# Setup

Everything in this repo is the source of truth for a Home Assistant install.
Dashboards live in `dashboards/`, get validated on every pull request, and get
pushed to Home Assistant by GitHub Actions on every merge to `main`.

> **Deploys overwrite.** `scripts/ha.py deploy` replaces the live dashboard
> config wholesale. Edits made in the HA UI survive until the next deploy, then
> they're gone. If you tweak something in the UI and want to keep it, copy it
> back into `dashboards/` (Dashboard → ⋮ → Raw configuration editor).

---

> **Note on shell snippets.** These deliberately carry no trailing `#`
> comments. zsh does not treat `#` as a comment in interactive shells unless
> `interactive_comments` is set, so a pasted `cmd  # note` passes `#` and the
> words after it as arguments — which is how `python3 -m venv venv  # once`
> quietly creates three virtualenvs.

## First run — do these in order

Roughly 20 minutes. Steps 1–6 get a working deploy from your laptop; 7–9 hand
it over to CI. Each links to the detail below.

|  | Step | Where |
|---|---|---|
| 0 | Snapshot the dashboards already in HA — see §0 | laptop |
| 1 | Create the dashboard in HA, note its **URL** slug | HA → Settings → Dashboards |
| 2 | Put that slug in `url_path` | `dashboards/dashboards.yaml` |
| 3 | Create a long-lived access token | HA → profile → Security |
| 4 | Add `trusted_proxies` so HA accepts the tunnel, restart HA | `configuration.yaml` — see §1 |
| 5 | Install deps, export `HA_URL`/`HA_TOKEN`, look up your real sensor IDs | laptop — see §3 |
| 6 | Replace the placeholder climate entity IDs, then `deploy --dry-run` until clean | `dashboards/home.yaml` |
| 7 | Deploy for real and check the dashboard on your phone | laptop |
| 8 | Add `HA_URL` + `HA_TOKEN` repository secrets | GitHub — see §2 |
| 9 | Commit, push to `main`, watch the Action | GitHub → Actions |

Step 4 is the one people skip; without it HA refuses the connection as coming
from an untrusted address and step 5 fails with a handshake error.

---

## 0. Dashboards that already exist

`deploy` only touches dashboards listed in `dashboards/dashboards.yaml`.
Anything else in Home Assistant is left completely alone — so a dashboard you
want to keep as-is is safe by default, just don't add it to the manifest.

Before changing anything, snapshot what's live:

```sh
python3 scripts/ha.py dashboards
python3 scripts/ha.py pull
```

`dashboards` prints what exists and which ones this repo owns; `pull` writes
every config to `dashboards/_pulled/`.

`_pulled/` is a backup, not a deploy target — the leading underscore is the
reminder. Commit it: it costs nothing and it's the only copy of those configs
outside HA's `.storage`.

### Keeping one dashboard untouched

Do nothing. Leave it out of the manifest and no deploy will ever write to it.
`python3 scripts/ha.py dashboards` prints a "managed by this repo" column so you
can confirm at a glance.

If you later want it version-controlled but still hand-edited in the UI, keep
its snapshot in `_pulled/` and re-run `pull` after you change it. That gives you
history without handing control to CI.

### Combining several dashboards into one

A dashboard is just a list of views, and each view is a tab. So merging is
mostly copying view blocks:

1. `python3 scripts/ha.py pull` to get each one as YAML.
2. Copy the `views:` entries you want out of `dashboards/_pulled/*.yaml` and
   append them under `views:` in `dashboards/home.yaml`.
3. Give each view a distinct `title:` and `path:` — `path` must be unique
   within a dashboard or HA will not route to it.
4. `python3 scripts/ha.py validate`, then `deploy --dry-run` to catch entities
   that no longer exist.
5. Deploy, check every tab, and only then delete the old dashboards in HA
   (Settings → Dashboards → the dashboard → Delete).

Views copied from an older dashboard may use the Masonry layout (`cards:` at
the top level) rather than Sections (`sections:` with `type: grid`). Both work
side by side in one dashboard — a view keeps whatever layout it declares — so
there's no need to convert them up front.

Watch for views that depend on custom cards from HACS (`type: custom:...`).
They keep working, but the dashboard stops being "native cards only" and will
break if that HACS component is ever removed.

---

## 1. One-time Home Assistant setup

### Create the dashboard

Settings → Dashboards → **+ Add dashboard** → New dashboard from scratch.

Note the value in the **URL** column (e.g. `home`) — it must match `url_path`
in `dashboards/dashboards.yaml`. To target the built-in Overview dashboard
instead, omit `url_path` from the manifest entry.

### Create a long-lived access token

Click your user avatar (bottom left) → **Security** tab → scroll to
**Long-lived access tokens** → **Create token**. Copy it immediately; HA will
not show it again.

