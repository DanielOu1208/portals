#!/bin/sh
# Measures the Mac app's memory and CPU on a scratch copy, never the installed app.
#
#   scripts/app-footprint.sh prepare <built Portals.app> <dir>
#       copies the app to <dir>/Portals.app under a throwaway bundle id
#       (com.danielou.portals.footprint), without its extensions and URL types, signed
#       ad hoc. The build has to read the launch switches: a Release build with
#       SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG (DebugLaunch.swift is the only code
#       under DEBUG), see docs/perf-app.md.
#   scripts/app-footprint.sh launch <dir> <port> <password> [NAME=value ...]
#       starts the copy in the background with a new scratch home, <dir>/home (stop removes
#       it), signed in to the scratch bridge on 127.0.0.1:<port> (bridge.mts start), with
#       any more launch switches (PORTALS_DEBUG_OPEN_EACH=30 ...). Prints its pid.
#   scripts/app-footprint.sh sample <pid> <label> [seconds]
#       one line: memory (footprint's phys_footprint, and resident), CPU averaged over
#       <seconds> (10 by default) from the process's own CPU time, idle wake-ups a
#       second (top), threads, and the load average beside them.
#   scripts/app-footprint.sh stop <dir>
#       quits the copy, removes its preferences and saved state, and the scratch home.
#
# The numbers move with what else the Mac is doing: take several samples and use the
# median, with the load average written beside it.
set -eu

ID=com.danielou.portals.footprint

usage() {
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
}

