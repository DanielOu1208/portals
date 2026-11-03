# Stop one Droid subagent, 2026-10-29

## Outcome

**P2 cannot safely be built on Droid 1.0.0's SDK transport.** Keep `can_stop: false`
for Droid Tasks. A prototype was removed after the real recordings showed that its
RPC stops the wrong turn. No production stop API is added.

The orchestrator approved this fallback after seeing the first recordings. The
recorder, separate fixtures and regression tests retain the evidence. They do not
issue a stop against a real user's conversation.

## Bug report for Factory

**Title:** `droid.kill_worker_session` acknowledges a Task child ID, interrupts the
parent, and leaves the child running.

**Environment:** macOS arm64, CLI 1.0.0 (downloaded and checksum verified separately
from the installed CLI), SDK 0.10.0, protocol 1.286.0, Haiku 5.5.
Each recording uses a new scratch git repository and project-local fixed-model droid.
No global settings were changed.

**Steps:**

1. Open an ordinary SDK session, not a Mission.
2. Launch one Task running `sleep 20; echo done`, then reading `hello.txt` (`pear`).
3. Take its child session ID from `child_session_available` (also the launch
   result's `task_id` and `session_id`).
4. While the parent is still answering, send
   `droid.kill_worker_session` with `{ "workerSessionId": "<child session ID>" }`.

**Expected:** Stop only that Task, leave the parent and other Tasks running, and
send the parent a terminal Task report saying it was stopped. Alternatively, reject
the request as unsupported for ordinary Tasks, without interrupting the parent.

**Actual:** The response is `{}`. The parent receives a system message,
`Request interrupted by user`, and its `agent_turn_completed` says `completed`,
not `interrupted`. The child continues, then reports `reason: completed` and
`output: pear`; the parent answers that completion normally.

The first background recording, `task-stop-background.jsonl`, shows the request at
9,207 ms, the parent interruption/end at 9,214 ms, the success response at 9,215 ms,
and the child's normal completion at 33,747 ms. An `await: true` prompt was also
tried. On 1.0 the model omitted `await` from the actual Task input and the Task
returned a background launch receipt, so this is not evidence of a distinct
foreground stop implementation.

### Why a different ID does not fix it

The CLI's embedded JavaScript shows:

- `handleKillWorkerSession` requires an active parent execution and passes its own
  `interruptAgent` callback to `sessionController.killWorkerSession`.
- That controller calls a Mission helper using `getDecompMissionId() ?? currentSessionId`,
  then unconditionally calls the parent interrupt callback.
- The Mission helper returns immediately if no Mission exists. It otherwise writes
  Mission progress, requeues a feature and closes a Mission worker. It does not call
  the ordinary Task manager.
- The agent-side `TaskStop(task_id)` is a separate tool. SDK 0.10.0 exposes no
  equivalent Task-stop RPC or arbitrary native-tool execution RPC.
- CLI 1.0 also handles `droid.kill_background_process({ processId })`, which is not
  exported by this SDK. It checks the background Execute process registry, not
  the Task registry. It is not an individual Task stop.

The alternate live probes confirm:

| Probe | RPC result | Parent | Task |
|---|---|---|---|
| Child ID, parent still active | `{}` | Interrupted; end reason `completed` | Completes `pear` |
| `await: true` prompt | `{}` | Interrupted; end reason `completed` | Actually launched async; completes `pear` |
| Task tool-call ID, parent counting | `{}` | Interrupted; end reason `completed` | Completes `pear` |
| Child ID, parent idle | `No active execution to interrupt` | Unchanged | Completes `pear` |
| Background-process kill with child ID, parent idle | `{ killed: false }` | Unchanged | Completes `pear` |

The launch receipt names the same ID as `task_id` and `session_id`; neither is an
alternative identifier. The first tool-call-ID attempt ran after the parent had
already ended and was rejected; the retained recording keeps the parent counting
so that it exercises the active-parent path.

**Needed from Factory:** A Task-specific RPC targeting the child's Task/session ID,
using the same ownership checks and stop implementation as `TaskStop`, without
interrupting the parent. Its terminal notification should identify the Task and say
stopped. Mission-only worker kills should reject a non-Mission caller.

## Reproduce

```sh
cd bridge
DROID_RECORD_PATH=/tmp/droid-1.0.0/droid \
  DROID_RECORD_MODEL=claude-haiku-5-5 \
  node scripts/record-droid.ts task-stop-background task-stop-foreground \
  task-stop-tool-id task-stop-idle
```

The recorder permits only the exact harmless scratch commands and writes sanitized
envelopes. Replay tests make no model calls. The branch leaves the installed Droid,
login and global settings alone.

## Validation

- After rebasing onto refreshed main `5167e920`, `node --test test/droid-*.test.ts`:
  256 passed.
- After the same rebase, `npm test`: 2,188 passed.
- `npm run typecheck`: clean.
- Pre-rebase noninteractive `codex review --base main`: no actionable regressions in round 1.
  Codex independently reran all 2,186 bridge tests and TypeScript checks successfully.
  It did not rerun live probes.
- Post-rebase `codex review --base main`, round 2: no actionable regressions.
  Codex independently reran the 256 Droid tests and typecheck successfully; it did
  not rerun live probes.
- No Swift changes; Swift tests are not needed.

The replay tests cover all four recordings, the still-running child after the
parent's interrupted turn, its later genuine completion and parent follow-up,
and Stop remaining unavailable. A separate test checks restored terminal cards.
