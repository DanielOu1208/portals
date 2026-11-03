#!/bin/zsh
# What a reply streaming costs the app: CPU and frames while the reply streams into the
# thread on screen, with the window in view and with it covered (Mac) or in the
# background (iPhone simulator). Night of 2026-10-18 (docs/perf-mac-scroll.md).
#
#   scripts/stream-bench.sh [options] <label>=<built .app> [<label>=<built .app> …]
#
# Mac: each app is a Release Mac Catalyst build with the launch switches compiled in
# (SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG, see scripts/mac-scroll-bench.sh). Needs the
# gui lock. iPhone simulator (--ios <udid>): each app is a Release build for the
# simulator with the same switches (Release-iphonesimulator/Portals.app). Needs the
# sim lock.
#
# For every round, and every app in turn (A, B, A, B…), it starts a scratch bridge with
# only the fake agent on PORT (9352) in a scratch home under OUT, makes a thread of
# HISTORY turns (45) there, opens a scratch copy of the app on it (its own bundle id, no
# extension, no URL scheme; on the Mac in the background, in a scratch home; opened with
# PORTALS_DEBUG_OPEN_EACH=1:0.5, which waits for the list, where OPEN_LATEST sometimes
# opened a new thread instead, in about one run in four), has the
# fake agent stream its minute-long reply (bridge/src/providers/fakeBench.ts) and while
# it streams, nobody touching the app:
#   - the app's CPU over 12 s (ps), and its frames then (FrameMeter.swift: hitch ms a
#     second, hitches a second, frames a second, longest frame ms);
#   - with --trace, a Time Profiler recording of 10 s, summarised by
#     scripts/app-footprint/timeprofile.py (the summary is kept, the trace removed);
#   - Mac: its CPU over 10 s with the window covered by an opaque window
#     (scripts/app-footprint/cover.swift), after 3 s for the app to notice;
#     iPhone: its CPU over 10 s in the background (Settings brought up in front).
# Then it quits the app and the bridge and removes their homes and settings.
#
# It prints one line per run and the medians per app, with `uptime`'s load beside each
# run. Everything is kept under OUT.
#
# Options:
#   --rounds N     rounds of all apps (default 3)
#   --history N    turns in the thread (default 45)
#   --trace        also record a Time Profiler trace while it streams
#   --ios <udid>   run in that iPhone simulator instead of on the Mac
#   --no-cover     skip the covered / background stretch
#   --env K=V      also launch every app with this in its environment (repeatable)
#   --whole        instead of the 12 s, the trace and the covered stretch: the app's CPU
#                  and frames over the whole reply, from 3 s after it starts to its end

set -uo pipefail
zmodload zsh/datetime
ROOT=${0:A:h:h}
PORT=${PORT:-9352}
OUT=${OUT:-/private/tmp/portals-n4/bench/stream-$(date +%H%M%S)}
BUNDLE=${BUNDLE:-com.danielou.portals.n4-stream}
ROUNDS=3 HISTORY=45 TRACE=0 SIM="" COVER=1 WHOLE=0
APPS=() EXTRA=()
while (( $# )); do
  case $1 in
    --rounds) ROUNDS=$2; shift 2;;
    --history) HISTORY=$2; shift 2;;
    --trace) TRACE=1; shift;;
    --ios) SIM=$2; shift 2;;
    --no-cover) COVER=0; shift;;
    --env) EXTRA+=($2); shift 2;;
    --whole) WHOLE=1; TRACE=0; COVER=0; shift;;
    *=*) APPS+=($1); shift;;
    *) echo "unknown argument $1"; exit 2;;
  esac
