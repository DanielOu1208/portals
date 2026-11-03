#!/bin/zsh
# Pictures of a long thread opening on a Mac scratch copy right after a relaunch, the case
# that was once seen blank until scrolled by hand (4fd2778): a picture of the window every
# 0.25 s for 6 s from when the copy starts again, to look at.
#
#   scripts/open-bench/shots.sh <built .app> [thread kind: t120]
#
# The app as for scripts/open-bench.sh. Starts a scratch bridge on PORT (9351) with the
# fake agent's threads (open.ts seed), opens the thread once (nothing of it on the copy:
# fetched from the host and saved), quits, starts again on the same home and opens it
# again, from its saved copy. The pictures are kept in OUT/shots. Needs the gui lock.

set -uo pipefail
zmodload zsh/datetime
ROOT=${0:A:h:h:h}
PORT=${PORT:-9351}
OUT=${OUT:-/private/tmp/portals-n4/bench/open/shots-$(date +%H%M%S)}
APP_BUILT=${1:?usage: shots.sh <built .app> [thread kind]}
KIND=${2:-t120}
BRIDGE=$ROOT/bridge
USER_NAME=bench PASSWORD=bench-$RANDOM-$RANDOM
BUNDLE=com.danielou.portals.n4-open
URL=http://127.0.0.1:$PORT
mkdir -p $OUT/bin $OUT/shots
swiftc -O $ROOT/scripts/mac-scroll-bench/window.swift -o $OUT/bin/window 2>/dev/null || { echo "could not build the window helper"; exit 1; }

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
thread=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" $OUT/ids.json $KIND)
$ROOT/scripts/mac-scroll-bench/prepare-app.sh $APP_BUILT $OUT/app.app $BUNDLE || exit 1
hosts="[{\"name\":\"Scratch\",\"url\":\"$URL\",\"user\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}]"

launch() {
  open -g -n --env CFFIXED_USER_HOME=$OUT/app-home --env "PORTALS_DEBUG_HOSTS=$hosts" \
    --env PORTALS_DEBUG_OPEN_PROBE=$OUT/probe.jsonl --env "PORTALS_DEBUG_OPEN_PLAN=$thread:30" $OUT/app.app
  for _ in {1..50}; do app_pid=$(pgrep -f "$OUT/app.app/Contents/MacOS/Portals" | head -1); [[ -n $app_pid ]] && break; sleep 0.1; done
}
launch
sleep 6
kill $app_pid; for _ in {1..30}; do kill -0 $app_pid 2>/dev/null || break; sleep 0.2; done
launch
started=$EPOCHREALTIME
window=()
while (( EPOCHREALTIME - started < 6 )); do
  (( ${#window} == 5 )) || window=($($OUT/bin/window $app_pid 2>/dev/null))
  if (( ${#window} == 5 )); then
    screencapture -x -o -l ${window[1]} $OUT/shots/$(printf "%05.2f" $(( EPOCHREALTIME - started ))).png 2>/dev/null
  fi
  sleep 0.25
done
print -r -- "pictures in $OUT/shots; the probe's line for the relaunch: $(tail -1 $OUT/probe.jsonl)"
