#!/usr/bin/env python3
"""Append one snapshot of the Thread mesh to /config/thread_log/. Runs INSIDE HA.

The flight recorder behind packages/thread_log.yaml, which runs it every 15
minutes and whenever a Matter device goes unavailable or comes back. HA's own
history says *that* a sensor stopped reporting; the Matter server's log says
it stopped answering. Neither says what the mesh looked like at the time:
which router a sensor hung off, how strong that link was, whether a router had
just rebooted or the network had split. Those only exist as live values on the
devices, gone by the time anyone looks. This keeps them.

  thread_snapshot.py [--reason schedule|change] [--trigger TEXT]

WHAT IT RECORDS (one JSON line per run, in /config/thread_log/YYYY-MM.jsonl)
- nodes: every Matter node with its name, Thread address, whether the Matter
  server can reach it, its Thread role and battery (from the server's cache,
  which a subscription keeps current), and for an unreachable node, whether
  it answers a ping.
- routers: for every reachable mains-powered node, read live: its role,
  partition and leader, reboot count, uptime and last boot reason, the
  Thread counters it supports (detached / parent changes / attach attempts,
  ...), its neighbour table (signal and link quality to each neighbour, and
  which neighbours are its children) and its route table (link quality each
way to every other router).
- children: each battery device's parent and link, worked out from the
  routers' neighbour tables. The battery devices themselves are never read:
  waking them every 15 minutes would cost battery, and their own copy of the
  table is hours old anyway. A battery device no router claims is listed in
  `orphans`: it's either attached to a router HA can't read (the Aqara hub,
  which isn't on HA's fabric) or detached.

About 6 KB a snapshot, so up to 20 MB for the current month. Finished months
are gzipped (to around 2 MB) and those older than the two before this one
are deleted.
Stdlib plus aiohttp, which Home Assistant itself depends on. Read-only
towards the devices: it only reads attributes and pings.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import gzip
import itertools
import json
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import aiohttp

CONFIG = Path("/config")
LOG_DIR = CONFIG / "thread_log"
DEFAULT_URL = "ws://core-matter-server:5580/ws"
KEEP_MONTHS = 3  # this month and the two before it

# HA's shell_command kills the process at 60 s; finish well inside that.
BUDGET = 45
CALL_TIMEOUT = 10
PING_TIMEOUT = 20

# Thread neighbours HA has no Matter node for, by extended address. Mirrors
# `thread.names` in dashboards/house.yaml, which this script can't read: only
# packages/ and scripts reach HA.
KNOWN_EXT = {
    "566e8370c00f8e0a": "Aqara hub",
}

ROLES = {0: "unspecified", 1: "unassigned", 2: "sleepy", 3: "end_device",
         4: "reed", 5: "router", 6: "leader"}
BOOT_REASONS = {0: "unspecified", 1: "power_on", 2: "brown_out",
                3: "software_watchdog", 4: "hardware_watchdog",
                5: "software_update", 6: "software_reset"}
# Thread Network Diagnostics counters (cluster 53), all optional; a device
# that lacks one simply leaves it out.
COUNTERS = {14: "detached", 15: "child_role", 16: "router_role",
            17: "leader_role", 18: "attach_attempts", 19: "partition_changes",
            20: "better_partition_attempts", 21: "parent_changes"}
ROUTER_PATHS = (
    ["0/53/1", "0/53/7", "0/53/8", "0/53/9", "0/53/13"]
    + [f"0/53/{attr}" for attr in COUNTERS]
    + ["0/51/1", "0/51/2", "0/51/4"]
)
NODE_ID = re.compile(r"^deviceid_[0-9A-F]+-([0-9A-F]{16})-MatterNodeDevice$")


class MatterServer:
    """Just enough of the Matter server's WebSocket API: commands in, results out."""

    def __init__(self, ws: aiohttp.ClientWebSocketResponse):
        self.ws = ws
        self.ids = itertools.count(1)
        self.pending: dict[str, asyncio.Future] = {}
        self.reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        async for msg in self.ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            data = json.loads(msg.data)
            future = self.pending.pop(str(data.get("message_id")), None)
            if future is None or future.done():
                continue  # an event, or an answer we stopped waiting for
            if data.get("error_code") is not None:
                future.set_exception(
                    RuntimeError(f"error {data['error_code']}: {data.get('details')}")
                )
            else:
                future.set_result(data.get("result"))
        for future in self.pending.values():
            if not future.done():
                future.set_exception(ConnectionError("Matter server closed the connection"))

    async def call(self, command: str, timeout: float = CALL_TIMEOUT, **args):
        message_id = str(next(self.ids))
        future = asyncio.get_running_loop().create_future()
        self.pending[message_id] = future
        await self.ws.send_json({"message_id": message_id, "command": command, "args": args})
        try:
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(message_id, None)


