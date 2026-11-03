#!/bin/sh
# Runs a local headless Hermes backend for Portals development.
#
# It listens on 127.0.0.1 only and needs no login: loopback callers read the
# per-process session token from the server's root page. Stop it with Ctrl-C, or
# from another shell with `hermes serve --stop`.
#
#   scripts/dev-serve.sh            # port 9119
#   PORTALS_HERMES_PORT=9120 scripts/dev-serve.sh
set -eu

HERMES_BIN="${HERMES_BIN:-hermes}"
PORT="${PORTALS_HERMES_PORT:-${AERIPORTAL_HERMES_PORT:-9119}}"

exec "$HERMES_BIN" serve --host 127.0.0.1 --port "$PORT" --skip-build "$@"
