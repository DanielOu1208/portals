#!/bin/zsh
# Measures how a thread opens in the app: whether its first frame is at the end of the
# chat or short of it and then scrolled down, and how long it takes to show.
#
#   scripts/open-bench.sh [options] <label>=<built .app> [<label>=<built .app> …]
#
# Mac (the default): each app is a Release Mac Catalyst build with the launch switches
# compiled in (they are read only when DEBUG is set, which changes nothing else):
#
#   xcodebuild -project Portals.xcodeproj -scheme Portals -configuration Release \
#     -destination 'generic/platform=macOS,variant=Mac Catalyst' -derivedDataPath <dd> \
#     CODE_SIGNING_ALLOWED=NO SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG build
#
# With --sim <simulator id>, each app is a simulator build instead (the same command with
# -destination 'platform=iOS Simulator,id=<id>' and -configuration Release), installed
# under a throwaway bundle id and uninstalled afterwards.
#
# It starts a scratch bridge with only the scripted fake agent on PORT (9351), in a
# scratch home under OUT, and makes threads of several shapes there
# (bridge/scripts/bench/open.ts seed: 1, 10, 45 and 120 turns of a long reply with tool
# rows, diffs, code, a table and math; one with a very long last reply; one with a turn
# running, started before each run; one waiting on an approval card; nine short ones).
# Then for every round, and every app in turn (A, B, A, B…), on a new scratch home:
#   1. it opens each shaped thread once: `cold`, nothing of it on the device yet;
#   2. switches between the 45- and 120-turn threads twice: `warm`, still in memory;
#   3. opens the nine short ones (`cold-small`), which lets the 45 and 120 go (the app
#      keeps the eight threads looked at last), then those two again: `saved`, shown from
#      the copy saved on the device while the host's is fetched;
#   4. quits, starts again on the same home, and opens the 120 and the 45 again:
#      `relaunch`, the first threads opened after a launch.
# The threads are opened by the app itself, 4 s apart (PORTALS_DEBUG_OPEN_PLAN), and
# each opening is measured by the app (OpenProbe.swift, PORTALS_DEBUG_OPEN_PROBE): over
# the 3 s after it, frame by frame, how far the chat is from its end.
#   content_ms   from the request to the first frame that shows the thread
#   first_dist   that frame's distance from the end, in points (0: at the end)
#   moves        frames after it in which the end moved on screen, with nothing touched
#   lags         layouts after it that left the chat short of its end, nothing touched
#                (a streaming reply followed a frame late; the frames may not see it)
#   settled_ms   from the request to the frame from which the chat stays at its end
#   max_dist     the farthest from the end once shown
# It prints one line per opening and the medians per app and case; everything is kept
# under OUT (probe.jsonl and the app's and bridge's logs for each run).
#
# Needs: on a Mac, the gui lock (the app's frames are measured); with --sim, the sim
# lock. Node (the bridge's own node_modules). The Mac must be awake and unlocked, and the
# app's window on the Space in view (checked; it relaunches up to three times).
#
# Beside it, in scripts/open-bench/: table.py (a Markdown table of a run, A against B),
# follow.sh (the chat still follows a streaming reply, on a Mac copy), shots.sh (pictures
# of a thread opened right after a relaunch), profile.sh and heaviest.py (where the main
# thread's time goes while threads are opened). Results: docs/perf-open.md.
#
# Options:
#   --rounds N     rounds of all apps (default 3)
#   --sim ID       run on this iOS simulator instead of the Mac
#   --gap S        seconds between openings (default 4; the probe watches 3)

set -uo pipefail
zmodload zsh/datetime
ROOT=${0:A:h:h}
PORT=${PORT:-9351}
OUT=${OUT:-/private/tmp/portals-n4/bench/open/run-$(date +%H%M%S)}
ROUNDS=3 SIM="" GAP=4
APPS=()
while (( $# )); do
  case $1 in
    --rounds) ROUNDS=$2; shift 2;;
    --sim) SIM=$2; shift 2;;
    --gap) GAP=$2; shift 2;;
    *=*) APPS+=($1); shift;;
    *) echo "unknown argument $1"; exit 2;;
  esac
