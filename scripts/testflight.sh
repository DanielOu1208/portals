#!/bin/sh
# Builds Portals for TestFlight from the current commit and uploads it to App Store Connect:
# the iPhone and iPad app (an .ipa) and the Mac app (Mac Catalyst, a .pkg), both to the
# app's one record there. `--ios` or `--mac` builds only that one; `--export-only` builds
# and signs them without uploading them.
#
# Needs the app's record in App Store Connect (com.danielou.portals), the signing team in
# Config/Local.xcconfig, and either Xcode signed in to that team's account or an App Store
# Connect API key: ASC_KEY_ID and ASC_ISSUER_ID, with the key in
# ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8 or at ASC_KEY_PATH. It has to be
# a team key with Admin access, which Apple's cloud signing for distribution asks for. The
# key signs and uploads both builds; it is never printed.
#
# The build number is the time of the build in UTC (yyyymmddHHMM), so every upload is a
# new build, the same for both platforms; the version is MARKETING_VERSION in
# Config/Shared.xcconfig. Notifications go through Apple's production servers, as for
# every TestFlight and App Store build.
set -eu
cd "$(dirname "$0")/.."

destination=upload
ios= mac=
for arg; do
  case "$arg" in
    --export-only) destination=export ;;
    --ios) ios=ios ;;
    --mac) mac=mac ;;
    *) echo "Usage: scripts/testflight.sh [--ios] [--mac] [--export-only]" >&2; exit 2 ;;
  esac
done
[ -n "$ios$mac" ] || { ios=ios; mac=mac; }
platforms="$ios $mac"

changes=$(git status --porcelain --untracked-files=all)
if [ -n "$changes" ]; then
  echo "Add and commit your changes first, including new files, so the build is a commit." >&2
  exit 1
fi
team=$(sed -n 's/^DEVELOPMENT_TEAM *= *//p' Config/Local.xcconfig 2>/dev/null)
if [ -z "$team" ] || [ "$team" = YOUR_TEAM_ID ]; then
  echo "Set DEVELOPMENT_TEAM in Config/Local.xcconfig first (see Local.example.xcconfig)." >&2
  exit 1
fi

# From here "$@" is what each xcodebuild is given to sign in: the API key, or nothing
# (Xcode's own account).
set --
if [ -n "${ASC_KEY_ID:-}${ASC_ISSUER_ID:-}${ASC_KEY_PATH:-}" ]; then
  key="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID:-}.p8}"
  if [ -z "${ASC_KEY_ID:-}" ] || [ -z "${ASC_ISSUER_ID:-}" ]; then
    echo "An App Store Connect API key needs both ASC_KEY_ID and ASC_ISSUER_ID." >&2
    exit 1
  fi
  if [ ! -r "$key" ]; then
    echo "No App Store Connect API key to read at $key (set ASC_KEY_PATH if it is elsewhere)." >&2
    exit 1
  fi
  set -- -authenticationKeyPath "$key" -authenticationKeyID "$ASC_KEY_ID" \
    -authenticationKeyIssuerID "$ASC_ISSUER_ID"
fi

version=$(sed -n 's/^MARKETING_VERSION *= *//p' Config/Shared.xcconfig)
build=$(date -u +%Y%m%d%H%M)
commit=$(git rev-parse --short HEAD)
tag="testflight-$version-$build"
out="${TMPDIR:-/tmp}"; out="${out%/}/portals-testflight/$build"
mkdir -p "$out"

name() { if [ "$1" = ios ]; then echo iOS; else echo Mac; fi; }
package() { if [ "$1" = ios ]; then echo Portals.ipa; else echo Portals.pkg; fi; }

# Both are archived before either is exported, so a build that fails on one platform
# uploads nothing.
for platform in $platforms; do
  if [ "$platform" = ios ]; then
    platform_destination='generic/platform=iOS'
  else
    platform_destination='generic/platform=macOS,variant=Mac Catalyst'
  fi
  echo "Building Portals $version ($build) for $(name "$platform") from $commit in $out/$platform"
  xcodebuild archive -project Portals.xcodeproj -scheme Portals -configuration Release \
    -destination "$platform_destination" -archivePath "$out/$platform/Portals.xcarchive" \
    -derivedDataPath "$out/DerivedData" -allowProvisioningUpdates "$@" -quiet \
    CURRENT_PROJECT_VERSION="$build" PORTALS_APS_ENVIRONMENT=production
done

cat > "$out/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>$destination</string>
	<key>teamID</key>
	<string>$team</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>uploadSymbols</key>
	<true/>
</dict>
</plist>
EOF

tagged=
for platform in $platforms; do
  xcodebuild -exportArchive -archivePath "$out/$platform/Portals.xcarchive" \
    -exportOptionsPlist "$out/ExportOptions.plist" -exportPath "$out/$platform/export" \
    -allowProvisioningUpdates "$@" -quiet
  if [ "$destination" = upload ]; then
    # Tagged at the first upload: from then on this build number is this commit's.
    [ -n "$tagged" ] || git tag "$tag" "$commit"
    tagged=yes
    echo "Uploaded Portals $version ($build) for $(name "$platform") from $commit, tagged $tag."
  else
    echo "Exported $out/$platform/export/$(package "$platform") (not uploaded)."
  fi
done

if [ "$destination" = upload ]; then
  echo "It shows in App Store Connect under TestFlight once Apple has processed it (a few minutes)."
fi
