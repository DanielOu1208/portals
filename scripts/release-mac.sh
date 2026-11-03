#!/bin/bash
# Builds the Mac app as a download: signed with Developer ID, with Sparkle in it, notarized,
# in a DMG, with the appcast that announces it. Uploads nothing: the DMG and appcast.xml go on
# a GitHub release by hand (`gh release create`), and the appcast's address is that of the
# latest release, so the newest release is what every copy finds.
#
#   scripts/release-mac.sh <release notes .md>
#
# Needs: DEVELOPMENT_TEAM in Config/Local.xcconfig and its Developer ID Application certificate;
# the two Developer ID profiles below (Mac Catalyst, for the app's two bundle IDs), in Xcode's
# profiles folder; a notarytool keychain profile (PORTALS_NOTARY_PROFILE); Sparkle's private
# key in the Keychain (made once with Sparkle's `generate_keys --account $sparkle_account`,
# and never lost: without it the copies out there can take no more updates).
#
# ASC_KEY_ID and ASC_ISSUER_ID, as for scripts/testflight.sh, let the archive sign in with an
# App Store Connect API key.
#
# PORTALS_RELEASE_TEST_FEED=<http://127.0.0.1:…/appcast.xml> makes a build for trying an update
# on this Mac: it reads that feed, may use plain HTTP, and is not notarized. Not for anyone
# else. PORTALS_RELEASE_BUILD gives such a build its number.
set -euo pipefail
cd "$(dirname "$0")/.."

sparkle_version=2.10.1
sparkle_sha256=1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27
sparkle_account=com.danielou.portals.sparkle
sparkle_public_key=oLrpbMmw36lu4+QwwyS7fUW8GFVWJGca0j2aTjKdYJw=
feed=https://github.com/DanielOu1208/portals/releases/latest/download/appcast.xml
app_profile="Portals Developer ID App"
extension_profile="Portals Developer ID Notifications"
notary_profile=${PORTALS_NOTARY_PROFILE:-AeriVoiceNotary}
test_feed=${PORTALS_RELEASE_TEST_FEED:-}

notes=${1:-}
if [ -z "$notes" ] || [ ! -s "$notes" ]; then
  echo "Usage: scripts/release-mac.sh <release notes .md>" >&2
  exit 2
