#!/bin/zsh
# Does the phone app cost more after a while? One copy of the app in an iPhone simulator
# against a scratch bridge with the fake agent: measured at rest and with four threads
# streaming, then kept busy for <minutes> (three threads streaming one reply after
# another while the UI test of scripts/phone-bench.sh scrolls and switches, over and
# over), measured again in the same process, then quit and launched again on the same
# data and measured a third time (night of 2026-10-19, docs/perf-phone.md).
#
#   scripts/phone-bench/soak.sh <sim udid> <port> <built .app> <out folder> <minutes> <xctestrun>
#
# Each measurement: 12 s at rest (CPU, main thread, idle wake-ups: threads.py), memory
# (footprint, the IOSurfaces), the objects alive that keep work going (display links,
# Metal layers, web views, timers: `heap`), and the CPU seconds of one reply in each of
# the four long threads at once (whichever of them is on screen streams). Lines in
# <out>/soak.txt.
set -uo pipefail
zmodload zsh/datetime
SIM=$1 PORT=$2 BUILT=$3 OUT=$4 MINUTES=$5 XCTESTRUN=$6
ROOT=${0:A:h:h:h}
HELP=$ROOT/scripts/phone-bench
BRIDGE=$ROOT/bridge
BUNDLE=com.danielou.portals.n5-soak
USER_NAME=bench PASSWORD=soak-$RANDOM
url=http://127.0.0.1:$PORT
UIDIR=/private/tmp/portals-n5/bench/perf/uitest-$SIM
mkdir -p $OUT $UIDIR
HOME_DIR=$OUT/bridge-home
scroll() { node $BRIDGE/scripts/bench/scroll.ts "$@" }
log() { print -r -- "$(date +%T) $*" | tee -a $OUT/soak.txt }
bridge_pid="" pid="" poller=""
cleanup() {
  rm -f $OUT/looping
  [[ -n $poller ]] && kill $poller 2>/dev/null
  xcrun simctl terminate $SIM $BUNDLE 2>/dev/null
  xcrun simctl uninstall $SIM $BUNDLE 2>/dev/null
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null
}
trap cleanup EXIT INT TERM

rm -rf $HOME_DIR $OUT/app.app
scroll config $HOME_DIR $PORT $USER_NAME $PASSWORD || exit 1
PORTALS_BRIDGE_HOME=$HOME_DIR node $BRIDGE/src/main.ts > $OUT/bridge.log 2>&1 &
bridge_pid=$!
for _ in {1..100}; do grep -q "listening on" $OUT/bridge.log 2>/dev/null && break; sleep 0.1; done
long=$(scroll seed $url $USER_NAME $PASSWORD 45)

cp -R $BUILT $OUT/app.app
rm -rf $OUT/app.app/PlugIns
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE" $OUT/app.app/Info.plist
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" $OUT/app.app/Info.plist 2>/dev/null
codesign --force --deep -s - $OUT/app.app 2>/dev/null
xcrun simctl uninstall $SIM $BUNDLE 2>/dev/null
xcrun simctl install $SIM $OUT/app.app || exit 1
launch() {  # <tag>
  local answer
  answer=$(SIMCTL_CHILD_PORTALS_DEBUG_HOSTS="[{\"name\":\"Scratch\",\"url\":\"$url\",\"user\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}]" \
    SIMCTL_CHILD_PORTALS_DEBUG_OPEN_EACH=1:0.5 SIMCTL_CHILD_PORTALS_DEBUG_FRAMES=$OUT/frames-$1.txt \
    xcrun simctl launch --terminate-running-process $SIM $BUNDLE 2>&1)
  pid=${answer##*: }
  [[ $pid == <-> ]] || { log "could not launch: $answer"; exit 1 }
  : > $OUT/poll-$1.txt
  python3 -I $HELP/threads.py poll $pid $OUT/poll-$1.txt $OUT/frames-$1.txt &
  poller=$!
  sleep 10
}
launch first
threads=()
for i in 1 2 3; do threads+=($(scroll seed $url $USER_NAME $PASSWORD 10)); done
threads+=($long)
for i in {1..24}; do scroll seed $url $USER_NAME $PASSWORD 1 > /dev/null; done
sleep 8

measure() {  # <label> <poll tag>
  local rest=$(python3 -I $HELP/threads.py $pid 12)
  local fp=$(footprint -p $pid 2>/dev/null | awk '/phys_footprint:/ { print $2 $3; exit }')
  local surf=$(vmmap --summary $pid 2>/dev/null | awk '/^IOSurface / { print $2; exit }')
  heap $pid > $OUT/heap-$1.txt 2>/dev/null
  local objects=$(grep -E 'CADisplayLink|CAMetalLayer|WKWebView|Timer|DisplayLink|AsyncStream|Task' $OUT/heap-$1.txt | awk '$1 ~ /^[0-9]+$/ { printf "%s:%s,", $4, $1 }')
  xcrun simctl io $SIM screenshot $OUT/$1.png > /dev/null 2>&1
  log "$1 rest $rest footprint=$fp iosurface=$surf objects=$objects"
  local t0=$EPOCHREALTIME p=() t
  for t in $threads; do scroll stream $url $USER_NAME $PASSWORD $t >> $OUT/stream.log 2>&1 & p+=($!); done
  for t in $p; do wait $t; done
  log "$1 four-streaming $(python3 -I $HELP/stretch.py $OUT/poll-$2.txt $OUT/frames-$2.txt $t0 $EPOCHREALTIME)"
}
uitest() {
  print -r -- $BUNDLE > $UIDIR/target.txt
  rm -f $UIDIR/marks.txt
  xcodebuild test-without-building -xctestrun $XCTESTRUN -destination "id=$SIM" > $OUT/uitest.log 2>&1 &
  local runner=$!
  for _ in {1..240}; do
    grep -qE "Test Suite 'All tests' (passed|failed)|\*\* TEST" $OUT/uitest.log 2>/dev/null && break
    kill -0 $runner 2>/dev/null || break
    sleep 1
  done
  sleep 2; kill $runner 2>/dev/null; wait $runner 2>/dev/null
}

measure start first
until=$(( EPOCHSECONDS + MINUTES * 60 )) rounds=0
: > $OUT/looping
loops=()
for t in $threads[4] $threads[1] $threads[2]; do
  ( while [[ -f $OUT/looping ]]; do scroll stream $url $USER_NAME $PASSWORD $t >> $OUT/stream.log 2>&1; done ) &
  loops+=($!)
done
while (( EPOCHSECONDS < until )); do uitest; rounds=$(( rounds + 1 )); done
rm -f $OUT/looping
# Only the loops: a bare `wait` also waits for the bridge and the poller, for ever.
for t in $loops; do wait $t; done
log "soaked $MINUTES min: $rounds UI test rounds, $(grep -c 'streamed in' $OUT/stream.log) replies so far"
sleep 10
measure soaked first
kill $poller 2>/dev/null; poller=""
xcrun simctl terminate $SIM $BUNDLE
sleep 3
launch again
sleep 5
measure relaunched again