def matter_url() -> str:
    """The URL HA's Matter integration uses, so an add-on move can't break this."""
    try:
        entries = json.loads((CONFIG / ".storage/core.config_entries").read_text())
        for entry in entries["data"]["entries"]:
            if entry["domain"] == "matter" and entry["data"].get("url"):
                return entry["data"]["url"]
    except (OSError, ValueError, KeyError):
        pass
    return DEFAULT_URL


def device_names() -> dict[int, str]:
    """Matter node id -> the device's name in HA."""
    try:
        registry = json.loads((CONFIG / ".storage/core.device_registry").read_text())
    except (OSError, ValueError):
        return {}
    names = {}
    for device in registry["data"]["devices"]:
        for domain, ident in device.get("identifiers", []):
            match = NODE_ID.match(ident) if domain == "matter" else None
            if match:
                names[int(match.group(1), 16)] = device.get("name_by_user") or device.get("name")
    return names


def ext_address(attributes: dict) -> str | None:
    """The node's Thread extended address, as 16 hex digits."""
    for interface in attributes.get("0/51/0") or []:
        raw = base64.b64decode(interface.get("4") or "")
        if len(raw) == 8:  # Thread's EUI-64; Wi-Fi and Ethernet are 6 bytes
            return raw.hex()
    return None


def battery(attributes: dict) -> tuple[float | None, int | None]:
    """(percent, millivolts) from whichever endpoint has the Power Source cluster."""
    percent = millivolts = None
    for path, value in attributes.items():
        if value is None:
            continue
        if path.endswith("/47/12"):
            percent = value / 2  # the spec counts in half-percent steps
        elif path.endswith("/47/11"):
            millivolts = value
    return percent, millivolts


def neighbour(entry: dict, name_of_ext) -> dict:
    return {
        "name": name_of_ext(f"{entry['0']:016x}"), "child": entry.get("13"),
        "rssi": entry.get("6"), "last_rssi": entry.get("7"), "lqi": entry.get("5"),
        "age_s": entry.get("1"), "frame_errors": entry.get("8"),
        "message_errors": entry.get("9"),
    }


def route(entry: dict, name_of_ext) -> dict:
    return {
        "name": name_of_ext(f"{entry['0']:016x}"), "path_cost": entry.get("4"),
        "lqi_in": entry.get("5"), "lqi_out": entry.get("6"), "link": entry.get("9"),
    }