[ $# -ge 1 ] || usage
cmd="$1"
shift

# The scratch folder as its real path, refused outside /private/tmp: nothing here may
# reach the installed app.
scratch_dir() {
    case "$1" in
    *..*) echo "refused: $1 has a .. in it" >&2; exit 1 ;;
    /private/tmp/?* | /tmp/?*) ;;
    *) echo "refused: $1 is not under /private/tmp" >&2; exit 1 ;;
    esac
    # The deepest folder of it that exists, by its real path, before anything is made.
    existing="$1"
    while [ ! -d "$existing" ]; do existing="$(dirname "$existing")"; done
    case "$(cd "$existing" && pwd -P)/" in
    /private/tmp/*) ;;
    *) echo "refused: $1 leads out of /private/tmp" >&2; exit 1 ;;
    esac
    mkdir -p "$1"
    real="$(cd "$1" && pwd -P)"
    case "$real" in
    /private/tmp/?*) echo "$real" ;;
    *) echo "refused: $real is not under /private/tmp" >&2; exit 1 ;;
    esac
}

# Whether <dir>/Portals.app is a copy made by prepare: no link on the way to its
# executable or its Info.plist, and the throwaway bundle id.
is_copy() {
    for part in Portals.app Portals.app/Contents Portals.app/Contents/Info.plist Portals.app/Contents/MacOS \
        Portals.app/Contents/MacOS/Portals; do
        [ -e "$1/$part" ] && [ ! -L "$1/$part" ] || return 1
    done
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Portals.app/Contents/Info.plist" 2>/dev/null)" = "$ID" ]
}

# The pid of the scratch copy in <dir>: the process whose executable is exactly that
# copy's, and whose bundle is the throwaway one.
pid_of() {
    exe="$1/Portals.app/Contents/MacOS/Portals"
    is_copy "$1" || return 0
    ps -axo pid=,comm= | awk -v exe="$exe" '{ pid = $1; sub(/^[ ]*[0-9]+[ ]+/, ""); if ($0 == exe) { print pid; exit } }'
}

case "$cmd" in
prepare)
    [ $# -eq 2 ] || usage
    # The built app by its real path: a link to it (or to the installed app) is never
    # copied as a link, which the steps below would follow.
    src="$(cd "$1" && pwd -P)" || exit 1
    case "$src" in
    /Applications/* | "$HOME"/Applications/*) echo "refused: $src is an installed app" >&2; exit 1 ;;
    esac
    dir="$(scratch_dir "$2")"
    rm -rf "$dir/Portals.app"
    cp -R "$src" "$dir/Portals.app"
    # Nothing in the copy may lead out of it: the steps below would change what it
    # leads to.
    if find "$dir/Portals.app" -type l -exec readlink {} \; | grep -qE '^/|(^|/)[.][.](/|$)'; then
        rm -rf "$dir/Portals.app"
        echo "refused: $src has links that lead out of it" >&2
        exit 1
    fi
    [ -f "$dir/Portals.app/Contents/Info.plist" ] || { rm -rf "$dir/Portals.app"; echo "refused: $src is not an app" >&2; exit 1; }
    rm -rf "$dir/Portals.app/Contents/PlugIns"
    plist="$dir/Portals.app/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $ID" "$plist"
    /usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$plist" 2>/dev/null || true
    codesign --force --deep -s - "$dir/Portals.app" 2>/dev/null
    echo "$dir/Portals.app"
    ;;
launch)
    [ $# -ge 3 ] || usage
    dir="$(scratch_dir "$1")"
    port="$2"
    password="$3"
    shift 3
    is_copy "$dir" || { echo "refused: $dir/Portals.app is not a copy made by prepare" >&2; exit 1; }
    # The copy keeps its threads, settings and caches in its home, made new here: one
    # left from before could hold a link leading anywhere else (to the installed app's
    # data, say).
    if [ -e "$dir/home" ] || [ -L "$dir/home" ]; then
        echo "refused: $dir/home is there already: stop the copy (which removes its home) and launch again" >&2
        exit 1
    fi
    mkdir -m 700 "$dir/home"
    hosts="[{\"name\":\"Scratch\",\"url\":\"http://127.0.0.1:$port\",\"user\":\"lean\",\"password\":\"$password\"}]"
    # Each switch as one argument, spaces and all.
    count=$#
    for pair in "$@"; do set -- "$@" --env "$pair"; done
    shift "$count"
    open -g -n --env "CFFIXED_USER_HOME=$dir/home" --env "PORTALS_DEBUG_HOSTS=$hosts" "$@" "$dir/Portals.app"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        pid="$(pid_of "$dir" || true)"
        [ -n "$pid" ] && break
        sleep 0.5
    done
    [ -n "${pid:-}" ] || { echo "the copy did not start" >&2; exit 1; }
    echo "$pid"
    ;;
sample)
    [ $# -ge 2 ] || usage
    pid="$1"
    label="$2"
    seconds="${3:-10}"
    cpu_s() {
        # cumulative CPU time as [[hh:]mm:]ss.cc, in seconds
        ps -o time= -p "$1" | awk -F: '{ if (NF == 3) print $1 * 3600 + $2 * 60 + $3; else if (NF == 2) print $1 * 60 + $2; else print $1 }'
    }
    before="$(cpu_s "$pid")"
    # top's IDLEW is a running count: the second sample less the first
    wakeups="$(top -l 2 -s "$seconds" -pid "$pid" -stats pid,idlew 2>/dev/null | awk -v p="$pid" -v s="$seconds" '$1 == p { gsub(/[^0-9]/, "", $2); v[n++] = $2 } END { if (n == 2) printf "%.1f", (v[1] - v[0]) / s; else print "?" }')"
    after="$(cpu_s "$pid")"
    cpu="$(echo "$before $after $seconds" | awk '{ printf "%.1f", ($2 - $1) / $3 * 100 }')"
    fp="$(footprint -p "$pid" 2>/dev/null | awk '/phys_footprint:/ { print $2 $3; exit }')"
    peak="$(footprint -p "$pid" 2>/dev/null | awk '/phys_footprint_peak:/ { print $2 $3; exit }')"
    rss="$(ps -o rss= -p "$pid" | awk '{ printf "%.0fMB", $1 / 1024 }')"
    threads="$(ps -M -p "$pid" | tail -n +2 | wc -l | tr -d ' ')"
    load="$(uptime | sed 's/.*load averages: //')"
    printf '%s\tfootprint %s (peak %s)\trss %s\tcpu %s%%\twakeups/s %s\tthreads %s\tload %s\n' \
        "$label" "$fp" "$peak" "$rss" "$cpu" "$wakeups" "$threads" "$load"
    ;;
stop)
    [ $# -eq 1 ] || usage
    dir="$(scratch_dir "$1")"
    pid="$(pid_of "$dir" || true)"
    if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null || true
        for _ in 1 2 3 4 5 6 7 8 9 10; do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.5
        done
        # Only if it is still the copy: its pid may be another process's by now.
        if [ "$(pid_of "$dir" || true)" = "$pid" ]; then kill -9 "$pid" 2>/dev/null || true; fi
    fi
    defaults delete "$ID" 2>/dev/null || true
    rm -f "$HOME/Library/Preferences/$ID.plist"
    rm -rf "$HOME/Library/Saved Application State/$ID.savedState"
    rm -rf "$dir/home"
    ;;
*)
    usage
    ;;
esac
