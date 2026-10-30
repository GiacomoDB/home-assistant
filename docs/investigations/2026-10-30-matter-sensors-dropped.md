# Two Matter sensors dropped off Thread, 2026-10-30

**Status:** open. ALPSTUGA fixed by a power cycle. Hall timmer still
offline: the sensor factory-reset and re-paired as "Hall timmer" at 12:06 was
the **living room** one (see [the mix-up](#the-mix-up)). As of 2026-10-30
12:50 UTC.

All times UTC, which is also UK local time since the clocks went back on
Oct 25.

## Symptoms

Two sensors went `unavailable` in the Matter integration the same day:

| Device | Node | Last reading | Unavailable from | Power |
|---|---|---|---|---|
| **Hall timmer** (IKEA TIMMERFLOTTE temp/humidity, fw 1.0.21) | 14 (`@1:e`) | 04:24 | 04:33 | AAA, 65% / 2.57 V |
| **ALPSTUGA** air quality monitor (IKEA, fw 1.0.26) | 8 (`@1:8`) | 10:30 | 10:35 | USB, mains |

A third Matter device, **Lampada Cucina** (KAJPLATS E27 bulb, node 10), was
also unavailable, but that's normal for it: since at least Oct 27 it comes
online for a few minutes most evenings and drops again, which is the bulb
being switched at the wall.

## The mesh at the time

Thread network on channel 11, credentials from Google (`thread.datasets`),
no OpenThread Border Router add-on. Border router in the mesh: the Aqara hub
(extended address `566e8370c00f8e0a`, named in `dashboards/house.yaml`). It
isn't on HA's Matter fabric, so its own tables can't be read.

| Node | Device | Role |
|---|---|---|
| 19 (`@1:13`) | Badjour (KAJPLATS E14 bulb) | **Leader** |
| 8 (`@1:8`) | ALPSTUGA | Router |
| 13 (`@1:d`) | GRILLPLATS plug | Router |
| 10 (`@1:a`) | Lampada Cucina | REED, when powered |
| 14 (`@1:e`) | Hall timmer | Sleepy, child of **Badjour** at −87 dBm, LQI 2. Removed from HA at ~12:05; the sensor itself is still unpaired |
| 18 (`@1:12`) | Kitchen timme | Sleepy, child of Badjour at −93 dBm, **LQI 1** |
| 29 (`@1:1d`) | Babyroom timme | Sleepy, child of ALPSTUGA at −92 dBm, LQI 1 (moved elsewhere when ALPSTUGA dropped) |
| 5, 6 | Occupancy (MYGGSPRAY), BILRESA scroll wheel | Sleepy, children of Badjour, good links |
| 9, 15, 16 | KLIPPBOK leak sensor, LivRoom and Bathroom timmers | Sleepy, under the Aqara hub (from their own, older tables). Node 15's sensor is now node 30 |

LQI runs 0–3. Anything at LQI 1, or below about −85 dBm, is on the edge.

## Timeline

- **Oct 27 18:58**: HA restart. Every node reconnects, including both.
- **Oct 28 22:28 / 22:31**: one routine subscription timeout each, both
  recovered within seconds.
- **Oct 30 04:00**: the *Keep IKEA Thread sensors alive* automation presses
  `identify` on Hall timmer; it answers.
- **04:24**: Hall timmer's last reading.
- **04:30**: the Matter server's subscription to it times out (5 m 38 s),
  probes fail, the address is unreachable. **04:33** marked unavailable.
- **10:30**: ALPSTUGA's last reading. **10:32** subscription times out
  (1 m 39 s), probes fail. **10:35** marked unavailable.
- **~11:00**: live neighbour tables read from Badjour and the GRILLPLATS plug:
  neither lists ALPSTUGA any more (both did before), and Badjour no longer
  lists Hall timmer as a child. `ping_node` fails for both.
- **~11:16**: both power-cycled by hand. ALPSTUGA is back at **11:17** (boot
  reason *power on*, reboot count 18). Hall timmer doesn't come back.
- **11:25**: still no router claims Hall timmer, and ping still fails.
- **11:49**: the **living room** sensor (node 15) gets fresh batteries:
  2.55 V → 2.89 V, 54% → 100%. Back online at 11:50.
- **~12:05**: the Hall timmer device (node 14) is removed from HA.
- **12:06:11**: a TIMMERFLOTTE is commissioned as node 30 (`@1:1e`) and named
  "Hall timmer". It joins as a child of the GRILLPLATS plug at −65 dBm, LQI 3.
  Entity IDs renamed to the hall's `_3` ones by 12:09.
- **12:06:24**: node 15, LivRoom timmer, stops acknowledging. Subscription
  times out at 12:08, unavailable at 12:15.
- **12:46**: LivRoom timmer reported as dropped. The flight recorder shows no
  router reboot, no partition change, and LivRoom under the Aqara hub (never
  claimed by a readable router) throughout, so nothing on the mesh explains
  it. Node 30's Matter unique ID (`0/40/18`) is `0af6c730…2e85`, the same as
  node 15's: **node 30 is the living room sensor.** Its last living room
  reading (21.56 °C at 12:03) is node 30's first.

## What we checked

- **Matter, HA or the Matter server at fault?** No. Every other node stayed
  connected through both drops, the HA core log has nothing Matter-related,
  and in both cases the server's own log shows the node simply stopped
  answering, then became unreachable over Thread. Ruled out.
- **A shared cause (border router, mesh outage)?** No. The two drops are six
  hours apart, and at each moment nothing else on the mesh had trouble.
  Ruled out.
- **Batteries.** Hall timmer read 65% / 2.57 V right before, in line with the
  other timmers (55–77%). ALPSTUGA is USB-powered. Ruled out.
- **Firmware updates.** Both are on the latest firmware HA knows of. Nothing
  to update.
- **Early warning in the logs.** The Matter server log goes back to Sep 11.
  ALPSTUGA had 122 brief subscription timeouts before today (a few a week),
  Hall timmer about 30, all recovered within seconds; nothing unusual in the
  days before. No decline to see.
- **Thread partitions.** The live routers all agreed (partition 2133470835,
  leader 41). The battery devices' cached values disagree with each other,
  but those caches are days old, so that proves nothing either way. There was
  no recorded history of this to compare against.

## Cause

**ALPSTUGA froze.** A mains router that vanishes from every other router's
neighbour table is either unpowered or hung, and it came straight back from a
power cycle. With its firmware current and nothing else wrong on the mesh at
10:32, the best explanation is a firmware hang in the device itself.
Confidence: fairly high that it hung; what made it hang is unknown.

**Hall timmer lost a weak link and can't get back on.** Its only parent was
Badjour, at −87 dBm and LQI 2, already marginal. After it dropped, no router
listed it as a child, and a battery reseat didn't change that. What tipped it
over at 04:24 is unknown: Badjour has been up for 40 days, so the lamp
wasn't switched off. Either it can't hear any router from where it sits, or
it's stuck in a state a reboot doesn't clear. The test below tells those two
apart.

## The mix-up

The TIMMERFLOTTEs look identical. The sensor that got new batteries at 11:49
and the factory reset at 12:06 was the living room one, so:

- "Hall timmer" in HA (node 30, entities `_3`) is physically the **living room**
  sensor. The hall series has living room readings from 12:07.
- "LivRoom timmer" (node 15, entities `_4`) is dead: its sensor was reset.
- The **real Hall timmer** was never reset. HA has forgotten it, so it needs a
  factory reset and re-pair anyway. Which sensor got the 11:16 battery reseat
  isn't known, so whether the hall one would have come back from a reseat is
  open too.

Before resetting a sensor, press its **Identify** button in HA and check that
it's the one that blinks. An offline sensor can't do that, so instead, find
every sensor that *does* blink and rule those out. Labelling them would help.

## Fix

- ALPSTUGA: power cycle. Worked.
- Hall timmer: still to do. Make node 30 the living room sensor again (remove
  node 15, rename node 30's entities `_3` → `_4`, name it LivRoom timmer), then
  factory-reset the real Hall timmer, pair it, and rename its entities to
  `_3`.

  How to re-pair a sensor and keep its entity IDs and history:
  1. Remove the old device (Matter → device → ⋮ → Remove device), so its
     entity IDs are free.
  2. Pair the reset sensor, name the device and set its area. Say **no** when
     HA offers to rename the entity IDs to match.
  3. Rename each new entity's ID back to the old one (here `_2` → `_3`).

  The recorder then logs `Cannot rename statistic_id ..._2 to ..._3` and
  `Cannot migrate history`, which is the good outcome: the old `_3` history and
  long-term statistics stay, and the new readings carry on in the same series,
  with a gap for the outage. Only the minutes recorded under `_2` before the
  rename are left behind.

## Follow-ups

- **Added: the Thread flight recorder** (`packages/thread_log.yaml`,
  `scripts/thread_snapshot.py`). What stopped this investigation was having no
  history of the mesh itself. It now snapshots every router's neighbour and
  route tables, roles, partitions, reboot counts and boot reasons every 15
  minutes and whenever a Matter device drops or returns. Next time, check
  `/config/thread_log/` first: see [the toolbox](README.md#reading-the-thread-log).
- **Kitchen timme** is the next one likely to drop: child of Badjour at
  −93 dBm, LQI 1.
- **Lampada Cucina** is switched at the wall, so it's a router that comes and
  goes. Children that pick it as a parent get stranded each time it's turned
  off. Better left always powered, or replaced by a smart plug as a router.
- **The GRILLPLATS plug** had over 2,000 subscription timeouts between Sep 28
  and Oct 19, none since Oct 22. Not related to this, and unexplained. Worth a
  look if it comes back.
- **If ALPSTUGA freezes again**, it's the device: a smart plug that
  power-cycles it after 10 minutes unavailable would make it self-healing,
  and it's worth reporting to IKEA with its firmware version.
- The Matter Server add-on went from 9.2.0 to 9.3.0 (matter.js 0.17.9 → 0.18.0)
  the same day, after both drops. If they recur, that's a variable that changed.
- **The flight recorder's blind spot** showed straight away: LivRoom timmer
  sits under the Aqara hub, whose tables can't be read, so the recorder had
  nothing on its link. The Matter server log and the unique IDs solved it.
- **First flight-recorder snapshot**, 12:00: all four routers on one partition
  (2133470835, Badjour leading), Hall timmer still unreachable and orphaned.
  Note that `orphans` also lists the devices under the Aqara hub (KLIPPBOK,
  LivRoom, Bathroom, Babyroom), since its table can't be read; what matters is
  a device joining or leaving that list.
