#!/bin/zsh
# Measures the Mac app's new sidebar (a Mac's space, every folder listed) and its tabs:
# scrolling the space, switching tabs, the app at rest with tabs open, turns and titles
# from another device, the tab put back at launch, and stepping between two Macs'
# spaces (docs/perf-tabs.md). On scratch copies and scratch bridges, never the installed
# app or bridge.
#
#   scripts/tabs-bench.sh [options] <label>=<built .app> [<label>=<built .app> …]
#   (<label>=<built .app>@NAME=value[@NAME=value…] launches that one with more switches)
#
# Each app is a Release Mac Catalyst build with the launch switches compiled in
# (SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG, see scripts/mac-scroll-bench.sh). For every
# round, and every app in turn (A, B, A, B…), it:
#   1. starts a scratch bridge on PORT (9501) with THREADS threads (600) over five agents
#      and twelve folders, one in a hundred unseen (scripts/sidebar-bench/bridge.mts);
#   2. opens a scratch copy of the app in the background, which opens twelve threads as
#      tabs one after another (PORTALS_DEBUG_OPEN_PLAN): the newest (a reply of 20,000
#      characters), three of 20 turns, eight of one; with its frame meter
#      (PORTALS_DEBUG_FRAMES), the sidebar's probe and the open probe;
#   3. scroll: Show more on every folder (every thread of the space listed), then the
#      space scrolled up and down with the mouse wheel for SECONDS (cua-driver, in the
#      background): frames, and the app's CPU;
#   4. tabs: SWITCHES switches between the tabs, GAP s apart, made by the app as ⌃Tab,
#      ⌘1-9 and a click make them (PORTALS_DEBUG_TAB_SWITCHES, TabsBench.swift): for
#      each, the time until the main thread could draw again (tab_frame), until the chat
#      was on screen and drawn (drawn: the chat put on screen, then the next frame), and
#      until a frame showed its turns (content, the open probe); frames over them all, CPU
#      time per switch, and the footprint before and after;
#   5. turns: a turn in TURNS threads one after another, as another device would, and
#      renames: RENAMES titles changed from another device; frames meanwhile;
#   6. restore: quits and opens the copy again with the tab it left on screen (the long
#      one) put back (PORTALS_DEBUG_RESTORE_TABS): when the chat showed and was drawn after
#      the process started, and how long its saved copy took to read on the main thread;
#   7. idle, in that launch (no frame meter, no open probe, which wake the app): over IDLE
#      s at rest, then RUNNING s with turns running in three tabs not on screen, then
#      RUNNING s more with three others running and the window covered by another
#      (scripts/app-footprint/cover.swift): CPU, idle and interrupt wakeups a second
#      (proc_pid_rusage, scripts/tabs-bench/rusage.swift), and the footprint at rest;
#   3b. hover, only when asked for (--only …,hover) and allowed (HOVER_OK=1): Show more on
#      every folder, the copy brought to the front, then the REAL pointer moved up and down
#      over the space's list for HOVER_SECONDS (20) and put back (tabs-bench/pointer-sweep.swift):
#      frames and the app's CPU. It is the user's pointer, and the events go to whatever is
#      under it: run it only when the user allows it, with the screen unlocked;
#   8. spaces: a second scratch bridge on PORT2 (9502) as a second Mac, a launch with
#      both, and SPACE_STEPS steps from one space to the other and back, a second apart,
#      as ⌘⌥→/← and a click on a Mac's tab make them (PORTALS_DEBUG_SPACE_STEPS):
#      the time until the main thread could draw again, and frames.
# Each run writes one line of key=value numbers to OUT/results.txt, and the medians per
# app come at the end (scripts/tabs-bench/summary.py), with the load beside each run.
#
# With --profile, it also records Time Profiler (xctrace, kept under OUT) over the scroll,
# the switches and the turns running: such a run's numbers are not to be compared.
#
# Needs the gui lock (/private/tmp/portals-n10/scripts/lock.sh take gui <you>) while it
# runs, cua-driver, the bridge's node_modules, and the Mac awake with the copy's window on
# the Space in view (checked; it relaunches up to three times).
#
# Options: --rounds N (3), --threads N (600), --seconds S (15), --hover-seconds S (20), --switches N (42),
#          --gap S (0.7), --idle S (60), --running S (50), --turns N (6), --renames N (6),
#          --steps N (20), --profile, --only scroll,tabs,turns,renames,restore,idle,spaces[,hover]
#          [,tabsreturn,tabsfar,keptrun,sidebar]
#
# Besides: tabsreturn, SWITCHES switches back and forth between the last three tabs shown
# (keys ret_…), and tabsfar, SWITCHES switches each to the tab shown longest ago (far_…),
# in the first launch after tabs; keptrun, in the second launch after idle, three tabs
# shown one after another and the first again, then a turn in each of those three for
# RUNNING s: CPU and wakeups (keptrun_…) and the footprint (fp_primed_mb, fp_keptrun_mb);
# sidebar, after the tabs, the sidebar hidden and shown ten times, a second apart, as ⌘S
# does: frames while it slides (sidebar_…), CPU a toggle, the main thread after each.

