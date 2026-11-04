import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { machineWord } from "../src/platform.ts";
import type { ClaudeProvider } from "../src/providers/claude/provider.ts";
import { fakeClaude, FakeFiles, FakeQuery, inFolder, maxPlanUsage, planUsage, play, playEntries, processes, recordedHistory, tinyCheckJournal } from "./claude-fixtures.ts";
import { pastSubagents } from "../src/providers/claude/tasks.ts";
import { isEvent, RpcFailure, startTestBridge, streamedText, TestClient, unspent, type Frame, type TestBridge } from "./helpers.ts";

// Claude Code threads through the whole bridge, as the app sees them, with recorded
// Claude streams standing in for Claude: the sessions, turns, questions, modes and
// processes are the real code; only the SDK's query is played back.

let bridge: TestBridge;
let client: TestClient;
let provider: ClaudeProvider;
let queries: FakeQuery[];
let files: FakeFiles;
let cwd: string;

before(async () => {
  ({ provider, queries, files } = fakeClaude());
  // The thread folder is General: a temporary folder is never on the list of others.
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "portals-claude-test-")));
  bridge = await startTestBridge({ providers: new Map([["claude", provider]]), config: { generalFolder: cwd } });
  client = await TestClient.open(bridge);
});

after(async () => {
  await client.close();
  await bridge.dispose();
  rmSync(cwd, { recursive: true, force: true });
});

/** The queries that run threads (not the startup check). */
function sessionQueries(list: FakeQuery[] = queries): FakeQuery[] {
  return list.filter((query) => query.options.persistSession !== false);
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function createThread(params: Record<string, unknown> = {}): Promise<string> {
  return (await client.call("session.create", { profile: "claude", source: "tui", cwd, ...params })).session_id;
}

/** Sends a message and returns the query (the Claude process) it went to. */
async function send(session: string, text: string): Promise<FakeQuery> {
  const counts = new Map(sessionQueries().map((query) => [query, query.received.length]));
  const reply = await client.call("prompt.submit", { session_id: session, text, profile: "claude" });
  assert.equal(reply.status, "streaming");
  const reached = () => sessionQueries().find((query) => query.received.length > (counts.get(query) ?? 0));
  await until(() => reached() !== undefined);
  return reached()!;
}

function turnEvents(session: string, start: number): Frame[] {
  return client.frames.slice(start).filter((frame) => frame.method === "event" && frame.params.session_id === session).map((frame) => frame.params);
}

async function completed(session: string, start: number, timeoutMs = 3000): Promise<Frame> {
  return (await client.from(start, (frame) => isEvent(frame, "message.complete", session), timeoutMs)).params;
}

test("a thread's context meter shows from its first request: the window is asked of Claude Code when no process on the model has said it", async () => {
  // 2026-10-27: "in this session i cant see ur context usage", an hour into a first turn.
  const session = await createThread();
  const start = client.frames.length;
  const query = await send(session, "A long first turn.");
  // A model no other test's process ran, so nothing here knows its window yet.
  query.contextUsage = { model: "claude-window-test", rawMaxTokens: 400_000 };
  query.emit({ type: "system", subtype: "init", model: "claude-window-test", permissionMode: "bypassPermissions", session_id: session });
  query.emit({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 4, cache_read_input_tokens: 30_000 } } }, session_id: session });
  const shown = await client.from(start, (frame) => isEvent(frame, "session.usage", session));
  assert.deepEqual(shown.params.payload.usage, { context_used: 30_004, context_max: 400_000 });
  assert.deepEqual(query.calls.filter((call) => call[0] === "getContextUsage"), [["getContextUsage", { detail: "summary" }]]);
  // No result yet: the turn still runs.
  assert.equal(turnEvents(session, start).some((event) => event.type === "message.complete"), false);
  query.emit({ type: "result", subtype: "success", is_error: false, user_message_uuids: [query.received[0].uuid], usage: {}, modelUsage: { "claude-window-test": { contextWindow: 400_000 } }, session_id: session });
  await completed(session, start);

  // The thread's next process on that model knows it and asks nothing.
  query.end();
  await until(() => !query.isRunning);
  const again = client.frames.length;
  const next = await send(session, "And another.");
  assert.notEqual(next, query);
  next.emit({ type: "system", subtype: "init", model: "claude-window-test", permissionMode: "bypassPermissions", session_id: session });
  next.emit({ type: "stream_event", event: { type: "message_start", message: { id: "m2", usage: { input_tokens: 31_000 } } }, session_id: session });
  assert.deepEqual((await client.from(again, (frame) => isEvent(frame, "session.usage", session))).params.payload.usage, { context_used: 31_000, context_max: 400_000 });
  assert.deepEqual(next.calls.filter((call) => call[0] === "getContextUsage"), []);
  next.emit({ type: "result", subtype: "success", is_error: false, user_message_uuids: [next.received[0].uuid], usage: {}, session_id: session });
  await completed(session, again);
});

test("with a Claude Code that cannot say its window, the meter waits for the turn's end, as before", async () => {
  const session = await createThread();
  const start = client.frames.length;
  const query = await send(session, "Hello.");
  query.emit({ type: "system", subtype: "init", model: "claude-older-test", permissionMode: "bypassPermissions", session_id: session });
  query.emit({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 100 } } }, session_id: session });
  await until(() => query.calls.some((call) => call[0] === "getContextUsage"));
  query.emit({ type: "result", subtype: "success", is_error: false, user_message_uuids: [query.received[0].uuid], usage: {}, modelUsage: { "claude-older-test": { contextWindow: 200_000 } }, session_id: session });
  const done = await completed(session, start);
  assert.equal(turnEvents(session, start).some((event) => event.type === "session.usage"), false);
  assert.deepEqual(done.payload.usage, { context_used: 100, context_max: 200_000 });
});

test("profiles.list and model.options describe Claude Code from what a running Claude Code says", async () => {
  const profiles = (await client.call("profiles.list")).profiles;
  assert.deepEqual(profiles, [
    { name: "claude", kind: "claude", display_name: "Claude Code", description: `Claude Code on this ${machineWord()}, with your own settings and sign-in.`, model: "default", provider: "anthropic", is_default: true, adopt_modes: ["continue", "fork", "read"], mode_options: provider.modeOptions },
  ]);
  // The app's five in its own words, and Claude Code's auto mode as Medium.
  assert.deepEqual(profiles[0].mode_options.map((mode: Frame) => [mode.id, mode.label]), [
    ["full", "Full access"],
    ["medium", "Auto"],
    ["edits", "Accept edits"],
    ["ask", "Ask first"],
    ["plan", "Plan"],
    ["default", "Your settings"],
  ]);
  assert.deepEqual(await client.call("model.options", { profile: "claude" }), {
    // `opus` runs what `default` does, so only the default is listed.
    providers: [{ slug: "anthropic", name: "Claude", models: ["default", "sonnet", "haiku", "claude-opus-4-6"], authenticated: true }],
    model: "default",
    provider: "anthropic",
    // The effort levels each model lists; Haiku lists none and takes them all as thinking budgets.
    model_levels: {
      default: ["low", "medium", "high", "xhigh", "max"],
      opus: ["low", "medium", "high", "xhigh", "max"],
      sonnet: ["low", "medium", "high", "xhigh", "max"],
      haiku: ["low", "medium", "high", "xhigh", "max"],
      "claude-opus-4-6": ["low", "medium", "high", "max"],
    },
    // The default by the name of the model the settings come to; `opus` still named, for threads already on it.
    model_names: { default: "Opus 5.5", opus: "Opus 5.5", sonnet: "Sonnet 5.5", haiku: "Haiku 4.5", "claude-opus-4-6": "Opus 4.6" },
    // Each model's own effort when a thread chooses none; Haiku has none.
    model_default_levels: { default: "xhigh", opus: "xhigh", sonnet: "medium", "claude-opus-4-6": "high" },
    // Its threads take a mode; Dana's settings come to full access (bypassPermissions).
    modes: { default: "full" },
    mode_options: provider.modeOptions,
  });
  assert.deepEqual(await client.call("config.get", { key: "reasoning", profile: "claude" }), { value: "xhigh" });
  // The startup check ran without a session and asked nothing.
  const check = queries.find((query) => query.options.persistSession === false)!;
  assert.equal(check.options.sessionId, undefined);
  assert.equal(check.received.length, 0);
  assert.equal(check.isRunning, false);
});

test("session.create answers at once with the thread id and starts no process; a missing folder is refused", async () => {
  const before = sessionQueries().length;
  const created = await client.call("session.create", { profile: "claude", source: "tui", cwd, title: "Probe" });
  assert.match(created.session_id, /^[0-9a-f-]{36}$/);
  assert.equal(created.stored_session_id, created.session_id);
  assert.equal(created.info.model, "default");
  assert.equal(created.info.provider, "anthropic");
  assert.equal(created.info.cwd, cwd);
  assert.equal(sessionQueries().length, before);
  // A model chosen with no level runs at its own (Sonnet's medium), as the app shows it,
  // not at the default model's.
  const sonnet = await client.call("session.create", { profile: "claude", cwd, model: "sonnet" });
  assert.equal(sonnet.info.reasoning_effort, "medium");
  assert.equal((await client.call("session.create", { profile: "claude", cwd, model: "sonnet", reasoning_effort: "high" })).info.reasoning_effort, "high");
  await assert.rejects(client.call("session.create", { profile: "claude", cwd: "/no/such/folder" }), (error: RpcFailure) => error.code === -32602 && error.message === `The folder /no/such/folder does not exist on this ${machineWord()}.`);
});

