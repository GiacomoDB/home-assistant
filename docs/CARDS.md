# Custom cards

The card files at the repo root. `dashboards/home.yaml` pulls them in with
`!include`, and each also works pasted into any dashboard as a manual card.
The HACS cards they need are listed in [SETUP.md §4](SETUP.md#4-custom-cards-hacs).

| File | Shows | Needs |
|---|---|---|
| `attention-card.yaml` | Leaks, sensors not reporting, low batteries; nothing when all is fine | html-template-card |
| `climate-table-card.yaml` | Temperature and humidity per room, outdoor strip on top | html-template-card |
| `energy-card.yaml` | Today's electricity cost, usage and rate | html-template-card |
| `adguard-card.yaml` | DNS queries, blocked, block rate | html-template-card |
| `petlibro-fountain-card.yaml` | Fountain level and drinking stats vs the same time yesterday | html-template-card |
| `petlibro-water-level-card.yaml` | Just the fountain level | html-template-card |
| `petlibro-fountain-chart-card.yaml` | Today's vs yesterday's intake on one time axis | apexcharts-card |
| `eink-sensor-card.js` | One sensor value, for the Kindle e-ink dashboard | nothing (a JS resource) |
| `www/tablet-panel-card.js` | The whole wall-tablet screen | nothing; deployed by CI |
| `www/laptop-dashboard-card.js` | One page of the laptop dashboard (`page: home`, `heating`, …) | nothing; deployed by CI |

Cards in `www/` deploy themselves: HA pulls them into `/config/www/repo/`
with the packages, and `ha.py deploy` points a dashboard resource at each
one with a `?v=` that changes with the file. `eink-sensor-card.js` predates
that and is still copied by hand.

## A note on CSS in `html-template-card`

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


## E-ink Sensor Card

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

## Climate Table Card

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

**Sensors used:** see [docs/ENTITIES.md](ENTITIES.md#climate).

## Attention Card

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
[docs/ENTITIES.md](ENTITIES.md#batteries).

## Energy Card

`energy-card.yaml` — today's electricity cost, usage and unit rate from
Hildebrand Glow (DCC), in the same 3-across grid as the climate card.

**Requires:** the `html-template-card` custom card (installable via HACS).

Units are read from each entity's `unit_of_measurement` rather than hardcoded,
so the card cannot disagree with the sensor. The rate and standing charge are
converted to pence when they arrive in GBP below £1 — a rate of `0.2431 GBP/kWh`
rounds to a meaningless `0.24`, whereas `24.31p/kWh` is how UK tariffs are
actually quoted. Guarded on both the unit and the magnitude, so a non-GBP unit
or a genuinely above-£1 rate is left exactly as reported.

The standing charge is a footnote rather than a fourth cell: it is fixed and you
cannot influence it, but without it the daily cost looks wrong on a low-use day.

**Sensors used:** see [docs/ENTITIES.md](ENTITIES.md#energy--hildebrand-glow-dcc).

## AdGuard Card

`adguard-card.yaml` — DNS queries, how many were blocked and the block rate, in
the same 3-across grid as the climate and energy cards.

**Requires:** the `html-template-card` custom card (installable via HACS).

Every figure covers AdGuard's own **rolling** statistics window — 24 hours out
of the box — not "today" and not HA's recorder. The count at 18:00 covers 18:00
yesterday to now and ages queries out continuously rather than resetting at
midnight. Change the retention in the AdGuard UI and the "Queries 24h" label
here is the thing to edit.

Blocked is rendered green: a high number is the system working. The footer
carries the average response time, and flips to a red warning when protection
or filtering is switched off — the one state where the counts above are
misleading, since they keep showing yesterday's blocks while nothing is being
filtered now.

None of the AdGuard sensors carry a `state_class`, so they record no long-term
statistics and `statistics-graph` renders empty against them. The trend cards on
that view use `history-graph` and `sensor` instead, which read recorder history
and so reach back only as far as `purge_keep_days`. `python3 scripts/ha.py
stats` reports these entities as NO STATS, which is expected.

**Sensors used:** see [docs/ENTITIES.md](ENTITIES.md#adguard-home).

## Petlibro Fountain Card

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

## Petlibro Water Level Card

A deliberately minimal companion to the card above: the percentage, a status
word (Good / Top up soon / Refill now) and a colour-coded bar. Intended for an
overview dashboard where the full stat card would be too much.

**Requires:** the `html-template-card` custom card (installable via HACS).

Thresholds match `petlibro-fountain-card.yaml` — above 50 % blue, above 25 %
amber, below that red. Keep the two in sync if you change one.

**Sensors used:**
- `sensor.dockstream_smart_fountain_remaining_water_2`

## Petlibro Fountain Chart Card

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
