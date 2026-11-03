#!/bin/zsh
# Measures the Mac app's sidebar with hundreds of threads, its launch, and its memory
# (docs/perf-sidebar.md), on scratch copies and a scratch bridge, never the installed
# app or bridge.
#
#   scripts/sidebar-bench.sh [options] <label>=<built .app> [<label>=<built .app> …]
#   (<label>=<built .app>@NAME=value launches that one with one more switch)
#
# Each app is a Release Mac Catalyst build with the launch switches compiled in
# (SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG, see scripts/mac-scroll-bench.sh). For every
# round, and every app in turn (A, B, A, B…), it:
#   1. starts a scratch bridge on PORT (9353) with THREADS threads (600) over five
#      agents and eight folders (scripts/sidebar-bench/bridge.mts), one in ten under
#      Finished;
#   2. makes a scratch copy of the app and opens it in the background with every agent
#      open in the sidebar (PORTALS_DEBUG_SIDEBAR_BENCH), its frame meter
#      (PORTALS_DEBUG_FRAMES) and its probe (PORTALS_DEBUG_SIDEBAR_PROBE);
#   3. fold: presses Show more and Show fewer on every open list at once, FOLDS times,
#      and notes each time until the main thread could draw again (the probe);
#   4. scroll: with every list shown whole, scrolls the sidebar up and down with the
#      mouse wheel for SECONDS (cua-driver, in the background) and notes the frames;
#   5. turns: runs a turn in TURNS threads one after another, as another device would
#      (each goes to Running, then to Finished), and notes the frames meanwhile;
#   6. renames: gives RENAMES threads a new title from another device, a second
#      apart, and notes the frames;
#   7. launch: quits the copy and opens it again on the list it saved, and notes when
#      its first sidebar row showed, and when the bridge's list was merged;
#   8. memory: opens it again and the 20 newest threads one after another, and notes
#      its footprint once the list is in, after them, and at rest.
#
# With --profile it also records Time Profiler over the folds, the scroll and the turns
# (xctrace, kept under OUT; read with scripts/app-footprint/timeprofile.py).
#
# Needs the gui lock (/private/tmp/portals-n4/lock.sh take gui <you>) while it runs.
#
# Options: --rounds N (3), --threads N (600), --seconds S (15), --folds N (12),
#          --turns N (6), --renames N (6), --profile, --only fold,scroll,turns,renames,launch,memory

set -uo pipefail
zmodload zsh/datetime
ROOT=${0:A:h:h}
PORT=${PORT:-9353}
OUT=${OUT:-/private/tmp/portals-n4/bench/sidebar/run-$(date +%H%M%S)}
ROUNDS=3 THREADS=600 SECONDS_REC=15 FOLDS=12 TURNS=6 RENAMES=6 PROFILE=0 ONLY=fold,scroll,turns,renames,launch,memory
APPS=()
while (( $# )); do
  case $1 in
    --rounds) ROUNDS=$2; shift 2;;
    --threads) THREADS=$2; shift 2;;
    --seconds) SECONDS_REC=$2; shift 2;;
    --folds) FOLDS=$2; shift 2;;
    --turns) TURNS=$2; shift 2;;
    --renames) RENAMES=$2; shift 2;;
    --profile) PROFILE=1; shift;;
    --only) ONLY=$2; shift 2;;
    *=*) APPS+=($1); shift;;
    *) echo "unknown argument $1"; exit 2;;
  esac
