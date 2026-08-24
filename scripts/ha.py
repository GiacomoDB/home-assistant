#!/usr/bin/env python3
"""Talk to Home Assistant's WebSocket API from this repo (and from CI).

Subcommands
-----------
  deploy    push the dashboards listed in dashboards/dashboards.yaml into HA
  entities  list entities matching a pattern, to fill in dashboard YAML
  validate  parse the dashboard YAML only -- no network, no credentials

`deploy` issues `lovelace/config/save`, the same command the frontend's raw
configuration editor uses. The dashboard stays in normal storage mode, so it is
still editable in the UI -- but a deploy overwrites whatever is live, so treat
this repo as the source of truth and edit here.

Credentials come from the environment:
  HA_URL    e.g. https://xxxxx.ui.nabu.casa or http://homeassistant.local:8123
  HA_TOKEN  a long-lived access token (HA profile page → Security → bottom)
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, urlunparse


def reexec_in_venv() -> None:
    """Re-run under the repo's venv interpreter if we aren't already using it.

    Means `python3 scripts/ha.py ...` works whatever Python happens to be on
    PATH, instead of failing on a missing dependency. No-ops in CI, where
    venv/ is gitignored and therefore absent.
    """
    if __name__ != "__main__":
        return  # imported as a module -- the caller chose the interpreter
    if os.environ.get("HA_SKIP_VENV_REEXEC"):
        return

    venv_dir = Path(__file__).resolve().parent.parent / "venv"
    venv_python = venv_dir / "bin" / "python"
    if not venv_python.exists():
        return
    # sys.prefix is the venv directory when running inside one. Comparing
    # interpreter paths does not work: venv/bin/python is a symlink that
    # resolves back to the system interpreter.
    if Path(sys.prefix).resolve() == venv_dir.resolve():
        return

    # Guards against an exec loop if the venv is somehow broken.
    os.environ["HA_SKIP_VENV_REEXEC"] = "1"
    os.execv(
        str(venv_python),
        [str(venv_python), str(Path(__file__).resolve()), *sys.argv[1:]],
    )


reexec_in_venv()


def dependency_hint(package: str) -> str:
    """Reached only when there is no usable venv to fall back on."""
    return (
        f"{package} is not installed, and no virtualenv was found at ./venv\n"
        f"  interpreter: {sys.executable}\n"
        "  fix: python3 -m venv venv && "
        "./venv/bin/pip install -r scripts/requirements.txt\n"
        "  then re-run this same command"
    )


try:
    import yaml
except ModuleNotFoundError:
    raise SystemExit(f"error: {dependency_hint('PyYAML')}") from None

REPO_ROOT = Path(__file__).resolve().parent.parent
DASHBOARD_DIR = REPO_ROOT / "dashboards"
MANIFEST = DASHBOARD_DIR / "dashboards.yaml"
# Snapshots of dashboards as they exist in HA. The leading underscore is a
# reminder that nothing here is deployed -- only the manifest drives that.
PULL_DIR = DASHBOARD_DIR / "_pulled"

# Cloudflare Tunnel drops the occasional connection while cloudflared
# reconnects, so a cold CI run can hit a 502 that succeeds moments later.
CONNECT_ATTEMPTS = 4


# ── plumbing ────────────────────────────────────────────────────────────────

def fail(message: str) -> "NoReturn":  # noqa: F821
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def websocket_url(base: str) -> str:
    """http(s)://host[:port] → ws(s)://host[:port]/api/websocket"""
    parsed = urlparse(base if "://" in base else f"https://{base}")
    scheme = {"http": "ws", "https": "wss", "ws": "ws", "wss": "wss"}.get(parsed.scheme)
    if scheme is None:
        fail(f"unsupported scheme in HA_URL: {parsed.scheme!r}")
    path = parsed.path.rstrip("/") + "/api/websocket"
    return urlunparse((scheme, parsed.netloc, path, "", "", ""))


