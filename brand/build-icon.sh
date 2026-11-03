#!/bin/sh
# Renders brand/appicon.svg into the app's icon. Run from anywhere after editing the SVG.
# Uses only sips. The PNG it renders has an alpha channel, which an iOS app icon must
# not have, so it goes through a full-quality JPEG to drop it.
set -eu
cd "$(dirname "$0")/.."
out=Portals/Assets.xcassets/AppIcon.appiconset/AppIcon.png
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sips -s format png brand/appicon.svg --out "$tmp/icon.png" >/dev/null
sips -s format jpeg -s formatOptions 100 "$tmp/icon.png" --out "$tmp/icon.jpg" >/dev/null
sips -s format png "$tmp/icon.jpg" --out "$out" >/dev/null
sips -g pixelWidth -g pixelHeight -g hasAlpha "$out"
