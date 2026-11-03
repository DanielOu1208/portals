#!/bin/zsh
# What the phone app costs in the states the user feels as lag and heat, on an iPhone
# simulator against a scratch bridge with only the fake agent (night of 2026-10-19,
# docs/perf-phone.md).
#
#   scripts/phone-bench.sh --sim <udid> [options] <label>=<built .app> [<label>=<built .app> …]
#
# Each app is a build for the simulator (Debug, or Release with
# SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG for the launch switches). For every round and
# every app in turn (A, B, A, B…) it puts back the same bridge home (made once: 24 short
# threads, three of 10 turns, and the one opened, of 45 turns, last), starts the bridge on
# PORT (9374), opens a copy of the app (its own bundle id, no extension, no URL scheme) on
# the 45-turn thread (PORTALS_DEBUG_OPEN_EACH=1:0.5), and measures, nobody touching it
# but the UI test:
#   idle     10 s at rest on the thread
#   off      three other threads stream the fake agent's minute-long reply
#            (bridge/src/providers/fakeBench.ts), the thread on screen at rest
#   on       three threads stream, the one on screen among them
#   chat, switch, sidebar
#            the UI test (scripts/phone-bench/PerfUITests.swift, --uitest): flings in
#            the chat, four trips to the sidebar and into a thread, flings in the sidebar
#   busy-chat, busy-switch, busy-sidebar
#            the same while three threads stream, the one on screen among them
# off-whole and on-whole: from the replies' start to their end (the CPU seconds there
# are the work of three whole replies, the steadiest number on a loaded Mac).
# For idle, off and on, 12 s from 3 s in: the app's CPU (process time, ended workers
# included) and its main thread's CPU time, idle wake-ups and energy impact, and the busiest
# other threads (scripts/phone-bench/threads.py). For every stretch: CPU, main thread, and
# the frame meter (FrameMeter.swift: hitch ms a second, hitches a second, frames a second,
# longest frame), and the wash's frames a second (PORTALS_DEBUG_WASH_FRAMES, from
# a217ee0 on). At the end the app's footprint and its IOSurfaces (vmmap).
#
# Options:
#   --rounds N      rounds of all apps (default 2)
#   --uitest <xctestrun>  run the UI test stretches: build the standalone UI test project
#                   first, `xcodebuild build-for-testing -project
#                   scripts/phone-bench/uitest/WidgetUI.xcodeproj -scheme UITests -destination
#                   'platform=iOS Simulator,id=<udid>' -derivedDataPath <dd>`, and give
#                   <dd>/Build/Products/UITests_*.xctestrun
#   --phases "…"    which of: idle off on ui busy (default all)
#   --env K=V       launch every app with this too (repeatable)
#   --soak <min>    after the phases, keep the app streaming, switching and scrolling for
#                   that many minutes, then measure idle/off/on again in the same process
#                   (labelled soak-…), then quit and measure them in a fresh launch
#                   (fresh-…) over the same bridge
# One line a stretch, medians per app and stretch at the end; everything kept under OUT.
#
# Known limit: with a fresh install among 28 threads, which thread the launch opens first
# is not settled (OPEN_EACH opens the first in the app's list as it arrives), and on
# 2026-10-19 it was one of the 10-turn threads, which streams in both `off` and `on`.
# For a number that depends on which thread is on screen use phone-bench/reply-cost.sh,
# trace.sh or soak.sh, which launch on a bridge holding only the long thread.

set -uo pipefail
zmodload zsh/datetime
ROOT=${0:A:h:h}
HELP=$ROOT/scripts/phone-bench
PORT=${PORT:-9374}
OUT=${OUT:-/private/tmp/portals-n5/bench/perf/run-$(date +%H%M%S)}
BUNDLE=${BUNDLE:-com.danielou.portals.n5-perf}
ROUNDS=2 SIM="" XCTESTRUN="" PHASES="idle off on ui busy" SOAK=0
APPS=() EXTRA=()
while (( $# )); do
  case $1 in
    --rounds) ROUNDS=$2; shift 2;;
    --sim) SIM=$2; shift 2;;
    --uitest) XCTESTRUN=$2; shift 2;;
    --phases) PHASES=$2; shift 2;;
    --env) EXTRA+=($2); shift 2;;
    --soak) SOAK=$2; shift 2;;
    *=*) APPS+=($1); shift;;
    *) echo "unknown argument $1"; exit 2;;
  esac
