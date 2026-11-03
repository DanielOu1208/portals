#!/usr/bin/env python3 -I
"""Where the app's own code is in a Time Profiler recording, as xctrace exports it (see
scripts/app-footprint/timeprofile.py): for each sample, the frames that are the app's (in
a binary inside the .app), and of them the one nearest the top of the stack, which
answers for everything above it (SwiftUI's and UIKit's work done for it).

    appframes.py <export.xml> [thread]   # thread: "Main Thread" by default

Prints the samples of the thread, then the app frames most often anywhere in the stack
(inclusive), then most often the nearest (what the work above them was done for), each
with its share of the thread's samples. A sample is a millisecond of the thread's CPU.
The app's entry point (`main`, `PortalsApp.$main`) is left out: every sample has it.
"""
import collections
import sys
import xml.etree.ElementTree as ET


def stacks(path):
    """Each sample's thread name and its frames, the top of the stack first, each as
    (name, whether it is in the app's own binaries)."""
    frames, backtraces, threads, binaries = {}, {}, {}, {}
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
            found = backtraces.get(backtrace.get("ref"), [])
        else:
            found = []
            for frame in backtrace.iter("frame"):
                if frame.get("ref"):
                    found.append(frames.get(frame.get("ref"), ("?", False)))
                    continue
                binary = frame.find("binary")
                mine = False
                if binary is not None:
                    if binary.get("ref"):
                        mine = binaries.get(binary.get("ref"), False)
                    else:
                        mine = ".app/" in (binary.get("path") or "")
                        binaries[binary.get("id")] = mine
                entry = (frame.get("name", "?"), mine)
                frames[frame.get("id")] = entry
                found.append(entry)
            backtraces[backtrace.get("id")] = found
        yield name, found


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = argv[1]
    thread = argv[2] if len(argv) > 2 else "Main Thread"
    entry = ("main", "PortalsApp.$main", "PortalsApp.main")
    samples = [names for name, names in stacks(path) if name == thread]
    total = max(len(samples), 1)
    inclusive = collections.Counter()
    nearest = collections.Counter()
    none = 0
    for names in samples:
        mine = [n for n, app in names if app and not any(n == e or n.endswith(e + "()") for e in entry)]
        if not mine:
            none += 1
            continue
        nearest[mine[0]] += 1
        inclusive.update(set(mine))
    print(f"{len(samples)} samples on {thread}; {100.0 * none / total:.1f}% with no app frame")
    print("--- app frames anywhere in the stack")
    for name, count in inclusive.most_common(45):
        print(f"{count:6} {100.0 * count / total:5.1f}%  {name[:150]}")
    print("--- the app frame nearest the top (the work above it was for it)")
    for name, count in nearest.most_common(35):
        print(f"{count:6} {100.0 * count / total:5.1f}%  {name[:150]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
