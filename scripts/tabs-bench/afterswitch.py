#!/usr/bin/env python3 -I
"""When the main thread works after each tab switch, in a Time Profiler recording of the
tabs bench (scripts/tabs-bench.sh --profile, its tabs.trace exported as xml): the switch
itself (a sample in `TabsBench.switchTabs` starts one), then what follows it.

    afterswitch.py <export.xml> [<frame name part> …]

Prints the main thread's milliseconds per switch in 50 ms steps after it, then for the
switch itself (0 to 120 ms after) and for what follows (150 to 680 ms after) how many of
them had a frame whose name holds each part given (`AgentSidebar`, `NewTabButton`,
`RBInterpolatedDisplayListContents`…), and the frames most often in the second.
"""
import bisect
import collections
import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from appframes import stacks  # noqa: E402


def sample_times(path):
    """Each sample's time in ns, in the order `stacks` gives the samples."""
    times, known = [], {}
    for row in ET.parse(path).getroot().iter("row"):
        time = row.find("sample-time")
        if time is None or (row.find("tagged-backtrace") is None and row.find("backtrace") is None):
            continue
        if time.get("ref"):
            times.append(known[time.get("ref")])
        else:
            known[time.get("id")] = int(time.text)
            times.append(known[time.get("id")])
    return times


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    path, parts = argv[1], argv[2:]
    samples = list(stacks(path))
    times = sample_times(path)
    main_thread = [(t, names) for t, (thread, names) in zip(times, samples) if thread == "Main Thread"]
    onsets = []
    for t, names in main_thread:
        if any("TabsBench.switchTabs" in name for name, _ in names) and (not onsets or t - onsets[-1] > 300e6):
            onsets.append(t)
    count = max(len(onsets), 1)
    print(f"{len(onsets)} switches")

    def after(t):
        index = bisect.bisect_right(onsets, t) - 1
        return None if index < 0 else (t - onsets[index]) / 1e6

    steps = collections.Counter()
    for t, _ in main_thread:
        ms = after(t)
        if ms is not None and ms < 800:
            steps[int(ms // 50) * 50] += 1
    for step in sorted(steps):
        print(f"{step:4}-{step + 50:4} ms after: {steps[step] / count:6.1f} ms of the main thread a switch")

    for low, high in ((0, 120), (150, 680)):
        picked = [names for t, names in main_thread if (ms := after(t)) is not None and low <= ms < high]
        print(f"=== {low}-{high} ms after: {len(picked) / count:.1f} ms a switch")
        for part in parts:
            hit = sum(1 for names in picked if any(part in name for name, _ in names))
            print(f"  {part:50} {hit / count:6.1f} ms a switch ({100 * hit / max(len(picked), 1):.0f}%)")
        if low == 150:
            anywhere = collections.Counter()
            for names in picked:
                anywhere.update(set(name for name, _ in names))
            print("  frames most often there:")
            for name, hits in anywhere.most_common(90)[25:90]:
                print(f"  {hits / count:6.1f}  {name[:130]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