done
[[ -n $SIM && ${#APPS} -gt 0 ]] || { sed -n '2,/^$/p' $0; exit 2; }
[[ -z $XCTESTRUN ]] && PHASES=${PHASES//ui/} PHASES=${PHASES//busy/}
UIDIR=/private/tmp/portals-n5/bench/perf/uitest-$SIM   # where PerfUITests.swift looks

BRIDGE=$ROOT/bridge
USER_NAME=bench PASSWORD=bench-$RANDOM-$RANDOM
HOME_DIR=$OUT/bridge-home TEMPLATE=$OUT/bridge-template
mkdir -p $OUT $UIDIR
log() { print -r -- "$(date +%T) $*" | tee -a $OUT/bench.log }

bridge_pid="" app_pid="" poller="" loops=() current=""
cleanup() {
  stop_loops
  [[ -n $app_pid ]] && quit_app
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null
  for spec in $APPS; do xcrun simctl uninstall $SIM $BUNDLE.${spec%%=*} 2>/dev/null; done
}
trap cleanup EXIT INT TERM

start_bridge() {
  PORTALS_BRIDGE_HOME=$HOME_DIR PORTALS_BRIDGE_LOG=info node $BRIDGE/src/main.ts > $1 2>&1 &
  bridge_pid=$!
  for _ in {1..100}; do grep -q "listening on" $1 2>/dev/null && return 0; sleep 0.1; done
  echo "the bridge did not start"; return 1
}
stop_bridge() {
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null && wait $bridge_pid 2>/dev/null
  bridge_pid=""
}
url=http://127.0.0.1:$PORT
scroll() { node $BRIDGE/scripts/bench/scroll.ts "$@" }

# The bridge's home, made once and put back for every run.
make_template() {
  rm -rf $HOME_DIR
  scroll config $HOME_DIR $PORT $USER_NAME $PASSWORD || exit 1
  start_bridge $OUT/template-bridge.log || exit 1
  local i
  for i in {1..24}; do scroll seed $url $USER_NAME $PASSWORD 1 >> $OUT/threads-short.txt; done
  for i in 1 2 3; do scroll seed $url $USER_NAME $PASSWORD 10 >> $OUT/threads.txt; done
  scroll seed $url $USER_NAME $PASSWORD 45 >> $OUT/threads.txt
  stop_bridge
  rm -rf $TEMPLATE && cp -R $HOME_DIR $TEMPLATE
}
threads=()
hosts() { print -r -- "[{\"name\":\"Scratch\",\"url\":\"$url\",\"user\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}]" }

launch_app() {  # <label> <dir>
  local answer pair
  # Installed afresh for every launch: nothing the launch before saved (the threads it
  # knew, the one it had open) decides what this one opens first.
  if [[ -z ${KEEP_DATA:-} ]]; then
    xcrun simctl uninstall $SIM $BUNDLE.$1 2>/dev/null
    xcrun simctl install $SIM $OUT/$1.app || return 1
  fi
  for pair in $EXTRA; do export SIMCTL_CHILD_$pair; done
  answer=$(SIMCTL_CHILD_PORTALS_DEBUG_HOSTS="$(hosts)" SIMCTL_CHILD_PORTALS_DEBUG_OPEN_EACH=1:0.5 \
    SIMCTL_CHILD_PORTALS_DEBUG_FRAMES=$2/frames.txt SIMCTL_CHILD_PORTALS_DEBUG_WASH_FRAMES=$2/wash.txt \
    xcrun simctl launch --terminate-running-process $SIM $BUNDLE.$1 2>&1)
  app_pid=${answer##*: }
  [[ $app_pid == <-> ]] || { log "  could not launch: $answer"; app_pid=""; return 1; }
  : > $2/poll.txt
  python3 -I $HELP/threads.py poll $app_pid $2/poll.txt $2/frames.txt &
  poller=$!
  sleep 10
}
quit_app() {
  xcrun simctl terminate $SIM $BUNDLE.$current 2>/dev/null
  [[ -n $poller ]] && { kill $poller 2>/dev/null; wait $poller 2>/dev/null }
  app_pid="" poller=""
}

stream() {  # <thread> … : one minute-long reply in each, in the background
  local t
  for t in "$@"; do scroll stream $url $USER_NAME $PASSWORD $t >> $dir/stream.log 2>&1 & loops+=($!); done
}
stream_loop() {  # <thread> … : replies one after another in each until stop_loops
  local t
  : > $dir/looping
  for t in "$@"; do
    ( while [[ -f $dir/looping ]]; do scroll stream $url $USER_NAME $PASSWORD $t >> $dir/stream.log 2>&1; done ) &
    loops+=($!)
  done
}
wait_streams() { local p; for p in $loops; do wait $p 2>/dev/null; done; loops=() }
stop_loops() {
  [[ -n ${dir:-} ]] && rm -f $dir/looping
  wait_streams
}

# Puts the 45-turn thread back on screen before a UI test (whose trips into other
# threads leave one of them open): a quick turn in it makes it the most recent, and a new
# launch opens the most recent. The files of the launch before are kept, numbered.
relaunches=0
relaunch() {
  BENCH_PROMPT="bench instant" scroll stream $url $USER_NAME $PASSWORD $threads[4] >> $dir/stream.log 2>&1
  quit_app
  relaunches=$(( relaunches + 1 ))
  local f
  for f in frames wash poll; do [[ -f $dir/$f.txt ]] && mv $dir/$f.txt $dir/$f-$relaunches.txt; done
  launch_app $current $dir
}

wash_fps() {  # <dir> <t0> <t1>
  [[ -s $1/wash.txt ]] || { print -- -; return }
  awk -v a=$2 -v b=$3 '$1 > a && $1 <= b { n += $2; c++ } END { if (c) printf "%.1f", n / (b - a); else print 0 }' $1/wash.txt
}

record() {  # <label> <stretch> <t0> <t1> [<threads.py line>]
  local s=$(python3 -I $HELP/stretch.py $dir/poll.txt $dir/frames.txt $3 $4)
  local w=$(wash_fps $dir $3 $4)
  local -a details
  local item
  for item in ${=${5:-}}; do
    case $item in cpu=*|main=*) details+=(sample_$item);; *) details+=($item);; esac
  done
  local load=$(uptime | sed 's/.*load averages*: //')
  log "$1 $2 $s wash=$w ${details[*]} load=[$load]"
  print -r -- "$1 $2 $s wash=$w ${details[*]}" >> $OUT/results.txt
}

sample() {  # <label> <stretch>: 12 s from now, with threads.py
  local t0=$EPOCHREALTIME
  local line=$(python3 -I $HELP/threads.py $app_pid 12)
  record $1 $2 $t0 $EPOCHREALTIME "$line"
}

uitest() {  # <label> <prefix>
  print -r -- $BUNDLE.$1 > $UIDIR/target.txt
  rm -f $UIDIR/marks.txt
  xcodebuild test-without-building -xctestrun $XCTESTRUN -destination "id=$SIM" > $dir/uitest-$2.log 2>&1 &
  local runner=$!
  for _ in {1..240}; do
    grep -qE "Test Suite 'All tests' (passed|failed)|\*\* TEST (SUCCEEDED|FAILED|EXECUTE FAILED)" $dir/uitest-$2.log 2>/dev/null && break
    kill -0 $runner 2>/dev/null || break
    sleep 1
  done
  sleep 2; kill $runner 2>/dev/null; wait $runner 2>/dev/null
  grep -q "error\|failed" $dir/uitest-$2.log && grep -E "error:|XCTAssert|failed" $dir/uitest-$2.log | head -3 | sed 's/^/  uitest: /' | tee -a $OUT/bench.log
  local phase t0 t1
  for phase in query chat switch sidebar; do
    t0=$(awk -v p=$phase '$2 == p && $3 == "start" { print $1 }' $UIDIR/marks.txt 2>/dev/null)
    t1=$(awk -v p=$phase '$2 == p && $3 == "end" { print $1 }' $UIDIR/marks.txt 2>/dev/null)
    [[ -n $t0 && -n $t1 ]] && record $1 $2$phase $t0 $t1 || log "  $1 $2$phase: no marks"
  done
  cp $UIDIR/marks.txt $dir/marks-$2.txt 2>/dev/null
  for f in chat sidebar; do [[ -f $UIDIR/$f.png ]] && mv $UIDIR/$f.png $dir/$2$f.png; done
}

memory() {  # <label> <stretch>
  local fp=$(footprint -p $app_pid 2>/dev/null | awk '/phys_footprint:/ { print $2 $3; exit }')
  local peak=$(footprint -p $app_pid 2>/dev/null | awk '/phys_footprint_peak:/ { print $2 $3; exit }')
  local surf=$(vmmap --summary $app_pid 2>/dev/null | awk '/^IOSurface / { print $2; exit }')
  log "$1 $2 footprint=$fp peak=$peak iosurface=$surf"
  print -r -- "$1 $2 footprint=$fp peak=$peak iosurface=$surf" >> $OUT/memory.txt
}

phases() {  # <label> <prefix>
  local label=$1 p=$2
  if [[ $PHASES == *idle* ]]; then sleep 3; sample $label ${p}idle; fi
  local t0
  if [[ $PHASES == *off* ]]; then
    t0=$EPOCHREALTIME
    stream $threads[1] $threads[2] $threads[3]; sleep 3; sample $label ${p}off; wait_streams
    record $label ${p}off-whole $t0 $EPOCHREALTIME
  fi
  if [[ $PHASES == *on* ]]; then
    t0=$EPOCHREALTIME
    stream $threads[4] $threads[1] $threads[2]; sleep 3; sample $label ${p}on
    xcrun simctl io $SIM screenshot $dir/${p}streaming.png >/dev/null 2>&1; wait_streams
    record $label ${p}on-whole $t0 $EPOCHREALTIME
  fi
  if [[ $PHASES == *ui* ]]; then relaunch; uitest $label "$p"; fi
  if [[ $PHASES == *busy* ]]; then
    relaunch; stream_loop $threads[4] $threads[1] $threads[2]; sleep 3; uitest $label "${p}busy-"; stop_loops
  fi
  memory $label ${p}end
}

run_one() {  # <label> <tag>
  local label=$1
  dir=$OUT/$2
  mkdir -p $dir
  current=$label
  rm -rf $HOME_DIR && cp -R $TEMPLATE $HOME_DIR
  start_bridge $dir/bridge.log || return 1
  launch_app $label $dir || { stop_bridge; return 1; }
  xcrun simctl io $SIM screenshot $dir/start.png >/dev/null 2>&1
  phases $label ""
  if (( SOAK )); then
    local until=$(( EPOCHSECONDS + SOAK * 60 )) n=0
    log "$label soaking for $SOAK min"
    while (( EPOCHSECONDS < until )); do
      stream_loop $threads[4] $threads[1] $threads[2]
      [[ -n $XCTESTRUN ]] && uitest $label soak$n- >/dev/null || sleep 60
      stop_loops
      n=$(( n + 1 ))
    done
    memory $label soak-before
    PHASES="idle off on ui" phases $label soak-
    quit_app
    launch_app $label $dir || { stop_bridge; return 1; }
    PHASES="idle off on ui" phases $label fresh-
  fi
  quit_app
  stop_bridge
}

log "out: $OUT; apps: ${APPS[*]}; rounds $ROUNDS; phases $PHASES; simulator $SIM; extra ${EXTRA[*]}"
xcrun simctl bootstatus $SIM -b >/dev/null 2>&1
for spec in $APPS; do
  label=${spec%%=*} built=${spec#*=}
  # A label names a copy in $OUT and a bundle id: letters, digits, - and _ only (nothing that leaves $OUT).
  [[ $label =~ '^[A-Za-z0-9][A-Za-z0-9_-]*$' ]] || { print -u2 "a label is letters, digits, - and _ only: '$label'"; exit 2 }
  rm -rf $OUT/$label.app
  cp -R $built $OUT/$label.app
  rm -rf $OUT/$label.app/PlugIns
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE.$label" $OUT/$label.app/Info.plist
  /usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" $OUT/$label.app/Info.plist 2>/dev/null
  codesign --force --deep -s - $OUT/$label.app 2>/dev/null
  xcrun simctl install $SIM $OUT/$label.app || exit 1
done
make_template
threads=($(cat $OUT/threads.txt))
log "threads: ${threads[*]}"
for round in $(seq 1 $ROUNDS); do
  for spec in $APPS; do run_one ${spec%%=*} r$round-${spec%%=*}; done
done
python3 -I $HELP/medians.py $OUT/results.txt | tee -a $OUT/bench.log
