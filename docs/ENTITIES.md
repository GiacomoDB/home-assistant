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

---

## Air quality — Alpstuga monitor

This device also provides the Bedroom temperature and humidity above.

| Entity ID | Meaning |
|---|---|
| `sensor.alpstuga_air_quality_monitor_carbon_dioxide` | CO₂ ppm |
| `sensor.alpstuga_air_quality_monitor_pm2_5` | PM2.5 |

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
| _(not yet recorded)_ | Daily boost lockout for the center-button blueprint |
