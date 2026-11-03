# Medians per app and thread length from mac-scroll-bench.sh's results.txt. Each line:
#   <label> <turns> <cpu %> <streaming> <streaming+scrolling> <main busy %> <rest+scrolling>
# where each frames field is "<hitch ms/s>,<hitches/s>,<frames/s>,<longest ms>".
import statistics
import sys
from collections import defaultdict

runs = defaultdict(list)
for line in open(sys.argv[1]):
    parts = line.split()
    if len(parts) != 7:
        continue
    runs[(parts[0], int(parts[1]))].append(parts[2:])


def median(values):
    numbers = []
    for value in values:
        try:
            numbers.append(float(value.rstrip("%")))
        except ValueError:
            pass
    return f"{statistics.median(numbers):.1f}" if numbers else "-"


def field(items, index, part):
    return median([item[index].split(",")[part] for item in items if len(item[index].split(",")) > part])


print("medians; hitch ms/s (hitches/s, fps, longest frame ms)")
print(f"{'app':10} {'turns':>5} {'runs':>4} {'cpu% stream':>11}   {'streaming':<26} {'streaming+scrolling':<26} {'main busy':>9}   {'rest+scrolling':<26}")
for (label, turns), items in sorted(runs.items()):
    def frames(index):
        return f"{field(items, index, 0)} ({field(items, index, 1)}, {field(items, index, 2)}, {field(items, index, 3)})"
    print(f"{label:10} {turns:>5} {len(items):>4} {median([i[0] for i in items]):>11}   {frames(1):<26} {frames(2):<26} {median([i[3] for i in items]):>9}   {frames(4):<26}")
