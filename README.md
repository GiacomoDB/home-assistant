# Home Assistant

Source of truth for my Home Assistant setup: dashboards (phone, laptop and the
wall tablet), packages (automations and their helper entities), custom cards
and blueprints. Edit here, not in the
HA UI: a deploy overwrites what's live.

**On every push to `main`**, GitHub Actions validates everything, then:

1. **Packages**: HA pulls `packages/` at that commit from GitHub, runs its
   config check (rolling back if it fails), and reloads, or restarts when a
   change needs it. No SSH is reachable from outside.
2. **Dashboards**: written to HA over the WebSocket API.

Pull requests only get validated. Pushing to `main` changes HA's config and
can run commands on it, so keep 2FA on the GitHub account.

## Docs

| | |
|---|---|
| [SETUP.md](docs/SETUP.md) | First run, credentials, GitHub secrets, the Cloudflare tunnel, how deploys work, every command |
| [DASHBOARDS.md](docs/DASHBOARDS.md) | What each view shows, layout notes, themes |
| [PACKAGES.md](docs/PACKAGES.md) | What each package does: alerts, heating, appliance stats |
| [CARDS.md](docs/CARDS.md) | The custom cards, and the CSS rule they all follow |
| [BLUEPRINTS.md](docs/BLUEPRINTS.md) | IKEA BILRESA scroll-wheel blueprints, with import buttons |
| [ENTITIES.md](docs/ENTITIES.md) | Every entity ID the repo depends on |
| [investigations/](docs/investigations/README.md) | Write-ups of past incidents, and the toolbox for looking into the live system |

## Layout

```
dashboards/           home.yaml, tablet.yaml, laptop.yaml, phone.yaml (+ house.yaml, their shared entities) and the manifest; _pulled/ = snapshots
packages/             one package per feature; HA pulls these on deploy
automations/_pulled/  read-only snapshots of automations still owned by the HA UI
*-card.yaml, *.js     custom cards, !included by the dashboard
www/                  JS cards HA pulls on deploy (the tablet panel, the laptop and phone pages)
ikea-billresa-*.yaml  blueprints
themes/               theme files, copied to HA by hand (currently unused)
scripts/ha.py         validate / deploy / entity lookup CLI
scripts/pull_packages.py  runs INSIDE HA: installs packages/ at a commit on main
scripts/thread_snapshot.py  runs INSIDE HA: the Thread flight recorder (packages/thread_log.yaml)
scripts/push-packages.sh  one-time bootstrap and manual fallback, over SSH on the LAN
scripts/screenshot.mjs    screenshots of the dashboard views, for checking a deploy
.github/workflows/    the deploy pipeline
```

## Everyday commands

| Command | Does |
|---|---|
| `python3 scripts/ha.py validate` | Offline check of all YAML; what CI runs on every PR |
| `python3 scripts/ha.py entities fountain` | Find entity IDs |
| `python3 scripts/ha.py deploy --dry-run` | Check the dashboard's entities exist in HA |
| `python3 scripts/ha.py stats` | Which entities can feed statistics charts |
| `node scripts/screenshot.mjs` | Screenshot every view at phone width |

The network commands need `HA_URL` and `HA_TOKEN` exported, and a venv the
first time; see [SETUP.md §3](docs/SETUP.md#3-working-locally) for that and
the full list.
