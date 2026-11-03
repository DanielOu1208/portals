#!/bin/zsh
# Tries to open threads blank, as the user saw on an iPhone (2026-10-19): a thread opened
# from the sidebar showing nothing but the subagents line until scrolled by hand. On an
# iPhone simulator, against a scratch bridge with only the fake agent.
#
#   scripts/blank-bench.sh --sim <udid> --app <built .app> --xctestrun <file> [options]
#
# The app is a Debug build for the simulator; the xctestrun is the UI test project's
# (scripts/phone-bench/uitest, built with `xcodebuild build-for-testing -project
# scripts/phone-bench/uitest/WidgetUI.xcodeproj -scheme UITests -destination
# 'platform=iOS Simulator,id=<udid>' -derivedDataPath <dd>`), whose BlankUITests taps the
# sidebar's rows. It
#   1. makes the bridge's home once (TEMPLATE: bridge/scripts/bench/blank.ts seed: long
#      threads, threads with visuals, threads to stream into) and puts a copy back each run;
#   2. starts the bridge on PORT (9374), and the fake agent's minute-long reply over and
#      over in "Streaming 45" and "Streaming visuals" (visuals there in turn);
#   3. installs a copy of the app (its own bundle id) and launches it with the blank probe
#      (PORTALS_DEBUG_BLANK, BlankProbe.swift) and the open probe on;
#   4. runs the UI test's plan (--steps, as BlankUITests.swift says): rows tapped in the
#      sidebar, Settings in front and back, rows tapped right after coming back;
#   5. --relaunches N times: Settings in front, the app ended there (kill -9, as the
#      system does), launched again on the thread it had on screen, then a row tapped.
# A picture of the simulator is taken when the probe says a chat has been blank for half
# a second (shots/). Everything under OUT: blank.jsonl, open.jsonl, marks.txt, the UI
# test's pictures of blank screens, summary.txt.
#
# Options:
#   --steps "…"       the UI test's plan (default: 40 taps among the long threads, the
#                     streaming ones and the visuals, with comings back between)
#   --dwell S         seconds after each opening before the next step (2.5)
#   --relaunches N    ended in the background and launched again N times (default 4)
#   --env K=V         launch the app with this too (PORTALS_DEBUG_BLANK_FIX=last)
#   --no-stream       no replies streaming

set -uo pipefail
zmodload zsh/datetime
ROOT=${0:A:h:h}
BASE=/tmp/portals-blank-repro
PORT=${PORT:-9374}
OUT=${OUT:-$BASE/out/run-$(date +%H%M%S)}
TEMPLATE=${TEMPLATE:-$BASE/bridge-template}
BUNDLE=com.danielou.portals.blank
SIM="" APP="" XCTESTRUN="" DWELL=2.5 RELAUNCHES=4 STREAM=1
EXTRA=()
STEPS=""
while (( $# )); do
  case $1 in
    --sim) SIM=$2; shift 2;;
    --app) APP=$2; shift 2;;
    --xctestrun) XCTESTRUN=$2; shift 2;;
    --steps) STEPS=$2; shift 2;;
    --dwell) DWELL=$2; shift 2;;
    --relaunches) RELAUNCHES=$2; shift 2;;
    --env) EXTRA+=($2); shift 2;;
    --no-stream) STREAM=0; shift;;
    *) echo "unknown argument $1"; exit 2;;
  esac
done
[[ -n $SIM && -n $APP && -n $XCTESTRUN ]] || { sed -n '2,/^$/p' $0; exit 2; }
if [[ -z $STEPS ]]; then
  STEPS=""
  for round in 1 2 3 4; do
    STEPS+="tap:Long_60 tap:Streaming_45 tap:Visuals_45 tap:Streaming_visuals tap:Long_45 "
    STEPS+="away-tap:3:Streaming_45 tap:Long_60 away:3 away-tap:4:Visuals_45 tap:Streaming_visuals "
  done
fi

BRIDGE=$ROOT/bridge
HOME_DIR=$BASE/bridge-home
UIDIR=$BASE/uitest-$SIM   # where BlankUITests.swift looks
mkdir -p $OUT/shots $UIDIR
log() { print -r -- "$(date +%T) $*" | tee -a $OUT/bench.log }
scroll() { node $BRIDGE/scripts/bench/scroll.ts "$@" }

bridge_pid="" app_pid="" watcher="" loops=()
cleanup() {
  rm -f $OUT/looping
  for p in $loops; do kill $p 2>/dev/null; done
  [[ -n $watcher ]] && kill $watcher 2>/dev/null
  xcrun simctl terminate $SIM $BUNDLE >/dev/null 2>&1
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null
  xcrun simctl uninstall $SIM $BUNDLE >/dev/null 2>&1
  rm -rf $HOME_DIR $BASE/app.app $UIDIR
}
trap cleanup EXIT INT TERM

