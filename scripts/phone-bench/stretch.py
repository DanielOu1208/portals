#!/usr/bin/env python3 -I
"""What the app did over a stretch of a phone-bench run.

    python3 -I scripts/phone-bench/stretch.py <poll.txt> <frames.txt> <from unix time> <to unix time>

poll.txt is threads.py's `poll` output (<unix time> <CPU s> <main CPU s> <frame lines>),
frames.txt the app's frame meter (FrameMeter.swift: <t> <frames> <hitches> <hitch ms>
<longest ms>, about a line a second). Prints "cpu=<%> main=<%> hitch=<ms a second>
hitches=<a second> fps=<frames a second> longest=<ms> secs=<CPU seconds> mains=<main thread
CPU seconds> span=<seconds>". The seconds of CPU are the work done, which a loaded Mac
spreads over more time: compare them where the work is fixed (a whole reply, the UI test's
gestures).
"""
import sys

poll = [tuple(float(x) for x in l.split()) for l in open(sys.argv[1]) if len(l.split()) == 4]
frames = [l.split() for l in open(sys.argv[2]) if len(l.split()) == 5]
t0, t1 = float(sys.argv[3]), float(sys.argv[4])
a = min(poll, key=lambda p: abs(p[0] - t0))
b = min(poll, key=lambda p: abs(p[0] - t1))
span = b[0] - a[0]
cpu = 100 * (b[1] - a[1]) / span if span > 0 else float("nan")
main = 100 * (b[2] - a[2]) / span if span > 0 else float("nan")
# The meter's lines written within the stretch (line counts at its ends).
rows = frames[int(a[3]):int(b[3])]
work = "secs=%.2f mains=%.2f span=%.1f" % (b[1] - a[1], b[2] - a[2], span)
if len(rows) >= 2:
    start = float(frames[int(a[3]) - 1][0]) if int(a[3]) > 0 else float(rows[0][0]) - 1
    seconds = float(rows[-1][0]) - start
    count = sum(int(r[1]) for r in rows)
    print("cpu=%.1f main=%.1f hitch=%.1f hitches=%.1f fps=%.0f longest=%.0f %s" % (
        cpu, main, sum(float(r[3]) for r in rows) / seconds, sum(int(r[2]) for r in rows) / seconds,
        count / seconds, max(float(r[4]) for r in rows), work))
else:
    print("cpu=%.1f main=%.1f hitch=- hitches=- fps=- longest=- %s" % (cpu, main, work))
