#!/bin/sh
# Runs the bridge's tests on Linux, in a Docker container (Colima on a Mac): `npm ci`,
# then `node --test`. The repository is mounted read-only and copied into the container
# without .git, node_modules and dist (some tests read the app's fixtures and the relay's
# source), so the Mac's packages and build stay out of it and the container's stay in it.
# The tests run as the image's `node` user, not root, as a person would. No port is
# published. PORTALS_LINUX_IMAGE picks another image (node:24 by default); arguments go to
# `node --test`, which expands a glob itself (test/*.test.ts by default). See
# docs/linux-plan.md.
set -eu

cd "$(dirname "$0")/../.."
image="${PORTALS_LINUX_IMAGE:-node:24}"
[ "$#" -gt 0 ] || set -- 'test/*.test.ts'

exec docker run --rm --init --user node --workdir /home/node \
  --volume "$PWD:/src:ro" \
  "$image" sh -c '
    set -eu
    mkdir portals
    tar -C /src --exclude=./.git --exclude="*/node_modules" --exclude=./bridge/dist -cf - . | tar -C portals -xf -
    cd portals/bridge
    npm ci --no-audit --no-fund --loglevel=error
    node --version
    exec node --test "$@"
  ' linux-test "$@"
