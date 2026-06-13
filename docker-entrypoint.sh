#!/bin/sh
# Container entrypoint (Phase 5 deployment).
#
# Railway (and `docker run -v`) mount the persistent volume at /data
# owned by root, which shadows the image-time `chown maestro:maestro /data`.
# The conductor runs as the non-root `maestro` user, so it can't write
# there until ownership is fixed at runtime.
#
# This script starts as root, makes /data writable by maestro, then drops
# privileges via gosu before exec'ing the conductor. That keeps the
# non-root security boundary from CLAUDE.md without needing the blunt
# RAILWAY_RUN_UID=0 (run-everything-as-root) workaround.
set -e

DATA_DIR="${MAESTRO_DATA_DIR:-/data}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$DATA_DIR/claude}"

mkdir -p "$DATA_DIR" "$CLAUDE_DIR"
# Only chown when needed — a -R sweep over a large /data on every boot is
# wasteful, so gate on the top-level owner.
if [ "$(stat -c '%U' "$DATA_DIR")" != "maestro" ]; then
  chown -R maestro:maestro "$DATA_DIR"
fi

exec gosu maestro "$@"
