#!/usr/bin/env python3
"""Pull packages/ from GitHub into Home Assistant's config. Runs INSIDE HA.

Not run from the laptop or CI. It lives at /config/deploy/pull_packages.py and
runs in the Home Assistant container, through the two shell commands in
packages/deploy.yaml. CI calls those over the WebSocket API (see
`ha.py deploy-packages`), so packages deploy on a push to main without SSH
being reachable from the internet. HA pulls; nothing pushes files in.

  pull_packages.py pull <sha>   install packages/ as of commit <sha>
  pull_packages.py rollback     put back what the last pull replaced

PULL
1. Refuses any commit that is not on main. GitHub serves a fork's commits
   through the parent repo's URLs, so without this check, anyone holding the
   HA token could push a commit to a fork and have HA install it. GitHub's
   compare API says whether <sha> is main itself or an ancestor of it.
2. Downloads that commit's tarball and reads only packages/*.yaml and this
   script out of it. Nothing is extracted by path, so a crafted archive cannot
   write anywhere else.
3. Snapshots /config/packages to /config/deploy/packages.prev, then writes
   the changed files (each atomically) and deletes files that an earlier pull
   installed but the repo no longer has. Files added on the HA side by hand,
   and never part of a pull, are left alone.
4. Prints one JSON line: commit, changed, removed, and whether a restart is
   needed. A restart is needed when a change touches a domain that
   `homeassistant.reload_all` can't apply (anything outside RELOADABLE: a
   `sensor:` platform, `shell_command:`...). This script never reloads or
   restarts; CI does that after HA's config check passes.

ROLLBACK
Restores the snapshot. CI runs it when the config check fails, so a broken
package never reaches a reload or a restart.

Stdlib only, plus PyYAML, which Home Assistant itself depends on.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import sys
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

import yaml

REPO = "GiacomoDB/home-assistant"
CONFIG = Path("/config")
PACKAGES = CONFIG / "packages"
STATE = CONFIG / "deploy"
PREV = STATE / "packages.prev"
MANIFEST = STATE / "manifest.json"
PREV_MANIFEST = STATE / "manifest.prev.json"
SELF = STATE / "pull_packages.py"

SHA = re.compile(r"^[0-9a-f]{40}$")
# The archive's top directory is <repo>-<sha>/. Same filename rule as
# `ha.py validate`: !include_dir_named makes the filename the package key.
PACKAGE_MEMBER = re.compile(r"^[^/]+/packages/([A-Za-z0-9_]+\.yaml)$")
SELF_MEMBER = re.compile(r"^[^/]+/scripts/pull_packages\.py$")
MAX_DOWNLOAD = 20 * 1024 * 1024

# Domains whose config `homeassistant.reload_all` applies in place. A change
# anywhere else in a package means a restart.
RELOADABLE = {
    "automation", "script", "scene", "template", "group", "schedule",
    "input_boolean", "input_button", "input_datetime", "input_number",
    "input_select", "input_text", "timer", "counter", "zone", "person",
}


def fetch(url: str) -> bytes:
    request = urllib.request.Request(
        url, headers={"User-Agent": "home-assistant-pull-packages/1.0"}
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        data = response.read(MAX_DOWNLOAD + 1)
    if len(data) > MAX_DOWNLOAD:
        raise SystemExit(f"error: {url} is larger than {MAX_DOWNLOAD} bytes")
    return data


def on_main(sha: str) -> bool:
    # base...head: "ahead" means main has moved on past <sha>, "identical"
    # that <sha> is main. A fork's commit compares as "diverged" or "behind".
    try:
        compare = json.loads(
            fetch(f"https://api.github.com/repos/{REPO}/compare/{sha}...main")
        )
    except urllib.error.HTTPError as exc:
        if exc.code in (404, 422):  # GitHub doesn't know the commit at all
            return False
        raise
    return compare.get("status") in ("identical", "ahead")


class AnyTagLoader(yaml.SafeLoader):
    """SafeLoader that reads !include, !secret and friends as plain data.

    Only used to compare old and new package contents domain by domain; the
    tags are never resolved.
    """


def _any_tag(loader, _suffix, node):
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node, deep=True)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node, deep=True)
    return loader.construct_scalar(node)


AnyTagLoader.add_multi_constructor("!", _any_tag)


def domains(text: bytes | None) -> dict | None:
    """A package's top-level domains, or None if it can't be parsed."""
    if text is None:
        return {}
    try:
        doc = yaml.load(text, AnyTagLoader)  # noqa: S506 -- SafeLoader subclass
    except yaml.YAMLError:
        return None
    return doc if isinstance(doc, dict) else None


def restart_reasons(name: str, old: bytes | None, new: bytes | None) -> list[str]:
    before, after = domains(old), domains(new)
    if before is None or after is None:
        return [f"{name}: could not compare (YAML did not parse)"]
    return [
        f"{name}: {domain}"
        for domain in sorted(set(before) | set(after))
        if before.get(domain) != after.get(domain) and domain not in RELOADABLE
    ]


def write_atomic(path: Path, data: bytes) -> None:
    # A dot-prefixed temp file: !include_dir_named only loads *.yaml, and the
    # rename is atomic, so HA never reads a half-written package.
    temp = path.with_name(f".{path.name}.tmp")
    temp.write_bytes(data)
    os.replace(temp, path)


def read_manifest(path: Path) -> list[str]:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return []


def pull(sha: str) -> dict:
    if not SHA.match(sha):
        raise SystemExit(f"error: not a full commit sha: {sha!r}")
    if not on_main(sha):
        raise SystemExit(f"error: {sha} is not on {REPO} main; refusing it")

    archive = fetch(f"https://codeload.github.com/{REPO}/tar.gz/{sha}")
    files: dict[str, bytes] = {}
    new_self = None
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            match = PACKAGE_MEMBER.match(member.name)
            if match:
                files[match.group(1)] = tar.extractfile(member).read()
            elif SELF_MEMBER.match(member.name):
                new_self = tar.extractfile(member).read()
    if not files:
        raise SystemExit(f"error: no packages/*.yaml in {sha}; refusing to deploy nothing")

    PACKAGES.mkdir(parents=True, exist_ok=True)
    STATE.mkdir(parents=True, exist_ok=True)

    current = {p.name: p.read_bytes() for p in PACKAGES.glob("*.yaml")}
    changed = sorted(n for n, data in files.items() if current.get(n) != data)
    removed = sorted(
        n for n in read_manifest(MANIFEST) if n not in files and n in current
    )

    reasons: list[str] = []
    for name in changed:
        reasons += restart_reasons(name, current.get(name), files[name])
    for name in removed:
        reasons += restart_reasons(name, current[name], None)

    if changed or removed:
        if PREV.exists():
            shutil.rmtree(PREV)
        shutil.copytree(PACKAGES, PREV)
        if MANIFEST.exists():
            shutil.copyfile(MANIFEST, PREV_MANIFEST)
        else:
            PREV_MANIFEST.unlink(missing_ok=True)
        for name in changed:
            write_atomic(PACKAGES / name, files[name])
        for name in removed:
            (PACKAGES / name).unlink()
    MANIFEST.write_text(json.dumps(sorted(files)))

    # Takes effect from the next pull; this run finishes on the old code.
    if new_self is not None and (not SELF.exists() or SELF.read_bytes() != new_self):
        write_atomic(SELF, new_self)

    return {
        "commit": sha,
        "changed": changed,
        "removed": removed,
        "restart": bool(reasons),
        "reasons": reasons,
    }


def rollback() -> dict:
    if not PREV.is_dir():
        raise SystemExit("error: no snapshot to roll back to")
    restored = sorted(p.name for p in PREV.glob("*.yaml"))
    for path in PACKAGES.glob("*.yaml"):
        if path.name not in restored:
            path.unlink()
    for name in restored:
        write_atomic(PACKAGES / name, (PREV / name).read_bytes())
    if PREV_MANIFEST.exists():
        shutil.copyfile(PREV_MANIFEST, MANIFEST)
    else:
        MANIFEST.unlink(missing_ok=True)
    return {"rolled_back": restored}


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "pull":
        result = pull(argv[2])
    elif len(argv) == 2 and argv[1] == "rollback":
        result = rollback()
    else:
        raise SystemExit("usage: pull_packages.py pull <sha> | rollback")
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