class CommandError(RuntimeError):
    """Home Assistant answered, but refused the command."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


class TransportError(RuntimeError):
    """A connection-level failure -- a tunnel hiccup, not a bad config."""

    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


def access_headers() -> dict:
    """Cloudflare Access service-token headers, when a policy fronts the tunnel.

    Without them Access answers the WebSocket upgrade with its own login
    redirect, which never reaches Home Assistant. Harmless to leave unset if
    the tunnel is open.
    """
    client_id = os.environ.get("CF_ACCESS_CLIENT_ID")
    client_secret = os.environ.get("CF_ACCESS_CLIENT_SECRET")
    if client_id and client_secret:
        return {
            "CF-Access-Client-Id": client_id,
            "CF-Access-Client-Secret": client_secret,
        }
    return {}


class HomeAssistant:
    """Minimal synchronous WebSocket client -- connect, auth, send commands."""

    def __init__(self, url: str, token: str, headers: dict | None = None,
                 timeout: int = 30):
        # Imported lazily so `validate` works without the dependency at all.
        try:
            import websocket
        except ModuleNotFoundError:
            fail(dependency_hint("websocket-client"))

        self._id = 0
        # Only the transport is retryable; a rejected token is not, so the
        # handshake below fails hard instead of raising TransportError.
        try:
            self._ws = websocket.create_connection(
                websocket_url(url), timeout=timeout, header=headers or {}
            )
            hello = json.loads(self._ws.recv())
        except Exception as exc:  # noqa: BLE001 -- any transport fault retries
            # websocket-client packs headers into the message with a " -+-+- "
            # separator; the first field is the only readable part.
            message = str(exc).split(" -+-+- ")[0] or exc.__class__.__name__
            status = getattr(exc, "status_code", None)
            # A 4xx means the edge turned us away deliberately (Access policy,
            # bad path) -- backing off won't change its mind. 5xx and socket
            # errors are the transient ones worth retrying.
            retryable = not (status is not None and 400 <= status < 500)
            raise TransportError(message, retryable=retryable) from exc

        if hello.get("type") != "auth_required":
            fail(f"unexpected greeting from HA: {hello!r}")

        self._ws.send(json.dumps({"type": "auth", "access_token": token}))
        reply = json.loads(self._ws.recv())
        if reply.get("type") != "auth_ok":
            fail(
                "authentication rejected -- check HA_TOKEN is a valid "
                f"long-lived access token ({reply.get('message', reply)})"
            )
        self.version = reply.get("ha_version", "unknown")

    def command(self, type_: str, **payload):
        self._id += 1
        message = {"id": self._id, "type": type_, **payload}
        self._ws.send(json.dumps(message))

        # Skip any unsolicited events that arrive before our reply.
        while True:
            reply = json.loads(self._ws.recv())
            if reply.get("id") == self._id and reply.get("type") == "result":
                break

        if not reply.get("success"):
            error = reply.get("error", {})
            raise CommandError(
                error.get("code", "unknown"), error.get("message", "")
            )
        return reply.get("result")

    def close(self):
        try:
            self._ws.close()
        except Exception:  # noqa: BLE001 -- closing is best-effort
            pass


def redact_host(text: str, url: str) -> str:
    """Strip the HA hostname out of error text.

    Actions logs are public on a public repo. GitHub masks the exact secret
    value, but a TLS or DNS error often quotes the bare hostname without the
    scheme, which does not match the stored secret and so is not masked.
    """
    host = urlparse(url if "://" in url else f"https://{url}").netloc
    if host:
        text = text.replace(host, "<HA_URL>")
        bare = host.split(":")[0]
        if bare:
            text = text.replace(bare, "<HA_URL>")
    return text


def client_from_env() -> HomeAssistant:
    url, token = os.environ.get("HA_URL"), os.environ.get("HA_TOKEN")
    if not url or not token:
        fail("HA_URL and HA_TOKEN must both be set (see docs/SETUP.md)")

    headers = access_headers()
    timeout = int(os.environ.get("HA_TIMEOUT", "30"))
    last_error = None
    attempts = 0

    for attempt in range(1, CONNECT_ATTEMPTS + 1):
        attempts = attempt
        try:
            return HomeAssistant(url, token, headers=headers, timeout=timeout)
        except TransportError as exc:
            last_error = exc
            if attempt == CONNECT_ATTEMPTS or not exc.retryable:
                break
            delay = 2 ** attempt
            print(
                f"connection attempt {attempt}/{CONNECT_ATTEMPTS} failed "
                f"({redact_host(str(exc), url)}); retrying in {delay}s",
                file=sys.stderr,
            )
            time.sleep(delay)

    hint = ""
    text = redact_host(str(last_error), url)
    if not headers and ("403" in text or "status 30" in text):
        hint = (
            "\nhint: that looks like a Cloudflare Access login redirect rather "
            "than Home Assistant -- set CF_ACCESS_CLIENT_ID and "
            "CF_ACCESS_CLIENT_SECRET (see docs/SETUP.md)"
        )
    fail(
        f"could not reach Home Assistant after {attempts} attempt(s): "
        f"{text}{hint}"
    )


# ── dashboard loading ───────────────────────────────────────────────────────

def load_manifest() -> list[dict]:
    if not MANIFEST.exists():
        fail(f"missing manifest: {MANIFEST}")
    entries = yaml.safe_load(MANIFEST.read_text()) or []
    if not isinstance(entries, list):
        fail(f"{MANIFEST.name} must contain a list of dashboards")
    return entries


class IncludeLoader(yaml.SafeLoader):
    """SafeLoader plus `!include other.yaml`, resolved next to the including file.

    Lets a dashboard pull in a card that already lives elsewhere in the repo --
    the Petlibro cards are shared with the standalone versions at the repo root,
    so this keeps one copy rather than pasting a 13KB Jinja template inline.
    """

    def __init__(self, stream):
        self._base = Path(stream.name).resolve().parent
        super().__init__(stream)


def _construct_include(loader: IncludeLoader, node):
    target = (loader._base / loader.construct_scalar(node)).resolve()
    if not target.exists():
        fail(f"!include target not found: {target}")
    with target.open() as handle:
        return yaml.load(handle, IncludeLoader)


IncludeLoader.add_constructor("!include", _construct_include)


def load_yaml(path: Path):
    """Parse a YAML file with !include support."""
    with path.open() as handle:
        return yaml.load(handle, IncludeLoader)


def load_dashboard(entry: dict) -> dict:
    path = DASHBOARD_DIR / entry["file"]
    if not path.exists():
        fail(f"dashboard file not found: {path}")
    config = load_yaml(path)
    if not isinstance(config, dict) or "views" not in config:
        fail(f"{path.name} must be a mapping with a top-level 'views' key")
    return config


def referenced_entities(node, found: set[str] | None = None) -> set[str]:
    """Collect every entity_id mentioned anywhere in a dashboard config."""
    found = set() if found is None else found

    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("entity", "entity_id") and isinstance(value, str):
                found.add(value)
            elif key == "entities" and isinstance(value, list):
                for item in value:
                    if isinstance(item, str):
                        found.add(item)
                    else:
                        referenced_entities(item, found)
            else:
                referenced_entities(value, found)
    elif isinstance(node, list):
        for item in node:
            referenced_entities(item, found)

    # Domain-prefixed strings only; skips template fragments and free text.
    return {e for e in found if "." in e and " " not in e}


# ── subcommands ─────────────────────────────────────────────────────────────

def count_cards(node) -> int:
    """Count every card, including ones nested in stacks and grids.

    Panel views hold a single stack card that contains everything, so a
    top-level count would report 1.
    """
    total = 0
    if isinstance(node, dict):
        if "type" in node and not isinstance(node.get("type"), dict):
            total += 1
        for key, value in node.items():
            if key in ("cards", "card", "sections", "views"):
                total += count_cards(value)
    elif isinstance(node, list):
        for item in node:
            total += count_cards(item)
    return total


def lint_card_styles() -> list[str]:
    """Flag CSS in html-template-cards that would style OTHER cards.

    `hui-card` opts out of shadow DOM (`createRenderRoot()` returns `this`), so
    every card in a stack renders into the stack's shadow tree. html-template-card
    has no shadow root either, which puts its <style> AND its <ha-card> in that
    shared tree -- so a bare `ha-card { ... }` rule reaches every sibling card
    that also lacks a shadow root, i.e. every other html-template-card on the
    view. Cards written as ordinary LitElements keep their ha-card inside their
    own shadow root and are unaffected, which is what makes this so easy to ship
    without noticing: it looks fine until two of these cards share a view.

    A `display: none` written that way blanks the other cards outright. Scope
    every rule to a marker the card actually contains -- `ha-card:has(.my-root)`
    -- so it can only ever match its own card.

    Only selectors written at the start of a line are checked, which is how they
    are written here; a selector split across lines would slip through.
    """
    problems = []
    for path in sorted(REPO_ROOT.glob("*.yaml")):
        try:
            doc = yaml.safe_load(path.read_text())
        except yaml.YAMLError:
            continue  # blueprints and other non-card YAML
        if not isinstance(doc, dict) or "html-template-card" not in str(doc.get("type", "")):
            continue
        for number, line in enumerate(str(doc.get("content", "")).splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("ha-card") and not stripped.startswith("ha-card:has("):
                problems.append(
                    f"{path.name}: unscoped 'ha-card' selector in template line "
                    f"{number} -- use ha-card:has(.your-root-class) so the rule "
                    f"cannot style sibling cards"
                )
    return problems


def cmd_validate(_args) -> int:
    for entry in load_manifest():
        config = load_dashboard(entry)
        views = config["views"]
        cards = count_cards(views)
        entities = referenced_entities(config)
        print(
            f"ok  {entry['file']:<20} {len(views)} view(s), "
            f"{cards} card(s), {len(entities)} entit(y|ies)"
        )

    problems = lint_card_styles()
    for problem in problems:
        print(f"ERROR  {problem}", file=sys.stderr)
    return 1 if problems else 0


def cmd_entities(args) -> int:
    ha = client_from_env()
    print(f"# connected to Home Assistant {ha.version}", file=sys.stderr)
    states = ha.command("get_states")
    ha.close()

    pattern = args.pattern
    rows = []
    for state in states:
        entity_id = state["entity_id"]
        name = state.get("attributes", {}).get("friendly_name", "")
        if fnmatch.fnmatch(entity_id, pattern) or pattern.lower() in name.lower():
            rows.append((entity_id, state.get("state", ""), name))

    if not rows:
        print(f"no entities matched {pattern!r}", file=sys.stderr)
        return 1

    width = max(len(r[0]) for r in rows)
    for entity_id, value, name in sorted(rows):
        print(f"{entity_id:<{width}}  {value:>10}  {name}")
    return 0


def cmd_stats(_args) -> int:
    """Report which dashboard entities have long-term statistics.

    The statistics-graph card reads long-term statistics, not recorder history.
    HA only records those for sensors with a `state_class` of measurement,
    total or total_increasing -- anything else plots as an empty series with no
    error shown. This answers "will that card draw anything?" before a deploy.
    """
    ha = client_from_env()
    print(f"# connected to Home Assistant {ha.version}", file=sys.stderr)
    # has_mean / has_sum decide which stat_types a statistics-graph card can
    # actually plot. HA keeps min/max/mean for `state_class: measurement` and
    # sum for total/total_increasing -- ask for the wrong one and the series is
    # empty with no error, so the card needs to be told which is which.
    known = {
        row["statistic_id"]: row
        for row in (ha.command("recorder/list_statistic_ids") or [])
    }

    wanted: set[str] = set()
    for entry in load_manifest():
        wanted |= referenced_entities(load_dashboard(entry))
    ha.close()

    if not wanted:
        print("no entities referenced by any dashboard", file=sys.stderr)
        return 0

    width = max(len(entity_id) for entity_id in wanted)
    missing = 0
    print(f"{'ENTITY':<{width}}  {'STATS':<8}  USABLE stat_types")
    for entity_id in sorted(wanted):
        row = known.get(entity_id)
        missing += row is None
        if row is None:
            print(f"{entity_id:<{width}}  {'NO STATS':<8}  -")
            continue
        kinds = []
        if row.get("has_mean"):
            kinds.append("min/max/mean")
        if row.get("has_sum"):
            kinds.append("sum/state/change")
        print(f"{entity_id:<{width}}  {'stats':<8}  {', '.join(kinds) or 'unknown'}")

    print(
        f"\n{len(wanted) - missing}/{len(wanted)} have long-term statistics",
        file=sys.stderr,
    )
    # Non-zero so this is usable as a check, but note that plenty of entities
    # legitimately have no statistics (switches, lights) -- read the list.
    return 1 if missing else 0


def ha_dashboards(ha) -> list[dict]:
    """Every dashboard in HA, including the implicit default Overview.

    `lovelace/dashboards/list` only returns user-created dashboards, so the
    built-in one is prepended by hand.
    """
    listed = ha.command("lovelace/dashboards/list") or []
    return [{"url_path": None, "title": "Overview (built-in)"}] + listed


def cmd_dashboards(_args) -> int:
    ha = client_from_env()
    dashboards = ha_dashboards(ha)
    tracked = {entry.get("url_path") for entry in load_manifest()}

    print(f"{'URL':<28} {'TITLE':<28} MANAGED BY THIS REPO")
    for dash in dashboards:
        url_path = dash.get("url_path")
        try:
            config = ha.command("lovelace/config", url_path=url_path)
            views = len(config.get("views", []))
            shape = f"{views} view(s)"
        except CommandError as exc:
            # An untouched Overview is generated on the fly and has no config.
            shape = "auto-generated" if exc.code == "config_not_found" else exc.code

        managed = "yes -- deploys overwrite it" if url_path in tracked else "no"
        print(
            f"{(url_path or '(default)'):<28} "
            f"{dash.get('title', ''):<28} {managed}   [{shape}]"
        )
    ha.close()
    print("\nUnlisted dashboards are never touched by `deploy`.")
    return 0


def cmd_pull(args) -> int:
    """Snapshot live dashboard configs into the repo, so nothing is lost."""
    ha = client_from_env()
    targets = ha_dashboards(ha)
    if args.url_path is not None:
        targets = [d for d in targets if d.get("url_path") == args.url_path]
        if not targets:
            fail(f"no dashboard in HA with url_path {args.url_path!r}")

    PULL_DIR.mkdir(parents=True, exist_ok=True)
    pulled = 0

    for dash in targets:
        url_path = dash.get("url_path")
        label = url_path or "overview"
        try:
            config = ha.command("lovelace/config", url_path=url_path)
        except CommandError as exc:
            reason = (
                "auto-generated, nothing stored"
                if exc.code == "config_not_found"
                else exc
            )
            print(f"  skipped {label}: {reason}")
            continue

        path = PULL_DIR / f"{label}.yaml"
        header = (
            f"# Snapshot of the '{dash.get('title', label)}' dashboard as it\n"
            f"# exists in Home Assistant (url_path: {url_path!r}).\n"
            "#\n"
            "# Not deployed -- only dashboards listed in ../dashboards.yaml are.\n"
            "# Pulled with: python scripts/ha.py pull\n\n"
        )
        path.write_text(
            header
            + yaml.safe_dump(config, sort_keys=False, allow_unicode=True, width=100)
        )
        print(f"  pulled {label} → {path.relative_to(REPO_ROOT)} "
              f"({len(config.get('views', []))} view(s))")
        pulled += 1

    ha.close()
    print(f"\n{pulled} dashboard(s) snapshotted.")
    return 0


def cmd_deploy(args) -> int:
    entries = load_manifest()
    configs = {entry["file"]: load_dashboard(entry) for entry in entries}

    ha = client_from_env()
    print(f"connected to Home Assistant {ha.version}")

    known = {state["entity_id"] for state in ha.command("get_states")}
    problems = 0

    for entry in entries:
        config = configs[entry["file"]]
        label = entry.get("title", entry["file"])

        missing = sorted(referenced_entities(config) - known)
        if missing:
            problems += len(missing)
            print(f"  warning: {label} references {len(missing)} unknown entit(y|ies):")
            for entity_id in missing:
                print(f"    - {entity_id}")

        if args.dry_run:
            print(f"  dry-run: would deploy {label}")
            continue

        ha.command(
            "lovelace/config/save",
            url_path=entry.get("url_path"),
            config=config,
        )
        target = entry.get("url_path") or "(default dashboard)"
        print(f"  deployed {label} → {target}")

    ha.close()

    if problems and args.strict:
        fail(f"{problems} unknown entity reference(s) and --strict was set")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser(
        "validate", help="parse dashboard YAML locally (no credentials needed)"
    ).set_defaults(func=cmd_validate)

    entities = subparsers.add_parser(
        "entities", help="list entities matching a glob or name substring"
    )
    entities.add_argument(
        "pattern",
        nargs="?",
        default="sensor.*",
        help="glob against entity_id, or substring of the friendly name",
    )
    entities.set_defaults(func=cmd_entities)

    deploy = subparsers.add_parser("deploy", help="push dashboards into HA")
    deploy.add_argument(
        "--dry-run",
        action="store_true",
        help="connect and check entities, but do not write",
    )
    deploy.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero if any referenced entity does not exist",
    )
    deploy.set_defaults(func=cmd_deploy)

    subparsers.add_parser(
        "stats",
        help="check which dashboard entities have long-term statistics",
    ).set_defaults(func=cmd_stats)

    subparsers.add_parser(
        "dashboards", help="list the dashboards in HA and who manages them"
    ).set_defaults(func=cmd_dashboards)

    pull = subparsers.add_parser(
        "pull", help="snapshot live dashboard configs into dashboards/_pulled/"
    )
    pull.add_argument(
        "url_path",
        nargs="?",
        help="one dashboard's URL slug; omit to snapshot all of them",
    )
    pull.set_defaults(func=cmd_pull)

    args = parser.parse_args()
    try:
        return args.func(args)
    except CommandError as exc:
        fail(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