start_bridge() {  # <log>
  PORTALS_BRIDGE_HOME=$HOME_DIR PORTALS_BRIDGE_LOG=info node $BRIDGE/src/main.ts > $1 2>&1 &
  bridge_pid=$!
  for _ in {1..100}; do grep -q "listening on" $1 2>/dev/null && return 0; sleep 0.1; done
  echo "the bridge did not start"; return 1
}

# The bridge's home, made once.
if [[ ! -f $TEMPLATE/ids.json ]]; then
  rm -rf $TEMPLATE $HOME_DIR
  print -r -- "bench-blank-$RANDOM$RANDOM" > $BASE/password.tmp
  scroll config $HOME_DIR $PORT bench $(cat $BASE/password.tmp) || exit 1
  start_bridge $OUT/seed-bridge.log || exit 1
  node $BRIDGE/scripts/bench/blank.ts seed http://127.0.0.1:$PORT bench $(cat $BASE/password.tmp) $HOME_DIR/ids.json || exit 1
  kill $bridge_pid; wait $bridge_pid 2>/dev/null; bridge_pid=""
  mv $BASE/password.tmp $HOME_DIR/password.txt
  cp -R $HOME_DIR $TEMPLATE
fi
PASSWORD=$(cat $TEMPLATE/password.txt)
URL=http://127.0.0.1:$PORT
HOSTS="[{\"name\":\"Scratch\",\"url\":\"$URL\",\"user\":\"bench\",\"password\":\"$PASSWORD\"}]"
id_of() { python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" $TEMPLATE/ids.json $1 }
cp $TEMPLATE/ids.json $OUT/ids.json

rm -rf $HOME_DIR && cp -R $TEMPLATE $HOME_DIR
start_bridge $OUT/bridge.log || exit 1

# The app, as a copy of its own.
rm -rf $BASE/app.app && cp -R $APP $BASE/app.app && rm -rf $BASE/app.app/PlugIns
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE" $BASE/app.app/Info.plist
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" $BASE/app.app/Info.plist 2>/dev/null
codesign --force --deep -s - $BASE/app.app 2>/dev/null
xcrun simctl bootstatus $SIM -b >/dev/null 2>&1
xcrun simctl uninstall $SIM $BUNDLE >/dev/null 2>&1
xcrun simctl install $SIM $BASE/app.app || exit 1

launch() {  # [--terminate-running-process]
  local pair answer
  for pair in $EXTRA; do export SIMCTL_CHILD_$pair; done
  answer=$(SIMCTL_CHILD_PORTALS_DEBUG_HOSTS="$HOSTS" SIMCTL_CHILD_PORTALS_DEBUG_BLANK=$OUT/blank.jsonl \
    SIMCTL_CHILD_PORTALS_DEBUG_OPEN_PROBE=$OUT/open.jsonl xcrun simctl launch "$@" $SIM $BUNDLE 2>&1)
  app_pid=${answer##*: }
  [[ $app_pid == <-> ]] || { log "could not launch: $answer"; app_pid=""; return 1; }
  log "launched $app_pid"
}

# Pictures when the probe says a chat has been blank for half a second.
watch_shots() {
  local seen=0 n=0 lines
  while true; do
    if [[ -f $OUT/blank.jsonl ]]; then
      lines=$(wc -l < $OUT/blank.jsonl | tr -d ' ')
      if (( lines > seen )); then
        if (( n < 20 )) && sed -n "$((seen + 1)),${lines}p" $OUT/blank.jsonl | grep -qE '"event":"persist".*"ms":[5-9][0-9][0-9],'; then
          n=$(( n + 1 ))
          xcrun simctl io $SIM screenshot --type=jpeg $OUT/shots/blank-$(date +%H%M%S)-$n.jpg >/dev/null 2>&1
        fi
        seen=$lines
      fi
    fi
    sleep 0.2
  done
}

stream_loop() {  # <thread> <prompts…>: replies one after another until the run ends
  local thread=$1; shift
  local prompts=("$@")
  ( local i=0
    while [[ -f $OUT/looping ]]; do
      BENCH_PROMPT=${prompts[$(( i % ${#prompts} + 1 ))]} scroll stream $URL bench $PASSWORD $thread >> $OUT/stream.log 2>&1
      i=$(( i + 1 ))
    done ) &
  loops+=($!)
}

uitest() {  # <name> <steps>
  local rc=0 expected=0 step looks=0 allowed=120
  # How long the plan may take, its waits and times away included, two minutes more.
  for step in ${=2}; do
    case $step in
      tap:*|drag) expected=$(( expected + 1 )); allowed=$(( allowed + DWELL + 12 ));;
      away:*|away-tap:*) expected=$(( expected + 1 )); allowed=$(( allowed + ${${step#*:}%%:*} + DWELL + 12 ));;
      wait:*) allowed=$(( allowed + ${step#wait:} + 1 ));;
      *) allowed=$(( allowed + 5 ));;
    esac
  done
  rm -f $UIDIR/marks.txt
  print -r -- $BUNDLE > $UIDIR/plan.txt
  print -r -- $2 >> $UIDIR/plan.txt
  print -r -- $DWELL >> $UIDIR/plan.txt
  log "uitest $1: $2"
  # xcodebuild often stays on after the test has run: ended once its log says the tests
  # are over (their verdict then read from the log), or once the plan's time is up.
  xcodebuild test-without-building -xctestrun $XCTESTRUN -destination "id=$SIM" \
    -only-testing:UITests/BlankUITests/testOpenFromSidebar > $OUT/uitest-$1.log 2>&1 &
  local xcode=$! ends=$(( SECONDS + allowed )) ended=0
  while kill -0 $xcode 2>/dev/null; do
    if grep -qE "^Test Suite 'Selected tests' (passed|failed)" $OUT/uitest-$1.log 2>/dev/null || (( SECONDS > ends )); then
      # Ended here only if still on: one that exited meanwhile gives its own verdict.
      sleep "${BLANK_UI_EXIT_GRACE_SECONDS:-2}"; kill $xcode 2>/dev/null && ended=1; break
    fi
    sleep "${BLANK_UI_POLL_SECONDS:-1}"
  done
  wait $xcode 2>/dev/null || (( ended )) || rc=1
  (( ended )) && { grep -qE "^Test Suite 'Selected tests' passed" $OUT/uitest-$1.log || rc=1 }
  grep -E "error:|XCTAssert|Test Case .* (passed|failed|skipped)" $OUT/uitest-$1.log | head -3 | sed 's/^/  /' | tee -a $OUT/bench.log
  if [[ -f $UIDIR/marks.txt ]]; then
    looks=$(grep -cE '^[0-9.]+ ink ' $UIDIR/marks.txt)
    grep -qE '^[0-9.]+ done$' $UIDIR/marks.txt || rc=1
    cat $UIDIR/marks.txt >> $OUT/marks.txt
    rm $UIDIR/marks.txt
  else
    rc=1
  fi
  (( expected > 0 && looks == expected )) || rc=1
  local f
  for f in $UIDIR/blank-*.jpg(N) $UIDIR/shot-*.jpg(N); do mv $f $OUT/shots/uitest-$1-${f:t}; done
  return $rc
}

log "out $OUT; app $APP; sim $SIM; extra ${EXTRA[*]}; relaunches $RELAUNCHES; stream $STREAM"
watch_shots &
watcher=$!
if (( STREAM )); then
  : > $OUT/looping
  stream_loop $(id_of stream45) bench
  stream_loop $(id_of streamvis) bench "visual many"
fi
launch --terminate-running-process || exit 1
sleep 8
failures=0
uitest main "$STEPS" || failures=$(( failures + 1 ))

titles=(Long_60 Streaming_45 Visuals_45 Streaming_visuals Long_45)
for (( i = 1; i <= RELAUNCHES; i++ )); do
  # Away, ended there by the system, and opened again on the thread it had on screen.
  xcrun simctl launch $SIM com.apple.Preferences >/dev/null 2>&1
  sleep 2
  print -r -- "$(printf '%.3f' $EPOCHREALTIME) killed $app_pid" >> $OUT/marks.txt
  kill -9 $app_pid 2>/dev/null
  sleep 1.5
  print -r -- "$(printf '%.3f' $EPOCHREALTIME) relaunch" >> $OUT/marks.txt
  launch || { failures=$(( failures + 1 )); break; }
  sleep 6
  uitest relaunch-$i "tap:${titles[$(( i % ${#titles} + 1 ))]} away-tap:2:${titles[$(( (i + 2) % ${#titles} + 1 ))]}" || failures=$(( failures + 1 ))
done

rm -f $OUT/looping
sleep 1
python3 -I $ROOT/scripts/blank-bench/summary.py $OUT | tee $OUT/summary.txt || failures=$(( failures + 1 ))
(( failures == 0 ))