test("a chat with tools: the first message starts Claude with the thread id; rows, diff, reply, usage and title follow", async () => {
  const session = await createThread({ title: "" });
  const start = client.frames.length;
  const query = await send(session, "In hello.txt, change hi to hello.");
  // Claude has stored the session, and titled it, by the time the turn ends.
  files.stored.set(session, { title: "hello.txt edit and verify", messages: [] });
  // A new session: Claude takes the bridge's id; Dana's own mode and model are left alone.
  assert.equal(query.options.sessionId, session);
  assert.equal(query.options.resume, undefined);
  assert.equal(query.options.cwd, cwd);
  assert.equal(query.options.permissionMode, undefined);
  assert.equal(query.options.model, undefined);
  assert.deepEqual(query.options.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(query.options.env?.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(query.options.env?.ANTHROPIC_API_KEY, undefined);
  assert.equal(query.options.env?.CLAUDE_AGENT_SDK_CLIENT_APP, "portals-bridge");
  // Claude Code sums up each run of its calls for the status line (claude.toolSummaries, on by default).
  assert.equal(query.options.env?.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES, "1");
  assert.equal(typeof query.received[0].uuid, "string");

  await play(query, "tools");
  const done = await completed(session, start);
  const events = turnEvents(session, start);
  assert.equal(events[0].type, "message.start");
  assert.deepEqual(
    events.filter((event) => event.type === "tool.complete").map((event) => event.payload.name),
    ["read_file", "patch", "terminal"],
  );
  const edit = events.find((event) => event.type === "tool.complete" && event.payload.name === "patch").payload;
  assert.equal(edit.result.diff, "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n");
  // What it spent (feature turn_usage): the bridge's time for it, and Claude's result's tokens.
  assert.equal(done.payload.turn_usage.tokens, 108_407);
  const { turn_diff: changed, ...ended } = unspent(done.payload);
  assert.deepEqual(ended, { status: "complete", text: 'I changed "hi" to "hello" in hello.txt, and `cat` confirms the file now reads "hello".', usage: { context_used: 27725, context_max: 1_000_000 } });
  // What the turn changed, from its edit's own diff (feature turn_diff).
  assert.deepEqual(changed, {
    files: [{ path: "hello.txt", status: "modified", added: 1, removed: 1, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n" }],
    added: 1,
    removed: 1,
  });
  assert.ok(events.some((event) => event.type === "reasoning.delta"));
  // Claude's own title, read once the turn is over.
  const title = await client.from(start, (frame) => isEvent(frame, "session.title", session));
  assert.deepEqual(title.params.payload, { title: "hello.txt edit and verify" });

  // The process stays warm for the next message.
  assert.equal(query.isRunning, true);
  const resumed = await client.call("session.resume", { session_id: session });
  assert.equal(resumed.info.title, "hello.txt edit and verify");
  assert.deepEqual(
    resumed.messages.map((message: Frame) => message.role),
    ["user", "assistant", "tool", "tool", "tool", "assistant"],
  );
});

test("Claude Code's summary of a run of its calls is a status.headline, with the calls it sums up (feature status_headline)", async () => {
  assert.ok(client.readyPayload.bridge.features.includes("status_headline"));
  const session = await createThread();
  const start = client.frames.length;
  const query = await send(session, "Hi");
  query.emit({ type: "tool_use_summary", summary: "Read a.txt and b.txt", preceding_tool_use_ids: ["toolu_1", "toolu_2"], uuid: "u", session_id: session });
  const headline = await client.from(start, (frame) => isEvent(frame, "status.headline", session));
  assert.deepEqual(headline.params.payload, { text: "Read a.txt and b.txt", tool_ids: ["toolu_1", "toolu_2"] });
  await play(query, "plain");
  await completed(session, start);
});

test("/mode ask: Claude asks, one write is denied and the next allowed once", async () => {
  const session = await createThread();
  assert.deepEqual(await client.call("slash.exec", { session_id: session, command: "mode ask", profile: "claude" }), {
    type: "exec",
    output: "This thread now asks before editing files or running commands.",
  });
  let start = client.frames.length;
  const query = await send(session, "Create note.txt.");
  assert.equal(query.options.permissionMode, "default");
  const playing = play(query, "approval");

  const first = await client.nextRequest();
  assert.equal(first.method, "approval");
  assert.deepEqual(first.params, {
    session_id: session,
    command: `Edit ${cwd}/note.txt\n--- a/note.txt\n+++ b/note.txt\n+note\n`,
    choices: ["once", "session", "deny"],
    description: "Claude wants to change a file",
  });
  client.answer(first.id, { choice: "deny" });
  const denied = await completed(session, start);
  assert.equal(denied.payload.status, "complete");
  const blocked = turnEvents(session, start).find((event) => event.type === "tool.complete");
  assert.deepEqual(blocked.payload.result, { status: "blocked", error: "Denied from AeriPortal.", user_summary: "You denied this change — it was not made." });

  start = client.frames.length;
  assert.equal((await client.call("prompt.submit", { session_id: session, text: "Please try once more." })).status, "streaming");
  const second = await client.nextRequest();
  client.answer(second.id, { choice: "once" });
  await completed(session, start);
  await playing;
  const written = turnEvents(session, start).find((event) => event.type === "tool.complete");
  assert.deepEqual(written.payload.result, { diff: "--- /dev/null\n+++ b/note.txt\n@@ -0,0 +1 @@\n+note\n" });
  // One process for both turns.
  assert.equal(query.received.length, 2);

  const status = await client.call("slash.exec", { session_id: session, command: "status" });
  assert.match(status.output, /\nModel: Opus 5\.5 \(default\) from anthropic(, thinking \w+)?\n/);
  assert.match(status.output, /\nMode: ask\n/);
});

test("AskUserQuestion is a clarify card, and the answer goes back to Claude keyed by its question", async () => {
  const session = await createThread();
  const start = client.frames.length;
  const query = await send(session, "Ask me which language I prefer.");
  const answered: unknown[] = [];
  const canUseTool = query.options.canUseTool!;
  query.options.canUseTool = async (...args) => {
    const result = await canUseTool(...args);
    answered.push(result);
    return result;
  };
  const playing = play(query, "clarify");
  const request = await client.nextRequest();
  assert.equal(request.method, "clarify");
  // With Claude's heading for it and what each choice means (feature question_details).
  assert.deepEqual(request.params.questions, [
    {
      qid: "q0",
      question: "Which language do you prefer?",
      choices: ["Python", "Swift"],
      multi_select: false,
      header: "Language",
      descriptions: { Python: "Prefer Python for this work", Swift: "Prefer Swift for this work" },
    },
  ]);
  client.answer(request.id, { answers: { q0: "Swift" } });
  const done = await completed(session, start);
  await playing;
  assert.equal(done.payload.text, "You prefer Swift.");
  assert.deepEqual((answered[0] as { updatedInput: { answers: unknown } }).updatedInput.answers, { "Which language do you prefer?": "Swift" });
});

test("/mode plan: the plan is a plan card; Start carries it out in the mode the thread had before planning", async () => {
  const session = await createThread();
  let start = client.frames.length;
  assert.equal((await client.call("slash.exec", { session_id: session, command: "mode plan" })).output, "This thread now plans first, and asks before carrying the plan out.");
  // The thread's followers hear the change (feature modes).
  assert.deepEqual((await client.from(start, (frame) => isEvent(frame, "session.mode", session))).params.payload, { mode: "plan", mode_default: "full", mode_options: provider.modeOptions });
  start = client.frames.length;
  const query = await send(session, "Plan a file.");
  assert.equal(query.options.permissionMode, "plan");
  const playing = play(query, "plan");
  const plan = await client.nextRequest();
  assert.equal(plan.params.description, "Claude has a plan");
  assert.match(plan.params.command, /^# Plan: create plan\.txt/);
  assert.deepEqual(plan.params.choices, ["once", "deny"]);
  // Before planning the thread followed Dana's settings, so its work starts there.
  assert.equal(plan.params.plan, true);
  assert.equal(plan.params.starts_in, "default");
  client.answer(plan.id, { choice: "once" });
  const write = await client.nextRequest();
  assert.ok(write.params.command.startsWith(`Edit ${cwd}/plan.txt\n`));
  client.answer(write.id, { choice: "once" });
  await completed(session, start);
  await playing;
  // Claude is told to leave plan mode for that mode, Dana's (bypassPermissions), not
  // for asking before every edit, and the thread is back in it.
  const approved = query.permissionResults.find((entry) => entry.tool === "ExitPlanMode")?.result as { behavior: string; updatedPermissions?: unknown };
  assert.equal(approved.behavior, "allow");
  assert.deepEqual(approved.updatedPermissions, [{ type: "setMode", mode: "bypassPermissions", destination: "session" }]);
  const modes = turnEvents(session, start).filter((event) => event.type === "session.mode").map((event) => event.payload.mode);
  assert.equal(modes[0], "default");
});

test("session.set_mode changes a thread's mode as /mode does, and info says it", async () => {
  const session = await createThread();
  const before = (await client.call("session.resume", { session_id: session })).info;
  assert.equal(before.mode, "default");
  assert.equal(before.mode_default, "full");
  const start = client.frames.length;
  assert.deepEqual(await client.call("session.set_mode", { session_id: session, mode: "edits" }), { mode: "edits", mode_default: "full", mode_options: provider.modeOptions });
  assert.deepEqual((await client.from(start, (frame) => isEvent(frame, "session.mode", session))).params.payload, { mode: "edits", mode_default: "full", mode_options: provider.modeOptions });
  assert.equal((await client.call("session.resume", { session_id: session })).info.mode, "edits");
  await assert.rejects(client.call("session.set_mode", { session_id: session, mode: "yolo" }), (error: RpcFailure) => error.code === -32602);
});

test("/mode with no argument, a wrong one, and default (Dana's own settings)", async () => {
  const session = await createThread();
  assert.equal(
    (await client.call("slash.exec", { session_id: session, command: "mode" })).output,
    "Mode: default. This thread follows your Claude Code settings: it edits files and runs commands without asking.\nChange it with /mode full, medium, edits, ask, plan or default.",
  );
  await assert.rejects(client.call("slash.exec", { session_id: session, command: "mode careful" }), (error: RpcFailure) => error.code === -32602 && error.message === "Use /mode full, medium, edits, ask, plan or default.");
  await client.call("slash.exec", { session_id: session, command: "mode full" });

  // On a warm thread the mode changes at once; default goes back to what Dana's settings said.
  const query = await send(session, "Hello.");
  assert.equal(query.options.permissionMode, "bypassPermissions");
  const start = client.frames.length;
  void play(query, "plain");
  await completed(session, start);
  assert.equal((await client.call("command.dispatch", { session_id: session, name: "mode", arg: "edits" })).output, "This thread now edits files without asking, and asks before running commands.");
  assert.equal((await client.call("slash.exec", { session_id: session, command: "mode default" })).output, "This thread now follows your Claude Code settings: it edits files and runs commands without asking.");
  assert.deepEqual(
    query.calls.filter((call) => call[0] === "setPermissionMode"),
    [
      ["setPermissionMode", "acceptEdits"],
      ["setPermissionMode", "bypassPermissions"],
    ],
  );
});

test("/mode medium is Claude Code's auto mode, at start and on a warm thread; Claude reporting auto is Medium", async () => {
  const session = await createThread();
  assert.equal(
    (await client.call("slash.exec", { session_id: session, command: "mode medium" })).output,
    "This thread now uses Claude Code's auto mode: it runs safe actions without asking, blocks risky ones, and asks when unsure.",
  );
  const query = await send(session, "Hello.");
  assert.equal(query.options.permissionMode, "auto");
  let start = client.frames.length;
  void play(query, "plain");
  await completed(session, start);
  await client.call("session.set_mode", { session_id: session, mode: "ask" });
  await client.call("session.set_mode", { session_id: session, mode: "medium" });
  assert.deepEqual(
    query.calls.filter((call) => call[0] === "setPermissionMode"),
    [
      ["setPermissionMode", "default"],
      ["setPermissionMode", "auto"],
    ],
  );

  // A thread on Dana's settings that Claude moves into auto mode by itself shows Medium.
  const other = await createThread();
  const next = await send(other, "Hello.");
  start = client.frames.length;
  next.emit({ type: "system", subtype: "init", model: "claude-haiku-5-5", permissionMode: "bypassPermissions", session_id: other });
  next.emit({ type: "system", subtype: "status", status: null, permissionMode: "auto", session_id: other });
  assert.equal((await client.from(start, (frame) => isEvent(frame, "session.mode", other))).params.payload.mode, "medium");
  next.emit({ type: "result", subtype: "success", is_error: false, user_message_uuids: [next.received[0].uuid], usage: {}, session_id: other });
  await completed(other, start);
});

test("commands: what Claude Code says needs a terminal leaves the menu; without its word, the bridge's own list holds", async (t) => {
  const own = fakeClaude();
  const other = await startTestBridge({ providers: new Map([["claude", own.provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(other);
  t.after(async () => {
    await phone.close();
    await other.dispose();
  });
  const offered = async () => ((await phone.call("commands.catalog", { profile: "claude" })).pairs as string[][]).map(([key]) => key);
  // Before any session has said: the list alone keeps /doctor and /send-to-project out.
  assert.deepEqual(await offered(), ["/status", "/mode", "/usage", "/compact", "/context", "/grill-me"]);

  const session = (await phone.call("session.create", { profile: "claude", cwd })).session_id as string;
  const start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "Hello." });
  const query = own.queries.find((entry) => entry.options.persistSession !== false)!;
  await until(() => query.received.length === 1);
  query.emit({ type: "system", subtype: "init", model: "claude-haiku-5-5", permissionMode: "bypassPermissions", terminal_slash_commands: ["doctor", "Context"], session_id: session });
  query.emit({ type: "result", subtype: "success", is_error: false, user_message_uuids: [query.received[0].uuid], usage: {}, session_id: session });
  await phone.from(start, (frame) => isEvent(frame, "message.complete", session));
  assert.deepEqual(await offered(), ["/status", "/mode", "/usage", "/compact", "/grill-me"]);

  // A Claude Code that lists none (or predates the list) leaves only the bridge's own out.
  const again = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "And again." });
  await until(() => query.received.length === 2);
  query.emit({ type: "system", subtype: "init", model: "claude-haiku-5-5", permissionMode: "bypassPermissions", session_id: session });
  query.emit({ type: "result", subtype: "success", is_error: false, user_message_uuids: [query.received[1].uuid], usage: {}, session_id: session });
  await phone.from(again, (frame) => isEvent(frame, "message.complete", session));
  assert.deepEqual(await offered(), ["/status", "/mode", "/usage", "/compact", "/context", "/grill-me"]);
});

test("commands: Claude's own and the user's skills are offered and sent as messages; some are withheld", async () => {
  const catalog = await client.call("commands.catalog", { profile: "claude" });
  assert.deepEqual(catalog.categories, [
    {
      name: "Bridge",
      pairs: [
        ["/status", "Show this thread's agent, folder, branch and model"],
        ["/mode", "Show or change how much this thread asks before acting (usage: /mode [full|medium|edits|ask|plan|default])"],
        ["/usage", "Show how much of your plan's usage limits is used, and when each resets"],
      ],
    },
    {
      name: "Claude Code",
      pairs: [
        ["/compact", "Free up context by summarizing the conversation so far (usage: /compact <optional custom summarization instructions>)"],
        ["/context", "Show current context usage"],
      ],
    },
  ]);
  assert.deepEqual(catalog.skills, { "/grill-me": { usage: 0 } });
  assert.ok(catalog.pairs.some(([key]: string[]) => key === "/grill-me"));
  const session = await createThread();
  await assert.rejects(client.call("slash.exec", { session_id: session, command: "compact keep it short" }), (error: RpcFailure) => error.code === 4018);
  assert.deepEqual(await client.call("command.dispatch", { session_id: session, name: "compact", arg: "keep it short" }), { type: "send", message: "/compact keep it short" });
  assert.deepEqual(await client.call("command.dispatch", { session_id: session, name: "grill-me" }), { type: "send", message: "/grill-me" });
  await assert.rejects(client.call("command.dispatch", { session_id: session, name: "clear" }), (error: RpcFailure) => error.code === -32602);
});

test("a long first turn: the title Claude gives is shown while the turn runs, not only at its end", async (t) => {
  const watched = fakeClaude({ titleWatchMs: [20, 60] });
  const other = await startTestBridge({ providers: new Map([["claude", watched.provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(other);
  t.after(async () => {
    await phone.close();
    await other.dispose();
  });
  const session = (await phone.call("session.create", { profile: "claude", cwd })).session_id as string;
  const start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "Read the whole repository." });
  await until(() => sessionQueries(watched.queries).length === 1);
  const [query] = sessionQueries(watched.queries);
  await until(() => query.received.length === 1);
  // Claude titles the session a few seconds into the turn, which goes on.
  watched.files.stored.set(session, { title: "Repository walkthrough", messages: [] });
  const title = await phone.from(start, (frame) => isEvent(frame, "session.title", session));
  assert.deepEqual(title.params.payload, { title: "Repository walkthrough" });
  assert.equal(phone.frames.slice(start).some((frame) => isEvent(frame, "message.complete", session)), false);
  // The end of the turn reads the same title and says nothing more of it.
  await play(query, "plain");
  await phone.from(start, (frame) => isEvent(frame, "message.complete", session));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(phone.frames.slice(start).filter((frame) => isEvent(frame, "session.title", session)).length, 1);
});

test("session.rename: Claude keeps the title as the session's own; one not stored yet gets it when it starts", async () => {
  const session = await createThread();
  let start = client.frames.length;
  assert.deepEqual(await client.call("session.rename", { session_id: session, title: "  Push   retries " }), {});
  // Nothing stored yet: the title waits for the first message's process.
  assert.deepEqual(files.renames, []);
  assert.equal((await client.from(start, (frame) => isEvent(frame, "session.title", session))).params.payload.title, "Push retries");
  const query = await send(session, "Hello.");
  assert.equal(query.options.title, "Push retries");
  files.stored.set(session, { title: "Push retries", messages: [] });
  void play(query, "plain");
  await completed(session, start);

  start = client.frames.length;
  assert.deepEqual(await client.call("session.rename", { session_id: session, title: "Retry failed pushes" }), {});
  assert.deepEqual(files.renames.at(-1), [session, "Retry failed pushes"]);
  assert.equal((await client.call("session.resume", { session_id: session })).info.title, "Retry failed pushes");
  await assert.rejects(client.call("session.rename", { session_id: session, title: "   " }), (error: RpcFailure) => error.code === -32602);
});

test("a title read begun before a rename cannot replace the title the user chose", async (t) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  class DelayedTitleFiles extends FakeFiles {
    reading = false;
    returned = false;
    override async title(id: string): Promise<string | null> {
      const title = await super.title(id);
      this.reading = true;
      await waiting;
      this.returned = true;
      return title;
    }
  }
  const delayed = new DelayedTitleFiles();
  const watched = fakeClaude({ files: delayed, titleWatchMs: [20] });
  const other = await startTestBridge({ providers: new Map([["claude", watched.provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(other);
  t.after(async () => {
    release();
    await phone.close();
    await other.dispose();
  });
  const session = (await phone.call("session.create", { profile: "claude", cwd })).session_id as string;
  delayed.stored.set(session, { title: "Generated before rename", messages: [] });
  await phone.call("prompt.submit", { session_id: session, text: "Read the whole repository." });
  await until(() => delayed.reading);
  await phone.call("session.rename", { session_id: session, title: "User chosen name" });
  const start = phone.frames.length;
  release();
  await until(() => delayed.returned);
  assert.equal((await phone.call("session.resume", { session_id: session })).info.title, "User chosen name");
  assert.equal(phone.frames.slice(start).some((frame) => isEvent(frame, "session.title", session) && frame.params.payload.title === "Generated before rename"), false);
});

test("/usage asks the thread's running Claude Code, else one started only to ask; when none can say, its last answer with what the turns have reported over it", async (t) => {
  // A bridge of its own, where no other thread runs.
  const { provider: own, queries } = fakeClaude();
  const other = await startTestBridge({ providers: new Map([["claude", own]]), config: { generalFolder: cwd } });
  const client = await TestClient.open(other);
  t.after(async () => {
    await client.close();
    await other.dispose();
  });
  const session = (await client.call("session.create", { profile: "claude", cwd })).session_id as string;
  const checks = () => queries.filter((query) => query.options.persistSession === false);
  const usage = async () => (await client.call("slash.exec", { session_id: session, command: "usage", profile: "claude" })).output as string;
  const time = String.raw`\w{3} \d{1,2}:\d{2} [AP]M`;
  planUsage.answer = maxPlanUsage;
  try {
    // Offered as the bridge's own, in place of Claude Code's.
    const catalog = await client.call("commands.catalog", { profile: "claude", session_id: session });
    assert.deepEqual(catalog.categories[0].pairs.map((pair: string[]) => pair[0]), ["/status", "/mode", "/usage"]);
    assert.equal(catalog.pairs.filter((pair: string[]) => pair[0] === "/usage").length, 1);

    // No thread runs: a Claude Code is started only to ask, keeps no session, and is closed.
    const before = checks().length;
    assert.match(
      await usage(),
      new RegExp(String.raw`^Claude Code usage, Max plan:\n5-hour: 42% used, resets ${time}\nWeekly: 12% used, resets ${time}\nWeekly Fable: used up, resets ${time}\nExtra usage: 5% of this month's limit used\.$`),
    );
    const asked = checks().slice(before);
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].calls.filter((call) => call[0] !== "setMaxThinkingTokens"), [["usage", { skipBehaviors: true }], ["close"]]);
    assert.equal(asked[0].received.length, 0);

    // The thread's own running Claude Code is asked, and nothing more is started.
    const start = client.frames.length;
    assert.equal((await client.call("prompt.submit", { session_id: session, text: "Count to 60.", profile: "claude" })).status, "streaming");
    await until(() => queries.some((query) => query.options.persistSession !== false && query.received.length > 0));
    const query = queries.find((query) => query.options.persistSession !== false)!;
    const playing = play(query, "interrupt");
    await client.from(start, (frame) => isEvent(frame, "message.delta", session));
    const started = checks().length;
    assert.match(await usage(), /^Claude Code usage, Max plan:\n5-hour: 42% used/);
    assert.equal(checks().length, started);
    assert.deepEqual(query.calls.filter((call) => call[0] === "usage"), [["usage", { skipBehaviors: true }]]);

    // When no Claude Code can say, the last answer with the windows the turns reported over it, and when;
    // past its reset (the fixture's Fable, long ago) a window's number is over.
    const later = Math.floor(Date.now() / 1000) + 3600;
    query.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: later } } } });
    query.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: later } });
    // Heard once the second has warned the thread.
    await client.from(start, (frame) => isEvent(frame, "status.update", session) && /reached your weekly/.test(frame.params.payload.text));
    planUsage.answer = new Error("Unknown control request subtype: get_usage");
    assert.match(await usage(), new RegExp(String.raw`^Claude Code usage, Max plan:\n5-hour: 50% used, resets ${time} \(as last said, ${time}\)\nWeekly: used up, resets ${time} \(as last said, ${time}\)\nWeekly Fable: in use\nExtra usage: 5% of this month's limit used\.\nAs Claude Code last said, ${time}\.$`));
    await client.call("session.interrupt", { session_id: session });
    await client.from(start, (frame) => isEvent(frame, "message.complete", session));
    await playing;
  } finally {
    planUsage.answer = new Error("not set");
  }
});

test("interrupting stops Claude, and the turn ends interrupted", async () => {
  const session = await createThread();
  const start = client.frames.length;
  const query = await send(session, "Count to 60.");
  const playing = play(query, "interrupt");
  await client.from(start, (frame) => isEvent(frame, "message.delta", session));
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  const done = await completed(session, start);
  await playing;
  assert.equal(done.payload.status, "interrupted");
  assert.deepEqual(query.calls.filter((call) => call[0] === "interrupt"), [["interrupt"]]);
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "not_interrupted" });
});

/** A bridge of its own whose Claude threads are stopped this soon after Stop if their turn has not ended. */
async function quickStopBridge(t: { after: (fn: () => Promise<void>) => void }) {
  const quick = fakeClaude({ interruptGraceMs: 50 });
  const other = await startTestBridge({ providers: new Map([["claude", quick.provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(other);
  t.after(async () => {
    await phone.close();
    await other.dispose();
  });
  const thread = async () => (await phone.call("session.create", { profile: "claude", cwd })).session_id as string;
  return { quick, phone, thread };
}

test("Stop on a turn Claude does not end: after a grace time its process is stopped and the turn ends interrupted", async (t) => {
  const { quick, phone, thread } = await quickStopBridge(t);
  const session = await thread();
  const start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "Count to 60." });
  await until(() => sessionQueries(quick.queries).length === 1);
  const [query] = sessionQueries(quick.queries);
  await until(() => query.received.length === 1);
  assert.deepEqual(await phone.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  const done = (await phone.from(start, (frame) => isEvent(frame, "message.complete", session))).params;
  assert.equal(done.payload.status, "interrupted");
  assert.deepEqual(query.calls.filter((call) => call[0] === "interrupt" || call[0] === "close"), [["interrupt"], ["close"]]);
});

test("Stop as Claude finishes: the turn ends, and the next turn is not stopped by it", async (t) => {
  const { quick, phone, thread } = await quickStopBridge(t);
  const session = await thread();
  let start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "Hello." });
  await until(() => sessionQueries(quick.queries).length === 1);
  const [query] = sessionQueries(quick.queries);
  // Claude's reply, to its end, is on its way when it reads the interrupt, and it answers after it.
  query.interrupt = async () => {
    query.calls.push(["interrupt"]);
    await play(query, "plain");
    return undefined;
  };
  assert.deepEqual(await phone.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  await phone.from(start, (frame) => isEvent(frame, "message.complete", session));

  // The next message's turn runs past the grace time, and goes on.
  start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "Hello again." });
  await until(() => query.received.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(query.isRunning, true);
  assert.deepEqual(query.calls.filter((call) => call[0] === "close"), []);
  void play(query, "plain", { from: 1 });
  const done = (await phone.from(start, (frame) => isEvent(frame, "message.complete", session))).params;
  assert.equal(done.payload.status, "complete");
});

test("a message sent while Claude works is steered into the running turn, which ends once for both", async () => {
  const session = await createThread();
  const start = client.frames.length;
  const query = await send(session, "Count to 25.");
  const playing = play(query, "steer");
  await client.from(start, (frame) => isEvent(frame, "message.delta", session));
  assert.deepEqual(await client.call("prompt.submit", { session_id: session, text: "Then say banana." }), { status: "steered" });
  const done = await completed(session, start);
  await playing;
  assert.equal(query.received.length, 2);
  assert.notEqual(query.received[0].uuid, query.received[1].uuid);
  const events = turnEvents(session, start);
  assert.equal(events.filter((event) => event.type === "message.complete").length, 1);
  assert.equal(events.filter((event) => event.type === "message.interim").length, 1);
  assert.equal(done.payload.text, "banana");
  const stored = (await client.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(
    stored.filter((message: Frame) => message.role === "user").map((message: Frame) => [message.text, message.display_kind]),
    [
      ["Count to 25.", undefined],
      ["Then say banana.", "steer"],
    ],
  );
});

test("/compact: with nothing to compact its turn fails with Claude Code's reason; later it marks where it compacted, which resume and replay keep", async () => {
  const session = await createThread();
  let start = client.frames.length;
  const query = await send(session, "/compact");
  const playing = play(query, "compact");
  const failed = await completed(session, start);
  // Asking again would meet the same answer.
  assert.deepEqual(unspent(failed.payload), { status: "error", text: "No messages to compact.", error_surface: { retryable: false } });

  start = client.frames.length;
  await send(session, "Reply with the single word hello. Do not use any tools.");
  await completed(session, start);

  start = client.frames.length;
  await send(session, "/compact");
  const done = await completed(session, start);
  await playing;
  const events = turnEvents(session, start);
  assert.deepEqual(
    events.map((event) => event.type),
    ["message.start", "thinking.delta", "thinking.delta", "session.compacted", "session.usage", "message.complete"],
  );
  const compacted = events.find((event) => event.type === "session.compacted");
  assert.deepEqual(compacted.payload, { trigger: "manual", tokens_before: 25473 });
  // Nothing was said: the summary and Claude Code's "Compacted" are not the reply.
  assert.deepEqual(unspent(done.payload), { status: "complete", text: "", usage: { context_used: 2807, context_max: 1_000_000 } });

  const resumed = await client.call("session.resume", { session_id: session });
  assert.deepEqual(
    resumed.messages.map((message: Frame) => (message.role === "compaction" ? [message.role, message.trigger, message.tokens_before] : [message.role, message.text, message.display_kind])),
    [
      ["user", "/compact", undefined],
      ["assistant", "No messages to compact.", "failed_turn"],
      ["user", "Reply with the single word hello. Do not use any tools.", undefined],
      ["assistant", "hello", undefined],
      ["user", "/compact", undefined],
      ["compaction", "manual", 25473],
    ],
  );
  const replayed = await client.call("session.events.since", { session_id: session, last_seen: compacted.seq - 1 });
  assert.deepEqual(replayed.events[0], compacted);
});

test("a slash command sent while Claude works waits for the turn to end and is a turn of its own, where a message would be steered", async () => {
  const session = await createThread();
  let start = client.frames.length;
  const query = await send(session, "/compact");
  const playing = play(query, "compact");
  await completed(session, start);

  // The second /compact arrives while the reply to the message before it is still to come.
  start = client.frames.length;
  const replying = client.call("prompt.submit", { session_id: session, text: "Reply with the single word hello. Do not use any tools." });
  const compacting = client.call("prompt.submit", { session_id: session, text: "/compact" });
  assert.deepEqual(await replying, { status: "streaming" });
  assert.deepEqual(await compacting, { status: "queued", queue_id: "1" });
  await playing;
  await until(() => turnEvents(session, start).filter((event) => event.type === "message.complete").length === 2);
  assert.deepEqual(
    turnEvents(session, start)
      .filter((event) => ["message.start", "message.complete", "session.compacted"].includes(event.type))
      .map((event) => (event.type === "message.complete" ? [event.type, event.payload.status, event.payload.text] : [event.type])),
    [["message.start"], ["message.complete", "complete", "hello"], ["message.start"], ["session.compacted"], ["message.complete", "complete", ""]],
  );
  // Claude had the command only once the reply was done, as a message of its own.
  assert.equal(query.received.length, 3);
  const stored = (await client.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(
    stored.slice(2).map((message: Frame) => (message.role === "compaction" ? [message.role, message.trigger] : [message.role, message.text, message.display_kind])),
    [
      ["user", "Reply with the single word hello. Do not use any tools.", undefined],
      ["assistant", "hello", undefined],
      ["user", "/compact", undefined],
      ["compaction", "manual"],
    ],
  );
});

test("images attached go to Claude as image blocks with the next message", async () => {
  const session = await createThread();
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  assert.equal((await client.call("image.attach_bytes", { session_id: session, content_base64: png.toString("base64"), filename: "shot.png" })).attached, true);
  const start = client.frames.length;
  const query = await send(session, "What is this?");
  assert.deepEqual(query.received[0].message.content, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
    { type: "text", text: "What is this?" },
  ]);
  void play(query, "plain");
  await completed(session, start);
});

test("model and thinking level: applied at once when idle, after the turn when one runs, at the start when cold", async () => {
  const session = await createThread({ model: "haiku", reasoning_effort: "high" });
  const start = client.frames.length;
  const query = await send(session, "Hello.");
  // Haiku has no adaptive thinking: its thinking text needs a budget, in the summarized display.
  assert.equal(query.options.model, "haiku");
  assert.equal(query.options.effort, "high");
  assert.equal(query.options.thinking, undefined);
  await until(() => query.calls.some((call) => call[0] === "setMaxThinkingTokens"));
  assert.deepEqual(query.calls.find((call) => call[0] === "setMaxThinkingTokens"), ["setMaxThinkingTokens", 8192, "summarized"]);

  // While the turn runs, the change waits for it.
  assert.deepEqual(await client.call("config.set", { session_id: session, key: "model", value: "sonnet --provider anthropic --session" }), { deferred: true });
  assert.equal(query.calls.some((call) => call[0] === "setModel"), false);
  void play(query, "plain");
  await completed(session, start);
  await until(() => query.calls.some((call) => call[0] === "setModel"));
  assert.deepEqual(query.calls.filter((call) => call[0] === "setModel"), [["setModel", "sonnet"]]);
  assert.deepEqual(query.calls.at(-1), ["setMaxThinkingTokens", null, "summarized"]);

  assert.deepEqual(await client.call("config.set", { session_id: session, key: "reasoning", value: "ultra" }), {});
  assert.deepEqual(query.calls.find((call) => call[0] === "applyFlagSettings"), ["applyFlagSettings", { effortLevel: "max" }]);
  const info = (await client.call("session.resume", { session_id: session })).info;
  assert.equal(info.model, "sonnet");
  assert.equal(info.reasoning_effort, "max");
  const status = await client.call("slash.exec", { session_id: session, command: "status" });
  assert.match(status.output, /\nModel: Sonnet 5\.5 from anthropic, thinking max\n/);
  await assert.rejects(client.call("config.set", { session_id: session, key: "model", value: "gpt-5 --session" }), (error: RpcFailure) => error.code === -32602);
});

test("`opus`, left off the list while the default runs it, is still taken, and named without the default's mark", async () => {
  // Threads put on `opus` before the list left it out still say so.
  const session = await createThread({ model: "opus" });
  assert.equal((await client.call("session.resume", { session_id: session })).info.model, "opus");
  assert.deepEqual(await client.call("config.set", { session_id: session, key: "model", value: "sonnet --session" }), {});
  assert.deepEqual(await client.call("config.set", { session_id: session, key: "model", value: "opus --provider anthropic --session" }), {});
  const status = await client.call("slash.exec", { session_id: session, command: "status" });
  assert.match(status.output, /\nModel: Opus 5\.5 from anthropic(, thinking \w+)?\n/);
});

test("a crash after Claude streamed requests keeps what they spent with the failed turn (feature turn_usage)", async () => {
  const session = await createThread();
  const start = client.frames.length;
  const query = await send(session, "Hello.");
  files.stored.set(session, { title: null, messages: [] });
  // One request streamed in full (in 6, cache written 1,000, cache read 500, out 94), then the process dies before a result.
  query.emit({ type: "stream_event", event: { type: "message_start", message: { id: "req-1", usage: { input_tokens: 6, cache_creation_input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 1 } } } });
  query.emit({ type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 6, cache_creation_input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 94 } } });
  query.crash("Claude Code process exited with code 1");
  const done = await completed(session, start);
  assert.equal(done.payload.status, "error");
  assert.equal(done.payload.turn_usage.tokens, 1600);
});

test("a crash ends the running turn with an error the app shows; the next message resumes the session", async () => {
  const session = await createThread();
  let start = client.frames.length;
  const query = await send(session, "Hello.");
  files.stored.set(session, { title: null, messages: [] });
  query.crash("Claude Code process exited with code 1");
  const done = await completed(session, start);
  assert.equal(done.payload.status, "error");
  assert.equal(done.payload.text, "Claude Code stopped unexpectedly: Claude Code process exited with code 1");
  const error = turnEvents(session, start).find((event) => event.type === "error");
  assert.deepEqual(error.payload, { message: "Claude Code stopped unexpectedly: Claude Code process exited with code 1" });
  // Nothing was streamed: no tokens, the bridge's time only.
  assert.equal(done.payload.turn_usage.tokens, undefined);

  start = client.frames.length;
  const again = await send(session, "Hello again.");
  assert.notEqual(again, query);
  assert.equal(again.options.resume, session);
  assert.equal(again.options.sessionId, undefined);
  void play(again, "plain");
  assert.equal((await completed(session, start)).payload.status, "complete");
});

test("an idle thread goes cold after its idle time, and the next message resumes it", async () => {
  const session = await createThread();
  let start = client.frames.length;
  const query = await send(session, "Hello.");
  files.stored.set(session, { title: null, messages: [] });
  void play(query, "plain");
  await completed(session, start);
  provider.pool.sweep(Date.now() + 14 * 60_000);
  assert.equal(query.isRunning, true);
  provider.pool.sweep(Date.now() + 16 * 60_000);
  await until(() => !query.isRunning);

  start = client.frames.length;
  const again = await send(session, "Still there?");
  assert.equal(again.options.resume, session);
  void play(again, "plain");
  await completed(session, start);
});

test("a thread messaged while its cooled process is still exiting keeps the new process in the idle count, and it goes cold in turn", async (t) => {
  const own = fakeClaude();
  const other = await startTestBridge({ providers: new Map([["claude", own.provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(other);
  t.after(async () => {
    await phone.close();
    await other.dispose();
  });
  const session = (await phone.call("session.create", { profile: "claude", cwd })).session_id;
  let start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "Hello." });
  await until(() => sessionQueries(own.queries).length === 1);
  const [old] = sessionQueries(own.queries);
  own.files.stored.set(session, { title: null, messages: [] });
  void play(old, "plain");
  await phone.from(start, (frame) => isEvent(frame, "message.complete", session));

  // Claude takes a while to exit once told to (its hooks, its MCP servers).
  const exit = old.end.bind(old);
  old.end = () => void setTimeout(exit, 100);
  own.provider.pool.sweep(Date.now() + 16 * 60_000);
  start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "Still there?" });
  await until(() => sessionQueries(own.queries).length === 2);
  const fresh = sessionQueries(own.queries)[1];
  await until(() => !old.isRunning);
  assert.equal(own.provider.pool.size, 1);

  void play(fresh, "plain");
  await phone.from(start, (frame) => isEvent(frame, "message.complete", session));
  own.provider.pool.sweep(Date.now() + 16 * 60_000);
  await until(() => !fresh.isRunning);
});

test("background work keeps the process up past the idle time; the turn Claude begins when it ends reaches the app, saying why", async () => {
  const session = await createThread();
  let start = client.frames.length;
  const query = await send(session, "Run sleep 3 in the background.");
  files.stored.set(session, { title: null, messages: [] });
  const [entries] = processes("background");
  const ended = entries.findIndex((entry) => entry.kind === "message" && entry.message.subtype === "task_notification");
  const uuids = new Map<string, string>();
  await playEntries(query, entries.slice(0, ended), { uuids });
  await completed(session, start);
  // The command runs on in Claude's process: an idle sweep leaves it up.
  provider.pool.sweep(Date.now() + 16 * 60_000);
  assert.equal(query.isRunning, true);

  start = client.frames.length;
  await playEntries(query, entries.slice(ended), { from: 1, uuids });
  const done = await completed(session, start);
  const line = 'Background command "Sleep for 3 seconds in background" completed (exit code 0)';
  // The command's row on the subagents line ended with it (feature background_commands).
  const row = turnEvents(session, start).find((event) => event.type === "subagent.complete");
  assert.equal(row?.payload.kind, "command");
  assert.equal(row?.payload.status, "completed");
  assert.equal(row?.payload.goal, "Sleep for 3 seconds in background");
  assert.deepEqual(
    turnEvents(session, start)
      .filter((event) => !event.type.startsWith("subagent."))
      .slice(0, 3)
      .map((event) => [event.type, event.payload ?? null]),
    [
      ["status.update", { kind: "process", text: line }],
      ["thinking.delta", { text: "" }],
      ["message.start", null],
    ],
  );
  assert.equal(done.payload.status, "complete");
  assert.equal(done.payload.text, "The background `sleep 3` finished with exit code 0.");
  // Opened again, the thread shows the line where a message of the user's would be.
  const resumed = await client.call("session.resume", { session_id: session, profile: "claude", inline_images: false });
  const opener = resumed.messages.filter((message: Frame) => message.role === "user").at(-1);
  assert.deepEqual({ ...opener, timestamp: 0 }, { role: "user", text: line, timestamp: 0, display_kind: "process_complete", display_metadata: { display_text: line } });
  // With the work over, the thread is idle and cools as any other.
  provider.pool.sweep(Date.now() + 16 * 60_000);
  await until(() => !query.isRunning);
});

test("a background subagent and a workflow: the app is told of each, can list them after the turn, and the thread is at work until both end", async () => {
  const session = await createThread();
  let start = client.frames.length;
  const query = await send(session, "Start a subagent and a workflow.");
  files.stored.set(session, { title: null, messages: [] });
  const [entries] = processes("subagents");
  const ended = entries.findIndex((entry) => entry.kind === "message" && entry.message.subtype === "task_updated");
  const uuids = new Map<string, string>();
  await playEntries(query, entries.slice(0, ended), { uuids });
  await completed(session, start);
  const news = turnEvents(session, start).filter((event) => event.type.startsWith("subagent."));
  assert.deepEqual(news.filter((event) => event.type === "subagent.start").map((event) => [event.payload.subagent_id, event.payload.kind, event.payload.goal]), [
    ["a24479d5e93836222", "agent", "Count the files"],
    ["wwn9e3l29", "workflow", "Two haiku agents reply with apple and pear in parallel"],
  ]);
  // Both run on after the turn: listed, stoppable, and the thread is at work.
  const listed = (await client.call("subagent.list", { session_id: session, profile: "claude" })).subagents;
  assert.deepEqual(
    listed.map((subagent: Frame) => [subagent.subagent_id, subagent.status, subagent.can_stop, subagent.background]),
    [
      ["a24479d5e93836222", "running", true, true],
      ["wwn9e3l29", "running", true, true],
    ],
  );
  // Both started by the same turn, the thread's first since the bridge started.
  assert.deepEqual(listed.map((subagent: Frame) => subagent.turn), [listed[0].turn, listed[0].turn]);
  const workflow = listed[1];
  assert.equal(workflow.name, "tiny-check");
  assert.deepEqual(workflow.phases, [{ index: 1, title: "Check" }]);
  assert.deepEqual(
    workflow.agents.map((agent: Frame) => [agent.label, agent.phase, agent.status]),
    [
      ["apple", "Check", "completed"],
      ["pear", "Check", "running"],
    ],
  );
  assert.equal(workflow.agents[0].result, "apple");
  assert.equal(typeof workflow.started_at, "number");
  // At work after its turn, for them alone: no turn of its own (`turn: false`).
  assert.deepEqual((await client.call("sessions.activity")).sessions.find((entry: Frame) => entry.session_id === session), { session_id: session, state: "running", turn: false });

  start = client.frames.length;
  await playEntries(query, entries.slice(ended), { from: 1, uuids });
  await until(() => turnEvents(session, start).filter((event) => event.type === "message.complete").length === 2);
  const done = turnEvents(session, start).filter((event) => event.type === "subagent.complete");
  assert.deepEqual([...new Set(done.map((event) => event.payload.subagent_id))], ["a24479d5e93836222", "wwn9e3l29"]);
  const relisted = (await client.call("subagent.list", { session_id: session, profile: "claude" })).subagents;
  assert.deepEqual(
    relisted.map((subagent: Frame) => [subagent.subagent_id, subagent.status, subagent.can_stop, typeof subagent.ended_at]),
    [
      ["a24479d5e93836222", "completed", false, "number"],
      ["wwn9e3l29", "completed", false, "number"],
    ],
  );
  assert.match(relisted[0].result, /^0 entries\./);
  // The turns Claude began by itself to report back did not change which turn started them.
  assert.deepEqual(relisted.map((subagent: Frame) => subagent.turn), listed.map((subagent: Frame) => subagent.turn));
  assert.equal((await client.call("sessions.activity")).sessions.some((entry: Frame) => entry.session_id === session), false);
  // Ended, it cannot be stopped.
  assert.deepEqual(await client.call("subagent.stop", { session_id: session, subagent_id: "wwn9e3l29", profile: "claude" }), { status: "not_running" });
  assert.equal(query.calls.some((call) => call[0] === "stopTask"), false);
});

test("Stop on a workflow stops it alone: Claude Code is asked to stop that task, and the workflow ends stopped", async () => {
  const session = await createThread();
  const start = client.frames.length;
  const query = await send(session, "Start a slow workflow.");
  files.stored.set(session, { title: null, messages: [] });
  const [entries] = processes("workflow-stop");
  const stop = entries.findIndex((entry) => entry.kind === "control");
  const uuids = new Map<string, string>();
  await playEntries(query, entries.slice(0, stop), { uuids });
  await completed(session, start);
  // Another thread's subagent, or one never started, is not this thread's to stop.
  assert.deepEqual(await client.call("subagent.stop", { session_id: session, subagent_id: "nope", profile: "claude" }), { status: "not_running" });
  assert.deepEqual(await client.call("subagent.stop", { session_id: session, subagent_id: "w1ye6xeq1", profile: "claude" }), { status: "stopped" });
  assert.deepEqual(
    query.calls.filter((call) => call[0] === "stopTask"),
    [["stopTask", "w1ye6xeq1"]],
  );
  await playEntries(query, entries.slice(stop), { from: 1, uuids });
  const ended = await client.from(start, (frame) => isEvent(frame, "subagent.complete", session));
  assert.equal(ended.params.payload.status, "stopped");
  assert.equal(ended.params.payload.result, undefined);
  assert.deepEqual(ended.params.payload.agents.map((agent: Frame) => [agent.label, agent.status]), [["sleeper", "stopped"]]);
  // The query was not interrupted: Stop on one task is not Stop on the turn.
  assert.equal(query.calls.some((call) => call[0] === "interrupt"), false);
});

for (const keep of [false, true]) {
  test(
    keep
      ? "Stop on the turn from an app with a Stop for each subagent (keep_background) leaves the workflow running"
      : "Stop on the turn from an app with no Stop for each subagent stops the background workflow with it, as before",
    async () => {
      const session = await createThread();
      const start = client.frames.length;
      const query = await send(session, "Start a slow workflow.");
      files.stored.set(session, { title: null, messages: [] });
      const [entries] = processes("workflow-stop");
      const result = entries.findIndex((entry) => entry.kind === "message" && entry.message.type === "result");
      const uuids = new Map<string, string>();
      // The workflow has started; the turn has not ended.
      await playEntries(query, entries.slice(0, result), { uuids });
      await client.from(start, (frame) => isEvent(frame, "subagent.start", session));
      const params = keep ? { session_id: session, profile: "claude", keep_background: true } : { session_id: session, profile: "claude" };
      assert.deepEqual(await client.call("session.interrupt", params), { status: "interrupted" });
      assert.deepEqual(
        query.calls.filter((call) => call[0] === "interrupt" || call[0] === "stopTask"),
        keep ? [["interrupt"]] : [["interrupt"], ["stopTask", "w1ye6xeq1"]],
      );
      await playEntries(query, entries.slice(result, result + 1), { from: 1, uuids });
      await completed(session, start);
    },
  );
}

test("Claude is started so that Stop on the turn spares background work, and subagents say what they are doing", async () => {
  const session = await createThread();
  const start = client.frames.length;
  const query = await send(session, "Say hello.");
  await play(query, "plain");
  await completed(session, start);
  assert.equal(query.options.perTaskStopAffordance, true);
  assert.equal(query.options.agentProgressSummaries, true);
});

test("a background subagent's question stays open when the turn ends, while the turn's own is withdrawn", async () => {
  // An app that keeps the subagent's card after the turn says so.
  await client.call("client.capabilities", { server_requests: true, subagent_requests: true });
  const session = await createThread();
  const start = client.frames.length;
  const query = await send(session, "Say hello.");
  const ask = (agentID: string | undefined, toolUseID: string) =>
    query.options.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID, requestId: toolUseID, ...(agentID ? { agentID } : {}) } as never);
  const own = ask(undefined, "toolu_own");
  const background = ask("a24479d5e93836222", "toolu_sub");
  await until(() => (client.frames.slice(start).filter((frame) => frame.method === "approval").length === 2));
  const [ownCard, subagentCard] = client.frames.slice(start).filter((frame) => frame.method === "approval");
  // The app is told whose it is, to keep the card once the turn is over.
  assert.equal(ownCard.params.subagent, undefined);
  assert.equal(subagentCard.params.subagent, "a24479d5e93836222");
  await play(query, "plain");
  await completed(session, start);
  // The turn's question is over with it; the subagent's is still asked.
  assert.equal((await own)?.behavior, "deny");
  const cancelled = client.frames.slice(start).filter((frame) => frame.method === "event" && frame.params.type === "request.cancel").map((frame) => frame.params.payload.id);
  assert.deepEqual(cancelled, [ownCard.id]);
  const open = (await client.call("session.resume", { session_id: session, profile: "claude", inline_images: false })).open_requests;
  assert.deepEqual(open.map((request: Frame) => request.id), [subagentCard.id]);
  assert.deepEqual((await client.call("sessions.activity")).sessions.find((entry: Frame) => entry.session_id === session), { session_id: session, state: "waiting" });
  client.answer(subagentCard.id, { choice: "once" });
  assert.equal((await background)?.behavior, "allow");
});

test("Stop after the turn has ended leaves a background subagent's question open when the app keeps background work, and else stops the work and takes the question back", async () => {
  await client.call("client.capabilities", { server_requests: true, subagent_requests: true });
  const session = await createThread();
  const start = client.frames.length;
  const query = await send(session, "Start a slow workflow.");
  files.stored.set(session, { title: null, messages: [] });
  const [entries] = processes("workflow-stop");
  const stop = entries.findIndex((entry) => entry.kind === "control");
  await playEntries(query, entries.slice(0, stop), { uuids: new Map() });
  await completed(session, start);
  // One of the workflow's agents asks, with no turn running.
  const asked = query.options.canUseTool!("Bash", { command: "make" }, { signal: new AbortController().signal, toolUseID: "toolu_w", requestId: "toolu_w", agentID: "a8a61ae82f6b90c55" } as never);
  await until(() => client.frames.slice(start).some((frame) => frame.method === "approval"));
  // Stop that arrives once the turn is over, from this app: the question and the work stay.
  assert.deepEqual(await client.call("session.interrupt", { session_id: session, profile: "claude", keep_background: true }), { status: "not_interrupted" });
  assert.equal((await client.call("session.resume", { session_id: session, profile: "claude", inline_images: false })).open_requests.length, 1);
  assert.equal(query.calls.some((call) => call[0] === "stopTask"), false);
  // From an app with no Stop for each: both go.
  assert.deepEqual(await client.call("session.interrupt", { session_id: session, profile: "claude" }), { status: "interrupted" });
  assert.equal((await asked)?.behavior, "deny");
  assert.deepEqual(query.calls.filter((call) => call[0] === "stopTask"), [["stopTask", "w1ye6xeq1"]]);
});

test("in a thread only apps that drop a subagent's card at the turn's end (no subagent_requests) follow, the turn takes the question back, as before", async (t) => {
  const own = fakeClaude();
  const other = await startTestBridge({ providers: new Map([["claude", own.provider]]), config: { generalFolder: cwd } });
  // An app that keeps the cards came, and follows another thread: this one is not its.
  const newer = await TestClient.open(other);
  await newer.call("client.capabilities", { server_requests: true, subagent_requests: true });
  await newer.call("session.create", { profile: "claude", cwd });
  await newer.close();
  const phone = await TestClient.open(other);
  t.after(async () => {
    await phone.close();
    await other.dispose();
  });
  const session = (await phone.call("session.create", { profile: "claude", cwd })).session_id as string;
  const start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "Say hello.", profile: "claude" });
  await until(() => sessionQueries(own.queries).length === 1);
  const [query] = sessionQueries(own.queries);
  await until(() => query.received.length === 1);
  const background = query.options.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "toolu_sub", requestId: "toolu_sub", agentID: "a24479d5e93836222" } as never);
  await until(() => phone.frames.slice(start).some((frame) => frame.method === "approval"));
  await play(query, "plain");
  await phone.from(start, (frame) => isEvent(frame, "message.complete", session));
  assert.equal((await background)?.behavior, "deny");
  assert.deepEqual((await phone.call("session.resume", { session_id: session, profile: "claude", inline_images: false })).open_requests, []);
});

