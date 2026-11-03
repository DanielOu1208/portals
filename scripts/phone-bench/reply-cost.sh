#!/bin/zsh
# What one streamed reply costs the phone app, build against build: the CPU seconds the
# app spends while the fake agent's minute-long reply streams into the thread on screen
# and into two others (night of 2026-10-19, docs/perf-phone.md). Steadier than a CPU
# percentage on a loaded Mac: the work is the same reply every time.
#
#   scripts/phone-bench/reply-cost.sh <sim udid> <port> <out folder> <replies> <label>=<built .app> …
#
# For each app in turn, A, B, A, B…: a scratch bridge with only the 45-turn thread, the
# app launched on it (alone, so it is the one opened), two 10-turn threads and 24
# short ones made, then <replies> times one reply in the long thread and two others at
# once, and the app's CPU (all threads, and the main thread's) over each. BENCH_PROMPT
# picks another reply ("bench coarse": half as many pieces). OPEN_FIRST=<n> (1 or 2):
# the app is launched again on the same data and opens n of the 10-turn threads before
# the long one (PORTALS_DEBUG_OPEN_PLAN, from a217ee0 on), so that threads opened
# before are running off screen. Lines in <out>/costs.txt, medians at the end.
set -uo pipefail
zmodload zsh/datetime
SIM=$1 PORT=$2 OUT=$3 REPLIES=$4
shift 4
ROOT=${0:A:h:h:h}
HELP=$ROOT/scripts/phone-bench
BRIDGE=$ROOT/bridge
USER_NAME=bench PASSWORD=cost-$RANDOM
url=http://127.0.0.1:$PORT
mkdir -p $OUT
scroll() { node $BRIDGE/scripts/bench/scroll.ts "$@" }
bridge_pid="" current=""
cleanup() {
  [[ -n $current ]] && xcrun simctl terminate $SIM com.danielou.portals.n5-cost.$current 2>/dev/null
  for spec in "$@"; do xcrun simctl uninstall $SIM com.danielou.portals.n5-cost.${spec%%=*} 2>/dev/null; done
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null
}
trap 'cleanup $APPS' EXIT INT TERM
APPS=("$@")
for spec in $APPS; do
  label=${spec%%=*}
  # A label names a copy in $OUT and a bundle id: letters, digits, - and _ only (nothing that leaves $OUT).
  [[ $label =~ '^[A-Za-z0-9][A-Za-z0-9_-]*$' ]] || { print -u2 "a label is letters, digits, - and _ only: '$label'"; exit 2 }
  rm -rf $OUT/$label.app
  cp -R ${spec#*=} $OUT/$label.app
  rm -rf $OUT/$label.app/PlugIns
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.danielou.portals.n5-cost.$label" $OUT/$label.app/Info.plist
  /usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" $OUT/$label.app/Info.plist 2>/dev/null
  codesign --force --deep -s - $OUT/$label.app 2>/dev/null
done

one() {  # <label> <round>
  local label=$1 home=$OUT/bridge-home
  current=$label
  rm -rf $home
  scroll config $home $PORT $USER_NAME $PASSWORD || return 1
  PORTALS_BRIDGE_HOME=$home node $BRIDGE/src/main.ts > $OUT/bridge.log 2>&1 &
  bridge_pid=$!
  for _ in {1..100}; do grep -q "listening on" $OUT/bridge.log 2>/dev/null && break; sleep 0.1; done
  local long=$(scroll seed $url $USER_NAME $PASSWORD 45)
  local id=com.danielou.portals.n5-cost.$label
  xcrun simctl uninstall $SIM $id 2>/dev/null
  xcrun simctl install $SIM $OUT/$label.app || return 1
  local answer=$(SIMCTL_CHILD_PORTALS_DEBUG_HOSTS="[{\"name\":\"Scratch\",\"url\":\"$url\",\"user\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}]" \
    SIMCTL_CHILD_PORTALS_DEBUG_OPEN_EACH=1:0.5 xcrun simctl launch --terminate-running-process $SIM $id 2>&1)
  local pid=${answer##*: }
  [[ $pid == <-> ]] || { print -r -- "could not launch: $answer"; return 1 }
  sleep 10
  local others=() i
  for i in 1 2; do others+=($(scroll seed $url $USER_NAME $PASSWORD 10)); done
  for i in {1..24}; do scroll seed $url $USER_NAME $PASSWORD 1 > /dev/null; done
  sleep 6
  if (( ${OPEN_FIRST:-0} > 0 )); then
    # Threads opened before, still running, off screen: launched again on the same data,
    # the app opens OPEN_FIRST of the 10-turn threads, then the long one.
    xcrun simctl terminate $SIM $id; sleep 2
    local plan=${(j:,:)${others[1,$OPEN_FIRST]}},$long
    answer=$(SIMCTL_CHILD_PORTALS_DEBUG_HOSTS="[{\"name\":\"Scratch\",\"url\":\"$url\",\"user\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}]" \
      SIMCTL_CHILD_PORTALS_DEBUG_OPEN_PLAN=$plan:2 xcrun simctl launch $SIM $id 2>&1)
    pid=${answer##*: }
    [[ $pid == <-> ]] || { print -r -- "could not launch: $answer"; return 1 }
    sleep $(( 2 * OPEN_FIRST + 10 ))
  fi
  xcrun simctl io $SIM screenshot $OUT/$label-$2.png > /dev/null 2>&1
  for i in $(seq 1 $REPLIES); do
    local a=$(python3 -I -c "
import sys; sys.path.insert(0, '$HELP'); sys.argv = ['x', '0', '0']
exec(open('$HELP/threads.py').read().split('def main')[0])
rows = threads($pid); print(cputime($pid), sum(r[2] for r in rows if r[3]))")
    local t0=$EPOCHREALTIME p=() t
    for t in $long $others; do scroll stream $url $USER_NAME $PASSWORD $t >> $OUT/stream.log 2>&1 & p+=($!); done
    for t in $p; do wait $t; done
    local b=$(python3 -I -c "
import sys; sys.path.insert(0, '$HELP'); sys.argv = ['x', '0', '0']
exec(open('$HELP/threads.py').read().split('def main')[0])
rows = threads($pid); print(cputime($pid), sum(r[2] for r in rows if r[3]))")
    local line="$label cpu_s=$(( ${b% *} - ${a% *} )) main_s=$(( ${b#* } - ${a#* } )) span=$(( EPOCHREALTIME - t0 )) load=$(uptime | sed 's/.*load averages*: //' | cut -d' ' -f1)"
    print -r -- $line | tee -a $OUT/costs.txt
    sleep 2
  done
  xcrun simctl terminate $SIM $id
  kill $bridge_pid; wait $bridge_pid 2>/dev/null; bridge_pid=""
  current=""
}
for round in 1 2; do
  for spec in $APPS; do one ${spec%%=*} $round; done
done
python3 -I - $OUT/costs.txt <<'EOF'
import collections, statistics, sys
rows = collections.defaultdict(list)
for line in open(sys.argv[1]):
    parts = dict(p.split("=", 1) for p in line.split()[1:])
    rows[line.split()[0]].append((float(parts["cpu_s"]), float(parts["main_s"])))
for label, xs in rows.items():
    print("%s: %d replies, CPU %.2f s (median; %s), main thread %.2f s" % (label, len(xs), statistics.median(x[0] for x in xs),
          " ".join("%.1f" % x[0] for x in xs), statistics.median(x[1] for x in xs)))
EOF
