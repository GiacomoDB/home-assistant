# Packages

`packages/` holds one HA [package](https://www.home-assistant.io/docs/configuration/packages/)
per feature: the automation plus any helper entity it needs, in one file so
neither can be installed without the other. Each file's header explains the
details; this is the overview.

They deploy on every push to `main` (HA pulls them; see
[SETUP.md](SETUP.md#automatic-deploys)). `ha.py validate` checks them first:
YAML syntax, required automation fields, and the filename rule that
`!include_dir_named` imposes (letters, digits, underscores).

## Alerts

| Package | Alerts when |
|---|---|
| `water_leak.yaml` | Any `device_class: moisture` sensor is wet. Repeats every 5 minutes for up to an hour at high priority, with an all-clear when it dries. The only alert where minutes matter, so the loudest. |
| `bath_humidity.yaml` | The bathroom stays above 70% for two hours *and* 10+ points above the hall: sustained damp, not the spike after a shower. |
| `cat_water_anomaly.yaml` | Yesterday's fountain intake is 35%+ off the trailing 7-day average, either way. Ships the statistics sensor it depends on. |
| `heating.yaml` | The thermostat is unreachable for 30 minutes, tado ignores HA's setpoint for 30 minutes, or the bedroom stays 2° short for 2 hours (see below). |

All of them push to `notify.mobile_app_pixel_8_pro` and also raise a persistent
notification, so an alert survives an undelivered push. `notify_target` at the
top of each automation's `variables:` is the one place to change that
(`python3 scripts/ha.py entities 'notify.*'` lists the alternatives). Each
carries a `tag`, so a repeat replaces the previous notification instead of
stacking, and a `channel`, so Android can tune each alert type.

## Heating — `heating.yaml`

HA owns the heating schedule and drives tado **locally over HomeKit**: tado's
cloud API allows 100 calls a day without Auto-Assist, too few to schedule
through. Every target is the bedroom's, measured by its own sensor at all
hours, and tado is sent `target + (tado reading − bedroom reading)`.

Controlled from the dashboard's **Heating** view: a slider holds a temperature
until the next block, plus Boost / Cancel / Resume. Changes from the tado dial
or app pause it until the next block. It starts in shadow mode, and needs the
HomeKit thermostat renamed to `climate.heating`; see the file header.

## Sensors for the dashboards

- **`appliances.yaml`**: the numbers behind the **Appliances** view. A status
  line per SmartThings device, cycle counters for the washer, dryer and vacuum
  (with long-term statistics, so they chart per week and month; SmartThings
  has no counter of its own), the last wash's and dry's length and energy, and
  when each machine last finished and the vacuum last ran.
- **`litter_box.yaml`**: gives the litter box occupancy sensor a 5-minute
  cooldown, so a cat holding still mid-visit doesn't count twice, and counts
  today's visits with `history_stats`, since the occupancy sensor alone has no
  statistics to chart.

## Deploy plumbing — `deploy.yaml`

Two shell commands, `pull_packages` and `rollback_packages`, that CI calls to
deploy this folder. See [SETUP.md](SETUP.md#automatic-deploys).
