"""The numbers of scripts/open-bench.sh.

    summary.py line <app label> <labels.txt> <probe.jsonl> <load>
        one line per opening of a run: its case, thread, and what the probe measured
    summary.py medians <runs.txt>
        the medians per app and case over every run listed (`<label> <dir>` per line)
"""

import json
import os
import statistics
import sys

FIELDS = ["laid_out_ms", "content_ms", "first_dist", "moves", "lags", "settled_ms", "max_dist", "saved_took_ms", "fetched_ms", "fetched_took_ms", "adopted_took_ms"]


# How each case's thread is to be opened (the probe's `how`).
EXPECTED_HOW = {"cold": "cold", "cold-small": "cold", "warm": "warm", "saved": "saved", "relaunch": "saved"}


class Invalid(Exception):
    """A run whose measurements cannot be matched to its plan: left out, never counted."""


def openings(labels_path, probe_path):
    """Each opening of a run, (case, thread, probe line), checked against the plan first:
    a run marked incomplete by open-bench.sh, with more or fewer openings measured than
    planned, or with a measured thread that is not the one planned at its place or not
    opened as its case says (cold, warm, saved), is Invalid: pairing them by position
    would give one thread's numbers, or one way of opening, to another."""
    folder = os.path.dirname(os.path.abspath(probe_path))
    marker = os.path.join(folder, "incomplete")
    if os.path.exists(marker):
        raise Invalid(open(marker).read().strip() or "the run did not open every thread")
    if not os.path.exists(labels_path) or not os.path.exists(probe_path):
        raise Invalid("the run did not finish (no plan or no measurements written)")
    labels = open(labels_path).read().split()
    lines = [json.loads(line) for line in open(probe_path) if line.strip()]
    if len(lines) != len(labels):
        raise Invalid(f"{len(lines)} openings measured for {len(labels)} planned")
    ids_path = os.path.join(os.path.dirname(folder), "ids.json")
    ids = json.load(open(ids_path)) if os.path.exists(ids_path) else None
    result = []
    for label, line in zip(labels, lines):
        case, thread = label.split(":")
        if ids is not None and line.get("thread") != ids.get(thread):
            raise Invalid(f"{label}: measured thread {line.get('thread')}, planned {ids.get(thread)}")
        # Opened as the case says: from the host, from memory, or from the saved copy.
        expected = EXPECTED_HOW.get(case)
        if expected is not None and line.get("how") != expected:
            raise Invalid(f"{label}: opened {line.get('how')}, not {expected}")
        result.append((case, thread, line))
    return result


def show(value):
    return "-" if value is None else str(value)


def line(app, labels_path, probe_path, load):
    print(f"{app} load=[{load}]")
    try:
        measured = openings(labels_path, probe_path)
    except Invalid as error:
        print(f"  INVALID run, left out of the medians: {error}")
        return
    for case, thread, probe in measured:
        values = " ".join(f"{name}={show(probe.get(name))}" for name in FIELDS)
        print(f"  {case:10} {thread:9} how={probe.get('how')} {values} trace={probe.get('trace')}")


def medians(runs_path):
    table = {}
    left_out = []
    for entry in open(runs_path):
        app, folder = entry.split()
        try:
            measured = openings(f"{folder}/labels.txt", f"{folder}/probe.jsonl")
        except Invalid as error:
            left_out.append(f"{folder}: {error}")
            continue
        for case, thread, probe in measured:
            key = (app, case if case in ("cold-small",) else f"{case}:{thread}")
            for name in FIELDS:
                if name in probe:
                    table.setdefault(key, {}).setdefault(name, []).append(probe[name])
            # A thread never settled at its end within the 3 s counts as 3000; one never
            # shown, as never settled, and is counted apart (not a clean opening).
            if "settled_ms" not in probe:
                table.setdefault(key, {}).setdefault("settled_ms", []).append(3000)
            if "content_ms" not in probe:
                table.setdefault(key, {}).setdefault("not_shown", []).append(1)
            table.setdefault(key, {}).setdefault("n", []).append(1)
    print("medians (n = openings):")
    for (app, case), values in sorted(table.items(), key=lambda item: (item[0][1], item[0][0])):
        parts = []
        for name in FIELDS:
            if name in values:
                parts.append(f"{name}={round(statistics.median(values[name]))}")
        if "not_shown" in values:
            parts.append(f"NOT_SHOWN={len(values['not_shown'])}")
        print(f"  {case:16} {app:6} n={len(values['n'])} " + " ".join(parts))
    for entry in left_out:
        print(f"  LEFT OUT (invalid run) {entry}")


if __name__ == "__main__":
    if sys.argv[1] == "line":
        line(*sys.argv[2:6])
    else:
        medians(sys.argv[2])