done
(( ${#APPS} )) || { sed -n '2,/^$/p' $0; exit 2; }
wants() { [[ ",$ONLY," == *",$1,"* ]] }

HELPERS=$ROOT/scripts/mac-scroll-bench
BIN=$OUT/bin
PASSWORD=sidebar-$RANDOM-$RANDOM
BUNDLE=com.danielou.portals.n4-sidebar
mkdir -p $OUT $BIN
swiftc -O $HELPERS/window.swift -o $BIN/window 2>/dev/null || { echo "could not build the window helper"; exit 1; }

log() { print -r -- "$(date +%T) $*" | tee -a $OUT/bench.log }

bridge_pid="" app_pid=""
cleanup() {
  [[ -n $app_pid ]] && kill $app_pid 2>/dev/null
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null
  defaults delete $BUNDLE >/dev/null 2>&1
  rm -f ~/Library/Preferences/$BUNDLE.plist
  rm -rf ~/Library/Saved\ Application\ State/$BUNDLE.savedState
}
trap cleanup EXIT INT TERM

start_bridge() {  # <home>
  node $ROOT/scripts/sidebar-bench/bridge.mts start $1 $PORT $THREADS $PASSWORD > $1.log 2>&1 &
  bridge_pid=$!
  for _ in {1..150}; do grep -q "listening on" $1.log 2>/dev/null && return 0; sleep 0.1; done
  echo "the bridge did not start"; return 1
}

stop_bridge() {
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null && wait $bridge_pid 2>/dev/null
  bridge_pid=""
}

launch_app() {  # <app copy> <home> <probe> <frames> [more --env switches]
  local hosts="[{\"name\":\"Scratch\",\"url\":\"http://127.0.0.1:$PORT\",\"user\":\"sidebar\",\"password\":\"$PASSWORD\"}]"
  local app=$1 home=$2 probe=$3 meter=$4; shift 4
  for attempt in 1 2 3; do
    # This launch's own notes only: what an earlier run left in the file would read as
    # this one's (host-listed, the fold presses).
    rm -f $probe
    open -g -n --env CFFIXED_USER_HOME=$home --env "PORTALS_DEBUG_HOSTS=$hosts" --env PORTALS_DEBUG_SIDEBAR_BENCH=1 \
      --env PORTALS_DEBUG_SIDEBAR_PROBE=$probe --env PORTALS_DEBUG_FRAMES=$meter "$@" $app
    for _ in {1..50}; do
      app_pid=$(pgrep -f "$app/Contents/MacOS/Portals" | head -1)
      [[ -n $app_pid ]] && break
      sleep 0.2
    done
    for _ in {1..100}; do grep -q "host-listed" $probe 2>/dev/null && break; sleep 0.2; done
    sleep 4
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
}

forget_app() {
  defaults delete $BUNDLE >/dev/null 2>&1
  rm -f ~/Library/Preferences/$BUNDLE.plist
  rm -rf ~/Library/Saved\ Application\ State/$BUNDLE.savedState
}

frames_mark() { wc -l < $frames | tr -d ' ' }
frames_since() {  # <mark>
  sleep 1.2
  local from=0
  (( $1 > 0 )) && from=$(sed -n "${1}p" $frames | cut -d' ' -f1)
  tail -n +$(( $1 + 1 )) $frames | python3 -I $HELPERS/frames.py $from
}

# Scrolls the sidebar up and down with the mouse wheel for <seconds>.
scroll_for() {  # <seconds>
  local shot sw sh
  shot=$(cua-driver call get_window_state "{\"pid\":$app_pid,\"window_id\":${window[1]},\"include_accessibility_tree\":false,\"max_dimension\":400,\"session\":\"sidebar-$app_pid\",\"screenshot_out_file\":\"$OUT/shot.png\"}" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d["screenshot_width"], d["screenshot_height"])')
  sw=${shot% *} sh=${shot#* }
  [[ -n $sw && -n $sh && $sw != $shot ]] || { log "  could not see the window to scroll it"; return 1; }
  # A point in the sidebar's list, below the groups on top.
  local x=$(( sw * 12 / 100 )) y=$(( sh * 70 / 100 ))
  local ends=$(( EPOCHREALTIME + $1 )) step=0 failed=0 answer
  while (( EPOCHREALTIME < ends )); do
    local direction=$([[ $(( step / 3 % 2 )) == 0 ]] && echo down || echo up)
    answer=$(cua-driver call scroll "{\"pid\":$app_pid,\"window_id\":${window[1]},\"x\":$x,\"y\":$y,\"direction\":\"$direction\",\"amount\":8,\"by\":\"line\",\"session\":\"sidebar-$app_pid\"}" 2>&1) || (( failed++ ))
    [[ $answer == *'"isError"'* || $answer == *refus* ]] && { (( failed++ )); print -r -- "$answer" >> $OUT/scroll-errors.log; }
    (( step++ ))
  done
  (( failed == 0 )) || { log "  $failed of $step scrolls failed"; return 1; }
}

profile_start() {  # <file>
  (( PROFILE )) || return 0
  xcrun xctrace record --template 'Time Profiler' --attach $app_pid --output $1 --time-limit 60s --no-prompt > $1.log 2>&1 &
  profiler=$!
  sleep 3
}
profile_stop() {
  (( PROFILE )) || return 0
  kill -INT $profiler 2>/dev/null; wait $profiler 2>/dev/null
}

fp() { footprint -p $app_pid 2>/dev/null | awk '/phys_footprint:/ { print $2 $3; exit }' }

# The last Show more or Show fewer the probe noted: show-more leaves every list whole.
last_fold() { awk '$2 == "show-more" || $2 == "show-fewer" { last = $2 } END { print last }' $1 }

median() { python3 -I -c 'import sys,statistics; v=[float(x) for x in sys.argv[1:]]; print(f"{statistics.median(v):.1f}" if v else "-")' "$@" }

run_one() {  # <label> <app> <tag> [--env NAME=value]
  local label=$1 app=$2 tag=$3 dir=$OUT/$3
  local switches=(${@:4})
  mkdir -p $dir
  local probe=$dir/probe.txt
  frames=$dir/frames.txt
  forget_app
  start_bridge $dir/bridge || return 1
  launch_app $app $dir/home $probe $frames $switches || { stop_bridge; return 1; }
  local load=$(uptime | sed 's/.*load averages*: //') result="$label" broken=0
  local ids=($(cat $dir/bridge/ids.txt))

  if wants fold; then
    profile_start $dir/fold.trace
    for i in $(seq 1 $FOLDS); do notifyutil -p com.danielou.portals.bench.fold; sleep 2.5; done
    profile_stop
    local more=($(awk '$2 == "show-more" { print $3 }' $probe)) fewer=($(awk '$2 == "show-fewer" { print $3 }' $probe))
    result+=" show_more_ms=$(median $more) show_fewer_ms=$(median $fewer) (n=${#more}/${#fewer})"
    # Each press is noted by the probe: one not noted was not measured.
    (( ${#more} + ${#fewer} == FOLDS )) || { result+=" FOLD-FAILED"; broken=1 }
  fi
  # Every list shown whole from here on: pressed once more only if the last press the
  # probe noted was not Show more (an even number of folds, or none), and the press
  # checked, so that a missed one does not leave the lists folded for what follows.
  if [[ $(last_fold $probe) != show-more ]]; then
    notifyutil -p com.danielou.portals.bench.fold; sleep 3
    [[ $(last_fold $probe) == show-more ]] || { result+=" EXPAND-FAILED"; broken=1 }
  fi
  if wants scroll; then
    profile_start $dir/scroll.trace
    local mark=$(frames_mark)
    # A scroll that failed measured a list at rest: no numbers for it.
    if scroll_for $SECONDS_REC; then
      result+=" scroll=[$(frames_since $mark)]"
    else
      result+=" scroll=FAILED"; broken=1
    fi
    profile_stop
  fi
  if wants turns; then
    profile_start $dir/turns.trace
    local mark=$(frames_mark) bad=0
    for i in $(seq 1 $TURNS); do
      node $ROOT/scripts/sidebar-bench/bridge.mts turn http://127.0.0.1:$PORT $PASSWORD ${ids[$(( i * 37 % THREADS + 1 ))]} >> $dir/turns.log 2>&1 || bad=$(( bad + 1 ))
      sleep 1
    done
    # A turn that did not run leaves the list at rest, which would read as faster.
    if (( bad == 0 )); then
      result+=" turns=[$(frames_since $mark)]"
    else
      result+=" turns=FAILED($bad of $TURNS, $dir/turns.log)"; broken=1
    fi
    profile_stop
  fi
  if wants renames; then
    local mark=$(frames_mark) bad=0
    for i in $(seq 1 $RENAMES); do
      node $ROOT/scripts/sidebar-bench/bridge.mts rename http://127.0.0.1:$PORT $PASSWORD ${ids[$(( i * 11 + 2 ))]} "Renamed $i at $(date +%T)" >> $dir/renames.log 2>&1 || bad=$(( bad + 1 ))
      sleep 1
    done
    if (( bad == 0 )); then
      result+=" renames=[$(frames_since $mark)]"
    else
      result+=" renames=FAILED($bad of $RENAMES, $dir/renames.log)"; broken=1
    fi
  fi
  local fp=$(footprint -p $app_pid 2>/dev/null | awk '/phys_footprint:/ { print $2 $3; exit }')
  result+=" footprint=$fp"
  quit_app
  if wants launch; then
    probe=$dir/probe-launch.txt
    sleep 1
    launch_app $app $dir/home $probe $frames $switches || { stop_bridge; return 1; }
    local at=$(awk '!($2 in at) { at[$2] = $1 } END { printf "app-init=%s fleet-made=%s first-row=%s host-listed=%s", at["app-init"], at["fleet-made"], at["sidebar-row"], at["host-listed"] }' $probe)
    result+=" launch_saved: $at row_from=$(awk '$2 == "sidebar-row" { print $3; exit }' $probe) footprint=$(fp)"
    quit_app
  fi
  if wants memory; then
    # The footprint once the list is in, after opening the 20 newest threads one after
    # another (the newest with a 20,000-character reply), and at rest after.
    probe=$dir/probe-memory.txt
    sleep 1
    launch_app $app $dir/home $probe $frames --env PORTALS_DEBUG_OPEN_EACH=20:0.5 $switches || { stop_bridge; return 1; }
    local at_launch=$(fp)
    sleep 14
    local opened=$(fp)
    sleep 20
    result+=" memory: launch=$at_launch after20=$opened rest=$(fp) peak=$(footprint -p $app_pid 2>/dev/null | awk '/phys_footprint_peak:/ { print $2 $3; exit }')"
    quit_app
  fi
  stop_bridge
  forget_app
  rm -rf $dir/home $dir/bridge
  log "$result load=[$load]"
  return $broken
}

log "sidebar bench: ${#APPS} apps, $ROUNDS rounds, $THREADS threads, out $OUT"
failures=0
for round in $(seq 1 $ROUNDS); do
  for entry in $APPS; do
    label=${entry%%=*} src=${entry#*=} extra=()
    # <label>=<app>@NAME=value: one more launch switch for this app (an experiment's).
    [[ $src == *@* ]] && { extra=(--env ${src#*@}); src=${src%%@*} }
    # The app itself, not a link to it: the copy is changed in place (its extension
    # removed, its bundle id set), which through a copied link would change the original.
    src=${src:A}
    [[ -d $src && $src == *.app ]] || { log "$src is not a built .app"; exit 2; }
    # A copy keeps the links in the app, and the parts changed in the copy must not be
    # links out of it.
    for part in Contents Contents/Info.plist Contents/PlugIns; do
      [[ -L $src/$part ]] && { log "$src/$part is a link: refused"; exit 2; }
    done
    copy=${OUT:A}/apps/$label/Portals.app
    [[ -L $copy || -L ${copy:h} ]] && { log "$copy is a link: refused"; exit 2; }
    # The copy is removed before it is made: never the app, nor anything in it or around it.
    [[ $copy == $src || $copy == $src/* || $src == $copy/* ]] && { log "$copy overlaps $src: refused"; exit 2; }
    if [[ ! -d $copy ]]; then
      mkdir -p ${copy:h}; $HELPERS/prepare-app.sh $src $copy $BUNDLE
      [[ -d $copy && ! -L $copy ]] || { log "could not make a copy of $src"; exit 2; }
    fi
    run_one $label $copy $label-r$round $extra || { log "$label round $round failed: its numbers are not to be used"; failures=$(( failures + 1 )) }
  done
done
log "done"
(( failures == 0 )) || { log "$failures runs failed"; exit 1; }
