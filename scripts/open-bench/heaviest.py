"""The heaviest frames of the main thread in a `sample` report: for each function, the
most samples it was seen under on the main thread (inclusive), the top 60, and how many
samples the main thread had in all and how many of them it was idle (in mach_msg).

    python3 heaviest.py <sample report>
"""

import re
import sys

lines = open(sys.argv[1]).read().split("\n")
# The main thread's tree runs from its "Thread_… DispatchQueue_1: com.apple.main-thread"
# line to the next thread's.
start = next((i for i, line in enumerate(lines) if "com.apple.main-thread" in line or ": Main Thread" in line), None)
if start is None:
    sys.exit("no main thread in the report")
end = next((i for i in range(start + 1, len(lines)) if re.match(r"^\s{4}\d+ Thread_", lines[i])), len(lines))
total = int(re.match(r"^\s*(\d+)", lines[start]).group(1))
heaviest = {}
idle = 0
for line in lines[start + 1:end]:
    match = re.match(r"^[\s+!:|]*(\d+)\s+(.*?)\s+\(in ([^)]+)\)", line)
    if not match:
        continue
    count, name, image = int(match.group(1)), match.group(2)[:110], match.group(3)
    heaviest[(name, image)] = max(heaviest.get((name, image), 0), count)
    if name.startswith("mach_msg2_trap"):
        idle = max(idle, count)
print(f"main thread: {total} samples, idle (mach_msg) {idle}, busy {total - idle}")
for (name, image), count in sorted(heaviest.items(), key=lambda item: -item[1])[:60]:
    print(f"{count:6} {image:24} {name}")
