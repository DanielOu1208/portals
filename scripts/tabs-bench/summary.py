# Medians per app of scripts/tabs-bench.sh's results.txt, whose lines are key=value
# pairs (label=…, round=…, then numbers), with each app's spread (lowest to highest of
# its runs) and, for two apps, the second against the first in percent.
#
#   summary.py <results.txt> [<label> …]   (the apps in that order; else as first seen)
import statistics
import sys
from collections import OrderedDict

runs = OrderedDict()
keys = []
for line in open(sys.argv[1]):
    pairs = dict(part.split("=", 1) for part in line.split() if "=" in part)
    label = pairs.pop("label", "?")
    pairs.pop("round", None)
    runs.setdefault(label, []).append(pairs)
    for key in pairs:
        if key not in keys:
            keys.append(key)
labels = sys.argv[2:] or list(runs)


def numbers(label, key):
    found = []
    for run in runs.get(label, []):
        try:
            found.append(float(run.get(key, "-")))
        except ValueError:
            pass
    return found


print(f"medians of the runs (lowest-highest); {', '.join(f'{l}: {len(runs.get(l, []))} runs' for l in labels)}")
header = f"{'':34}" + "".join(f"{l:>26}" for l in labels) + ("     B vs A" if len(labels) == 2 else "")
print(header)
for key in keys:
    cells, medians = [], []
    for label in labels:
        values = numbers(label, key)
        if values:
            median = statistics.median(values)
            medians.append(median)
            # Two decimals for small numbers (CPU % at rest), one otherwise.
            digits = 2 if max(abs(v) for v in values) < 10 else 1
            cells.append(f"{median:9.{digits}f} ({min(values):.{digits}f}-{max(values):.{digits}f})")
        else:
            medians.append(None)
            cells.append("-")
    change = ""
    if len(labels) == 2 and medians[0] and medians[1] is not None:
        change = f"{100 * (medians[1] - medians[0]) / medians[0]:+10.0f}%"
    print(f"{key:34}" + "".join(f"{c:>26}" for c in cells) + change)
