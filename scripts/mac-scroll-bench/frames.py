# Sums the app's frame meter lines (FrameMeter.swift) on stdin:
#   <t> <frames> <hitches> <hitch ms> <longest ms>   about one line a second
# and prints "<hitch ms per s> <hitches per s> <frames per s> <longest ms>".
#   frames.py [<t of the line before the first>]
# A line covers the time since the line before it (since the meter started, t = 0, for
# its first line): at least a second, more when the app was busy as it came due. Without
# the line before, the first line is taken to cover one second.
# Part of scripts/mac-scroll-bench.sh.
import sys

rows = [line.split() for line in sys.stdin if len(line.split()) == 5]
if len(rows) < 2:
    print("- - - -")
    sys.exit()
start = float(sys.argv[1]) if len(sys.argv) > 1 else float(rows[0][0]) - 1
seconds = float(rows[-1][0]) - start
frames = sum(int(r[1]) for r in rows)
hitches = sum(int(r[2]) for r in rows)
hitch_ms = sum(float(r[3]) for r in rows)
longest = max(float(r[4]) for r in rows)
print(f"{hitch_ms / seconds:.1f} {hitches / seconds:.1f} {frames / seconds:.0f} {longest:.0f}")
