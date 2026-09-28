# Entity reference

The entity IDs this repo depends on. Keep it current — it's the thing that
makes a dashboard editable a year from now without opening Developer Tools.

Regenerate any section with:

```sh
python scripts/ha.py entities 'sensor.*'      # glob on entity_id
python scripts/ha.py entities fountain        # substring of the friendly name
```

---

## Cat fountain — Petlibro / Dockstream

Confirmed working; used by `dashboards/home.yaml`,
`petlibro-fountain-card.yaml` and `petlibro-fountain-chart-card.yaml`.

| Entity ID | Unit | Meaning |
|---|---|---|
| `sensor.dockstream_smart_fountain_remaining_water_2` | % | Water left in the bowl. The `_2` suffix is real — HA created a second entity for this sensor. |
| `sensor.dockstream_smart_fountain_today_s_water_consumption` | mL | Cumulative today, resets at midnight |
| `sensor.dockstream_smart_fountain_today_s_total_drinking_times` | count | Number of drinking sessions today |
| `sensor.dockstream_smart_fountain_today_s_average_drinking_time` | s | Mean session length today |
| `sensor.dockstream_smart_fountain_today_s_total_drinking_time` | s | Summed session length today |
| `sensor.dockstream_smart_fountain_yesterday_s_water_consumption` | mL | Yesterday's total |
| `sensor.dockstream_smart_fountain_yesterday_s_total_drinking_times` | count | Yesterday's session count |

**Level thresholds** used by the gauge in `dashboards/home.yaml` and the colour
logic in `petlibro-fountain-card.yaml` — keep the two in sync if you change one:

| Remaining | Colour | Meaning |
|---|---|---|
| ≥ 50 % | green | fine |
| 25–49 % | yellow | top up soon |
| < 25 % | red | refill now (triggers the alert card) |

---

## Litter box

| Entity ID | Meaning |
|---|---|
| `binary_sensor.myggspray_wrlss_mtn_sensor_occupancy` | Occupancy sensor by the litter box — device `3ea027dfc4ee13282471c8dabfbaead2`. `on` = motion in the box. Clears mid-visit when the cat holds still, so nothing on the dashboard reads it directly — see `binary_sensor.cat_in_litter_box` below. Also the trigger of the UI automation `automations/_pulled/gatto_cacca.yaml`. |

---

## Climate

Six rooms. Recovered from the pre-merge dashboards and all confirmed present
in the instance via `deploy --dry-run` (HA 2026.8.0).

| Room | Temperature | Humidity |
|---|---|---|
| Living Room | `sensor.timmerflotte_temp_hmd_sensor_temperature_4` | `sensor.timmerflotte_temp_hmd_sensor_humidity_4` |
| Kitchen | `sensor.timmerflotte_temp_hmd_sensor_temperature` | `sensor.timmerflotte_temp_hmd_sensor_humidity` |
| Bedroom | `sensor.alpstuga_air_quality_monitor_temperature` | `sensor.alpstuga_air_quality_monitor_humidity` |
| Babyroom | `sensor.babyroom_babyroom_temperature` | `sensor.babyroom_babyroom_humidity` |
| Bath | `sensor.timmerflotte_temp_hmd_sensor_temperature_5` | `sensor.timmerflotte_temp_hmd_sensor_humidity_5` |
| Hall | `sensor.timmerflotte_temp_hmd_sensor_temperature_3` | `sensor.timmerflotte_temp_hmd_sensor_humidity_3` |

Only the temperature halves for Bath and Hall appeared on the old dashboards;
their humidity counterparts were inferred from the Timmerflotte's combined
temp/humidity pairing and then confirmed to exist.

There is **no outdoor temperature sensor** in this instance — the dashboard's
badge row uses Living Room temperature, fountain level and CO₂ instead.

### Outdoor temperature — from the weather integration

The climate card's "Outside" strip does not use a sensor. It takes the first
entity in the `weather` domain and reads its `temperature` attribute, because
that id depends on how the weather integration was named at setup and is not
worth pinning. Confirm what yours is with:

