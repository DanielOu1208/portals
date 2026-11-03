"""What a scripts/blank-bench.sh run saw: the openings, the blank chats the probe noted
(BlankProbe.swift) and how each ended, and the UI test's looks at the screen.

    python3 -I scripts/blank-bench/summary.py <out>
"""

import json
import math
import sys
from pathlib import Path

out = Path(sys.argv[1])
ids = json.loads((out / "ids.json").read_text()) if (out / "ids.json").exists() else {}
names = {thread: name for name, thread in ids.items()}

events = []
invalid = []
if (out / "blank.jsonl").exists():
    for line in (out / "blank.jsonl").read_text().splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            invalid.append("malformed probe event")

marks = []
if (out / "marks.txt").exists():
    for line in (out / "marks.txt").read_text().splitlines():
        parts = line.split(" ", 1)
        if len(parts) == 2:
            marks.append((float(parts[0]), parts[1]))


def name(thread):
    return names.get(thread, thread[:8])


opens = [e for e in events if e["event"] == "open"]
taps = [m for m in marks if m[1].startswith("open ")]
print(f"chats opened (probe): {len(opens)}; rows tapped (UI test): {len(taps)}; relaunches: {sum(1 for m in marks if m[1] == 'relaunch')}")

# Each blank episode: its start, its longest persist, its end.
episodes = []
current = None
for e in events:
    if e["event"] == "blank":
        current = {"start": e, "persist": None, "clear": None, "repair": None}
        episodes.append(current)
    elif current is not None and e["event"] == "persist":
        current["persist"] = e
    elif current is not None and e["event"] == "repair":
        current["repair"] = e
    elif current is not None and e["event"] == "clear":
        current["clear"] = e
        current = None


def context(t):
    """The UI test's last step before time t, and how long before."""
    before = [m for m in marks if m[0] <= t]
    if not before:
        return "-"
    when, what = before[-1]
    return f"{what} ({t - when:.1f} s before)"


long = [ep for ep in episodes if (ep["clear"] or {}).get("ms", 10**9) >= 1000]
interrupted = [ep for ep in episodes if (ep["clear"] or {}).get("by") in {"aside", "gone"}]
print(f"blank episodes: {len(episodes)}; lasting 1 s or more (or never cleared): {len(long)}")
for ep in episodes:
    s, c = ep["start"], ep["clear"]
    ms = c["ms"] if c else None
    by = c.get("by") if c else "never cleared"
    print(
        f"  {name(s['thread'])}: turns {s['turns']}, content {s['content']}, offset {s['offset']}, dist {s['dist']}, "
        f"built {s['built'] or '-'}, last {s.get('last_frame')}, stack {s.get('stack_frame')}, end {s.get('end_frame')}, "
        f"{s['since_open_ms']} ms after open; cleared {ms} ms by {by}"
        + (f" (repair at {ep['repair']['ms']} ms)" if ep["repair"] else "")
        + (f", then built {c['built'] or '-'}, offset {c['offset']}, dist {c['dist']}, in view {c['in_view']}" if c else "")
        + f"; after: {context(s['t'])}"
    )
by_cause = {}
for ep in episodes:
    cause = ep["clear"]["by"] if ep["clear"] else "never"
    by_cause[cause] = by_cause.get(cause, 0) + 1
if episodes:
    print("  ended by: " + ", ".join(f"{cause} {n}" for cause, n in sorted(by_cause.items())))
    repaired = [ep["clear"]["ms"] for ep in episodes if ep["clear"] and ep["clear"]["by"] == "repair"]
    if repaired:
        repaired.sort()
        print(f"  blank for, when repaired: {repaired[0]}–{repaired[-1]} ms (median {repaired[len(repaired) // 2]})")

inks = [(t, m) for t, m in marks if m.startswith("ink ")]
low = [(t, m) for t, m in inks if float(m.split()[1]) < 0.002]
print(f"screen looks: {len(inks)}; with almost no text in the chat's middle: {len(low)}")
for t, m in low:
    print(f"  {m} at {t:.3f}")
values = sorted(float(m.split()[1]) for _, m in inks)
if values:
    print(f"  ink: min {values[0]:.4f}, median {values[len(values) // 2]:.4f}, max {values[-1]:.4f}")
missing = [m for _, m in marks if m.startswith("no-row") or m.startswith("no-sidebar") or m.startswith("unknown")]
if missing:
    print(f"steps not taken: {len(missing)}: {', '.join(missing[:8])}")

failures = list(invalid)
if not opens:
    failures.append("no probe openings")
if not taps or not inks or not any(m == "done" for _, m in marks):
    failures.append("missing completed UI measurements")
if missing:
    failures.append("steps not taken")
if long:
    failures.append("blank for at least 1 s or never cleared")
if interrupted:
    failures.append("chat left blank when hidden or closed (aside/gone)")
if low or any(not math.isfinite(value) or not 0 <= value <= 1 for value in values):
    failures.append("blank or invalid screen measurement")
print("FAIL: " + "; ".join(failures) if failures else "PASS: completed, measured openings")
sys.exit(bool(failures))
