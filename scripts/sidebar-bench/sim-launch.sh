#!/bin/zsh
# The iPhone simulator's launch and memory with a long list (docs/perf-sidebar.md), on a
# scratch copy (com.danielou.portals.n4-sidebar) and a scratch bridge, never the
# installed app. Needs the sim lock.
#
#   scripts/sidebar-bench/sim-launch.sh <built Portals.app for the simulator> <out dir> [launches] [threads]
#
# Installs the copy, starts a bridge with <threads> threads (600) on 9353, launches the
# copy once (nothing saved yet), then <launches> (5) more times on the list it saved,
# and prints each launch's probe (PORTALS_DEBUG_SIDEBAR_PROBE): ms since the process
# started for app-init, fleet-made, the first sidebar row and host-listed. Then opens
# the ten newest threads one after another (the newest has a 20,000-character reply)
# and prints the footprint and its peak. Removes the copy and the bridge after.
set -uo pipefail
ROOT=${0:A:h:h:h}
SIM=${SIM:-booted}
ID=com.danielou.portals.n4-sidebar
# The app itself, not a link to it: the copy is changed in place (its extension removed,
# its bundle id set), which through a copied link would change the original.
APP=${1:A} OUT=${2:A} LAUNCHES=${3:-5} THREADS=${4:-600}
[[ -d $APP && $APP == *.app ]] || { echo "$APP is not a built .app"; exit 2; }
# A copy keeps the links in the app, and the parts changed in the copy must not be links
# out of it.
for part in Info.plist PlugIns; do
  [[ -L $APP/$part ]] && { echo "$APP/$part is a link: refused"; exit 2; }
done
mkdir -p $OUT
copy=$OUT/Portals.app
[[ -L $copy ]] && { echo "$copy is a link: refused"; exit 2; }
# The copy is removed before it is made: never the app, nor anything in it or around it.
[[ $copy == $APP || $copy == $APP/* || $APP == $copy/* ]] && { echo "$copy overlaps $APP: refused"; exit 2; }
rm -rf $copy; cp -R $APP $copy
[[ -d $copy && ! -L $copy ]] || { echo "could not make a copy of $APP"; exit 2; }
rm -rf $copy/PlugIns
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $ID" $copy/Info.plist
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" $copy/Info.plist 2>/dev/null
codesign --force --deep -s - $copy 2>/dev/null
xcrun simctl uninstall $SIM $ID 2>/dev/null
xcrun simctl install $SIM $copy || exit 1
home=$OUT/bridge; rm -rf $home $home.log
node $ROOT/scripts/sidebar-bench/bridge.mts start $home 9353 $THREADS simbench > $home.log 2>&1 &
bridge=$!
trap 'kill $bridge 2>/dev/null; xcrun simctl terminate $SIM $ID 2>/dev/null; xcrun simctl uninstall $SIM $ID 2>/dev/null' EXIT
for _ in {1..100}; do grep -q "listening on" $home.log 2>/dev/null && break; sleep 0.1; done
hosts='[{"name":"Scratch","url":"http://127.0.0.1:9353","user":"sidebar","password":"simbench"}]'
launch() {  # <probe file> [more SIMCTL_CHILD_ switches]
  local probe=$1; shift
  rm -f $probe
  xcrun simctl terminate $SIM $ID 2>/dev/null; sleep 2
  env SIMCTL_CHILD_PORTALS_DEBUG_HOSTS=$hosts SIMCTL_CHILD_PORTALS_DEBUG_SIDEBAR_PROBE=$probe "$@" xcrun simctl launch $SIM $ID | sed 's/.*: //'
}
summary() {  # <probe file>
  awk '{ at[$2] = at[$2] ? at[$2] : $1 } END { printf "app-init %s fleet-made %s sidebar-row %s host-listed %s", at["app-init"], at["fleet-made"], at["sidebar-row"], at["host-listed"] }' $1
}
launch $OUT/probe-0.txt SIMCTL_CHILD_PORTALS_DEBUG_SIDEBAR=1 >/dev/null; sleep 8
echo "first (nothing saved): $(summary $OUT/probe-0.txt) load $(uptime | sed 's/.*averages: //')"
for i in $(seq 1 $LAUNCHES); do
  launch $OUT/probe-$i.txt SIMCTL_CHILD_PORTALS_DEBUG_SIDEBAR=1 >/dev/null; sleep 7
  echo "saved $i: $(summary $OUT/probe-$i.txt) load $(uptime | sed 's/.*averages: //')"
done
pid=$(launch $OUT/probe-open.txt SIMCTL_CHILD_PORTALS_DEBUG_OPEN_EACH=10:1.5)
sleep 25
echo "ten threads opened: $(footprint -p $pid 2>/dev/null | awk '/phys_footprint:/ {a=$2$3} /phys_footprint_peak:/ {b=$2$3} END {print a, "peak", b}')"