async def snapshot(url: str, reason: str, trigger: str | None) -> dict:
    started = time.monotonic()
    record: dict = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reason": reason, "trigger": trigger, "errors": [],
    }
    names = device_names()
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(url, max_msg_size=0) as ws:
            info = await ws.receive_json(timeout=CALL_TIMEOUT)
            record["server"] = info.get("sdk_version")
            server = MatterServer(ws)
            cached = await server.call("get_nodes", timeout=30)

            ext_names = dict(KNOWN_EXT)
            nodes = []
            for node in sorted(cached, key=lambda n: n["node_id"]):
                attributes = node.get("attributes") or {}
                percent, millivolts = battery(attributes)
                entry = {
                    "node": node["node_id"],
                    "name": names.get(node["node_id"]) or f"node {node['node_id']}",
                    "ext": ext_address(attributes),
                    "available": node.get("available"),
                    "role": ROLES.get(attributes.get("0/53/1")),
                    "battery": percent, "battery_mv": millivolts,
                }
                if entry["ext"]:
                    ext_names[entry["ext"]] = entry["name"]
                nodes.append(entry)
            record["nodes"] = nodes

            def name_of_ext(ext: str) -> str:
                """A device's name, or its address if HA doesn't know it."""
                return ext_names.get(ext, ext)

            # Unreachable nodes, pinged together while the routers are read
            # one at a time below (gently: they're on the same 250 kbit/s mesh).
            async def ping(entry: dict) -> None:
                try:
                    result = await server.call("ping_node", timeout=PING_TIMEOUT,
                                               node_id=entry["node"])
                    entry["ping"] = any((result or {}).values())
                except Exception as exc:  # noqa: BLE001 -- recorded, not fatal
                    entry["ping"] = None
                    record["errors"].append(f"ping {entry['name']}: {exc!r}")
            pings = [asyncio.create_task(ping(n)) for n in nodes if not n["available"]]

            routers = []
            for entry in nodes:
                if not entry["available"] or entry["role"] in (None, "sleepy"):
                    continue
                if time.monotonic() - started > BUDGET - CALL_TIMEOUT:
                    record["errors"].append(f"out of time before reading {entry['name']}")
                    break
                try:
                    live = await server.call("read_attribute", node_id=entry["node"],
                                             attribute_path=ROUTER_PATHS)
                except Exception as exc:  # noqa: BLE001 -- recorded, not fatal
                    record["errors"].append(f"read {entry['name']}: {exc!r}")
                    continue
                live = live or {}
                routers.append({
                    "node": entry["node"], "name": entry["name"],
                    "role": ROLES.get(live.get("0/53/1")),
                    "partition": live.get("0/53/9"), "leader": live.get("0/53/13"),
                    "reboots": live.get("0/51/1"), "uptime_s": live.get("0/51/2"),
                    "boot_reason": BOOT_REASONS.get(live.get("0/51/4")),
                    "counters": {name: live[f"0/53/{attr}"] for attr, name in COUNTERS.items()
                                 if live.get(f"0/53/{attr}") is not None},
                    "neighbours": [neighbour(n, name_of_ext) for n in live.get("0/53/7") or []],
                    # Unallocated router ids are padding, and the router's
                    # own entry says nothing.
                    "routes": [route(r, name_of_ext) for r in live.get("0/53/8") or []
                               if r.get("8") and f"{r['0']:016x}" != entry["ext"]],
                })
            record["routers"] = routers

            if pings:
                await asyncio.wait(pings, timeout=max(1, BUDGET - (time.monotonic() - started)))
            server.reader.cancel()

    children = {}
    for router in routers:
        for n in router["neighbours"]:
            if n["child"]:
                children[n["name"]] = {"parent": router["name"], "rssi": n["rssi"],
                                       "lqi": n["lqi"], "age_s": n["age_s"]}
    record["children"] = children
    record["orphans"] = [n["name"] for n in nodes
                         if n["role"] == "sleepy" and n["name"] not in children]
    return record


def write(record: dict) -> Path:
    """Append to this month's file; gzip finished months, drop old ones."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    path = LOG_DIR / f"{record['ts'][:7]}.jsonl"
    with path.open("a") as log:
        log.write(json.dumps(record, separators=(",", ":")) + "\n")

    year, month = int(record["ts"][:4]), int(record["ts"][5:7])
    index = year * 12 + month - 1
    keep = {f"{i // 12:04d}-{i % 12 + 1:02d}" for i in range(index - KEEP_MONTHS + 1, index + 1)}
    for old in LOG_DIR.glob("????-??.jsonl*"):
        stem = old.name[:7]
        if stem not in keep:
            old.unlink()
        elif old.suffix == ".jsonl" and old != path:
            # zcat / gzip -dc reads it; about a tenth of the size.
            with old.open("rb") as src, gzip.open(f"{old}.gz", "wb") as dst:
                shutil.copyfileobj(src, dst)
            old.unlink()
    return path


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--reason", default="manual")
    parser.add_argument("--trigger")
    parser.add_argument("--url", help="Matter server WebSocket (default: what HA uses)")
    args = parser.parse_args(argv[1:])

    try:
        record = asyncio.run(asyncio.wait_for(
            snapshot(args.url or matter_url(), args.reason, args.trigger), BUDGET + 10))
    except Exception as exc:  # noqa: BLE001 -- a failed run still leaves a line
        record = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                  "reason": args.reason, "trigger": args.trigger,
                  "errors": [f"snapshot failed: {exc!r}"]}
    path = write(record)
    print(json.dumps({
        "file": str(path),
        "routers": len(record.get("routers", [])),
        "unavailable": [n["name"] for n in record.get("nodes", []) if not n["available"]],
        "orphans": record.get("orphans", []),
        "errors": record["errors"],
    }))
    return 1 if record["errors"] and "routers" not in record else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
