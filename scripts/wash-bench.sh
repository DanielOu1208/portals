#!/bin/zsh
# Measures what the wash (the background animation, AmbientGradient.swift) costs.
#
#   scripts/wash-bench.sh [options] <label>=<built .app> [<label>=<built .app> …]
#
# Each app is a Release build made with the launch switches compiled in (they are read
# only when DEBUG is set, which changes nothing else in the app):
#
#   xcodebuild -project Portals.xcodeproj -scheme Portals -configuration Release \
#     -destination 'generic/platform=macOS,variant=Mac Catalyst' -derivedDataPath <dd> \
#     CODE_SIGNING_ALLOWED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
#     SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG build
#
# (with --sim, an iOS simulator build: -destination 'platform=iOS Simulator,id=<udid>').
#
# For every round, every state, every window size and every app in turn (A, B, A, B…,
# so that whatever else the Mac is doing falls on both alike), it starts the app with
# the scripted backend in the app (PORTALS_FAKE: no bridge, no host), lets it settle,
# and then over SECONDS s measures:
#   - the app's CPU (its own CPU time, ps), as % of a core;
#   - the render server's: WindowServer on the Mac, the simulator's backboardd with
#     --sim (relative only: a simulator is not a phone);
#   - the energy top reports for both (top's POWER, no sudo needed);
#   - the frames the wash drew a second and the milliseconds its own drawing took
#     (WashMeter, PORTALS_DEBUG_WASH_FRAMES; 0 ms where SwiftUI draws it);
#   - the app's memory at the end (footprint's phys_footprint);
#   - the load average.
# States (--states, comma-separated):
#   still        the wash at rest (nothing going on)
#   drift        the wash drifting with nothing else changing (PORTALS_DEBUG_WASH=working)
#   listen       the wash swelling to a made-up voice (PORTALS_DEBUG_WASH=listening)
#   stream       the fake agent streams its markdown reply, slowed to last about 20 s
#                (a piece every 150 ms), the wash drifting; measured from 4 s
#   stream-calm  the same with the wash held still (PORTALS_DEBUG_WASH=calm): the
#                difference to `stream` is the wash's share while a reply streams
# Window sizes on the Mac (--sizes): large (the whole screen but the menu bar), small
# (800 × 700 points); the simulator has one.
#
# It prints a line per run and the medians per app, state and size; everything is kept
# under OUT. The copies are scratch copies (bundle id com.danielou.portals.n4-wash, no
# extensions, no URL types; on the Mac in a scratch home), never the installed app.
#
# Needs: the gui lock while it runs on the Mac (sim lock with --sim), cua-driver (to
# size the window, in the background: the pointer does not move), an awake, unlocked
# Mac with the app's window on the Space in view (checked; relaunched up to 3 times).
#
# Options:
#   --rounds N      rounds (default 3)
#   --seconds S     seconds measured per run (default 12)
#   --settle S      seconds after launch before measuring (default 6)
#   --states LIST   default still,drift,listen,stream,stream-calm
#   --sizes LIST    default large,small
#   --sim UDID      run on that iOS simulator instead of the Mac
#   --out DIR       where to keep everything (default /private/tmp/portals-n4/bench/wash/run-<time>)
#   --env L:N=V     one more launch switch for the app labelled L (repeatable), e.g.
#                   --env full:PORTALS_DEBUG_WASH_PIXELS=0 with full=<the same .app>

set -uo pipefail
zmodload zsh/datetime
ROOT=${0:A:h:h}
ROUNDS=3 SECS=12 SETTLE=6 STATES=still,drift,listen,stream,stream-calm SIZES=large,small SIM="" OUT=""
APPS=()
typeset -A EXTRA
while (( $# )); do
  case $1 in
    --rounds) ROUNDS=$2; shift 2;;
    --seconds) SECS=$2; shift 2;;
    --settle) SETTLE=$2; shift 2;;
    --states) STATES=$2; shift 2;;
    --sizes) SIZES=$2; shift 2;;
    --sim) SIM=$2; shift 2;;
    --out) OUT=$2; shift 2;;
    --env) EXTRA[${2%%:*}]="${EXTRA[${2%%:*}]:-} ${2#*:}"; shift 2;;
    *=*) APPS+=($1); shift;;
    *) echo "unknown argument $1"; exit 2;;
  esac
