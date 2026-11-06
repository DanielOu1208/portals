#!/bin/zsh
# What a key typed in the Mac app's composer costs: CPU and instructions a key, with a
# long thread on screen. On scratch copies and a scratch bridge, never the installed app
# or bridge.
#
#   scripts/type-bench.sh [--rounds N] [--port P] [--out DIR] [--threads N] [--search] <label>=<built .app> […]
#
# With --search, the keys go into the sidebar's search field instead: "budget" typed and
# taken out again, key by key (PORTALS_DEBUG_TYPE_BENCH_FIELD=search); --threads 600 then
# gives the list a size worth searching.
#
# Each app is a Release Mac Catalyst build with the launch switches compiled in
# (SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG, see scripts/mac-scroll-bench.sh). For every
# round, and every app in turn (A, B, A, B…): a scratch bridge with 60 threads (--threads)
# (scripts/sidebar-bench/bridge.mts; the newest ends with a reply of 20,000 characters),
# a scratch copy opened in the background on that newest thread (PORTALS_DEBUG_OPEN_PLAN),
# which then puts 300 letters into its composer one at a time, 80 ms apart, through its
# text view's insertText as the keyboard does (PORTALS_DEBUG_TYPE_BENCH). The app's CPU and instructions over those 24 seconds
# (proc_pid_rusage, scripts/tabs-bench/rusage.swift), less the same span at rest just
# after, divided by 300, is what a key costs. Medians per app at the end.
set -uo pipefail
zmodload zsh/datetime
ROOT=${0:A:h:h}
ROUNDS=3 PORT=${PORT:-9535} THREADS=60 FIELD=composer
OUT=/private/tmp/type-bench-$(date +%H%M%S)
APPS=()
while (( $# )); do
  case $1 in
    --rounds) ROUNDS=$2; shift 2;;
    --port) PORT=$2; shift 2;;
    --out) OUT=$2; shift 2;;
    --threads) THREADS=$2; shift 2;;
    --search) FIELD=search; shift;;
    *=*) APPS+=($1); shift;;
    *) echo "unknown argument $1"; exit 2;;
  esac
done
(( ${#APPS} )) || { sed -n '2,/^set/p' $0; exit 2; }
BIN=$OUT/bin PASSWORD=type-$RANDOM-$RANDOM
mkdir -p $BIN
swiftc -O $ROOT/scripts/tabs-bench/rusage.swift -o $BIN/rusage 2>/dev/null || { echo "could not build the rusage helper"; exit 1; }

bridge_pid="" app_pid="" bundle=""
forget_app() {
  [[ -n $bundle ]] || return 0
  defaults delete $bundle >/dev/null 2>&1
  rm -f ~/Library/Preferences/$bundle.plist
  rm -rf ~/Library/Saved\ Application\ State/$bundle.savedState
}
cleanup() {
  [[ -n $app_pid ]] && kill $app_pid 2>/dev/null
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null
  forget_app
}
trap cleanup EXIT INT TERM

wait_word() {  # <file> <word> <seconds>
  local ends=$(( EPOCHREALTIME + $3 ))
  while (( EPOCHREALTIME < ends )); do grep -q "^$2 " $1 2>/dev/null && return 0; sleep 0.1; done
  return 1
}

for round in {1..$ROUNDS}; do
  for spec in $APPS; do
    label=${spec%%=*} app=${spec#*=}
    dir=$OUT/$label-$round
    mkdir -p $dir
    node $ROOT/scripts/sidebar-bench/bridge.mts start $dir/bridge $PORT $THREADS $PASSWORD 5 8 100 > $dir/bridge.log 2>&1 &
    bridge_pid=$!
    for _ in {1..200}; do grep -q "listening on" $dir/bridge.log 2>/dev/null && break; sleep 0.1; done
    bundle=com.danielou.portals.type-bench-$label
    copy=$OUT/$label.app
    [[ -d $copy ]] || $ROOT/scripts/mac-scroll-bench/prepare-app.sh $app $copy $bundle || exit 1
    hosts="[{\"name\":\"Scratch\",\"url\":\"http://127.0.0.1:$PORT\",\"user\":\"sidebar\",\"password\":\"$PASSWORD\"}]"
    open -g -n --env CFFIXED_USER_HOME=$dir/home --env "PORTALS_DEBUG_HOSTS=$hosts" \
      --env PORTALS_DEBUG_OPEN_PLAN=$(head -1 $dir/bridge/ids.txt) --env PORTALS_DEBUG_TYPE_BENCH=$dir/typed.txt --env PORTALS_DEBUG_TYPE_BENCH_FIELD=$FIELD $copy
    for _ in {1..50}; do app_pid=$(pgrep -f "$copy/Contents/MacOS/Portals" | head -1); [[ -n $app_pid ]] && break; sleep 0.2; done
    if ! wait_word $dir/typed.txt typing 60; then
      echo "$label round $round: never started typing"; kill $app_pid; app_pid=""; kill $bridge_pid; bridge_pid=""; continue
    fi
    typing_at=$EPOCHREALTIME
    start=$($BIN/rusage $app_pid)
    # A round that did not type all 300 keys (it stalled, or the chat closed: "aborted") is
    # left out, rather than divided by 300 into the medians.
    if ! wait_word $dir/typed.txt typed 60; then
      echo "$label round $round: never ended, left out"
      kill $app_pid 2>/dev/null; app_pid=""; kill $bridge_pid 2>/dev/null; wait $bridge_pid 2>/dev/null; bridge_pid=""
      forget_app
      continue
    fi
    end=$($BIN/rusage $app_pid)
    span=$(( EPOCHREALTIME - typing_at ))
    sleep 2
    rest0=$($BIN/rusage $app_pid)
    sleep 10
    rest1=$($BIN/rusage $app_pid)
    python3 -I -c 'import sys
a, b, r0, r1 = ([float(x) for x in s.split()] for s in sys.argv[1:5]); span = float(sys.argv[5])
rest_cpu = (r1[0] - r0[0]) / 10 * span; rest_ins = (r1[4] - r0[4]) / 10 * span
print(f"cpu_ms_key={(b[0] - a[0] - rest_cpu) / 300:.2f} minstr_key={(b[4] - a[4] - rest_ins) / 300:.2f} cpu_pct_typing={(b[0] - a[0]) / span / 10:.1f} cpu_pct_rest={(r1[0] - r0[0]) / 100:.2f}")' \
      "$start" "$end" "$rest0" "$rest1" "$span" > $dir/result.txt
    # Counters not read (the app gone before the last read): left out too.
    if [[ -s $dir/result.txt ]]; then
      print -r -- "$label round $round $(cat $dir/result.txt) load $(sysctl -n vm.loadavg)" | tee -a $OUT/results.txt
    else
      echo "$label round $round: counters not read, left out"
    fi
    kill $app_pid 2>/dev/null; for _ in {1..40}; do kill -0 $app_pid 2>/dev/null || break; sleep 0.2; done; app_pid=""
    kill $bridge_pid 2>/dev/null; wait $bridge_pid 2>/dev/null; bridge_pid=""
    forget_app
  done
done
python3 -I -c 'import sys, re, statistics, collections
rows = collections.defaultdict(lambda: collections.defaultdict(list))
for line in open(sys.argv[1]):
    label = line.split()[0]
    for k, v in re.findall(r"(\w+)=([\d.\-]+)", line): rows[label][k].append(float(v))
for label, ks in rows.items():
    print(label, " ".join(f"{k}={statistics.median(v):.2f}" for k, v in ks.items()), f"(n={len(next(iter(ks.values())))})")' $OUT/results.txt
