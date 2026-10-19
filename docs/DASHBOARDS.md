# Dashboards

The repo deploys four dashboards (the mapping is in
`dashboards/dashboards.yaml`):

- `dashboards/home.yaml` over `dashboard-general`: phone-first, six views.
- `dashboards/tablet.yaml` as `dashboard-tablet`: the wall tablet (below).
- `dashboards/laptop.yaml` as `dashboard-laptop`: the laptop (below).
- `dashboards/phone.yaml` as `dashboard-phone`: the phone (below).

Anything not in that manifest is never touched; in particular
`dashboard-giacomo`, the Kindle Dashboard. Snapshots of every dashboard as it
was before the merge are in `dashboards/_pulled/`.

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
  (`energy-card.yaml`), plus 30 days of daily usage (not cost: see
  [ENTITIES.md](ENTITIES.md#energy--hildebrand-glow-dcc)).
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
Cancel boost / Resume tiles, 24 hours of target vs bedroom vs the computed
setpoint vs what tado is actually set to, and the details (bias, setback, the
Live switch).

**Appliances**: stats for the SmartThings washer, dryer and robot vacuum, no
controls. A status line each, cycles and kWh this month, the last cycle's
length and energy, a 48-hour timeline of wash and dry phases, cycles per week,
and energy per day and per month (`packages/appliances.yaml`).

**Buttons**: the light and switch buttons.

## Tablet

The wall tablet, a Galaxy Tab A7 in portrait (about 800×1280 CSS px): the
state of the house on one screen, read from across the room. A clock and the
weather, warnings (lights offline, water leaks; hidden when there are none),
the heating with −/+, Boost, Back to schedule, the boiler's time on today
and today's schedule as a bar, the six rooms, eight small tiles (fountain, litter box, energy, air, washer,
dryer, vacuum, network) and the lights as toggles. Light colours by day,
dark and dim from 22:00 to 07:00.

It is one card, `www/tablet-panel-card.js` (see [CARDS.md](CARDS.md)), on a
panel view; `tablet.yaml` only lists its entities. On the tablet, open
`/dashboard-tablet/panel?kiosk`: the `?kiosk` makes kiosk-mode (HACS) hide
HA's header and sidebar, so the same dashboard opens normally elsewhere.

## Laptop

Seven pages for checking and changing things at a desk, with a sidebar of
their own: **Home** (heating controls, rooms, lights, a summary of each other
page, 24 hours of room temperatures), **Heating** (controls, the live switch,
what the controller sees and computes, 24 hours of target vs bedroom vs
computed vs what tado is set to, shaded where the boiler was on, 31 days of
boiler hours, today's blocks and the week's schedule), **Cat** (fountain, drinking, litter
box, today against yesterday, 31 days of water, sessions and visits),
**Energy** (kWh per measured device by day and month, and a unit rate box that
turns them into pounds), **Appliances** (washer, dryer and vacuum with their
switches and Start cleaning, the Steam Machine, energy per day and month), **Network** (the
internet connection, then AdGuard counts, 24 hours of queries, its switches),
**Mesh** (the Thread network: which devices relay, how good each link is, and
which battery device hangs off which relay) and **Lights** (each light with
why it's offline and what to do, brightness, plugs, all off).

Each page is a panel view holding `www/laptop-dashboard-card.js` with its
`page:`. The entities are in `dashboards/house.yaml`, which `laptop.yaml` and
`phone.yaml` each `!include` as every view's `house:`.
Charts come from HA's history and long-term statistics, read over the
viewer's own connection. Open `/dashboard-laptop/home?kiosk` to hide HA's
header; the card's sidebar keeps the `?kiosk` from page to page.

Energy is only what measures itself (washer, dryer, vacuum, the Grillplats
plug): there's no smart meter, and the Glow feed's daily totals came out
below what the washer and dryer alone used, so the laptop shows no house
total. The rate is `input_number.electricity_unit_rate` (`packages/energy.yaml`).

The **internet** comes from the router (ICOTERA, UPnP integration): up or
down, download and upload now and over 24 hours in Mbit/s, outages in the
last 7 days, and how long since the router restarted (its Uptime sensor, which
the integration leaves disabled until it's enabled under the device). The
speeds are the house's traffic, not the line's top speed. The line down, or the
router not answering for 5 minutes, shows in the alerts on all three
dashboards; the tablet reads it from `internet_entity`.

The **Mesh** page reads HA's Matter diagnostics for every Thread device (the
same JSON as *Download diagnostics*), so it needs an **admin** login; anyone
else sees a note instead. From each device's neighbour table it draws the
relays and the links between them (signal, share of messages resent) and puts
each battery device under the relay it uses, with its restarts, its offline
spells in the last 7 days (from history) and its battery. A relay HA doesn't
know, like the Aqara hub, is named by Thread address under `thread.names` in
`house.yaml`. Battery devices refresh their link details rarely, so those can
be hours old.

Offline sensors are in the alerts on all three dashboards, by the rule of the
old dashboard's `attention-card.yaml`: a battery sensor without a number (the
Granary feeder aside). The phone notification for a dropped Thread sensor is
the UI automation *Alert when a Thread sensor goes unavailable*, not this repo.

The **Steam Machine** (the gaming and media-centre PC) has no integration:
its GRILLPLATS plug's power says when it's on (5 W or more; standby is under
2 W). The Appliances page shows it on or off, the watts, how long it's been
on today and over 7 days, its energy this month, and a 7-day timeline built
from HA's 5-minute power statistics (kept about 10 days). The plug's switch is
on no page on purpose: off would cut the machine's power mid-session.

## Phone

The laptop's pages with `layout: phone`: no sidebar and one column. Home
follows the phone design: the heating with −/+, today's schedule as a bar and
Boost / Back to schedule, the lights as a two-column grid, the rooms, and a
House list (cat, energy, appliances, network, lights) leading to the other
pages, each of which has a "‹ Home" link back. Open
`/dashboard-phone/home?kiosk`, or set it as the companion app's default
dashboard.

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