fi
notes=$(cd "$(dirname "$notes")" && pwd)/$(basename "$notes")
if [ -z "$test_feed" ] && [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "Add and commit your changes first, so the release is a commit." >&2
  exit 1
fi
team=$(sed -n 's/^DEVELOPMENT_TEAM *= *//p' Config/Local.xcconfig 2>/dev/null)
if [ -z "$team" ] || [ "$team" = YOUR_TEAM_ID ]; then
  echo "Set DEVELOPMENT_TEAM in Config/Local.xcconfig first." >&2
  exit 1
fi
identity=$(security find-identity -v -p codesigning | sed -n "s/.*\"\(Developer ID Application: .*($team)\)\".*/\1/p" | head -1)
if [ -z "$identity" ]; then
  echo "No Developer ID Application certificate of team $team in the Keychain." >&2
  exit 1
fi

auth=()
if [ -n "${ASC_KEY_ID:-}" ]; then
  auth=(-authenticationKeyPath "${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}"
    -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

version=$(sed -n 's/^MARKETING_VERSION *= *//p' Config/Shared.xcconfig)
build=${PORTALS_RELEASE_BUILD:-$(date -u +%Y%m%d%H%M)}
out="${TMPDIR:-/tmp}"; out="${out%/}/portals-release/$version-$build"
rm -rf "$out"
mkdir -p "$out"
minimum=$(sed -n 's/.*IPHONEOS_DEPLOYMENT_TARGET = \(.*\);/\1/p' Portals.xcodeproj/project.pbxproj | sort -u | tail -1)

# Sparkle, from its own release, at the version and bytes named above.
tools="$HOME/Library/Caches/portals-release/sparkle-$sparkle_version"
if [ ! -d "$tools/Sparkle.framework" ]; then
  mkdir -p "$tools"
  curl -fsSL -o "$tools/sparkle.tar.xz" \
    "https://github.com/sparkle-project/Sparkle/releases/download/$sparkle_version/Sparkle-$sparkle_version.tar.xz"
  echo "$sparkle_sha256  $tools/sparkle.tar.xz" | shasum -a 256 -c - >/dev/null
  tar -xf "$tools/sparkle.tar.xz" -C "$tools"
fi

# The app, signed as TestFlight's is until the export signs it for a download.
echo "Building Portals $version ($build) in $out"
xcodebuild archive -project Portals.xcodeproj -scheme Portals -configuration Release \
  -destination 'generic/platform=macOS,variant=Mac Catalyst' -archivePath "$out/Portals.xcarchive" \
  -derivedDataPath "$out/DerivedData" -allowProvisioningUpdates ${auth[@]+"${auth[@]}"} -quiet \
  CURRENT_PROJECT_VERSION="$build" PORTALS_APS_ENVIRONMENT=production

cat > "$out/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>developer-id</string>
	<key>teamID</key>
	<string>$team</string>
	<key>signingStyle</key>
	<string>manual</string>
	<key>signingCertificate</key>
	<string>Developer ID Application</string>
	<key>provisioningProfiles</key>
	<dict>
		<key>com.danielou.portals</key>
		<string>$app_profile</string>
		<key>com.danielou.portals.notifications</key>
		<string>$extension_profile</string>
	</dict>
</dict>
</plist>
EOF
xcodebuild -exportArchive -archivePath "$out/Portals.xcarchive" -exportOptionsPlist "$out/ExportOptions.plist" \
  -exportPath "$out/export" -quiet
app="$out/export/Portals.app"
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")

# The bundle that holds Sparkle (see PortalsUpdater.swift), for both of a Mac's chips.
bundle="$app/Contents/PlugIns/PortalsUpdater.bundle"
mkdir -p "$bundle/Contents/MacOS" "$app/Contents/Frameworks"
ditto "$tools/Sparkle.framework" "$app/Contents/Frameworks/Sparkle.framework"
for arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -emit-library -O -module-name PortalsUpdater \
    -target "$arch-apple-macos$minimum" -F "$tools" -framework Sparkle \
    -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
    -Xlinker -install_name -Xlinker @rpath/PortalsUpdater.bundle/Contents/MacOS/PortalsUpdater \
    scripts/mac-release/PortalsUpdater.swift -o "$out/PortalsUpdater-$arch"
done
lipo -create "$out/PortalsUpdater-arm64" "$out/PortalsUpdater-x86_64" -output "$bundle/Contents/MacOS/PortalsUpdater"
cat > "$bundle/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>PortalsUpdater</string>
	<key>CFBundleIdentifier</key>
	<string>$bundle_id.updater</string>
	<key>CFBundlePackageType</key>
	<string>BNDL</string>
	<key>CFBundleShortVersionString</key>
	<string>$version</string>
	<key>CFBundleVersion</key>
	<string>$build</string>
	<key>NSPrincipalClass</key>
	<string>PortalsUpdaterPlugin</string>
</dict>
</plist>
EOF

# What Sparkle reads. The app is sandboxed, so its installer runs from an XPC service, and the
# app has network access of its own, so Sparkle's downloader service stays off.
plist="$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :SUFeedURL string ${test_feed:-$feed}" \
  -c "Add :SUPublicEDKey string $sparkle_public_key" \
  -c "Add :SUEnableInstallerLauncherService bool true" \
  -c "Add :SUEnableAutomaticChecks bool true" "$plist"
if [ -n "$test_feed" ]; then
  plutil -replace NSAppTransportSecurity -xml '<dict><key>NSAllowsArbitraryLoads</key><true/></dict>' "$plist"
fi

# The new parts are signed from the inside out, and the app again around them, with the two
# lookups Sparkle's installer needs added to the entitlements the export gave it. Never --deep.
sign() { codesign --force --timestamp --options runtime --sign "$identity" "$@"; }
sparkle="$app/Contents/Frameworks/Sparkle.framework"
sign "$sparkle/Versions/B/XPCServices/Installer.xpc"
sign --preserve-metadata=entitlements "$sparkle/Versions/B/XPCServices/Downloader.xpc"
sign "$sparkle/Versions/B/Autoupdate"
sign "$sparkle/Versions/B/Updater.app"
sign "$sparkle"
sign "$bundle"
codesign -d --entitlements - --xml "$app" > "$out/entitlements.plist" 2>/dev/null
python3 -I - "$out/entitlements.plist" "$bundle_id" <<'PY'
import plistlib, sys
path, bundle = sys.argv[1:]
with open(path, "rb") as file:
    entitlements = plistlib.load(file)
entitlements["com.apple.security.temporary-exception.mach-lookup.global-name"] = [f"{bundle}-spks", f"{bundle}-spki"]
with open(path, "wb") as file:
    plistlib.dump(entitlements, file)
PY
sign --entitlements "$out/entitlements.plist" "$app"
codesign --verify --deep --strict "$app"

if [ -n "$test_feed" ]; then
  echo "Test build, for this Mac only: $app"
  exit 0
fi

ditto -c -k --keepParent "$app" "$out/Portals.zip"
xcrun notarytool submit "$out/Portals.zip" --keychain-profile "$notary_profile" --wait
xcrun stapler staple "$app"
spctl --assess --type execute "$app"

# dmgbuild in a folder of its own, at the versions and bytes named in dmg-requirements.txt.
packaging="$HOME/Library/Caches/portals-release/dmg-venv"
if [ ! -x "$packaging/bin/dmgbuild" ]; then
  python3 -m venv "$packaging"
  "$packaging/bin/pip" install --quiet --require-hashes --only-binary=:all: -r scripts/mac-release/dmg-requirements.txt
fi
release="$out/release"
mkdir -p "$release"
dmg="$release/Portals-$version.dmg"
"$packaging/bin/dmgbuild" -s scripts/mac-release/dmg-settings.py -D app="$app" Portals "$dmg"
codesign --force --timestamp --sign "$identity" "$dmg"
xcrun notarytool submit "$dmg" --keychain-profile "$notary_profile" --wait
xcrun stapler staple "$dmg"
spctl --assess --type open --context context:primary-signature "$dmg"

# The appcast, kept whole: the feed as it is now, with this release added.
cp "$notes" "$release/Portals-$version.md"
curl -fsSL -o "$release/appcast.xml" "$feed" 2>/dev/null || rm -f "$release/appcast.xml"
"$tools/bin/generate_appcast" --account "$sparkle_account" --embed-release-notes \
  --download-url-prefix "https://github.com/DanielOu1208/portals/releases/download/v$version/" \
  --link https://portals.build -o "$release/appcast.xml" "$release"
rm -f "$release/Portals-$version.md"
(cd "$release" && shasum -a 256 "Portals-$version.dmg" > "Portals-$version.dmg.sha256")

echo "Portals $version ($build) is ready, nothing uploaded: $release"