set -uo pipefail
zmodload zsh/datetime
ROOT=${0:A:h:h}
PORT=${PORT:-9501}
PORT2=${PORT2:-9502}
OUT=${OUT:-/private/tmp/portals-n10/bench/tabs-$(date +%H%M%S)}
ROUNDS=3 THREADS=600 FOLDERS=12 SECONDS_REC=15 HOVER_SECONDS=20 SWITCHES=42 GAP=0.7 IDLE=60 RUNNING=50 TURNS=6 RENAMES=6 STEPS=20 PROFILE=0
ONLY=scroll,tabs,turns,renames,restore,idle,spaces
APPS=()
while (( $# )); do
  case $1 in
    --rounds) ROUNDS=$2; shift 2;;
    --threads) THREADS=$2; shift 2;;
    --seconds) SECONDS_REC=$2; shift 2;;
    --hover-seconds) HOVER_SECONDS=$2; shift 2;;
    --switches) SWITCHES=$2; shift 2;;
    --gap) GAP=$2; shift 2;;
    --idle) IDLE=$2; shift 2;;
    --running) RUNNING=$2; shift 2;;
    --turns) TURNS=$2; shift 2;;
    --renames) RENAMES=$2; shift 2;;
    --steps) STEPS=$2; shift 2;;
    --profile) PROFILE=1; shift;;
    --only) ONLY=$2; shift 2;;
    *=*) APPS+=($1); shift;;
    *) echo "unknown argument $1"; exit 2;;
  esac
