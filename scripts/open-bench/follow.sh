#!/bin/zsh
# Checks, on a Mac scratch copy, that the chat still follows a reply after the changes to
# how a thread opens: it keeps to the end while a reply streams, stays where it was
# scrolled up to while the reply goes on, comes back to following once scrolled down to
# the end, and is at the end once the reply is over.
#
#   scripts/open-bench/follow.sh <built .app>
#
# The app is a Release Mac Catalyst build with the launch switches compiled in, as for
# scripts/open-bench.sh, and must have the open probe's watch (OpenProbe.swift: twice a
# second, how far the chat is from its end, in <probe>.watch). It starts a scratch bridge
# on PORT (9351) with the fake agent, opens a 10-turn thread while the fake agent's
# minute-long reply streams into it, and scrolls the chat with the mouse wheel in the
# background (cua-driver; the pointer does not move). Prints one line per check, PASS or
# FAIL, with the distances seen. Needs the gui lock.

set -uo pipefail
zmodload zsh/datetime
ROOT=${0:A:h:h:h}
PORT=${PORT:-9351}
OUT=${OUT:-/private/tmp/portals-n4/bench/open/follow-$(date +%H%M%S)}
APP_BUILT=${1:?usage: follow.sh <built .app>}
BRIDGE=$ROOT/bridge
USER_NAME=bench PASSWORD=bench-$RANDOM-$RANDOM
BUNDLE=com.danielou.portals.n4-open
URL=http://127.0.0.1:$PORT
mkdir -p $OUT/bin
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
thread=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['running'])" $OUT/ids.json)
$ROOT/scripts/mac-scroll-bench/prepare-app.sh $APP_BUILT $OUT/app.app $BUNDLE || exit 1
node $BRIDGE/scripts/bench/open.ts run $URL $USER_NAME $PASSWORD $thread || exit 1

probe=$OUT/probe.jsonl
hosts="[{\"name\":\"Scratch\",\"url\":\"$URL\",\"user\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}]"
open -g -n --env CFFIXED_USER_HOME=$OUT/app-home --env "PORTALS_DEBUG_HOSTS=$hosts" \
  --env PORTALS_DEBUG_OPEN_PROBE=$probe --env "PORTALS_DEBUG_OPEN_PLAN=$thread:60" $OUT/app.app
for _ in {1..50}; do app_pid=$(pgrep -f "$OUT/app.app/Contents/MacOS/Portals" | head -1); [[ -n $app_pid ]] && break; sleep 0.2; done
sleep 6
window=($($OUT/bin/window $app_pid 2>/dev/null))
(( ${#window} == 5 )) || { echo "FAIL the window is not on the Space in view"; exit 1; }

# The last <n> watch lines' distances, and the content heights.
dists() { tail -n ${1:-3} $probe.watch | python3 -I -c 'import json,sys; print(" ".join(str(json.loads(l)["dist"]) for l in sys.stdin))' }
heights() { tail -n ${1:-3} $probe.watch | python3 -I -c 'import json,sys; print(" ".join(str(json.loads(l)["content"]) for l in sys.stdin))' }
failures=0
check() {  # <name> <python condition on d (distances) and h (heights)>
  local d=$(dists 4) h=$(heights 4)
  if [[ -n $d ]] && python3 -I -c "d=[float(x) for x in '$d'.split()]; h=[float(x) for x in '$h'.split()]; import sys; sys.exit(0 if ($2) else 1)"; then
    print -r -- "PASS $1: distances [$d] heights [$h]"
  else
    print -r -- "FAIL $1: distances [$d] heights [$h]"
    (( failures += 1 ))
  fi
}
shot=$(cua-driver call get_window_state "{\"pid\":$app_pid,\"window_id\":${window[1]},\"include_accessibility_tree\":false,\"max_dimension\":400,\"session\":\"follow\",\"screenshot_out_file\":\"$OUT/shot.png\"}" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d["screenshot_width"], d["screenshot_height"])')
sw=${shot% *} sh=${shot#* }
x=$(( sw * 62 / 100 )) y=$(( sh * 45 / 100 ))
scroll() { cua-driver call scroll "{\"pid\":$app_pid,\"window_id\":${window[1]},\"x\":$x,\"y\":$y,\"direction\":\"$1\",\"amount\":$2,\"by\":\"$3\",\"session\":\"follow\"}" >/dev/null 2>&1 }

check "follows the end while the reply streams" "all(abs(x) < 2 for x in d) and h[-1] > h[0]"
scroll up 12 line; sleep 0.4; scroll up 12 line
sleep 3
check "stays where it was scrolled up to as the reply goes on" "all(x > 100 for x in d) and d[-1] > d[0]"
screencapture -x -o -l ${window[1]} $OUT/scrolled-up.png 2>/dev/null
scroll down 60 page
sleep 3
check "follows again once scrolled back to the end" "all(abs(x) < 2 for x in d[1:])"
node $BRIDGE/scripts/bench/open.ts stop $URL $USER_NAME $PASSWORD $thread >/dev/null 2>&1
sleep 3
check "at the end once the reply is over" "all(abs(x) < 2 for x in d[-2:])"
screencapture -x -o -l ${window[1]} $OUT/after.png 2>/dev/null
print -r -- "kept in $OUT"
# Every check is made and shown; the script fails if any of them did.
(( failures == 0 )) || { print -r -- "$failures check(s) failed"; exit 1; }
