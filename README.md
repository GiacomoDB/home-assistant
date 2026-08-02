# Home Assistant Custom Components

Custom blueprints and cards for Home Assistant.

## Custom Cards

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