The token inherits your user's permissions. If you'd rather not hand CI your
own admin account, create a dedicated local user first, make it an admin
(saving dashboards requires it), and generate the token as that user.

### Make Home Assistant reachable from GitHub's runners

GitHub-hosted runners are on the public internet, so they need to reach your HA
instance. **This setup uses a Cloudflare Tunnel**, so `HA_URL` is your tunnel
hostname, e.g. `https://ha.example.com` — see the Cloudflare notes below.

Other arrangements that work: Nabu Casa Cloud (`https://<id>.ui.nabu.casa`) or
any reverse proxy on a public hostname. If HA were LAN-only instead, you'd need
a [self-hosted runner](https://docs.github.com/actions/hosting-your-own-runners)
on your network, or you'd skip Actions and deploy from your laptop using §3.

### Cloudflare Tunnel notes

**Let HA trust the tunnel.** `cloudflared` is a reverse proxy, so without this
HA rejects the connection as coming from an untrusted address. In
`configuration.yaml`:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 172.30.33.0/24   # the HA add-on network, if cloudflared runs as an add-on
    - 127.0.0.1        # if cloudflared runs on the HA host itself
```

Restart HA after changing this.

**WebSockets** are proxied by `cloudflared` by default — no extra config. The
deploy finishes in a second or two, so Cloudflare's 100-second idle timeout for
WebSocket connections never comes into play.

**If a Cloudflare Access policy protects the hostname**, the runner has no
browser to complete the login, so Access answers the WebSocket upgrade with a
redirect and the deploy fails with `Handshake status 403`. Fix it with a
service token: Cloudflare Zero Trust → Access → Service Auth → **Create service
token**, then add it to the Access policy for that hostname as an allowed
service token. Feed the two values in as `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` (see §2); `scripts/ha.py` sends them as headers when
both are present, and tells you to set them if it sees a 403 without them.

**Transient failures.** `cloudflared` occasionally drops a connection while it
reconnects to Cloudflare's edge. The deploy script retries up to four times
with exponential backoff on 5xx and socket errors, but fails immediately on a
4xx, since an Access rejection or wrong hostname won't fix itself.

---

## 2. GitHub setup

Repository → Settings → Secrets and variables → Actions → **New repository
secret**:

| Secret | Required | Value |
|---|---|---|
| `HA_URL` | yes | Tunnel hostname, no trailing slash, e.g. `https://ha.example.com` |
| `HA_TOKEN` | yes | The long-lived access token from §1 |
| `CF_ACCESS_CLIENT_ID` | only with Access | Service token client ID |
| `CF_ACCESS_CLIENT_SECRET` | only with Access | Service token client secret |

Or from the CLI:

```sh
gh secret set HA_URL   --body "https://ha.example.com"
gh secret set HA_TOKEN --body "eyJhbGciOi..."

# only if a Cloudflare Access policy fronts the tunnel
gh secret set CF_ACCESS_CLIENT_ID     --body "....access"
gh secret set CF_ACCESS_CLIENT_SECRET --body "..."
```

Then trigger a no-op run to confirm the wiring:
Actions → **Deploy dashboards** → Run workflow → tick **dry_run**.

---

## 3. Working locally

One-time setup. Apple's bundled Python has no `pip` on `PATH` and shouldn't be
installed into anyway, so the dependencies live in a virtualenv (`venv/`, which
is gitignored). `scripts/ha.py` re-runs itself under that interpreter
automatically, so `python3 scripts/ha.py ...` works from any shell.

```sh
python3 -m venv venv
./venv/bin/pip install -r scripts/requirements.txt
```

Credentials, per shell:

```sh
export HA_URL=https://ha.example.com
export HA_TOKEN=eyJhbGciOi...
```

Only if a Cloudflare Access policy fronts the tunnel, also:

```sh
export CF_ACCESS_CLIENT_ID=....access
export CF_ACCESS_CLIENT_SECRET=...
```

Then:

| Command | Does |
|---|---|
| `python3 scripts/ha.py validate` | Parse the YAML; no network, no credentials |
| `python3 scripts/ha.py dashboards` | List HA's dashboards and who manages them |
| `python3 scripts/ha.py pull` | Snapshot live configs into `dashboards/_pulled/` |
| `python3 scripts/ha.py entities 'sensor.*temperature*'` | Find entity IDs by glob |
| `python3 scripts/ha.py entities fountain` | Find entity IDs by friendly name |
| `python3 scripts/ha.py deploy --dry-run` | Connect and check entities, don't write |
| `python3 scripts/ha.py deploy` | Push for real |

`deploy` warns about entity IDs that don't exist in your instance. Pass
`--strict` to turn those warnings into a non-zero exit — useful if you'd rather
CI block a typo'd sensor than ship a broken card.

Never commit `HA_TOKEN`. It is a full-access credential; if one leaks, revoke it
from the same Security tab that created it.

---

## 4. Custom cards (HACS)

`dashboards/home.yaml` needs **three HACS frontend cards**. Without them the
affected cards render as a red error box, so install these before the first
deploy:

| HACS card | Used by |
|---|---|
| [`html-template-card`](https://github.com/PiotrMachowski/Home-Assistant-Lovelace-HTML-Jinja2-Template-card) | `attention-card.yaml`, `climate-table-card.yaml`, `energy-card.yaml`, `petlibro-water-level-card.yaml`, `petlibro-fountain-card.yaml` |
| [`apexcharts-card`](https://github.com/RomRider/apexcharts-card) | `petlibro-fountain-chart-card.yaml` |
| [`card-mod`](https://github.com/thomasloven/lovelace-card-mod) | the `custom:mod-card` wrapper on every view, which supplies the side margins |

Everything else on the dashboard is native: the `clock`, `heading`, `tile`,
`grid`, `light`, `history-graph` and `statistics-graph` cards all ship with HA.

`eink-sensor-card.js` is not a HACS card — copy it to `config/www/` and add it
as a dashboard resource. It is used only by the Kindle dashboard, which this
repo does not manage.


---

## Packages (automations)

`packages/` holds automations and the helper entities they need, one file per
feature. **These are not deployed by `ha.py deploy` or by GitHub Actions.**

That is a real limitation, not an oversight. Dashboards are written over the
WebSocket API, which has a `lovelace/config/save` command. There is no
equivalent for arbitrary config files, so packages have to reach the config
directory as files — by Samba, SSH, the File Editor add-on or Studio Code
Server. `ha.py validate` still checks them, so CI catches a broken one before
you copy it across.

### One-time setup

Add this to `configuration.yaml`, if it is not there already:

```yaml
homeassistant:
  packages: !include_dir_named packages
```

`!include_dir_named` uses each **filename** as the package name, so names must
be unique across the whole folder and must be valid keys — use underscores, not
hyphens. `validate` fails on a hyphenated filename for that reason.

### Installing or updating

With the Terminal & SSH add-on, this is one command:

```sh
export HA_SSH_HOST=homeassistant.local     # LAN address, not the tunnel
scripts/push-packages.sh                   # copy + reload
scripts/push-packages.sh --restart         # copy + full restart
```

It validates first and refuses to copy anything that fails — a broken package
takes the whole config down at restart, which is far worse than not deploying.
It never deletes on the remote side, so files you added there by hand survive.

Use `--restart` the first time, and any time a package **adds** a `sensor:`
block: `reload_all` picks up changed automations and templates, but not a newly
added platform sensor such as the statistics sensor in `cat_water_anomaly.yaml`.

`HA_SSH_HOST` must be the LAN hostname or IP. The Cloudflare tunnel carries
HTTPS only, and putting SSH through it would be a much larger exposure than the
WebSocket token. For the same reason this is deliberately **not** part of the
GitHub Actions workflow — that would mean SSH access from the public internet.

Without SSH, do it by hand:

| Step | What |
|---|---|
| 1 | Copy `packages/*.yaml` into `<config>/packages/` (Samba, File Editor, Studio Code Server) |
| 2 | Developer Tools → YAML → **Check configuration** |
| 3 | Developer Tools → YAML → **Reload all YAML**, or restart per the note above |

### Verifying it loaded

A package that fails to load does so quietly, and the automation half can load
while the sensor half fails — so check for the sensor, not just the automations:

```sh
python scripts/ha.py entities 'automation.*'
python scripts/ha.py entities 'cat water'
```

### What is in them

| Package | Does |
|---|---|
| `cat_water_anomaly.yaml` | Compares yesterday's fountain intake against a trailing 7-day average and notifies when it deviates by 35% or more. Ships the statistics sensor it depends on. |
| `bath_humidity.yaml` | Notifies when bathroom humidity stays above 70% for two hours *and* sits 10+ points above the hall, the condition mould needs. |
| `water_leak.yaml` | Repeating high-priority alarm every 5 minutes while any moisture sensor is wet, capped at an hour, with an all-clear when it dries. |

### Notifications

All three are pinned to `notify.mobile_app_pixel_8_pro`, matching the convention
already used by the "Acqua gatto notifica" automation. `notify_target` at the top
of each automation's `variables:` block is the single place to change it; find
other services with:

```sh
python scripts/ha.py entities 'notify.*'
```

Each carries a `tag`, so a repeat replaces the previous notification rather than
stacking, and a `channel` so Android can be tuned per alert type. Each also
raises a persistent notification behind `continue_on_error: true`, so an alert
is never lost to an undelivered push.
