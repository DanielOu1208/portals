#!/bin/sh
# Sends a test notification to the booted simulator, shaped like the ones the
# aeriportal-push Hermes plugin sends.
#
#   scripts/sim-push.sh THREAD_ID [approval|question|finished|failed] [AGENT] [TITLE] [TEXT]
#
# AGENT is the agent's profile name; the notification shows it as the sender, with the
# avatar the app saved for it. The app must allow notifications. In a simulator,
# launching it once with SIMCTL_CHILD_PORTALS_DEBUG_PUSH=1 allows them without the
# permission question.
set -eu

thread="${1:?usage: sim-push.sh THREAD_ID [kind] [agent] [title] [text]}"
kind="${2:-finished}"
agent="${3:-default}"
title="${4:-Test thread}"
case "$kind" in
  approval) text="${5:-Wants to run: swift test}" ;;
  question) text="${5:-Which language should I use?}" ;;
  failed) text="${5:-The provider did not answer.}" ;;
  *) text="${5:-Done. All 14 tests pass.}" ;;
esac

payload="$(mktemp -t aeriportal-push).json"
trap 'rm -f "$payload"' EXIT
python3 - "$payload" "$thread" "$kind" "$agent" "$title" "$text" <<'PY'
import json, sys
path, thread, kind, agent, title, text = sys.argv[1:7]
json.dump({
    "aps": {"alert": {"title": agent, "subtitle": title, "body": text}, "sound": "default", "thread-id": thread,
            "mutable-content": 1},
    "aeriportal": {"thread": thread, "kind": kind, "agent": agent},
}, open(path, "w"))
PY
xcrun simctl push booted com.danielou.portals "$payload"
