# Dashboards

`dashboards/home.yaml` is the one dashboard this repo deploys: phone-first,
six views, written over `dashboard-general` (the mapping is in
`dashboards/dashboards.yaml`). Anything not in that manifest is never touched;
in particular `dashboard-giacomo`, the Kindle Dashboard. Snapshots of every
dashboard as it was before the merge are in `dashboards/_pulled/`.

Entity IDs are in [ENTITIES.md](ENTITIES.md); the custom cards in
[CARDS.md](CARDS.md).

## Views

**Home**, at a glance:

- **Clock**: the built-in `clock` card.
- **Attention**: `attention-card.yaml`. Water leaks, sensors that stopped
  reporting, low batteries; renders nothing when everything is fine.
- **Climate**: six rooms in `climate-table-card.yaml` with an outdoor strip on
  top, then 24-hour temperature and humidity graphs.
- **Cat Fountain**: the water level (`petlibro-water-level-card.yaml`).
- **Energy**: today's cost, usage and unit rate from the Hildebrand Glow feed
  (`energy-card.yaml`), plus 30 days of daily cost.
- **Air Quality**: CO₂ and PM2.5 from the Alpstuga monitor.

**Fountain**: the fountain stat card and today-vs-yesterday chart, 30 days of
water drunk and drinking sessions, then **Litter Box**: today's visits, the
last visit, a 24-hour timeline and 30 days of visits (needs
`packages/litter_box.yaml`).

**AdGuard**: query and block counts (`adguard-card.yaml`), 24-hour trends, and
a tile per AdGuard switch. AdGuard Home is the LAN's DNS server, so what it
blocks is blocked for every device.

**Heating**: the controls for `packages/heating.yaml`. A status line, the
target, a slider that holds a temperature until the next block, Boost /
Cancel boost / Resume tiles, 24 hours of target vs bedroom vs what was sent to
tado, and the details (bias, setback, the Live switch).

**Appliances**: stats for the SmartThings washer, dryer and robot vacuum, no
controls. A status line each, cycles and kWh this month, the last cycle's
length and energy, a 48-hour timeline of wash and dry phases, cycles per week,
and energy per day and per month (`packages/appliances.yaml`).

**Buttons**: the light and switch buttons.

## Layout

Every view is `type: panel`, which renders one card at full width. Sections
views cap each column at 500px, adjustable only from a theme. So each view
holds a single `vertical-stack`, and multi-column parts use a `grid` card.

Side margins come from [`card-mod`](https://github.com/thomasloven/lovelace-card-mod):
each view's stack is wrapped in a `custom:mod-card` whose `ha-card` is padded
12px. It has to be that wrapper: card-mod can't style a stack or a view
directly.

The custom cards are pulled in with `!include` from the copies at the repo
root, so the standalone versions and the dashboard can't drift apart.

## Themes

`themes/wide-sections.yaml` is **unused**, kept in case the dashboard moves
back to sections views. In a sections view, column widths and gaps are theme
variables (500px columns by default); this theme widens the column to 760px
and tightens the gutters. It has to be copied into HA by hand (steps in the
file), since the API writes dashboards, not config files. A view opts in with
`theme: wide_sections`.
