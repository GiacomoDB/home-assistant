# Home Assistant

Source of truth for my Home Assistant setup: dashboards, custom cards and
blueprints. Dashboards are validated on every pull request and deployed to Home
Assistant by GitHub Actions on every push to `main`.

```
dashboards/          dashboard configs + the manifest that maps them to HA
packages/            automations + their helper entities — copied to HA by hand
themes/              theme files — copied to HA by hand, not deployable
scripts/ha.py        deploy / entity-lookup / validate CLI
docs/SETUP.md        credentials, GitHub secrets, reverse-proxy notes
docs/ENTITIES.md     every entity ID this repo depends on
.github/workflows/   the deploy pipeline
```

**Start here:** [docs/SETUP.md](docs/SETUP.md).

## Dashboards

### Home

`dashboards/home.yaml` — phone-first, three views, deployed over the dashboard
at `dashboard-general`.

**Home** — the at-a-glance view:

- **Clock** — the built-in `clock` card at the top, no HACS dependency.
- **Attention** — `attention-card.yaml`: water leaks, sensors that have stopped
  reporting, low batteries. Renders nothing at all when everything is fine.
- **Climate** — all six rooms (Living Room, Kitchen, Bedroom, Babyroom, Bath,
  Hall) as a 3-across grid via `climate-table-card.yaml`, with an outdoor
  temperature strip on top. 24-hour statistics graphs below.
- **Cat Fountain** — just the water level, via
  `petlibro-water-level-card.yaml`.
- **Air Quality** — CO₂ and PM2.5 line graphs from the Alpstuga monitor.

**Fountain** — the detail: the `html-template-card` stat card, the `apexcharts`
today-vs-yesterday chart, and 30-day daily-total bar charts for water drunk and
drinking sessions.

**Buttons** — the light and switch buttons.