done
(( ${#APPS} )) || { sed -n '2,/^$/p' $0; exit 2; }

HELPERS=$ROOT/scripts/mac-scroll-bench
BIN=$OUT/bin
BRIDGE=$ROOT/bridge
USER_NAME=bench PASSWORD=bench-$RANDOM-$RANDOM
mkdir -p $OUT $BIN
if [[ -z $SIM ]]; then
  swiftc -O $HELPERS/window.swift -o $BIN/window 2>/dev/null || { echo "could not build the window helper"; exit 1; }
  swiftc -O $ROOT/scripts/app-footprint/cover.swift -o $BIN/cover 2>/dev/null || { echo "could not build the cover helper"; exit 1; }
fi

log() { print -r -- "$(date +%T) $*" | tee -a $OUT/bench.log }

bridge_pid="" app_pid="" frames="" current=""
cleanup() {
  [[ -n $app_pid ]] && quit_app
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null
  if [[ -n $SIM ]]; then
    for spec in $APPS; do xcrun simctl uninstall $SIM $BUNDLE.${spec%%=*} 2>/dev/null; done
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

stop_bridge() {
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null && wait $bridge_pid 2>/dev/null
  bridge_pid=""
}

hosts() { print -r -- "[{\"name\":\"Scratch\",\"url\":\"http://127.0.0.1:$PORT\",\"user\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}]" }

launch_app() {  # <label> <app copy> <home>
  if [[ -n $SIM ]]; then
    local answer pair
    for pair in $EXTRA; do export SIMCTL_CHILD_$pair; done
    answer=$(SIMCTL_CHILD_PORTALS_DEBUG_HOSTS="$(hosts)" SIMCTL_CHILD_PORTALS_DEBUG_OPEN_EACH=1:0.5 \
      SIMCTL_CHILD_PORTALS_DEBUG_FRAMES=$frames xcrun simctl launch --terminate-running-process $SIM $BUNDLE.$1 2>&1)
    app_pid=${answer##*: }
    [[ $app_pid == <-> ]] || { log "  could not launch: $answer"; app_pid=""; return 1; }
    sleep 8
    return 0
  fi
  local extra=() pair
  for pair in $EXTRA; do extra+=(--env $pair); done
  for attempt in 1 2 3; do
    open -g -n $extra --env CFFIXED_USER_HOME=$3 --env "PORTALS_DEBUG_HOSTS=$(hosts)" --env PORTALS_DEBUG_OPEN_EACH=1:0.5 --env PORTALS_DEBUG_FRAMES=$frames $2
    for _ in {1..50}; do
      app_pid=$(pgrep -f "$2/Contents/MacOS/Portals" | head -1)
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
  if [[ -n $SIM ]]; then
    xcrun simctl terminate $SIM $BUNDLE.$current 2>/dev/null
  else
    [[ -n $app_pid ]] && kill $app_pid 2>/dev/null
    for _ in {1..30}; do kill -0 $app_pid 2>/dev/null || break; sleep 0.2; done
    defaults delete $BUNDLE >/dev/null 2>&1
    rm -f ~/Library/Preferences/$BUNDLE.plist
    rm -rf ~/Library/Saved\ Application\ State/$BUNDLE.savedState
  fi
  app_pid=""
}

cpu_seconds() {  # <pid> → CPU seconds used so far
  ps -o cputime= -p $1 | python3 -I -c 'import sys
t = sys.stdin.read().strip().replace("-", ":").split(":")
s = 0.0
for part in t: s = s * 60 + float(part)
print(s)'
}

cpu_over() {  # <seconds> → the app's CPU, % of a core
  local c0=$(cpu_seconds $app_pid) t0=$EPOCHREALTIME
  sleep $1
  local c1=$(cpu_seconds $app_pid) t1=$EPOCHREALTIME
  python3 -I -c "print(round(100 * ($c1 - $c0) / ($t1 - $t0), 1))"
}

frames_mark() { wc -l < $frames | tr -d ' ' }
frames_since() {  # <mark>
  sleep 1.2
  local from=0
  (( $1 > 0 )) && from=$(sed -n "${1}p" $frames | cut -d' ' -f1)
  tail -n +$(( $1 + 1 )) $frames | python3 -I $HELPERS/frames.py $from
}

trace() {  # <dir>
  local file=$1/streaming.trace
  xctrace record --template 'Time Profiler' ${SIM:+--device} ${SIM:+$SIM} --attach $app_pid --time-limit 10s --output $file >$1/xctrace.log 2>&1 || { log "  xctrace failed (xctrace.log)"; return 1; }
  xctrace export --input $file --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]' > $1/profile.xml 2>>$1/xctrace.log
  python3 -I $ROOT/scripts/app-footprint/timeprofile.py $1/profile.xml > $1/profile.txt 2>&1
  rm -rf $file
  gzip -f $1/profile.xml
}

run_one() {  # <label> <app copy> <tag>
  local label=$1 app=$2 tag=$3
  local dir=$OUT/$tag
  mkdir -p $dir
  local home=$dir/bridge-home
  frames=$dir/frames.txt
  : > $frames
  current=$label
  start_bridge $home || return 1
  local thread=$(node $BRIDGE/scripts/bench/scroll.ts seed http://127.0.0.1:$PORT $USER_NAME $PASSWORD $HISTORY)
  launch_app $label $app $dir/app-home || { stop_bridge; return 1; }
  local load=$(uptime | sed 's/.*load averages*: //')
  node $BRIDGE/scripts/bench/scroll.ts stream http://127.0.0.1:$PORT $USER_NAME $PASSWORD $thread > $dir/stream.log 2>&1 &
  local streamer=$!
  sleep 3
  if [[ -n $SIM ]]; then
    xcrun simctl io $SIM screenshot $dir/streaming.png >/dev/null 2>&1
  else
    screencapture -x -o -l ${window[1]} $dir/streaming.png 2>/dev/null
  fi
  local mark=$(frames_mark) cpu still
  if (( WHOLE )); then
    local c0=$(cpu_seconds $app_pid) t0=$EPOCHREALTIME
    wait $streamer
    local c1=$(cpu_seconds $app_pid) t1=$EPOCHREALTIME
    cpu=$(python3 -I -c "print(round(100 * ($c1 - $c0) / ($t1 - $t0), 1))")
    still=$(frames_since $mark)
  else
    cpu=$(cpu_over 12)
    still=$(frames_since $mark)
  fi
  (( TRACE )) && trace $dir
  local hidden="-"
  if (( COVER )); then
    if [[ -n $SIM ]]; then
      xcrun simctl launch $SIM com.apple.Preferences >/dev/null 2>&1
      sleep 3
      hidden=$(cpu_over 10)
      # Back in front: what it shows once seen again.
      xcrun simctl launch $SIM $BUNDLE.$label >/dev/null 2>&1
      sleep 2
      xcrun simctl io $SIM screenshot $dir/after-hidden.png >/dev/null 2>&1
    else
      $BIN/cover ${window[2]} ${window[3]} ${window[4]} ${window[5]} 15 &
      local cover=$!
      sleep 3
      hidden=$(cpu_over 10)
      wait $cover
      # Uncovered: what it shows once seen again.
      sleep 2
      screencapture -x -o -l ${window[1]} $dir/after-hidden.png 2>/dev/null
    fi
  fi
  local invalid=""
  if (( ! WHOLE )); then
    kill -0 $streamer 2>/dev/null || invalid="the reply ended before the measuring did"
    wait $streamer || : ${invalid:="the reply did not stream to its end (stream.log)"}
  fi
  grep -q "streamed in" $dir/stream.log || : ${invalid:="the reply did not stream to its end (stream.log)"}
  # An app that hardly worked was not showing the reply (seen: the iPhone app opened on a
  # new thread instead of the bench's, 1% where the others took 20%).
  (( ${cpu%.*} < 8 )) && : ${invalid:="the app hardly worked (${cpu}% CPU): was it showing the reply? ($dir/streaming.png)"}
  quit_app
  stop_bridge
  rm -rf $dir/app-home $home
  log "$label cpu_streaming=${cpu}% frames_streaming=[$still] cpu_hidden=${hidden}% load=[$load]"
  [[ -n $invalid ]] && { log "  left out: $invalid"; print -r -- "$label $invalid" >> $OUT/left-out.txt; return 0; }
  print -r -- "$label $cpu ${still// /,} $hidden" >> $OUT/results.txt
}

log "out: $OUT; apps: ${APPS[*]}; rounds $ROUNDS; history $HISTORY; ${SIM:+simulator $SIM}"
for spec in $APPS; do
  label=${spec%%=*} built=${spec#*=}
  if [[ -n $SIM ]]; then
    rm -rf $OUT/$label.app
    cp -R $built $OUT/$label.app
    rm -rf $OUT/$label.app/PlugIns
    /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE.$label" $OUT/$label.app/Info.plist
    /usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" $OUT/$label.app/Info.plist 2>/dev/null
    codesign --force --deep -s - $OUT/$label.app 2>/dev/null
    xcrun simctl install $SIM $OUT/$label.app || exit 1
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
python3 -I - $OUT/results.txt <<'EOF' | tee -a $OUT/bench.log
import collections, statistics, sys
rows = collections.defaultdict(list)
for line in open(sys.argv[1]):
    label, cpu, frames, hidden = line.split()
    rows[label].append((float(cpu), [float(x) if x != "-" else None for x in frames.split(",")], None if hidden == "-" else float(hidden)))
for label, runs in rows.items():
    med = lambda xs: statistics.median(xs) if xs else float("nan")
    cpu = med([r[0] for r in runs])
    hidden = med([r[2] for r in runs if r[2] is not None])
    cols = [med([r[1][i] for r in runs if r[1][i] is not None]) for i in range(4)]
    print(f"{label}: runs {len(runs)}, cpu streaming {cpu:.1f}%, frames hitch {cols[0]:.1f} ms/s ({cols[1]:.1f}/s, {cols[2]:.0f} fps, longest {cols[3]:.0f} ms), cpu hidden {hidden:.1f}%")
EOF
