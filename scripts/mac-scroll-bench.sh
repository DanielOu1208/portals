#!/bin/zsh
# Measures how smoothly the Mac app's chat scrolls while a reply streams in.
#
#   scripts/mac-scroll-bench.sh [options] <label>=<built .app> [<label>=<built .app> …]
#
# Each app is a Release Mac Catalyst build made with the launch switches compiled in
# (they are read only when DEBUG is set, which changes nothing else in the app):
#
#   xcodebuild -project Portals.xcodeproj -scheme Portals -configuration Release \
#     -destination 'generic/platform=macOS,variant=Mac Catalyst' -derivedDataPath <dd> \
#     CODE_SIGNING_ALLOWED=NO SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG build
#
# For every round, and every app in turn (A, B, A, B… so that the load of whatever
# else the Mac is doing falls on both alike), it:
#   1. starts a scratch bridge with only the scripted fake agent, on PORT (9341),
#      in a scratch home under OUT, and makes a thread there with HISTORY turns (each
#      a long reply with headings, lists, code, a table, math and tool calls; 45 by
#      default; `--short` runs a second pass with a 1-turn thread);
#   2. makes a scratch copy of the app (its own bundle id, no extension, no URL
#      scheme) and opens it on that thread, in the background, in a scratch home;
#   3. has the fake agent stream its minute-long reply (fakeBench.ts: 2–14 characters
#      every 30–80 ms, with tool calls), and while it streams:
#        - the app's CPU over 12 s while nobody scrolls (ps), and its frames then,
#        - its frames over SECONDS s while the chat is scrolled up and down with the
#          mouse wheel (cua-driver, in the background: the pointer does not move and
#          the app does not come forward),
#        - with --profile, a `sample` of the app over 10 s more of scrolling: how busy
#          its main thread was (the report is kept, to find what it was busy with);
#   4. once the reply is done, its frames over SECONDS s of the same scrolling, at rest;
#   5. quits the app and the bridge, and removes their scratch homes and settings.
#
# Frames come from the app itself (FrameMeter.swift, PORTALS_DEBUG_FRAMES): a
# display link on the main thread, whose calls the main thread can only take when it
# is free. A call later than half a frame past when it was due counts as a hitch, and
# the time it was late as hitch time. This measures how well the main thread keeps up
# with the display, which is what a busy chat costs; it is not Instruments' hitch
# time, which also counts frames the render server presents late while the main
# thread is free, so it can miss those. Hitch ms per second is read against Apple's
# guide for its "hitch time ratio" (under 5 smooth, over 10 visibly choppy) as a rough
# scale only. Instruments' own Animation Hitches template is not used: on this Mac it
# wrote an 11 GB trace in $TMPDIR in under a minute and filled the disk.
#
# It prints one line per run and the medians per app, with `uptime`'s load beside
# each run; everything (samples, frame logs, bridge logs) is kept under OUT.
#
# Needs: the gui lock (`/private/tmp/portals-n1/lock.sh take gui <you>`) while it
# runs, cua-driver, Node (the bridge's own node_modules), `sample`. The Mac
# must be awake and unlocked; the app's window must be on the Space in view, which
# the script checks (it relaunches up to three times).
#
# Options:
#   --rounds N     rounds of all apps (default 3)
#   --seconds S    seconds of each stretch of scrolling (default 20)
#   --history N    turns in the long thread (default 45)
#   --short        also run each app on a thread with 1 turn
#   --profile      also take a `sample` of the app while it streams and scrolls
#   --no-rest      skip the scrolling at rest

