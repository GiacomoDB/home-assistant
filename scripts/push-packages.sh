#!/usr/bin/env bash
#
# Copy packages/ to Home Assistant over SSH, then reload.
#
# Dashboards go over the WebSocket API; packages cannot, because there is no
# API for writing arbitrary config files. This is the equivalent one-liner.
#
#   HA_SSH_HOST=homeassistant.local scripts/push-packages.sh
#   HA_SSH_HOST=192.168.1.10 scripts/push-packages.sh --restart
#
# Env:
#   HA_SSH_HOST    required. LAN hostname or IP -- NOT the Cloudflare tunnel;
#                  the tunnel carries HTTPS only, and exposing SSH through it
#                  would be a far larger hole than the WebSocket token.
#   HA_SSH_PORT    default 22
#   HA_SSH_USER    default root (what the Terminal & SSH add-on gives you)
#   HA_CONFIG_DIR  default /config
#
# Deliberately NOT part of the GitHub Actions workflow: that would mean SSH
# access to the instance from the public internet.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_HOST="${HA_SSH_HOST:-}"
SSH_PORT="${HA_SSH_PORT:-22}"
SSH_USER="${HA_SSH_USER:-root}"
REMOTE_DIR="${HA_CONFIG_DIR:-/config}/packages"
RESTART=0

for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$SSH_HOST" ]; then
  echo "error: HA_SSH_HOST is not set (see the header of this script)" >&2
  exit 1
fi

if [ ! -d "$REPO_ROOT/packages" ]; then
  echo "error: no packages/ directory at $REPO_ROOT" >&2
  exit 1
fi

# Never ship a package that fails validation -- a broken one takes the whole
# HA config down at restart, which is a much worse outcome than not deploying.
echo "==> validating"
python3 "$REPO_ROOT/scripts/ha.py" validate

echo "==> copying packages/ to $SSH_USER@$SSH_HOST:$REMOTE_DIR"
# tar over ssh rather than rsync or scp: the add-on's container is Alpine and
# is not guaranteed to have either, but busybox tar is always present.
# Nothing is deleted remotely -- packages/ may hold files added by hand there.
#
# COPYFILE_DISABLE stops macOS bsdtar emitting AppleDouble "._name" companions
# for extended attributes. Those matter here rather than being mere clutter:
# !include_dir_named turns every FILE in the directory into a package, so a
# stray ._cat_water_anomaly.yaml is loaded as a package in its own right.
# --exclude is belt and braces for anything already lying around.
COPYFILE_DISABLE=1 tar czf - --exclude='._*' --exclude='.DS_Store' -C "$REPO_ROOT/packages" . \
  | ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" \
      "mkdir -p '$REMOTE_DIR' && tar xzf - -C '$REMOTE_DIR' && ls -1 '$REMOTE_DIR'"

if [ "$RESTART" -eq 1 ]; then
  echo "==> restarting Home Assistant"
  python3 "$REPO_ROOT/scripts/ha.py" reload --restart
else
  echo "==> reloading YAML"
  python3 "$REPO_ROOT/scripts/ha.py" reload
  echo
  echo "note: reload does not pick up a NEWLY ADDED platform sensor."
  echo "      Adding a package with a 'sensor:' block needs --restart once."
fi
