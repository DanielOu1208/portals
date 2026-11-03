#!/bin/sh
# Installs (or updates) the bridge from this checkout: builds dist/, then
# `portals-host update` copies it into the data folder's app/, installs its runtime
# packages there and restarts the LaunchAgent, as `npx portals-host update` does from
# npm. Editing the repo changes nothing until the next install. The first install (or a
# move from the old aeriportal-bridge names) is setup: `node dist/cli.js setup`.
# PORTALS_BRIDGE_HOME picks another bridge (a second one for development, say).
# See bridge/DEVELOPING.md.
set -eu

cd "$(dirname "$0")/.."
npm run build --silent
node dist/cli.js update