```sh
python scripts/ha.py entities 'weather.*'
```

If the strip never appears, either there is no weather integration configured
or the entity reports no `temperature` attribute. Both cases hide the strip
rather than showing a wrong or zero value.

---

## Air quality — Alpstuga monitor

This device also provides the Bedroom temperature and humidity above.

| Entity ID | Meaning |
|---|---|
| `sensor.alpstuga_air_quality_monitor_carbon_dioxide` | CO₂ ppm |
| `sensor.alpstuga_air_quality_monitor_pm2_5` | PM2.5 |

---

## Water leak

| Entity ID | Notes |
|---|---|
| `binary_sensor.klippbok_water_leak_sensor_water_leak` | Under the kitchen sink. `on` = wet |

Neither `attention-card.yaml` nor `packages/water_leak.yaml` names it. Both find
leak sensors by `device_class: moisture`, so a second one is covered the moment
it is paired — which for a leak alarm matters more than the precision of a fixed
list. It is recorded here so the set is known, not because anything reads it.

---

## Derived entities created by this repo

Not from any integration — these are created by the packages in `packages/` and
will not exist until those are installed (see [SETUP.md](SETUP.md#packages-automations)).

| Entity ID | Created by | Meaning |
|---|---|---|
| `sensor.cat_water_7_day_average` | `packages/cat_water_anomaly.yaml` | Trailing 7-day mean of daily fountain intake, from a `statistics` sensor over `yesterday_s_water_consumption` |
| `binary_sensor.cat_in_litter_box` | `packages/litter_box.yaml` | The Myggspray occupancy sensor with a 5-minute cooldown: stays `on` until the raw sensor has been clear for 5 minutes, so one visit is one `on` |
| `sensor.litter_box_visits_today` | `packages/litter_box.yaml` | Visits since midnight — `on` transitions of `binary_sensor.cat_in_litter_box`, from `history_stats` |

It reads empty for roughly the first week, and the automation stays deliberately
silent until `age_coverage_ratio` reaches 0.8 rather than comparing against an
average built from one or two days.

---

## Batteries

Not enumerated here on purpose. `attention-card.yaml` discovers batteries at
render time by walking every entity with `device_class: battery`, covering both
`sensor` (percentage) and `binary_sensor` (`on` = low). A list written down here
would go stale the next time a device is paired, and staleness is the specific
failure the card exists to prevent.

To see the current set:

```sh
python scripts/ha.py entities battery
```

Battery-powered devices in this instance: the IKEA Timmerflotte temp/humidity
sensors, the Bilresa scroll wheels, the Tado TRVs and the Alpstuga monitor.

A battery sensor that is `unavailable` or `unknown` is listed under **Not
reporting** rather than skipped. It used to be filtered out by the numeric
check, which made a dropped Thread sensor and a healthy one look identical.

**Threshold:** at or below 20% is listed; at or below 10% renders red. Both live
in `attention-card.yaml` as the `threshold` variable at the top.

**Ignored devices.** Some mains-powered devices still expose a battery entity
and park it at 0. The Granary feeder is plugged in and reports 0%, which is a
bogus value rather than a flat battery, so it is excluded via the `ignore` list
next to `threshold`. Entries match as substrings against the entity_id.

| Ignored | Why |
|---|---|
| `granary` | Granary feeder is mains-powered; its battery entity reads a fixed 0% |

The filter is per **device**, not per value — a blanket "hide anything reading
exactly 0" rule would also hide a genuinely dead battery, which is the single
reading this card most needs to show.

---

## Energy — Hildebrand Glow (DCC)

UK smart meter data over the DCC. **Electricity only** — no gas sensors exist on
this account.

| Entity ID | Unit | Meaning |
|---|---|---|
| `sensor.electricity_meter_cost_today` | GBP | Cost so far today, resets at midnight |
| `sensor.electricity_meter_usage_today` | kWh | Usage so far today, resets at midnight |
| `sensor.dcc_sourced_smart_electricity_meter_rate` | GBP/kWh | Unit rate |
| `sensor.dcc_sourced_smart_electricity_meter_standing_charge` | GBP | Fixed daily charge |

Two things to know about this data:

- **It lags by roughly half an hour.** DCC delivers in batches, so nothing here
  reacts to an appliance switching on, and no automation built on it can.
- **The rate and standing charge arrive in GBP, not pence.** A typical rate is
  `0.2431`, which rounds to a meaningless `0.24`. `energy-card.yaml` converts
  anything under £1 in a GBP unit to pence, matching how UK tariffs are quoted.

There is also `switch.hildebrand_glow_dcc_pre_release` and
`update.hildebrand_glow_dcc_update`; neither is used by the dashboard.

---

## AdGuard Home

Created by the `adguard` integration, which HA discovered from the
`a0d7b954_adguard` add-on. Used by `dashboards/home.yaml` and
`adguard-card.yaml`.

| Entity ID | Unit | Meaning |
|---|---|---|
| `sensor.adguard_home_dns_queries` | queries | Queries seen in the statistics window |
| `sensor.adguard_home_dns_queries_blocked` | queries | Of those, how many were blocked |
| `sensor.adguard_home_dns_queries_blocked_ratio` | % | Blocked as a share of total |
| `sensor.adguard_home_average_processing_speed` | ms | Mean time to answer a query |
| `sensor.adguard_home_safe_browsing_blocked` | queries | Blocked by the malware/phishing list |
| `sensor.adguard_home_safe_searches_enforced` | queries | Rewritten to a safe-search result |
| `sensor.adguard_home_parental_control_blocked` | queries | Blocked by parental control |
| `switch.adguard_home_protection` | | Master switch — off forwards everything unfiltered |
| `switch.adguard_home_filtering` | | Blocklists on/off |
| `switch.adguard_home_query_log` | | Whether AdGuard records individual queries |
| `switch.adguard_home_safe_browsing` | | Malware/phishing blocking |
| `switch.adguard_home_safe_search` | | Forces safe search on Google/Bing/YouTube |
| `switch.adguard_home_parental_control` | | Adult-content blocking |

Two things to know about this data:

- **The counters are a rolling window, not a day.** They cover AdGuard's
  statistics retention (24 h by default, set in its own UI), ageing queries out
  continuously instead of resetting at midnight. A flat line on the trend graph
  is a steady query rate; a cliff is AdGuard restarting.
- **None of the sensors carry a `state_class`,** so HA records no long-term
  statistics for them and `statistics-graph` plots nothing. The AdGuard view
  uses `history-graph` and `sensor` cards for that reason, which reach back only
  as far as recorder's `purge_keep_days`.

The add-on itself is **not** managed by this repo — it is installed through the
Supervisor and holds its own config (filter lists, per-client rules) in its data
directory. Only the dashboard reading it lives here.

---

## Lights and switches — Buttons view

| Entity ID | Notes |
|---|---|
| `switch.big_light` | |
| `switch.tree` | rendered green on the dashboard |
| `switch.kettelinch` | |
| `switch.lampadina` | |
| `light.kajplats_e27_ws_globe_1521lm` | full `light` card, brightness control |
| `light.kajplats_e14_ws_globe_806lm` | full `light` card, brightness control |

---

## Kindle Dashboard — not managed by this repo

`dashboard-giacomo` renders on a Kindle and is deliberately left out of the
manifest, so no deploy ever touches it. Its snapshot is in
`dashboards/_pulled/dashboard-giacomo.yaml`. It uses `eink-sensor-card.js` plus
`custom:mini-graph-card`, and reads the same climate sensors listed above.

---

## Helpers required by blueprints

`ikea-billresa-thermostat-boost.yaml` needs an `input_boolean` to track daily
boost usage, plus an automation to reset it at midnight. Record the helper's
entity ID here once created.

| Entity ID | Purpose |
|---|---|
| `input_boolean.thermostat_boost_used` | Daily boost lockout for the center-button blueprint |
