#!/usr/bin/env python3
"""What moved when the app came back, from scripts/return-bench.sh's files.

    summary.py <run dir> <bytes.txt>

For each return (a `back` line in marks.txt), over the 3 s after it:
- moved: probed views (sidebar rows, group titles, the chat's turns, the composer) whose
  frame went more than half a point from where it was before the return (or from its
  first frame, for one that came after it), and the largest such distance; the chat's
  scroll position (`chat-scroll`, its offset and its content's height) apart. A view that
  left (`gone`) or came (first frame) counts as such.
- seen: a return counts only if the probe saw the app come back within the 3 s (its
  scene active, or on a Mac the app active or shown, or its window visible again: never
  the background phase or a window covered); one it did
  not see (the step to bring the app back failed) is left out and said, never counted as
  "moved 0".
- current: from the return to the connection back, the agents listed, the list merged
  (`list-held`, same or changed) and the open thread caught up (`thread-caught-up`) or
  taken whole (`thread-snapshot`), whichever came first, within 10 s. Thread events
  count only for the latest `shown` identity; without it thread freshness is unknown.
- bytes: up and down through the counting relay, from the return to 10 s after it or the
  next `away`, whichever is first; "n/a" when the relay wrote nothing.
"""
import sys
from collections import defaultdict

WINDOW = 3.0
CURRENT = 10.0
# What the probe notes as the app comes back, never as it leaves: the scene active (every
# device), and on a Mac the app active or shown again, or its window uncovered.
SEEN = {("phase", "active"), ("app-active", "-"), ("app-shown", "-"), ("occlusion", "visible")}
LEAD = 0.5


def read_probe(path):
    lines = []
    with open(path) as f:
        for raw in f:
            parts = raw.split()
            if len(parts) < 3:
                continue
            try:
                t = float(parts[0])
            except ValueError:
                continue
            lines.append((t, parts[1], parts[2], [float(x) for x in parts[3:7]] if len(parts) >= 7 else None))
    return lines


def read_marks(path):
    marks = []
    with open(path) as f:
        for raw in f:
            t, what, kind = raw.split()
            marks.append((float(t), what, kind))
    return marks


def read_bytes(path):
    rows = []
    try:
        with open(path) as f:
            for raw in f:
                t, up, down = raw.split()
                rows.append((float(t), int(up), int(down)))
    except FileNotFoundError:
        pass
    return rows


def bytes_at(rows, t):
    last = (0, 0)
    for when, up, down in rows:
        if when > t:
            break
        last = (up, down)
    return last


def main():
    run, bytes_path = sys.argv[1], sys.argv[2]
    probe = read_probe(f"{run}/probe.txt")
    marks = read_marks(f"{run}/marks.txt")
    traffic = read_bytes(bytes_path)
    backs = [(t, kind) for t, what, kind in marks if what == "back"]
    aways = [t for t, what, _ in marks if what == "away"]
    by_kind = defaultdict(list)
    for index, (mark, kind) in enumerate(backs):
        # From when the probe saw the app come back, if that was before the mark (a window
        # uncovered is noted as the cover goes, a moment before the bench marks it back):
        # what moved from then on is the return's, not the baseline's.
        seen_at = [t for t, what, key, _ in probe if (what, key) in SEEN and mark - LEAD <= t <= mark]
        t0 = min(seen_at + [mark])
        before = {}
        for t, what, key, rect in probe:
            if t >= t0:
                break
            if what == "frame":
                before[key] = rect
            elif what == "gone":
                before.pop(key, None)
        moved, came, went, scroll = {}, set(), set(), []
        now = dict(before)
        # Where each view was before the return, or first was after it: how far it went
        # is measured from there, not from its last frame (three steps of 10 points are 30).
        origin = dict(before)
        # The window uncovered is noted a moment before the bench marks it back.
        seen = any((what, key) in SEEN for t, what, key, _ in probe if mark - LEAD <= t <= mark + WINDOW)
        for t, what, key, rect in probe:
            if t < t0 or t > t0 + WINDOW:
                continue
            if what == "frame":
                if key == "chat-scroll":
                    old = now.get(key)
                    if old and (abs(old[1] - rect[1]) > 0.5 or abs(old[3] - rect[3]) > 0.5):
                        scroll.append((round(t - t0, 2), int(rect[1] - old[1]), int(rect[3] - old[3])))
                else:
                    # Not there until now: it came (again, after it went).
                    if key not in now:
                        came.add(key)
                    if key in origin:
                        delta = max(abs(a - b) for a, b in zip(origin[key], rect))
                        if delta > 0.5:
                            moved[key] = max(moved.get(key, 0), delta)
                    else:
                        origin[key] = rect
                now[key] = rect
            elif what == "gone":
                went.add(key)
                now.pop(key, None)
        events = {}
        # Up to the next leaving, or 10 s: what comes after that is the next return's.
        end = min([t for t in aways if t > t0] + [t0 + CURRENT])
        shown = None
        for t, what, key, rect in probe:
            if what == "shown":
                shown = key if key != "new" else None
            if t < t0 or t > end:
                continue
            if what in ("thread-caught-up", "thread-snapshot") and (shown is None or key != shown):
                continue
            name = what if what not in ("connection",) else f"connection:{key.split('(')[0]}"
            if what == "list-held":
                name = f"list-held:{key}"
            if name not in events and what not in ("frame", "gone"):
                events[name] = round(t - t0, 2)
        if not seen:
            print(f"!! {kind} return at {mark:.3f}: the app was not seen coming back within {WINDOW:.0f} s; left out")
            by_kind[kind]
            continue
        up0, down0 = bytes_at(traffic, t0)
        up1, down1 = bytes_at(traffic, end)
        by_kind[kind].append({
            "moved": len(moved), "largest": max(moved.values(), default=0),
            "came": len(came - went), "went": len(went - came), "rebuilt": len(came & went),
            "scroll": scroll, "events": events,
            "up": up1 - up0 if traffic else "n/a", "down": down1 - down0 if traffic else "n/a",
            "movers": sorted(moved, key=lambda k: -moved[k])[:6],
        })
    for kind, runs in by_kind.items():
        print(f"== {kind} ({len(runs)} returns seen)")
        for r in runs:
            print(f"  moved {r['moved']} (largest {r['largest']:.0f} pt), came {r['came']}, went {r['went']}, rebuilt {r['rebuilt']}; "
                  f"scroll {r['scroll'][:4]}{'…' if len(r['scroll']) > 4 else ''}; bytes up {r['up']} down {r['down']}")
            if r["movers"]:
                print(f"    movers: {', '.join(r['movers'])}")
            print(f"    events: {', '.join(f'{k} {v}s' for k, v in sorted(r['events'].items(), key=lambda kv: kv[1]))}")


if __name__ == "__main__":
    main()
