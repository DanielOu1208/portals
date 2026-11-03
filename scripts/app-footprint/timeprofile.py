#!/usr/bin/env python3 -I
"""Reads a Time Profiler recording of the app, as xctrace exports it, and says where the
CPU went: samples by thread, the frames most often on top, and the frames most often
anywhere in the stack (inclusive).

    xctrace record --template 'Time Profiler' --attach <pid> --time-limit 10s --output r.trace
    xctrace export --input r.trace \\
        --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]' > r.xml
    scripts/app-footprint/timeprofile.py r.xml                  # the summary
    scripts/app-footprint/timeprofile.py r.xml --share AgentSidebar Fleet.layout
                                                                # samples with any of these
    scripts/app-footprint/timeprofile.py r.xml --under GraphHost.flushTransactions 4
                                                                # what a frame calls, 4 deep

A sample is a millisecond of one thread's CPU: samples over the recording's seconds,
divided by ten, is the percentage of a core.
"""
import collections
import sys
import xml.etree.ElementTree as ET


def stacks(path):
    """Each sample's thread name and its frames, the top of the stack first."""
    frames, backtraces, threads = {}, {}, {}
    for row in ET.parse(path).getroot().iter("row"):
        thread = row.find("thread")
        name = "?"
        if thread is not None:
            if thread.get("ref"):
                name = threads.get(thread.get("ref"), "?")
            else:
                name = thread.get("fmt", "?").split(" (")[0]
                threads[thread.get("id")] = name
        backtrace = row.find("tagged-backtrace")
        if backtrace is None:
            backtrace = row.find("backtrace")
        if backtrace is None:
            continue
        if backtrace.get("ref"):
            names = backtraces.get(backtrace.get("ref"), [])
        else:
            names = []
            for frame in backtrace.findall("frame"):
                if frame.get("ref"):
                    names.append(frames.get(frame.get("ref"), "?"))
                else:
                    frames[frame.get("id")] = frame.get("name", "?")
                    names.append(frame.get("name", "?"))
            backtraces[backtrace.get("id")] = names
        yield name, names


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = argv[1]
    samples = list(stacks(path))
    if len(argv) > 2 and argv[2] == "--share":
        wanted = argv[3:]
        hit = sum(1 for _, names in samples if any(w in n for n in names for w in wanted))
        print(f"{hit} of {len(samples)} samples ({100.0 * hit / max(len(samples), 1):.1f}%)")
        return 0
    if len(argv) > 3 and argv[2] == "--under":
        target, depth = argv[3], int(argv[4]) if len(argv) > 4 else 1
        calls = collections.Counter()
        for _, names in samples:
            for index, name in enumerate(names):
                if target in name:
                    below = names[max(0, index - depth):index][::-1]
                    calls[" > ".join(n[:70] for n in below) or "(itself)"] += 1
                    break
        for path_, count in calls.most_common(40):
            print(count, path_)
        return 0
    by_thread = collections.Counter(name for name, _ in samples)
    top = collections.Counter(names[0] for _, names in samples if names)
    anywhere = collections.Counter()
    for _, names in samples:
        anywhere.update(set(names))
    print("samples", len(samples))
    print("--- by thread")
    for name, count in by_thread.most_common(8):
        print(count, name)
    print("--- on top")
    for name, count in top.most_common(25):
        print(count, name[:150])
    print("--- anywhere in the stack")
    for name, count in anywhere.most_common(80):
        print(count, name[:150])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