done
(( ${#APPS} )) || { sed -n '2,/^$/p' $0; exit 2; }
wants() { [[ ",$ONLY," == *",$1,"* ]] }

HELPERS=$ROOT/scripts/mac-scroll-bench
MINE=$ROOT/scripts/tabs-bench
BIN=$OUT/bin
PASSWORD=tabs-$RANDOM-$RANDOM
BUNDLE=com.danielou.portals.n10-tabs
mkdir -p $OUT $BIN
swiftc -O $HELPERS/window.swift -o $BIN/window 2>/dev/null || { echo "could not build the window helper"; exit 1; }
swiftc -O $MINE/rusage.swift -o $BIN/rusage 2>/dev/null || { echo "could not build the rusage helper"; exit 1; }
swiftc -O $ROOT/scripts/app-footprint/cover.swift -o $BIN/cover 2>/dev/null || { echo "could not build the cover helper"; exit 1; }
if wants hover; then
  swiftc -O $MINE/pointer-sweep.swift -o $BIN/pointer-sweep 2>/dev/null || { echo "could not build the pointer helper"; exit 1; }
fi

log() { print -r -- "$(date +%T) $*" | tee -a $OUT/bench.log }

bridge_pid="" bridge2_pid="" app_pid="" cover_pid="" turners=()
cleanup() {
  [[ -n $app_pid ]] && kill $app_pid 2>/dev/null
  [[ -n $cover_pid ]] && kill $cover_pid 2>/dev/null
  (( ${#turners} )) && kill $turners 2>/dev/null
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null
  [[ -n $bridge2_pid ]] && kill $bridge2_pid 2>/dev/null
  forget_app
}
trap cleanup EXIT INT TERM

forget_app() {
  defaults delete $BUNDLE >/dev/null 2>&1
  rm -f ~/Library/Preferences/$BUNDLE.plist
  rm -rf ~/Library/Saved\ Application\ State/$BUNDLE.savedState
}

start_bridge() {  # <home> <port> <threads>; sets bridge_pid (or bridge2_pid for PORT2)
  node $ROOT/scripts/sidebar-bench/bridge.mts start $1 $2 $3 $PASSWORD 5 $FOLDERS 100 > $1.log 2>&1 &
  if [[ $2 == $PORT ]]; then bridge_pid=$!; else bridge2_pid=$!; fi
  for _ in {1..200}; do grep -q "listening on" $1.log 2>/dev/null && return 0; sleep 0.1; done
  echo "the bridge did not start"; return 1
}

stop_bridges() {
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null && wait $bridge_pid 2>/dev/null
  [[ -n $bridge2_pid ]] && kill $bridge2_pid 2>/dev/null && wait $bridge2_pid 2>/dev/null
  bridge_pid="" bridge2_pid=""
}

hosts_json() {  # [two]
  local one="{\"name\":\"Scratch\",\"url\":\"http://127.0.0.1:$PORT\",\"user\":\"sidebar\",\"password\":\"$PASSWORD\"}"
  if [[ ${1:-} == two ]]; then
    print -r -- "[$one,{\"name\":\"Second\",\"url\":\"http://127.0.0.1:$PORT2\",\"user\":\"sidebar\",\"password\":\"$PASSWORD\"}]"
  else
    print -r -- "[$one]"
  fi
}

launch_app() {  # <app copy> <home> <probe> <wait for event> <hosts json> [more --env switches]
  local app=$1 home=$2 probe=$3 event=$4 hosts=$5; shift 5
  # The copy launched is found by its path: one already running there (left by a bench
  # stopped part way) would be the one measured, its CPU and wakeups read for this one's.
  local before
  for _ in {1..25}; do before=$(pgrep -f "$app/Contents/MacOS/Portals" | head -1); [[ -z $before ]] && break; sleep 0.2; done
  [[ -z $before ]] || { log "a copy at $app already runs (pid $before): quit it first, or its numbers would be read for this one's"; return 1; }
  for attempt in 1 2 3; do
    rm -f $probe
    open -g -n --env CFFIXED_USER_HOME=$home --env "PORTALS_DEBUG_HOSTS=$hosts" \
      --env PORTALS_DEBUG_SIDEBAR_PROBE=$probe --env PORTALS_DEBUG_TABS_FILE=$home-tabs.json "$@" $app
    for _ in {1..50}; do
      app_pid=$(pgrep -f "$app/Contents/MacOS/Portals" | head -1)
      [[ -n $app_pid ]] && break
      sleep 0.2
    done
    for _ in {1..300}; do grep -q " $event" $probe 2>/dev/null && break; sleep 0.2; done
    sleep 3
    window=($($BIN/window $app_pid 2>/dev/null))
    (( ${#window} == 5 )) && grep -q " $event" $probe 2>/dev/null && return 0
    log "window not on the Space in view, or no $event (attempt $attempt): relaunching"
    kill $app_pid 2>/dev/null; sleep 2
  done
  return 1
}

quit_app() {
  [[ -n $app_pid ]] && kill $app_pid 2>/dev/null
  for _ in {1..40}; do kill -0 $app_pid 2>/dev/null || break; sleep 0.2; done
  app_pid=""
}

usage_now() { $BIN/rusage $app_pid }  # "<cpu ms> <idle wakeups> <interrupt wakeups> <footprint MB> <instructions M>"
# CPU % of a core, idle and interrupt wakeups a second, between two usage_now lines over <seconds>.
usage_rate() {  # <before> <after> <seconds>
  python3 -I -c 'import sys
a = [float(x) for x in sys.argv[1].split()]; b = [float(x) for x in sys.argv[2].split()]; s = float(sys.argv[3])
print(f"{(b[0] - a[0]) / s / 10:.2f} {(b[1] - a[1]) / s:.1f} {(b[2] - a[2]) / s:.1f}")' "$1" "$2" "$3"
}
fp() { $BIN/rusage $app_pid | awk '{ print $4 }' }

frames_mark() { wc -l < $frames | tr -d ' ' }
frames_since() {  # <mark>: "<hitch ms/s> <hitches/s> <fps> <longest ms>"
  sleep 1.2
  local from=0
  (( $1 > 0 )) && from=$(sed -n "${1}p" $frames | cut -d' ' -f1)
  tail -n +$(( $1 + 1 )) $frames | python3 -I $HELPERS/frames.py $from
}
# key=value pairs from a frames line, prefixed.
frames_kv() {  # <prefix> <frames line>
  local f=(${=2})
  print -r -- "$1_hitch_ms_s=${f[1]} $1_hitches_s=${f[2]} $1_fps=${f[3]} $1_longest_ms=${f[4]}"
}

# Scrolls the space's list up and down with the mouse wheel for <seconds>.
scroll_for() {  # <seconds>
  local shot sw sh
  shot=$(cua-driver call get_window_state "{\"pid\":$app_pid,\"window_id\":${window[1]},\"include_accessibility_tree\":false,\"max_dimension\":400,\"session\":\"tabs-$app_pid\",\"screenshot_out_file\":\"$OUT/shot.png\"}" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d["screenshot_width"], d["screenshot_height"])')
  sw=${shot% *} sh=${shot#* }
  [[ -n $sw && -n $sh && $sw != $shot ]] || { log "  could not see the window to scroll it"; return 1; }
  # A point in the space's list, below the groups on top and the Macs' tabs.
  local x=$(( sw * 12 / 100 )) y=$(( sh * 78 / 100 ))
  local ends=$(( EPOCHREALTIME + $1 )) step=0 failed=0 answer
  while (( EPOCHREALTIME < ends )); do
    local direction=$([[ $(( step / 3 % 2 )) == 0 ]] && echo down || echo up)
    answer=$(cua-driver call scroll "{\"pid\":$app_pid,\"window_id\":${window[1]},\"x\":$x,\"y\":$y,\"direction\":\"$direction\",\"amount\":8,\"by\":\"line\",\"session\":\"tabs-$app_pid\"}" 2>&1) || (( failed++ ))
    [[ $answer == *'"isError"'* || $answer == *refus* ]] && { (( failed++ )); print -r -- "$answer" >> $OUT/scroll-errors.log; }
    (( step++ ))
  done
  (( failed == 0 )) || { log "  $failed of $step scrolls failed"; return 1; }
}

profile_start() {  # <file> <seconds>
  (( PROFILE )) || return 0
  xcrun xctrace record --template "${PROFILE_TEMPLATE:-Time Profiler}" --attach $app_pid --output $1 --time-limit ${2}s --no-prompt > $1.log 2>&1 &
  profiler=$!
  sleep 3
}
profile_stop() {
  (( PROFILE )) || return 0
  kill -INT $profiler 2>/dev/null; wait $profiler 2>/dev/null
}

# As wait_for, for an <event> noted past the probe's first <lines> lines.
wait_for_after() {  # <probe> <lines> <event> <seconds>
  local ends=$(( EPOCHREALTIME + $4 ))
  while (( EPOCHREALTIME < ends )); do
    tail -n +$(( $2 + 1 )) $1 2>/dev/null | grep -q " $3" && return 0
    sleep 0.25
  done
  return 1
}

wait_for() {  # <probe> <event> <seconds>: true once the probe has noted <event>
  local ends=$(( EPOCHREALTIME + $3 ))
  while (( EPOCHREALTIME < ends )); do
    grep -q " $2" $1 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# Turns started as another device would, in the background; their pids in `turners`.
start_turns() {  # <prompt> <thread> [<thread> …]
  local prompt=$1; shift
  turners=()
  for thread in "$@"; do
    node $ROOT/scripts/sidebar-bench/bridge.mts turn http://127.0.0.1:$PORT $PASSWORD $thread "$prompt" >> $dir/turns-bg.log 2>&1 &
    turners+=($!)
  done
}
# The turn command gives up waiting after 60 s (bridge/scripts/bench/device.ts), before a
# `bench` reply (a little over a minute) ends: the turn goes on in the bridge regardless,
# so its failing to wait is no failure (running.png shows the turns under Running), and
# a little time is left after for it to end.
wait_turns() {
  for pid in $turners; do wait $pid 2>/dev/null; done
  turners=()
  sleep 10
}

run_one() {  # <label> <app> <tag> [--env NAME=value]
  local label=$1 app=$2 tag=$3 dir=$OUT/$3
  local switches=(${@:4})
  mkdir -p $dir
  local probe=$dir/probe.txt open=$dir/open.jsonl
  frames=$dir/frames.txt
  forget_app
  start_bridge $dir/bridge $PORT $THREADS || return 1
  local ids=($(cat $dir/bridge/ids.txt))
  # The tabs: the newest (the long reply), three of 20 turns (one in forty), short ones.
  local tab_ids=(${ids[1]} ${ids[8]} ${ids[48]} ${ids[88]} ${ids[2]} ${ids[3]} ${ids[4]} ${ids[6]} ${ids[7]} ${ids[9]} ${ids[10]} ${ids[11]})
  local result="label=$label round=${tag##*-r} threads=$THREADS" broken=0
  local load=$(uptime | sed 's/.*load averages*: //')
  local main_wanted=0
  # keptrun needs the tabs this launch opens.
  for s in scroll hover tabs tabsreturn tabsfar sidebar turns renames keptrun; do wants $s && main_wanted=1; done

  if (( main_wanted )) || wants restore || wants idle; then
    launch_app $app $dir/home $probe open-plan-done "$(hosts_json)" \
      --env PORTALS_DEBUG_SIDEBAR_BENCH=1 --env PORTALS_DEBUG_FRAMES=$frames --env PORTALS_DEBUG_OPEN_PROBE=$open \
      --env "PORTALS_DEBUG_OPEN_PLAN=${(j:,:)tab_ids}:0.6" --env PORTALS_DEBUG_TAB_SWITCHES=$SWITCHES:$GAP $switches \
      || { stop_bridges; return 1; }
    screencapture -x -o -l ${window[1]} $dir/opened.png 2>/dev/null
    result+=" fp_tabs_opened_mb=$(fp)"

    if wants scroll; then
      notifyutil -p com.danielou.portals.bench.fold
      wait_for $probe show-more 10 || { result+=" EXPAND-FAILED"; broken=1 }
      sleep 2
      screencapture -x -o -l ${window[1]} $dir/scroll-before.png 2>/dev/null
      profile_start $dir/scroll.trace $(( SECONDS_REC + 6 ))
      local mark=$(frames_mark) u0=$(usage_now) t0=$EPOCHREALTIME
      if scroll_for $SECONDS_REC; then
        local u1=$(usage_now) t1=$EPOCHREALTIME
        local rate=(${=$(usage_rate "$u0" "$u1" $(( t1 - t0 )))})
        result+=" $(frames_kv scroll "$(frames_since $mark)") scroll_cpu_pct=${rate[1]}"
      else
        result+=" scroll=FAILED"; broken=1
      fi
      profile_stop
      screencapture -x -o -l ${window[1]} $dir/scroll-after.png 2>/dev/null
      # Back to three threads a folder, as the app opens, for what follows.
      notifyutil -p com.danielou.portals.bench.fold
      wait_for $probe show-fewer 10
      sleep 2
    fi

    if wants hover; then
      if [[ ${HOVER_OK:-} != 1 ]]; then
        log "  hover not run: it moves the real pointer (HOVER_OK=1 once the user allows it)"
        result+=" hover=SKIPPED"
      elif ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked | grep -q true; then
        log "  hover not run: the screen is locked"
        result+=" hover=LOCKED"; broken=1
      else
        notifyutil -p com.danielou.portals.bench.fold
        wait_for $probe show-more 10 || { result+=" EXPAND-FAILED"; broken=1 }
        sleep 2
        # In front, so that the pointer is over the copy's window and its events are the
        # copy's; nothing is moved unless it is.
        osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $app_pid) to true" >/dev/null 2>&1
        sleep 1
        local front=$(lsappinfo info -only pid "$(lsappinfo front)" 2>/dev/null | sed 's/.*=//')
        window=($($BIN/window $app_pid 2>/dev/null))
        if [[ $front != $app_pid || ${#window} != 5 ]]; then
          log "  hover not run: the copy did not come to the front (the front app's pid is $front)"
          result+=" hover=NOT-FRONT"; broken=1
        else
          # The space's list, within the sidebar, below the groups on top and the Macs' tabs.
          local hx=$(( window[2] + 30 )) hy=$(( window[3] + window[5] * 55 / 100 )) hh=$(( window[5] * 38 / 100 ))
          screencapture -x -o -l ${window[1]} $dir/hover-before.png 2>/dev/null
          profile_start $dir/hover.trace $(( HOVER_SECONDS + 6 ))
          local mark=$(frames_mark) u0=$(usage_now) t0=$EPOCHREALTIME
          local moves=$($BIN/pointer-sweep $hx $hy 300 $hh $HOVER_SECONDS)
          local u1=$(usage_now) t1=$EPOCHREALTIME
          local rate=(${=$(usage_rate "$u0" "$u1" $(( t1 - t0 )))})
          result+=" $(frames_kv hover "$(frames_since $mark)") hover_cpu_pct=${rate[1]} hover_moves=$moves"
          profile_stop
        fi
        notifyutil -p com.danielou.portals.bench.fold
        wait_for $probe show-fewer 10
        sleep 2
      fi
    fi

    # tabs: the mixed switches; tabsreturn: back and forth between the last three tabs
    # shown; tabsfar: each to the tab shown longest ago (TabsBench.swift).
    for kind in tabs tabsreturn tabsfar; do
      wants $kind || continue
      local prefix=${${kind#tabs}:-tabs} note=com.danielou.portals.bench.tabs
      [[ $kind != tabs ]] && note=$note.${kind#tabs}
      [[ $prefix == return ]] && prefix=ret
      sleep 2
      local before_fp=$(fp) opened=$(wc -l < $open 2>/dev/null | tr -d ' ') probe_from=$(wc -l < $probe | tr -d ' ')
      profile_start $dir/$kind.trace $(( SWITCHES * 1 + 10 ))
      local mark=$(frames_mark) u0=$(usage_now) t0=$EPOCHREALTIME
      notifyutil -p $note
      if wait_for_after $probe $probe_from tab-switches-done $(( SWITCHES * 2 + 30 )); then
        local u1=$(usage_now) t1=$EPOCHREALTIME
        local switching=$(frames_since $mark)
        profile_stop
        sleep 5
        local cpu_per=$(python3 -I -c 'import sys; a=float(sys.argv[1].split()[0]); b=float(sys.argv[2].split()[0]); print(f"{(b-a)/int(sys.argv[3]):.1f}")' "$u0" "$u1" $(( SWITCHES + 1 )))
        local kv="$(frames_kv tabs "$switching") tabs_cpu_ms_per_switch=$cpu_per"
        kv+=" $(tail -n +$(( probe_from + 1 )) $probe | python3 -I $MINE/switches.py $open $opened)"
        kv+=" fp_tabs_before_mb=$before_fp fp_tabs_after_mb=$(fp)"
        # The mixed switches' keys as they always were; the others' with their own prefix.
        [[ $prefix != tabs ]] && kv=$(print -r -- "$kv" | python3 -I -c 'import sys
p = sys.argv[1]
print(" ".join(p + "_" + w for w in sys.stdin.read().split()))' $prefix)
        result+=" $kv"
      else
        profile_stop
        result+=" $kind=FAILED"; broken=1
      fi
      screencapture -x -o -l ${window[1]} $dir/$kind-after.png 2>/dev/null
    done

    if wants sidebar; then
      # The sidebar hidden and shown ten times, a second apart, as ⌘S does: the chat (and
      # every chat kept built behind it) changes width as the sidebar slides.
      sleep 2
      local probe_from=$(wc -l < $probe | tr -d ' ')
      profile_start $dir/sidebar.trace 16
      local mark=$(frames_mark) u0=$(usage_now)
      notifyutil -p com.danielou.portals.bench.sidebar
      if wait_for_after $probe $probe_from sidebar-toggles-done 30; then
        local u1=$(usage_now)
        result+=" $(frames_kv sidebar "$(frames_since $mark)")"
        result+=" sidebar_cpu_ms_per_toggle=$(python3 -I -c 'import sys; a=float(sys.argv[1].split()[0]); b=float(sys.argv[2].split()[0]); print(f"{(b-a)/10:.1f}")' "$u0" "$u1")"
        result+=" $(tail -n +$(( probe_from + 1 )) $probe | awk '$2 == "sidebar-frame" { print $3 }' | python3 -I -c 'import sys, statistics
v = sorted(float(x) for x in sys.stdin.read().split())
print(f"sidebar_frame_ms={statistics.median(v):.1f} sidebar_frame_max_ms={v[-1]:.1f}" if v else "sidebar_frame_ms=-")')"
      else
        result+=" sidebar=FAILED"; broken=1
      fi
      profile_stop
    fi

    if wants turns; then
      local mark=$(frames_mark) bad=0
      for i in $(seq 1 $TURNS); do
        node $ROOT/scripts/sidebar-bench/bridge.mts turn http://127.0.0.1:$PORT $PASSWORD ${ids[$(( i * 37 % THREADS + 1 ))]} >> $dir/turns.log 2>&1 || bad=$(( bad + 1 ))
        sleep 1
      done
      if (( bad == 0 )); then
        result+=" $(frames_kv turns "$(frames_since $mark)")"
      else
        result+=" turns=FAILED"; broken=1
      fi
    fi
    if wants renames; then
      local mark=$(frames_mark) bad=0
      for i in $(seq 1 $RENAMES); do
        node $ROOT/scripts/sidebar-bench/bridge.mts rename http://127.0.0.1:$PORT $PASSWORD ${ids[$(( i * 11 + 2 ))]} "Renamed $i at $(date +%T)" >> $dir/renames.log 2>&1 || bad=$(( bad + 1 ))
        sleep 1
      done
      if (( bad == 0 )); then
        result+=" $(frames_kv renames "$(frames_since $mark)")"
      else
        result+=" renames=FAILED"; broken=1
      fi
    fi
    quit_app
  fi

  if wants restore || wants idle || wants keptrun; then
    probe=$dir/probe-restore.txt
    sleep 1
    local listens=()
    wants keptrun && listens=(--env PORTALS_DEBUG_TAB_SWITCHES=$SWITCHES:$GAP)
    launch_app $app $dir/home $probe host-listed "$(hosts_json)" --env PORTALS_DEBUG_RESTORE_TABS=1 $listens $switches \
      || { stop_bridges; return 1; }
    screencapture -x -o -l ${window[1]} $dir/restored.png 2>/dev/null
    if wants restore; then
      result+=" $(awk '
        !($2 in at) { at[$2] = $1; detail[$2] = $3 }
        END { printf "restore_chat_shown_ms=%s restore_chat_drawn_ms=%.1f restore_read_ms=%s restore_turns=%s restore_first_row_ms=%s restore_host_listed_ms=%s",
          at["chat-shown"], at["chat-drawn"], detail["thread-read"], detail["chat-shown"], at["sidebar-row"], at["host-listed"] }' $probe)"
    fi
    if wants idle; then
      sleep 5
      # At rest: the tabs open, the sidebar out, nothing running.
      local u0=$(usage_now) t0=$EPOCHREALTIME
      sleep $IDLE
      local u1=$(usage_now) t1=$EPOCHREALTIME
      local rate=(${=$(usage_rate "$u0" "$u1" $(( t1 - t0 )))})
      result+=" idle_cpu_pct=${rate[1]} idle_wakeups_s=${rate[2]} idle_intr_wakeups_s=${rate[3]} fp_rest_mb=$(fp)"
      # Turns running in three tabs not on screen: their spinners on the tabs and in Running.
      start_turns "bench please" ${tab_ids[2]} ${tab_ids[3]} ${tab_ids[4]}
      sleep 4
      profile_start $dir/running.trace $(( RUNNING + 4 ))
      u0=$(usage_now) t0=$EPOCHREALTIME
      sleep $RUNNING
      u1=$(usage_now) t1=$EPOCHREALTIME
      profile_stop
      screencapture -x -o -l ${window[1]} $dir/running.png 2>/dev/null
      rate=(${=$(usage_rate "$u0" "$u1" $(( t1 - t0 )))})
      result+=" running_cpu_pct=${rate[1]} running_wakeups_s=${rate[2]} running_intr_wakeups_s=${rate[3]}"
      wait_turns
      # The same with the window covered by another, that takes no clicks.
      sleep 2
      start_turns "bench please" ${tab_ids[5]} ${tab_ids[6]} ${tab_ids[7]}
      $BIN/cover ${window[2]} ${window[3]} ${window[4]} ${window[5]} $(( RUNNING + 8 )) &
      cover_pid=$!
      sleep 4
      u0=$(usage_now) t0=$EPOCHREALTIME
      sleep $RUNNING
      u1=$(usage_now) t1=$EPOCHREALTIME
      rate=(${=$(usage_rate "$u0" "$u1" $(( t1 - t0 )))})
      result+=" covered_cpu_pct=${rate[1]} covered_wakeups_s=${rate[2]} covered_intr_wakeups_s=${rate[3]}"
      wait $cover_pid 2>/dev/null; cover_pid=""
      wait_turns
      # Still there after being covered (not dropped as a window out of sight would be).
      kill -0 $app_pid 2>/dev/null || { result+=" APP-GONE"; broken=1 }
    fi
    if wants keptrun; then
      # Turns running in three tabs shown a moment ago and not on screen now: what such
      # a chat costs while it is not seen (its chat kept built, or not).
      sleep 2
      local primed_from=$(wc -l < $probe | tr -d ' ')
      notifyutil -p com.danielou.portals.bench.tabs.prime
      local primed=()
      if wait_for_after $probe $primed_from tabs-primed 20; then
        primed=(${(s:,:)$(tail -n +$(( primed_from + 1 )) $probe | awk '$2 == "tabs-primed" { print $3 }' | tail -1)})
      fi
      if (( ${#primed} == 3 )); then
        sleep 3
        local fp_primed=$(fp)
        start_turns "bench please" $primed
        sleep 4
        profile_start $dir/keptrun.trace $(( RUNNING + 4 ))
        local u0=$(usage_now) t0=$EPOCHREALTIME
        sleep $RUNNING
        local u1=$(usage_now) t1=$EPOCHREALTIME
        profile_stop
        screencapture -x -o -l ${window[1]} $dir/keptrun.png 2>/dev/null
        local rate=(${=$(usage_rate "$u0" "$u1" $(( t1 - t0 )))})
        result+=" keptrun_cpu_pct=${rate[1]} keptrun_wakeups_s=${rate[2]} keptrun_intr_wakeups_s=${rate[3]} fp_primed_mb=$fp_primed fp_keptrun_mb=$(fp)"
        wait_turns
      else
        result+=" keptrun=FAILED"; broken=1
      fi
    fi
    quit_app
  fi
  stop_bridges

  if wants spaces; then
    probe=$dir/probe-spaces.txt
    rm -rf $dir/bridge $dir/home
    start_bridge $dir/bridge $PORT $THREADS || return 1
    start_bridge $dir/bridge2 $PORT2 $THREADS || { stop_bridges; return 1; }
    forget_app
    launch_app $app $dir/home-spaces $probe host-listed "$(hosts_json two)" \
      --env PORTALS_DEBUG_SIDEBAR_BENCH=1 --env PORTALS_DEBUG_FRAMES=$frames --env PORTALS_DEBUG_SPACE_STEPS=$STEPS:1 $switches \
      || { stop_bridges; return 1; }
    sleep 4
    screencapture -x -o -l ${window[1]} $dir/spaces.png 2>/dev/null
    local mark=$(frames_mark) probe_from=$(wc -l < $probe | tr -d ' ')
    notifyutil -p com.danielou.portals.bench.spaces
    if wait_for $probe space-steps-done $(( STEPS * 2 + 20 )); then
      result+=" $(frames_kv spaces "$(frames_since $mark)")"
      result+=" $(tail -n +$(( probe_from + 1 )) $probe | awk '$2 == "space-frame" { print $3 }' | python3 -I -c 'import sys, statistics
v = sorted(float(x) for x in sys.stdin.read().split())
print(f"space_frame_ms={statistics.median(v):.1f} space_frame_max_ms={v[-1]:.1f} space_steps={len(v)}" if v else "space_frame_ms=-")')"
    else
      result+=" spaces=FAILED"; broken=1
    fi
    quit_app
    stop_bridges
  fi

  forget_app
  rm -rf $dir/home $dir/home-spaces $dir/bridge $dir/bridge2 $dir/home-tabs.json $dir/home-spaces-tabs.json
  result+=" load1=${load%% *}"
  print -r -- "$result" >> $OUT/results.txt
  log "$result load=[$load]"
  return $broken
}

log "tabs bench: ${#APPS} apps, $ROUNDS rounds, $THREADS threads, only $ONLY, out $OUT"
failures=0
for round in $(seq 1 $ROUNDS); do
  for entry in $APPS; do
    label=${entry%%=*} src=${entry#*=} extra=()
    if [[ $src == *@* ]]; then
      for given in ${(s:@:)${src#*@}}; do extra+=(--env $given); done
      src=${src%%@*}
    fi
    src=${src:A}
    [[ -d $src && $src == *.app ]] || { log "$src is not a built .app"; exit 2; }
    for part in Contents Contents/Info.plist Contents/PlugIns; do
      [[ -L $src/$part ]] && { log "$src/$part is a link: refused"; exit 2; }
    done
    copy=${OUT:A}/apps/$label/Portals.app
    [[ -L $copy || -L ${copy:h} ]] && { log "$copy is a link: refused"; exit 2; }
    [[ $copy == $src || $copy == $src/* || $src == $copy/* ]] && { log "$copy overlaps $src: refused"; exit 2; }
    if [[ ! -d $copy ]]; then
      mkdir -p ${copy:h}; $HELPERS/prepare-app.sh $src $copy $BUNDLE
      [[ -d $copy && ! -L $copy ]] || { log "could not make a copy of $src"; exit 2; }
    fi
    run_one $label $copy $label-r$round $extra || { log "$label round $round failed: its numbers are not to be used"; failures=$(( failures + 1 )) }
  done
done
python3 -I $MINE/summary.py $OUT/results.txt | tee -a $OUT/bench.log
log "done"
(( failures == 0 )) || { log "$failures runs failed"; exit 1; }
