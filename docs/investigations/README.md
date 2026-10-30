# Investigations

Write-ups of things that went wrong in the house and how they were tracked
down: what broke, what was checked, what it turned out to be, and what was
left open. The point is the next time: the same device drops again, or
something that looks similar does, and the evidence and the commands that
found it are already here.

One file per incident, named `YYYY-MM-DD-short-slug.md` after the day it
started. Keep the sections below, even when one is just "unknown". An honest
"we couldn't tell" is worth recording, and so is what would have told us.

```markdown
# <What broke>, <date>

**Status:** resolved / open / mitigated, as of <date>.

## Symptoms
What was noticed, by whom, and since when (times in UTC).

## Timeline
The facts in order, with sources (log lines, history, device readings).

## What we checked
Each lead, what it showed, and whether it was ruled in or out.

## Cause
What it was, or the best explanation and how sure we are.

## Fix
What was done, and whether it worked.

## Follow-ups
What's still open, and anything added so the next one is easier.
```

## Incidents

| Date | What | Status |
|---|---|---|
| 2026-10-30 | [Two Matter sensors dropped off Thread](2026-10-30-matter-sensors-dropped.md): ALPSTUGA froze, and a TIMMERFLOTTE dropped that turned out to have had its name swapped with another since April. Includes how to re-pair a Matter device and keep its entity IDs and history | Open |

## Toolbox

What's reachable from the laptop, and how. None of it needs `HA_TOKEN`.

### SSH into HA

`ssh root@homeassistant.local` (the Terminal & SSH add-on, LAN only; see
[SETUP.md](../SETUP.md#bootstrap-once-and-the-manual-fallback)). The add-on
has `jq`, `curl` and the `ha` CLI, but no `python3` or `sqlite3`. `/config` is
mounted. Port forwarding is off (`AllowTcpForwarding no`), so anything on HA's
internal network has to be queried from inside the add-on.

| What | Where |
|---|---|
| Entity and device registries | `/config/.storage/core.entity_registry`, `core.device_registry` (JSON; `jq` them) |
| HA core log | `ha core logs --lines 3000` |
| Matter server log, ~7 weeks | `ha apps logs core_matter_server --lines 50000` (strip colours with `sed "s/\x1b\[[0-9;]*m//g"`) |
| Thread flight recorder | `/config/thread_log/YYYY-MM.jsonl` (older months `.jsonl.gz`); see [below](#reading-the-thread-log) |
| Recorder history | `/config/home-assistant_v2.db`. `scp` it and its `-wal` file to a scratch folder and query the copy with `sqlite3` |

The Matter server log names nodes in hex: `@1:e` is node 14. Node IDs come from
the device registry's `deviceid_<fabric>-<node, 16 hex digits>-MatterNodeDevice`
identifiers.

Useful recorder query, the last real reading of an entity:

```sql
select s.state, datetime(max(s.last_updated_ts), 'unixepoch')
from states s join states_meta m using (metadata_id)
where m.entity_id = 'sensor.timmerflotte_temp_hmd_sensor_temperature_3'
  and s.state not in ('unavailable', 'unknown');
```

### Asking the Matter server directly

The Matter server's WebSocket API is at `ws://172.30.32.1:5580/ws` from inside
the SSH add-on, with no auth, and the add-on's `curl` speaks WebSocket. Pipe
commands in, give it time to answer, and pick the reply out with `jq`:

```sh
(sleep 1
 printf '%s' '{"message_id":"1","command":"read_attribute","args":{"node_id":19,"attribute_path":["0/53/7","0/53/1"]}}'
 sleep 5) | curl -s -N -m 8 -T - ws://172.30.32.1:5580/ws | jq -c 'select(.message_id=="1")'
```

| Command | Args | Gives |
|---|---|---|
| `get_nodes` | none | Every node with its cached attributes and `available`. A battery device's cache can be days old for anything it doesn't report on change |
| `read_attribute` | `node_id`, `attribute_path` (one path, a list, or a wildcard like `0/53/*`) | Live values from the device |
| `ping_node` | `node_id` | `{address: true/false}`: is it reachable over Thread at all |

Attributes that mattered so far (endpoint/cluster/attribute):

| Path | Meaning |
|---|---|
| `0/53/1` | Thread role: 2 sleepy end device, 3 end device, 4 REED, 5 router, 6 leader |
| `0/53/7` | Neighbour table. Per entry: `0` extended address, `5` LQI (0–3), `6` average RSSI, `7` last RSSI, `13` is my child |
| `0/53/8` | Route table: link quality to every other router |
| `0/53/9`, `0/53/13` | Partition ID, leader router ID. Two different values across routers means a split mesh |
| `0/53/14`–`21` | Counters: detached, child/router/leader role, attach attempts, partition changes, parent changes (optional; not every device has them) |
| `0/51/0` | Network interfaces. Field `4` is the Thread extended address (base64) |
| `0/51/1`, `0/51/2`, `0/51/4` | Reboot count, uptime in seconds, boot reason (1 power on, 2 brown-out, 3/4 watchdog, 5 update, 6 software reset) |
| `*/47/12`, `*/47/11` | Battery, in half-percent, and in mV |

Stick to these read commands. The same API can also remove nodes and
commission devices.

### Reading the Thread log

Each line is one snapshot (see `scripts/thread_snapshot.py` for every field).
On HA, for the current month (use `zcat <file> | jq ...` for a `.gz`):

```sh
cd /config/thread_log
# One battery device's parent and link over time
jq -r '[.ts, (.children["Hall timmer"] // {} | "\(.parent // "-") \(.rssi // "") \(.lqi // "")")] | @tsv' 2026-11.jsonl
# Router reboots and why: a line each time a router's reboot count moves
jq -r '.ts as $t | .routers[]? | [$t, .name, .reboots, .boot_reason] | @tsv' 2026-11.jsonl \
  | awk -F'\t' '$3 != seen[$2] { print; seen[$2] = $3 }'
# Did the mesh split? More than one partition in a snapshot
jq -r 'select(([.routers[]?.partition] | unique | length) > 1) | .ts' 2026-11.jsonl
# The snapshots taken because something dropped or came back
jq -c 'select(.reason == "change") | [.ts, [.nodes[] | select(.available | not) | .name], .orphans]' 2026-11.jsonl
```
