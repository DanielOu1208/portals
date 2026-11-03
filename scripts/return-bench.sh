#!/bin/zsh
# What moves when the app comes back, and how soon it is current again
# (docs/perf-return.md). On a scratch copy of the Mac app and on the iPhone simulator,
# never the installed app or a real bridge.
#
#   scripts/return-bench.sh bridge <dir>
#       starts a scratch bridge on 9354 with the scripted agent and 60 threads (the
#       newest with a long last turn, every tenth one long), in <dir>/bridge (new), and
#       a relay on 9364 in front of it that counts the bytes (<dir>/bytes.txt). Runs in
#       the foreground until killed.
#   scripts/return-bench.sh mac <built Portals.app> <dir> <label> [rounds] [NAME=value ...]
#       a scratch copy (com.danielou.portals.n4-return) with the probe on
#       (PORTALS_DEBUG_RETURN), the newest thread open; then, <rounds> times (2): Finder
#       in front and back, the copy hidden and shown, its window covered and uncovered,
#       and hidden while a turn runs in the open thread and while one runs in another;
#       then the chat scrolled up (with RETURN_SCROLL_X=12 the sidebar scrolled down
#       instead, and with 0 rounds only that), and an approval card waiting.
#       Needs the gui lock. Writes <dir>/<label>/{probe,marks}.txt; quits the copy after.
#       Any NAME=value after the rounds is one more launch switch (PORTALS_DEBUG_DRAFT=…,
#       PORTALS_DEBUG_FOCUS=1, PORTALS_DEBUG_SIDEBAR=1).
#   SIM=<udid> scripts/return-bench.sh sim <built Portals.app> <dir> <label> [rounds] [NAME=value ...]
#       the same on the iPhone simulator (Preferences in front and back, then the same
#       with a turn running while away), with a screen recording of each round.
#       Needs the sim lock and an explicit booted iOS simulator. Only the scratch
#       bundle is replaced; it is left installed, not running.
#   scripts/return-bench.sh summary <dir> <label>
#       what moved within 3 s of each return, how long the list and the open thread took
#       to be current, and the bytes fetched (scripts/return-bench/summary.py).
#
# The build has to read the launch switches: Release with
# SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG (see scripts/mac-scroll-bench.sh).
set -eu

ID=com.danielou.portals.n4-return
SIM=${SIM:-}
SIM_ID=$ID
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
TOOLS=/private/tmp/portals-n4/bench
PASSWORD=return-bench
HOSTS='[{"name":"Scratch","url":"http://127.0.0.1:9364","user":"lean","password":"return-bench"}]'

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -ge 2 ] || usage
cmd=$1; shift