test("a thread whose work runs on in the background is not removed, which would end the work; once the work is done it is", async () => {
  const session = await createThread();
  let start = client.frames.length;
  const query = await send(session, "Run sleep 3 in the background.");
  files.stored.set(session, { title: null, messages: [] });
  const [entries] = processes("background");
  const ended = entries.findIndex((entry) => entry.kind === "message" && entry.message.subtype === "task_notification");
  const uuids = new Map<string, string>();
  await playEntries(query, entries.slice(0, ended), { uuids });
  await completed(session, start);
  // At rest as the app sees it, with the command still running in Claude's process.
  assert.equal((await client.call("sessions.activity")).sessions.some((entry: Frame) => entry.session_id === session), false);
  await assert.rejects(
    client.call("thread.delete", { thread: session }),
    (error: RpcFailure) => error.code === -32602 && error.message === "Claude Code still has work running in the background in this thread. Remove it once that work is done.",
  );
  assert.equal(query.isRunning, true);

  start = client.frames.length;
  await playEntries(query, entries.slice(ended), { from: 1, uuids });
  await completed(session, start);
  assert.deepEqual(await client.call("thread.delete", { thread: session }), {});
  await until(() => !query.isRunning);
});

test("a thread taken off the list is let go of by Claude Code's provider too, with what it held of the conversation", async () => {
  const kept = provider.tracked.sessions;
  // One never messaged (no process), and one that ran a turn.
  const quiet = await createThread();
  const used = await createThread();
  const start = client.frames.length;
  await play(await send(used, "Say hello."), "plain");
  await completed(used, start);
  assert.equal(provider.tracked.sessions, kept + 2);
  assert.deepEqual(await client.call("thread.delete", { thread: quiet }), {});
  assert.equal(provider.tracked.sessions, kept + 1);
  assert.deepEqual(await client.call("thread.delete", { thread: used }), {});
  assert.equal(provider.tracked.sessions, kept);
});