done
(( ${#APPS} )) || { sed -n '2,/^$/p' $0; exit 2; }
OUT=${OUT:-/private/tmp/portals-n4/bench/wash/run-$(date +%H%M%S)}
# Everything it makes and removes is under OUT, which must be a new or bench-made folder
# under /private/tmp by its real path: the clean-up removes OUT/home and OUT/apps.
case $OUT in *..*) echo "refused: $OUT has a .. in it"; exit 1;; /private/tmp/?*|/tmp/?*) ;; *) echo "refused: OUT must be under /private/tmp"; exit 1;; esac
mkdir -p $OUT || exit 1
OUT=${OUT:A}
[[ $OUT == /private/tmp/?* && -d $OUT && ! -L $OUT ]] || { echo "refused: $OUT leads out of /private/tmp"; exit 1; }
# Nor may anything it writes into or removes there be a link (to an installed app, say).
for child in apps home bin runs results.tsv bench.log size.json sizes.log; do
  [[ -L $OUT/$child ]] && { echo "refused: $OUT/$child is a link"; exit 1; }
done
for child in $OUT/apps/*(N@) $OUT/runs/*(N@) $OUT/bin/*(N@); do
  echo "refused: $child is a link"; exit 1
done
[[ -n $SIM ]] && SIZES=phone
BUNDLE=com.danielou.portals.n4-wash
SIM_BUNDLE=$BUNDLE
mkdir -p $OUT/bin $OUT/runs
swiftc -O $ROOT/scripts/mac-scroll-bench/window.swift -o $OUT/bin/window 2>/dev/null || { echo "could not build the window helper"; exit 1; }

log() { print -r -- "$(date +%T) $*" | tee -a $OUT/bench.log }

app_pid=""
cleanup() {
  if [[ -n $SIM ]]; then
    xcrun simctl terminate $SIM $SIM_BUNDLE >/dev/null 2>&1
    xcrun simctl uninstall $SIM $SIM_BUNDLE >/dev/null 2>&1
  else
    [[ -n $app_pid ]] && kill $app_pid 2>/dev/null
    defaults delete $BUNDLE >/dev/null 2>&1
    rm -f ~/Library/Preferences/$BUNDLE.plist
    rm -rf ~/Library/Saved\ Application\ State/$BUNDLE.savedState
    rm -rf $OUT/home
  fi
}
trap cleanup EXIT INT TERM

# A scratch copy of each Mac app: its own bundle id, no extensions, no URL types.
typeset -A COPY
for pair in $APPS; do
  label=${pair%%=*} src=${pair#*=}
  [[ $label =~ '^[A-Za-z0-9_-]+$' ]] || { echo "refused: the label $label is not a plain name"; exit 1; }
  src=${src:A}
  case $src in /Applications/*|$HOME/Applications/*) echo "refused: $src is an installed app"; exit 1;; esac
  rm -rf $OUT/apps/$label.app; mkdir -p $OUT/apps
  cp -R $src $OUT/apps/$label.app
  if [[ -n $SIM ]]; then
    rm -rf $OUT/apps/$label.app/PlugIns
    plist=$OUT/apps/$label.app/Info.plist
  else
    rm -rf $OUT/apps/$label.app/Contents/PlugIns
    plist=$OUT/apps/$label.app/Contents/Info.plist
  fi
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE" $plist
  /usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" $plist 2>/dev/null
  codesign --force --deep -s - $OUT/apps/$label.app 2>/dev/null
  COPY[$label]=$OUT/apps/$label.app
done

screen=($(swift -e 'import AppKit; let f = NSScreen.main!.frame, v = NSScreen.main!.visibleFrame; print(Int(v.minX), Int(f.height - v.maxY), Int(v.width), Int(v.height))' 2>/dev/null))

state_env() {  # <state> → the launch switches, one per line
  case $1 in
    still) print -l PORTALS_FAKE=greeting;;
    drift) print -l PORTALS_FAKE=greeting PORTALS_DEBUG_WASH=working;;
    listen) print -l PORTALS_FAKE=greeting PORTALS_DEBUG_WASH=listening;;
    stream) print -l PORTALS_FAKE=markdown "PORTALS_DEBUG_PROMPT=Show me markdown" PORTALS_FAKE_PACE=150;;
    stream-calm) print -l PORTALS_FAKE=markdown "PORTALS_DEBUG_PROMPT=Show me markdown" PORTALS_FAKE_PACE=150 PORTALS_DEBUG_WASH=calm;;
  esac
}

cpu_seconds() {  # <pid> → CPU seconds used so far
  ps -o cputime= -p $1 | python3 -I -c 'import sys
t = sys.stdin.read().strip().replace("-", ":").split(":")
s = 0.0
for part in t: s = s * 60 + float(part or 0)
print(s)'
}

render_pid() {
  if [[ -n $SIM ]]; then
    # the simulator's backboardd: the child of its launchd_sim
    local sim_launchd=$(pgrep -f "launchd_sim.*$SIM" | head -1)
    [[ -n $sim_launchd ]] && pgrep -P $sim_launchd -x backboardd | head -1
  else
    pgrep -x WindowServer | head -1
  fi
}

launch() {  # <label> <state> <frames file> → sets app_pid, window
  local -a envs
  envs=("${(@f)$(state_env $2)}" PORTALS_DEBUG_WASH_FRAMES=$3 ${=EXTRA[$1]:-})
  if [[ -n $SIM ]]; then
    xcrun simctl terminate $SIM $SIM_BUNDLE >/dev/null 2>&1
    xcrun simctl install $SIM ${COPY[$1]} || return 1
    local -a simenv
    for e in $envs; do simenv+=("SIMCTL_CHILD_$e"); done
    app_pid=$(env $simenv xcrun simctl launch $SIM $SIM_BUNDLE | awk '{print $NF}')
    [[ -n $app_pid ]] || return 1
    return 0
  fi
  for attempt in 1 2 3; do
    rm -rf $OUT/home; mkdir -m 700 $OUT/home
    local -a args
    args=(--env CFFIXED_USER_HOME=$OUT/home)
    for e in $envs; do args+=(--env $e); done
    open -g -n $args ${COPY[$1]}
    for _ in {1..50}; do
      app_pid=$(pgrep -f "${COPY[$1]}/Contents/MacOS/Portals" | head -1)
      [[ -n $app_pid ]] && break
      sleep 0.2
    done
    sleep 2.5
    window=($($OUT/bin/window $app_pid 2>/dev/null))
    if (( ${#window} == 5 )); then
      size_window || log "  could not size the window"
      return 0
    fi
    log "window not on the Space in view (attempt $attempt): relaunching"
    quit_app
  done
  return 1
}

size_window() {
  local x y w h
  case $SIZE in
    large) x=${screen[1]} y=${screen[2]} w=${screen[3]} h=${screen[4]};;
    small) x=200 y=120 w=800 h=700;;
    *) return 0;;
  esac
  # A session of its own each time: a session another run ended refuses every call.
  cua-driver call set_window_frame "{\"pid\":$app_pid,\"window_id\":${window[1]},\"x\":$x,\"y\":$y,\"width\":$w,\"height\":$h,\"session\":\"wash-bench-$$-$app_pid\"}" > $OUT/size.json 2>&1 || return 1
  sleep 0.5
  window=($($OUT/bin/window $app_pid 2>/dev/null))
  print -r -- "${window[*]}" >> $OUT/sizes.log
}

quit_app() {
  if [[ -n $SIM ]]; then
    xcrun simctl terminate $SIM $SIM_BUNDLE >/dev/null 2>&1
  else
    [[ -n $app_pid ]] && kill $app_pid 2>/dev/null
    for _ in {1..30}; do kill -0 $app_pid 2>/dev/null || break; sleep 0.2; done
    defaults delete $BUNDLE >/dev/null 2>&1
    rm -f ~/Library/Preferences/$BUNDLE.plist
    rm -rf ~/Library/Saved\ Application\ State/$BUNDLE.savedState
    rm -rf $OUT/home
  fi
  app_pid=""
}

# Frames a second and ms a frame of the wash between two Unix times. Each line of the
# meter counts the frames since the line before it, so the rate is the frames of the
# lines after the first one in the stretch over the time from that first line to the last.
wash_frames() {  # <file> <from> <to>
  python3 -I -c '
import sys
path, start, end = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
lines = []
for line in open(path):
    p = line.split()
    if len(p) >= 4 and start <= float(p[0]) <= end:
        lines.append((float(p[0]), int(p[1]), float(p[2]), float(p[3])))
if len(lines) < 2:
    print("0 0 0"); sys.exit()
counted = lines[1:]
frames = sum(l[1] for l in counted); busy = sum(l[2] for l in counted); longest = max(l[3] for l in counted)
print("%.1f %.2f %.2f" % (frames / (lines[-1][0] - lines[0][0]), busy / frames if frames else 0, longest))
' $1 $2 $3
}

RESULTS=$OUT/results.tsv
print -- "round\tstate\tsize\tapp\tcpu%\trender%\tapp_power\trender_power\twash_fps\twash_ms_per_frame\twash_longest_ms\tload1\tfootprint" > $RESULTS
log "apps: ${(k)COPY} states: $STATES sizes: $SIZES rounds: $ROUNDS seconds: $SECS"
for round in {1..$ROUNDS}; do
  for state in ${(s:,:)STATES}; do
    for SIZE in ${(s:,:)SIZES}; do
      [[ $state == stream* && $SIZE == small ]] && continue
      for pair in $APPS; do
        label=${pair%%=*}
        run=$OUT/runs/r$round-$state-$SIZE-$label
        launch $label $state $run.frames || { log "could not launch $label"; continue; }
        launched=$EPOCHREALTIME
        if [[ $state == stream* ]]; then sleep 4; else sleep $SETTLE; fi
        rp=$(render_pid)
        t0=$EPOCHREALTIME
        a0=$(cpu_seconds $app_pid); r0=0; [[ -n $rp ]] && r0=$(cpu_seconds $rp)
        topout=$(top -l 2 -s $SECS -stats pid,cpu,power 2>/dev/null | awk -v a=$app_pid -v r=${rp:-0} 'BEGIN{n=0} /^PID/ {n++} n==2 && ($1==a || $1==r) {print $1, $3}')
        a1=$(cpu_seconds $app_pid); r1=0; [[ -n $rp ]] && r1=$(cpu_seconds $rp)
        t1=$EPOCHREALTIME
        load=$(uptime | sed 's/.*load averages: //' | cut -d' ' -f1)
        fp=$(footprint -p $app_pid 2>/dev/null | awk '/phys_footprint:/ { print $2 $3; exit }')
        cpu=$(( (a1 - a0) / (t1 - t0) * 100 ))
        rcpu=$(( (r1 - r0) / (t1 - t0) * 100 ))
        apower=$(print -r -- $topout | awk -v a=$app_pid '$1==a {print $2}')
        rpower=$(print -r -- $topout | awk -v r=${rp:-0} '$1==r {print $2}')
        if [[ -s $run.frames ]]; then
          wf=($(wash_frames $run.frames $t0 $t1))
        else
          wf=(0 0 0)
        fi
        line=$(printf "%d\t%s\t%s\t%s\t%.1f\t%.1f\t%s\t%s\t%s\t%s\t%s\t%s\t%s" $round $state $SIZE $label $cpu $rcpu ${apower:-?} ${rpower:-?} ${wf[1]} ${wf[2]} ${wf[3]} $load ${fp:-?})
        print -r -- $line >> $RESULTS
        log "$line"
        quit_app
        sleep 1
      done
    done
  done
done

log "medians (app cpu%, render cpu%, app power, render power, wash fps, wash ms/frame):"
python3 -I - $RESULTS <<'EOF' | tee -a $OUT/bench.log
import sys, statistics, collections
rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[1])][1:]
groups = collections.OrderedDict()
for r in rows:
    groups.setdefault((r[1], r[2], r[3]), []).append(r)
def med(vals):
    vals = [float(v) for v in vals if v not in ("?", "")]
    return statistics.median(vals) if vals else float("nan")
for (state, size, app), rs in groups.items():
    print("%-12s %-6s %-10s cpu %5.1f%%  render %5.1f%%  power %5.1f / %5.1f  wash %5.1f fps %6.2f ms  footprint %s  (n=%d, load %s)" % (
        state, size, app, med(r[4] for r in rs), med(r[5] for r in rs), med(r[6] for r in rs), med(r[7] for r in rs),
        med(r[8] for r in rs), med(r[9] for r in rs), "/".join(r[12] if len(r) > 12 else "?" for r in rs), len(rs), "/".join(r[11] for r in rs)))
EOF
