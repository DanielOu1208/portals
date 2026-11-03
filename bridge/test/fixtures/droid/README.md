# Real Droid SDK recordings

## Recorded on 1.0.0, 2026-10-29

All 13 scenarios were recorded afresh with CLI 1.0.0 and SDK 0.10.0. Direct-tool
scenarios use Haiku 5.5 (`claude-haiku-5-5`, multiplier 0.04, effort medium), including
the fixed-model children; `script` and `script-background` use `gpt-6.1-sol`.
The raw protocol is 1.286.0; the pinned SDK handles it.

`task-background-late-approval-0.247.jsonl` keeps the earlier 0.247.0 recording as
a separate regression fixture: its child asks for approval after the parent turn ends.
The fresh 1.0.0 `task-background` asks before that end, so it cannot prove the late case.

The prior CLI 0.245.0 / SDK 0.9.1 and 0.247.0 / SDK 0.10.0 recordings are in
commit `28236e75` (their observations below are historical).
The prior CLI 0.236.0 / Haiku 4.5 baseline is preserved in commit `39d9b28`.

```sh
cd bridge
DROID_RECORD_PATH=/tmp/droid-1.0.0/droid DROID_RECORD_MODEL=claude-haiku-5-5 \
  DROID_RECORD_SCRIPT_MODEL=gpt-6.1-sol node scripts/record-droid.ts [scenario…]
```

Each JSONL line is a recorder envelope with `kind` and elapsed `at` milliseconds.
`event` is the raw high-level SDK event. `notification` is the **full raw JSON-RPC
envelope**, so its payload is `notification.params.notification`. Other kinds
record metadata, permissions/questions and answers, control calls, and context.
Paths and injected environment context are sanitized, not event shapes.

## Earlier direct-tool recordings (CLI 0.245.0)

Important observed behavior:

- Execute `tool_progress.update.fullOutput` is cumulative; the last update has
  empty `content` but adds the second output line. Final result repeats output.
- `tool_call_delta.toolUse.input` is a snapshot, initially empty.
- Task emits raw `child_session_available` with `childSessionId` and `toolUseId`.
  This tiny awaited Task emitted no parent progress or `subagentSessionId`.
- Compact emits raw `session_compacted` and returns a successor wrapper with the
  **same session ID** on this CLI. The second prompt still remembers `pear`.
- Spec offered no `proceed_edit`; only offered outcomes may be rendered.
- Interrupt can have buffered text after the request, then one interrupted result.
- CLI user hooks run in scratch sessions too. Recorded hook paths are sanitized.
- Raw protocol was 1.272.0 (previously 1.252.0); the pinned SDK handled it.
- Haiku 5.5 emits thinking events in AskUser, Spec, and interrupt scenarios.
  Context stats remain estimated, now with limit 872000 rather than 180000.

## Recorded on the MBP16, 2026-10-27 (n14)

`meter`, `script`, `script-background` and `task-background` were recorded with CLI
0.247.0 and SDK 0.10.0:
`meter` and `task-background` on Haiku 5.5, `script` and `script-background` on
`gpt-6.1-sol`, one of the twelve models Droid runs through Script (`--probe-script`:
gpt-6.1-sol, gpt-6-sol, kimi-k3, claude-opus-5-5, gpt-5.6-sol, claude-opus-5 and their
fast variants, the Fables, gpt-6-astra; every other model, both Haikus among them, calls
its tools directly). A Script scenario names its model with `DROID_RECORD_SCRIPT_MODEL`.

- Droid chooses Scripts by model; `--tool-execution-mode script-only` is ignored in an
  SDK session.
- A Script's approval is confirmation type `script` with each call's own confirmation
  (`calls[]`); its calls show as calls of their own (`repl-tool-call:<id>-<n>`).
- A Script started in the background answers `[Script running · …]` and then
  `{"toolCallId": "<its call>", "status": "running"}` as its result's last text; its
  command's result comes at rest, then Droid's turn under
  `script-completion:<session>:<call>:<call>` (role `system`).
- A background Task's child sends nothing on the parent's channel but its
  `child_session_available`; its approvals come through the parent's handler, naming the
  child's session and the parent's (`associatedSessionIds`), also after the parent's turn.
- The session's naming call reports its usage as the session's last call, after the
  turn's end; `get_context_stats` counts what a compaction took out (unchanged by it),
  `get_context_breakdown` does not (its `contextBudget` is the compaction limit, not the
  model's). The person's skill, droid and MCP server names in a breakdown are kept as
  counts only.

These are real observations, not guarantees that unobserved events are unsupported.
Never update fixtures by inventing model/tool events. UUIDs, timings, chunking,
tokens, and model behavior vary across recordings. No production session is used.

## Individual Task stop probes, CLI 1.0.0 / SDK 0.10.0

`task-stop-background`, `task-stop-foreground`, `task-stop-tool-id` and `task-stop-idle`
probe `droid.kill_worker_session` against ordinary Tasks, not Missions. They are
negative evidence: the RPC does not stop the Task. An acknowledged request interrupts
the parent; the child keeps running and later completes with `pear`. An idle parent
rejects it with `No active execution to interrupt`. `kill_background_process` with the
child ID does not stop it either. No individual Stop control is enabled from these
recordings. See `docs/plans/2026-10-29-droid-subagent-stop.md`.

The foreground scenario asks for `await: true`, but CLI 1.0's actual Task input omits
it and returns a background launch receipt. The name records the attempted scenario,
not a distinct foreground execution path. Every probe records through the child's
completion and the parent's follow-up.

## Oversized prompt during background work, CLI 1.0.0 (R4)

`oversized-background.jsonl` uses SDK 0.10.0 and Haiku 5.5. Execute ran
`sleep 20; echo done` in the background. While Droid answered its completion,
the recorder submitted 2,000,000 repetitions of `quartz ` (14,000,000 characters).
The `send` row keeps the generator and size, not the paste. Unrelated local MCP
server names are replaced with `recorded-local-server`; records retain their
original structure and order.

At 27.677 s Droid's `create_message` names the rejected RPC's `requestId`: a
`system`, `user_only` message says the 3,500,000-token paste exceeds the
872,000-token window and was not sent. The autonomous turn ends at 27.680 s,
but the unmodified SDK stream waits until the recorder's 300 s timeout closes
the session. That timeout also makes the final context read fail. The fixture
keeps that observed failure, not a fabricated result. The RPC regression replays
this exact tail through the pinned SDK, remapping only the rejected RPC id to
the test's fresh id.
