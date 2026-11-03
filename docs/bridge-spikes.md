# Bridge spikes (M9)

What the M9 spikes found on MBP16 on 2026-10-06, and what `portals-bridge` does because of it. Versions: Claude Code 2.1.292 with `@anthropic-ai/claude-agent-sdk` 0.3.292, codex-cli 0.160.1, Node 24.14.1. Scripts ran in a scratch folder and are not kept; harmless prompts only, in scratch folders.

## S1 Codex shared daemon

- **Socket and framing.** The shared app-server listens on `~/.codex/app-server-control/app-server-control.sock`, a symlink into `/private/tmp/codex-daemon-501/`. It speaks **WebSocket** over that unix socket: an HTTP upgrade, then one JSON-RPC message per text frame.
  - `codex app-server proxy` only pipes raw bytes to the socket, so JSON lines sent to it get no answer.
  - The bridge connects with `ws` to `ws+unix://<socket>:/`.
  - `codex app-server daemon version` prints the socket path and versions as JSON.
- **Two clients on one thread.** Both receive the same approval request, with the same request id. One answers, both get `serverRequest/resolved`, and the turn goes on.
- **A pending approval survives its client.** The client holding the approval was closed without answering. A new client then sent `thread/resume`, got the same request again at once, answered it, and the turn finished.
  - So a bridge restart loses no Codex approvals.
- **Terminal sessions are live on the daemon.** An interactive `codex` in a terminal (run in tmux) waited on an approval. The bridge-style client found it by folder with `thread/list {cwd}`, resumed it, got the pending request and accepted. The terminal's dialog closed, showed `Ran printf hi > s1c.txt`, and the turn finished.
- **Things to design around:**
  - **Source filters don't work.** Threads started from a terminal and from the bridge both report `source: "vscode"`, so `sourceKinds: ["cli"]` finds nothing. Desk threads are listed by folder and recency instead. The bridge's own registry says which threads started on the phone.
  - **A new thread has no rollout until its first turn.** Until then, `thread/resume` from another connection fails with "no rollout found".
  - **Status events are broadcast.** `thread/status/changed` reaches every connection, so filter by `threadId`.
  - **`thread/list` is slow.** It took about 6 s each time, so cache it.
  - **Thread status is useful.** `active` with `activeFlags: ["waitingOnApproval"]` tells us a thread is blocked on someone.
  - **Deleting works.** `thread/delete` removes a thread, which the spikes used for cleanup.
  - **There are two Codex homes.** This Mac also runs a second daemon for `~/.codex-work`. The bridge uses `~/.codex` only.
- **Decision.** The bridge's Codex provider joins the shared daemon through its socket. Running its own `codex app-server` stays as a config fallback.

## S2 Claude history and sessions in a terminal

- **The bridge chooses the session id.** `Options.sessionId` is honoured (the `init` message shows the same id), so the bridge can name a thread before the first reply.
- **Diffs:**
  - Live tool results carry `tool_use_result`. An Edit's includes `filePath`, `oldString`, `newString`, `originalFile` and `structuredPatch`.
  - `getSessionMessages()` returns `{type, uuid, session_id, message, parent_tool_use_id, parent_agent_id, timestamp}` without `tool_use_result`. So history diffs are built from the Edit's `old_string` and `new_string` input.
- **Listing sessions:**
  - `listSessions()` returns `sessionId, summary, lastModified, fileSize, customTitle, firstPrompt, gitBranch, cwd, tag, createdAt`. It covers all folders, or one with `{dir}`, and took 46 ms for 50 sessions.
  - Claude titles sessions on its own (`customTitle`).
- **Which sessions are open.** `claude agents --json` lists live sessions with `pid, cwd, kind` (interactive or background), `sessionId, name, status, state, waitingFor, startedAt`.
- **Resuming a session open in a terminal silently forks the history.** The SDK resumed a session a terminal still had open. It appended its turn to the same session file with no error and no copy. The terminal never saw that turn: asked for its last reply, it still said "ready".
  - The bridge must not "continue" a session that `claude agents --json` shows as open. It offers a **fork** instead: `{resume, forkSession: true, sessionId: <new uuid>}` works and keeps the chosen id. It can also show the session read-only.
- **The folder-trust dialog appears only in the terminal.** Headless sessions don't ask.

## S3 Claude interaction

All of these ran in one long-lived streaming-input `query()` with the user's own settings (`settingSources: ["user", "project", "local"]`).

- **The user's default loads.** `init` reports `permissionMode: bypassPermissions`, 3 plugins and 1 MCP server.
  - `allowDangerouslySkipPermissions: true` is required for that mode.
  - An `init` message arrives at every turn, carrying the current mode and model.