set -uo pipefail
zmodload zsh/datetime
ROOT=${0:A:h:h}
PORT=${PORT:-9341}
OUT=${OUT:-/private/tmp/portals-n1/bench/scroll-$(date +%H%M%S)}
ROUNDS=3 SECONDS_REC=20 HISTORY=45 SHORT=0 PROFILE=0 REST=1
APPS=()
while (( $# )); do
  case $1 in
    --rounds) ROUNDS=$2; shift 2;;
    --seconds) SECONDS_REC=$2; shift 2;;
    --history) HISTORY=$2; shift 2;;
    --short) SHORT=1; shift;;
    --profile) PROFILE=1; shift;;
    --no-rest) REST=0; shift;;
    *=*) APPS+=($1); shift;;
    *) echo "unknown argument $1"; exit 2;;
  esac
done
(( ${#APPS} )) || { sed -n '2,/^$/p' $0; exit 2; }

HELPERS=$ROOT/scripts/mac-scroll-bench
BIN=$OUT/bin
BRIDGE=$ROOT/bridge
USER_NAME=bench PASSWORD=bench-$RANDOM-$RANDOM
BUNDLE=com.danielou.portals.n1-scroll
mkdir -p $OUT $BIN
swiftc -O $HELPERS/window.swift -o $BIN/window 2>/dev/null || { echo "could not build the window helper"; exit 1; }

log() { print -r -- "$(date +%T) $*" | tee -a $OUT/bench.log }

bridge_pid=""
app_pid=""
cleanup() {
  [[ -n $app_pid ]] && kill $app_pid 2>/dev/null
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null
  defaults delete $BUNDLE >/dev/null 2>&1
  rm -f ~/Library/Preferences/$BUNDLE.plist
  rm -rf ~/Library/Saved\ Application\ State/$BUNDLE.savedState
}
trap cleanup EXIT INT TERM

start_bridge() {  # <home>
  node $BRIDGE/scripts/bench/scroll.ts config $1 $PORT $USER_NAME $PASSWORD || return 1
  PORTALS_BRIDGE_HOME=$1 PORTALS_BRIDGE_LOG=info node $BRIDGE/src/main.ts > $1/bridge.log 2>&1 &
  bridge_pid=$!
  for _ in {1..100}; do grep -q "listening on" $1/bridge.log 2>/dev/null && return 0; sleep 0.1; done
  echo "the bridge did not start"; return 1
}

stop_bridge() {
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null && wait $bridge_pid 2>/dev/null
  bridge_pid=""
}

launch_app() {  # <app copy> <home>
  local hosts="[{\"name\":\"Scratch\",\"url\":\"http://127.0.0.1:$PORT\",\"user\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}]"
  for attempt in 1 2 3; do
    open -g -n --env CFFIXED_USER_HOME=$2 --env "PORTALS_DEBUG_HOSTS=$hosts" --env PORTALS_DEBUG_OPEN_LATEST=1 --env PORTALS_DEBUG_FRAMES=$frames $1
    for _ in {1..50}; do
      app_pid=$(pgrep -f "$1/Contents/MacOS/Portals" | head -1)
      [[ -n $app_pid ]] && break
      sleep 0.2
    done
    sleep 6
    window=($($BIN/window $app_pid 2>/dev/null))
    (( ${#window} == 5 )) && return 0
    log "window not on the Space in view (attempt $attempt): relaunching"
    kill $app_pid 2>/dev/null; sleep 2
  done
  return 1
}

quit_app() {
  [[ -n $app_pid ]] && kill $app_pid 2>/dev/null
  for _ in {1..30}; do kill -0 $app_pid 2>/dev/null || break; sleep 0.2; done
  app_pid=""
  defaults delete $BUNDLE >/dev/null 2>&1
  rm -f ~/Library/Preferences/$BUNDLE.plist
  rm -rf ~/Library/Saved\ Application\ State/$BUNDLE.savedState
}

cpu_seconds() {  # <pid> → CPU seconds used so far
  ps -o cputime= -p $1 | python3 -I -c 'import sys
t = sys.stdin.read().strip().replace("-", ":").split(":")
s = 0.0
for part in t: s = s * 60 + float(part)
print(s)'
}

# Scrolls the chat up and down with the mouse wheel for <seconds>, ending at the bottom.
# Fails, with what the driver said in $OUT/scroll-errors.log, unless every scroll was
# sent: a stretch without its scrolling is not measured as one with.
scroll_for() {  # <seconds>
  local id=(${window[@]}) shot
  local session=scroll-$app_pid
  shot=$(cua-driver call get_window_state "{\"pid\":$app_pid,\"window_id\":${id[1]},\"include_accessibility_tree\":false,\"max_dimension\":400,\"session\":\"$session\",\"screenshot_out_file\":\"$OUT/shot.png\"}" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d["screenshot_width"], d["screenshot_height"])')
  local sw=${shot% *} sh=${shot#* }
  [[ -n $sw && -n $sh && $sw != $shot ]] || { log "  could not see the window to scroll it"; return 1; }
  # A point in the chat: right of the sidebar, above the composer.
  local x=$(( sw * 62 / 100 )) y=$(( sh * 45 / 100 ))
  local ends=$(( EPOCHREALTIME + $1 )) step=0 failed=0
  while (( EPOCHREALTIME < ends )); do
    local direction=$([[ $(( step / 2 % 2 )) == 0 ]] && echo up || echo down)
    scroll_once $x $y $direction 6 line || (( failed++ ))
    (( step++ ))
  done
  scroll_once $x $y down 30 page || (( failed++ ))
  (( failed == 0 )) || { log "  $failed of $(( step + 1 )) scrolls failed (scroll-errors.log)"; return 1; }
}

scroll_once() {  # <x> <y> <direction> <amount> <line|page>; fails unless the driver did it
  local answer
  answer=$(cua-driver call scroll "{\"pid\":$app_pid,\"window_id\":${window[1]},\"x\":$1,\"y\":$2,\"direction\":\"$3\",\"amount\":$4,\"by\":\"$5\",\"session\":\"scroll-$app_pid\"}" 2>&1)
  local code=$?
  if (( code != 0 )) || [[ $answer == *'"refusal"'* || $answer == *'"status" : "refused"'* || $answer == *'"status": "refused"'* || $answer == *'"isError"'* ]]; then
    print -r -- "$(date +%T) $answer" >> $OUT/scroll-errors.log
    return 1
  fi
}

# Where the app's frame meter (FrameMeter.swift) is: a line a second.
frames_mark() { wc -l < $frames | tr -d ' ' }

# The meter's lines since <mark>: "<hitch ms per s> <hitches per s> <frames per s> <longest ms>".
# The time they cover runs from the line at <mark> (the meter's start for 0): a line
# comes at the first frame a second or more after the last, which can be well over a
# second when the app is busy.
frames_since() {  # <mark>
  sleep 1.2
  local from=0
  (( $1 > 0 )) && from=$(sed -n "${1}p" $frames | cut -d' ' -f1)
  tail -n +$(( $1 + 1 )) $frames | python3 -I $HELPERS/frames.py $from
}

# The share of the app's main thread that was busy over <seconds> of scrolling (`sample`).
# Prints it, or fails (saying why in the log, not in what it prints) when the scrolling
# or the sample failed or the report has no main thread.
busy_scrolling() {  # <sample file> <seconds>
  sample $app_pid $2 5 -file $1 >/dev/null 2>&1 &
  local sampler=$! failed=0
  scroll_for $2 >&2 || failed=1
  wait $sampler || { log "  the sample failed" >&2; failed=1; }
  (( failed == 0 )) || return 1
  local busy
  busy=$(python3 -I $HELPERS/busy.py $1)
  [[ $busy == *% ]] || { log "  no main thread in the sample ($1)" >&2; return 1; }
  print -r -- $busy
}

run_one() {  # <label> <app copy> <turns> <tag>
  local label=$1 app=$2 turns=$3 tag=$4
  local dir=$OUT/$tag
  mkdir -p $dir
  local home=$dir/bridge-home
  frames=$dir/frames.txt
  start_bridge $home || return 1
  local thread=$(node $BRIDGE/scripts/bench/scroll.ts seed http://127.0.0.1:$PORT $USER_NAME $PASSWORD $turns)
  launch_app $app $dir/app-home || { stop_bridge; return 1; }
  local load=$(uptime | sed 's/.*load averages*: //')
  node $BRIDGE/scripts/bench/scroll.ts stream http://127.0.0.1:$PORT $USER_NAME $PASSWORD $thread > $dir/stream.log 2>&1 &
  local streamer=$!
  sleep 3
  # What the app shows as the reply streams, to look at when a run is off.
  screencapture -x -o -l ${window[1]} $dir/streaming.png 2>/dev/null
  # Streaming, nobody scrolling: CPU and frames.
  local mark=$(frames_mark) c0=$(cpu_seconds $app_pid) t0=$EPOCHREALTIME
  sleep 12
  local c1=$(cpu_seconds $app_pid) t1=$EPOCHREALTIME
  local cpu=$(python3 -I -c "print(round(100 * ($c1 - $c0) / ($t1 - $t0)))")
  local still=$(frames_since $mark)
  # Streaming, scrolled up and down.
  local invalid=""
  mark=$(frames_mark)
  scroll_for $SECONDS_REC || invalid="the scrolling while it streamed failed"
  local streaming=$(frames_since $mark)
  local busy="-"
  if (( PROFILE )); then
    busy=$(busy_scrolling $dir/sample-streaming.txt 10) || : ${invalid:="the scrolling or the sample while profiling failed"}
  fi
  # The reply has to have streamed through all of that.
  kill -0 $streamer 2>/dev/null || : ${invalid:="the reply ended before the measuring did (fewer --seconds)"}
  wait $streamer || : ${invalid:="the reply did not stream to its end (stream.log)"}
  # At rest, scrolled the same way.
  local rest="-"
  if (( REST )); then
    sleep 2
    mark=$(frames_mark)
    scroll_for $SECONDS_REC || : ${invalid:="the scrolling at rest failed"}
    rest=$(frames_since $mark)
  fi
  quit_app
  stop_bridge
  rm -rf $dir/app-home $home
  log "$label turns=$turns cpu_streaming=${cpu}% frames_streaming=[$still] frames_streaming_scrolling=[$streaming] main_busy_streaming_scrolling=$busy frames_rest_scrolling=[$rest] load=[$load]"
  # An app that hardly worked while the reply streamed was not showing it (seen once:
  # 7% where every other run took 33% or more). Such a run is kept out of the medians,
  # and counted, to be looked at: a build that really needs that little would be too.
  (( cpu < 15 )) && : ${invalid:="the app hardly worked (${cpu}% CPU): was it showing the reply? (see $dir/streaming.png)"}
  if [[ -n $invalid ]]; then
    log "  left out of the medians: $invalid"
    print -r -- "$label $turns $invalid" >> $OUT/left-out.txt
    return 0
  fi
  print -r -- "$label $turns $cpu ${still// /,} ${streaming// /,} $busy ${rest// /,}" >> $OUT/results.txt
}

log "out: $OUT; apps: ${APPS[*]}; rounds $ROUNDS; history $HISTORY; seconds $SECONDS_REC"
for spec in $APPS; do
  label=${spec%%=*} built=${spec#*=}
  $HELPERS/prepare-app.sh $built $OUT/$label.app $BUNDLE || exit 1
done
for round in $(seq 1 $ROUNDS); do
  for spec in $APPS; do
    label=${spec%%=*}
    run_one $label $OUT/$label.app $HISTORY r$round-$label-long
    (( SHORT )) && run_one $label $OUT/$label.app 1 r$round-$label-short
  done
done
python3 -I $HELPERS/summary.py $OUT/results.txt | tee -a $OUT/bench.log
summarized=$?
if [[ -f $OUT/left-out.txt ]]; then
  log "runs left out of the medians: $(wc -l < $OUT/left-out.txt | tr -d ' ') (left-out.txt)"
fi
exit $summarized