done
(( ${#APPS} )) || { sed -n '2,/^$/p' $0; exit 2; }

HELPERS=$ROOT/scripts/mac-scroll-bench
BIN=$OUT/bin
BRIDGE=$ROOT/bridge
USER_NAME=bench PASSWORD=bench-$RANDOM-$RANDOM
BUNDLE=com.danielou.portals.n4-open
mkdir -p $OUT $BIN
[[ -n $SIM ]] || swiftc -O $HELPERS/window.swift -o $BIN/window 2>/dev/null || { echo "could not build the window helper"; exit 1; }
URL=http://127.0.0.1:$PORT

log() { print -r -- "$(date +%T) $*" | tee -a $OUT/bench.log }

bridge_pid=""
app_pid=""
cleanup() {
  [[ -n $app_pid ]] && kill $app_pid 2>/dev/null
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null
  if [[ -n $SIM ]]; then
    xcrun simctl terminate $SIM $BUNDLE >/dev/null 2>&1
    xcrun simctl uninstall $SIM $BUNDLE >/dev/null 2>&1
  else
    defaults delete $BUNDLE >/dev/null 2>&1
    rm -f ~/Library/Preferences/$BUNDLE.plist
    rm -rf ~/Library/Saved\ Application\ State/$BUNDLE.savedState
  fi
}
trap cleanup EXIT INT TERM

start_bridge() {  # <home>
  node $BRIDGE/scripts/bench/scroll.ts config $1 $PORT $USER_NAME $PASSWORD || return 1
  PORTALS_BRIDGE_HOME=$1 PORTALS_BRIDGE_LOG=info node $BRIDGE/src/main.ts > $1/bridge.log 2>&1 &
  bridge_pid=$!
  for _ in {1..100}; do grep -q "listening on" $1/bridge.log 2>/dev/null && return 0; sleep 0.1; done
  echo "the bridge did not start"; return 1
}

id_of() { python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" $OUT/ids.json $1 }

# The plan of one launch: labels (case:thread) and the ids to open.
plan_ids() { local ids=(); for entry in "$@"; do ids+=($(id_of ${entry#*:})); done; print -r -- ${(j:,:)ids} }

HOSTS="[{\"name\":\"Scratch\",\"url\":\"$URL\",\"user\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}]"

launch_mac() {  # <app copy> <home> <probe file> <plan>
  # A launch given up on is undone before the next try: what it measured would be taken
  # for the next launch's (summary.py pairs them with the plan in order), and the threads
  # it fetched and saved in its home would open from their saved copies, not cold.
  local kept=0
  [[ -f $3 ]] && kept=$(wc -l < $3)
  rm -rf $2.before
  [[ -d $2 ]] && ditto $2 $2.before
  for attempt in 1 2 3; do
    if (( attempt > 1 )); then
      [[ -f $3 ]] && { head -n $kept $3 > $3.kept; mv $3.kept $3 }
      rm -rf $2
      [[ -d $2.before ]] && ditto $2.before $2
    fi
    open -g -n --env CFFIXED_USER_HOME=$2 --env "PORTALS_DEBUG_HOSTS=$HOSTS" \
      --env PORTALS_DEBUG_OPEN_PROBE=$3 --env "PORTALS_DEBUG_OPEN_PLAN=$4:$GAP" $1
    for _ in {1..50}; do
      app_pid=$(pgrep -f "$1/Contents/MacOS/Portals" | head -1)
      [[ -n $app_pid ]] && break
      sleep 0.2
    done
    sleep 2
    window=($($BIN/window $app_pid 2>/dev/null))
    (( ${#window} == 5 )) && { rm -rf $2.before; return 0 }
    log "window not on the Space in view (attempt $attempt): relaunching"
    kill $app_pid 2>/dev/null
    for _ in {1..30}; do kill -0 $app_pid 2>/dev/null || break; sleep 0.2; done
  done
  rm -rf $2.before
  return 1
}

quit_mac() {
  [[ -n $app_pid ]] && kill $app_pid 2>/dev/null
  for _ in {1..30}; do kill -0 $app_pid 2>/dev/null || break; sleep 0.2; done
  app_pid=""
}

launch_sim() {  # <unused> <unused> <probe file> <plan>
  SIMCTL_CHILD_PORTALS_DEBUG_HOSTS=$HOSTS SIMCTL_CHILD_PORTALS_DEBUG_OPEN_PROBE=$3 \
    SIMCTL_CHILD_PORTALS_DEBUG_OPEN_PLAN="$4:$GAP" \
    xcrun simctl launch --terminate-running-process $SIM $BUNDLE >/dev/null
}

quit_sim() { xcrun simctl terminate $SIM $BUNDLE >/dev/null 2>&1; sleep 1 }

# Waits until the probe has written <n> lines, or the time is up.
wait_lines() {  # <probe file> <n> <seconds>
  local ends=$(( EPOCHREALTIME + $3 ))
  while (( EPOCHREALTIME < ends )); do
    [[ -f $1 ]] && (( $(wc -l < $1) >= $2 )) && return 0
    sleep 0.5
  done
  return 1
}

FIRST=(cold:t1 cold:t10 cold:t45 cold:t120 cold:long cold:running cold:approval
  warm:t45 warm:t120 warm:t45 warm:t120
  cold-small:f1 cold-small:f2 cold-small:f3 cold-small:f4 cold-small:f5 cold-small:f6 cold-small:f7 cold-small:f8 cold-small:f9
  saved:t45 saved:t120)
SECOND=(relaunch:t120 relaunch:t45)

run_one() {  # <label> <app> <tag>
  local label=$1 app=$2 dir=$OUT/$3
  mkdir -p $dir
  local probe=$dir/probe.jsonl home=$dir/app-home
  local load=$(uptime | sed 's/.*load averages*: //')
  node $BRIDGE/scripts/bench/open.ts run $URL $USER_NAME $PASSWORD $(id_of running) || log "  could not start the running turn"
  if [[ -n $SIM ]]; then
    xcrun simctl uninstall $SIM $BUNDLE >/dev/null 2>&1
    xcrun simctl install $SIM $app || { log "  could not install $app"; print "could not install the app" >> $dir/incomplete; return 1; }
    launch_sim "" "" $probe $(plan_ids $FIRST)
  else
    launch_mac $app $home $probe $(plan_ids $FIRST) || { log "  the window never showed"; print "the window never showed" >> $dir/incomplete; return 1; }
  fi
  # A run that did not open every thread is marked, and summary.py and table.py leave
  # it out.
  wait_lines $probe ${#FIRST} $(( ${#FIRST} * GAP + 60 )) || {
    log "  the first launch did not open every thread"; print "the first launch did not open every thread" >> $dir/incomplete; }
  if [[ -n $SIM ]]; then quit_sim; else quit_mac; fi
  sleep 1
  if [[ -n $SIM ]]; then
    launch_sim "" "" $probe $(plan_ids $SECOND)
  else
    launch_mac $app $home $probe $(plan_ids $SECOND) || { log "  the window never showed after the relaunch"; print "the window never showed after the relaunch" >> $dir/incomplete; return 1; }
  fi
  wait_lines $probe $(( ${#FIRST} + ${#SECOND} )) $(( ${#SECOND} * GAP + 60 )) || {
    log "  the relaunch did not open every thread"; print "the relaunch did not open every thread" >> $dir/incomplete; }
  if [[ -n $SIM ]]; then quit_sim; else quit_mac; fi
  node $BRIDGE/scripts/bench/open.ts stop $URL $USER_NAME $PASSWORD $(id_of running) >/dev/null 2>&1
  [[ -n $SIM ]] || rm -rf $home
  print -r -- "${(j: :)FIRST} ${(j: :)SECOND}" > $dir/labels.txt
  python3 -I $ROOT/scripts/open-bench/summary.py line $label $dir/labels.txt $probe "$load" | tee -a $OUT/bench.log
  print -r -- "$label $dir" >> $OUT/runs.txt
}

log "out: $OUT; apps: ${APPS[*]}; rounds $ROUNDS; ${SIM:+simulator $SIM}${SIM:-Mac}"
start_bridge $OUT/bridge-home || exit 1
node $BRIDGE/scripts/bench/open.ts seed $URL $USER_NAME $PASSWORD $OUT/ids.json 2>> $OUT/bench.log || { log "could not seed the threads"; exit 1; }
for spec in $APPS; do
  label=${spec%%=*} built=${spec#*=}
  if [[ -n $SIM ]]; then
    # Copied from where it really is (a copy of a link would change the app it points to).
    built=${built:A}
    [[ -f $built/Info.plist ]] || { log "$built is not a simulator app"; exit 1; }
    rm -rf $OUT/$label.app; cp -R $built $OUT/$label.app
    # Nothing outside the copy is changed: a link leading out of it, or nowhere, is refused.
    for link in ${(f)"$(find ${OUT:A}/$label.app -type l)"}; do
      [[ -e $link && ${link:A} == ${OUT:A}/$label.app/* ]] || { log "$link leads out of the copy or nowhere: not changed"; rm -rf $OUT/$label.app; exit 1; }
    done
    /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE" $OUT/$label.app/Info.plist
    rm -rf $OUT/$label.app/PlugIns $OUT/$label.app/_CodeSignature
    codesign --force --deep -s - $OUT/$label.app 2>/dev/null
  else
    $HELPERS/prepare-app.sh $built $OUT/$label.app $BUNDLE || exit 1
  fi
done
for round in $(seq 1 $ROUNDS); do
  for spec in $APPS; do
    label=${spec%%=*}
    run_one $label $OUT/$label.app r$round-$label
  done
done
python3 -I $ROOT/scripts/open-bench/summary.py medians $OUT/runs.txt | tee -a $OUT/bench.log