Side margins come from [`card-mod`](https://github.com/thomasloven/lovelace-card-mod):
each view's `vertical-stack` is wrapped in a `custom:mod-card`, whose `ha-card`
is padded 12px. Panel views render edge-to-edge and `grid_options` does nothing
outside a sections view, so this is the available lever. It has to be the
wrapper rather than `card_mod` on the stack itself — card-mod has no handling
for stack or view elements, so styling them directly does nothing.

The four custom cards are pulled in with `!include` from the maintained copies
at the repo root, so the standalone versions and the dashboard can't drift
apart. That means this dashboard needs `html-template-card` and
`apexcharts-card` from HACS.

This dashboard was merged from two older ones. `dashboard-giacomo`, which
renders the Kindle Dashboard, is deliberately left out of the manifest and is
never written to. Pre-merge snapshots of everything live in
`dashboards/_pulled/`.

### Themes

Column widths and section gaps in a sections view are **theme variables**, not
dashboard config — Home Assistant caps each column at 500px by default, and
that cannot be changed from the YAML this repo deploys.

`dashboards/home.yaml` sidesteps this by using `type: panel` views, which
render a single card edge-to-edge at full width with no theme and no HACS
dependency — so this file is currently **unused**.

It's kept as the alternative: `themes/wide-sections.yaml` widens the sections
column to 760px and tightens the gutters, for if the dashboard ever moves back
to sections views. It has to be copied into your HA config by hand (install
steps are in the file); the WebSocket API used by `scripts/ha.py` writes
dashboards only, not config files. Once installed, a view opts in with
`theme: wide_sections`.

### Deploying

One-time setup:

```sh
python3 -m venv venv
./venv/bin/pip install -r scripts/requirements.txt
```

Then, per shell:

```sh
export HA_URL=https://ha.example.com
export HA_TOKEN=...
```

| Command | Does |
|---|---|
| `python3 scripts/ha.py validate` | Parse the YAML offline; no credentials needed |
| `python3 scripts/ha.py dashboards` | List what's in HA and which ones this repo owns |
| `python3 scripts/ha.py pull` | Snapshot live configs to `dashboards/_pulled/` |
| `python3 scripts/ha.py pull-automations` | Snapshot UI automations to `automations/_pulled/` |
| `python3 scripts/ha.py stats` | Which entities have long-term statistics, and which `stat_types` work |
| `python3 scripts/ha.py entities fountain` | Look up entity IDs |
| `python3 scripts/ha.py deploy --dry-run` | Check entities without writing |
| `python3 scripts/ha.py deploy` | Push dashboards for real |
| `python3 scripts/ha.py reload` | Reload YAML after editing packages (`--restart` for a full restart) |
| `HA_SSH_HOST=… scripts/push-packages.sh` | Validate, copy `packages/` over SSH, reload |

`scripts/ha.py` re-runs itself under `venv/` automatically, so plain `python3`
is correct regardless of what's on your `PATH`.

Only dashboards listed in `dashboards/dashboards.yaml` are deployed; everything
else in your instance is left alone. See
[docs/SETUP.md §0](docs/SETUP.md) for keeping or merging existing dashboards.

In CI the same `deploy` step runs with `HA_URL` and `HA_TOKEN` repository
secrets. Deploys overwrite the live dashboard, so edit the YAML here rather than
in the HA UI.

## Automations

`packages/` holds one HA [package](https://www.home-assistant.io/docs/configuration/packages/)
per feature — the automation plus any helper entity it needs, kept together in a
single file so neither can be installed without the other.

| Package | Does |
|---|---|
| `cat_water_anomaly.yaml` | Compares yesterday's fountain intake against a trailing 7-day average, notifying on a 35%+ deviation in either direction. A sustained change in a cat's water intake is worth catching early, and it is not something you notice by glancing at a chart. |
| `bath_humidity.yaml` | Notifies when the bathroom stays above 70% humidity for two hours *and* sits 10+ points above the hall — sustained damp rather than the harmless spike after a shower. |
| `water_leak.yaml` | High-priority repeating alarm while any `device_class: moisture` sensor is wet, with an all-clear when it dries. The only alert here where minutes matter, so it is deliberately louder than the rest. |

All three push to `notify.mobile_app_pixel_8_pro` and also raise a persistent
notification, so an alert survives an undelivered push. `notify_target` at the
top of each automation's variables is the single place to change that.

**These are not deployed by `ha.py deploy`.** The WebSocket API can write
dashboards but not arbitrary config files, so packages go over SSH instead:

```sh
HA_SSH_HOST=homeassistant.local scripts/push-packages.sh
```

which validates, copies and reloads (`--restart` when a package adds a sensor). `ha.py validate` checks them either way — YAML
syntax, required automation fields, and the filename rule that
`!include_dir_named` imposes. See [docs/SETUP.md](docs/SETUP.md) for the
one-time `configuration.yaml` entry.

## Custom Cards

### A note on CSS in `html-template-card`

Always scope `ha-card` rules as `ha-card:has(.your-root-class)`. Never write a
bare `ha-card { ... }`.

`hui-card` opts out of shadow DOM (`createRenderRoot()` returns `this`), so
every card in a stack renders into the *stack's* shadow tree. `html-template-card`
has no shadow root either, which puts its `<style>` **and** its `<ha-card>` in
that shared tree — so a bare `ha-card` rule reaches every sibling card that also
lacks a shadow root, meaning every other `html-template-card` on the view. Cards
written as ordinary LitElements keep their `ha-card` inside their own shadow root
and are unaffected, which is what makes this easy to ship without noticing: it
looks fine until two of these cards share a view.

A `display: none` written that way blanks the neighbouring cards outright, which
is precisely how the battery card's empty state once hid the climate table.

`python scripts/ha.py validate` fails on an unscoped selector, so CI catches it
before a deploy does.


### E-ink Sensor Card

A minimal sensor card designed for e-ink displays. Shows sensor value with one decimal place, unit, and optional label.

**Features:**
- Clean black text on white background
- Configurable font sizes for value, unit, and label
- Automatic rounding to one decimal place
- Grid layout options

**Installation:**
1. Copy `eink-sensor-card.js` to your `www` folder
2. Add as a resource in your dashboard

**Example configuration:**
```yaml
type: custom:eink-sensor-card
entity: sensor.temperature
name: Living Room
unit: °C
value_font_size: 120
unit_font_size: 40
label_font_size: 32
```

### Climate Table Card

Room-by-room temperature and humidity as a compact table with column headers,
aligned columns and row dividers.

Replaces a stack of `heading` cards carrying entity badges, where the room name
and its readings sat at opposite edges of the card with a wide gap between
them, and nothing labelled which number was which measurement.

**Requires:** the `html-template-card` custom card (installable via HACS).

Rooms are a list at the top of the template — one entry per room, as
`[label, temperature entity, humidity entity]` — so adding or reordering rooms
is a one-line edit. Sensors that are unavailable render as `—` rather than 0.

It also carries an **outdoor temperature strip** above the grid, which supplies
the context the indoor numbers lack. There is no outdoor sensor in this
instance, so the reading comes from the weather integration — discovered as the
first entity in the `weather` domain rather than hardcoded, since that id
depends on how the integration was named at setup. With no weather integration,
or none reporting a temperature, the strip omits itself.

**Sensors used:** see [docs/ENTITIES.md](docs/ENTITIES.md#climate).

### Attention Card

`attention-card.yaml` — water leaks, sensors that have stopped reporting, and
low batteries. Renders nothing whatsoever when everything is fine.

**Requires:** the `html-template-card` custom card (installable via HACS).

One card rather than three, because these share a job: be impossible to miss
when they matter and take up no room at all the rest of the time. Groups are
ordered by how fast you need to act — a leak is measured in floorboards, a low
battery in days.

The **Not reporting** group exists because a sensor that has stopped reporting is
not "fine", but the climate grid renders it identically to a healthy one. The
IKEA Thread sensors here drop often enough to warrant an automation pressing
`identify` on five of them every two hours, so a dropped sensor is a routine
event worth surfacing rather than an exotic one.

Nothing is a hardcoded entity list: leaks are found by `device_class: moisture`
and batteries by `device_class: battery`, so a newly paired device is covered
immediately — a fixed list would silently stop covering new devices, which is
the exact failure this card exists to catch. The tradeoff is that iterating
`states` subscribes the template to all state changes, which is why this pattern
is used once here rather than in several cards.

Batteries handle both flavours: `sensor` (a percentage) and `binary_sensor`
(`on` = low, no number available). Binary ones sort first, then percentages
ascending; at or below half the threshold the figure turns red.

An `ignore` list next to the threshold excludes mains-powered devices that
expose a battery entity anyway and park it at 0 — the Granary feeder does this.
Entries match as substrings against the entity_id. The filter is per device
rather than per value on purpose: hiding everything that reads exactly 0 would
also hide a genuinely dead battery. See
[docs/ENTITIES.md](docs/ENTITIES.md#batteries).

### Petlibro Fountain Card

A styled card for a Petlibro / Dockstream smart water fountain. Shows remaining water, today's consumption and drinking stats, and a comparison against **the same time yesterday** (yesterday's totals prorated to the fraction of the day elapsed so far), so the comparison reflects pace rather than partial-day vs. full-day.

**Requires:** the [`html-template-card`](https://github.com/PiotrMachowski/Home-Assistant-Lovelace-HTML-Jinja2-Template-card) custom card (installable via HACS).

**Installation:**
1. Add the card to a dashboard (Edit dashboard → Add card → Manual).
2. Paste the contents of `petlibro-fountain-card.yaml`.
3. Adjust the `sensor.dockstream_smart_fountain_*` entity IDs to match your device.

**Sensors used:**
- `sensor.dockstream_smart_fountain_remaining_water_2`
- `sensor.dockstream_smart_fountain_today_s_water_consumption`
- `sensor.dockstream_smart_fountain_today_s_average_drinking_time`
- `sensor.dockstream_smart_fountain_today_s_total_drinking_time`
- `sensor.dockstream_smart_fountain_today_s_total_drinking_times`
- `sensor.dockstream_smart_fountain_yesterday_s_water_consumption`
- `sensor.dockstream_smart_fountain_yesterday_s_total_drinking_times`

Ex:   
<img width="298" height="526" alt="Screenshot 2026-08-02 at 17 26 07" src="https://github.com/user-attachments/assets/6c9f8f80-aa3c-4d50-96a6-2b314042a540" />

### Petlibro Water Level Card

A deliberately minimal companion to the card above: the percentage, a status
word (Good / Top up soon / Refill now) and a colour-coded bar. Intended for an
overview dashboard where the full stat card would be too much.

**Requires:** the `html-template-card` custom card (installable via HACS).

Thresholds match `petlibro-fountain-card.yaml` — above 50 % blue, above 25 %
amber, below that red. Keep the two in sync if you change one.

**Sensors used:**
- `sensor.dockstream_smart_fountain_remaining_water_2`

### Petlibro Fountain Chart Card

A line chart comparing today's cumulative water consumption against yesterday's, overlaid on the same time-of-day axis. Pairs with the stat card above.

`html-template-card` renders plain Jinja and has no access to sensor history, so the chart can't live inside that card — it's a separate card driven by [`apexcharts-card`](https://github.com/RomRider/apexcharts-card), which queries the recorder directly and has a built-in `offset` feature for exactly this "same time yesterday" overlay.

**Requires:** the `apexcharts-card` custom card (installable via HACS).

Configured with `grid_options: columns: full` so it spans the full width of a **Sections**-view dashboard; if your dashboard uses the classic Masonry layout instead, remove `grid_options` and use `card-mod` to span columns (Masonry has no native per-card width).

**Installation:**
1. Add the card to a dashboard (Edit dashboard → Add card → Manual).
2. Paste the contents of `petlibro-fountain-chart-card.yaml`.
3. Adjust the entity ID if your sensor name differs.
4. To show it together with the stat card, put both cards in a `vertical-stack` (Edit dashboard → Add card → Stack → Vertical stack → add both cards).

**Sensors used:**
- `sensor.dockstream_smart_fountain_today_s_water_consumption` (plotted twice: once as-is for "Today", once with `offset: -1d` for "Yesterday")

## Blueprints

### Scroll Wheel – Light Brightness Control

Controls light brightness with clockwise/counter-clockwise rotation.

<a href="https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FGiacomoDB%2Fhome-assistant%2Fblob%2Fmain%2Fikea-billresa-scrollwheel.yaml" target="_blank" rel="noreferrer noopener"><img src="https://my.home-assistant.io/badges/blueprint_import.svg" alt="Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled." /></a>

### Scroll Wheel – Thermostat Control

Controls Tado thermostat temperature with clockwise/counter-clockwise rotation.

<a href="https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FGiacomoDB%2Fhome-assistant%2Fblob%2Fmain%2Fikea-billresa-thermostat.yaml" target="_blank" rel="noreferrer noopener"><img src="https://my.home-assistant.io/badges/blueprint_import.svg" alt="Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled." /></a>

### Center Button – Tado Thermostat Boost (Once Per Day)

Boost Tado thermostats with multi-click on center button. 3-click and 6-click trigger different thermostats. Limited to one boost per day.

**Prerequisites:** Create an `input_boolean` helper to track daily usage, and a separate automation to reset it at midnight.

<a href="https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FGiacomoDB%2Fhome-assistant%2Fblob%2Fmain%2Fikea-billresa-thermostat-boost.yaml" target="_blank" rel="noreferrer noopener"><img src="https://my.home-assistant.io/badges/blueprint_import.svg" alt="Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled." /></a>
