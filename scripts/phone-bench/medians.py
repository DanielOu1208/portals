#!/usr/bin/env python3 -I
"""Medians of scripts/phone-bench.sh's results.txt, per app and stretch, in the order seen.

    python3 -I scripts/phone-bench/medians.py <results.txt>
"""
import collections, statistics, sys

rows = collections.OrderedDict()
for line in open(sys.argv[1]):
    parts = line.split()
    if len(parts) < 3:
        continue
    values = {}
    for part in parts[2:]:
        key, _, value = part.partition("=")
        try:
            # Old logs appended sampler CPU after the authoritative poll measurement.
            values.setdefault(key, float(value))
        except ValueError:
            pass
    rows.setdefault((parts[1], parts[0]), []).append(values)
stretches = list(dict.fromkeys(k[0] for k in rows))
labels = list(dict.fromkeys(k[1] for k in rows))
for (stretch, label), runs in sorted(rows.items(), key=lambda kv: (stretches.index(kv[0][0]), labels.index(kv[0][1]))):
    keys = [k for k in ("cpu", "main", "secs", "mains", "span", "hitch", "hitches", "fps", "longest", "wash", "wakeups", "power") if any(k in r for r in runs)]
    cells = []
    for key in keys:
        xs = [r[key] for r in runs if key in r]
        cells.append("%s=%s" % (key, ("%.1f" % statistics.median(xs)) if xs else "-"))
    print("%-16s %-10s runs=%d %s" % (stretch, label, len(runs), " ".join(cells)))