- **AskUserQuestion.** It reaches `canUseTool` even in bypass mode, with input `{questions: [{question, header, options: [{label, description}], multiSelect}]}`.
  - The answer is `allow` with `updatedInput: {...input, answers: {<question text>: <label>}}`, and Claude continued with that answer.
  - It maps onto the app's clarify card.
- **`/mode` maps onto `setPermissionMode()`, applied before the next turn:**

  | `/mode` | Claude | Seen |
  |---|---|---|
  | `ask` | `default` | `Write` went through `canUseTool` |
  | `edits` | `acceptEdits` | `Edit` ran without asking |
  | `plan` | `plan` | Claude wrote a plan and called `ExitPlanMode` through `canUseTool`; allowing it ran the plan. The bridge shows it as an approval whose text is the plan |
  | `full` | `bypassPermissions` | Nothing asked |
  | `default` | Whatever the user's settings say | Today `bypassPermissions` |

  Codex equivalents, applied on the next `turn/start`:

  | `/mode` | Codex |
  |---|---|
  | `ask` | `approvalPolicy: untrusted`, `workspace-write` |
  | `edits` | `on-request`, `workspace-write` |
  | `plan` | `on-request`, `read-only` (until 2026-10-14; since then Codex's own plan mode, `collaborationMode: plan`, with the policy of the mode before it) |
  | `full` | `never`, `danger-full-access` |
  | `default` | Whatever `config.toml` says (since 2026-10-14: nothing is sent for a thread in `default` all along; coming back to it from another mode sends what Codex's settings come to in the thread's folder, its own `.codex/config.toml` included, as `config/read` with `cwd` gives them, and Codex's own choice for what they leave out) |

- **Model and effort.** `setModel("sonnet")` and `applyFlagSettings({effortLevel: "low"})` took effect mid-session; the next reply came from `claude-sonnet-5-5`.
- **A message sent mid-turn joins the running turn.** The second message reached the running turn, and the single reply answered both ("done banana"). So `prompt.submit` during a turn reports `steered`.
- **Thinking text only arrives with the summarized display.** It was empty by default and with Haiku's fixed budget. With `thinking: {type: "adaptive", display: "summarized"}` (Sonnet) or `setMaxThinkingTokens(n, "summarized")` (Haiku), real thinking text streamed: 373 and 2,262 characters. Adaptive thinking may also not think at all on easy prompts.
- **Session state events.** `system/session_state_changed` reports `idle`, `running` or `requires_action`, which drives thread status.

## S4 Claude under launchd

A one-shot LaunchAgent was booted, read and removed. It used the absolute node path and `PATH=~/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`.
- It signed in with the Max login from the Keychain (`apiKeySource: none`).
- It loaded the user's settings (`bypassPermissions`, 3 plugins, the claude.ai MCP connector).
- It replied normally.

## Held approvals

Each test held one approval, then allowed it. All three turns continued normally:
- **Claude, 30 minutes:** after `allow`, the file was written and the reply arrived about a second later.
- **Claude, 60 minutes:** same result.
- **Codex, 60 minutes:** `serverRequest/resolved`, the file change completed, and `turn/completed: completed`.

So the bridge can hold an approval while the phone is away for at least an hour, with no timeout to work around.

## S5 Hermes through the bridge

Done 2026-10-09 for R4, on MBP16 with Hermes 0.21.5+5295.g234badf,
reading its source (`~/.hermes/hermes-agent`) and then running the dev server
(`scripts/dev-serve.sh`, GLM-5.3-Flash on GMI). The question: how does the bridge reach
Hermes on the same Mac, so one pairing serves Claude Code, Codex and Hermes?

- **One backend per user, and it says where it is.** Hermes runs exactly one
  `hermes serve` (or `hermes dashboard`) per OS user, serving every profile; profiles
  are chosen per call (`profile`). The one that runs takes a lock and writes
  `~/.local/state/hermes/gateway-locks/host-serve.json` (role, pid, process start time,
  host, port, format version 1, the fingerprint of its session token) with the token
  itself in `host-serve.token` (0600). `$HERMES_GATEWAY_LOCK_DIR` or an absolute
  `$XDG_STATE_HOME` move the folder. A client proves the record live with
  `GET /api/host/identity` (token in `X-Hermes-Token`), which answers its pid and role.
  - A second `hermes serve` does not bind: it prints the running one and exits 0, or 78
    when asked for a port the owner is not on. `--isolated` binds anyway.
  - While a headless `serve` owns the host, `hermes dashboard` refuses to start (it
    wants a UI behind the URL); `--isolated` or `hermes serve --stop` gets round it.
  - Desktop's own backends publish under another role (`desktop-serve`) and never own
    the host.
  - None was running on MBP16 when checked; the `--port 0` serve seen on 2026-10-05
    was not there.
- **Signing in.** On a loopback bind the backend's session token is the whole sign-in:
  `/api/ws?token=<token>`, and REST calls with `X-Hermes-Session-Token`. It is the token
  in `host-serve.token` (`HERMES_DASHBOARD_SESSION_TOKEN` if set, else fresh each start),
  the same one the app's loopback sign-in reads from `GET /`. A backend gated for a
  non-loopback bind withholds it and signs clients in with its own auth instead; the
  bridge cannot join one of those (it finds the record, but the backend does not prove
  itself to the token).
- **Sessions and the connection.** A session has one client: the one that created or
  last resumed it, which gets its events and questions. When that client goes, Hermes
  parks the session; after 20 s (`ws_orphan_reap_grace_s`) it interrupts a running turn
  and later closes the session, which stays on disk and loads again when resumed.
  `session.resume` by stored id rebinds a live session (same runtime
  id) or loads it anew (a new runtime id). `session.active_list` lists the sessions
  loaded, by `session_key` (the stored id) and `status` (`working`, `waiting`,
  `starting`, `idle`); `session.events.since` replays a session's events within one run
  (`replay_epoch` in `gateway.ready`).
- **Profiles.** `profiles.list` lists `default` and each named profile (`display_name`
  and `description` usually empty). MBP16 has `default` and `aeri`.
- **What a turn needs.** A provider and a model. `setup.runtime_check` answers whether a
  new session could run (`ok`, else `error` in Hermes's words), as Hermes's own apps ask
  before a first message; `setup.status` says whether any provider is configured. A
  profile with no model resolves one at session start (MBP16's default, `z-ai/glm-5.2`,
  answers 404, as before). Hermes's own error says the free Nous tier needs no API key.
- **Installing.** `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`
  (README). The installer ends with `hermes setup` (the wizard) unless given
  `--skip-setup`; `hermes setup model` sets only the provider and model;
  `hermes setup --portal` is Nous Portal's one-shot setup. Not tried here: Hermes is
  installed on MBP16, and a scratch `HERMES_HOME` rebuilds the shared checkout.
- **ACP.** This Hermes has `hermes acp` (an earlier note said it had none). It was not
  chosen: the gateway protocol is what the app already speaks to Hermes, with every
  profile on one connection, replay, questions with choices, skills and subagents.

**Decision.** A provider (`bridge/src/providers/hermes/`) that is a client of the
gateway protocol: one connection to the backend this Mac runs, found from its record;
when none runs and `hermes.start` allows it, the bridge starts `hermes serve` in a
process group of its own and leaves it running, so Hermes turns survive a bridge
restart, as Codex's do on its daemon. One bridge agent per profile. Hermes's events
become the bridge's neutral events, which the bridge's sessions turn back into the same
events with their own `seq`, so Hermes threads get what every thread gets: the
registry, Needs you and Running, rename, folders, notifications. Stored conversations
pass as Hermes keeps them.

Costs, as built:

- Not passed through (yet): the subagents line, Hermes's own slash commands and
  skills (`commands.catalog`, `slash.exec`, `command.dispatch`), Hermes sessions
  started elsewhere (Discord, a terminal) as desk sessions, and steering: a message sent
  mid-turn waits for the turn, where Hermes would cut it short (`redirected`).
- A bridge-started headless backend owns the host, with the dashboard consequence above.
- One client per session: a thread opened in another Hermes app at the same time goes
  quiet on the phone until the bridge resumes it.
- A model change is confirmed for Hermes (`confirm_expensive_model`): choosing it in the
  app is the yes.

**Checked live** (2026-10-09, a test bridge on port 0 joined the dev server through its
record, `hermes.start` off): both profiles listed; a turn with `write_file` and
`read_file`; the `rm -rf` approval reached the client and the deny went back; a clarify
question answered "Swift"; a stop ended the turn interrupted; and a turn running
`sleep 20` carried on across a restart of the bridge: the new bridge found it with
`session.active_list` ("following 1 Hermes thread"), resumed it, and the turn finished
with the tool's output. `~/.hermes/config.yaml` was unchanged after; the two test
sessions were deleted. The recorded runs in `bridge/test/hermes-bridge.test.ts` play the
app's own Hermes captures.

## What changes in the plan

- The Codex provider talks to the shared daemon over `ws+unix`, not through `codex app-server proxy`.
- Desk Codex threads are found by folder and recency, not by `sourceKinds`.
- A Claude session open in a terminal can only be forked or read, never continued, from the phone.
- `/mode plan` needs the approval card to show a plan; the existing card's command text is enough to start.
- The bridge turns on the summarized thinking display so the app's reasoning row has text.
