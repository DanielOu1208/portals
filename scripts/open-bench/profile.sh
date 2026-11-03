#!/bin/zsh
# Where the main thread's time goes while threads are opened one after another on a Mac
# scratch copy: the 45- and 120-turn threads of scripts/open-bench.sh opened in turn, every
# 1.5 s, 16 times (each opened once cold first, then from memory), with `sample` taking the
# app for 20 s of it. Keeps the report in OUT/sample.txt and prints the heaviest frames
# of the main thread (scripts/open-bench/heaviest.py).
#
#   scripts/open-bench/profile.sh <built .app>
#
# The app as for scripts/open-bench.sh. Needs the gui lock (the app must be on screen).

set -uo pipefail
ROOT=${0:A:h:h:h}
PORT=${PORT:-9351}
OUT=${OUT:-/private/tmp/portals-n4/bench/open/profile-$(date +%H%M%S)}
APP_BUILT=${1:?usage: profile.sh <built .app>}
BRIDGE=$ROOT/bridge
USER_NAME=bench PASSWORD=bench-$RANDOM-$RANDOM
BUNDLE=com.danielou.portals.n4-open
URL=http://127.0.0.1:$PORT
mkdir -p $OUT

bridge_pid="" app_pid=""
cleanup() {
  [[ -n $app_pid ]] && kill $app_pid 2>/dev/null
  [[ -n $bridge_pid ]] && kill $bridge_pid 2>/dev/null
  defaults delete $BUNDLE >/dev/null 2>&1
  rm -f ~/Library/Preferences/$BUNDLE.plist
  rm -rf ~/Library/Saved\ Application\ State/$BUNDLE.savedState $OUT/app-home
}
trap cleanup EXIT INT TERM

home=$OUT/bridge-home
node $BRIDGE/scripts/bench/scroll.ts config $home $PORT $USER_NAME $PASSWORD || exit 1
PORTALS_BRIDGE_HOME=$home PORTALS_BRIDGE_LOG=info node $BRIDGE/src/main.ts > $home/bridge.log 2>&1 &
bridge_pid=$!
for _ in {1..100}; do grep -q "listening on" $home/bridge.log 2>/dev/null && break; sleep 0.1; done
node $BRIDGE/scripts/bench/open.ts seed $URL $USER_NAME $PASSWORD $OUT/ids.json 2>/dev/null || { echo "could not seed"; exit 1; }
id() { python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" $OUT/ids.json $1 }
a=$(id t45) b=$(id t120)
plan=$(for _ in {1..8}; do print -n "$a,$b,"; done)
$ROOT/scripts/mac-scroll-bench/prepare-app.sh $APP_BUILT $OUT/app.app $BUNDLE || exit 1
hosts="[{\"name\":\"Scratch\",\"url\":\"$URL\",\"user\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}]"
open -g -n --env CFFIXED_USER_HOME=$OUT/app-home --env "PORTALS_DEBUG_HOSTS=$hosts" \
  --env PORTALS_DEBUG_OPEN_PROBE=$OUT/probe.jsonl --env "PORTALS_DEBUG_OPEN_PLAN=${plan%,}:1.5" $OUT/app.app
for _ in {1..50}; do app_pid=$(pgrep -f "$OUT/app.app/Contents/MacOS/Portals" | head -1); [[ -n $app_pid ]] && break; sleep 0.1; done
# Past the two cold openings.
for _ in {1..120}; do [[ -f $OUT/probe.jsonl ]] && (( $(wc -l < $OUT/probe.jsonl) >= 2 )) && break; sleep 0.25; done
sample $app_pid 20 1 -file $OUT/sample.txt >/dev/null 2>&1
python3 -I $ROOT/scripts/open-bench/heaviest.py $OUT/sample.txt
print -r -- "kept in $OUT"
