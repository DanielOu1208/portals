# What each tab switch took, from the probe's lines on stdin (SidebarProbe, TabsBench) and
# the open probe's (OpenProbe), for scripts/tabs-bench.sh:
#
#   switches.py <open.jsonl> <its lines before the switches>  < probe lines since then
#
# For each `tab-switch`: `tab-frame`, the time until the main thread could draw again;
# `drawn`, until the chat was on screen and the next frame came (`chat-shown`, then its
# `chat-drawn`), at once for a thread still in memory (warm) or after its saved copy was
# read off the main thread (saved); and the open probe's `content_ms`, until a frame
# showed the thread's turns. `kept` openings were of a chat kept built off screen. Prints key=value pairs: medians, the 90th percentile and the
# longest, in ms.
import json
import statistics
import sys


def stats(name, values):
    if not values:
        return f"{name}_ms=-"
    values = sorted(values)
    p90 = values[min(len(values) - 1, int(round(0.9 * (len(values) - 1))))]
    return f"{name}_ms={statistics.median(values):.1f} {name}_p90_ms={p90:.1f} {name}_max_ms={values[-1]:.1f}"


lines = [line.split() for line in sys.stdin if len(line.split()) >= 2]
switches, frames, drawn = [], [], []
pending_frame = pending_shown = None
shown_at = None
for parts in lines:
    t, event = float(parts[0]), parts[1]
    if event == "tab-switch":
        switches.append(t)
        pending_frame = pending_shown = t
        shown_at = None
    elif event == "tab-frame" and pending_frame is not None:
        frames.append(float(parts[2]))
        pending_frame = None
    elif event == "chat-shown" and pending_shown is not None:
        shown_at = t
    elif event == "chat-drawn" and pending_shown is not None and shown_at is not None:
        drawn.append(t - pending_shown)
        pending_shown = shown_at = None

content, how = [], {}
try:
    with open(sys.argv[1]) as file:
        records = [json.loads(line) for line in file.read().splitlines()[int(sys.argv[2]):] if line.strip()]
except (OSError, ValueError, IndexError):
    records = []
for record in records:
    how[record.get("how", "?")] = how.get(record.get("how", "?"), 0) + 1
    if "content_ms" in record:
        content.append(record["content_ms"])

print(" ".join([
    f"tab_switches={len(switches)}",
    stats("tab_frame", frames),
    stats("drawn", drawn),
    stats("content", content),
    f"opened_kept={how.get('kept', 0)} opened_warm={how.get('warm', 0)} opened_saved={how.get('saved', 0) + how.get('load', 0)} opened_cold={how.get('cold', 0)}",
]))
