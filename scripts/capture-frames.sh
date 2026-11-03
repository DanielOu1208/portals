#!/bin/sh
# Records real Hermes frames as a test fixture.
#
# Runs portals-probe against a local `hermes serve` (see scripts/dev-serve.sh), records
# every frame in both directions, strips personal and bulky fields, and writes
# Packages/PortalsKit/Tests/HermesBackendTests/Fixtures/NAME.jsonl.
#
#   scripts/capture-frames.sh handshake-profiles profiles
#   scripts/capture-frames.sh chat-text-complete chat --cwd /tmp/scratch "Say hello."
#   scripts/capture-frames.sh NAME --from raw.jsonl     # clean an existing capture
#
# Review the result before committing: the cleaning below covers the fields known to
# carry personal data, not everything a future Hermes version might add.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$ROOT/Packages/PortalsKit/Tests/HermesBackendTests/Fixtures"

if [ $# -lt 2 ]; then
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
fi

NAME="$1"
shift

if [ "$1" = "--from" ]; then
    RAW="$2"
else
    RAW="$(mktemp -t portals-capture)"
    trap 'rm -f "$RAW"' EXIT
    (cd "$ROOT/Packages/PortalsKit" && swift run -q portals-probe --capture "$RAW" "$@")
fi

python3 - "$RAW" "$FIXTURES/$NAME.jsonl" <<'PY'
import json
import os
import re
import sys

raw_path, out_path = sys.argv[1], sys.argv[2]

# Replaced wholesale: personal, or large and irrelevant to the client.
REPLACE = {
    "system_prompt": None,
    "credential_warning": None,
    "ui_meta": {},
    "ui_meta_revisions": {},
    "last_session": None,
    "canonical_session": None,
    "worker_session": None,
    "skills": {},
    "tools": {},
    "mcp_servers": [],
}
HOME = re.compile(r"/Users/[^/\"\s]+")
TEMP = re.compile(r"/(?:private/)?(?:tmp|var/folders)/[^\"\s]*")

records = [json.loads(line) for line in open(raw_path) if line.strip()]

# The working directory the session was created in becomes /tmp/aeriportal-cwd wherever it
# appears (tool arguments, results, diffs), so file names under it survive.
working_directories = set()


def find_working_directories(value):
    """Every `cwd` in a frame: session.create params, and the session info in results."""
    if isinstance(value, dict):
        cwd = value.get("cwd")
        if isinstance(cwd, str) and cwd.startswith("/"):
            bare = re.sub(r"^/private", "", cwd)
            working_directories.update({cwd, bare, "/private" + bare})
        for child in value.values():
            find_working_directories(child)
    elif isinstance(value, list):
        for child in value:
            find_working_directories(child)


for record in records:
    find_working_directories(record["frame"])


def clean(value, key=None):
    if key in REPLACE:
        return REPLACE[key]
    if key == "skin" and isinstance(value, dict):
        return {"name": value.get("name")}
    if isinstance(value, dict):
        return {k: clean(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, str):
        for directory in sorted(working_directories, key=len, reverse=True):
            value = value.replace(directory, "/tmp/aeriportal-cwd")
        if key == "cwd":
            value = TEMP.sub("/tmp/aeriportal-cwd", value)
        if key == "context":
            # Hermes shortens a long path here, so the exact directory no longer matches.
            value = TEMP.sub("/tmp/aeriportal-cwd/...", value)
        return HOME.sub("/Users/dev", value)
    return value


count = 0
with open(out_path, "w") as target:
    for record in records:
        record["frame"] = clean(record["frame"])
        target.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        count += 1

print(f"wrote {count} frames to {os.path.relpath(out_path)} ({os.path.getsize(out_path)} bytes)")
PY
