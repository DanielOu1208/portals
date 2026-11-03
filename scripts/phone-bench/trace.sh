#!/bin/zsh
# Where the phone app's CPU goes in one state: a Time Profiler recording of a copy of the
# app in an iPhone simulator against a scratch bridge with the fake agent, summarised by
# scripts/app-footprint/timeprofile.py (night of 2026-10-19, docs/perf-phone.md).
#
#   scripts/phone-bench/trace.sh <sim udid> <port> <built .app> <out folder> <state> [<xctestrun>]
#
# States: stream (three threads stream, the one on screen among them: 10 s from 3 s in),
# rest (10 s with nothing going on), ui (the whole UI test of scripts/phone-bench.sh:
# its accessibility queries show as AX frames), busy-ui (the UI test while three threads
# stream). The summary is <out>/<state>.txt; the export <out>/<state>.xml.gz.
set -uo pipefail
zmodload zsh/datetime
SIM=$1 PORT=$2 BUILT=$3 OUT=$4 STATE=$5 XCTESTRUN=${6:-}
ROOT=${0:A:h:h:h}
BRIDGE=$ROOT/bridge
BUNDLE=com.danielou.portals.n5-trace
USER_NAME=bench PASSWORD=trace-$RANDOM
url=http://127.0.0.1:$PORT
mkdir -p $OUT
HOME_DIR=$OUT/bridge-home
scroll() { node $BRIDGE/scripts/bench/scroll.ts "$@" }
bridge_pid="" loops=()
cleanup() {
  rm -f $OUT/looping
  for p in $loops; do kill $p 2>/dev/null; done
  xcrun simctl terminate $SIM $BUNDLE 2>/dev/null
  xcrun simctl uninstall $SIM $BUNDLE 2>/dev/null
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null
}
trap cleanup EXIT INT TERM

rm -rf $HOME_DIR $OUT/app.app
scroll config $HOME_DIR $PORT $USER_NAME $PASSWORD || exit 1
PORTALS_BRIDGE_HOME=$HOME_DIR node $BRIDGE/src/main.ts > $OUT/bridge-$STATE.log 2>&1 &
bridge_pid=$!
for _ in {1..100}; do grep -q "listening on" $OUT/bridge-$STATE.log 2>/dev/null && break; sleep 0.1; done
# The long thread alone at launch, so that it is the one the app opens; the others come
# once it is open (which thread a launch opens first among many is not settled).
long=$(scroll seed $url $USER_NAME $PASSWORD 45)

cp -R $BUILT $OUT/app.app
rm -rf $OUT/app.app/PlugIns
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE" $OUT/app.app/Info.plist
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" $OUT/app.app/Info.plist 2>/dev/null
codesign --force --deep -s - $OUT/app.app 2>/dev/null
xcrun simctl uninstall $SIM $BUNDLE 2>/dev/null
xcrun simctl install $SIM $OUT/app.app || exit 1
answer=$(SIMCTL_CHILD_PORTALS_DEBUG_HOSTS="[{\"name\":\"Scratch\",\"url\":\"$url\",\"user\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}]" \
  SIMCTL_CHILD_PORTALS_DEBUG_OPEN_EACH=1:0.5 xcrun simctl launch --terminate-running-process $SIM $BUNDLE 2>&1)
pid=${answer##*: }
[[ $pid == <-> ]] || { echo "could not launch: $answer"; exit 1 }
sleep 10
threads=()
for i in 1 2 3; do threads+=($(scroll seed $url $USER_NAME $PASSWORD 10)); done
threads+=($long)
for i in {1..24}; do scroll seed $url $USER_NAME $PASSWORD 1 > /dev/null; done
sleep 5
xcrun simctl io $SIM screenshot $OUT/$STATE-start.png > /dev/null 2>&1

stream_loop() {
  : > $OUT/looping
  local t
  for t in "$@"; do
    ( while [[ -f $OUT/looping ]]; do scroll stream $url $USER_NAME $PASSWORD $t >> $OUT/stream.log 2>&1; done ) &
    loops+=($!)
  done
}
record() {  # <seconds>
  xctrace record --template 'Time Profiler' --device $SIM --attach $pid --time-limit ${1}s --output $OUT/$STATE.trace > $OUT/xctrace-$STATE.log 2>&1
}
case $STATE in
  stream) stream_loop $threads[4] $threads[1] $threads[2]; sleep 3; record 10;;
  rest) record 10;;
  ui|busy-ui)
    [[ $STATE == busy-ui ]] && { stream_loop $threads[4] $threads[1] $threads[2]; sleep 3 }
    mkdir -p /private/tmp/portals-n5/bench/perf/uitest-$SIM
    print -r -- $BUNDLE > /private/tmp/portals-n5/bench/perf/uitest-$SIM/target.txt
    record 75 &
    recorder=$!
    sleep 4
    xcodebuild test-without-building -xctestrun $XCTESTRUN -destination "id=$SIM" > $OUT/uitest-$STATE.log 2>&1 &
    runner=$!
    # xcodebuild often hangs once the test has run: done when the log says so.
    for _ in {1..150}; do
      grep -qE "Test Suite 'All tests' (passed|failed)|\*\* TEST" $OUT/uitest-$STATE.log 2>/dev/null && break
      kill -0 $runner 2>/dev/null || break
      sleep 1
    done
    kill $runner 2>/dev/null
    wait $recorder;;
esac
rm -f $OUT/looping
xcrun simctl io $SIM screenshot $OUT/$STATE.png > /dev/null 2>&1
xctrace export --input $OUT/$STATE.trace --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]' > $OUT/$STATE.xml 2>> $OUT/xctrace-$STATE.log
python3 -I $ROOT/scripts/app-footprint/timeprofile.py $OUT/$STATE.xml > $OUT/$STATE.txt 2>&1
rm -rf $OUT/$STATE.trace
gzip -f $OUT/$STATE.xml
head -40 $OUT/$STATE.txt
