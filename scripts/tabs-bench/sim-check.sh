#!/bin/zsh
# Checks that a simulator build launches and shows its sidebar on a new iPhone and a new
# iPad simulator without crashing (a Mac-only change once crashed iOS at launch), with a
# scratch bridge of the scripted agent on PORT (9503). The simulators are made for the
# check and deleted after it.
#
#   scripts/tabs-bench/sim-check.sh <built .app for the simulator> <out dir>
#
# For each: boots it, installs the app, launches it with the sidebar out
# (PORTALS_DEBUG_SIDEBAR) on the scratch bridge, takes a screenshot after 15 s, and says
# whether the app is still running and whether a crash report of it came meanwhile.
# Needs the sim lock (/private/tmp/portals-n10/scripts/lock.sh take sim <you>).
set -uo pipefail
ROOT=${0:A:h:h:h}
APP=${1:A} OUT=$2
PORT=${PORT:-9503}
mkdir -p $OUT
BUNDLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' $APP/Info.plist) || exit 2
RUNTIME=$(xcrun simctl list runtimes | awk '/iOS/ { id = $NF } END { print id }')
PASSWORD=sim-$RANDOM
rm -rf $OUT/bridge
node $ROOT/scripts/sidebar-bench/bridge.mts start $OUT/bridge $PORT 200 $PASSWORD 5 12 100 > $OUT/bridge.log 2>&1 &
bridge=$!
for _ in {1..100}; do grep -q "listening on" $OUT/bridge.log 2>/dev/null && break; sleep 0.1; done
hosts="[{\"name\":\"Scratch\",\"url\":\"http://127.0.0.1:$PORT\",\"user\":\"sidebar\",\"password\":\"$PASSWORD\"}]"
since=$(date +%s)
failed=0
for kind in "iPhone 18 Pro" "iPad Pro 13-inch (M5)"; do
  type=$(xcrun simctl list devicetypes | grep -F "$kind (" | head -1 | sed 's/.*(\(com.apple[^)]*\)).*/\1/')
  sim=$(xcrun simctl create "n10-check $kind" $type $RUNTIME) || { echo "could not make a $kind simulator"; failed=1; continue; }
  xcrun simctl boot $sim
  xcrun simctl bootstatus $sim -b > /dev/null 2>&1
  xcrun simctl install $sim $APP
  SIMCTL_CHILD_PORTALS_DEBUG_HOSTS=$hosts SIMCTL_CHILD_PORTALS_DEBUG_SIDEBAR=1 xcrun simctl launch $sim $BUNDLE > $OUT/launch.log 2>&1
  sleep 15
  name=${kind// /-}
  xcrun simctl io $sim screenshot $OUT/$name.png > /dev/null 2>&1
  # `simctl launch` says "<bundle>: <pid>", a process of this Mac's.
  pid=$(awk '{ print $NF }' $OUT/launch.log)
  if [[ -n $pid ]] && kill -0 $pid 2>/dev/null; then
    echo "$kind: running after 15 s ($OUT/$name.png)"
  else
    echo "$kind: NOT running after 15 s"; failed=1
  fi
  xcrun simctl shutdown $sim
  xcrun simctl delete $sim
done
kill $bridge 2>/dev/null; wait $bridge 2>/dev/null
rm -rf $OUT/bridge
crashes=$(find ~/Library/Logs/DiagnosticReports -name 'Portals*' -newermt "@$since" 2>/dev/null)
if [[ -n $crashes ]]; then
  echo "crash reports since the check began:"; print -r -- $crashes; failed=1
else
  echo "no crash report of Portals since the check began"
fi
exit $failed
