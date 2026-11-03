# The share of samples in which the main thread was doing something, from a `sample`
# report: everything but waiting in the run loop for the next event (mach_msg2_trap).
# Part of scripts/mac-scroll-bench.sh.
import re
import sys

lines = open(sys.argv[1]).read().splitlines()
node = re.compile(r"^([ +!:|]*)(\d+) (.*)$")
main = []
for line in lines:
    if re.match(r"^\s+\d+ Thread_\d+", line):
        if main:
            break
        if "Main Thread" in line or "com.apple.main-thread" in line:
            main.append(line)
        continue
    if main:
        main.append(line)
if not main:
    print("-")
    sys.exit()
total = int(node.match(main[0]).group(2))
idle = 0
open_at = None
for line in main[1:]:
    m = node.match(line)
    if not m:
        continue
    depth = len(m.group(1))
    if open_at is not None and depth <= open_at:
        open_at = None
    if open_at is None and m.group(3).startswith("mach_msg2_trap"):
        idle += int(m.group(2))
        open_at = depth
print(f"{100 * (total - idle) / total:.0f}%")
