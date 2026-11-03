"""A Markdown table of an open-bench run (scripts/open-bench.sh), A against B, per case:
how many openings jumped or glided, the farthest first frame from the end, the frames
moved, and the medians of the first frame shown and of settled at the end.

    python3 scripts/open-bench/table.py <OUT of open-bench.sh> [A] [B]
"""

import glob
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from summary import Invalid, openings  # noqa: E402

out = sys.argv[1]
apps = sys.argv[2:4] or ["A", "B"]
order = ["warm:t45", "warm:t120", "saved:t45", "saved:t120", "relaunch:t45", "relaunch:t120",
         "cold:t1", "cold:t10", "cold:t45", "cold:t120", "cold:long", "cold:approval", "cold:running", "cold-small"]
names = {"warm:t45": "warm, 45 turns", "warm:t120": "warm, 120 turns", "saved:t45": "saved copy, 45",
         "saved:t120": "saved copy, 120", "relaunch:t45": "after a relaunch, 45", "relaunch:t120": "after a relaunch, 120",
         "cold:t1": "cold, 1 turn", "cold:t10": "cold, 10", "cold:t45": "cold, 45", "cold:t120": "cold, 120",
         "cold:long": "cold, very long last reply", "cold:approval": "cold, approval waiting",
         "cold:running": "cold, turn running", "cold-small": "cold, short (9 a run)"}
cases = {}
left_out = []
for app in apps:
    for folder in sorted(glob.glob(f"{out}/r*-{app}")):
        try:
            measured = openings(f"{folder}/labels.txt", f"{folder}/probe.jsonl")
        except Invalid as error:
            left_out.append(f"{os.path.basename(folder)}: {error}")
            continue
        for case, thread, probe in measured:
            key = "cold-small" if case == "cold-small" else f"{case}:{thread}"
            cases.setdefault(key, {}).setdefault(app, []).append(probe)


def cell(values, f):
    return " → ".join(f(values.get(app, [])) for app in apps)


def jumped(probes):
    # Never shown within the probe's 3 s is not a clean opening either.
    n = sum(1 for p in probes if "content_ms" not in p or p.get("moves", 0) > 0 or abs(p.get("first_dist", 0)) > 1)
    return f"{n}/{len(probes)}"


def farthest(probes):
    return str(max((abs(p.get("first_dist", 0)) for p in probes), default=0))


def moved(probes):
    return str(sum(p.get("moves", 0) for p in probes))


def median(name):
    def f(probes):
        values = [p.get(name, 3000 if name == "settled_ms" else None) for p in probes]
        values = [v for v in values if v is not None]
        return str(round(statistics.median(values))) if values else "-"
    return f


print(f"| Case | jumped or glided | farthest first frame, pt | frames moved | first frame shown, ms | at its end, ms |")
print("|---|---:|---:|---:|---:|---:|")
for key in order:
    if key not in cases:
        continue
    values = cases[key]
    print(f"| {names[key]} | {cell(values, jumped)} | {cell(values, farthest)} | {cell(values, moved)} | "
          f"{cell(values, median('content_ms'))} | {cell(values, median('settled_ms'))} |")
for entry in left_out:
    print(f"\nLeft out, invalid run: {entry}")
