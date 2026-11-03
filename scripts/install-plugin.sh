#!/bin/sh
# Links the aeriportal-push Hermes plugin into a Hermes installation.
#
#   scripts/install-plugin.sh            link it, and print how to enable it
#   scripts/install-plugin.sh --enable   link it and enable it in every profile
#
# Hermes loads a plugin for a profile from that profile's own plugins folder, and only
# when the profile's config.yaml lists it under plugins.enabled. So the plugin is linked
# into the default profile (~/.hermes/plugins, which is also where the server finds its
# HTTP routes) and into every named profile (~/.hermes/profiles/<name>/plugins).
#
# Run this on the machine that runs `hermes serve`, as the user who runs it. Restart
# `hermes serve` afterwards. Other Hermes processes (the messaging gateway) pick the
# plugin up whenever they next start; until the app registers a device it does nothing.
set -eu

root="${HERMES_ROOT:-$HOME/.hermes}"
plugin="$(cd "$(dirname "$0")/../hermes-plugin/aeriportal-push" && pwd)"
enable=no
[ "${1:-}" = "--enable" ] && enable=yes

[ -d "$root" ] || { echo "No Hermes installation at $root" >&2; exit 1; }

link() {
  mkdir -p "$1"
  ln -sfn "$plugin" "$1/aeriportal-push"
  echo "linked $1/aeriportal-push"
}

link "$root/plugins"
profiles=""
if [ -d "$root/profiles" ]; then
  for profile in "$root"/profiles/*/; do
    [ -d "$profile" ] || continue
    link "${profile}plugins"
    profiles="$profiles $(basename "$profile")"
  done
fi

if [ "$enable" = yes ]; then
  hermes plugins enable aeriportal-push
  for name in $profiles; do hermes -p "$name" plugins enable aeriportal-push; done
else
  echo
  echo "To enable it (this edits each profile's config.yaml):"
  echo "  hermes plugins enable aeriportal-push"
  for name in $profiles; do echo "  hermes -p $name plugins enable aeriportal-push"; done
fi

echo
echo "For notifications to be sent, put the APNs key settings in $root/aeriportal-push/apns.json:"
echo '  {"key_path": "/path/to/AuthKey_XXXXXXXXXX.p8", "key_id": "XXXXXXXXXX", "team_id": "YOUR_TEAM_ID"}'