test("a thread whose process stopped while work ran in the background: the next message's turn ends with its reply", async () => {
  const session = await createThread();
  let start = client.frames.length;
  const query = await send(session, "Run sleep 600 in the background.");
  files.stored.set(session, { title: null, messages: [] });
  const [first, second] = processes("resumed");
  await playEntries(query, first);
  await completed(session, start);
  const warm = provider.pool.size;
  query.end();
  await until(() => provider.pool.size === warm - 1);

  start = client.frames.length;
  const again = await send(session, "Is that command still running?");
  assert.equal(again.options.resume, session);
  // Claude first says what did not finish, with an empty result of no turn.
  await playEntries(again, second);
  const done = await completed(session, start);
  assert.match(done.payload.text, /^No, it isn't running anymore/);
  assert.equal(turnEvents(session, start).filter((event) => event.type === "message.complete").length, 1);
});

test("at most maxWarm processes: the least recently used idle one goes cold first, a busy one never", async (t) => {
  const small = fakeClaude({ maxWarm: 1 });
  const other = await startTestBridge({ providers: new Map([["claude", small.provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(other);
  t.after(async () => {
    await phone.close();
    await other.dispose();
  });
  const create = async () => (await phone.call("session.create", { profile: "claude", cwd })).session_id;
  const first = await create();
  const second = await create();

  await phone.call("prompt.submit", { session_id: first, text: "one" });
  await until(() => sessionQueries(small.queries).length === 1);
  const [one] = sessionQueries(small.queries);
  await until(() => one.received.length === 1);
  // The first is busy (its turn runs), so the second may warm up beside it.
  await phone.call("prompt.submit", { session_id: second, text: "two" });
  await until(() => sessionQueries(small.queries).length === 2);
  const two = sessionQueries(small.queries)[1];
  assert.equal(one.isRunning, true);
  await until(() => two.received.length === 1);

  // Both finish; the next one to warm up pushes out the older idle one.
  void play(one, "plain");
  void play(two, "plain");
  await phone.find((frame) => isEvent(frame, "message.complete", first));
  await phone.find((frame) => isEvent(frame, "message.complete", second));
  const third = await create();
  await phone.call("prompt.submit", { session_id: third, text: "three" });
  await until(() => sessionQueries(small.queries).length === 3);
  await until(() => !one.isRunning && !two.isRunning);
  assert.equal(small.provider.pool.size, 1);
});

test("after a restart a cold thread comes back from Claude's stored history, with no process started", async () => {
  const shared = new FakeFiles();
  const firstRun = fakeClaude({ files: shared });
  const before = await startTestBridge({ keepHome: true, providers: new Map([["claude", firstRun.provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(before);
  const session = (await phone.call("session.create", { profile: "claude", cwd, title: "Edit hello" })).session_id;
  await phone.call("slash.exec", { session_id: session, command: "mode edits" });
  await phone.close();
  await before.close();

  shared.stored.set(session, { title: "hello.txt edit and verify", messages: inFolder(recordedHistory("tools"), cwd) });
  const secondRun = fakeClaude({ files: shared });
  const after = await startTestBridge({ home: before.home, providers: new Map([["claude", secondRun.provider]]) });
  const again = await TestClient.open(after);
  try {
    const resumed = await again.call("session.resume", { session_id: session, profile: "claude", inline_images: false });
    assert.notEqual(after.replayEpoch, before.replayEpoch);
    assert.equal(resumed.running, false);
    assert.equal(resumed.info.title, "Edit hello");
    assert.deepEqual(
      resumed.messages.map((message: Frame) => (message.role === "tool" ? message.name : message.role)),
      ["user", "assistant", "read_file", "patch", "terminal", "assistant"],
    );
    assert.equal(JSON.parse(resumed.messages[3].content).diff, "--- a/hello.txt\n+++ b/hello.txt\n-hi\n+hello\n");
    assert.equal(sessionQueries(secondRun.queries).length, 0);
    // The mode set before the restart is kept, and applied when Claude starts.
    const start = again.frames.length;
    await again.call("prompt.submit", { session_id: session, text: "Again." });
    await until(() => sessionQueries(secondRun.queries).length === 1);
    const query = sessionQueries(secondRun.queries)[0];
    assert.equal(query.options.permissionMode, "acceptEdits");
    assert.equal(query.options.resume, session);
    void play(query, "plain");
    await again.from(start, (frame) => isEvent(frame, "message.complete", session));
  } finally {
    await again.close();
    // Removes the folder both runs used.
    await after.dispose();
  }
});

test("after a restart a thread's ended subagents and workflows come back from Claude's stored history, on the line of its last turn", async () => {
  const shared = new FakeFiles();
  const firstRun = fakeClaude({ files: shared });
  const before = await startTestBridge({ keepHome: true, providers: new Map([["claude", firstRun.provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(before);
  const session = (await phone.call("session.create", { profile: "claude", cwd })).session_id;
  await phone.close();
  await before.close();

  shared.stored.set(session, { title: null, messages: inFolder(recordedHistory("subagents"), cwd) });
  const after = await startTestBridge({ home: before.home, providers: new Map([["claude", fakeClaude({ files: shared }).provider]]) });
  const again = await TestClient.open(after);
  try {
    await again.call("session.resume", { session_id: session, profile: "claude", inline_images: false });
    const listed = (await again.call("subagent.list", { session_id: session, profile: "claude" })).subagents;
    assert.deepEqual(
      listed.map((subagent: Frame) => [subagent.subagent_id, subagent.kind, subagent.goal, subagent.name ?? null, subagent.status, subagent.can_stop]),
      [
        ["a24479d5e93836222", "agent", "Count the files", null, "completed", false],
        ["wwn9e3l29", "workflow", "Two haiku agents reply with apple and pear in parallel", "tiny-check", "completed", false],
      ],
    );
    // Both started by the first of the conversation's three turns, numbered back from its last.
    assert.deepEqual(listed.map((subagent: Frame) => subagent.turn), [-2, -2]);
    assert.match(listed[0].result, /^0 entries\./);
    assert.equal(listed[1].result, '["apple","pear"]');
    assert.ok(listed[0].ended_at > listed[0].started_at);
  } finally {
    await again.close();
    await after.dispose();
  }
});

test("after a restart a workflow comes back with the phases and agents its journal tells of", async () => {
  const shared = new FakeFiles();
  const firstRun = fakeClaude({ files: shared });
  const before = await startTestBridge({ keepHome: true, providers: new Map([["claude", firstRun.provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(before);
  const session = (await phone.call("session.create", { profile: "claude", cwd })).session_id;
  await phone.close();
  await before.close();

  const messages = inFolder(recordedHistory("subagents"), cwd);
  shared.stored.set(session, { title: null, messages });
  shared.journals.set(pastSubagents(messages)[1].journal!, tinyCheckJournal);
  const after = await startTestBridge({ home: before.home, providers: new Map([["claude", fakeClaude({ files: shared }).provider]]) });
  const again = await TestClient.open(after);
  try {
    await again.call("session.resume", { session_id: session, profile: "claude", inline_images: false });
    const listed = (await again.call("subagent.list", { session_id: session, profile: "claude" })).subagents;
    const workflow = listed.find((subagent: Frame) => subagent.kind === "workflow");
    assert.deepEqual(workflow.phases, [{ index: 1, title: "Check" }]);
    assert.deepEqual(
      workflow.agents.map((agent: Frame) => [agent.label, agent.phase, agent.status, agent.result, agent.duration_s]),
      [
        ["apple", "Check", "completed", "apple", 3.19],
        ["pear", "Check", "completed", "pear", 3.41],
      ],
    );
    assert.deepEqual([workflow.status, workflow.tokens, Math.round((workflow.ended_at - workflow.started_at) * 10) / 10], ["completed", 31614, 4.2]);
  } finally {
    await again.close();
    await after.dispose();
  }
});

test("after a restart a workflow cut off before its journal was written comes back with the agents its log tells of", async () => {
  const shared = new FakeFiles();
  const firstRun = fakeClaude({ files: shared });
  const before = await startTestBridge({ keepHome: true, providers: new Map([["claude", firstRun.provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(before);
  const session = (await phone.call("session.create", { profile: "claude", cwd })).session_id;
  await phone.close();
  await before.close();

  const messages = inFolder(recordedHistory("workflow-stop"), cwd);
  shared.stored.set(session, { title: null, messages });
  // No journal: only the log of its agents.
  shared.journals.set(pastSubagents(messages)[0].agentLog!, [{ type: "launched" }, { type: "started", key: "v2:cc09", agentId: "a6cc", label: "sleeper", phase: "Wait" }]);
  const after = await startTestBridge({ home: before.home, providers: new Map([["claude", fakeClaude({ files: shared }).provider]]) });
  const again = await TestClient.open(after);
  try {
    await again.call("session.resume", { session_id: session, profile: "claude", inline_images: false });
    const [workflow] = (await again.call("subagent.list", { session_id: session, profile: "claude" })).subagents;
    assert.equal(workflow.status, "stopped");
    assert.deepEqual(workflow.phases, [{ index: 1, title: "Wait" }]);
    assert.deepEqual(workflow.agents, [{ id: "1", label: "sleeper", phase: "Wait", status: "stopped" }]);
  } finally {
    await again.close();
    await after.dispose();
  }
});

test("after a restart an approved plan still goes back to the mode the thread had before planning", async () => {
  const shared = new FakeFiles();
  const firstRun = fakeClaude({ files: shared });
  const before = await startTestBridge({ keepHome: true, providers: new Map([["claude", firstRun.provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(before);
  const session = (await phone.call("session.create", { profile: "claude", cwd })).session_id;
  await phone.call("session.set_mode", { session_id: session, mode: "edits" });
  await phone.call("session.set_mode", { session_id: session, mode: "plan" });
  await phone.close();
  await before.close();

  shared.stored.set(session, { title: "Plan a file", messages: inFolder(recordedHistory("tools"), cwd) });
  const secondRun = fakeClaude({ files: shared });
  const after = await startTestBridge({ home: before.home, providers: new Map([["claude", secondRun.provider]]) });
  const again = await TestClient.open(after);
  try {
    await again.call("session.resume", { session_id: session, profile: "claude", inline_images: false });
    const start = again.frames.length;
    await again.call("prompt.submit", { session_id: session, text: "Plan a file." });
    await until(() => sessionQueries(secondRun.queries).length === 1);
    const query = sessionQueries(secondRun.queries)[0];
    assert.equal(query.options.permissionMode, "plan");
    const playing = play(query, "plan");
    const plan = await again.nextRequest();
    // Accept edits, as before planning: not Dana's settings (full access).
    assert.equal(plan.params.starts_in, "edits");
    again.answer(plan.id, { choice: "once" });
    const write = await again.nextRequest();
    again.answer(write.id, { choice: "once" });
    await again.from(start, (frame) => isEvent(frame, "message.complete", session));
    await playing;
    const approved = query.permissionResults.find((entry) => entry.tool === "ExitPlanMode")?.result as { updatedPermissions?: unknown };
    assert.deepEqual(approved.updatedPermissions, [{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
  } finally {
    await again.close();
    await after.dispose();
  }
});

test("shutting the bridge down stops every Claude process", async () => {
  const own = fakeClaude();
  const other = await startTestBridge({ providers: new Map([["claude", own.provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(other);
  const session = (await phone.call("session.create", { profile: "claude", cwd })).session_id;
  await phone.call("prompt.submit", { session_id: session, text: "Hello." });
  await until(() => sessionQueries(own.queries).length === 1);
  const [query] = sessionQueries(own.queries);
  await until(() => query.received.length === 1);
  void play(query, "plain");
  await phone.find((frame) => isEvent(frame, "message.complete", session));
  assert.equal(streamedText(phone.events(session)).startsWith("Hello"), true);
  await phone.close();
  await other.dispose();
  assert.equal(query.isRunning, false);
});

test("shutting the bridge down during a turn stops the turn as Stop does before Claude's input ends, so Claude's own history has it stopped", async () => {
  const own = fakeClaude();
  const other = await startTestBridge({ providers: new Map([["claude", own.provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(other);
  const session = (await phone.call("session.create", { profile: "claude", cwd })).session_id;
  await phone.call("prompt.submit", { session_id: session, text: "Run the long build." });
  await until(() => sessionQueries(own.queries).length === 1);
  const [query] = sessionQueries(own.queries);
  await until(() => query.received.length === 1);
  // The turn runs on; Claude takes the interrupt while its input is still open, and ends the turn.
  const runningAtInterrupt: boolean[] = [];
  const interrupt = query.interrupt.bind(query);
  query.interrupt = async () => {
    runningAtInterrupt.push(query.isRunning);
    return interrupt();
  };
  await phone.close();
  await other.dispose();
  assert.deepEqual(runningAtInterrupt, [true], "interrupted once, before its input ended");
  assert.equal(query.isRunning, false);
});

test("a workflow's journal is read only as a regular file in a session's folder, and a pipe there does not hold the thread up", async () => {
  const { sdkSessionFiles } = await import("../src/providers/claude/provider.ts");
  const readJournal = (path: string) => sdkSessionFiles.journal!(path);
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, truncateSync, writeFileSync } = await import("node:fs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "portals-journal-")));
  try {
    const session = join(root, "projects", "-w", "55b38f29");
    mkdirSync(join(session, "workflows"), { recursive: true });
    mkdirSync(join(session, "subagents", "workflows", "wf_pipe-1"), { recursive: true });
    writeFileSync(join(session, "workflows", "wf_good-1.json"), JSON.stringify({ taskId: "w1", status: "completed" }));
    // Not yet a session's folder: no session file beside it.
    assert.equal(await readJournal(join(session, "workflows", "wf_good-1.json")), null);
    writeFileSync(`${session}.jsonl`, "");
    assert.deepEqual(await readJournal(join(session, "workflows", "wf_good-1.json")), { taskId: "w1", status: "completed" });
    // A pipe at the agent log's path: nothing is read, at once.
    execFileSync("mkfifo", [join(session, "subagents", "workflows", "wf_pipe-1", "journal.jsonl")]);
    const started = Date.now();
    const pipe = await Promise.race([readJournal(join(session, "subagents", "workflows", "wf_pipe-1", "journal.jsonl")), new Promise((resolve) => setTimeout(() => resolve("waited"), 2000).unref())]);
    assert.equal(pipe, null);
    assert.ok(Date.now() - started < 1000);
    // One past the limit is not one, however it came to be that long.
    const big = join(session, "workflows", "wf_big-1.json");
    writeFileSync(big, "");
    truncateSync(big, 8 * 1024 * 1024 + 1);
    assert.equal(await readJournal(big), null);
    // Any other file, or a path that climbs out, is not a journal.
    writeFileSync(join(root, "secret.json"), "{}");
    assert.equal(await readJournal(join(root, "secret.json")), null);
    assert.equal(await readJournal(`${session}/workflows/../../../secret.json`), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retry of Claude's API that went through leaves no status line, live or for a device that catches up on the turn after it", async () => {
  const session = await createThread();
  const start = client.frames.length;
  const query = await send(session, "Hello.");
  const retrying = "Claude's API did not answer; trying again (attempt 6 of 10)…";
  query.emit({ type: "system", subtype: "api_retry", attempt: 6, max_retries: 10, retry_delay_ms: 1000, error_status: 529, error: "overloaded", uuid: "retry-1", session_id: session } as never);
  const shown = (await client.from(start, (frame) => isEvent(frame, "thinking.delta", session))).params;
  assert.deepEqual(shown.payload, { text: retrying });
  await play(query, "plain");
  await completed(session, start);
  const lines = turnEvents(session, start).filter((event) => event.type === "thinking.delta").map((event) => event.payload.text);
  assert.deepEqual(lines, [retrying, ""]);
  // A device that saw the line and then dropped is given its clear with what it missed.
  const missed = await client.call("session.events.since", { session_id: session, last_seen: shown.seq });
  assert.deepEqual(missed.events.filter((event: Frame) => event.type === "thinking.delta").map((event: Frame) => event.payload.text), [""]);
});

test("Claude Code's API retry heartbeat after a turn's end (a background agent waiting out a usage limit) is dropped at rest: no line sent, none held for the next run", async () => {
  const session = await createThread();
  const start = client.frames.length;
  const query = await send(session, "Hello.");
  await play(query, "plain");
  await completed(session, start);
  const rest = client.frames.length;
  const heartbeat = { type: "system", subtype: "api_retry", attempt: 3, max_retries: 10, retry_delay_ms: 60000, error_status: 429, error: "rate_limit", uuid: "retry-rest", session_id: session } as never;
  query.emit(heartbeat);
  query.emit(heartbeat);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(turnEvents(session, rest).filter((event) => event.type === "thinking.delta"), []);
  // Nothing is held for a device that opens the thread, nor for one catching up.
  assert.equal((await client.call("session.resume", { session_id: session })).status_line, undefined);
  // Inside a turn the line shows as before.
  const next = client.frames.length;
  await send(session, "Again.");
  query.emit({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 529, error: "overloaded", uuid: "retry-in", session_id: session } as never);
  const shown = (await client.from(next, (frame) => isEvent(frame, "thinking.delta", session))).params;
  assert.deepEqual(shown.payload, { text: "Claude's API did not answer; trying again (attempt 1 of 10)…" });
  await play(query, "plain", { from: 1 });
  await completed(session, next);
});