scratch() {
    case "$1" in
    *..*) echo "refused: $1 has a .. in it" >&2; exit 1 ;;
    /private/tmp/?*) ;;
    *) echo "refused: $1 is not under /private/tmp" >&2; exit 1 ;;
    esac
    # What of it is there already, resolved, is under /private/tmp too: a link in it
    # could lead out, and mkdir would follow it before the check below.
    there="$1"; while [ ! -e "$there" ]; do there="$(dirname "$there")"; done
    [ -d "$there" ] || { echo "refused: $there is not a folder" >&2; exit 1; }
    case "$(cd "$there" && pwd -P)/" in /private/tmp/*) ;; *) echo "refused: $there leads out of /private/tmp" >&2; exit 1 ;; esac
    mkdir -p "$1"
    real="$(cd "$1" && pwd -P)"
    case "$real" in /private/tmp/?*) echo "$real" ;; *) echo "refused: $real" >&2; exit 1 ;; esac
}

# A folder of <dir>'s own, made if need be: not a link (whose target the run would empty),
# and once made, where it says it is under <dir> (already resolved by scratch).
own() {
    [ ! -L "$2" ] || { echo "refused: $2 is a link" >&2; exit 1; }
    mkdir -p "$2"
    [ "$(cd "$2" && pwd -P)" = "$1/${2:t}" ] || { echo "refused: $2 is not in $1" >&2; exit 1; }
}

# A run's label names one folder in <dir>, which is emptied: a name alone, nothing that
# could reach out of it (a slash, a .., a leading dot or dash).
named() {
    [[ "$1" =~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' && "$1" != *..* ]] || { echo "refused: label $1 (letters, digits, . _ - only)" >&2; exit 1; }
}

now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
mark() { echo "$(now) $1 $2" >> "$out/marks.txt"; }

tools() {
    [ -x "$TOOLS/return-app" ] || swiftc -O -o "$TOOLS/return-app" "$REPO/scripts/return-bench/app.swift"
    [ -x "$TOOLS/return-cover" ] || swiftc -O -o "$TOOLS/return-cover" "$REPO/scripts/app-footprint/cover.swift"
}

# A turn of the scripted agent in <thread>, as another device would.
turn() {
    node "$REPO/scripts/return-bench/bridge.mts" turns http://127.0.0.1:9354 "$PASSWORD" "$1" 1 "${2:-A reply while the app is away}" > /dev/null
}

case "$cmd" in
bridge)
    dir="$(scratch "$1")"
    [ ! -e "$dir/bridge" ] || { echo "refused: $dir/bridge is there already" >&2; exit 1; }
    [ ! -L "$dir/bytes.txt" ] || { echo "refused: $dir/bytes.txt is a link" >&2; exit 1; }
    node "$REPO/scripts/return-bench/proxy.mjs" 9364 9354 "$dir/bytes.txt" &
    proxy=$!
    trap 'kill $proxy 2>/dev/null' EXIT INT TERM
    node "$REPO/scripts/return-bench/bridge.mts" start "$dir/bridge" 9354 60 "$PASSWORD" 10 20
    ;;
mac)
    [ $# -ge 3 ] || usage
    named "$3"
    src="$(cd "$1" && pwd -P)"; dir="$(scratch "$2")"; label=$3; rounds=${4:-2}
    shift $(( $# < 4 ? $# : 4 ))
    extra=(); for pair in "$@"; do extra+=(--env "$pair"); done
    case "$src" in /Applications/* | "$HOME"/Applications/*) echo "refused: installed app" >&2; exit 1 ;; esac
    tools
    out="$dir/$label"; own "$dir" "$out"; rm -rf "$out"; own "$dir" "$out"
    own "$dir" "$dir/copy-$label"
    copy="$dir/copy-$label/Portals.app"
    "$REPO/scripts/mac-scroll-bench/prepare-app.sh" "$src" "$copy" "$ID"
    home="$dir/copy-$label/home"; rm -rf "$home"; mkdir -m 700 "$home"
    other="$(sed -n 8p "$dir/bridge/ids.txt")"
    open -n --env "CFFIXED_USER_HOME=$home" --env "PORTALS_DEBUG_HOSTS=$HOSTS" \
        --env "PORTALS_DEBUG_RETURN=$out/probe.txt" --env "PORTALS_DEBUG_OPEN_EACH=1:0.5" "${extra[@]}" "$copy"
    exe="$copy/Contents/MacOS/Portals"
    pid=""
    for _ in {1..20}; do
        pid="$(ps -axo pid=,comm= | awk -v exe="$exe" '{ p = $1; sub(/^[ ]*[0-9]+[ ]+/, ""); if ($0 == exe) { print p; exit } }')"
        [ -n "$pid" ] && break; sleep 0.5
    done
    [ -n "$pid" ] || { echo "the copy did not start" >&2; exit 1; }
    echo "pid $pid"
    sleep 12
    "$TOOLS/return-app" front "$pid" || true; sleep 3
    first="$(awk '$2 == "shown" && $3 != "new" { id = $3 } END { print id }' "$out/probe.txt")"
    other="$(grep -v -x "$first" "$dir/bridge/ids.txt" | sed -n 8p)"
    echo "open thread $first, other $other"
    window="$("$TOOLS/return-app" windows "$pid" | awk '$2 == "true" && $3 == 0 && $6 > 300 { print $4, $5, $6, $7; exit }')"
    echo "window $window"
    for round in $( [ "$rounds" -gt 0 ] && seq 1 "$rounds"); do
        mark away focus; "$TOOLS/return-app" finder || true; sleep 3
        mark back focus; "$TOOLS/return-app" front "$pid" || true; sleep 5
        mark away hide; "$TOOLS/return-app" hide "$pid" || true; sleep 4
        mark back hide; "$TOOLS/return-app" front "$pid" || true; sleep 6
        if [ -n "$window" ]; then
            mark away cover; "$TOOLS/return-cover" ${=window} 4
            mark back cover; sleep 5
        fi
        mark away turn-open; "$TOOLS/return-app" hide "$pid" || true; sleep 1.5; turn "$first"; sleep 1
        mark back turn-open; "$TOOLS/return-app" front "$pid" || true; sleep 8
        mark away turn-other; "$TOOLS/return-app" hide "$pid" || true; sleep 1.5; turn "$other"; sleep 1
        mark back turn-other; "$TOOLS/return-app" front "$pid" || true; sleep 8
        mark away streaming; "$TOOLS/return-app" hide "$pid" || true; sleep 1.5; turn "$first" "slow please" & slow=$!; sleep 3
        mark back streaming; "$TOOLS/return-app" front "$pid" || true; wait $slow; sleep 3
    done
    # The chat scrolled up, reading older turns: it stays where it is.
    wid="$("$TOOLS/return-app" windows "$pid" | awk '$2 == "true" && $3 == 0 && $6 > 300 { print $1; exit }')"
    if [ -n "$wid" ] && command -v cua-driver > /dev/null; then
        size="$(cua-driver call get_window_state "{\"pid\":$pid,\"window_id\":$wid,\"include_accessibility_tree\":false,\"max_dimension\":400,\"session\":\"return-$pid\",\"screenshot_out_file\":\"$out/shot.png\"}" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d["screenshot_width"], d["screenshot_height"])')"
        # The chat, or with RETURN_SCROLL_X=12 the sidebar beside it.
        sx=$(( ${size% *} * ${RETURN_SCROLL_X:-62} / 100 )); sy=$(( ${size#* } * 45 / 100 ))
        for _ in 1 2 3; do
            cua-driver call scroll "{\"pid\":$pid,\"window_id\":$wid,\"x\":$sx,\"y\":$sy,\"direction\":\"${RETURN_SCROLL_DIRECTION:-up}\",\"amount\":6,\"by\":\"line\",\"session\":\"return-$pid\"}" > /dev/null 2>&1 || true
            sleep 0.3
        done
        sleep 3
        mark away up-focus; "$TOOLS/return-app" finder || true; sleep 3
        mark back up-focus; "$TOOLS/return-app" front "$pid" || true; sleep 5
        mark away up-hide; "$TOOLS/return-app" hide "$pid" || true; sleep 4
        mark back up-hide; "$TOOLS/return-app" front "$pid" || true; sleep 6
        mark away up-turn; "$TOOLS/return-app" hide "$pid" || true; sleep 1.5; turn "$first"; sleep 1
        mark back up-turn; "$TOOLS/return-app" front "$pid" || true; sleep 8
    fi
    # An approval card over the composer: it stays as it is.
    node "$REPO/scripts/return-bench/bridge.mts" approve http://127.0.0.1:9354 "$PASSWORD" "$first" > /dev/null 2>&1 || true
    sleep 3
    mark away card-focus; "$TOOLS/return-app" finder || true; sleep 3
    mark back card-focus; "$TOOLS/return-app" front "$pid" || true; sleep 5
    mark away card-hide; "$TOOLS/return-app" hide "$pid" || true; sleep 4
    mark back card-hide; "$TOOLS/return-app" front "$pid" || true; sleep 6
    node "$REPO/scripts/return-bench/bridge.mts" approve http://127.0.0.1:9354 "$PASSWORD" "$first" interrupt > /dev/null 2>&1 || true
    sleep 2
    "$TOOLS/return-app" finder || true
    kill "$pid" 2>/dev/null || true
    sleep 2
    defaults delete "$ID" 2>/dev/null || true
    rm -f "$HOME/Library/Preferences/$ID.plist"
    rm -rf "$HOME/Library/Saved Application State/$ID.savedState" "$home"
    echo "$(uptime | sed 's/.*load averages: //')" > "$out/load.txt"
    python3 "$REPO/scripts/return-bench/summary.py" "$out" "$dir/bytes.txt"
    ;;
sim)
    [ $# -ge 3 ] || usage
    [ -n "$SIM" ] || { echo "set SIM to the booted iOS simulator's UDID" >&2; exit 2; }
    xcrun simctl list devices available -j | python3 -c '
import json, sys
devices = json.load(sys.stdin)["devices"]
found = any(d.get("udid") == sys.argv[1] and d.get("isAvailable") is True and d.get("state") == "Booted"
            for runtime, rows in devices.items() if ".iOS-" in runtime for d in rows)
sys.exit(0 if found else 1)
' "$SIM" || { echo "SIM must name an available, booted iOS simulator" >&2; exit 2; }
    named "$3"
    src="$(cd "$1" && pwd -P)"; dir=${2:A}; label=$3; rounds=${4:-2}
    [ -f "$src/Info.plist" ] || { echo "not a simulator app: $src" >&2; exit 1; }
    out="$dir/$label"
    copydir="$dir/copy-$label"
    # Check both run folders before removing anything, even when the build was
    # supplied through a link or lives in a previous run's output.
    for target in "$out" "$copydir"; do
        [[ ! -L $target ]] || { echo "refused: $target is a link" >&2; exit 1; }
        target=${target:A}
        [[ $target != $src && $target != $src/* && $src != $target/* ]] || { echo "refused: $target overlaps source $src" >&2; exit 1; }
    done
    dir="$(scratch "$2")"
    shift $(( $# < 4 ? $# : 4 ))
    for pair in "$@"; do export "SIMCTL_CHILD_$pair"; done
    own "$dir" "$out"; rm -rf "$out"; own "$dir" "$out"
    other="$(sed -n 8p "$dir/bridge/ids.txt")"
    own "$dir" "$copydir"
    copy="$copydir/Portals.app"
    [[ ! -L $copy ]] || { echo "refused: $copy is a link" >&2; exit 1; }
    rm -rf "$copy"
    cp -R "$src" "$copy"
    root=${copy:A}
    for link in ${(f)"$(find "$copy" -type l)"}; do
        [[ -e $link && ${link:A} == $root/* ]] || { echo "refused: $link leads outside the copy" >&2; exit 1; }
    done
    rm -rf "$copy/PlugIns" "$copy/_CodeSignature"
    /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $SIM_ID" "$copy/Info.plist"
    /usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$copy/Info.plist" 2>/dev/null || true
    codesign --force --deep -s - "$copy"
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$copy/Info.plist")" = "$SIM_ID" ] || exit 1
    xcrun simctl terminate "$SIM" "$SIM_ID" 2>/dev/null || true
    xcrun simctl uninstall "$SIM" "$SIM_ID" 2>/dev/null || true
    xcrun simctl install "$SIM" "$copy"
    SIMCTL_CHILD_PORTALS_DEBUG_HOSTS="$HOSTS" SIMCTL_CHILD_PORTALS_DEBUG_RETURN="$out/probe.txt" \
        SIMCTL_CHILD_PORTALS_DEBUG_OPEN_EACH=1:0.5 xcrun simctl launch "$SIM" "$SIM_ID" > /dev/null
    sleep 14
    first="$(awk '$2 == "shown" && $3 != "new" { id = $3 } END { print id }' "$out/probe.txt")"
    other="$(grep -v -x "$first" "$dir/bridge/ids.txt" | sed -n 8p)"
    echo "open thread $first, other $other"
    for round in $(seq 1 "$rounds"); do
        xcrun simctl io "$SIM" recordVideo --force "$out/round-$round.mov" > /dev/null 2>&1 &
        video=$!
        sleep 1.5
        mark away background; xcrun simctl launch "$SIM" com.apple.Preferences > /dev/null; sleep 4
        mark back background; xcrun simctl launch "$SIM" "$SIM_ID" > /dev/null; sleep 6
        mark away turn-open; xcrun simctl launch "$SIM" com.apple.Preferences > /dev/null; sleep 2; turn "$first"; sleep 1
        mark back turn-open; xcrun simctl launch "$SIM" "$SIM_ID" > /dev/null; sleep 8
        mark away turn-other; xcrun simctl launch "$SIM" com.apple.Preferences > /dev/null; sleep 2; turn "$other"; sleep 1
        mark back turn-other; xcrun simctl launch "$SIM" "$SIM_ID" > /dev/null; sleep 8
        mark away streaming; xcrun simctl launch "$SIM" com.apple.Preferences > /dev/null; sleep 2; turn "$first" "slow please" & slow=$!; sleep 3
        mark back streaming; xcrun simctl launch "$SIM" "$SIM_ID" > /dev/null; wait $slow; sleep 3
        kill -INT "$video" 2>/dev/null || true; wait "$video" 2>/dev/null || true
    done
    # An approval card over the composer: it stays as it is.
    node "$REPO/scripts/return-bench/bridge.mts" approve http://127.0.0.1:9354 "$PASSWORD" "$first" > /dev/null 2>&1 || true
    sleep 3
    mark away card-background; xcrun simctl launch "$SIM" com.apple.Preferences > /dev/null; sleep 4
    mark back card-background; xcrun simctl launch "$SIM" "$SIM_ID" > /dev/null; sleep 6
    node "$REPO/scripts/return-bench/bridge.mts" approve http://127.0.0.1:9354 "$PASSWORD" "$first" interrupt > /dev/null 2>&1 || true
    sleep 2
    # Ended by the system in the background, then opened again: the same thread?
    xcrun simctl launch "$SIM" com.apple.Preferences > /dev/null; sleep 3
    xcrun simctl terminate "$SIM" "$SIM_ID" 2>/dev/null || true; sleep 1
    SIMCTL_CHILD_PORTALS_DEBUG_HOSTS="$HOSTS" SIMCTL_CHILD_PORTALS_DEBUG_RETURN="$out/probe-relaunch.txt" \
        SIMCTL_CHILD_PORTALS_DEBUG_OPEN_EACH= xcrun simctl launch "$SIM" "$SIM_ID" > /dev/null
    sleep 8
    xcrun simctl io "$SIM" screenshot "$out/relaunch.png" > /dev/null 2>&1 || true
    echo "left on screen: $first; opened after the relaunch: $(awk '$2 == "shown" { id = $3 } END { print id }' "$out/probe-relaunch.txt" 2>/dev/null)" | tee "$out/relaunch.txt"
    xcrun simctl terminate "$SIM" "$SIM_ID" 2>/dev/null || true
    echo "$(uptime | sed 's/.*load averages: //')" > "$out/load.txt"
    python3 "$REPO/scripts/return-bench/summary.py" "$out" "$dir/bytes.txt"
    ;;
summary)
    named "$2"
    dir="$(scratch "$1")"
    python3 "$REPO/scripts/return-bench/summary.py" "$dir/$2" "$dir/bytes.txt"
    ;;
*) usage ;;
esac
