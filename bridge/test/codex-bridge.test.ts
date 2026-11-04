import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { setLogLevel } from "../src/log.ts";
import { machineWord } from "../src/platform.ts";
import { CodexClient, socketConnector } from "../src/providers/codex/client.ts";
import { titleSchema } from "../src/providers/codex/naming.ts";
import { CodexProvider } from "../src/providers/codex/provider.ts";
import { CodexSession } from "../src/providers/codex/session.ts";
import { providerModeOptions } from "../src/providers/modes.ts";
import { Session } from "../src/sessions/session.ts";
import { WaitingStore } from "../src/sessions/waiting.ts";
import { fixtureCwd, recordedHistory, recordedThread, rewrite } from "./codex-fixtures.ts";
import { FakeDaemon, type DaemonConnection } from "./codex-daemon.ts";
import { isEvent, RpcFailure, startTestBridge, TestClient, type Frame, type TestBridge } from "./helpers.ts";

// Codex threads through the whole bridge, as the app sees them, against a stand-in for
// Codex's shared app-server daemon (test/codex-daemon.ts) that plays recorded turns:
// the connection, the sessions, turns, questions and modes are the real code; only the
// daemon is played.

let daemon: FakeDaemon;
let bridge: TestBridge;
let client: TestClient;
let cwd: string;
let images: string;

function codexProvider(imagesDir = images, interruptGraceMs?: number): CodexProvider {
  return new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir },
    connect: socketConnector(daemon.socketPath),
    checkVersion: false,
    configPath: join(daemon.folder, "config.toml"),
    timeZone: "UTC",
    backoff: [0.05, 0.1],
    interruptGraceMs,
  });
}

before(async () => {
  daemon = await FakeDaemon.start();
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "portals-codex-test-")));
  writeFileSync(join(cwd, "hello.txt"), "hi\n");
  images = mkdtempSync(join(tmpdir(), "portals-codex-images-"));
  // The thread folder is General: a temporary folder is never on the list of others.
  const provider = codexProvider();
  assert.equal(providerModeOptions(provider), undefined, "Codex retains the app's original mode labels, order and wording");
  bridge = await startTestBridge({ providers: new Map([["codex", provider]]), config: { generalFolder: cwd } });
  client = await TestClient.open(bridge);
});

after(async () => {
  await client.close();
  await bridge.dispose();
  await daemon.close();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(images, { recursive: true, force: true });
});

// Generous: it returns as soon as `check` holds, and six agents may share the machine.
async function until(check: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function createThread(params: Record<string, unknown> = {}, on = client): Promise<string> {
  return (await on.call("session.create", { profile: "codex", source: "tui", cwd, ...params })).session_id;
}

/** Sends a message and returns the turn/start it made. */
async function send(session: string, text: string, on = client) {
  const from = daemon.calls.length;
  const reply = await on.call("prompt.submit", { session_id: session, text, profile: "codex" });
  assert.equal(reply.status, "streaming");
  return daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === session, from);
}

function turnEvents(session: string, start: number, on = client): Frame[] {
  return on.frames.slice(start).filter((frame) => frame.method === "event" && frame.params.session_id === session).map((frame) => frame.params);
}

/**
 * The turn's end, once the device heard it. `timeoutMs` only ends a wait for an end that
 * never comes: a Mac busy with the whole suite and a build may take more than 3 s to start
 * a bridge again and run a turn on it.
 */
async function completed(session: string, start: number, on = client, timeoutMs = 20_000): Promise<Frame> {
  return (await on.from(start, (frame) => isEvent(frame, "message.complete", session), timeoutMs)).params;
}

/** What the bridge answered Codex for the requests of a thread, in order. */
function answersFor(thread: string): unknown[] {
  return daemon.answers.filter((answer) => answer.threadId === thread).map((answer) => answer.result ?? answer.error);
}

test("profiles.list and model.options describe Codex from its own model list and config.toml", async () => {
  assert.deepEqual(await client.call("model.options", { profile: "codex" }), {
    providers: [{ slug: "openai", name: "OpenAI", models: ["gpt-6.1-sol", "gpt-6-luna"], authenticated: true }],
    model: "gpt-6.1-sol",
    provider: "openai",
    // Each model's supportedReasoningEfforts, as the app's level names.
    model_levels: { "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max", "ultra"], "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"] },
    // Its threads take a mode; config.toml (never, full access) comes to full.
    modes: { default: "full" },
  });
  assert.deepEqual((await client.call("profiles.list")).profiles, [
    { name: "codex", kind: "codex", display_name: "Codex", description: `Codex on this ${machineWord()}, with your own settings and sign-in.`, model: "gpt-6.1-sol", provider: "openai", is_default: true, adopt_modes: ["continue", "fork", "read"] },
  ]);
  assert.deepEqual(await client.call("config.get", { key: "reasoning", profile: "codex" }), { value: "high" });
  // The handshake named the bridge.
  const initialize = daemon.callsOf("initialize")[0];
  assert.deepEqual(initialize.params.clientInfo.name, "portals-bridge");
  assert.deepEqual(initialize.params.capabilities, { experimentalApi: true, requestAttestation: false });
  assert.ok(initialize.connection.received.some((message) => message.method === "initialized"));
  assert.equal(initialize.connection.received.some((message) => "jsonrpc" in message), false);
});

test("session.create starts a Codex thread in the folder, and its id is the thread's", async () => {
  const from = daemon.calls.length;
  const created = await client.call("session.create", { profile: "codex", source: "tui", cwd, title: "Probe" });
  const start = await daemon.waitForCall((call) => call.method === "thread/start", from);
  assert.deepEqual(start.params, { cwd, model: "gpt-6.1-sol" });
  assert.ok(daemon.threads.has(created.session_id));
  assert.equal(created.stored_session_id, created.session_id);
  assert.equal(created.info.cwd, cwd);
  assert.equal(created.info.model, "gpt-6.1-sol");
  assert.equal(created.info.provider, "openai");
  assert.equal(created.info.reasoning_effort, "high");
  await assert.rejects(client.call("session.create", { profile: "codex", cwd: "/no/such/folder" }), (error: RpcFailure) => error.code === -32602);
});

test("a chat: commentary, a command row and the reply; the first message names the thread; turn/start carries only what differs", async () => {
  const session = await createThread();
  const start = client.frames.length;
  daemon.scripts.push("plain");
  const turn = await send(session, "List this folder.\nThen tell me about 221.");
  // Dana's model, level and policy already hold: only reasoning summaries are asked for.
  assert.deepEqual(Object.keys(turn.params).sort(), ["clientUserMessageId", "input", "summary", "threadId"]);
  assert.deepEqual(turn.params.input, [{ type: "text", text: "List this folder.\nThen tell me about 221.", text_elements: [] }]);
  assert.equal(turn.params.summary, "auto");

  const done = await completed(session, start);
  const events = turnEvents(session, start);
  assert.deepEqual(
    events.map((event) => event.type).filter((type, index, all) => type !== all[index - 1]),
    ["message.start", "session.title", "message.delta", "message.interim", "tool.start", "tool.complete", "session.usage", "message.delta", "session.usage", "message.complete"],
  );
  assert.deepEqual(events.find((event) => event.type === "session.title").payload, { title: "List this folder." });
  assert.deepEqual(events.find((event) => event.type === "message.interim").payload, { text: "I’ll list this folder and check whether 221 is prime.", already_streamed: true });
  const command = events.find((event) => event.type === "tool.complete").payload;
  assert.deepEqual(command.args, { command: "ls" });
  assert.deepEqual(command.result, { output: "hello.txt\n", exit_code: 0 });
  // Which turn it was, as the list numbers it (net-20).
  const { turn: listedTurn, ...ended } = done.payload;
  assert.ok(Number.isInteger(listedTurn));
  // What the turn spent (feature turn_usage): Codex's time for it, and how far the thread's tokens rose.
  assert.deepEqual(ended, {
    status: "complete",
    text: "I saw `hello.txt`; 221 is not prime because 221 = 13 × 17.",
    usage: { context_used: 24843, context_max: 258_400 },
    turn_usage: { seconds: 6.2, tokens: 49_635 },
  });

  // Codex's own warnings stay in the log.
  const before = client.events(session).length;
  daemon.broadcast("warning", { threadId: session, message: "Codex is ignoring 1 unrecognized configuration setting." });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.events(session).length, before);

  const resumed = await client.call("session.resume", { session_id: session });
  assert.deepEqual(
    resumed.messages.map((message: Frame) => (message.role === "tool" ? message.name : message.role)),
    ["user", "assistant", "terminal", "assistant"],
  );
  assert.equal(resumed.info.title, "List this folder.");
});

test("Codex permission changes queue a prompt instead of steering it into the previous Full policy", async () => {
  const session = await createThread();
  await client.call("session.set_mode", { session_id: session, mode: "full" });
  await send(session, "first under Full");
  const firstTurn = await daemon.activeTurn(session);
  assert.equal(daemon.threads.get(session)!.approvalPolicy, "never");
  await client.call("session.set_mode", { session_id: session, mode: "ask" });
  const from = daemon.calls.length;
  assert.equal((await client.call("prompt.submit", { session_id: session, text: "must ask" })).status, "queued");
  assert.equal(daemon.callsOf("turn/steer").filter((call) => call.params.threadId === session).length, 0);
  daemon.finishTurn(session, firstTurn, "First done.");
  const next = await daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === session, from);
  assert.equal(next.params.approvalPolicy, "untrusted");
  assert.equal(next.params.sandboxPolicy.type, "workspaceWrite");
  daemon.finishTurn(session, await daemon.activeTurn(session), "Done with Ask.");
});

test("/mode ask: Codex asks before the edit and each command; the answers go back as Codex's decisions", async () => {
  const session = await createThread();
  assert.deepEqual(await client.call("slash.exec", { session_id: session, command: "mode ask", profile: "codex" }), {
    type: "exec",
    output: "This thread now asks before editing files or running commands.",
  });
  const start = client.frames.length;
  daemon.scripts.push("tools");
  const turn = await send(session, "Change hi to hello.");
  assert.equal(turn.params.approvalPolicy, "untrusted");
  assert.deepEqual(turn.params.sandboxPolicy, { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });

  const read = await client.nextRequest();
  assert.equal(read.method, "approval");
  assert.deepEqual(read.params, { session_id: session, command: "cat hello.txt", choices: ["once", "always", "deny"], description: "Codex wants to run a command" });
  client.answer(read.id, { choice: "once" });
  const edit = await client.nextRequest();
  assert.deepEqual(edit.params, {
    session_id: session,
    command: `Edit ${cwd}/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n`,
    choices: ["once", "session", "deny"],
    description: "Codex wants to change a file",
  });
  client.answer(edit.id, { choice: "session" });
  const count = await client.nextRequest();
  assert.equal(count.params.command, "wc -c hello.txt");
  client.answer(count.id, { choice: "always" });
  const done = await completed(session, start);
  assert.equal(done.payload.text, "Patched `hi` to `hello`; `wc -c hello.txt` reports 6 bytes.");
  assert.deepEqual(answersFor(session), [
    { decision: "accept" },
    { decision: "acceptForSession" },
    { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["wc", "-c", "hello.txt"] } } },
  ]);
  const patch = turnEvents(session, start).find((event) => event.type === "tool.complete" && event.payload.name === "patch").payload;
  assert.deepEqual(patch.result, { success: true, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n" });
  // The phone's answer closed its own card: no cancel came back to it.
  assert.equal(turnEvents(session, start).some((event) => event.type === "request.cancel"), false);
  assert.match((await client.call("slash.exec", { session_id: session, command: "status" })).output, /\nMode: ask\n/);
  assert.equal(
    (await client.call("slash.exec", { session_id: session, command: "mode" })).output,
    "Mode: ask. This thread asks before editing files or running commands.\nChange it with /mode ask, edits, plan, full or default.",
  );
});

test("one change denied and one allowed: the denied ones are blocked rows, and the turn goes on", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode ask" });
  const start = client.frames.length;
  daemon.scripts.push("approval");
  await send(session, "Create note.txt, touch done.txt, create other.txt.");
  for (const choice of ["deny", "deny", "once"]) {
    const request = await client.nextRequest();
    client.answer(request.id, { choice });
  }
  const done = await completed(session, start);
  assert.equal(done.payload.status, "complete");
  assert.deepEqual(answersFor(session), [{ decision: "decline" }, { decision: "decline" }, { decision: "accept" }]);
  const results = turnEvents(session, start)
    .filter((event) => event.type === "tool.complete")
    .map((event) => event.payload.result);
  assert.deepEqual(results, [
    { status: "blocked", error: "Declined.", user_summary: "You denied this change — it was not made." },
    { status: "blocked", error: "Declined.", user_summary: "You denied this command — it did not run." },
    { diff: "--- /dev/null\n+++ b/other.txt\n@@ -0,0 +1 @@\n+other\n" },
  ]);
});

test("a no with a note: Codex is sent the decline first, then the note steered into the turn that asked", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode ask" });
  const start = client.frames.length;
  daemon.scripts.push("approval");
  await send(session, "Create note.txt, touch done.txt, create other.txt.");
  let answeredBeforeSteer: number | null = null;
  daemon.onSteer = () => {
    answeredBeforeSteer = answersFor(session).length;
  };
  const first = await client.nextRequest();
  client.answer(first.id, { choice: "deny", note: "  Call it notes.txt instead.  " });
  for (const choice of ["deny", "once"]) {
    const request = await client.nextRequest();
    client.answer(request.id, { choice });
  }
  await completed(session, start);
  daemon.onSteer = () => {};
  assert.deepEqual(answersFor(session), [{ decision: "decline" }, { decision: "decline" }, { decision: "accept" }]);
  // Only the no with a note was followed by a message, and only once Codex had the no.
  const steers = daemon.callsOf("turn/steer").filter((call) => call.params.threadId === session);
  assert.deepEqual(
    steers.map((call) => call.params.input),
    [[{ type: "text", text: "Call it notes.txt instead.", text_elements: [] }]],
  );
  assert.equal(answeredBeforeSteer, 1);
  // Every device is shown it waiting, then handed to the turn, where it shows.
  const lists = turnEvents(session, start).filter((event) => event.type === "queue.changed").map((event) => event.payload);
  assert.deepEqual(lists, [
    { queued: [{ id: "1", text: "Call it notes.txt instead." }], can_steer: true },
    { queued: [], can_steer: true, steered: "1" },
  ]);
  const stored = (await client.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(
    stored.filter((message: Frame) => message.role === "user").map((message: Frame) => [message.text, message.display_kind]),
    [
      ["Create note.txt, touch done.txt, create other.txt.", undefined],
      ["Call it notes.txt instead.", "steer"],
    ],
  );
});

test("a note Codex refuses to take into the turn that asked, still running, goes in a turn of its own once that turn ends", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Run make.");
  const turnId = await daemon.activeTurn(session);
  void daemon.request(session, "item/commandExecution/requestApproval", { threadId: session, turnId, itemId: "c4", command: "make" });
  const card = await client.next((frame) => frame.method === "approval" && frame.params.session_id === session);
  daemon.onSteer = () => {
    throw new Error("this turn takes no message in");
  };
  client.answer(card.id, { choice: "deny", note: "Run make test instead." });
  await until(() => daemon.callsOf("turn/steer").some((call) => call.params.threadId === session));
  daemon.onSteer = () => {};
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(daemon.thread(session).turns.length, 1);
  daemon.finishTurn(session, turnId, "Did not run make.");
  const starts = () => daemon.callsOf("turn/start").filter((call) => call.params.threadId === session);
  await until(() => starts().length === 2);
  assert.deepEqual(starts()[1].params.input, [{ type: "text", text: "Run make test instead.", text_elements: [] }]);
  await until(() => daemon.thread(session).turns.length === 2);
  daemon.finishTurn(session, daemon.thread(session).turns[1].id, "Ran make test.");
  const ends = () => turnEvents(session, start).filter((event) => event.type === "message.complete");
  await until(() => ends().length === 2);
  assert.deepEqual(ends().map((event) => event.payload.text), ["Did not run make.", "Ran make test."]);
  // Not taken, so no warning that it was lost.
  assert.equal(turnEvents(session, start).some((event) => event.type === "status.update" && /did not take/.test(event.payload.text)), false);
});

test("/mode with no argument says the thread follows config.toml; /mode default sends Dana's own policy back", async () => {
  const session = await createThread();
  assert.equal(
    (await client.call("slash.exec", { session_id: session, command: "mode" })).output,
    "Mode: default. This thread follows your Codex settings: it edits files and runs commands without asking.\nChange it with /mode ask, edits, plan, full or default.",
  );
  assert.equal((await client.call("slash.exec", { session_id: session, command: "mode plan" })).output, "This thread now plans first, and asks before carrying the plan out.");
  assert.equal(
    (await client.call("command.dispatch", { session_id: session, name: "mode", arg: "edits" })).output,
    "This thread now edits files and runs commands in its folder without asking, and asks before going outside it.",
  );
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  let start = client.frames.length;
  let turn = await send(session, "Plan it.");
  // Codex's own plan mode, with the policy of the mode the plan is to be carried out in.
  assert.deepEqual(turn.params.collaborationMode, { mode: "plan", settings: { model: "gpt-6.1-sol", reasoning_effort: "high", developer_instructions: null } });
  assert.equal(turn.params.approvalPolicy, "on-request");
  assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
  // A plan-mode turn that ends without a plan just ends.
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);

  assert.equal((await client.call("slash.exec", { session_id: session, command: "mode default" })).output, "This thread now follows your Codex settings: it edits files and runs commands without asking.");
  start = client.frames.length;
  turn = await send(session, "Now do it.");
  assert.equal(turn.params.approvalPolicy, "never");
  assert.deepEqual(turn.params.sandboxPolicy, { type: "dangerFullAccess" });
  // Out of plan mode once; Codex keeps it.
  assert.equal(turn.params.collaborationMode.mode, "default");
  // Summaries were asked for once; Codex keeps them for the thread.
  assert.equal(turn.params.summary, undefined);
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
});

test("requestUserInput is a question card, and the answer goes back keyed by the question's id", async () => {
  const session = await createThread();
  const start = client.frames.length;
  daemon.scripts.push("clarify");
  await send(session, "Ask me which language I prefer.");
  const question = await client.nextRequest();
  assert.equal(question.method, "clarify");
  // With its heading and what each choice means (feature question_details), as Codex gave them.
  assert.deepEqual(question.params.questions, [
    {
      qid: "preferred_language",
      question: "Which language do you prefer?",
      choices: ["Python", "Swift"],
      multi_select: false,
      header: "Language",
      descriptions: { Python: "Choose Python as your preferred language.", Swift: "Choose Swift as your preferred language." },
    },
  ]);
  client.answer(question.id, { answers: { preferred_language: "Swift" } });
  const done = await completed(session, start);
  assert.equal(done.payload.text, "You prefer Swift.");
  assert.deepEqual(answersFor(session), [{ answers: { preferred_language: { answers: ["Swift"] } } }]);
  // The thread keeps it as asked and answered, which Codex's history does not.
  const row = (await client.call("session.resume", { session_id: session })).messages.find((message: Frame) => message.name === "clarify");
  assert.deepEqual(row.args, { questions: [{ question: "Which language do you prefer?", choices: ["Python", "Swift"] }] });
  assert.deepEqual(JSON.parse(row.content), { responses: [{ question: "Which language do you prefer?", user_response: "Swift" }] });
});

/** The plan in the recording of a plan-mode turn, as Codex proposed it. */
function recordedPlan(): string {
  const items = rewrite(recordedHistory("plan"), [[fixtureCwd, cwd]]).turns[0].items;
  return items.find((item: { type: string }) => item.type === "plan").text.trim();
}

test("/mode plan is Codex's plan mode: its plan is a plan card, and Start carries it out in the mode from before, in the same turn", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode edits" });
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  daemon.scripts.push("plan");
  const planning = await send(session, "Plan how to change hi to hello in hello.txt.");
  assert.equal(planning.params.collaborationMode.mode, "plan");

  const card = await client.nextRequest();
  assert.equal(card.method, "approval");
  assert.deepEqual(card.params, {
    session_id: session,
    command: recordedPlan(),
    choices: ["once", "deny"],
    description: "Codex has a plan",
    plan: true,
    starts_in: "edits",
  });
  // Codex's turn is over, the app's is not: it waits for the answer.
  assert.equal(turnEvents(session, start).some((event) => event.type === "message.complete"), false);
  const from = daemon.calls.length;
  client.answer(card.id, { choice: "once" });
  const work = await daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === session, from);
  assert.deepEqual(work.params.input, [{ type: "text", text: "Implement the plan.", text_elements: [] }]);
  assert.equal(work.params.collaborationMode.mode, "default");
  assert.equal(work.params.approvalPolicy, undefined, "the policy was the work's all along");
  assert.deepEqual((await client.from(start, (frame) => isEvent(frame, "session.mode", session))).params.payload, { mode: "edits", mode_default: "full" });

  daemon.finishTurn(session, await daemon.activeTurn(session), "Changed it.");
  const done = await completed(session, start);
  assert.equal(done.payload.status, "complete");
  assert.match(done.payload.text, /Changed it\.$/);
  // One turn for the app, with the plan as its row.
  assert.equal(turnEvents(session, start).filter((event) => event.type === "message.complete").length, 1);
  assert.equal(turnEvents(session, start).filter((event) => event.type === "message.start").length, 1);
  const row = turnEvents(session, start).find((event) => event.type === "tool.complete" && event.payload.name === "plan");
  assert.equal(row.payload.args.content.trim(), recordedPlan());
  assert.match((await client.call("slash.exec", { session_id: session, command: "status" })).output, /\nMode: edits\n/);
});

/** The next card thread `session` puts to the app, past any an earlier test left unanswered. */
function cardOf(session: string): Promise<Frame> {
  return client.next((frame) => typeof frame.id === "string" && frame.id.startsWith("srq-") && typeof frame.method === "string" && frame.params?.session_id === session);
}

/** Codex's news of what thread `threadId` has spent: `total` so far, `last` the request it tells of. */
function spentNews(threadId: string, turnId: string, total: number, last: number): void {
  daemon.broadcast("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: { total: { inputTokens: total - 10, outputTokens: 10, totalTokens: total }, last: { inputTokens: last - 10, outputTokens: 10, totalTokens: last }, modelContextWindow: 258_400 },
  });
}

test("a plan carried out in the same turn of the app's has what its planning spent in the turn's footer too (turn_usage)", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  daemon.scripts.push("plan");
  await send(session, "Plan how to change hi to hello in hello.txt.");
  const card = await cardOf(session);
  assert.equal(card.params.plan, true);
  const from = daemon.calls.length;
  client.answer(card.id, { choice: "once" });
  await daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === session, from);
  const work = await daemon.activeTurn(session);
  // The recording's plan turn took the thread's total to 77,784; carrying it out spends 300 more.
  spentNews(session, work, 78_084, 300);
  daemon.finishTurn(session, work, "Changed it.");
  const done = await completed(session, start);
  assert.equal(done.payload.status, "complete");
  assert.equal(done.payload.turn_usage.tokens, 78_084);
});

test("Keep planning with a note sends the note in plan mode; without one the turn ends and the thread stays in plan mode", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  daemon.scripts.push("plan", "plan");
  await send(session, "Plan how to change hi to hello in hello.txt.");
  const first = await client.nextRequest();
  // Its work would follow Codex's own settings.
  assert.equal(first.params.starts_in, "default");
  let from = daemon.calls.length;
  client.answer(first.id, { choice: "deny", note: "Use sed for it." });
  const again = await daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === session, from);
  assert.deepEqual(again.params.input, [{ type: "text", text: "Use sed for it.", text_elements: [] }]);
  assert.equal(again.params.collaborationMode.mode, "plan");

  const second = await client.nextRequest();
  assert.equal(second.params.plan, true);
  from = daemon.calls.length;
  client.answer(second.id, { choice: "deny" });
  const done = await completed(session, start);
  assert.equal(done.payload.status, "complete");
  assert.equal(daemon.calls.slice(from).some((call) => call.method === "turn/start"), false);
  assert.equal(turnEvents(session, start).some((event) => event.type === "session.mode"), false);
  assert.match((await client.call("slash.exec", { session_id: session, command: "mode" })).output, /^Mode: plan\./);
});

test("Stop while a plan card is open closes the card and ends the turn, with nothing for Codex to stop", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  daemon.scripts.push("plan");
  await send(session, "Plan it.");
  const card = await client.nextRequest();
  // A message sent meanwhile waits for the turn: Codex runs nothing to take it in.
  assert.equal((await client.call("prompt.submit", { session_id: session, text: "Also check the spelling.", profile: "codex" })).status, "queued");
  const interrupts = daemon.callsOf("turn/interrupt").length;
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  const cancel = await client.from(start, (frame) => isEvent(frame, "request.cancel", session));
  assert.deepEqual(cancel.params.payload, { id: card.id, reason: "interrupted" });
  const done = await completed(session, start);
  assert.equal(done.payload.status, "interrupted");
  assert.equal(daemon.callsOf("turn/interrupt").length, interrupts);
  // The message that waited has its turn, still in plan mode.
  const next = await daemon.nextCall("turn/start");
  assert.deepEqual(next.params.input[0].text, "Also check the spelling.");
  assert.equal(next.params.collaborationMode.mode, "plan");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await until(() => turnEvents(session, start).filter((event) => event.type === "message.complete").length === 2);
});

test("a message sent while Codex works is steered into the running turn, which ends once", async () => {
  const session = await createThread();
  const start = client.frames.length;
  daemon.scripts.push("steer");
  await send(session, "Count to 40.");
  await client.from(start, (frame) => isEvent(frame, "message.delta", session));
  const from = daemon.calls.length;
  assert.deepEqual(await client.call("prompt.submit", { session_id: session, text: "Then say banana." }), { status: "steered" });
  const steer = await daemon.waitForCall((call) => call.method === "turn/steer", from);
  assert.equal(steer.params.threadId, session);
  assert.equal(steer.params.expectedTurnId, rewrite(recordedHistory("steer"), []).turns[0].id);
  assert.deepEqual(steer.params.input, [{ type: "text", text: "Then say banana.", text_elements: [] }]);
  const done = await completed(session, start);
  const events = turnEvents(session, start);
  assert.equal(events.filter((event) => event.type === "message.complete").length, 1);
  assert.equal(events.filter((event) => event.type === "message.interim").length, 1);
  // Codex (0.162.1) lets go of the message it was writing when one is steered in, and
  // writes it again from the start with the steer in mind: what it had written is the
  // interim piece, and the reply is the whole message.
  assert.match(events.find((event) => event.type === "message.interim").payload.text, /^1\n2\n3\n/);
  assert.match(done.payload.text, /^1\n2\n3\n[\s\S]*\n40\nbanana$/);
  const stored = (await client.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(
    stored.filter((message: Frame) => message.role === "user").map((message: Frame) => [message.text, message.display_kind]),
    [
      ["Count to 40.", undefined],
      ["Then say banana.", "steer"],
    ],
  );
});

/**
 * A message steered into a turn that ends before Codex takes it: answered in a turn of
 * its own after it, which opens with nothing (the message shows in the turn before).
 * `told`: the bridge hears the turn ended before Codex refuses the message; else after.
 */
async function missedSteer(told: boolean): Promise<void> {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Count to 10.");
  await until(() => daemon.thread(session).status.type === "active");
  const turnID = daemon.thread(session).turns[0].id;
  daemon.onSteer = () => {
    daemon.onSteer = () => {};
    if (told) {
      daemon.finishTurn(session, turnID, "1 2 3 4 5 6 7 8 9 10");
      return;
    }
    // Codex has ended the turn and not yet said so.
    Object.assign(daemon.thread(session).turns[0], { status: "completed" });
    daemon.thread(session).status = { type: "idle" };
  };
  const from = daemon.calls.length;
  assert.deepEqual(await client.call("prompt.submit", { session_id: session, text: "Then say banana." }), { status: "steered" });
  if (!told) {
    await until(() => daemon.calls.slice(from).some((call) => call.method === "thread/read" && call.params.threadId === session));
    daemon.finishTurn(session, turnID, "1 2 3 4 5 6 7 8 9 10");
  }
  const starts = () => daemon.callsOf("turn/start").filter((call) => call.params.threadId === session);
  await until(() => starts().length === 2);
  const again = starts()[1];
  assert.deepEqual(again.params.input, [{ type: "text", text: "Then say banana.", text_elements: [] }]);
  await until(() => daemon.thread(session).turns.length === 2);
  daemon.finishTurn(session, daemon.thread(session).turns[1].id, "banana");
  const ends = () => turnEvents(session, start).filter((event) => event.type === "message.complete");
  await until(() => ends().length === 2);
  assert.deepEqual(
    ends().map((event) => event.payload.text),
    ["1 2 3 4 5 6 7 8 9 10", "banana"],
  );
  assert.equal(turnEvents(session, start).filter((event) => event.type === "message.start").length, 2);
  const stored = (await client.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(
    stored.filter((message: Frame) => message.role === "user").map((message: Frame) => [message.text, message.display_kind]),
    [
      ["Count to 10.", undefined],
      ["Then say banana.", "steer"],
      ["", "hidden"],
    ],
  );
}

test("a message steered as Codex ends its turn, once the bridge has heard, gets a turn of its own", async () => {
  await missedSteer(true);
});

test("a message steered as Codex ends its turn, before the bridge has heard, gets a turn of its own after it", async () => {
  await missedSteer(false);
});

test("a message Codex says no to while its turn runs waits on disk as one Codex surely never had, so after a restart its turn opens with its words", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Count to 10.");
  const turnId = await daemon.activeTurn(session);
  daemon.onSteer = () => {
    daemon.onSteer = () => {};
    throw new Error("this turn takes no message in");
  };
  assert.deepEqual(await client.call("prompt.submit", { session_id: session, text: "Then say banana." }), { status: "steered" });
  const kept = () => (existsSync(join(bridge.home, "state", "waiting", `${session}.json`)) ? new WaitingStore(join(bridge.home, "state", "waiting")).read(session) : []);
  await until(() => kept().length === 1);
  assert.deepEqual(kept().map((message) => [message.text, message.resent, message.refused]), [["Then say banana.", true, true]]);
  daemon.finishTurn(session, turnId, "1 2 3 4 5 6 7 8 9 10");
  const starts = () => daemon.callsOf("turn/start").filter((call) => call.params.threadId === session);
  await until(() => starts().length === 2);
  await until(() => daemon.thread(session).turns.length === 2);
  daemon.finishTurn(session, daemon.thread(session).turns[1].id, "banana");
  await until(() => turnEvents(session, start).filter((event) => event.type === "message.complete").length === 2);
});

test("/mcp says how Codex runs the thread's MCP servers, every page; a thread Codex has not loaded gets them as set up", async () => {
  const session = await createThread();
  const mcp = async () => (await client.call("slash.exec", { session_id: session, command: "mcp", profile: "codex" })).output as string;
  daemon.mcpServers = [
    { name: "docs", runtimeStatus: "connected", authStatus: "unsupported", tools: { search: {}, fetch: {} }, toolsError: null },
    { name: "github", runtimeStatus: "authenticationRequired", authStatus: "notLoggedIn", tools: {}, toolsError: null },
    { name: "db", runtimeStatus: "failed", authStatus: "unsupported", tools: {}, toolsError: "MCP startup failed: spawn db-server ENOENT" },
    { name: "old", runtimeStatus: "disabled", authStatus: "unsupported", tools: {}, toolsError: null },
    { name: "slow", runtimeStatus: "starting", authStatus: "unsupported", tools: { look: {} }, toolsError: null },
  ];
  try {
    let from = daemon.calls.length;
    assert.equal(await mcp(), [
      "Codex MCP servers:",
      "db: failed (MCP startup failed: spawn db-server ENOENT)",
      "docs: connected, 2 tools",
      "github: needs sign-in",
      "old: off",
      "slow: starting",
      "To sign in to one, run codex mcp login <name> on the host.",
    ].join("\n"));
    const asked = daemon.calls.slice(from).filter((call) => call.method === "mcpServerStatus/list");
    assert.deepEqual(asked.map((call) => call.params), [
      { detail: "toolsAndAuthOnly", limit: 100, threadId: session },
      { detail: "toolsAndAuthOnly", limit: 100, threadId: session, cursor: "2" },
      { detail: "toolsAndAuthOnly", limit: 100, threadId: session, cursor: "4" },
    ]);

    // Codex has let the thread go: none of its servers runs, and Codex is asked of none.
    daemon.thread(session).loaded = false;
    from = daemon.calls.length;
    assert.equal(await mcp(), [
      "Codex MCP servers:",
      "Not started for this thread yet. Each is as set up, with the tools Codex last found.",
      "db: failed (MCP startup failed: spawn db-server ENOENT)",
      "docs: not started, 2 tools",
      "github: needs sign-in",
      "old: not started",
      "slow: not started, 1 tool",
      "To sign in to one, run codex mcp login <name> on the host.",
    ].join("\n"));
    assert.equal(daemon.calls.slice(from).filter((call) => call.method === "mcpServerStatus/list" && call.params.threadId === undefined).length, 3);

    daemon.mcpServers = [];
    assert.equal(await mcp(), "Codex MCP servers:\nNone set up.");
  } finally {
    daemon.mcpServers = [];
    daemon.thread(session).loaded = true;
  }
});

test("/compact is offered and runs thread/compact/start: a turn of its own, marked where it compacted, which resume and replay keep", async () => {
  const catalog = await client.call("commands.catalog", { profile: "codex" });
  assert.deepEqual(catalog.categories[1], { name: "Codex", pairs: [["/compact", "Summarise the conversation so far, to free up context"], ["/mcp", "Show your MCP servers and whether each is connected"]] });
  const session = await createThread();
  assert.deepEqual(await client.call("command.dispatch", { session_id: session, name: "compact" }), { type: "send", message: "/compact" });

  let start = client.frames.length;
  daemon.scripts.push("compact");
  await send(session, "Reply with the single word hello. Do not use any tools.");
  await completed(session, start);

  start = client.frames.length;
  const from = daemon.calls.length;
  assert.deepEqual(await client.call("prompt.submit", { session_id: session, text: "/compact" }), { status: "streaming" });
  const compact = await daemon.waitForCall((call) => call.method === "thread/compact/start", from);
  assert.deepEqual(compact.params, { threadId: session });
  const done = await completed(session, start);
  await Promise.all(daemon.playing);
  const events = turnEvents(session, start);
  assert.deepEqual(
    events.map((event) => event.type),
    ["message.start", "thinking.delta", "session.usage", "thinking.delta", "session.compacted", "message.complete"],
  );
  const compacted = events.find((event) => event.type === "session.compacted");
  assert.deepEqual(compacted.payload, { trigger: "manual", tokens_before: 24706 });
  const { turn: compactTurn, ...compactEnd } = done.payload;
  assert.ok(Number.isInteger(compactTurn));
  assert.deepEqual(compactEnd, { status: "complete", text: "", usage: { context_used: 15254, context_max: 258_400 }, turn_usage: { seconds: 0.9 } });
  // No message went to Codex as words.
  assert.equal(daemon.callsOf("turn/start").filter((call) => call.params.threadId === session).length, 1);

  const resumed = await client.call("session.resume", { session_id: session });
  assert.deepEqual(
    resumed.messages.map((message: Frame) => (message.role === "compaction" ? [message.role, message.trigger, message.tokens_before] : [message.role, message.text])),
    [
      ["user", "Reply with the single word hello. Do not use any tools."],
      ["assistant", "hello"],
      ["user", "/compact"],
      ["compaction", "manual", 24706],
    ],
  );
  const replayed = await client.call("session.events.since", { session_id: session, last_seen: compacted.seq - 1 });
  assert.deepEqual(replayed.events[0], compacted);
});

test("/compact with a file attached is words for Codex, as with an image: the message and the file go in a turn, and nothing is compacted", async () => {
  const session = await createThread();
  const attached = await client.call("file.attach_bytes", { session_id: session, content_base64: Buffer.from("notes").toString("base64"), filename: "notes.txt", profile: "codex" });
  assert.equal(attached.attached, true);
  const from = daemon.calls.length;
  const start = client.frames.length;
  assert.equal((await client.call("prompt.submit", { session_id: session, text: "/compact this file into three lines", profile: "codex" })).status, "streaming");
  const call = await daemon.waitForCall((call) => (call.method === "turn/start" || call.method === "thread/compact/start") && call.params.threadId === session, from);
  assert.equal(call.method, "turn/start");
  assert.equal(call.params.input[0].text, `/compact this file into three lines\n\nFiles attached in Portals (saved on this Mac):\n- ${attached.path}`);
  daemon.finishTurn(session, await daemon.activeTurn(session), "Done.");
  await completed(session, start);
});

test("a message sent while Codex compacts waits for the compaction to end, then has a turn of its own", async () => {
  const session = await createThread();
  const start = client.frames.length;
  let from = daemon.calls.length;
  assert.deepEqual(await client.call("prompt.submit", { session_id: session, text: "/compact" }), { status: "streaming" });
  await daemon.waitForCall((call) => call.method === "thread/compact/start" && call.params.threadId === session, from);
  const turnId = "compact-turn";
  const item = { type: "contextCompaction", id: "compaction-1" };
  daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  daemon.broadcast("item/started", { threadId: session, turnId, item, startedAtMs: 1 });
  await client.from(start, (frame) => isEvent(frame, "thinking.delta", session));

  // Codex takes no message into a compaction: it waits, rather than being lost.
  from = daemon.calls.length;
  assert.deepEqual(await client.call("prompt.submit", { session_id: session, text: "Then run the tests." }), { status: "queued", queue_id: "1" });
  daemon.broadcast("item/completed", { threadId: session, turnId, item, completedAtMs: 2 });
  daemon.broadcast("turn/completed", { threadId: session, turn: { id: turnId, items: [], itemsView: "summary", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } });
  const next = await daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === session, from);
  assert.deepEqual(next.params.input, [{ type: "text", text: "Then run the tests.", text_elements: [] }]);
  assert.equal(daemon.callsOf("turn/steer").some((call) => call.params.threadId === session), false);
  daemon.finishTurn(session, await daemon.activeTurn(session), "They pass.");
  await until(() => turnEvents(session, start).filter((event) => event.type === "message.complete").length === 2);
  const ends = turnEvents(session, start).filter((event) => event.type === "message.complete");
  assert.deepEqual(ends.map((event) => [event.payload.status, event.payload.text]), [
    ["complete", ""],
    ["complete", "They pass."],
  ]);
});

test("a sub-agent Codex spawns is on the line: its start and end reach the app, and the list keeps it", async () => {
  const session = await createThread();
  const start = client.frames.length;
  daemon.scripts.push("subagent");
  await send(session, "Spawn a sub-agent that says pear.");
  await completed(session, start);
  const news = turnEvents(session, start).filter((event) => event.type.startsWith("subagent."));
  const child = "01a13a21-3e05-7212-b29e-4fb66eb40f01";
  assert.deepEqual(
    news.map((event) => [event.type, event.payload.subagent_id, event.payload.status]),
    [
      ["subagent.start", child, "running"],
      ["subagent.complete", child, "completed"],
    ],
  );
  assert.equal(news[0].payload.goal, "pear reply");
  assert.equal(news[0].payload.model, "gpt-6.1-sol");
  assert.equal(news[0].payload.can_stop, true);
  const listed = (await client.call("subagent.list", { session_id: session, profile: "codex" })).subagents;
  assert.deepEqual(listed.map((subagent: Frame) => [subagent.subagent_id, subagent.status, subagent.can_stop]), [[child, "completed", false]]);
});

test("Stop on a Codex sub-agent interrupts the turn its own thread runs, and the parent's turn goes on", async () => {
  const session = await createThread();
  const start = client.frames.length;
  const turn = await send(session, "Spawn a slow sub-agent.");
  const turnID = await daemon.activeTurn(session);
  const child = daemon.addThread(cwd, [{ id: "child-turn", items: [{ type: "userMessage", id: "u1", content: [{ type: "text", text: "Sleep a while." }] }], status: "inProgress", error: null }], {
    loaded: true,
    status: { type: "active", activeFlags: [] },
    parentThreadId: session,
  });
  daemon.broadcast("item/completed", { threadId: session, turnId: turnID, item: { type: "subAgentActivity", id: "call_1", kind: "started", agentThreadId: child, agentPath: "/root/slow_one", model: "gpt-6-luna" } });
  const started = await client.from(start, (frame) => isEvent(frame, "subagent.start", session));
  assert.equal(started.params.payload.subagent_id, child);
  // Its own thread says what it was asked.
  const asked = await client.from(start, (frame) => isEvent(frame, "subagent.progress", session) && frame.params.payload.goal === "Sleep a while.");
  assert.equal(asked.params.payload.can_stop, true);
  assert.equal((await client.call("sessions.activity")).sessions.some((entry: Frame) => entry.session_id === session), true);

  const from = daemon.calls.length;
  assert.deepEqual(await client.call("subagent.stop", { session_id: session, subagent_id: child, profile: "codex" }), { status: "stopped" });
  const interrupt = await daemon.waitForCall((call) => call.method === "turn/interrupt", from);
  assert.deepEqual(interrupt.params, { threadId: child, turnId: "child-turn" });
  // Only the sub-agent's: the parent's turn is not interrupted.
  assert.equal(daemon.calls.slice(from).some((call) => call.method === "turn/interrupt" && call.params.threadId === session), false);
  daemon.broadcast("item/completed", { threadId: session, turnId: turnID, item: { type: "subAgentActivity", id: "call_2", kind: "interrupted", agentThreadId: child, agentPath: "/root/slow_one" } });
  const stopped = await client.from(start, (frame) => isEvent(frame, "subagent.complete", session));
  assert.equal(stopped.params.payload.status, "stopped");
  assert.equal(turn.params.threadId, session);
  // One that is not this thread's is not stopped.
  assert.deepEqual(await client.call("subagent.stop", { session_id: session, subagent_id: "someone-else", profile: "codex" }), { status: "not_running" });
  daemon.broadcast("turn/completed", { threadId: session, turn: { id: turnID, items: [], status: "completed", error: null } });
  await completed(session, start);
});

test("Stop on a sub-agent whose turn the bridge does not know stops the turn its read finds, also when a change of the sub-agent's status overtakes that read", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Spawn a worker.");
  const turnID = await daemon.activeTurn(session);
  const child = daemon.addThread(cwd, [{ id: "work-1", status: "inProgress", items: [] }], { loaded: true, status: { type: "active", activeFlags: [] }, parentThreadId: session });
  // Known only by its thread's start: running, with no turn the bridge has heard of.
  daemon.broadcast("thread/started", { thread: { id: child, parentThreadId: session } });
  await client.from(start, (frame) => isEvent(frame, "subagent.start", session) && frame.params.payload.subagent_id === child);

  const gates: (() => void)[] = [];
  daemon.onRead = (params) => (params.threadId === child ? new Promise<void>((resolve) => gates.push(resolve)) : undefined);
  try {
    const from = daemon.calls.length;
    const stopping = client.call("subagent.stop", { session_id: session, subagent_id: child, profile: "codex" });
    await until(() => gates.length === 1);
    // It starts waiting on an approval while Stop's read is on its way: a newer read.
    daemon.broadcast("thread/status/changed", { threadId: child, status: { type: "active", activeFlags: ["waitingOnApproval"] } });
    await until(() => gates.length === 2);
    // Stop's read comes back first, overtaken: it still says which turn runs.
    gates[0]!();
    assert.deepEqual(await stopping, { status: "stopped" });
    const interrupt = await daemon.waitForCall((call) => call.method === "turn/interrupt", from);
    assert.deepEqual(interrupt.params, { threadId: child, turnId: "work-1" });
    gates[1]!();
  } finally {
    daemon.onRead = () => {};
  }
  daemon.finishTurn(child, "work-1", "", "interrupted");
  daemon.finishTurn(session, turnID);
  await completed(session, start);
});

test("a sub-agent caught between two states is looked at again: a follow-up whose turn was not listed yet runs, and one that just finished is not taken for stopped", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Spawn a worker.");
  const turnID = await daemon.activeTurn(session);
  const child = daemon.addThread(cwd, [{ id: "w1", status: "inProgress", items: [] }], { loaded: true, status: { type: "active", activeFlags: [] }, parentThreadId: session });
  const activity = { type: "subAgentActivity", agentThreadId: child, agentPath: "/root/worker" };
  daemon.broadcast("item/completed", { threadId: session, turnId: turnID, item: { ...activity, id: "spawn-worker", kind: "started" } });
  await client.from(start, (frame) => isEvent(frame, "subagent.start", session));
  const childEvents = (from: number) => turnEvents(session, from).filter((event) => event.type.startsWith("subagent.") && event.payload.subagent_id === child);

  // Its thread goes idle a moment before its turn's end is written: not stopped, and it
  // completes when the end comes.
  let from = daemon.calls.length;
  let at = client.frames.length;
  daemon.broadcast("thread/status/changed", { threadId: child, status: { type: "idle" } });
  await daemon.waitForCall((call) => call.method === "thread/read" && call.params.threadId === child, from);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await client.call("subagent.list", { session_id: session })).subagents[0].status, "running");
  daemon.finishTurn(child, "w1", "First answer.");
  await client.from(at, (frame) => isEvent(frame, "subagent.complete", session) && frame.params.payload.result === "First answer.");
  // The look after it agrees.
  await daemon.waitForCall((call) => call.method === "thread/read" && call.params.threadId === child, daemon.calls.length);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(childEvents(at).some((event) => event.payload.status === "stopped"), false);
  assert.equal((await client.call("subagent.list", { session_id: session })).subagents[0].status, "completed");

  // Given more to do: its thread is at work before its new turn is listed, and no
  // turn/started reaches the bridge. The next look finds the turn.
  from = daemon.calls.length;
  at = client.frames.length;
  daemon.broadcast("thread/status/changed", { threadId: child, status: { type: "active", activeFlags: [] } });
  await daemon.waitForCall((call) => call.method === "thread/read" && call.params.threadId === child, from);
  await new Promise((resolve) => setTimeout(resolve, 50));
  daemon.thread(child).turns.push({ id: "w2", status: "inProgress", items: [] });
  await client.from(at, (frame) => isEvent(frame, "subagent.progress", session) && frame.params.payload.subagent_id === child && frame.params.payload.status === "running");
  assert.ok(daemon.calls.slice(from).filter((call) => call.method === "thread/read" && call.params.threadId === child).length >= 2);
  const stopFrom = daemon.calls.length;
  assert.deepEqual(await client.call("subagent.stop", { session_id: session, subagent_id: child }), { status: "stopped" });
  assert.deepEqual((await daemon.waitForCall((call) => call.method === "turn/interrupt", stopFrom)).params, { threadId: child, turnId: "w2" });
  daemon.finishTurn(child, "w2", "", "interrupted");
  daemon.finishTurn(session, turnID);
  await completed(session, start);
});

test("a message to a finished sub-agent keeps it done; a real follow-up discovered by a read runs and stops its new turn", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Review the provider.");
  const turnId = await daemon.activeTurn(session);
  const child = daemon.addThread(cwd, [{ id: "review-1", status: "inProgress", items: [] }], {
    loaded: true, status: { type: "active", activeFlags: [] }, parentThreadId: session,
  });
  const activity = { type: "subAgentActivity", agentThreadId: child, agentPath: "/root/reviewer" };
  daemon.broadcast("item/completed", { threadId: session, turnId, item: { ...activity, id: "spawn-reviewer", kind: "started" } });
  await client.from(start, (frame) => isEvent(frame, "subagent.start", session));
  daemon.finishTurn(child, "review-1", "Review finished.");
  await client.from(start, (frame) => isEvent(frame, "subagent.complete", session) && frame.params.payload.result === "Review finished.");

  // As in the live GMI session, send_message emits interacted after completion.
  const messageAt = client.frames.length;
  daemon.broadcast("item/completed", { threadId: session, turnId, item: { ...activity, id: "message-reviewer", kind: "interacted" } });
  await client.from(messageAt, (frame) => isEvent(frame, "subagent.complete", session));
  const [done] = (await client.call("subagent.list", { session_id: session })).subagents;
  assert.deepEqual([done.status, done.result, done.can_stop], ["completed", "Review finished.", false]);
  assert.equal(turnEvents(session, messageAt).some((event) => event.type.startsWith("subagent.") && event.payload.status === "running"), false);

  // A genuine follow-up may have started before its turn/started reached us.
  Object.assign(daemon.thread(child), { status: { type: "active", activeFlags: ["waitingOnApproval"] } });
  daemon.thread(child).turns.push({ id: "review-2", status: "inProgress", items: [] });
  const followupAt = client.frames.length;
  daemon.broadcast("item/completed", { threadId: session, turnId, item: { ...activity, id: "followup-reviewer", kind: "interacted" } });
  await client.from(followupAt, (frame) => isEvent(frame, "subagent.progress", session) && frame.params.payload.status === "running");
  const [running] = (await client.call("subagent.list", { session_id: session })).subagents;
  assert.equal(running.result, undefined);
  const callsAt = daemon.calls.length;
  assert.deepEqual(await client.call("subagent.stop", { session_id: session, subagent_id: child }), { status: "stopped" });
  const interrupt = await daemon.waitForCall((call) => call.method === "turn/interrupt", callsAt);
  assert.deepEqual(interrupt.params, { threadId: child, turnId: "review-2" });
  daemon.finishTurn(session, turnId);
  await completed(session, start);
});

test("child status changes reconcile a missed failure after the parent's turn, and detect a restart waiting for input", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Run a background check.");
  const turnId = await daemon.activeTurn(session);
  const child = daemon.addThread(cwd, [{ id: "check-1", status: "inProgress", items: [] }], {
    loaded: true, status: { type: "active", activeFlags: [] }, parentThreadId: session,
  });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: { type: "subAgentActivity", id: "spawn-check", kind: "started", agentThreadId: child, agentPath: "/root/check" } });
  await client.from(start, (frame) => isEvent(frame, "subagent.start", session));
  daemon.finishTurn(session, turnId);
  await completed(session, start);

  // The turn/completed notification was missed, but Codex announces idle.
  Object.assign(daemon.thread(child).turns[0], { status: "failed", error: { message: "Provider unavailable" } });
  const failedAt = client.frames.length;
  daemon.broadcast("thread/status/changed", { threadId: child, status: { type: "idle" } });
  const failed = await client.from(failedAt, (frame) => isEvent(frame, "subagent.complete", session) && frame.params.payload.status === "failed");
  assert.equal(failed.params.payload.result, "Provider unavailable");
  assert.equal((await client.call("sessions.activity")).sessions.some((entry: Frame) => entry.session_id === session), false);

  daemon.thread(child).turns.push({ id: "check-2", status: "inProgress", items: [] });
  const restartedAt = client.frames.length;
  daemon.broadcast("thread/status/changed", { threadId: child, status: { type: "active", activeFlags: ["waitingOnUserInput"] } });
  await client.from(restartedAt, (frame) => isEvent(frame, "subagent.progress", session) && frame.params.payload.status === "running");
  assert.equal((await client.call("sessions.activity")).sessions.some((entry: Frame) => entry.session_id === session), true);
  daemon.finishTurn(child, "check-2", "Check passed.");
  const done = await client.from(restartedAt, (frame) => isEvent(frame, "subagent.complete", session) && frame.params.payload.result === "Check passed.");
  assert.equal(done.params.payload.status, "completed");
});

test("session.rename names the Codex thread, as a terminal sees it", async () => {
  const session = await createThread();
  const start = client.frames.length;
  const from = daemon.calls.length;
  assert.deepEqual(await client.call("session.rename", { session_id: session, title: "Retry failed pushes" }), {});
  const call = await daemon.waitForCall((entry) => entry.method === "thread/name/set", from);
  assert.deepEqual(call.params, { threadId: session, name: "Retry failed pushes" });
  assert.equal(daemon.thread(session).name, "Retry failed pushes");
  assert.equal((await client.from(start, (frame) => isEvent(frame, "session.title", session))).params.payload.title, "Retry failed pushes");
  assert.equal((await client.call("session.resume", { session_id: session })).info.title, "Retry failed pushes");

  // From a phone that has not opened the thread: its list renames it all the same.
  const other = await TestClient.open(bridge);
  try {
    assert.deepEqual(await other.call("session.rename", { session_id: session, title: "Push retries" }), {});
    assert.equal(daemon.thread(session).name, "Push retries");
    await assert.rejects(other.call("session.rename", { session_id: "no-such-thread", title: "x" }), (error: RpcFailure) => error.code === 4007);
  } finally {
    await other.close();
  }
});

test("sessions.activity: a phone that has not opened a thread sees it running, then waiting on an approval, then done", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Run it.");
  const turnId = await daemon.activeTurn(session);
  const other = await TestClient.open(bridge);
  try {
    const state = async () => ((await other.call("sessions.activity", {})).sessions as { session_id: string; state: string }[]).find((entry) => entry.session_id === session)?.state;
    assert.equal(await state(), "running");
    void daemon.request(session, "item/commandExecution/requestApproval", { threadId: session, turnId, itemId: "c9", command: "make test" });
    const card = await client.nextRequest();
    assert.equal(await state(), "waiting");
    client.answer(card.id, { choice: "deny" });
    await until(() => answersFor(session).length === 1);
    daemon.finishTurn(session, turnId, "Done.");
    await completed(session, start);
    assert.equal(await state(), undefined);
  } finally {
    await other.close();
  }
});

test("interrupting stops Codex's turn, and the turn ends interrupted", async () => {
  const session = await createThread();
  const start = client.frames.length;
  daemon.scripts.push("interrupt");
  await send(session, "Count to 300.");
  await client.from(start, (frame) => isEvent(frame, "message.delta", session));
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  const interrupt = daemon.callsOf("turn/interrupt").at(-1)!;
  assert.deepEqual(interrupt.params, { threadId: session, turnId: rewrite(recordedHistory("interrupt"), []).turns[0].id });
  const done = await completed(session, start);
  assert.equal(done.payload.status, "interrupted");
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "not_interrupted" });
});

test("only the bridge's threads count: another thread's events and requests are left to whoever follows it", async () => {
  const session = await createThread();
  const foreign = daemon.addThread("/elsewhere", [], { loaded: true });
  const bridgeConnection = daemon.callsOf("initialize").at(-1)!.connection;
  const before = client.frames.length;
  daemon.broadcast("thread/status/changed", { threadId: foreign, status: { type: "active", activeFlags: ["waitingOnApproval"] } });
  daemon.broadcast("turn/started", { threadId: foreign, turn: { id: "foreign-turn", items: [], status: "inProgress" } });
  daemon.broadcast("item/agentMessage/delta", { threadId: foreign, turnId: "foreign-turn", itemId: "m", delta: "not for you" });
  // A question about a thread the bridge does not follow is not answered by it.
  bridgeConnection.send({ id: "terminal-7", method: "item/commandExecution/requestApproval", params: { threadId: foreign, turnId: "foreign-turn", itemId: "c", command: "ls" } });
  // Requests about the account get an error.
  bridgeConnection.send({ id: "account-refresh", method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized" } });
  await until(() => bridgeConnection.received.some((message) => message.id === "account-refresh"));
  assert.deepEqual(
    bridgeConnection.received.find((message) => message.id === "account-refresh"),
    { id: "account-refresh", error: { code: -32601, message: "Portals does not handle account/chatgptAuthTokens/refresh." } },
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(bridgeConnection.received.some((message) => message.id === "terminal-7"), false);
  assert.equal(client.frames.slice(before).length, 0);
  assert.equal(client.events(session).length, 0);
});

test("/mcp in a thread Codex has not loaded, whose folder is gone, says so and does not list the servers as set up elsewhere", async (t) => {
  // A bridge of its own, whose General folder the thread runs in and is then removed. After
  // the test above, which takes the last connection to Codex for the shared bridge's.
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "portals-codex-mcp-gone-")));
  const own = await startTestBridge({ providers: new Map([["codex", codexProvider()]]), config: { generalFolder: folder } });
  const phone = await TestClient.open(own);
  t.after(async () => {
    await phone.close();
    await own.dispose();
    rmSync(folder, { recursive: true, force: true });
  });
  const session = (await phone.call("session.create", { profile: "codex", source: "tui", cwd: folder })).session_id as string;
  daemon.mcpServers = [{ name: "elsewhere", runtimeStatus: null, authStatus: "unsupported", tools: {}, toolsError: null }];
  daemon.thread(session).loaded = false;
  rmSync(folder, { recursive: true, force: true });
  try {
    const from = daemon.calls.length;
    await assert.rejects(
      phone.call("slash.exec", { session_id: session, command: "mcp", profile: "codex" }),
      (error: RpcFailure) => error.message === `The thread's folder, ${folder}, is no longer there, so Codex cannot show its MCP servers.`,
    );
    assert.equal(daemon.calls.slice(from).filter((call) => call.method === "mcpServerStatus/list" && call.params.threadId === undefined).length, 0);
  } finally {
    daemon.mcpServers = [];
  }
});

test("a sub-agent's questions are its thread's cards, and the answers go back to the sub-agent; a terminal's answer closes the card", async () => {
  const session = await createThread({ title: "Spawner" });
  const start = client.frames.length;
  await send(session, "Have a sub-agent run it.");
  const turnId = await daemon.activeTurn(session);
  const spawned = (parent: string) => ({ loaded: true, parentThreadId: parent, source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: null, agent_nickname: null, agent_role: null } } } });
  const child = daemon.addThread(cwd, [], spawned(session));
  const spawn = { type: "subAgentActivity", id: "spawn-1", kind: "started", agentThreadId: child, agentPath: "/root/worker" };
  daemon.broadcast("item/started", { threadId: session, turnId, item: spawn, startedAtMs: 1 });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: spawn, completedAtMs: 1 });
  const command = daemon.request(child, "item/commandExecution/requestApproval", { threadId: child, turnId: "child-turn", itemId: "c-sub", command: "/bin/zsh -lc 'touch from-subagent.txt'" });
  const card = await client.nextRequest();
  assert.equal(card.params.command, "touch from-subagent.txt");
  client.answer(card.id, { choice: "once" });
  assert.deepEqual((await command).result, { decision: "accept" });

  // A sub-agent whose start the bridge did not see (it restarted since) is found by asking Codex whose it is.
  const working = { id: "unseen-turn", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
  const unseen = daemon.addThread(cwd, [working], { ...spawned(session), status: { type: "active", activeFlags: [] } });
  const change = { type: "fileChange", id: "change-sub", changes: [{ path: join(cwd, "sub.txt"), kind: { type: "add" }, diff: "sub\n" }], status: "inProgress" };
  daemon.broadcast("item/started", { threadId: unseen, turnId: "unseen-turn", item: change, startedAtMs: 1 });
  const edit = daemon.request(unseen, "item/fileChange/requestApproval", { threadId: unseen, turnId: "unseen-turn", itemId: "change-sub", reason: null, grantRoot: null });
  const editCard = await client.nextRequest();
  // With the change the sub-agent is making, from its own item.
  assert.equal(editCard.params.command, `Edit ${cwd}/sub.txt\n--- /dev/null\n+++ b/sub.txt\n@@ -0,0 +1 @@\n+sub\n`);
  client.answer(editCard.id, { choice: "deny" });
  assert.deepEqual((await edit).result, { decision: "decline" });

  // Answered at a terminal first, the card closes.
  const third = daemon.request(child, "item/commandExecution/requestApproval", { threadId: child, turnId: "child-turn", itemId: "c-sub-2", command: "make" });
  const thirdCard = await client.nextRequest();
  daemon.answerFromTerminal(daemon.openRequests().find((request) => request.threadId === child)!.id, { decision: "accept" });
  assert.equal((await third).from, "terminal");
  await until(() => turnEvents(session, start).some((event) => event.type === "request.cancel" && event.payload.id === thirdCard.id));
  daemon.finishTurn(session, turnId);
  await completed(session, start);
  // Only the one answer each: the bridge's, and the terminal's.
  assert.deepEqual(answersFor(child), [{ decision: "accept" }, { decision: "accept" }]);
  assert.deepEqual(answersFor(unseen), [{ decision: "decline" }]);
});

test("a sub-agent's question outlives the turn of the thread it works for on an app that keeps such cards, and its answer still reaches the sub-agent", async () => {
  const phone = await TestClient.open(bridge);
  try {
    await phone.call("client.capabilities", { server_requests: true, subagent_requests: true });
    const session = await createThread({ title: "Spawner" }, phone);
    const start = phone.frames.length;
    await send(session, "Have a sub-agent run it in the background.", phone);
    const turnId = await daemon.activeTurn(session);
    const child = daemon.addThread(cwd, [], { loaded: true, parentThreadId: session });
    const spawn = { type: "subAgentActivity", id: "spawn-background", kind: "started", agentThreadId: child, agentPath: "/root/background" };
    daemon.broadcast("item/started", { threadId: session, turnId, item: spawn, startedAtMs: 1 });
    daemon.broadcast("item/completed", { threadId: session, turnId, item: spawn, completedAtMs: 1 });
    await phone.from(start, (frame) => isEvent(frame, "subagent.start", session));
    const command = daemon.request(child, "item/commandExecution/requestApproval", { threadId: child, turnId: "child-turn", itemId: "c-background", command: "make" });
    const card = await phone.next((frame) => frame.method === "approval" && frame.params.session_id === session);
    // The app is told whose it is, to keep the card once the turn is over.
    assert.equal(card.params.subagent, child);
    // The thread's turn ends while its sub-agent works on and waits for the answer.
    daemon.finishTurn(session, turnId);
    await completed(session, start, phone);
    const open = (await phone.call("session.resume", { session_id: session, profile: "codex", inline_images: false })).open_requests;
    assert.deepEqual(open.map((request: Frame) => request.id), [card.id]);
    phone.answer(card.id, { choice: "once" });
    assert.deepEqual((await command).result, { decision: "accept" });
  } finally {
    await phone.close();
  }
});

test("a sub-agent's questions taken back as the thread it works for ends its turn, on an app that cannot keep such cards, are answered no, so the sub-agent works on", async () => {
  // Before, nothing was sent back, and the sub-agent waited for an answer from a terminal.
  const phone = await TestClient.open(bridge);
  try {
    await phone.call("client.capabilities", { server_requests: true });
    const session = await createThread({ title: "Spawner" }, phone);
    const start = phone.frames.length;
    await send(session, "Have a sub-agent run it in the background.", phone);
    const turnId = await daemon.activeTurn(session);
    const child = daemon.addThread(cwd, [], { loaded: true, parentThreadId: session });
    const spawn = { type: "subAgentActivity", id: "spawn-unkept", kind: "started", agentThreadId: child, agentPath: "/root/unkept" };
    daemon.broadcast("item/started", { threadId: session, turnId, item: spawn, startedAtMs: 1 });
    daemon.broadcast("item/completed", { threadId: session, turnId, item: spawn, completedAtMs: 1 });
    await phone.from(start, (frame) => isEvent(frame, "subagent.start", session));
    const command = daemon.request(child, "item/commandExecution/requestApproval", { threadId: child, turnId: "child-turn", itemId: "c-unkept", command: "make" });
    await phone.next((frame) => frame.method === "approval" && frame.params.session_id === session);
    const question = daemon.request(child, "item/tool/requestUserInput", { threadId: child, turnId: "child-turn", itemId: "q-unkept", questions: [{ id: "which", header: "Which", question: "Which one?", isOther: false, isSecret: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] });
    await phone.next((frame) => frame.method === "clarify" && frame.params.session_id === session);
    daemon.finishTurn(session, turnId);
    await completed(session, start, phone);
    const answered = (reply: Promise<{ result?: unknown }>) => Promise.race([reply.then((value) => value.result), new Promise((resolve) => setTimeout(() => resolve("no answer"), 3000))]);
    assert.deepEqual(await answered(command), { decision: "decline" });
    assert.deepEqual(await answered(question), { answers: {} });
    assert.deepEqual((await phone.call("session.resume", { session_id: session, profile: "codex", inline_images: false })).open_requests, []);
  } finally {
    await phone.close();
  }
});

test("a question of a sub-agent's own sub-agent, or of one whose start the bridge missed, also outlives the turn of the thread it works for", async () => {
  const phone = await TestClient.open(bridge);
  try {
    await phone.call("client.capabilities", { server_requests: true, subagent_requests: true });
    for (const nested of [true, false]) {
      const session = await createThread({ title: "Spawner" }, phone);
      const start = phone.frames.length;
      await send(session, "Have sub-agents run it in the background.", phone);
      const turnId = await daemon.activeTurn(session);
      const child = daemon.addThread(cwd, [], { loaded: true, parentThreadId: session });
      let asking = child;
      if (nested) {
        // The thread spawns a worker, which spawns the one that asks: not on the thread's line.
        const spawn = { type: "subAgentActivity", id: "spawn-worker", kind: "started", agentThreadId: child, agentPath: "/root/worker" };
        daemon.broadcast("item/started", { threadId: session, turnId, item: spawn, startedAtMs: 1 });
        daemon.broadcast("item/completed", { threadId: session, turnId, item: spawn, completedAtMs: 1 });
        asking = daemon.addThread(cwd, [], { loaded: true, parentThreadId: child });
        const inner = { type: "subAgentActivity", id: "spawn-inner", kind: "started", agentThreadId: asking, agentPath: "/root/worker/inner" };
        daemon.broadcast("item/started", { threadId: child, turnId: "worker-turn", item: inner, startedAtMs: 1 });
        daemon.broadcast("item/completed", { threadId: child, turnId: "worker-turn", item: inner, completedAtMs: 1 });
      }
      // Without `nested`, nothing said the sub-agent started: Codex is asked whose it is.
      const command = daemon.request(asking, "item/commandExecution/requestApproval", { threadId: asking, turnId: "asking-turn", itemId: `c-${asking}`, command: "make" });
      const card = await phone.next((frame) => frame.method === "approval" && frame.params.session_id === session);
      assert.equal(card.params.subagent, asking);
      daemon.finishTurn(session, turnId);
      await completed(session, start, phone);
      const open = (await phone.call("session.resume", { session_id: session, profile: "codex", inline_images: false })).open_requests;
      assert.deepEqual(open.map((request: Frame) => request.id), [card.id]);
      phone.answer(card.id, { choice: "once" });
      assert.deepEqual((await command).result, { decision: "accept" });
    }
  } finally {
    await phone.close();
  }
});

test("a sub-agent is shown with the nickname and role Codex gave it, and a sub-agent's own sub-agent is on the line of the thread too", async () => {
  const session = await createThread({ title: "Spawner" });
  const start = client.frames.length;
  await send(session, "Have a worker spawn a helper.");
  const turnId = await daemon.activeTurn(session);
  const spawned = (id: string, parent: string, path: string, nickname: string, role: string) => ({
    thread: {
      id,
      parentThreadId: parent,
      agentNickname: nickname,
      agentRole: role,
      source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: path, agent_nickname: nickname, agent_role: role } } },
      status: { type: "active", activeFlags: [] },
      turns: [],
    },
  });
  const worker = daemon.addThread(cwd, [], { loaded: true, parentThreadId: session });
  daemon.broadcast("thread/started", spawned(worker, session, "/root/pear_reply", "Darwin", "worker"));
  const spawn = { type: "subAgentActivity", id: "spawn-darwin", kind: "started", agentThreadId: worker, agentPath: "/root/pear_reply" };
  daemon.broadcast("item/started", { threadId: session, turnId, item: spawn, startedAtMs: 1 });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: spawn, completedAtMs: 1 });
  // The worker spawns a helper of its own.
  const helper = daemon.addThread(cwd, [], { loaded: true, parentThreadId: worker });
  daemon.broadcast("thread/started", spawned(helper, worker, "/root/pear_reply/fig_check", "Hopper", "explorer"));
  await until(() => turnEvents(session, start).filter((event) => event.type === "subagent.start").length === 2);
  const started = turnEvents(session, start).filter((event) => event.type === "subagent.start").map((event) => event.payload);
  assert.deepEqual(
    started.map((payload) => [payload.subagent_id, payload.nickname, payload.role, payload.goal, payload.parent_id ?? null]),
    [
      [worker, "Darwin", "worker", "pear reply", null],
      // Whose it is.
      [helper, "Hopper", "explorer", "fig check", worker],
    ],
  );
  // One known only from the worker's own items, as Codex 0.162.1 tells of a sub-agent's sub-agents (seen live).
  const quiet = daemon.addThread(cwd, [], { loaded: true, parentThreadId: worker });
  const spawnQuiet = { type: "subAgentActivity", id: "spawn-quiet", kind: "started", agentThreadId: quiet, agentPath: "/root/pear_reply/plum_check" };
  daemon.broadcast("item/started", { threadId: worker, turnId: "worker-turn", item: spawnQuiet, startedAtMs: 1 });
  daemon.broadcast("item/completed", { threadId: worker, turnId: "worker-turn", item: spawnQuiet, completedAtMs: 1 });
  await until(() => turnEvents(session, start).some((event) => event.type === "subagent.start" && event.payload.subagent_id === quiet));
  const quietStart = turnEvents(session, start).find((event) => event.type === "subagent.start" && event.payload.subagent_id === quiet)!.payload;
  assert.deepEqual([quietStart.goal, quietStart.parent_id, quietStart.status], ["plum check", worker, "running"]);
  const quietDone = { type: "subAgentActivity", id: "quiet-done", kind: "completed", agentThreadId: quiet, agentPath: "/root/pear_reply/plum_check" };
  daemon.broadcast("item/completed", { threadId: worker, turnId: "worker-turn", item: quietDone, completedAtMs: 2 });
  await until(() => turnEvents(session, start).some((event) => event.type === "subagent.complete" && event.payload.subagent_id === quiet));
  // The helper's own news reaches the line, and it can be stopped by itself.
  daemon.broadcast("turn/started", { threadId: helper, turn: { id: "helper-turn", status: "inProgress", items: [] } });
  daemon.broadcast("turn/completed", { threadId: helper, turn: { id: "helper-turn", status: "completed", items: [] } });
  await until(() => turnEvents(session, start).some((event) => event.type === "subagent.complete" && event.payload.subagent_id === helper));
  const listed = (await client.call("subagent.list", { session_id: session, profile: "codex" })).subagents;
  assert.deepEqual(
    listed.map((entry: Frame) => [entry.subagent_id, entry.nickname ?? null, entry.status]),
    [
      [worker, "Darwin", "running"],
      [helper, "Hopper", "completed"],
      [quiet, null, "completed"],
    ],
  );
  daemon.finishTurn(session, turnId);
  await completed(session, start);
});

test("a Codex wait's row names the sub-agents it waited for by nickname, as it starts and as it ends; the next wait only the one still at work; the thread read back keeps the names (subagent_calls)", async () => {
  const session = await createThread({ title: "Waiter" });
  const start = client.frames.length;
  await send(session, "Have two workers look around, and wait for them.");
  const turnId = await daemon.activeTurn(session);
  const spawned = (id: string, path: string, nickname: string) => ({
    thread: { id, parentThreadId: session, agentNickname: nickname, agentRole: "worker", source: { subAgent: { thread_spawn: { parent_thread_id: session, depth: 1, agent_path: path, agent_nickname: nickname, agent_role: "worker" } } }, status: { type: "active", activeFlags: [] }, turns: [] },
  });
  const item = (method: string, payload: Record<string, unknown>) => daemon.broadcast(method, { threadId: session, turnId, item: payload, startedAtMs: 1, completedAtMs: 1 });
  const workers: string[] = [];
  for (const [path, nickname] of [["/root/count_files", "Darwin"], ["/root/read_readme", "Euclid"]]) {
    const worker = daemon.addThread(cwd, [], { loaded: true, parentThreadId: session });
    workers.push(worker);
    daemon.broadcast("thread/started", spawned(worker, path, nickname));
    const activity = { type: "subAgentActivity", id: `spawn-${nickname}`, kind: "started", agentThreadId: worker, agentPath: path };
    item("item/started", activity);
    item("item/completed", activity);
  }
  await until(() => turnEvents(session, start).filter((event) => event.type === "subagent.start" && event.payload.nickname).length === 2);
  const wait = (id: string, status: string) => ({ type: "collabAgentToolCall", id, tool: "wait", status, senderThreadId: session, receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {} });
  item("item/started", wait("wait-1", "inProgress"));
  const waiting = await client.from(start, (frame) => isEvent(frame, "tool.start", session) && frame.params.payload.tool_id === "wait-1");
  assert.deepEqual([waiting.params.payload.name, waiting.params.payload.context, waiting.params.payload.args], ["delegate_task", "wait", { agents: ["Darwin", "Euclid"] }]);
  // Darwin answers; the wait comes back.
  item("item/completed", { type: "subAgentActivity", id: "done-Darwin", kind: "completed", agentThreadId: workers[0], agentPath: "/root/count_files" });
  item("item/completed", wait("wait-1", "completed"));
  const waited = await client.from(start, (frame) => isEvent(frame, "tool.complete", session) && frame.params.payload.tool_id === "wait-1");
  assert.deepEqual(waited.params.payload.args, { agents: ["Darwin", "Euclid"] });
  // Waited for again: only Euclid is still out.
  item("item/started", wait("wait-2", "inProgress"));
  item("item/completed", { type: "subAgentActivity", id: "done-Euclid", kind: "completed", agentThreadId: workers[1], agentPath: "/root/read_readme" });
  item("item/completed", wait("wait-2", "completed"));
  const second = await client.from(start, (frame) => isEvent(frame, "tool.complete", session) && frame.params.payload.tool_id === "wait-2");
  assert.deepEqual(second.params.payload.args, { agents: ["Euclid"] });
  daemon.finishTurn(session, turnId, "Both looked.");
  await completed(session, start);
  // The thread as stored keeps what the rows said.
  const stored = (await client.call("session.resume", { session_id: session })).messages.filter((message: Frame) => message.role === "tool");
  assert.deepEqual(stored.map((message: Frame) => [message.context, message.args]), [
    ["wait", { agents: ["Darwin", "Euclid"] }],
    ["wait", { agents: ["Euclid"] }],
  ]);
});

test("read back after a restart, a Codex wait names its sub-agents by the nicknames their own threads keep, each thread read once; one that cannot be read by its path (subagent_calls)", async () => {
  const activity = (id: string, kind: string, path: string) => ({ type: "subAgentActivity", id: `${kind}-${id}`, kind, agentThreadId: id, agentPath: path });
  const wait = (id: string) => ({ type: "collabAgentToolCall", id, tool: "wait", status: "completed", receiverThreadIds: [], agentsStates: {} });
  const threads: Record<string, unknown> = {
    parent: {
      status: { type: "notLoaded" },
      turns: [{ id: "p1", status: "completed", startedAt: 10, completedAt: 20, items: [activity("d", "started", "/root/pear"), activity("e", "started", "/root/fig"), activity("d", "completed", "/root/pear"), wait("w1"), activity("e", "completed", "/root/fig"), wait("w2")] }],
    },
    d: { id: "d", agentNickname: "Gauss", status: { type: "notLoaded" }, turns: [] },
  };
  const reads: { threadId: string; includeTurns?: boolean }[] = [];
  const host = {
    client: {
      call: async (_method: string, params: { threadId: string; includeTurns?: boolean }) => {
        reads.push(params);
        if (!threads[params.threadId]) throw new Error("no such thread");
        return { thread: threads[params.threadId] };
      },
    },
    defaults: () => null,
    efforts: () => [],
    imagesDir: cwd,
    interruptGraceMs: 100,
    forget() {},
  };
  const provider = new CodexSession({ id: "parent", cwd, settings: { model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low" } } as never, { emit() {} } as never, host as never, { applied: null, subscribed: false });
  await provider.load();
  const rows = (await provider.history()).filter((message) => message.role === "tool");
  assert.deepEqual(rows.map((message) => message.role === "tool" && message.args), [{ agents: ["Gauss", "fig"] }, { agents: ["fig"] }]);
  assert.deepEqual(reads.filter((read) => read.threadId !== "parent").map((read) => [read.threadId, read.includeTurns]), [["d", false], ["e", false]]);
  // Read again (a thread only read is, before each snapshot), the names are not asked for again.
  await provider.reload();
  assert.equal(reads.filter((read) => read.threadId !== "parent").length, 2);
});

test("a turn that spawned sub-agents and waited for them while the connection to Codex was down shows, once it is back, its waits naming them by nickname, and the line has them (subagent_calls)", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  const spawned = (nickname: string) => daemon.addThread(cwd, [], { parentThreadId: session, source: { subAgent: { thread_spawn: { parent_thread_id: session, depth: 1, agent_path: `/root/${nickname.toLowerCase()}`, agent_nickname: nickname, agent_role: "worker" } } } });
  const darwin = spawned("Darwin");
  const euclid = spawned("Euclid");
  const turnId = "desk-waits-while-down";
  const item = (payload: Record<string, unknown>) => daemon.broadcast("item/completed", { threadId: session, turnId, item: payload, completedAtMs: 1 });
  const activity = (id: string, kind: string, nickname: string) => ({ type: "subAgentActivity", id: `${kind}-${nickname}`, kind, agentThreadId: id, agentPath: `/root/${nickname.toLowerCase()}` });
  const wait = (id: string) => ({ type: "collabAgentToolCall", id, tool: "wait", status: "completed", senderThreadId: session, receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {} });
  daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  item({ type: "userMessage", id: "u-waits", clientId: null, content: [{ type: "text", text: "Have two workers look around.", text_elements: [] }] });
  item(activity(darwin, "started", "Darwin"));
  item(activity(euclid, "started", "Euclid"));
  item(activity(darwin, "completed", "Darwin"));
  item(wait("missed-wait-1"));
  item(activity(euclid, "completed", "Euclid"));
  item(wait("missed-wait-2"));
  daemon.finishTurn(session, turnId, "Both looked.");
  daemon.accepting = true;
  await until(() => daemon.callsOf("thread/resume").length > resumes);
  await completed(session, start);
  const rows = turnEvents(session, start).filter((event) => event.type === "tool.complete");
  assert.deepEqual(rows.map((event) => [event.payload.tool_id, event.payload.args]), [
    ["missed-wait-1", { agents: ["Darwin", "Euclid"] }],
    ["missed-wait-2", { agents: ["Euclid"] }],
  ]);
  // The line has them too, though their starts were missed.
  await until(() => turnEvents(session, start).filter((event) => event.type === "subagent.complete").length >= 2);
  const listed = (await client.call("subagent.list", { session_id: session, profile: "codex" })).subagents;
  assert.deepEqual(listed.map((entry: Frame) => [entry.subagent_id, entry.status]).sort(), [[darwin, "completed"], [euclid, "completed"]].sort());
});

test("a turn already running when the connection to Codex dropped names its waits as live once it is back: by nickname, one spawned meanwhile too, and by the thread's own order though the sub-agents' threads, read first, say both have ended (subagent_calls)", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Have workers look around.");
  const turnId = await daemon.activeTurn(session);
  const item = (method: string, payload: Record<string, unknown>) => daemon.broadcast(method, { threadId: session, turnId, item: payload, startedAtMs: 1, completedAtMs: 1 });
  const activity = (id: string, kind: string, nickname: string) => ({ type: "subAgentActivity", id: `${kind}-${nickname}`, kind, agentThreadId: id, agentPath: `/root/${nickname.toLowerCase()}` });
  const wait = (id: string) => ({ type: "collabAgentToolCall", id, tool: "wait", status: "completed", senderThreadId: session, receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {} });
  const worker = (nickname: string, loaded: boolean) =>
    daemon.addThread(cwd, [{ id: `${nickname}-turn`, status: "inProgress", items: [], error: null, startedAt: 1, completedAt: null }], {
      loaded,
      status: loaded ? { type: "active", activeFlags: [] } : { type: "notLoaded" },
      parentThreadId: session,
      source: { subAgent: { thread_spawn: { parent_thread_id: session, depth: 1, agent_path: `/root/${nickname.toLowerCase()}`, agent_nickname: nickname, agent_role: "worker" } } },
    });
  // Darwin and Euclid start while the bridge listens.
  const darwin = worker("Darwin", true);
  const euclid = worker("Euclid", true);
  for (const [id, nickname] of [[darwin, "Darwin"], [euclid, "Euclid"]]) {
    daemon.broadcast("thread/started", { thread: { id, parentThreadId: session, agentNickname: nickname, agentRole: "worker", status: { type: "active", activeFlags: [] }, turns: [] } });
    item("item/completed", activity(id, "started", nickname));
  }
  await until(() => turnEvents(session, start).filter((event) => event.type === "subagent.start" && event.payload.nickname).length === 2);
  const resumes = daemon.callsOf("thread/resume").length;
  daemon.accepting = false;
  daemon.dropAll();
  // Meanwhile both finish, their own threads say so, and the thread waits for them, then
  // for a third, Hume, spawned while nobody listened.
  for (const id of [darwin, euclid]) {
    const thread = daemon.thread(id);
    thread.status = { type: "idle" };
    thread.turns = [{ id: `${id}-done`, status: "completed", items: [{ type: "agentMessage", id: `said-${id}`, text: "Looked." }], error: null, startedAt: 1, completedAt: 2 }];
  }
  const hume = worker("Hume", false);
  item("item/completed", activity(darwin, "completed", "Darwin"));
  item("item/completed", wait("gap-wait-1"));
  item("item/completed", activity(euclid, "completed", "Euclid"));
  item("item/completed", wait("gap-wait-2"));
  item("item/completed", activity(hume, "started", "Hume"));
  item("item/completed", activity(hume, "completed", "Hume"));
  item("item/completed", wait("gap-wait-3"));
  daemon.finishTurn(session, turnId, "All three looked.");
  // The bridge reads the sub-agents' threads before the thread itself.
  const childReads = () => daemon.callsOf("thread/read").filter((call) => call.params.threadId === darwin || call.params.threadId === euclid).length;
  daemon.onRead = async (params) => {
    if ((params as { threadId?: string }).threadId !== session) return;
    await until(() => childReads() >= 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  try {
    daemon.accepting = true;
    await until(() => daemon.callsOf("thread/resume").length > resumes);
    await completed(session, start);
  } finally {
    daemon.onRead = () => {};
  }
  const rows = turnEvents(session, start).filter((event) => event.type === "tool.complete");
  assert.deepEqual(rows.map((event) => [event.payload.tool_id, event.payload.args]), [
    ["gap-wait-1", { agents: ["Darwin", "Euclid"] }],
    ["gap-wait-2", { agents: ["Euclid"] }],
    ["gap-wait-3", { agents: ["Hume"] }],
  ]);
});

test("what is said with a no to a sub-agent's question is steered into the sub-agent's turn after the no, not into the thread it works for", async () => {
  const phone = await TestClient.open(bridge);
  try {
    await phone.call("client.capabilities", { server_requests: true, subagent_requests: true });
    for (const threadDone of [false, true]) {
      const session = await createThread({ title: "Spawner" }, phone);
      const start = phone.frames.length;
      await send(session, "Have a sub-agent clean up.", phone);
      const turnId = await daemon.activeTurn(session);
      const working = { id: `cleaner-turn-${threadDone}`, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
      const child = daemon.addThread(cwd, [working], { loaded: true, parentThreadId: session, status: { type: "active", activeFlags: [] } });
      const spawn = { type: "subAgentActivity", id: `spawn-cleaner-${threadDone}`, kind: "started", agentThreadId: child, agentPath: "/root/cleaner" };
      daemon.broadcast("item/started", { threadId: session, turnId, item: spawn, startedAtMs: 1 });
      daemon.broadcast("item/completed", { threadId: session, turnId, item: spawn, completedAtMs: 1 });
      const command = daemon.request(child, "item/commandExecution/requestApproval", { threadId: child, turnId: working.id, itemId: `rm-${threadDone}`, command: "rm -rf output" });
      const card = await phone.next((frame) => frame.method === "approval" && frame.params.session_id === session);
      assert.equal(card.params.subagent, child);
      if (threadDone) {
        // The thread's turn is over and its sub-agent's card stayed: a note must not start a turn of the thread.
        daemon.finishTurn(session, turnId);
        await completed(session, start, phone);
      }
      const from = daemon.calls.length;
      phone.answer(card.id, { choice: "deny", note: "Use a temporary output folder instead." });
      assert.deepEqual((await command).result, { decision: "decline" });
      const steer = await daemon.waitForCall((call) => call.method === "turn/steer" && call.params.threadId === child, from);
      assert.equal(steer.params.expectedTurnId, working.id);
      assert.deepEqual(steer.params.input, [{ type: "text", text: "Use a temporary output folder instead.", text_elements: [] }]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(daemon.calls.slice(from).some((call) => (call.method === "turn/steer" || call.method === "turn/start") && call.params.threadId === session), false);
      daemon.finishTurn(child, working.id);
      if (!threadDone) {
        daemon.finishTurn(session, turnId);
        await completed(session, start, phone);
      }
    }
  } finally {
    await phone.close();
  }
});

test("a sub-agent's question answered at a terminal while Codex is asked whose thread it is never becomes a card", async () => {
  const session = await createThread({ title: "Spawner" });
  const start = client.frames.length;
  await send(session, "Have a sub-agent run it.");
  const turnId = await daemon.activeTurn(session);
  // Spawned while the bridge was not listening: its thread is asked about, and the terminal is quicker than the answer.
  const unseen = daemon.addThread(cwd, [], { loaded: true, parentThreadId: session, source: { subAgent: { thread_spawn: { parent_thread_id: session, depth: 1, agent_path: null, agent_nickname: null, agent_role: null } } } });
  daemon.onRead = (params) => {
    if (params.threadId !== unseen) return;
    daemon.onRead = () => {};
    daemon.answerFromTerminal(daemon.openRequests().find((request) => request.threadId === unseen)!.id, { decision: "accept" });
  };
  const answered = daemon.request(unseen, "item/commandExecution/requestApproval", { threadId: unseen, turnId: "sub-turn", itemId: "c-quick", command: "touch quick.txt" });
  assert.equal((await answered).from, "terminal");
  // The next one is a card: the only one.
  const asked = daemon.request(unseen, "item/commandExecution/requestApproval", { threadId: unseen, turnId: "sub-turn", itemId: "c-later", command: "make" });
  const card = await client.nextRequest();
  assert.equal(card.params.command, "make");
  client.answer(card.id, { choice: "deny" });
  assert.deepEqual((await asked).result, { decision: "decline" });
  assert.deepEqual(answersFor(unseen), [{ decision: "accept" }, { decision: "decline" }]);
  daemon.finishTurn(session, turnId);
  await completed(session, start);
});

test("the sub-agents' parents the provider keeps are capped, and a question of one let go of still reaches its thread, Codex asked whose it is", async () => {
  const provider = new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images },
    connect: socketConnector(daemon.socketPath),
    checkVersion: false,
    configPath: join(daemon.folder, "config.toml"),
    timeZone: "UTC",
    backoff: [0.05, 0.1],
    parentsKept: 2,
  });
  const capped = await startTestBridge({ providers: new Map([["codex", provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(capped);
  try {
    const session = await createThread({ title: "Spawner" }, phone);
    const start = phone.frames.length;
    await send(session, "Have three sub-agents run it.", phone);
    const turnId = await daemon.activeTurn(session);
    const children = [1, 2, 3].map(() => daemon.addThread(cwd, [], { loaded: true, parentThreadId: session }));
    for (const [index, child] of children.entries()) {
      const spawn = { type: "subAgentActivity", id: `spawn-${index}`, kind: "started", agentThreadId: child, agentPath: `/root/worker${index}` };
      daemon.broadcast("item/started", { threadId: session, turnId, item: spawn, startedAtMs: 1 });
      daemon.broadcast("item/completed", { threadId: session, turnId, item: spawn, completedAtMs: 1 });
    }
    const parents = (provider as unknown as { parents: Map<string, string | null> }).parents;
    await until(() => parents.has(children[2]));
    assert.deepEqual([...parents.keys()], children.slice(1));
    // The first one's question: Codex is asked whose thread it is, and the card is the thread's.
    const reads = daemon.callsOf("thread/read").length;
    const command = daemon.request(children[0], "item/commandExecution/requestApproval", { threadId: children[0], turnId: "child-turn", itemId: "c-first", command: "make" });
    const card = await phone.next((frame) => frame.method === "approval" && frame.params.session_id === session);
    assert.ok(daemon.callsOf("thread/read").slice(reads).some((call) => call.params.threadId === children[0]));
    phone.answer(card.id, { choice: "once" });
    assert.deepEqual((await command).result, { decision: "accept" });
    assert.ok(parents.size <= 2);
    daemon.finishTurn(session, turnId);
    await completed(session, start, phone);
  } finally {
    await phone.close();
    await capped.dispose();
  }
});

test("two phones on one thread: both get the approval, the first answer wins, the other's card closes", async () => {
  const session = await createThread();
  const other = await TestClient.open(bridge);
  try {
    await other.call("session.resume", { session_id: session });
    const start = client.frames.length;
    const otherStart = other.frames.length;
    await send(session, "Change it.");
    const turnId = await daemon.activeTurn(session);
    const item = { type: "fileChange", id: "change-1", changes: [{ path: join(cwd, "hello.txt"), kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-hi\n+hey\n" }], status: "inProgress" };
    daemon.broadcast("item/started", { threadId: session, turnId, item, startedAtMs: 1 });
    void daemon.request(session, "item/fileChange/requestApproval", { threadId: session, turnId, itemId: "change-1", startedAtMs: 1, reason: null, grantRoot: null });
    const mine = await client.nextRequest();
    const theirs = await other.nextRequest();
    assert.equal(mine.id, theirs.id);
    assert.equal(mine.params.command, `Edit ${cwd}/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hey\n`);
    other.answer(theirs.id, { choice: "once" });
    const cancel = await client.from(start, (frame) => isEvent(frame, "request.cancel", session));
    assert.deepEqual(cancel.params.payload, { id: mine.id, reason: "resolved" });
    // The late answer is ignored.
    client.answer(mine.id, { choice: "deny" });
    await until(() => answersFor(session).length === 1);
    assert.deepEqual(answersFor(session), [{ decision: "accept" }]);
    daemon.broadcast("item/completed", { threadId: session, turnId, item: { ...item, status: "completed" }, completedAtMs: 2 });
    daemon.finishTurn(session, turnId);
    await completed(session, start);
    await completed(session, otherStart, other);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(answersFor(session), [{ decision: "accept" }]);
  } finally {
    await other.close();
  }
});

test("an approval answered at a terminal closes the phone's card, and the bridge does not answer it too", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Run it.");
  const turnId = await daemon.activeTurn(session);
  void daemon.request(session, "item/commandExecution/requestApproval", { threadId: session, turnId, itemId: "c1", command: "/bin/zsh -lc 'make'", availableDecisions: ["accept", "decline"] });
  const card = await client.nextRequest();
  assert.deepEqual(card.params.choices, ["once", "deny"]);
  const [open] = daemon.openRequests().filter((request) => request.threadId === session);
  daemon.answerFromTerminal(open.id, { decision: "accept" });
  const cancel = await client.from(start, (frame) => isEvent(frame, "request.cancel", session));
  assert.deepEqual(cancel.params.payload, { id: card.id, reason: "resolved" });
  assert.equal((await client.call("session.resume", { session_id: session })).open_requests.length, 0);
  daemon.finishTurn(session, turnId);
  await completed(session, start);
  const bridgeConnection = daemon.callsOf("turn/start").at(-1)!.connection;
  assert.equal(bridgeConnection.received.some((message) => message.id === open.id && message.method === undefined), false);
});

test("the connection to Codex drops while an approval waits: the card stays, Codex asks again, the answer reaches it", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Run it.");
  const turnId = await daemon.activeTurn(session);
  void daemon.request(session, "item/commandExecution/requestApproval", { threadId: session, turnId, itemId: "c1", command: "make" });
  const card = await client.nextRequest();
  const from = daemon.calls.length;
  daemon.dropAll();
  // The bridge connects again and follows the thread again; Codex asks again under a new id.
  await daemon.waitForCall((call) => call.method === "thread/resume" && call.params.threadId === session, from);
  await new Promise((resolve) => setTimeout(resolve, 50));
  client.answer(card.id, { choice: "once" });
  await until(() => answersFor(session).length === 1);
  assert.deepEqual(answersFor(session), [{ decision: "accept" }]);
  // One card throughout: not asked twice, not withdrawn.
  const events = turnEvents(session, start);
  assert.equal(client.frames.slice(start).filter((frame) => frame.method === "approval").length, 1);
  assert.equal(events.some((event) => event.type === "request.cancel"), false);
  daemon.finishTurn(session, turnId);
  assert.equal((await completed(session, start)).payload.status, "complete");
});

test("an answer given while Codex is away is sent when Codex asks again; a turn that ended meanwhile is caught up", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Run it.");
  const turnId = await daemon.activeTurn(session);
  void daemon.request(session, "item/commandExecution/requestApproval", { threadId: session, turnId, itemId: "c2", command: "make test" });
  const card = await client.nextRequest();
  daemon.accepting = false;
  daemon.dropAll();
  await new Promise((resolve) => setTimeout(resolve, 30));
  client.answer(card.id, { choice: "deny" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  daemon.accepting = true;
  await until(() => answersFor(session).length === 1);
  assert.deepEqual(answersFor(session), [{ decision: "decline" }]);

  // Codex finishes the turn while the bridge is away again; it catches up from thread/read.
  daemon.accepting = false;
  daemon.dropAll();
  const command = { type: "commandExecution", id: "c2", command: "make test", cwd, status: "declined", aggregatedOutput: null, exitCode: null, durationMs: null, commandActions: [] };
  daemon.broadcast("item/completed", { threadId: session, turnId, item: command, completedAtMs: 3 });
  daemon.finishTurn(session, turnId, "Skipped the tests.");
  daemon.accepting = true;
  const done = await completed(session, start);
  assert.equal(done.payload.status, "complete");
  const events = turnEvents(session, start);
  assert.deepEqual(events.find((event) => event.type === "tool.complete").payload.result, { status: "blocked", error: "Declined.", user_summary: "You denied this command — it did not run." });
  assert.equal(done.payload.text, "Skipped the tests.");
});

test("a reply streaming when the connection to Codex drops goes on whole, without the part said while the bridge was away missing", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Say hello.");
  const turnId = await daemon.activeTurn(session);
  const item = { type: "agentMessage", id: "reply", text: "", phase: "final_answer", memoryCitation: null, delivery: null, questions: null };
  daemon.broadcast("item/started", { threadId: session, turnId, item, startedAtMs: 1 });
  daemon.broadcast("item/agentMessage/delta", { threadId: session, turnId, itemId: "reply", delta: "Hello " });
  await client.from(start, (frame) => isEvent(frame, "message.delta", session));
  const resumes = daemon.callsOf("thread/resume").length;
  daemon.accepting = false;
  daemon.dropAll();
  // Said while nobody listened.
  daemon.broadcast("item/agentMessage/delta", { threadId: session, turnId, itemId: "reply", delta: "big " });
  daemon.accepting = true;
  await until(() => daemon.callsOf("thread/resume").length > resumes);
  await new Promise((resolve) => setTimeout(resolve, 30));
  daemon.broadcast("item/agentMessage/delta", { threadId: session, turnId, itemId: "reply", delta: "world" });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: { ...item, text: "Hello big world" }, completedAtMs: 2 });
  daemon.broadcast("turn/completed", { threadId: session, turn: { id: turnId, items: [], itemsView: "summary", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } });
  const done = await completed(session, start);
  assert.equal(done.payload.text, "Hello big world");
  const streamed = turnEvents(session, start)
    .filter((event) => event.type === "message.delta")
    .map((event) => event.payload.text)
    .join("");
  assert.equal(streamed, "Hello big world");
});

test("after a reconnect only the threads Codex still has loaded are followed again; one it let go of is followed at its next message", async () => {
  const kept = await createThread();
  const dropped = await createThread();
  for (const session of [kept, dropped]) {
    const start = client.frames.length;
    await send(session, "Hello.");
    daemon.finishTurn(session, await daemon.activeTurn(session));
    await completed(session, start);
  }
  const from = daemon.calls.length;
  daemon.accepting = false;
  daemon.dropAll();
  // Codex let go of one meanwhile: following it again would load it, and start its MCP servers.
  Object.assign(daemon.thread(dropped), { loaded: false, status: { type: "notLoaded" } });
  daemon.accepting = true;
  await daemon.waitForCall((call) => call.method === "thread/resume" && call.params.threadId === kept, from);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resumed = () => daemon.calls.slice(from).filter((call) => call.method === "thread/resume" && call.params.threadId === dropped);
  assert.equal(resumed().length, 0);

  const start = client.frames.length;
  const turn = await send(dropped, "Again.");
  assert.equal(resumed().length, 1);
  assert.ok(daemon.calls.indexOf(resumed()[0]) < daemon.calls.indexOf(turn));
  daemon.finishTurn(dropped, await daemon.activeTurn(dropped));
  await completed(dropped, start);
  // Followed again, it is followed again after the next reconnect too.
  const again = daemon.calls.length;
  daemon.dropAll();
  await daemon.waitForCall((call) => call.method === "thread/resume" && call.params.threadId === dropped, again);
});

test("a turn begun at the desk while the bridge asks Codex which threads it still has is followed again, with its questions", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "Hello.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  // Codex had let go of it as it answered, while a terminal took it up and began a turn.
  Object.assign(daemon.thread(session), { loaded: false, status: { type: "notLoaded" } });
  const turnId = "desk-at-reconnect";
  const user = { type: "userMessage", id: "u-desk-reconnect", clientId: null, content: [{ type: "text", text: "From the terminal.", text_elements: [] }] };
  daemon.onLoaded = () => {
    daemon.onLoaded = () => {};
    daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
    daemon.broadcast("item/started", { threadId: session, turnId, item: user, startedAtMs: 1 });
    daemon.broadcast("item/completed", { threadId: session, turnId, item: user, completedAtMs: 1 });
  };
  start = client.frames.length;
  const from = daemon.calls.length;
  daemon.dropAll();
  await client.from(start, (frame) => isEvent(frame, "message.start", session));
  await until(() => daemon.calls.slice(from).some((call) => call.method === "thread/resume" && call.params.threadId === session));
  const asked = daemon.request(session, "item/commandExecution/requestApproval", { threadId: session, turnId, itemId: "c-desk", command: "make" });
  // Earlier tests' questions Codex asks again come too.
  let card = await client.nextRequest();
  while (card.params.session_id !== session) card = await client.nextRequest();
  client.answer(card.id, { choice: "once" });
  assert.deepEqual((await asked).result, { decision: "accept" });
  daemon.finishTurn(session, turnId);
  await completed(session, start);
});

test("a desk turn whose message comes after the bridge, back on its connection, let its thread go is followed once it shows, with its questions", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "Hello.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  Object.assign(daemon.thread(session), { loaded: false, status: { type: "notLoaded" } });
  const turnId = "desk-in-hooks-at-reconnect";
  // The terminal's turn has begun as Codex answers; its message comes once its hooks ran.
  daemon.onLoaded = () => {
    daemon.onLoaded = () => {};
    daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  };
  start = client.frames.length;
  const from = daemon.calls.length;
  daemon.dropAll();
  await daemon.waitForCall((call) => call.method === "thread/loaded/list", from);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const user = { type: "userMessage", id: "u-desk-hooks", clientId: null, content: [{ type: "text", text: "From the terminal.", text_elements: [] }] };
  daemon.broadcast("item/started", { threadId: session, turnId, item: user, startedAtMs: 1 });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: user, completedAtMs: 1 });
  await client.from(start, (frame) => isEvent(frame, "message.start", session));
  await until(() => daemon.calls.slice(from).some((call) => call.method === "thread/resume" && call.params.threadId === session));
  const asked = daemon.request(session, "item/commandExecution/requestApproval", { threadId: session, turnId, itemId: "c-desk-hooks", command: "make" });
  let card = await client.nextRequest();
  while (card.params.session_id !== session) card = await client.nextRequest();
  client.answer(card.id, { choice: "once" });
  assert.deepEqual((await asked).result, { decision: "accept" });
  daemon.finishTurn(session, turnId);
  await completed(session, start);
});

test("a no with a note given while Codex is away: the no reaches Codex once it asks again, and the note only after it", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Run it.");
  const turnId = await daemon.activeTurn(session);
  void daemon.request(session, "item/commandExecution/requestApproval", { threadId: session, turnId, itemId: "c3", command: "make" });
  // This thread's: Codex still asks the one an earlier test left open, on every reconnect.
  const card = await client.next((frame) => frame.method === "approval" && frame.params.session_id === session);
  daemon.accepting = false;
  daemon.dropAll();
  await new Promise((resolve) => setTimeout(resolve, 30));
  let answeredBeforeSteer: number | null = null;
  daemon.onSteer = () => {
    answeredBeforeSteer = answersFor(session).length;
  };
  client.answer(card.id, { choice: "deny", note: "Run make test instead." });
  await new Promise((resolve) => setTimeout(resolve, 30));
  daemon.accepting = true;
  await until(() => answeredBeforeSteer !== null);
  daemon.onSteer = () => {};
  assert.equal(answeredBeforeSteer, 1);
  assert.deepEqual(answersFor(session), [{ decision: "decline" }]);
  assert.deepEqual(
    daemon.callsOf("turn/steer").filter((call) => call.params.threadId === session).map((call) => call.params.input),
    [[{ type: "text", text: "Run make test instead.", text_elements: [] }]],
  );
  daemon.finishTurn(session, turnId);
  assert.equal((await completed(session, start)).payload.status, "complete");
});

test("a no with a note given while Codex stays away longer than a call waits: the no goes once Codex is back, and the note in a turn of its own after", async (t) => {
  // A bridge of its own, whose calls wait a tenth of a second for Codex.
  const provider = new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images },
    connect: socketConnector(daemon.socketPath),
    checkVersion: false,
    configPath: join(daemon.folder, "config.toml"),
    timeZone: "UTC",
    backoff: [0.05, 0.1],
    readyMs: 100,
  });
  const own = await startTestBridge({ providers: new Map([["codex", provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  t.after(async () => {
    daemon.accepting = true;
    await phone.close();
    await own.dispose();
  });
  const session = (await phone.call("session.create", { profile: "codex", cwd })).session_id as string;
  await phone.call("prompt.submit", { session_id: session, text: "Run it.", profile: "codex" });
  const turnId = await daemon.activeTurn(session);
  void daemon.request(session, "item/commandExecution/requestApproval", { threadId: session, turnId, itemId: "c5", command: "make" });
  const card = await phone.next((frame) => frame.method === "approval" && frame.params.session_id === session);
  daemon.accepting = false;
  daemon.dropAll();
  await new Promise((resolve) => setTimeout(resolve, 30));
  phone.answer(card.id, { choice: "deny", note: "Run make test instead." });
  // The steer gives up waiting for Codex, and its thread can be read no more than it.
  await new Promise((resolve) => setTimeout(resolve, 600));
  daemon.accepting = true;
  await until(() => answersFor(session).length === 1);
  assert.deepEqual(answersFor(session), [{ decision: "decline" }]);
  daemon.finishTurn(session, turnId, "Did not run make.");
  const starts = () => daemon.callsOf("turn/start").filter((call) => call.params.threadId === session);
  await until(() => starts().length === 2);
  assert.deepEqual(starts()[1].params.input, [{ type: "text", text: "Run make test instead.", text_elements: [] }]);
  // Never steered: it went once, in its own turn.
  assert.equal(daemon.callsOf("turn/steer").filter((call) => call.params.threadId === session).length, 0);
  await until(() => daemon.thread(session).turns.length === 2);
  daemon.finishTurn(session, daemon.thread(session).turns[1].id, "Ran make test.");
  await phone.from(0, () => phone.events(session).filter((event) => event.type === "message.complete").length === 2);
});

test("the connection drops again before the last reconnect's cards are closed: a no with a note given meanwhile is kept, and the note goes after it", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Run it.");
  const turnId = await daemon.activeTurn(session);
  void daemon.request(session, "item/commandExecution/requestApproval", { threadId: session, turnId, itemId: "c6", command: "make" });
  const card = await client.next((frame) => frame.method === "approval" && frame.params.session_id === session);
  const asked = () => daemon.openRequests().find((request) => request.threadId === session)?.id;
  const first = asked();
  // Down and back: Codex asks again, and the bridge closes what it does not ask again two seconds on.
  daemon.dropAll();
  await until(() => asked() !== first);
  // Down again within those two seconds, answered while away, and back after them.
  daemon.accepting = false;
  daemon.dropAll();
  await new Promise((resolve) => setTimeout(resolve, 30));
  let answeredBeforeSteer: number | null = null;
  daemon.onSteer = () => {
    answeredBeforeSteer = answersFor(session).length;
  };
  client.answer(card.id, { choice: "deny", note: "Run make test instead." });
  await new Promise((resolve) => setTimeout(resolve, 2200));
  daemon.accepting = true;
  await until(() => answeredBeforeSteer !== null);
  daemon.onSteer = () => {};
  assert.equal(answeredBeforeSteer, 1);
  assert.deepEqual(answersFor(session), [{ decision: "decline" }]);
  // One card throughout, answered once.
  assert.equal(client.frames.slice(start).filter((frame) => frame.method === "approval" && frame.params.session_id === session).length, 1);
  daemon.finishTurn(session, turnId);
  assert.equal((await completed(session, start)).payload.status, "complete");
});

test("Codex restarts while a turn runs: the turn it cut off ends interrupted, saying why, and the next message has a turn", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "Count to 1000.");
  const turnId = await daemon.activeTurn(session);
  // Down and back: Codex keeps the turn in progress, in a thread it has not loaded.
  daemon.accepting = false;
  daemon.dropAll();
  daemon.thread(session).status = { type: "notLoaded" };
  daemon.thread(session).loaded = false;
  daemon.accepting = true;
  const done = await completed(session, start);
  assert.equal(done.payload.status, "interrupted");
  const notice = turnEvents(session, start).find((event) => event.type === "status.update");
  assert.equal(notice.payload.kind, "warn");
  assert.match(notice.payload.text, /^Codex stopped before it finished this turn/);
  assert.equal(daemon.thread(session).turns.find((turn) => turn.id === turnId).status, "inProgress");

  start = client.frames.length;
  // Sent as the bridge may still be catching up on the thread: it may wait on the list till then.
  const reply = await client.call("prompt.submit", { session_id: session, text: "Go on.", profile: "codex" });
  assert.ok(reply.status === "streaming" || reply.status === "queued");
  await until(() => daemon.thread(session).status.type === "active");
  daemon.finishTurn(session, daemon.thread(session).turns.at(-1).id, "1001");
  assert.equal((await completed(session, start)).payload.text, "1001");
});

test("after a restart the bridge follows a thread Codex still runs at once; its open approval waits for the phone", async () => {
  const first = await startTestBridge({ keepHome: true, providers: new Map([["codex", codexProvider()]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(first);
  const session = (await phone.call("session.create", { profile: "codex", cwd, title: "Long job" })).session_id;
  await phone.call("prompt.submit", { session_id: session, text: "Build it." });
  const turnId = await daemon.activeTurn(session);
  daemon.broadcast("item/started", { threadId: session, turnId, item: { type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "Build it.", text_elements: [] }] }, startedAtMs: 1 });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: { type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "Build it.", text_elements: [] }] }, completedAtMs: 1 });
  const change = { type: "fileChange", id: "change-r", changes: [{ path: join(cwd, "built.txt"), kind: { type: "add" }, diff: "built\n" }], status: "inProgress" };
  daemon.broadcast("item/started", { threadId: session, turnId, item: change, startedAtMs: 1 });
  void daemon.request(session, "item/fileChange/requestApproval", { threadId: session, turnId, itemId: "change-r", startedAtMs: 1, reason: null, grantRoot: null });
  await phone.nextRequest();
  await phone.close();
  await first.close();

  const from = daemon.calls.length;
  const second = await startTestBridge({ home: first.home, providers: new Map([["codex", codexProvider()]]) });
  const again = await TestClient.open(second);
  try {
    // Followed before any phone asked.
    await daemon.waitForCall((call) => call.method === "thread/resume" && call.params.threadId === session, from);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resumed = await again.call("session.resume", { session_id: session, profile: "codex", inline_images: false });
    assert.equal(resumed.running, true);
    assert.deepEqual(resumed.inflight, { user: "Build it.", assistant: "" });
    assert.equal(resumed.info.title, "Long job");
    // The change it is about is still in progress, so only thread/resume has its diff.
    assert.deepEqual(
      resumed.open_requests.map((request: Frame) => [request.method, request.params.command]),
      [["approval", `Edit ${cwd}/built.txt\n--- /dev/null\n+++ b/built.txt\n@@ -0,0 +1 @@\n+built\n`]],
    );
    const start = again.frames.length;
    again.answer(resumed.open_requests[0].id, { choice: "once" });
    await until(() => answersFor(session).length === 1);
    assert.deepEqual(answersFor(session), [{ decision: "accept" }]);
    daemon.finishTurn(session, turnId, "Built.");
    const done = await completed(session, start, again);
    assert.deepEqual(done.payload.text, "Built.");
  } finally {
    await again.close();
    await second.dispose();
  }
});

test("after a restart a thread Codex has not loaded comes back from thread/read, and is followed only when used", async () => {
  const turns = rewrite(recordedHistory("tools").turns, [
    [recordedThread("tools"), "x"],
    [fixtureCwd, cwd],
  ]);
  const thread = daemon.addThread(cwd, turns, { loaded: false, name: "Patch hello.txt" });
  // The thread as an earlier run of the bridge left it.
  const seeded = await startTestBridge({ keepHome: true, providers: new Map(), config: { generalFolder: cwd } });
  await seeded.close();
  writeFileSync(
    join(seeded.home, "state", "threads.json"),
    JSON.stringify({ threads: [{ id: thread, agent: "codex", cwd, title: "Edit hello", model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "high", createdAt: 1, updatedAt: 1, origin: "phone", mode: "ask" }] }),
  );
  const from = daemon.calls.length;
  const restarted = await startTestBridge({ home: seeded.home, providers: new Map([["codex", codexProvider()]]) });
  const phone = await TestClient.open(restarted);
  try {
    const resumed = await phone.call("session.resume", { session_id: thread, profile: "codex", inline_images: false });
    assert.equal(resumed.running, false);
    assert.deepEqual(
      resumed.messages.map((message: Frame) => (message.role === "tool" ? message.name : message.role)),
      ["user", "assistant", "terminal", "patch", "terminal", "assistant"],
    );
    assert.equal(JSON.parse(resumed.messages[3].content).diff, "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n");
    // Codex's own name for it (given at the desk) is the title.
    assert.equal(resumed.info.title, "Patch hello.txt");
    assert.equal(daemon.calls.slice(from).some((call) => call.method === "thread/resume" && call.params.threadId === thread), false);

    // The next message follows it first, then starts the turn with the mode set before the restart.
    const start = phone.frames.length;
    const turn = await send(thread, "Again.", phone);
    const resume = daemon.calls.slice(from).findIndex((call) => call.method === "thread/resume" && call.params.threadId === thread);
    assert.ok(resume >= 0 && resume < daemon.calls.slice(from).indexOf(turn));
    assert.equal(turn.params.approvalPolicy, "untrusted");
    daemon.finishTurn(thread, await daemon.activeTurn(thread));
    await completed(thread, start, phone);
  } finally {
    await phone.close();
    await restarted.dispose();
  }
});

test("/mode default chosen just before a restart of the bridge still undoes the other mode's policy with the next turn", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode ask" });
  let start = client.frames.length;
  const asking = await send(session, "Ask first.");
  assert.equal(asking.params.approvalPolicy, "untrusted");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  await client.call("slash.exec", { session_id: session, command: "mode default" });
  const record = () => JSON.parse(readFileSync(join(bridge.home, "state", "threads.json"), "utf8")).threads.find((entry: Frame) => entry.id === session);
  // Kept with the thread until Codex has undone the other mode, not only in memory.
  assert.deepEqual([record().mode, record().modeReset], ["default", true]);
  // Not by a turn that could not start: Codex could not say what default comes to here.
  daemon.onConfigRead = (params) => {
    if (params?.cwd) throw new Error("Codex is restarting");
  };
  try {
    start = client.frames.length;
    assert.equal((await client.call("prompt.submit", { session_id: session, text: "Not yet.", profile: "codex" })).status, "streaming");
    assert.equal((await completed(session, start)).payload.status, "error");
  } finally {
    daemon.onConfigRead = () => {};
  }
  assert.equal(record().modeReset, true);
  // Nor by plan mode, whose turns run with the policy of the mode it left: default.
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  assert.equal(record().modeReset, true);
  await client.call("slash.exec", { session_id: session, command: "mode default" });
  const kept = record();

  // The thread as this run of the bridge left it, in the next run's registry.
  const seeded = await startTestBridge({ keepHome: true, providers: new Map(), config: { generalFolder: cwd } });
  await seeded.close();
  writeFileSync(join(seeded.home, "state", "threads.json"), JSON.stringify({ threads: [kept] }));
  const restarted = await startTestBridge({ home: seeded.home, providers: new Map([["codex", codexProvider()]]) });
  const phone = await TestClient.open(restarted);
  try {
    await phone.call("session.resume", { session_id: session, profile: "codex", inline_images: false });
    start = phone.frames.length;
    const turn = await send(session, "Now do it.", phone);
    // What default comes to (Dana's config.toml), sent once, in place of ask's policy.
    assert.equal(turn.params.approvalPolicy, "never");
    assert.deepEqual(turn.params.sandboxPolicy, { type: "dangerFullAccess" });
    daemon.finishTurn(session, await daemon.activeTurn(session));
    await completed(session, start, phone);
    const after = JSON.parse(readFileSync(join(seeded.home, "state", "threads.json"), "utf8")).threads.find((record: Frame) => record.id === session);
    assert.equal(after.modeReset, undefined);
    // Codex keeps it from then on: the turn after sends none.
    start = phone.frames.length;
    const next = await send(session, "And again.", phone);
    assert.equal(next.params.approvalPolicy, undefined);
    daemon.finishTurn(session, await daemon.activeTurn(session));
    await completed(session, start, phone);
  } finally {
    await phone.close();
    await restarted.dispose();
  }
});

/** A bridge whose registry has a Codex thread `thread`, as an earlier run of it left it. */
async function restartedWith(thread: string, title: string): Promise<{ bridge: TestBridge; phone: TestClient }> {
  const seeded = await startTestBridge({ keepHome: true, providers: new Map(), config: { generalFolder: cwd } });
  await seeded.close();
  writeFileSync(
    join(seeded.home, "state", "threads.json"),
    JSON.stringify({ threads: [{ id: thread, agent: "codex", cwd, title, model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "high", createdAt: 1, updatedAt: 1, origin: "phone" }] }),
  );
  const restarted = await startTestBridge({ home: seeded.home, providers: new Map([["codex", codexProvider()]]) });
  return { bridge: restarted, phone: await TestClient.open(restarted) };
}

test("after a restart a thread Codex is compacting runs that /compact: the reply before it is whole, and a message waits for it", async () => {
  const turns = rewrite(recordedHistory("compact").turns, [
    [recordedThread("compact"), "x"],
    [fixtureCwd, cwd],
  ]);
  // The compaction is under way: Codex keeps its item once it is done.
  const compacting = turns[1];
  Object.assign(compacting, { status: "inProgress", items: [], completedAt: null });
  const thread = daemon.addThread(cwd, turns, { loaded: true, status: { type: "active", activeFlags: [] } });
  const { bridge: restarted, phone } = await restartedWith(thread, "Hello");
  try {
    const resumed = await phone.call("session.resume", { session_id: thread, profile: "codex", inline_images: false });
    assert.equal(resumed.running, true);
    assert.deepEqual(resumed.inflight, { user: "/compact", assistant: "" });
    assert.deepEqual(
      resumed.messages.map((message: Frame) => [message.role, message.text, message.display_metadata]),
      [
        ["user", "Reply with the single word hello. Do not use any tools.", undefined],
        ["assistant", "hello", undefined],
        ["user", "/compact", undefined],
      ],
    );
    const start = phone.frames.length;
    const from = daemon.calls.length;
    assert.deepEqual(await phone.call("prompt.submit", { session_id: thread, text: "Then run the tests." }), { status: "queued", queue_id: "1" });
    const item = { type: "contextCompaction", id: "compaction-r" };
    daemon.broadcast("item/completed", { threadId: thread, turnId: compacting.id, item, completedAtMs: 2 });
    daemon.broadcast("turn/completed", { threadId: thread, turn: { id: compacting.id, items: [], itemsView: "summary", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } });
    const compacted = await completed(thread, start, phone);
    assert.equal(compacted.payload.status, "complete");
    assert.equal(turnEvents(thread, start, phone).find((event) => event.type === "session.compacted")?.payload.trigger, "manual");
    const next = await daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === thread, from);
    assert.deepEqual(next.params.input, [{ type: "text", text: "Then run the tests.", text_elements: [] }]);
    daemon.finishTurn(thread, await daemon.activeTurn(thread), "They pass.");
    await until(() => turnEvents(thread, start, phone).filter((event) => event.type === "message.complete").length === 2);
  } finally {
    await phone.close();
    await restarted.dispose();
  }
});

test("after a restart a running turn with a message steered into it is open from that message, which is shown once", async () => {
  const turns = rewrite(recordedHistory("steer").turns, [
    [recordedThread("steer"), "x"],
    [fixtureCwd, cwd],
  ]);
  const running = turns[0];
  Object.assign(running, { status: "inProgress", completedAt: null });
  // Up to the steered message: the reply after it is still being written.
  running.items = running.items.slice(0, running.items.findLastIndex((item: Frame) => item.type === "userMessage") + 1);
  const thread = daemon.addThread(cwd, turns, { loaded: true, status: { type: "active", activeFlags: [] } });
  const { bridge: restarted, phone } = await restartedWith(thread, "Count");
  try {
    const resumed = await phone.call("session.resume", { session_id: thread, profile: "codex", inline_images: false });
    assert.equal(resumed.running, true);
    assert.deepEqual(resumed.inflight, { user: "When you have finished counting, also say the word banana.", assistant: "" });
    assert.deepEqual(
      resumed.messages.filter((message: Frame) => message.role === "user").map((message: Frame) => [message.text, message.display_kind]),
      [
        ["Count from 1 to 40, one number per line, with no other text. Do not use any tools.", undefined],
        ["When you have finished counting, also say the word banana.", "steer"],
      ],
    );
    const start = phone.frames.length;
    daemon.finishTurn(thread, running.id, "banana");
    assert.equal((await completed(thread, start, phone)).payload.text, "banana");
  } finally {
    await phone.close();
    await restarted.dispose();
  }
});

test("after a restart a turn loaded before its message came (Codex runs hooks first) is taken for a /compact until the message comes, then is opened by it and takes more", async () => {
  const turns = rewrite(recordedHistory("plain").turns, [
    [recordedThread("plain"), "x"],
    [fixtureCwd, cwd],
  ]);
  const waiting = { id: "hooks-turn", rootTurnId: null, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 2, completedAt: null, durationMs: null };
  const thread = daemon.addThread(cwd, [...turns, waiting], { loaded: true, status: { type: "active", activeFlags: [] } });
  const { bridge: restarted, phone } = await restartedWith(thread, "Hello");
  try {
    const resumed = await phone.call("session.resume", { session_id: thread, profile: "codex", inline_images: false });
    assert.equal(resumed.running, true);
    assert.deepEqual(resumed.inflight, { user: "/compact", assistant: "" });
    const start = phone.frames.length;
    const user = { type: "userMessage", id: "u-hooked", clientId: null, content: [{ type: "text", text: "From the terminal.", text_elements: [] }] };
    daemon.broadcast("item/started", { threadId: thread, turnId: waiting.id, item: user, startedAtMs: 2 });
    daemon.broadcast("item/completed", { threadId: thread, turnId: waiting.id, item: user, completedAtMs: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // A device that opens it now is shown the message that opened it.
    const reopened = await phone.call("session.resume", { session_id: thread, profile: "codex", inline_images: false });
    assert.deepEqual(reopened.inflight, { user: "From the terminal.", assistant: "" });
    const said = reopened.messages.filter((message: Frame) => message.role === "user").map((message: Frame) => message.text);
    assert.equal(said.length, 2);
    assert.equal(said[1], "From the terminal.");
    // Steered in, not kept waiting for the turn to end.
    const from = daemon.calls.length;
    assert.deepEqual(await phone.call("prompt.submit", { session_id: thread, text: "And run the tests." }), { status: "steered" });
    const steer = await daemon.waitForCall((call) => call.method === "turn/steer" && call.params.threadId === thread, from);
    assert.equal(steer.params.expectedTurnId, waiting.id);
    daemon.finishTurn(thread, waiting.id, "Done.");
    assert.equal((await completed(thread, start, phone)).payload.text, "Done.");
  } finally {
    await phone.close();
    await restarted.dispose();
  }
});

test("after a restart a sub-agent's question answered at a terminal before the thread it works for is wired up leaves no card", async () => {
  const parent = daemon.addThread(cwd, [], { loaded: true });
  const child = daemon.addThread(cwd, [], { loaded: true, parentThreadId: parent, source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: null, agent_nickname: null, agent_role: null } } } });
  let reads = 0;
  // The second read of the thread comes once the bridge follows it, before it has wired it up.
  daemon.onRead = (params) => {
    if (params.threadId !== parent || ++reads < 2) return;
    daemon.onRead = () => {};
    daemon.broadcast("thread/started", { thread: { id: child, parentThreadId: parent } });
    void daemon.request(child, "item/commandExecution/requestApproval", { threadId: child, turnId: "sub-turn", itemId: "c-early", command: "make" });
    daemon.answerFromTerminal(daemon.openRequests().find((request) => request.threadId === child)!.id, { decision: "accept" });
  };
  const { bridge: restarted, phone } = await restartedWith(parent, "Spawner");
  try {
    await until(() => reads >= 2);
    await phone.call("session.resume", { session_id: parent, profile: "codex", inline_images: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual((await phone.call("session.resume", { session_id: parent, profile: "codex", inline_images: false })).open_requests, []);
    assert.deepEqual(answersFor(child), [{ decision: "accept" }]);
  } finally {
    daemon.onRead = () => {};
    await phone.close();
    await restarted.dispose();
  }
});

test("after a restart a Codex thread's sub-agents come back from its stored turns, on the line of the turn that started them", async () => {
  const turns = rewrite(recordedHistory("subagent").turns, [
    [recordedThread("subagent"), "x"],
    [fixtureCwd, cwd],
  ]);
  const thread = daemon.addThread(cwd, turns, { loaded: false, name: "Pear" });
  const seeded = await startTestBridge({ keepHome: true, providers: new Map(), config: { generalFolder: cwd } });
  await seeded.close();
  writeFileSync(
    join(seeded.home, "state", "threads.json"),
    JSON.stringify({ threads: [{ id: thread, agent: "codex", cwd, title: "Pear", model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low", createdAt: 1, updatedAt: 1, origin: "phone" }] }),
  );
  const restarted = await startTestBridge({ home: seeded.home, providers: new Map([["codex", codexProvider()]]) });
  const phone = await TestClient.open(restarted);
  try {
    await phone.call("session.resume", { session_id: thread, profile: "codex", inline_images: false });
    const listed = (await phone.call("subagent.list", { session_id: thread, profile: "codex" })).subagents;
    assert.deepEqual(
      listed.map((subagent: Frame) => [subagent.subagent_id, subagent.goal, subagent.status, subagent.turn, subagent.started_at, subagent.ended_at]),
      [["01a13a21-3e05-7212-b29e-4fb66eb40f01", "pear reply", "completed", 0, 1791976616, 1791976624]],
    );
  } finally {
    await phone.close();
    await restarted.dispose();
  }
});

test("a stored thread's sub-agent left at work keeps the turn that started it, however fast its own thread is read", async () => {
  // Codex answers at once: the read that settles the old sub-agent is in before the thread is taken up.
  const started = (thread: string, path: string) => ({ type: "subAgentActivity", id: `${thread}-started`, kind: "started", agentThreadId: thread, agentPath: path });
  const parent = {
    status: { type: "notLoaded" },
    turns: [
      { id: "p1", status: "completed", startedAt: 10, completedAt: 20, items: [started("old", "/root/old")] },
      { id: "p2", status: "completed", startedAt: 30, completedAt: 40, items: [started("new", "/root/new"), { ...started("new", "/root/new"), kind: "completed" }] },
    ],
  };
  const host = {
    client: { call: async (_method: string, params: { threadId: string }) => ({ thread: params.threadId === "parent" ? parent : { status: { type: "idle" }, turns: [{ id: "ct", status: "completed", items: [] }] } }) },
    defaults: () => null,
    efforts: () => [],
    imagesDir: cwd,
    interruptGraceMs: 100,
    forget() {},
  };
  const record = { id: "parent", agent: "codex", cwd, title: "Two", model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low", createdAt: 1, updatedAt: 1, origin: "phone" };
  const thread = new Session(record as never, { has: () => false, set() {}, update() {} } as never);
  const provider = new CodexSession({ id: "parent", cwd, settings: { model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low" } } as never, thread.sink, host as never, { applied: null, subscribed: false });
  await provider.load();
  await thread.attach(provider);
  await until(() => thread.subagentList().every((subagent) => subagent.status !== "running"));
  assert.deepEqual(
    thread.subagentList().map((subagent) => [subagent.subagent_id, subagent.turn, subagent.status]),
    [
      ["old", -1, "completed"],
      ["new", 0, "completed"],
    ],
  );
});

test("after a restart a sub-agent's own sub-agent still at work comes back under it, named, and can be stopped by itself", async () => {
  const activity = (kind: string, thread: string, path: string) => ({ type: "subAgentActivity", id: `${thread}-${kind}`, kind, agentThreadId: thread, agentPath: path });
  const parent = {
    status: { type: "notLoaded" },
    turns: [{ id: "p1", status: "completed", startedAt: 10, completedAt: 20, items: [activity("started", "worker", "/root/worker")] }],
  };
  const threads: Record<string, unknown> = {
    parent,
    // The worker, at work, spawned a helper (and messaged the thread it works for) while the bridge was off.
    worker: {
      status: { type: "active" },
      agentNickname: "Wegener",
      turns: [{ id: "wt", status: "inProgress", startedAt: 12, items: [activity("started", "helper", "/root/worker/helper"), activity("interacted", "parent", "/root")] }],
    },
    helper: { status: { type: "active" }, agentNickname: "Franklin", agentRole: "explorer", turns: [{ id: "ht", status: "inProgress", startedAt: 13, items: [] }] },
  };
  const interrupts: unknown[] = [];
  const host = {
    client: {
      call: async (method: string, params: { threadId: string; turnId?: string }) => {
        if (method === "turn/interrupt") return interrupts.push([params.threadId, params.turnId]);
        return { thread: threads[params.threadId] };
      },
    },
    defaults: () => null,
    efforts: () => [],
    imagesDir: cwd,
    interruptGraceMs: 100,
    forget() {},
  };
  const record = { id: "parent", agent: "codex", cwd, title: "Nested", model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low", createdAt: 1, updatedAt: 1, origin: "phone" };
  const thread = new Session(record as never, { has: () => false, set() {}, update() {} } as never);
  const provider = new CodexSession({ id: "parent", cwd, settings: { model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low" } } as never, thread.sink, host as never, { applied: null, subscribed: false });
  await provider.load();
  await thread.attach(provider);
  await until(() => thread.subagentList().some((subagent) => subagent.subagent_id === "helper" && subagent.nickname === "Franklin"));
  assert.deepEqual(
    thread.subagentList().map((subagent) => [subagent.subagent_id, subagent.nickname ?? null, subagent.parent_id ?? null, subagent.status, subagent.can_stop]),
    [
      ["worker", "Wegener", null, "running", true],
      ["helper", "Franklin", "worker", "running", true],
    ],
  );
  assert.equal(await provider.stopSubagent("helper"), true);
  assert.deepEqual(interrupts, [["helper", "ht"]]);
});

test("after a restart a sub-agent's many own sub-agents are read a few at a time", async () => {
  const activity = (thread: string, path: string) => ({ type: "subAgentActivity", id: `${thread}-started`, kind: "started", agentThreadId: thread, agentPath: path });
  const helpers = Array.from({ length: 12 }, (_, index) => `helper-${index}`);
  const threads: Record<string, unknown> = {
    parent: { status: { type: "notLoaded" }, turns: [{ id: "p1", status: "completed", startedAt: 10, completedAt: 20, items: [activity("worker", "/root/worker")] }] },
    worker: { status: { type: "active" }, turns: [{ id: "wt", status: "inProgress", startedAt: 12, items: helpers.map((id) => activity(id, `/root/worker/${id}`)) }] },
  };
  let reading = 0;
  let most = 0;
  const host = {
    client: {
      call: async (_method: string, params: { threadId: string }) => {
        reading += 1;
        most = Math.max(most, reading);
        await new Promise((resolve) => setTimeout(resolve, 5));
        reading -= 1;
        return { thread: threads[params.threadId] ?? { status: { type: "idle" }, turns: [{ id: "ht", status: "completed", completedAt: 30, items: [] }] } };
      },
    },
    defaults: () => null,
    efforts: () => [],
    imagesDir: cwd,
    interruptGraceMs: 100,
    forget() {},
  };
  const record = { id: "parent", agent: "codex", cwd, title: "Many", model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low", createdAt: 1, updatedAt: 1, origin: "phone" };
  const thread = new Session(record as never, { has: () => false, set() {}, update() {} } as never);
  const provider = new CodexSession({ id: "parent", cwd, settings: { model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low" } } as never, thread.sink, host as never, { applied: null, subscribed: false });
  await provider.load();
  await thread.attach(provider);
  await until(() => helpers.every((id) => thread.subagentList().some((subagent) => subagent.subagent_id === id && subagent.status === "completed")));
  assert.ok(most <= 4, `${most} reads at once`);
});

test("after a restart, a sub-agent that had left the line and ran again while the bridge was off is on the line once its own thread names the new run, though nothing else shown changed", async () => {
  const at = Math.floor(Date.now() / 1000) - 60;
  // As a v1 parent keeps it: the spawn, and the state its last call heard, answer included.
  const spawn = { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", prompt: "Check the build", receiverThreadIds: ["worker"], agentsStates: { worker: { status: "completed", message: "Done." } } };
  const threads: Record<string, unknown> = {
    parent: { status: { type: "notLoaded" }, turns: [{ id: "p1", status: "completed", startedAt: at - 10, completedAt: at, items: [spawn] }] },
    worker: { status: { type: "idle" }, turns: [{ id: "t2", status: "completed", startedAt: at - 5, completedAt: at, items: [{ type: "agentMessage", text: "Done." }] }] },
  };
  const host = {
    client: { call: async (_method: string, params: { threadId: string }) => ({ thread: threads[params.threadId] }) },
    defaults: () => null,
    efforts: () => [],
    imagesDir: cwd,
    interruptGraceMs: 100,
    forget() {},
  };
  // It left the line in its first run, t1.
  const record = { id: "parent", agent: "codex", cwd, title: "Rerun", model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low", createdAt: 1, updatedAt: 1, origin: "phone", subagentsCleared: [{ id: "worker", run: "t1" }] };
  const thread = new Session(record as never, { has: () => false, set() {}, update() {} } as never);
  const provider = new CodexSession({ id: "parent", cwd, settings: { model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low" } } as never, thread.sink, host as never, { applied: null, subscribed: false });
  await provider.load();
  await thread.attach(provider);
  await until(() => thread.subagentList().length > 0);
  assert.deepEqual(
    thread.subagentList().map((subagent) => [subagent.subagent_id, subagent.status, subagent.result]),
    [["worker", "completed", "Done."]],
  );
  // No longer kept as cleared: a later restart shows this run too.
  assert.equal(record.subagentsCleared, undefined);
});

test("a read that would settle a sub-agent, answered after it was given more to do, does not end its new turn", async () => {
  const parent = {
    status: { type: "notLoaded" },
    turns: [{ id: "p1", status: "completed", startedAt: 10, completedAt: 20, items: [{ type: "subAgentActivity", id: "s1", kind: "started", agentThreadId: "child", agentPath: "/root/worker" }] }],
  };
  let answer: (thread: unknown) => void = () => {};
  const interrupts: unknown[] = [];
  const host = {
    client: {
      call: async (method: string, params: { threadId: string }) => {
        if (method === "turn/interrupt") return interrupts.push(params);
        if (params.threadId === "parent") return { thread: parent };
        // The child's own thread, read to settle it: answered late.
        return new Promise((resolve) => (answer = (thread) => resolve({ thread })));
      },
    },
    defaults: () => null,
    efforts: () => [],
    imagesDir: cwd,
    interruptGraceMs: 100,
    forget() {},
  };
  const record = { id: "parent", agent: "codex", cwd, title: "Worker", model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low", createdAt: 1, updatedAt: 1, origin: "phone" };
  const thread = new Session(record as never, { has: () => false, set() {}, update() {} } as never);
  const provider = new CodexSession({ id: "parent", cwd, settings: { model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low" } } as never, thread.sink, host as never, { applied: null, subscribed: false });
  await provider.load();
  await thread.attach(provider);
  // Given more to do while the read is on its way; then the read says its old turn completed.
  provider.agentNotification("child", "turn/started", { threadId: "child", turn: { id: "new-turn", status: "inProgress", items: [] } });
  answer({ status: { type: "idle" }, turns: [{ id: "old-turn", status: "completed", items: [] }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(thread.subagentList().map((subagent) => [subagent.subagent_id, subagent.status, subagent.can_stop]), [["child", "running", true]]);
  assert.equal(await provider.stopSubagent("child"), true);
  assert.deepEqual(interrupts, [{ threadId: "child", turnId: "new-turn" }]);
});

test("overlapping child reads keep the newer completion, in either response order and with a missed start", async () => {
  for (const olderFirst of [true, false]) {
    for (const completionNotified of [true, false]) {
      const item = { type: "subAgentActivity", agentThreadId: "child", agentPath: "/root/worker" };
      const parent = { status: { type: "notLoaded" }, turns: [{ id: "p1", status: "completed", items: [
        { ...item, kind: "started" }, { ...item, kind: "completed" },
      ] }] };
      const old = { status: { type: "idle" }, turns: [{ id: "old", status: "completed", items: [{ type: "agentMessage", text: "Old answer" }] }] };
      let hold = false;
      const reads: ((thread: unknown) => void)[] = [];
      const host = {
        client: { call: async (_method: string, params: { threadId: string }) => {
          if (params.threadId === "parent") return { thread: parent };
          if (!hold) return { thread: old };
          return new Promise((resolve) => reads.push((thread) => resolve({ thread })));
        } },
        defaults: () => null, efforts: () => [], imagesDir: cwd, interruptGraceMs: 100, forget() {},
      };
      const record = { id: "parent", agent: "codex", cwd, title: "Worker", model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low", createdAt: 1, updatedAt: 1, origin: "phone" };
      const thread = new Session(record as never, { has: () => false, set() {}, update() {} } as never);
      const provider = new CodexSession({ id: "parent", cwd, settings: { model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "low" } } as never, thread.sink, host as never, { applied: null, subscribed: false });
      await provider.load();
      await thread.attach(provider);
      await until(() => thread.subagentList()[0]?.result === "Old answer");
      hold = true;
      await provider.reconnected(Promise.resolve(new Set()));
      if (completionNotified) provider.agentNotification("child", "turn/completed", { turn: { id: "new", status: "completed" } });
      else await provider.reconnected(Promise.resolve(new Set()));
      assert.equal(reads.length, 2);
      const active = { status: { type: "active", activeFlags: [] }, turns: [{ id: "new", status: "inProgress", items: [] }] };
      const done = { status: { type: "idle" }, turns: [{ id: "new", status: "completed", items: [{ type: "agentMessage", text: "New answer" }] }] };
      for (const index of olderFirst ? [0, 1] : [1, 0]) {
        reads[index](index === 0 ? active : done);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const [result] = thread.subagentList();
      assert.deepEqual([result.status, result.result, result.can_stop], ["completed", "New answer", false]);
    }
  }
});

test("a sub-agent that ends while the connection to Codex is down is settled once it is back, and the thread is at rest", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Spawn a slow sub-agent.");
  const turnID = await daemon.activeTurn(session);
  const child = daemon.addThread(cwd, [{ id: "child-turn", items: [], status: "inProgress", error: null }], {
    loaded: true,
    status: { type: "active", activeFlags: [] },
    parentThreadId: session,
  });
  daemon.broadcast("item/completed", { threadId: session, turnId: turnID, item: { type: "subAgentActivity", id: "call_1", kind: "started", agentThreadId: child, agentPath: "/root/slow_one" } });
  await client.from(start, (frame) => isEvent(frame, "subagent.start", session));
  daemon.finishTurn(session, turnID);
  await completed(session, start);
  const atWork = async () => (await client.call("sessions.activity")).sessions.some((entry: Frame) => entry.session_id === session);
  assert.equal(await atWork(), true);
  // It ends while the bridge is away, so no news of it reaches the bridge.
  Object.assign(daemon.thread(child), { status: { type: "idle" } });
  Object.assign(daemon.thread(child).turns[0], { status: "completed", items: [{ type: "agentMessage", id: "m1", text: "Slept." }] });
  daemon.dropAll();
  const ended = await client.from(start, (frame) => isEvent(frame, "subagent.complete", session));
  assert.deepEqual([ended.params.payload.status, ended.params.payload.result], ["completed", "Slept."]);
  assert.equal(await atWork(), false);
});

test("a finished sub-agent that restarts while disconnected is rediscovered and stopped by its new turn", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Run a background check.");
  const turnId = await daemon.activeTurn(session);
  const child = daemon.addThread(cwd, [{ id: "old-check", status: "inProgress", items: [] }], {
    loaded: true, status: { type: "active", activeFlags: [] }, parentThreadId: session,
  });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: { type: "subAgentActivity", id: "spawn-background-check", kind: "started", agentThreadId: child, agentPath: "/root/check" } });
  await client.from(start, (frame) => isEvent(frame, "subagent.start", session));
  daemon.finishTurn(child, "old-check", "Old check finished.");
  await client.from(start, (frame) => isEvent(frame, "subagent.complete", session));
  daemon.finishTurn(session, turnId);
  await completed(session, start);

  // No child notifications reach the bridge during this change.
  Object.assign(daemon.thread(child), { status: { type: "active", activeFlags: [] } });
  daemon.thread(child).turns.push({ id: "new-check", status: "inProgress", items: [] });
  const restartedAt = client.frames.length;
  daemon.dropAll();
  await client.from(restartedAt, (frame) => isEvent(frame, "subagent.progress", session) && frame.params.payload.status === "running");
  const [running] = (await client.call("subagent.list", { session_id: session })).subagents;
  assert.equal(running.result, undefined);
  const callsAt = daemon.calls.length;
  assert.deepEqual(await client.call("subagent.stop", { session_id: session, subagent_id: child }), { status: "stopped" });
  const interrupt = await daemon.waitForCall((call) => call.method === "turn/interrupt", callsAt);
  assert.deepEqual(interrupt.params, { threadId: child, turnId: "new-check" });
});

test("Stop given as a plan-mode turn completes puts no plan card: the turn ends once, as Codex ended it", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  await send(session, "Plan it.");
  const turnId = await daemon.activeTurn(session);
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  // Codex had its plan as Stop came, and completes the turn all the same.
  daemon.broadcast("item/completed", { threadId: session, turnId, item: { type: "plan", id: "plan-late", text: "1. Do it.\n" }, completedAtMs: 2 });
  daemon.finishTurn(session, turnId, "");
  assert.equal((await completed(session, start)).payload.status, "complete");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.frames.slice(start).some((frame) => frame.method === "approval"), false);
  assert.equal(turnEvents(session, start).filter((event) => event.type === "message.complete").length, 1);
});

test("Stop given while the bridge catches up on a plan-mode turn Codex ended while it was away puts no plan card, and the turn ends once", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  await send(session, "Plan it.");
  const turnId = await daemon.activeTurn(session);
  // Codex finishes its plan while the connection to it is down.
  daemon.accepting = false;
  daemon.dropAll();
  daemon.broadcast("item/completed", { threadId: session, turnId, item: { type: "plan", id: "plan-away", text: "1. Do it.\n" }, completedAtMs: 2 });
  daemon.finishTurn(session, turnId, "");
  // The bridge's read of what happened meanwhile is answered only after Stop.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let reading = false;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true) return;
    reading = true;
    return held;
  };
  daemon.accepting = true;
  try {
    await until(() => reading);
    assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  } finally {
    daemon.onRead = () => {};
    release();
  }
  await completed(session, start);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.frames.slice(start).some((frame) => frame.method === "approval"), false);
  assert.equal(turnEvents(session, start).filter((event) => event.type === "message.complete").length, 1);
});

test("a turn begun at the desk while a plan card waits closes the card and ends the app's turn; the desk's turn shows as its own, and a late Start sends nothing", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  daemon.scripts.push("plan");
  await send(session, "Plan how to change hi to hello in hello.txt.");
  const card = await client.from(start, (frame) => frame.method === "approval" && frame.params.session_id === session);
  assert.equal(card.params.plan, true);
  const turnId = "desk-after-plan";
  const user = { type: "userMessage", id: "u-desk-plan", clientId: null, content: [{ type: "text", text: "Never mind, I did it.", text_elements: [] }] };
  daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  const cancel = await client.from(start, (frame) => isEvent(frame, "request.cancel", session));
  assert.equal(cancel.params.payload.id, card.id);
  assert.equal((await completed(session, start)).payload.status, "complete");

  const deskStart = client.frames.length;
  daemon.broadcast("item/started", { threadId: session, turnId, item: user, startedAtMs: 1 });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: user, completedAtMs: 1 });
  daemon.finishTurn(session, turnId, "Fine.");
  const done = await completed(session, deskStart);
  assert.equal(done.payload.text, "Fine.");
  assert.equal(turnEvents(session, deskStart)[0].type, "message.start");
  const from = daemon.calls.length;
  client.answer(card.id, { choice: "once" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(daemon.calls.slice(from).some((call) => call.method === "turn/start"), false);
  assert.match((await client.call("slash.exec", { session_id: session, command: "mode" })).output, /^Mode: plan\./);
});

test("what default comes to is read from the folder's own Codex settings, not from the general config.toml alone", async () => {
  // The general config.toml runs without asking (full); this folder's asks first.
  daemon.folderConfigs.set(cwd, { sandbox_mode: "workspace-write", approval_policy: "untrusted" });
  try {
    const session = await createThread();
    assert.deepEqual((await client.call("session.resume", { session_id: session, profile: "codex" })).info.mode_default, "ask");
    assert.match((await client.call("slash.exec", { session_id: session, command: "mode" })).output, /^Mode: default\. This thread follows your Codex settings: it asks before editing files or running commands\./);
  } finally {
    daemon.folderConfigs.delete(cwd);
  }
});

test("/mode default whose folder settings Codex cannot read starts no turn, and the next turn undoes the other mode all the same", async () => {
  const session = await createThread();
  daemon.folderConfigs.set(cwd, { sandbox_mode: "read-only", approval_policy: "on-request" });
  try {
    await client.call("slash.exec", { session_id: session, command: "mode edits" });
    let start = client.frames.length;
    await send(session, "Go.");
    daemon.finishTurn(session, await daemon.activeTurn(session));
    await completed(session, start);
    await client.call("slash.exec", { session_id: session, command: "mode default" });
    daemon.onConfigRead = (params) => {
      if (params?.cwd) throw new Error("Codex is restarting");
    };
    start = client.frames.length;
    const from = daemon.calls.length;
    assert.equal((await client.call("prompt.submit", { session_id: session, text: "Now.", profile: "codex" })).status, "streaming");
    const failed = await completed(session, start);
    assert.equal(failed.payload.status, "error");
    assert.match(failed.payload.text, /settings for this folder: Codex is restarting/);
    assert.equal(daemon.calls.slice(from).some((call) => call.method === "turn/start"), false);
    daemon.onConfigRead = () => {};
    start = client.frames.length;
    const turn = await send(session, "Again.");
    assert.deepEqual([turn.params.approvalPolicy, turn.params.sandboxPolicy], ["on-request", { type: "readOnly", networkAccess: false }]);
    daemon.finishTurn(session, await daemon.activeTurn(session));
    await completed(session, start);
  } finally {
    daemon.onConfigRead = () => {};
    daemon.folderConfigs.delete(cwd);
  }
});

test("a turn's start takes back only the /mode default it carried out: default chosen again while it starts still undoes the mode between", async () => {
  const session = await createThread();
  daemon.folderConfigs.set(cwd, { sandbox_mode: "read-only", approval_policy: "on-request" });
  let releaseConfig = () => {};
  let releaseStart = () => {};
  const configHeld = new Promise<void>((resolve) => (releaseConfig = resolve));
  const startHeld = new Promise<void>((resolve) => (releaseStart = resolve));
  try {
    await client.call("slash.exec", { session_id: session, command: "mode full" });
    await client.call("slash.exec", { session_id: session, command: "mode default" });
    daemon.onConfigRead = (params) => (params?.cwd ? configHeld : undefined);
    daemon.onTurnStart = () => startHeld;
    let start = client.frames.length;
    const from = daemon.calls.length;
    assert.equal((await client.call("prompt.submit", { session_id: session, text: "Go.", profile: "codex" })).status, "streaming");
    await daemon.waitForCall((call) => call.method === "config/read" && call.params.cwd === cwd, from);
    // Edits, chosen while Codex reads the folder's settings, is what this turn runs with.
    await client.call("slash.exec", { session_id: session, command: "mode edits" });
    releaseConfig();
    const turn = await daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === session, from);
    assert.deepEqual([turn.params.approvalPolicy, turn.params.sandboxPolicy.type], ["on-request", "workspaceWrite"]);
    // Default again, before Codex has answered that turn's start.
    await client.call("slash.exec", { session_id: session, command: "mode default" });
    daemon.onTurnStart = () => {};
    releaseStart();
    daemon.finishTurn(session, await daemon.activeTurn(session));
    await completed(session, start);
    start = client.frames.length;
    const next = await send(session, "Again.");
    assert.deepEqual([next.params.approvalPolicy, next.params.sandboxPolicy], ["on-request", { type: "readOnly", networkAccess: false }]);
    daemon.finishTurn(session, await daemon.activeTurn(session));
    await completed(session, start);
  } finally {
    releaseConfig();
    releaseStart();
    daemon.onConfigRead = () => {};
    daemon.onTurnStart = () => {};
    daemon.folderConfigs.delete(cwd);
  }
});

test("Stop that comes right behind Start on a plan card ends the turn interrupted, and the plan is not carried out", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  daemon.scripts.push("plan");
  await send(session, "Plan how to change hi to hello in hello.txt.");
  const card = await client.from(start, (frame) => frame.method === "approval" && frame.params.session_id === session);
  const from = daemon.calls.length;
  // Both in the same moment, Stop second.
  client.answer(card.id, { choice: "once" });
  const stopped = client.call("session.interrupt", { session_id: session });
  assert.deepEqual(await stopped, { status: "interrupted" });
  const done = await completed(session, start);
  assert.equal(done.payload.status, "interrupted");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const started = daemon.calls.slice(from).filter((call) => call.method === "turn/start");
  // Not carried out, or else stopped in Codex.
  assert.ok(started.length === 0 || daemon.calls.slice(from).some((call) => call.method === "turn/interrupt"));
  assert.equal(turnEvents(session, start).filter((event) => event.type === "message.complete").length, 1);
});

/** A turn begun and ended at the desk, told to the daemon (which keeps it whether or not the bridge is connected). */
function deskTurn(session: string, turnId: string, text: string): void {
  const user = { type: "userMessage", id: `u-${turnId}`, clientId: null, content: [{ type: "text", text, text_elements: [] }] };
  daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: user, completedAtMs: 1 });
  daemon.finishTurn(session, turnId, "Done at the desk.");
}

test("a turn begun and ended at the desk while the connection to Codex was down closes the plan card it left behind once the bridge is back", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  daemon.scripts.push("plan");
  await send(session, "Plan how to change hi to hello in hello.txt.");
  const card = await client.from(start, (frame) => frame.method === "approval" && frame.params.session_id === session);
  const resumes = daemon.callsOf("thread/resume").length;
  daemon.accepting = false;
  daemon.dropAll();
  deskTurn(session, "desk-while-away", "Did it myself.");
  daemon.accepting = true;
  await until(() => daemon.callsOf("thread/resume").length > resumes);
  const cancel = await client.from(start, (frame) => isEvent(frame, "request.cancel", session));
  assert.equal(cancel.params.payload.id, card.id);
  assert.equal((await completed(session, start)).payload.status, "complete");
  const from = daemon.calls.length;
  client.answer(card.id, { choice: "once" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(daemon.calls.slice(from).some((call) => call.method === "turn/start"), false);
});

test("a turn begun at the desk while the connection to Codex was down, still running when it is back, shows as a turn of its own with its message", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  const turnId = "desk-while-down";
  const user = { type: "userMessage", id: "u-desk-down", clientId: null, content: [{ type: "text", text: "Typed while you were away.", text_elements: [] }] };
  daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: user, completedAtMs: 1 });
  daemon.accepting = true;
  await until(() => daemon.callsOf("thread/resume").length > resumes);
  const opened = await client.from(start, (frame) => isEvent(frame, "message.start", session));
  assert.deepEqual(opened.params.payload, { text: "Typed while you were away.", sender: "desk" });
  assert.deepEqual((await client.call("sessions.activity")).sessions.filter((entry: Frame) => entry.session_id === session), [{ session_id: session, state: "running" }]);
  daemon.finishTurn(session, turnId, "Done at the desk.");
  assert.equal((await completed(session, start)).payload.text, "Done at the desk.");
});

test("a plan carried out by a turn that said no tokens keeps the plan's under that turn's id, and its time, partly unknown, is the bridge's (turn_usage)", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  daemon.scripts.push("plan");
  await send(session, "Plan how to change hi to hello in hello.txt.");
  const card = await cardOf(session);
  const from = daemon.calls.length;
  client.answer(card.id, { choice: "once" });
  await daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === session, from);
  const work = await daemon.activeTurn(session);
  // Codex says nothing of what carrying it out spent; its own time for it is 1 s, the plan's is not known.
  daemon.finishTurn(session, work, "Changed it.");
  const done = await completed(session, start);
  assert.equal(done.payload.turn_usage.tokens, 77_784);
  assert.notEqual(done.payload.turn_usage.seconds, 1);
  const kept = JSON.parse(readFileSync(join(bridge.home, "state", "spent", `${session}.json`), "utf8"));
  assert.deepEqual(kept.map((entry: Frame) => [entry.turn, entry.tokens]), [[work, 77_784]]);
});

test("a plan whose carrying out Codex never began keeps what planning spent under the plan's turn (turn_usage)", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  daemon.scripts.push("plan");
  await send(session, "Plan how to change hi to hello in hello.txt.");
  const card = await cardOf(session);
  daemon.onTurnStart = () => {
    throw new Error("Codex is not taking turns now");
  };
  try {
    client.answer(card.id, { choice: "once" });
    const done = await completed(session, start);
    assert.equal(done.payload.status, "error");
    assert.equal(done.payload.turn_usage.tokens, 77_784);
  } finally {
    daemon.onTurnStart = () => {};
  }
  const kept = JSON.parse(readFileSync(join(bridge.home, "state", "spent", `${session}.json`), "utf8"));
  assert.deepEqual(kept.map((entry: Frame) => entry.tokens), [77_784]);
  assert.match(kept[0].turn, /\S/);
});

test("tokens a desk turn spent while the connection to Codex was down are not put on the next turn's footer (turn_usage)", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  const first = await daemon.activeTurn(session);
  spentNews(session, first, 1_000, 1_000);
  daemon.finishTurn(session, first);
  assert.equal((await completed(session, start)).payload.turn_usage.tokens, 1_000);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  // 1,500 spent at the desk, which the bridge never hears of.
  deskTurn(session, "desk-spent-while-down", "Done it myself.");
  daemon.accepting = true;
  await until(() => daemon.callsOf("thread/resume").length > resumes);
  await completed(session, start);
  start = client.frames.length;
  await send(session, "Next.");
  const next = await daemon.activeTurn(session);
  spentNews(session, next, 2_800, 300);
  daemon.finishTurn(session, next);
  assert.equal((await completed(session, start)).payload.turn_usage.tokens, 300);
});

test("a turn begun and ended at the desk while the connection to Codex was down shows once it is back, with its message and its reply", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  deskTurn(session, "desk-done-while-down", "Done it myself.");
  daemon.accepting = true;
  await until(() => daemon.callsOf("thread/resume").length > resumes);
  const opened = await client.from(start, (frame) => isEvent(frame, "message.start", session));
  assert.deepEqual(opened.params.payload, { text: "Done it myself.", sender: "desk" });
  const done = await completed(session, start);
  assert.deepEqual([done.payload.status, done.payload.text], ["complete", "Done at the desk."]);
  const stored = (await client.call("session.resume", { session_id: session })).messages.map((message: Frame) => [message.role, message.text]);
  assert.deepEqual(stored.slice(-2), [["user", "Done it myself."], ["assistant", "Done at the desk."]]);
  // Told once: a later reconnect has nothing more to tell.
  const again = client.frames.length;
  const resumed = daemon.callsOf("thread/resume").length;
  daemon.dropAll();
  await until(() => daemon.callsOf("thread/resume").length > resumed);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.frames.slice(again).some((frame) => isEvent(frame, "message.start", session)), false);
});

test("a turn begun at the desk just before the connection to Codex dropped, whose message came while it was down, shows once it is back", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  const turnId = "desk-split-by-drop";
  daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  daemon.accepting = false;
  daemon.dropAll();
  const user = { type: "userMessage", id: "u-split", clientId: null, content: [{ type: "text", text: "Sent as the line went down.", text_elements: [] }] };
  daemon.broadcast("item/completed", { threadId: session, turnId, item: user, completedAtMs: 1 });
  daemon.accepting = true;
  await until(() => daemon.callsOf("thread/resume").length > resumes);
  const opened = await client.from(start, (frame) => isEvent(frame, "message.start", session));
  assert.deepEqual(opened.params.payload, { text: "Sent as the line went down.", sender: "desk" });
  daemon.finishTurn(session, turnId, "Done at the desk.");
  assert.equal((await completed(session, start)).payload.text, "Done at the desk.");
});

test("a desk turn found running after the connection to Codex was down keeps what it said before, once it ends", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  const turnId = "desk-said-while-down";
  const user = { type: "userMessage", id: "u-said", clientId: null, content: [{ type: "text", text: "Check the logs.", text_elements: [] }] };
  daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: user, completedAtMs: 1 });
  const said = { type: "agentMessage", id: "a-said", text: "Reading the logs first.", phase: "commentary" };
  daemon.broadcast("item/completed", { threadId: session, turnId, item: said, completedAtMs: 2 });
  daemon.accepting = true;
  await until(() => daemon.callsOf("thread/resume").length > resumes);
  await client.from(start, (frame) => isEvent(frame, "message.start", session));
  daemon.finishTurn(session, turnId, "The logs are clean.");
  assert.equal((await completed(session, start)).payload.text, "The logs are clean.");
  const stored = (await client.call("session.resume", { session_id: session })).messages.map((message: Frame) => [message.role, message.text]);
  assert.deepEqual(stored.slice(-3), [["user", "Check the logs."], ["assistant", "Reading the logs first."], ["assistant", "The logs are clean."]]);
});

test("a /compact begun at the desk, found running with no message after the connection to Codex was down, shows once its compaction comes", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  const turnId = "desk-compact-while-down";
  daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  daemon.accepting = true;
  await until(() => daemon.callsOf("thread/resume").length > resumes);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const item = { type: "contextCompaction", id: "compaction-desk" };
  daemon.broadcast("item/started", { threadId: session, turnId, item, startedAtMs: 1 });
  daemon.broadcast("item/completed", { threadId: session, turnId, item, completedAtMs: 2 });
  daemon.broadcast("turn/completed", { threadId: session, turn: { id: turnId, items: [], itemsView: "summary", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } });
  const opened = await client.from(start, (frame) => isEvent(frame, "message.start", session));
  assert.deepEqual(opened.params.payload, { text: "/compact", sender: "desk" });
  await client.from(start, (frame) => isEvent(frame, "session.compacted", session));
  assert.equal((await completed(session, start)).payload.status, "complete");
});

test("a /compact begun at the desk that compacted while the connection to Codex was down shows once it is back, also if its end is all that follows", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  const turnId = "desk-compacted-while-down";
  daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  const item = { type: "contextCompaction", id: "compaction-gone" };
  daemon.broadcast("item/completed", { threadId: session, turnId, item, completedAtMs: 2 });
  daemon.accepting = true;
  await until(() => daemon.callsOf("thread/resume").length > resumes);
  const opened = await client.from(start, (frame) => isEvent(frame, "message.start", session));
  assert.deepEqual(opened.params.payload, { text: "/compact", sender: "desk" });
  await client.from(start, (frame) => isEvent(frame, "session.compacted", session));
  daemon.broadcast("turn/completed", { threadId: session, turn: { id: turnId, items: [], itemsView: "summary", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } });
  assert.equal((await completed(session, start)).payload.status, "complete");
});

test("a desk turn whose start came before the connection to Codex dropped, and whose end comes as the bridge reads the thread again, is still told", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  start = client.frames.length;
  const turnId = "desk-ends-during-read";
  daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const resumes = daemon.callsOf("thread/resume").length;
  daemon.accepting = false;
  daemon.dropAll();
  const user = { type: "userMessage", id: "u-ends", clientId: null, content: [{ type: "text", text: "Quick one.", text_elements: [] }] };
  daemon.broadcast("item/completed", { threadId: session, turnId, item: user, completedAtMs: 1 });
  let ended = false;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true || ended) return;
    ended = true;
    daemon.finishTurn(session, turnId, "Done quickly.");
  };
  daemon.accepting = true;
  try {
    await until(() => daemon.callsOf("thread/resume").length > resumes);
    const opened = await client.from(start, (frame) => isEvent(frame, "message.start", session));
    assert.deepEqual(opened.params.payload, { text: "Quick one.", sender: "desk" });
    assert.equal((await completed(session, start)).payload.text, "Done quickly.");
  } finally {
    daemon.onRead = () => {};
  }
});

/** A desk turn's start and message, told to the daemon: it runs until `daemon.finishTurn`. */
function deskTurnBegun(session: string, turnId: string, text: string): void {
  const user = { type: "userMessage", id: `u-${turnId}`, clientId: null, content: [{ type: "text", text, text_elements: [] }] };
  daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: user, completedAtMs: 1 });
}

/** The connection of the bridge's last read of the thread with its turns. */
function lastRead(session: string): DaemonConnection {
  return daemon.callsOf("thread/read").findLast((call) => call.params.threadId === session && call.params.includeTurns === true)!.connection;
}

/** Once the bridge has had all that was sent to it on `connection` so far: a ping goes after it, and the pong comes back once the bridge has read up to it. */
function reached(connection: DaemonConnection): Promise<void> {
  return new Promise((resolve) => {
    connection.socket.once("pong", () => resolve());
    connection.socket.ping();
  });
}

/** The messages that opened the thread's turns from `start` on, in the order they were told. */
function openers(session: string, start: number): unknown[] {
  return turnEvents(session, start).filter((event) => event.type === "message.start").map((event) => event.payload?.text);
}

test("a desk turn missed while the connection to Codex was down shows before one begun and ended at the desk as the bridge reads the thread again", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  deskTurn(session, "desk-missed", "Missed while away.");
  let told = false;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true || told) return;
    told = true;
    deskTurn(session, "desk-during-read", "Typed as the bridge came back.");
  };
  daemon.accepting = true;
  try {
    await until(() => daemon.callsOf("thread/resume").length > resumes);
    await until(() => turnEvents(session, start).filter((event) => event.type === "message.complete").length >= 2);
    assert.deepEqual(openers(session, start), ["Missed while away.", "Typed as the bridge came back."]);
    const stored = (await client.call("session.resume", { session_id: session })).messages.map((message: Frame) => [message.role, message.text]);
    assert.deepEqual(stored.slice(-4), [
      ["user", "Missed while away."],
      ["assistant", "Done at the desk."],
      ["user", "Typed as the bridge came back."],
      ["assistant", "Done at the desk."],
    ]);
  } finally {
    daemon.onRead = () => {};
  }
});

test("a desk turn missed while the connection to Codex was down shows before one begun at the desk as the bridge reads the thread again, which is then followed", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  deskTurn(session, "desk-missed-2", "Missed while away.");
  let begun = false;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true || begun) return;
    begun = true;
    deskTurnBegun(session, "desk-begun-during-read", "Still going.");
  };
  daemon.accepting = true;
  try {
    await until(() => daemon.callsOf("thread/resume").length > resumes);
    await until(() => openers(session, start).length >= 2);
    assert.deepEqual(openers(session, start), ["Missed while away.", "Still going."]);
    assert.deepEqual((await client.call("sessions.activity")).sessions.filter((entry: Frame) => entry.session_id === session), [{ session_id: session, state: "running" }]);
    daemon.finishTurn(session, "desk-begun-during-read", "Finished at the desk.");
    await until(() => turnEvents(session, start).filter((event) => event.type === "message.complete").length >= 2);
    const ends = turnEvents(session, start).filter((event) => event.type === "message.complete").map((event) => event.payload.text);
    assert.deepEqual(ends, ["Done at the desk.", "Finished at the desk."]);
    assert.deepEqual(openers(session, start), ["Missed while away.", "Still going."]);
  } finally {
    daemon.onRead = () => {};
  }
});

test("a message sent from the app as the bridge, back on its connection to Codex, reads the thread again waits on the list until it has, then has its turn, told to its end", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  let reply: Promise<Frame> | null = null;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true || reply) return;
    reply = client.call("prompt.submit", { session_id: session, text: "Sent as you came back.", profile: "codex" });
  };
  daemon.accepting = true;
  try {
    await until(() => daemon.callsOf("thread/resume").length > resumes);
    await until(() => reply !== null);
    assert.equal((await reply!).status, "queued");
    daemon.finishTurn(session, await daemon.activeTurn(session), "Answered at once.");
    assert.equal((await completed(session, start)).payload.text, "Answered at once.");
    assert.deepEqual(openers(session, start), ["Sent as you came back."]);
    assert.deepEqual((await client.call("sessions.activity")).sessions.filter((entry: Frame) => entry.session_id === session), []);
  } finally {
    daemon.onRead = () => {};
  }
});

test("a desk turn missed while the connection to Codex was down shows before a message the app sent as the bridge read the thread again, which waits for it", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  deskTurn(session, "desk-missed-3", "Missed while away.");
  let reply: Promise<Frame> | null = null;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true || reply) return;
    reply = client.call("prompt.submit", { session_id: session, text: "Sent as you came back.", profile: "codex" });
  };
  daemon.accepting = true;
  try {
    await until(() => daemon.callsOf("thread/resume").length > resumes);
    await until(() => reply !== null);
    assert.equal((await reply!).status, "queued");
    daemon.onRead = () => {};
    daemon.finishTurn(session, await daemon.activeTurn(session), "Answered.");
    await until(() => turnEvents(session, start).filter((event) => event.type === "message.complete").length >= 2);
    // In the thread's order: the missed one, then the app's, whose answer is the latest.
    assert.deepEqual(openers(session, start), ["Missed while away.", "Sent as you came back."]);
    const stored = (await client.call("session.resume", { session_id: session })).messages.map((message: Frame) => [message.role, message.text]);
    assert.deepEqual(stored.slice(-4), [
      ["user", "Missed while away."],
      ["assistant", "Done at the desk."],
      ["user", "Sent as you came back."],
      ["assistant", "Answered."],
    ]);
    assert.equal((await client.call("thread.wait", { thread: session })).reply, "Answered.");
    // Told once: the next reconnect has nothing more to tell.
    const again = client.frames.length;
    const resumed = daemon.callsOf("thread/resume").length;
    daemon.dropAll();
    await until(() => daemon.callsOf("thread/resume").length > resumed);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(openers(session, again), []);
  } finally {
    daemon.onRead = () => {};
  }
});

test("two desk turns missed while the connection to Codex was down both show before a message the app sent as the bridge read the thread again", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  deskTurn(session, "desk-missed-6", "Missed first.");
  deskTurn(session, "desk-missed-7", "Missed second.");
  let reply: Promise<Frame> | null = null;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true || reply) return;
    reply = client.call("prompt.submit", { session_id: session, text: "Sent as you came back.", profile: "codex" });
  };
  daemon.accepting = true;
  try {
    await until(() => daemon.callsOf("thread/resume").length > resumes);
    await until(() => reply !== null);
    assert.equal((await reply!).status, "queued");
    daemon.onRead = () => {};
    daemon.finishTurn(session, await daemon.activeTurn(session), "Answered.");
    await until(() => turnEvents(session, start).filter((event) => event.type === "message.complete").length >= 3);
    assert.deepEqual(openers(session, start), ["Missed first.", "Missed second.", "Sent as you came back."]);
  } finally {
    daemon.onRead = () => {};
  }
});

test("a message sent through the fleet with a wait as the bridge, back on its connection to Codex, reads the thread again is answered with its own turn's reply", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session), "The first answer.");
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  deskTurn(session, "desk-missed-8", "Missed while away.");
  let waited: Promise<Frame> | null = null;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true || waited) return;
    waited = client.call("thread.send", { thread: session, text: "Check the build.", wait: true, timeout_ms: 10_000 });
  };
  daemon.accepting = true;
  try {
    await until(() => daemon.callsOf("thread/resume").length > resumes);
    await until(() => waited !== null);
    daemon.onRead = () => {};
    let answered = false;
    void waited!.then(() => (answered = true));
    await until(() => openers(session, start).length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Still working: its own turn has not ended.
    assert.equal(answered, false);
    daemon.finishTurn(session, await daemon.activeTurn(session), "The build passes.");
    const result = await waited!;
    assert.equal(result.reply, "The build passes.");
    assert.equal(result.timed_out, false);
  } finally {
    daemon.onRead = () => {};
  }
});

test("a wait on a thread whose only message waiting (behind the bridge catching up with Codex) is taken off its list answers once the thread is at rest", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session), "The first answer.");
  await completed(session, start);
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reading = false;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true) return;
    reading = true;
    return gate;
  };
  daemon.accepting = true;
  try {
    await until(() => reading);
    const waited = client.call("thread.send", { thread: session, text: "Check the build.", wait: true, timeout_ms: 10_000 });
    let answered = false;
    void waited.then(
      () => (answered = true),
      () => undefined,
    );
    const listed = await client.from(start, (frame) => isEvent(frame, "queue.changed", session) && frame.params.payload.queued.length === 1);
    const queueID = listed.params.payload.queued[0].id;
    assert.deepEqual(await client.call("prompt.queue.remove", { session_id: session, queue_id: queueID }), { removed: true });
    release();
    daemon.onRead = () => {};
    const began = Date.now();
    const result = await waited;
    assert.ok(Date.now() - began < 2_000, "answered at once, not when its time was up");
    assert.equal(result.timed_out, false);
    assert.equal(result.state, "idle");
    assert.equal(answered, true);
  } finally {
    release();
    daemon.onRead = () => {};
  }
});

test("a reconnect whose connection to Codex drops again before it reads the thread leaves the next one to tell what was missed, before a message the app sends meanwhile", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  deskTurn(session, "desk-missed-9", "Missed while away.");
  // The first reconnect loses its connection as it asks which threads Codex has.
  let dropped = false;
  daemon.onLoaded = () => {
    if (dropped) return;
    dropped = true;
    daemon.accepting = false;
    daemon.dropAll();
  };
  daemon.accepting = true;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reading = false;
  try {
    await until(() => dropped);
    await new Promise((resolve) => setTimeout(resolve, 30));
    daemon.onLoaded = () => {};
    daemon.onRead = (params) => {
      if (params.threadId !== session || params.includeTurns !== true) return;
      reading = true;
      return gate;
    };
    daemon.accepting = true;
    await until(() => reading);
    const reply = await client.call("prompt.submit", { session_id: session, text: "Sent as you came back.", profile: "codex" });
    assert.equal(reply.status, "queued");
    release();
    daemon.onRead = () => {};
    daemon.finishTurn(session, await daemon.activeTurn(session), "Answered.");
    await until(() => turnEvents(session, start).filter((event) => event.type === "message.complete").length >= 2);
    assert.deepEqual(openers(session, start), ["Missed while away.", "Sent as you came back."]);
  } finally {
    release();
    daemon.onLoaded = () => {};
    daemon.onRead = () => {};
  }
});

// MARK: Codex not reachable

/**
 * A bridge of its own, on the same daemon, whose calls wait `readyMs` for Codex: a message
 * sent at rest while the connection to Codex is down waits that long before it fails.
 */
async function quickBridge(t: { after(fn: () => Promise<void>): void }, readyMs: number): Promise<TestClient> {
  const provider = new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images },
    connect: socketConnector(daemon.socketPath),
    checkVersion: false,
    configPath: join(daemon.folder, "config.toml"),
    timeZone: "UTC",
    backoff: [0.05, 0.1],
    readyMs,
  });
  const own = await startTestBridge({ providers: new Map([["codex", provider]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  t.after(async () => {
    daemon.accepting = true;
    daemon.onRead = () => {};
    await phone.close();
    await own.dispose();
  });
  return phone;
}

/** A thread on `phone`'s bridge with one turn done. */
async function threadWithATurn(phone: TestClient): Promise<string> {
  const session = (await phone.call("session.create", { profile: "codex", cwd })).session_id as string;
  const start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "First.", profile: "codex" });
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await phone.from(start, (frame) => isEvent(frame, "message.complete", session));
  return session;
}

const notSent = "Codex is not reachable right now. The message was not sent.";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const startsOf = (session: string) => daemon.callsOf("turn/start").filter((call) => call.params.threadId === session).length;

test("a message sent to a Codex thread at rest while the connection to Codex stays down fails once a call would give up on Codex, as a turn of its own, with those behind it; a wait through the fleet answers with why; neither is sent once Codex is back", async (t) => {
  const phone = await quickBridge(t, 300);
  const session = await threadWithATurn(phone);
  const start = phone.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  // The bridge hears of the drop.
  await pause(50);
  const sent = await phone.call("prompt.submit", { session_id: session, text: "Sent while away.", profile: "codex", message_id: "m-away" });
  assert.equal(sent.status, "queued");
  const waited = phone.call("thread.send", { thread: session, text: "Check the build.", wait: true, timeout_ms: 10_000 });
  const result = await waited;
  assert.deepEqual({ status: result.status, state: result.state, reply: result.reply, timed_out: result.timed_out }, { status: "queued", state: "error", reply: notSent, timed_out: false });
  const fleetText = "[Portals: from the command line]\nCheck the build.";
  assert.deepEqual(
    // Without which turn each was (`turn`, net-20): revisions.
    turnEvents(session, start, phone).filter((event) => ["message.start", "message.complete", "queue.changed"].includes(event.type)).map((event) => {
      const { turn: _turn, ...payload } = event.payload;
      return [event.type, payload];
    }),
    [
      ["queue.changed", { queued: [{ id: sent.queue_id, text: "Sent while away.", message_id: "m-away" }], can_steer: true }],
      ["queue.changed", { queued: [{ id: sent.queue_id, text: "Sent while away.", message_id: "m-away" }, { id: result.queue_id ?? "2", text: fleetText, fleet: true, from: {} }], can_steer: true }],
      ["message.start", { text: "Sent while away.", sender: "user", message_id: "m-away", queue_id: sent.queue_id }],
      ["message.complete", { status: "error", text: notSent, error_surface: { retryable: true } }],
      ["queue.changed", { queued: [{ id: result.queue_id ?? "2", text: fleetText, fleet: true, from: {} }], can_steer: true }],
      ["message.start", { opened_by: "portals", text: fleetText, sender: "portals", from: {}, queue_id: result.queue_id ?? "2" }],
      ["message.complete", { status: "error", text: notSent, error_surface: { retryable: true } }],
      ["queue.changed", { queued: [], can_steer: true }],
    ],
  );
  // Back: neither is sent behind anyone's back.
  const resumes = daemon.callsOf("thread/resume").length;
  daemon.accepting = true;
  await until(() => daemon.callsOf("thread/resume").length > resumes);
  await pause(150);
  assert.equal(startsOf(session), 1);
  const stored = (await phone.call("session.resume", { session_id: session })).messages.map((message: Frame) => [message.role, message.text, message.display_kind]);
  assert.deepEqual(stored.slice(-4), [
    ["user", "Sent while away.", undefined],
    ["assistant", notSent, "failed_turn"],
    ["user", fleetText, undefined],
    ["assistant", notSent, "failed_turn"],
  ]);
  // Try again: it goes.
  const again = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "Sent while away.", profile: "codex" });
  await until(() => startsOf(session) === 2);
  daemon.finishTurn(session, await daemon.activeTurn(session), "Here now.");
  assert.equal((await phone.from(again, (frame) => isEvent(frame, "message.complete", session))).params.payload.text, "Here now.");
});

test("a message sent as the bridge, back on its connection to Codex, reads the thread for longer than a call waits for Codex goes once the read is done", async (t) => {
  const phone = await quickBridge(t, 200);
  const session = await threadWithATurn(phone);
  const start = phone.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reading = false;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true) return;
    reading = true;
    return gate;
  };
  try {
    await pause(50);
    daemon.accepting = true;
    await until(() => reading);
    assert.equal((await phone.call("prompt.submit", { session_id: session, text: "Sent as you came back.", profile: "codex" })).status, "queued");
    // Codex answers, slowly: the message is not failed for that.
    await pause(400);
    assert.equal(turnEvents(session, start, phone).some((event) => event.type === "message.complete"), false);
    release();
    daemon.onRead = () => {};
    await until(() => startsOf(session) === 2);
    daemon.finishTurn(session, await daemon.activeTurn(session), "Answered.");
    const done = await phone.from(start, (frame) => isEvent(frame, "message.complete", session));
    assert.deepEqual([done.params.payload.status, done.params.payload.text], ["complete", "Answered."]);
  } finally {
    release();
    daemon.onRead = () => {};
  }
});

test("a message sent as the bridge, back on its connection to Codex, reads the thread fails at once when the connection drops again after a call would have given up on Codex", async (t) => {
  const phone = await quickBridge(t, 200);
  const session = await threadWithATurn(phone);
  daemon.accepting = false;
  daemon.dropAll();
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reading = false;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true) return;
    reading = true;
    return gate;
  };
  try {
    await pause(50);
    daemon.accepting = true;
    await until(() => reading);
    assert.equal((await phone.call("prompt.submit", { session_id: session, text: "Sent as you came back.", profile: "codex" })).status, "queued");
    await pause(400);
    const from = phone.frames.length;
    daemon.accepting = false;
    daemon.dropAll();
    const failed = await phone.from(from, (frame) => isEvent(frame, "message.complete", session), 1000);
    assert.deepEqual([failed.params.payload.status, failed.params.payload.text], ["error", notSent]);
    release();
    daemon.onRead = () => {};
    const resumes = daemon.callsOf("thread/resume").length;
    daemon.accepting = true;
    await until(() => daemon.callsOf("thread/resume").length > resumes);
    await pause(150);
    assert.equal(startsOf(session), 1);
  } finally {
    release();
    daemon.onRead = () => {};
  }
});

test("a message that failed while the connection to Codex was down still shows failed after the bridge restarts, and is not sent", async (t) => {
  const quick = () =>
    new CodexProvider({
      settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images },
      connect: socketConnector(daemon.socketPath),
      checkVersion: false,
      configPath: join(daemon.folder, "config.toml"),
      timeZone: "UTC",
      backoff: [0.05, 0.1],
      readyMs: 200,
    });
  let own = await startTestBridge({ providers: new Map([["codex", quick()]]), config: { generalFolder: cwd }, keepHome: true });
  const home = own.home;
  let phone = await TestClient.open(own);
  t.after(async () => {
    daemon.accepting = true;
    await phone.close();
    await own.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  const session = await threadWithATurn(phone);
  const start = phone.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  await pause(50);
  assert.equal((await phone.call("prompt.submit", { session_id: session, text: "Sent while away.", profile: "codex" })).status, "queued");
  await phone.from(start, (frame) => isEvent(frame, "message.complete", session) && frame.params.payload.status === "error");
  // The bridge restarts, and Codex is back.
  await phone.close();
  await own.dispose();
  daemon.accepting = true;
  own = await startTestBridge({ providers: new Map([["codex", quick()]]), home, keepHome: true });
  phone = await TestClient.open(own);
  const stored = (await phone.call("session.resume", { session_id: session })).messages.map((message: Frame) => [message.role, message.text, message.display_kind]);
  assert.deepEqual(stored.slice(-2), [
    ["user", "Sent while away.", undefined],
    ["assistant", notSent, "failed_turn"],
  ]);
  await pause(150);
  assert.equal(startsOf(session), 1);
});

test("a message that failed while the connection to Codex was down comes back after a restart where it showed, by Codex's turn ids, before a desk turn with the same words told after it", async (t) => {
  const quick = () =>
    new CodexProvider({
      settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images },
      connect: socketConnector(daemon.socketPath),
      checkVersion: false,
      configPath: join(daemon.folder, "config.toml"),
      timeZone: "UTC",
      backoff: [0.05, 0.1],
      readyMs: 200,
    });
  let own = await startTestBridge({ providers: new Map([["codex", quick()]]), config: { generalFolder: cwd }, keepHome: true });
  const home = own.home;
  let phone = await TestClient.open(own);
  t.after(async () => {
    daemon.accepting = true;
    await phone.close();
    await own.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  const session = (await phone.call("session.create", { profile: "codex", cwd })).session_id as string;
  let start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "Continue", profile: "codex" });
  const first = await daemon.activeTurn(session);
  // Kept with the turn, as Codex keeps a message: the thread then has those words twice.
  const said = { type: "userMessage", id: "u-first", clientId: null, content: [{ type: "text", text: "Continue", text_elements: [] }] };
  daemon.broadcast("item/completed", { threadId: session, turnId: first, item: said, completedAtMs: 1 });
  daemon.finishTurn(session, first, "Earlier reply");
  await phone.from(start, (frame) => isEvent(frame, "message.complete", session));
  start = phone.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  await pause(50);
  // Typed at the desk while the bridge is away, just after the first, with the same words.
  deskTurn(session, "desk-continue", "Continue");
  assert.equal((await phone.call("prompt.submit", { session_id: session, text: "Review this receipt", profile: "codex" })).status, "queued");
  await phone.from(start, (frame) => isEvent(frame, "message.complete", session) && frame.params.payload.status === "error");
  daemon.accepting = true;
  await until(() => turnEvents(session, start, phone).filter((event) => event.type === "message.complete").length === 2);
  const shown = (await phone.call("session.resume", { session_id: session })).messages.map((message: Frame) => [message.role, message.text]);
  assert.deepEqual(shown.slice(-6), [
    ["user", "Continue"],
    ["assistant", "Earlier reply"],
    ["user", "Review this receipt"],
    ["assistant", notSent],
    ["user", "Continue"],
    ["assistant", "Done at the desk."],
  ]);
  // The bridge restarts: the thread reads as it showed.
  await phone.close();
  await own.dispose();
  own = await startTestBridge({ providers: new Map([["codex", quick()]]), home, keepHome: true });
  phone = await TestClient.open(own);
  const stored = (await phone.call("session.resume", { session_id: session })).messages.map((message: Frame) => [message.role, message.text]);
  assert.deepEqual(stored.slice(-6), shown.slice(-6));
});

test("a message that fails while the bridge reads the thread again for a missed desk turn it has not shown yet is kept after the turn shown last, so it comes back where it showed", async () => {
  const root = mkdtempSync(join(tmpdir(), "portals-shown-"));
  const pauseFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const said = (text: string) => ({ type: "userMessage", id: text, content: [{ type: "text", text, text_elements: [] }] });
  const turn = (id: string, text: string, at: number, status = "completed") => ({
    id, rootTurnId: null, status, error: null, startedAt: at, completedAt: status === "inProgress" ? null : at + 1, itemsView: "full",
    items: [said(text), ...(status === "inProgress" ? [] : [{ type: "agentMessage", id: `a-${id}`, text: `${text} reply` }])],
  });
  const base = Math.floor(Date.now() / 1000) - 30;
  const known = turn("p", "Known turn", base);
  const desk = turn("d", "Recovered desk turn", base + 5);
  const stale = { ...desk, status: "inProgress", completedAt: null };
  let phase = "initial";
  let staleReads = 0;
  let heldRead: unknown = null;
  let allowReconnect = true;
  let releaseConnect: () => void = () => {};
  const connections: { handlers: { message(message: unknown): void; closed(reason: string): void } }[] = [];
  let codex: CodexSession | undefined;
  let flow: Promise<void> | undefined;
  // Codex over a connection of the test's own: what it answers, and when it drops.
  const client = new CodexClient({
    clientInfo: { name: "scratch", title: "scratch", version: "1" },
    readyMs: 50,
    timeoutMs: 3000,
    backoff: [0.005],
    connect: async (handlers) => {
      if (!allowReconnect) await new Promise<void>((resolve) => (releaseConnect = resolve));
      connections.push({ handlers });
      return {
        close() {},
        send(message) {
          if (message.id === undefined) return;
          const answer = (result: unknown) => queueMicrotask(() => handlers.message({ id: message.id, result }));
          if (message.method === "initialize") return answer({});
          if (message.method === "thread/resume") return answer({ thread: { turns: [] } });
          if (message.method === "thread/read") {
            if (phase === "initial") return answer({ thread: { status: { type: "idle" }, turns: [known] } });
            if (phase === "stale") {
              // Read again because its end was heard while it was being read: held.
              if (++staleReads === 1) return answer({ thread: { status: { type: "active", activeFlags: [] }, turns: [known, stale] } });
              heldRead = message.id;
              return;
            }
            return answer({ thread: { status: { type: "idle" }, turns: [known, desk] } });
          }
          throw new Error(`unexpected ${message.method}`);
        },
      };
    },
  });
  client.listen({
    notification: (method, params) => codex?.notification(method, params),
    request() {},
    connected(again) {
      if (again) flow = codex!.reconnected(Promise.resolve(new Set(["t"])));
    },
    disconnected() {
      codex?.connectionLost();
    },
  });
  const host = { client, readyMs: 50, defaults: () => null, defaultsFor: async () => null, efforts: () => [], imagesDir: join(root, "images"), interruptGraceMs: 100, forget() {}, nameThread() {} };
  const options = { id: "t", cwd: root, title: "Title", settings: { model: "m", provider: "p", reasoningEffort: "" } };
  const record = () => ({ id: "t", agent: "codex", cwd: root, title: "Title", model: "m", provider: "p", reasoningEffort: "", createdAt: 0, updatedAt: 0, origin: "phone" as const });
  const waiting = new WaitingStore(join(root, "waiting"));
  const thread = new Session(record(), { has: () => false } as never, { waiting });
  const users = (session: Session) => session.messages.filter((message) => message.role === "user").map((message) => (message.role === "user" ? message.text : ""));
  try {
    await client.start();
    codex = new CodexSession(options as never, thread.sink, host as never, { applied: null, subscribed: false });
    await codex.load();
    await thread.attach(codex);
    // A desk turn's end is heard before anything else of it; the bridge's read finds it still running.
    connections.at(-1)!.handlers.message({ method: "turn/completed", params: { threadId: "t", turn: { id: "d", status: "completed", items: [], error: null } } });
    phase = "stale";
    connections.at(-1)!.handlers.closed("first drop");
    assert.equal(thread.submit("Offline phone message").status, "queued");
    await until(() => heldRead !== null);
    assert.deepEqual(users(thread), ["Known turn"]);
    // Its 15 seconds (here 50 ms) pass while that read is held; then the connection drops again.
    await pauseFor(80);
    assert.equal(thread.queuedMessages().length, 1);
    allowReconnect = false;
    connections.at(-1)!.handlers.closed("second drop during the read");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const kept = waiting.readFailed("t");
    assert.equal(kept.length, 1);
    // The desk turn had not shown: the failure is kept after the one that had.
    assert.equal(kept[0].turn, "p");
    phase = "complete";
    allowReconnect = true;
    releaseConnect();
    await until(() => users(thread).includes("Recovered desk turn"));
    await flow;
    assert.deepEqual(users(thread), ["Known turn", "Offline phone message", "Recovered desk turn"]);
    await thread.close();
    const again = new Session(record(), { has: () => false } as never, { waiting });
    const fresh = new CodexSession(options as never, again.sink, host as never, { applied: null, subscribed: false });
    await fresh.load();
    await again.attach(fresh);
    assert.deepEqual(users(again), ["Known turn", "Offline phone message", "Recovered desk turn"]);
    await again.close();
  } finally {
    client.close();
    await codex?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a desk turn missed while the connection to Codex was down is not told after one begun at the desk as the bridge failed to read the thread again, which would make it the latest", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  deskTurn(session, "desk-missed-4", "Missed while away.");
  let failed = false;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true || failed) return;
    failed = true;
    deskTurnBegun(session, "desk-during-failed-read", "Typed as the read failed.");
    throw new Error("Codex is busy");
  };
  daemon.accepting = true;
  try {
    await until(() => daemon.callsOf("thread/resume").length > resumes);
    await until(() => openers(session, start).length >= 1);
    daemon.finishTurn(session, "desk-during-failed-read", "Done then.");
    await until(() => turnEvents(session, start).some((event) => event.type === "message.complete"));
    // And at the next reconnect neither: the turn at the desk stays the latest.
    const resumed = daemon.callsOf("thread/resume").length;
    daemon.dropAll();
    await until(() => daemon.callsOf("thread/resume").length > resumed);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(openers(session, start), ["Typed as the read failed."]);
    assert.equal((await client.call("thread.wait", { thread: session })).reply, "Done then.");
  } finally {
    daemon.onRead = () => {};
  }
});

test("a desk turn missed in one drop of the connection to Codex, whose reading failed as another began at the desk, is told before that one when it is told in a later drop", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  deskTurn(session, "desk-missed-5", "Missed in the first drop.");
  let failed = false;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true || failed) return;
    failed = true;
    // Begun at the desk, its message still to come.
    daemon.broadcast("turn/started", { threadId: session, turn: { id: "desk-across-drops", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
    throw new Error("Codex is busy");
  };
  daemon.accepting = true;
  try {
    // However late the bridge reads (under load), it is that read that fails: had the
    // read come after a fixed wait, it would have found no such turn begun, as the
    // stand-in's thread has a turn only once its start is told.
    await until(() => failed);
    // The turn's start and the failed read's answer have reached the bridge before the next drop.
    await reached(lastRead(session));
    daemon.onRead = () => {};
    // The second drop: the turn's message and its end come while the bridge is away.
    const resumes = daemon.callsOf("thread/resume").length;
    daemon.accepting = false;
    daemon.dropAll();
    const user = { type: "userMessage", id: "u-across", clientId: null, content: [{ type: "text", text: "Begun across the drops.", text_elements: [] }] };
    daemon.broadcast("item/completed", { threadId: session, turnId: "desk-across-drops", item: user, completedAtMs: 1 });
    daemon.finishTurn(session, "desk-across-drops", "Done across.");
    daemon.accepting = true;
    await until(() => daemon.callsOf("thread/resume").length > resumes);
    await until(() => openers(session, start).length >= 2);
    assert.deepEqual(openers(session, start), ["Missed in the first drop.", "Begun across the drops."]);
  } finally {
    daemon.onRead = () => {};
  }
});

test("a sub-agent a desk turn spawned as the bridge read the thread again, after the connection to Codex was down, is listed and keeps the thread at work", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "First.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  const child = daemon.addThread(cwd, [{ id: "child-at-work", items: [], status: "inProgress", error: null }], { loaded: true, status: { type: "active", activeFlags: [] }, parentThreadId: session });
  let spawned = false;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true || spawned) return;
    spawned = true;
    deskTurnBegun(session, "desk-spawns", "Check in the background.");
    const item = { type: "subAgentActivity", id: "spawn-during-read", kind: "started", agentThreadId: child, agentPath: "/root/checker", model: "gpt-6.1-sol" };
    daemon.broadcast("item/started", { threadId: session, turnId: "desk-spawns", item });
    daemon.broadcast("item/completed", { threadId: session, turnId: "desk-spawns", item });
    daemon.finishTurn(session, "desk-spawns", "The checker is at work.");
  };
  daemon.accepting = true;
  try {
    await until(() => daemon.callsOf("thread/resume").length > resumes);
    await until(() => turnEvents(session, start).some((event) => event.type === "message.complete"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const listed = (await client.call("subagent.list", { session_id: session })).subagents;
    assert.deepEqual(listed.map((entry: Frame) => entry.status), ["running"]);
    assert.equal((await client.call("sessions.activity")).sessions.some((entry: Frame) => entry.session_id === session), true);
  } finally {
    daemon.onRead = () => {};
  }
});

test("a plan Codex proposed while the bridge was away, which a turn at the desk has since carried out, is not put as a card when the bridge catches up", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  await send(session, "Plan it.");
  const turnId = await daemon.activeTurn(session);
  daemon.accepting = false;
  daemon.dropAll();
  daemon.broadcast("item/completed", { threadId: session, turnId, item: { type: "plan", id: "plan-gap", text: "1. Do it.\n" }, completedAtMs: 2 });
  daemon.finishTurn(session, turnId, "");
  deskTurn(session, "desk-after-gap-plan", "Did it myself.");
  daemon.accepting = true;
  assert.equal((await completed(session, start)).payload.status, "complete");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.frames.slice(start).some((frame) => frame.method === "approval" && frame.params.session_id === session), false);
});

test("Start given while the connection to Codex is down, after a turn at the desk carried the plan out, carries nothing out once Codex is back", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  daemon.scripts.push("plan");
  await send(session, "Plan how to change hi to hello in hello.txt.");
  const card = await client.from(start, (frame) => frame.method === "approval" && frame.params.session_id === session);
  const from = daemon.calls.length;
  daemon.accepting = false;
  daemon.dropAll();
  deskTurn(session, "desk-before-start", "Did it myself.");
  await new Promise((resolve) => setTimeout(resolve, 30));
  client.answer(card.id, { choice: "once" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  daemon.accepting = true;
  assert.equal((await completed(session, start)).payload.status, "complete");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(daemon.calls.slice(from).some((call) => call.method === "turn/start"), false);
  assert.match((await client.call("slash.exec", { session_id: session, command: "mode" })).output, /^Mode: plan\./);
});

test("Start given while the bridge, back, checks whether a turn at the desk left the plan behind carries nothing out when one did", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  daemon.scripts.push("plan");
  await send(session, "Plan how to change hi to hello in hello.txt.");
  const card = await client.from(start, (frame) => frame.method === "approval" && frame.params.session_id === session);
  const from = daemon.calls.length;
  daemon.accepting = false;
  daemon.dropAll();
  deskTurn(session, "desk-before-check", "Did it myself.");
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let reading = false;
  daemon.onRead = (params) => {
    if (params.threadId !== session || params.includeTurns !== true) return;
    reading = true;
    return held;
  };
  daemon.accepting = true;
  try {
    await until(() => reading);
    client.answer(card.id, { choice: "once" });
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    daemon.onRead = () => {};
    release();
  }
  assert.equal((await completed(session, start)).payload.status, "complete");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(daemon.calls.slice(from).some((call) => call.method === "turn/start"), false);
  // The app's turn, closed with its card, then the desk's, which shows as a turn of its own.
  assert.deepEqual(
    turnEvents(session, start).filter((event) => event.type === "message.complete").map((event) => event.payload.text),
    ["", "Done at the desk."],
  );
});

test("Start on a plan card that was open while the connection to Codex was down carries nothing out when Codex cannot say whether the thread went on", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  daemon.scripts.push("plan");
  await send(session, "Plan how to change hi to hello in hello.txt.");
  const card = await client.from(start, (frame) => frame.method === "approval" && frame.params.session_id === session);
  const resumes = daemon.callsOf("thread/resume").length;
  daemon.accepting = false;
  daemon.dropAll();
  deskTurn(session, "desk-unknown", "Did it myself.");
  daemon.onRead = (params) => {
    if (params.threadId === session && params.includeTurns === true) throw new Error("Codex is busy");
  };
  daemon.accepting = true;
  try {
    await until(() => daemon.callsOf("thread/resume").length > resumes);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const from = daemon.calls.length;
    client.answer(card.id, { choice: "once" });
    const done = await completed(session, start);
    assert.equal(done.payload.status, "error");
    assert.match(done.payload.text, /^Codex could not say whether the thread has gone on without the plan/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(daemon.calls.slice(from).some((call) => call.method === "turn/start"), false);
  } finally {
    daemon.onRead = () => {};
  }
});

test("Stop right behind Start on a plan card that was open while Codex was away ends the turn at once, while the bridge still checks the thread", async () => {
  const session = await createThread();
  await client.call("slash.exec", { session_id: session, command: "mode plan" });
  const start = client.frames.length;
  daemon.scripts.push("plan");
  await send(session, "Plan how to change hi to hello in hello.txt.");
  const card = await client.from(start, (frame) => frame.method === "approval" && frame.params.session_id === session);
  const resumes = daemon.callsOf("thread/resume").length;
  daemon.accepting = false;
  daemon.dropAll();
  daemon.accepting = true;
  await until(() => daemon.callsOf("thread/resume").length > resumes);
  await new Promise((resolve) => setTimeout(resolve, 50));
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  daemon.onRead = (params) => (params.threadId === session && params.includeTurns === true ? held : undefined);
  const from = daemon.calls.length;
  try {
    client.answer(card.id, { choice: "once" });
    await daemon.waitForCall((call) => call.method === "thread/read" && call.params.threadId === session, from);
    assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
    // Before Codex has answered the check.
    assert.equal((await completed(session, start)).payload.status, "interrupted");
  } finally {
    daemon.onRead = () => {};
    release();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(turnEvents(session, start).filter((event) => event.type === "message.complete").length, 1);
  assert.equal(daemon.calls.slice(from).some((call) => call.method === "turn/start"), false);
});

test("a plan-mode turn that runs across a restart of the bridge, its question answered after it, still ends with a plan card", async () => {
  const first = await startTestBridge({ keepHome: true, providers: new Map([["codex", codexProvider()]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(first);
  const session = (await phone.call("session.create", { profile: "codex", cwd, title: "Plan job" })).session_id;
  await phone.call("slash.exec", { session_id: session, command: "mode plan" });
  await phone.call("prompt.submit", { session_id: session, text: "Plan it." });
  const turnId = await daemon.activeTurn(session);
  const user = { type: "userMessage", id: "u-plan", clientId: null, content: [{ type: "text", text: "Plan it.", text_elements: [] }] };
  daemon.broadcast("item/started", { threadId: session, turnId, item: user, startedAtMs: 1 });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: user, completedAtMs: 1 });
  const questions = [{ id: "scope", header: "Scope", question: "Only hello.txt?", isOther: false, isSecret: false, options: [{ label: "Yes", description: "Just that file." }] }];
  const asked = daemon.request(session, "item/tool/requestUserInput", { threadId: session, turnId, itemId: "ask-1", questions });
  await phone.nextRequest();
  await phone.close();
  await first.close();

  const second = await startTestBridge({ home: first.home, providers: new Map([["codex", codexProvider()]]) });
  const again = await TestClient.open(second);
  try {
    await until(() => daemon.callsOf("thread/resume").some((call) => call.params.threadId === session));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resumed = await again.call("session.resume", { session_id: session, profile: "codex", inline_images: false });
    assert.equal(resumed.running, true);
    assert.equal(resumed.open_requests[0].method, "clarify");
    const start = again.frames.length;
    again.answer(resumed.open_requests[0].id, { answers: { scope: "Yes" } });
    assert.deepEqual((await asked).result, { answers: { scope: { answers: ["Yes"] } } });
    const plan = { type: "plan", id: "plan-r", text: "1. Change hi to hello in hello.txt.\n" };
    daemon.broadcast("item/started", { threadId: session, turnId, item: { ...plan, text: "" }, startedAtMs: 2 });
    daemon.broadcast("item/completed", { threadId: session, turnId, item: plan, completedAtMs: 3 });
    daemon.finishTurn(session, turnId, "");
    const card = await again.nextRequest();
    assert.equal(card.method, "approval");
    assert.equal(card.params.plan, true);
    assert.equal(card.params.command, "1. Change hi to hello in hello.txt.");
    assert.equal(turnEvents(session, start, again).some((event) => event.type === "message.complete"), false);
    again.answer(card.id, { choice: "deny" });
    assert.equal((await completed(session, start, again)).payload.status, "complete");
  } finally {
    await again.close();
    await second.dispose();
  }
});


test("a plan-mode turn across a restart of the bridge, its thread's mode changed while it ran, still ends with a plan card, for that mode", async () => {
  const first = await startTestBridge({ keepHome: true, providers: new Map([["codex", codexProvider()]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(first);
  const session = (await phone.call("session.create", { profile: "codex", cwd, title: "Plan then full" })).session_id;
  await phone.call("slash.exec", { session_id: session, command: "mode plan" });
  await phone.call("prompt.submit", { session_id: session, text: "Plan it." });
  const turnId = await daemon.activeTurn(session);
  const user = { type: "userMessage", id: "u-plan-full", clientId: null, content: [{ type: "text", text: "Plan it.", text_elements: [] }] };
  daemon.broadcast("item/started", { threadId: session, turnId, item: user, startedAtMs: 1 });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: user, completedAtMs: 1 });
  // For the next turn; this one goes on in plan mode.
  await phone.call("slash.exec", { session_id: session, command: "mode full" });
  await phone.close();
  await first.close();

  const second = await startTestBridge({ home: first.home, providers: new Map([["codex", codexProvider()]]) });
  const again = await TestClient.open(second);
  try {
    await until(() => daemon.callsOf("thread/resume").some((call) => call.params.threadId === session));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resumed = await again.call("session.resume", { session_id: session, profile: "codex", inline_images: false });
    assert.equal(resumed.running, true);
    const start = again.frames.length;
    const plan = { type: "plan", id: "plan-f", text: "1. Change hi to hello.\n" };
    daemon.broadcast("item/completed", { threadId: session, turnId, item: plan, completedAtMs: 3 });
    daemon.finishTurn(session, turnId, "");
    const card = await again.from(start, (frame) => frame.method === "approval" && frame.params.session_id === session);
    assert.deepEqual([card.params.plan, card.params.starts_in], [true, "full"]);
    again.answer(card.id, { choice: "deny" });
    assert.equal((await completed(session, start, again)).payload.status, "complete");
  } finally {
    await again.close();
    await second.dispose();
  }
});

test("/mode default undoes another mode with what default comes to in the thread's folder, its own config.toml included; a thread in default all along keeps what Codex has", async () => {
  const saved = { approval_policy: daemon.config.approval_policy, sandbox_mode: daemon.config.sandbox_mode };
  // config.toml sets no policy and trusts the project; the folder's own .codex/config.toml only reads, and never asks.
  delete daemon.config.approval_policy;
  delete daemon.config.sandbox_mode;
  daemon.config.projects = { [cwd]: { trust_level: "trusted" } };
  daemon.folderConfigs.set(cwd, { sandbox_mode: "read-only", approval_policy: "never" });
  const own = await startTestBridge({ providers: new Map([["codex", codexProvider()]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  const turn = async (session: string, text: string) => {
    const start = phone.frames.length;
    const started = await send(session, text, phone);
    daemon.finishTurn(session, await daemon.activeTurn(session));
    await completed(session, start, phone);
    return started.params;
  };
  try {
    const session = await createThread({}, phone);
    // Codex has the folder's settings for it: nothing is overridden.
    let params = await turn(session, "Hello.");
    assert.equal(params.approvalPolicy, undefined);
    assert.equal(params.sandboxPolicy, undefined);
    await phone.call("slash.exec", { session_id: session, command: "mode edits" });
    params = await turn(session, "Go.");
    assert.deepEqual([params.approvalPolicy, params.sandboxPolicy.type], ["on-request", "workspaceWrite"]);
    await phone.call("slash.exec", { session_id: session, command: "mode default" });
    params = await turn(session, "Back.");
    assert.deepEqual([params.approvalPolicy, params.sandboxPolicy], ["never", { type: "readOnly", networkAccess: false }]);
    assert.deepEqual(daemon.callsOf("config/read").at(-1)!.params, { cwd });
    // Once: Codex keeps it for the thread.
    params = await turn(session, "Again.");
    assert.equal(params.sandboxPolicy, undefined);
  } finally {
    await phone.close();
    await own.dispose();
    Object.assign(daemon.config, saved);
    delete daemon.config.projects;
    daemon.folderConfigs.delete(cwd);
  }
});

test("a usage limit at 80% or more warns the thread at work, once", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Work.");
  const turnId = await daemon.activeTurn(session);
  const limits = (usedPercent: number) => ({
    rateLimits: { limitId: "codex", limitName: null, normalModelSlug: null, primary: { usedPercent, windowDurationMins: 10_080, resetsAt: 1_791_580_476 }, secondary: null, credits: null, individualLimit: null, spendControlReached: null, planType: "pro", rateLimitReachedType: null },
  });
  daemon.broadcast("account/rateLimits/updated", limits(20));
  daemon.broadcast("account/rateLimits/updated", limits(85));
  daemon.broadcast("account/rateLimits/updated", limits(86));
  daemon.finishTurn(session, turnId);
  await completed(session, start);
  const warnings = turnEvents(session, start).filter((event) => event.type === "status.update");
  assert.deepEqual(
    warnings.map((event) => event.payload),
    [{ kind: "warn", text: "You have used 85% of your weekly Codex limit; it resets Fri 9:14 PM." }],
  );
});

test("/usage says what Codex says of the account's limits now: Codex's own windows first, a model's own by its name", async () => {
  const session = await createThread();
  const catalog = await client.call("commands.catalog", { profile: "codex", session_id: session });
  assert.deepEqual(catalog.categories[0].pairs.map((pair: string[]) => pair[0]), ["/status", "/mode", "/usage"]);
  const usage = async () => (await client.call("slash.exec", { session_id: session, command: "usage", profile: "codex" })).output as string;
  const time = String.raw`\w{3} \d{1,2}:\d{2} [AP]M`;
  assert.match(
    await usage(),
    new RegExp(String.raw`^Codex usage, Plus plan:\n5-hour: 31% used, resets ${time}\nWeekly: 8% used, resets ${time}\nWeekly GPT-6\.1-Spark: used up, resets ${time}\nCredits left: 62,500\.$`),
  );
  assert.equal(daemon.callsOf("account/rateLimits/read").length, 1);
  // A Codex that knows one limit only, and an account with none.
  const kept = daemon.accountLimits;
  try {
    daemon.accountLimits = { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: null }, secondary: null, planType: null } };
    assert.equal(await usage(), "Codex usage:\n5-hour: 31% used");
    daemon.accountLimits = { rateLimits: { limitId: "codex", limitName: null, primary: null, secondary: null, planType: "prolite" }, rateLimitsByLimitId: null };
    assert.equal(await usage(), "Codex usage, Pro 100 plan:\nCodex says no limits apply to this account.");
  } finally {
    daemon.accountLimits = kept;
  }
});

test("model and thinking level go with the next turn; a change while a turn runs waits for it", async () => {
  const session = await createThread({ model: "gpt-6-luna", reasoning_effort: "ultra" });
  assert.equal(daemon.thread(session).model, "gpt-6-luna");
  // Luna's strongest level stands in for ultra.
  assert.equal((await client.call("session.resume", { session_id: session })).info.reasoning_effort, "max");
  let start = client.frames.length;
  let turn = await send(session, "Hello.");
  assert.equal(turn.params.model, undefined);
  assert.equal(turn.params.effort, "max");
  assert.deepEqual(await client.call("config.set", { session_id: session, key: "model", value: "gpt-6.1-sol --provider openai --session" }), { deferred: true });
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  assert.deepEqual(await client.call("config.set", { session_id: session, key: "reasoning", value: "minimal" }), {});
  assert.equal((await client.call("session.resume", { session_id: session })).info.reasoning_effort, "low");
  start = client.frames.length;
  turn = await send(session, "Again.");
  assert.equal(turn.params.model, "gpt-6.1-sol");
  assert.equal(turn.params.effort, "low");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  await assert.rejects(client.call("config.set", { session_id: session, key: "model", value: "claude-opus --session" }), (error: RpcFailure) => error.code === -32602);
});

test("images go to Codex as files in the bridge's folder, kept for the turn only; HEIC is left out with a notice", async () => {
  const session = await createThread();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  assert.equal((await client.call("image.attach_bytes", { session_id: session, content_base64: png.toString("base64"), filename: "shot.png" })).attached, true);
  assert.equal((await client.call("image.attach_bytes", { session_id: session, content_base64: Buffer.from("0000001866747970686569630000", "hex").toString("base64"), filename: "photo.heic" })).attached, true);
  const start = client.frames.length;
  const turn = await send(session, "What is this?");
  const [text, image] = turn.params.input;
  assert.deepEqual(text, { type: "text", text: "What is this?", text_elements: [] });
  assert.equal(image.type, "localImage");
  assert.equal(basename(image.path), "shot.png");
  assert.equal(dirname(dirname(image.path)), images);
  assert.deepEqual(readFileSync(image.path), png);
  assert.equal(turn.params.input.length, 2);
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  await until(() => !existsSync(dirname(image.path)));
  const notice = turnEvents(session, start).find((event) => event.type === "status.update");
  assert.deepEqual(notice.payload, { kind: "warn", text: "An image was left out: Codex reads JPEG, PNG, GIF and WebP images." });
  const stored = (await client.call("session.resume", { session_id: session })).messages;
  assert.equal(stored.at(-2).text, "What is this?\n@image:shot.png\n@image:photo.heic");
});

test("images a bridge that stopped mid-turn left for Codex are cleared when it starts again", async () => {
  const folder = mkdtempSync(join(tmpdir(), "portals-codex-images-"));
  // As a bridge killed mid-turn left it: each image in a folder of its own.
  mkdirSync(join(folder, "0d1f"));
  writeFileSync(join(folder, "0d1f", "shot.png"), "png");
  const own = await startTestBridge({ providers: new Map([["codex", codexProvider(folder)]]), config: { generalFolder: cwd } });
  try {
    await until(() => !existsSync(join(folder, "0d1f")));
  } finally {
    await own.dispose();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("requests the app has no card for are declined with a notice, or refused", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Go online.");
  const turnId = await daemon.activeTurn(session);
  await daemon.request(session, "item/permissions/requestApproval", { threadId: session, turnId, itemId: "p", reason: "needs the network", permissions: {} });
  await daemon.request(session, "mcpServer/elicitation/request", { threadId: session, turnId, serverName: "docs", message: "Sign in" });
  const refused = await daemon.request(session, "item/tool/call", { threadId: session, turnId, callId: "x", tool: "t", arguments: {} });
  assert.equal(refused.error.code, -32601);
  daemon.finishTurn(session, turnId);
  await completed(session, start);
  assert.deepEqual(answersFor(session).slice(0, 2), [
    { permissions: {}, scope: "turn" },
    { action: "decline", content: null, _meta: null },
  ]);
  assert.deepEqual(
    turnEvents(session, start)
      .filter((event) => event.type === "status.update")
      .map((event) => event.payload.text),
    ["Codex asked for more access (needs the network). Portals cannot grant that, so it goes on without it.", "The docs tool asked for input Portals cannot give, so it was declined."],
  );
});

test("a turn begun at the desk on a thread the bridge follows shows as a turn of its own", async () => {
  const session = await createThread();
  const start = client.frames.length;
  const turnId = "desk-turn";
  const user = { type: "userMessage", id: "u-desk", clientId: null, content: [{ type: "text", text: "From the terminal.", text_elements: [] }] };
  daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  daemon.broadcast("item/started", { threadId: session, turnId, item: user, startedAtMs: 1 });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: user, completedAtMs: 1 });
  daemon.finishTurn(session, turnId, "Hello from the desk.");
  const done = await completed(session, start);
  assert.equal(done.payload.text, "Hello from the desk.");
  assert.equal(turnEvents(session, start)[0].type, "message.start");
  const stored = (await client.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(
    stored.map((message: Frame) => [message.role, message.text]),
    [
      ["user", "From the terminal."],
      ["assistant", "Hello from the desk."],
    ],
  );
});

test("a message sent as a turn begins at the desk, before its message arrives, goes into that turn, which ends the phone's turn when it ends", async () => {
  const session = await createThread();
  const start = client.frames.length;
  const turnId = "desk-turn-raced";
  daemon.broadcast("turn/started", { threadId: session, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  await until(() => daemon.thread(session).status.type === "active");
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Codex takes the phone's message into the turn the desk began, and answers with its id.
  const turn = await send(session, "From the phone.");
  assert.deepEqual(turn.params.input, [{ type: "text", text: "From the phone.", text_elements: [] }]);
  const desk = { type: "userMessage", id: "u-desk-raced", clientId: null, content: [{ type: "text", text: "From the terminal.", text_elements: [] }] };
  daemon.broadcast("item/started", { threadId: session, turnId, item: desk, startedAtMs: 1 });
  daemon.broadcast("item/completed", { threadId: session, turnId, item: desk, completedAtMs: 1 });
  daemon.finishTurn(session, turnId, "Both done.");
  const done = await completed(session, start);
  assert.equal(done.payload.status, "complete");
  assert.equal(done.payload.text, "Both done.");
  assert.equal(turnEvents(session, start).filter((event) => event.type === "message.start").length, 1);
  assert.equal((await client.call("sessions.activity")).sessions.some((entry: Frame) => entry.session_id === session), false);
});

test("shutting the bridge down leaves Codex's turns running", async () => {
  const own = await startTestBridge({ providers: new Map([["codex", codexProvider()]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  const session = (await phone.call("session.create", { profile: "codex", cwd })).session_id;
  await phone.call("prompt.submit", { session_id: session, text: "Keep going." });
  const turnId = await daemon.activeTurn(session);
  const interrupts = daemon.callsOf("turn/interrupt").length;
  await phone.close();
  await own.dispose();
  assert.equal(daemon.callsOf("turn/interrupt").length, interrupts);
  assert.equal(daemon.thread(session).status.type, "active");
  daemon.finishTurn(session, turnId);
});

test("a Codex that cannot say where its threads ran is in the log once for as long as it lasts, and once more when it can again", async (t) => {
  // What the bridge logs at its usual level, a line each.
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  setLogLevel("info");
  const asking = new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images },
    connect: socketConnector(daemon.socketPath),
    checkVersion: false,
    configPath: join(daemon.folder, "config.toml"),
    timeZone: "UTC",
    backoff: [0.05, 0.1],
    folderRefreshMs: 15,
  });
  t.after(async () => {
    process.stderr.write = write;
    setLogLevel("silent");
    daemon.onList = () => {};
    await asking.close();
  });
  const about = (words: string) => lines.filter((line) => line.includes(words));
  const asked = () => daemon.callsOf("thread/list").length;

  daemon.onList = () => {
    throw new Error("the index is locked");
  };
  let from = asked();
  asking.start();
  await until(() => asked() >= from + 4);
  assert.deepEqual(about("could not ask Codex where its threads ran").map((line) => line.split(" ")[1]), ["warn"]);
  assert.match(about("could not ask Codex where its threads ran")[0], /the index is locked/);

  daemon.onList = () => {};
  from = asked();
  await until(() => asked() >= from + 4 && about("Codex says where its threads ran again").length > 0);
  assert.equal(about("Codex says where its threads ran again").length, 1);
  assert.equal(about("could not ask Codex where its threads ran").length, 1);

  // Failing again is said again.
  daemon.onList = () => {
    throw new Error("the index is locked");
  };
  await until(() => about("could not ask Codex where its threads ran").length === 2);
});

test("a thread the bridge starts keeps the developer instructions config.toml gives, with the portals lines after them", async () => {
  daemon.config.developer_instructions = "Answer in British English.";
  const told = new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images, portals: { bin: "/bridge/bin", instructions: "About portals." } },
    connect: socketConnector(daemon.socketPath),
    checkVersion: false,
    configPath: join(daemon.folder, "config.toml"),
    timeZone: "UTC",
    backoff: [0.05, 0.1],
  });
  const own = await startTestBridge({ providers: new Map([["codex", told]]), config: { generalFolder: cwd } });
  const ownClient = await TestClient.open(own);
  try {
    const from = daemon.calls.length;
    await ownClient.call("session.create", { profile: "codex", source: "tui" });
    const started = daemon.calls.slice(from).find((call) => call.method === "thread/start");
    assert.equal(started?.params.developerInstructions, "Answer in British English.\n\nAbout portals.");
  } finally {
    delete daemon.config.developer_instructions;
    await ownClient.close();
    await own.dispose();
  }
});

// MARK: Names

/** A bridge whose Codex names its new threads, as Codex's own apps do; closed when the test ends. */
async function namingBridge(t: { after(cleanup: () => Promise<void>): void }): Promise<TestClient> {
  const provider = new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images, titleModel: "gpt-5.6-luna" },
    connect: socketConnector(daemon.socketPath),
    checkVersion: false,
    configPath: join(daemon.folder, "config.toml"),
    timeZone: "UTC",
    backoff: [0.05, 0.1],
  });
  const own = await startTestBridge({ providers: new Map([["codex", provider]]), config: { generalFolder: cwd } });
  const on = await TestClient.open(own);
  t.after(async () => {
    daemon.titleAnswer = JSON.stringify({ title: "Check the folder" });
    daemon.titleStatus = "completed";
    daemon.onTitleTurn = () => {};
    daemon.onTurnStart = () => {};
    delete daemon.config.mcp_servers;
    await on.close();
    await own.dispose();
  });
  return on;
}

/** Ends the turn running in `session` and waits for the app to see it end. */
async function finish(session: string, on: TestClient): Promise<void> {
  const start = on.frames.length;
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start, on);
}

test("a new thread is named after its first message, as Codex's own apps name theirs: an ephemeral thread on a small model gives a title, which goes onto the thread", async (t) => {
  const on = await namingBridge(t);
  daemon.config.mcp_servers = { "cua-driver": { command: "cua-driver", args: ["mcp"] }, node_repl: { command: "node", enabled: true }, Roblox_Studio: { url: "http://localhost:3000", enabled: false } };
  const session = await createThread({}, on);
  const start = on.frames.length;
  const from = daemon.calls.length;
  await send(session, '[Portals: from Claude Code · "Night review" (thread 4a91a4a6)]\ncan u check the logs in this folder?\nThen fix what is broken.\n@image:shot.png', on);
  const named = await daemon.waitForCall((call) => call.method === "thread/name/set", from);
  assert.deepEqual(named.params, { threadId: session, name: "Check the folder" });

  const calls = daemon.calls.slice(from);
  const titleThread = calls.find((call) => call.method === "thread/start")!;
  const titleTurn = calls.find((call) => call.method === "turn/start" && call.params.outputSchema)!;
  // Once the thread's own turn has started.
  assert.ok(calls.findIndex((call) => call.method === "turn/start" && call.params.threadId === session) < calls.indexOf(titleThread));
  // Ephemeral, with a line for instructions in place of Codex's own, and nothing to act
  // with: no plugins, apps or shell, and every MCP server config.toml sets up turned off
  // (Codex was asked which); no hooks of the user's, no memories.
  assert.ok(calls.findIndex((call) => call.method === "config/read") < calls.indexOf(titleThread));
  assert.deepEqual(titleThread.params, {
    cwd: tmpdir(),
    ephemeral: true,
    model: "gpt-5.6-luna",
    baseInstructions: "You write short titles for coding tasks. Reply with the title alone.",
    approvalPolicy: "never",
    sandbox: "read-only",
    environments: [],
    config: {
      features: { plugins: false, apps: false, hooks: false, memories: false, shell_tool: false },
      mcp_servers: { "cua-driver": { enabled: false }, node_repl: { enabled: false }, Roblox_Studio: { enabled: false } },
    },
  });
  // Codex's title prompt, given what the message says: not who sent it through Portals, nor its images.
  assert.equal(titleTurn.params.effort, "low");
  assert.deepEqual(titleTurn.params.outputSchema, titleSchema);
  const prompt: string = titleTurn.params.input[0].text;
  assert.match(prompt, /^Generate a concise, single-line task title of at most 40 characters and under five words where possible\. Start with an imperative verb\./);
  assert.ok(prompt.endsWith("<conversation>\nUser: can u check the logs in this folder?\nThen fix what is broken.\n</conversation>"), prompt);

  // The app has the first line at once and the name when it comes, and keeps the name.
  await on.from(start, (frame) => isEvent(frame, "session.title", session) && frame.params.payload.title === "Check the folder");
  const titles = turnEvents(session, start, on).filter((event) => event.type === "session.title").map((event) => event.payload.title);
  assert.deepEqual(titles, ["can u check the logs in this folder?", "Check the folder"]);
  assert.equal((await on.call("session.resume", { session_id: session })).info.title, "Check the folder");
  // Codex keeps nothing of the title-generation thread.
  await until(() => !daemon.threads.has(titleTurn.params.threadId));
  assert.equal(daemon.ephemeral.size, 0);

  // The next message names nothing.
  await finish(session, on);
  const later = daemon.calls.length;
  await send(session, "And the tests too.", on);
  await finish(session, on);
  assert.equal(daemon.calls.slice(later).some((call) => call.method === "thread/start" || call.method === "thread/name/set"), false);
});

test("a thread named while its name is made, or titled when it was made, keeps its name; an answer that is no title leaves the first line", async (t) => {
  const on = await namingBridge(t);

  // Renamed in the app while Codex makes the name.
  const renamed = await createThread({}, on);
  daemon.onTitleTurn = async () => {
    await on.call("session.rename", { session_id: renamed, title: "My own name" });
  };
  let from = daemon.calls.length;
  await send(renamed, "Look at the logs.", on);
  await daemon.waitForCall((call) => call.method === "thread/read" && call.params.threadId === renamed && call.params.includeTurns === false, from);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    daemon.calls.slice(from).filter((call) => call.method === "thread/name/set").map((call) => call.params.name),
    ["My own name"],
  );
  assert.equal(daemon.thread(renamed).name, "My own name");
  assert.equal((await on.call("session.resume", { session_id: renamed })).info.title, "My own name");
  await finish(renamed, on);
  daemon.onTitleTurn = () => {};

  // Titled when it was made (portals start --title): no name is made.
  const titled = await createThread({ title: "Probe" }, on);
  from = daemon.calls.length;
  await send(titled, "Look at the logs.", on);
  await finish(titled, on);
  assert.equal(daemon.calls.slice(from).some((call) => call.method === "thread/start"), false);

  // An answer that is no title: the first line stays.
  daemon.titleAnswer = "Sure! Here is a title: Check logs";
  const plain = await createThread({}, on);
  from = daemon.calls.length;
  await send(plain, "Look at the logs.\nAll of them.", on);
  await daemon.waitForCall((call) => call.method === "thread/unsubscribe", from);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(daemon.calls.slice(from).some((call) => call.method === "thread/name/set"), false);
  assert.equal((await on.call("session.resume", { session_id: plain })).info.title, "Look at the logs.");
  await finish(plain, on);
});

test("a thread whose first turn did not start is named by the next message's, and a name that does not come in time is given up on when the connection to Codex drops; Codex failing the title turn is said", async (t) => {
  const on = await namingBridge(t);

  // The first turn Codex refuses: the next one names the thread.
  const retried = await createThread({}, on);
  let refused = false;
  daemon.onTurnStart = (params) => {
    if (params.threadId !== retried || refused) return;
    refused = true;
    throw new Error("Codex is restarting");
  };
  let start = on.frames.length;
  let from = daemon.calls.length;
  assert.equal((await on.call("prompt.submit", { session_id: retried, text: "Look at the logs.", profile: "codex" })).status, "streaming");
  assert.equal((await completed(retried, start, on)).payload.status, "error");
  assert.equal(daemon.calls.slice(from).some((call) => call.method === "thread/start"), false);
  from = daemon.calls.length;
  await send(retried, "Then fix the parser.", on);
  const named = await daemon.waitForCall((call) => call.method === "thread/name/set", from);
  assert.deepEqual(named.params, { threadId: retried, name: "Check the folder" });
  const titleTurn = daemon.calls.slice(from).find((call) => call.method === "turn/start" && call.params.outputSchema)!;
  assert.ok(titleTurn.params.input[0].text.endsWith("User: Then fix the parser.\n</conversation>"));
  await finish(retried, on);

  // The connection drops while the name is made: the wait ends there, not a minute later.
  const dropped = await createThread({}, on);
  daemon.onTitleTurn = () => daemon.dropAll();
  from = daemon.calls.length;
  const sent = Date.now();
  await send(dropped, "Look at the logs.", on);
  await daemon.waitForCall((call) => call.method === "thread/unsubscribe", from);
  assert.ok(Date.now() - sent < 5000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(daemon.calls.slice(from).some((call) => call.method === "thread/name/set"), false);
  daemon.onTitleTurn = () => {};
  daemon.finishTurn(dropped, await daemon.activeTurn(dropped));

  // Codex fails the title turn: the log says so, and the first line stays.
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  setLogLevel("info");
  try {
    daemon.titleStatus = "failed";
    const failing = await createThread({}, on);
    from = daemon.calls.length;
    await send(failing, "Look at the logs.", on);
    await until(() => lines.some((line) => line.includes("Codex did not make a thread's name")));
    assert.match(lines.find((line) => line.includes("Codex did not make a thread's name"))!, /warn.*gpt-5\.6-luna.*the turn ended failed/);
    assert.equal(daemon.calls.slice(from).some((call) => call.method === "thread/name/set"), false);
    await finish(failing, on);
  } finally {
    process.stderr.write = write;
    setLogLevel("silent");
  }
});

// MARK: Removing a thread

/** What `thread.delete` answers for a Codex thread at work. */
const atWork = (error: RpcFailure) => error.code === -32602 && error.message === "Codex is still working in this thread. Stop it, then remove it.";

/** Waits until the bridge has nothing at work. */
async function atRest(on: TestClient): Promise<void> {
  const deadline = Date.now() + 3000;
  while ((await on.call("sessions.activity")).sessions.length > 0) {
    if (Date.now() > deadline) throw new Error("still at work");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a turn the bridge ended for the app after Stop, which Codex still runs, keeps its thread from being removed until Codex ends it", async (t) => {
  const own = await startTestBridge({ providers: new Map([["codex", codexProvider(images, 30)]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  t.after(async () => {
    await phone.close();
    await own.dispose();
  });
  // Codex takes the interrupt and goes on: the grace timer ends the turn for the app.
  const stopped = async () => {
    const session = await createThread({}, phone);
    const start = phone.frames.length;
    await send(session, "Count to a million.", phone);
    const turnId = await daemon.activeTurn(session);
    assert.deepEqual(await phone.call("session.interrupt", { session_id: session, profile: "codex" }), { status: "interrupted" });
    assert.equal((await completed(session, start, phone)).payload.status, "interrupted");
    assert.deepEqual((await phone.call("sessions.activity")).sessions, []);
    await assert.rejects(phone.call("thread.delete", { thread: session }), atWork);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(phone.call("thread.delete", { thread: session }), atWork);
    return { session, turnId };
  };

  // Codex says it ended.
  const told = await stopped();
  daemon.finishTurn(told.session, told.turnId, "", "interrupted");
  await until(() => daemon.thread(told.session).status.type === "idle");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await phone.call("thread.delete", { thread: told.session }), {});

  // Codex ended it without the bridge hearing: asked, it says so.
  const quiet = await stopped();
  const thread = daemon.thread(quiet.session);
  thread.turns.find((turn) => turn.id === quiet.turnId).status = "interrupted";
  thread.status = { type: "idle" };
  assert.deepEqual(await phone.call("thread.delete", { thread: quiet.session }), {});
  assert.deepEqual(
    (await phone.call("threads.changes", {})).removed.sort(),
    [told.session, quiet.session].sort(),
  );
});

test("a turn begun at the desk keeps its thread from being removed before its message arrives, or with none (a compaction)", async () => {
  const session = await createThread();
  const turn = { id: "desk-compact", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
  daemon.broadcast("turn/started", { threadId: session, turn });
  await until(() => daemon.thread(session).status.type === "active");
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The app is not shown it as running: it has no message.
  assert.equal((await client.call("sessions.activity")).sessions.some((entry: Frame) => entry.session_id === session), false);
  await assert.rejects(client.call("thread.delete", { thread: session }), atWork);
  daemon.finishTurn(session, "desk-compact");
  await until(() => daemon.thread(session).status.type === "idle");
  assert.deepEqual(await client.call("thread.delete", { thread: session }), {});
});

test("a desk turn Codex begins while the bridge asks it about the last one keeps the thread from being removed", async () => {
  const session = await createThread();
  const turn = (id: string) => ({ id, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null });
  daemon.broadcast("turn/started", { threadId: session, turn: turn("compact-a") });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Asked about the first, Codex has ended it, without the bridge hearing, and begun another.
  daemon.onRead = (params) => {
    if (params.threadId !== session) return;
    daemon.onRead = () => {};
    const thread = daemon.thread(session);
    thread.turns.find((entry) => entry.id === "compact-a").status = "completed";
    daemon.broadcast("turn/started", { threadId: session, turn: turn("compact-b") });
  };
  await assert.rejects(client.call("thread.delete", { thread: session }), atWork);
  await assert.rejects(client.call("thread.delete", { thread: session }), atWork);
  daemon.finishTurn(session, "compact-b");
  await until(() => daemon.thread(session).status.type === "idle");
  assert.deepEqual(await client.call("thread.delete", { thread: session }), {});
});

test("a thread whose sub-agent works on after the turn is not removed, which would lose it; once it has ended the thread is", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Spawn a slow sub-agent.");
  const turnID = await daemon.activeTurn(session);
  const child = daemon.addThread(cwd, [{ id: "child-turn", items: [], status: "inProgress", error: null }], {
    loaded: true,
    status: { type: "active", activeFlags: [] },
    parentThreadId: session,
  });
  daemon.broadcast("item/completed", { threadId: session, turnId: turnID, item: { type: "subAgentActivity", id: "call_1", kind: "started", agentThreadId: child, agentPath: "/root/slow_one" } });
  await client.from(start, (frame) => isEvent(frame, "subagent.start", session));
  daemon.finishTurn(session, turnID);
  await completed(session, start);
  await assert.rejects(
    client.call("thread.delete", { thread: session }),
    (error: RpcFailure) => error.code === -32602 && error.message === "Codex still has work running in the background in this thread. Remove it once that work is done.",
  );
  daemon.broadcast("item/completed", { threadId: session, turnId: turnID, item: { type: "subAgentActivity", id: "call_2", kind: "completed", agentThreadId: child, agentPath: "/root/slow_one" } });
  await client.from(start, (frame) => isEvent(frame, "subagent.complete", session));
  assert.deepEqual(await client.call("thread.delete", { thread: session }), {});
});

test("a turn Codex begins while the connection to it is down keeps the thread from being removed; with no message yet, it waits for its message to show", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Build it.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  const resumes = daemon.callsOf("thread/resume").length;
  daemon.dropAll();
  // At the desk, while the bridge is away: no turn/started reaches it.
  const thread = daemon.thread(session);
  thread.turns.push({ id: "in-the-gap", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null });
  thread.status = { type: "active", activeFlags: [] };
  await until(() => daemon.callsOf("thread/resume").length > resumes);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Codex runs hooks before a turn's message comes: it is not shown as "/compact" meanwhile.
  assert.equal(client.frames.slice(start).some((frame) => isEvent(frame, "message.start", session) && frame.params.seq > 2), false);
  await assert.rejects(client.call("thread.delete", { thread: session }), atWork);
  daemon.finishTurn(session, "in-the-gap");
  await until(() => daemon.thread(session).status.type === "idle");
  assert.deepEqual(await client.call("thread.delete", { thread: session }), {});
});

test("a thread loaded after a restart only to be shown, which the bridge does not follow, is not removed while a desk turn runs in it", async () => {
  const thread = daemon.addThread(cwd, [], { loaded: false, name: "Shown only" });
  const seeded = await startTestBridge({ keepHome: true, providers: new Map(), config: { generalFolder: cwd } });
  await seeded.close();
  writeFileSync(
    join(seeded.home, "state", "threads.json"),
    JSON.stringify({ threads: [{ id: thread, agent: "codex", cwd, title: "Shown only", model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "high", createdAt: 1, updatedAt: 2, origin: "phone" }] }),
  );
  const restarted = await startTestBridge({ home: seeded.home, providers: new Map([["codex", codexProvider()]]) });
  const phone = await TestClient.open(restarted);
  try {
    await phone.call("session.resume", { session_id: thread, profile: "codex", inline_images: false });
    // A turn begins at the desk, which the bridge does not hear of.
    const state = daemon.thread(thread);
    state.turns.push({ id: "at-the-desk", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null });
    state.loaded = true;
    state.status = { type: "active", activeFlags: [] };
    await assert.rejects(phone.call("thread.delete", { thread }), atWork);
    state.turns[0].status = "completed";
    state.status = { type: "idle" };
    assert.deepEqual(await phone.call("thread.delete", { thread }), {});
  } finally {
    await phone.close();
    await restarted.dispose();
  }
});

test("a Codex thread whose agent cannot be asked whether it is at work is not removed, and says why", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Build it.");
  daemon.finishTurn(session, await daemon.activeTurn(session));
  await completed(session, start);
  daemon.onRead = (params) => {
    if (params.threadId === session) throw new Error("Codex is restarting");
  };
  try {
    await assert.rejects(
      client.call("thread.delete", { thread: session }),
      (error: RpcFailure) => error.code === -32603 && error.message.startsWith("Portals could not ask Codex whether this thread is at work ("),
    );
  } finally {
    daemon.onRead = () => {};
  }
  assert.deepEqual(await client.call("thread.delete", { thread: session }), {});
});

test("a Codex thread Codex runs right after a restart of the bridge is not removed, followed again yet or not", async () => {
  const first = await startTestBridge({ keepHome: true, providers: new Map([["codex", codexProvider()]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(first);
  const running = (await phone.call("session.create", { profile: "codex", cwd })).session_id;
  const atDesk = (await phone.call("session.create", { profile: "codex", cwd })).session_id;
  await phone.call("prompt.submit", { session_id: running, text: "Build it." });
  const turnId = await daemon.activeTurn(running);
  const message = { type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "Build it.", text_elements: [] }] };
  daemon.broadcast("item/started", { threadId: running, turnId, item: message, startedAtMs: 1 });
  daemon.broadcast("item/completed", { threadId: running, turnId, item: message, completedAtMs: 1 });
  await phone.close();
  await first.close();
  // Codex has let go of the other one: the next bridge does not follow it at its start.
  const later = daemon.thread(atDesk);
  later.loaded = false;
  later.status = { type: "notLoaded" };

  const from = daemon.calls.length;
  const second = await startTestBridge({ home: first.home, providers: new Map([["codex", codexProvider()]]) });
  const again = await TestClient.open(second);
  try {
    // Right away, whether or not the bridge has followed it again yet.
    await assert.rejects(again.call("thread.delete", { thread: running }), atWork);
    await daemon.waitForCall((call) => call.method === "thread/loaded/list", from);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(daemon.calls.slice(from).some((call) => call.method === "thread/resume" && call.params.threadId === atDesk), false);

    // A turn starts at the desk in the other one: asked before removing it, Codex says it has it open.
    const user = { type: "userMessage", id: "u-desk", clientId: null, content: [{ type: "text", text: "From the terminal.", text_elements: [] }] };
    later.turns.push({ id: "desk-turn", items: [user], itemsView: "full", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null });
    later.loaded = true;
    later.status = { type: "active", activeFlags: [] };
    await assert.rejects(again.call("thread.delete", { thread: atDesk }), atWork);
    assert.deepEqual(
      (await again.call("sessions.activity")).sessions.map((entry: Frame) => entry.session_id).sort(),
      [running, atDesk].sort(),
    );

    // Both end: both are removed.
    daemon.finishTurn(running, turnId, "Built.");
    daemon.finishTurn(atDesk, "desk-turn", "Done at the desk.");
    await atRest(again);
    assert.deepEqual(await again.call("thread.delete", { thread: running }), {});
    assert.deepEqual(await again.call("thread.delete", { thread: atDesk }), {});
    assert.deepEqual((await again.call("threads.changes", {})).threads, []);
  } finally {
    await again.close();
    await second.dispose();
  }
});

test("what a Codex turn spent is kept by the bridge, as Codex keeps no tokens with a turn: after a restart its last message still says them, with Codex's time (turn_usage)", async () => {
  const first = await startTestBridge({ keepHome: true, providers: new Map([["codex", codexProvider()]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(first);
  const session = (await phone.call("session.create", { profile: "codex", cwd, title: "Spent" })).session_id;
  const start = phone.frames.length;
  daemon.scripts.push("plain");
  await phone.call("prompt.submit", { session_id: session, text: "List this folder.\nThen tell me about 221." });
  const done = await phone.from(start, (frame) => isEvent(frame, "message.complete", session));
  assert.deepEqual(done.params.payload.turn_usage, { seconds: 6.2, tokens: 49_635 });
  // Kept under Codex's id for the turn.
  const kept = JSON.parse(readFileSync(join(first.home, "state", "spent", `${session}.json`), "utf8"));
  assert.equal(kept.length, 1);
  assert.match(kept[0].turn, /\S/);
  assert.deepEqual({ ...kept[0], turn: "" }, { turn: "", seconds: 6.2, tokens: 49_635 });
  await phone.close();
  await first.close();

  const second = await startTestBridge({ home: first.home, providers: new Map([["codex", codexProvider()]]) });
  const again = await TestClient.open(second);
  try {
    const resumed = await again.call("session.resume", { session_id: session, profile: "codex", inline_images: false });
    const last = resumed.messages.at(-1);
    assert.equal(last.text, "I saw `hello.txt`; 221 is not prime because 221 = 13 × 17.");
    // The tokens the bridge kept, and its time for the turn where Codex's history has none.
    assert.deepEqual(last.turn_usage, { seconds: 6.2, tokens: 49_635 });
  } finally {
    await again.close();
    await second.dispose();
  }
});

test("what a Codex turn changed: its file changes joined per file, a file added and one deleted, at its end and in its stored history (feature turn_diff)", async () => {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Tidy up.");
  const turnId = await daemon.activeTurn(session);
  const items = [
    { type: "fileChange", id: "fc-1", changes: [{ path: join(cwd, "hello.txt"), kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-hi\n+hey\n" }], status: "completed" },
    {
      type: "fileChange",
      id: "fc-2",
      changes: [
        { path: join(cwd, "new.txt"), kind: { type: "add" }, diff: "one\ntwo\n" },
        { path: join(cwd, "old.txt"), kind: { type: "delete" }, diff: "gone\n" },
      ],
      status: "completed",
    },
    { type: "fileChange", id: "fc-3", changes: [{ path: join(cwd, "hello.txt"), kind: { type: "update", move_path: null }, diff: "@@ -3 +3 @@\n-a\n+b\n" }], status: "completed" },
    // Declined: nothing changed.
    { type: "fileChange", id: "fc-4", changes: [{ path: join(cwd, "secret.txt"), kind: { type: "add" }, diff: "no\n" }], status: "declined" },
  ];
  for (const item of items) {
    daemon.broadcast("item/started", { threadId: session, turnId, item: { ...item, status: "inProgress" }, startedAtMs: 1 });
    daemon.broadcast("item/completed", { threadId: session, turnId, item, completedAtMs: 2 });
  }
  daemon.finishTurn(session, turnId);
  const changed = (await completed(session, start)).payload.turn_diff;
  assert.deepEqual(
    changed.files.map((file: Frame) => [file.path, file.status, file.added, file.removed]),
    [
      ["hello.txt", "modified", 2, 2],
      ["new.txt", "added", 2, 0],
      ["old.txt", "deleted", 0, 1],
    ],
  );
  assert.equal(changed.files[0].diff, "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hey\n@@ -3 +3 @@\n-a\n+b\n");
  assert.deepEqual([changed.added, changed.removed], [4, 3]);
  const stored = (await client.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(stored.at(-1).turn_diff, changed);
});

test("a command Codex leaves running as its turn completes is a command row: its output after the turn, and across the next turn, its end on its row and its tool row", async () => {
  const session = await createThread();
  let start = client.frames.length;
  await send(session, "Start the dev server.");
  const first = await daemon.activeTurn(session);
  const command = { type: "commandExecution", id: "exec-bg", command: "/bin/zsh -lc 'npm run dev'", cwd: "/w", processId: "4242", source: "unifiedExecStartup", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
  daemon.broadcast("item/started", { threadId: session, turnId: first, item: command, startedAtMs: 1 });
  daemon.broadcast("item/commandExecution/outputDelta", { threadId: session, turnId: first, itemId: "exec-bg", delta: "ready\r\n" });
  daemon.finishTurn(session, first, "Started.");
  await completed(session, start);
  const begun = turnEvents(session, start).find((event) => event.type === "subagent.start")!;
  assert.deepEqual([begun.payload.kind, begun.payload.goal, begun.payload.can_stop, begun.payload.summary], ["command", "npm run dev", true, "ready"]);
  const row = turnEvents(session, start).find((event) => event.type === "tool.complete")!;
  assert.deepEqual(row.payload.result, { output: "ready\n…still running in the background." });

  // The next turn runs while it prints: its output is the row's; an item of the new turn with the same id is not.
  start = client.frames.length;
  await send(session, "And now?");
  const second = await daemon.activeTurn(session);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  daemon.broadcast("item/commandExecution/outputDelta", { threadId: session, turnId: first, itemId: "exec-bg", delta: "GET / 200\r\n" });
  daemon.broadcast("item/commandExecution/outputDelta", { threadId: session, turnId: second, itemId: "exec-bg", delta: "not the server's\n" });
  await until(() => client.events(session).some((event) => event.type === "subagent.progress" && event.payload.subagent_id === "exec-bg"));
  const progress = client.events(session).filter((event) => event.type === "subagent.progress").at(-1)!;
  assert.equal(progress.payload.output, "ready\nGET / 200\n");

  // Stop asks Codex to end its process.
  await client.call("subagent.stop", { session_id: session, subagent_id: "exec-bg" }).catch(() => undefined);
  assert.deepEqual(daemon.callsOf("thread/backgroundTerminals/terminate").at(-1)?.params, { threadId: session, processId: "4242" });

  daemon.broadcast("item/completed", { threadId: session, turnId: first, item: { ...command, status: "completed", aggregatedOutput: "ready\r\nGET / 200\r\n", exitCode: 0, durationMs: 9000 }, completedAtMs: 2 });
  await until(() => client.events(session).some((event) => event.type === "subagent.complete" && event.payload.subagent_id === "exec-bg"));
  const ended = client.events(session).find((event) => event.type === "subagent.complete" && event.payload.subagent_id === "exec-bg")!;
  assert.equal(ended.payload.status, "completed");
  const final = client.events(session).filter((event) => event.type === "tool.complete" && event.payload.tool_id === "exec-bg").at(-1)!;
  assert.deepEqual(final.payload.result, { output: "ready\nGET / 200\n", exit_code: 0 });
  daemon.finishTurn(session, second, "Fine.");
  await completed(session, start);
});

/** A thread with a command Codex left running in the background as its first turn completed (`exec-bg` of turn `first`). */
async function backgroundCommand(name: string) {
  const session = await createThread();
  const start = client.frames.length;
  await send(session, "Start the dev server.");
  const first = await daemon.activeTurn(session);
  const command = { type: "commandExecution", id: `exec-${name}`, command: "/bin/zsh -lc 'npm run dev'", cwd: "/w", processId: "4343", source: "unifiedExecStartup", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
  daemon.broadcast("item/started", { threadId: session, turnId: first, item: command, startedAtMs: 1 });
  daemon.finishTurn(session, first, "Started.");
  await completed(session, start);
  assert.ok(turnEvents(session, start).some((event) => event.type === "subagent.start" && event.payload.subagent_id === command.id));
  return { session, first, command };
}

test("a command left running in the background that ends while the connection to Codex is down, with a newer turn running, ends on its row and its tool row at the reconnect", async () => {
  const { session, first, command } = await backgroundCommand("bg-gap");
  const start = client.frames.length;
  await send(session, "And now?");
  const second = await daemon.activeTurn(session);
  // It ends while the bridge is away: Codex keeps it, ended, in its turn.
  const turn = daemon.thread(session).turns.find((entry) => entry.id === first)!;
  turn.items.push({ ...command, status: "completed", aggregatedOutput: "ready\n", exitCode: 0, durationMs: 4000 });
  daemon.dropAll();
  await until(() => client.events(session).some((event) => event.type === "subagent.complete" && event.payload.subagent_id === command.id));
  const final = client.events(session).filter((event) => event.type === "tool.complete" && event.payload.tool_id === command.id).at(-1)!;
  assert.deepEqual(final.payload.result, { output: "ready\n", exit_code: 0 });
  daemon.finishTurn(session, second, "Fine.");
  await completed(session, start);
});

test("a command left running in the background whose end comes while a reconnect reads the thread, after what the read says, ends on its row", async () => {
  const { session, first, command } = await backgroundCommand("bg-held");
  // Its end comes as the thread is read, but the read is from before it.
  daemon.onRead = () => {
    daemon.onRead = () => {};
    daemon.broadcast("item/completed", { threadId: session, turnId: first, item: { ...command, status: "completed", aggregatedOutput: "ready\n", exitCode: 0, durationMs: 4000 }, completedAtMs: 2 });
    const turn = daemon.thread(session).turns.find((entry) => entry.id === first)!;
    turn.items = turn.items.filter((item: Frame) => item.id !== command.id);
  };
  daemon.dropAll();
  await until(() => client.events(session).some((event) => event.type === "subagent.complete" && event.payload.subagent_id === command.id));
});

test("files mentioned (feature file_mentions) reach Codex in the text as @path, with no mention input, which Codex keeps for apps, plugins and skills", async () => {
  writeFileSync(join(cwd, "mentioned.md"), "# Notes\n");
  const session = await createThread();
  const start = client.frames.length;
  daemon.scripts.push("plain");
  const from = daemon.calls.length;
  const reply = await client.call("prompt.submit", { session_id: session, text: "Summarise", mentions: ["mentioned.md", "../outside.md"], profile: "codex" });
  assert.equal(reply.status, "streaming");
  const turn = await daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === session, from);
  assert.deepEqual(turn.params.input, [{ type: "text", text: "Summarise @mentioned.md", text_elements: [] }]);
  await completed(session, start);
});

// Last in the file: its bridge's connection to the daemon is the latest one made, which
// tests before it take for the shared bridge's.
test("a Stop Codex answers only after its turn ended and the next began leaves that turn's own Stop its time: a turn Codex does not end is ended for the app", async () => {
  const own = await startTestBridge({ providers: new Map([["codex", codexProvider(images, 200)]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  try {
    const session = await createThread({}, phone);
    let start = phone.frames.length;
    await send(session, "First.", phone);
    const first = await daemon.activeTurn(session);
    // Codex is slow to answer the Stop, and ends the turn by itself meanwhile.
    let release!: () => void;
    daemon.interruptHeld = new Promise((resolve) => (release = resolve));
    const from = daemon.calls.length;
    const stopped = phone.call("session.interrupt", { session_id: session });
    await daemon.waitForCall((call) => call.method === "turn/interrupt" && call.params.turnId === first, from);
    daemon.finishTurn(session, first);
    await completed(session, start, phone);
    // The next turn begins before Codex answers that Stop.
    start = phone.frames.length;
    await send(session, "Second.", phone);
    const second = await daemon.activeTurn(session);
    assert.notEqual(second, first);
    release();
    daemon.interruptHeld = null;
    await stopped;
    // A Stop on the second turn, which Codex never ends: the app's turn ends after the grace time all the same.
    await phone.call("session.interrupt", { session_id: session });
    const done = await completed(session, start, phone, 2000);
    assert.equal(done.payload.status, "interrupted");
    daemon.finishTurn(session, second, "", "interrupted");
  } finally {
    daemon.interruptHeld = null;
    await phone.close();
    await own.dispose();
  }
});

test("after a restart while Codex does not answer yet, a thread it still runs is followed once it does, before any phone asks, with its open approval", async () => {
  const first = await startTestBridge({ keepHome: true, providers: new Map([["codex", codexProvider()]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(first);
  const session = (await phone.call("session.create", { profile: "codex", cwd, title: "Late daemon" })).session_id;
  await phone.call("prompt.submit", { session_id: session, text: "Build it." });
  const turnId = await daemon.activeTurn(session);
  await phone.close();
  await first.close();

  // Codex takes no connection for longer than the bridge waits for one at its start.
  daemon.accepting = false;
  const from = daemon.calls.length;
  const late = new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images },
    connect: socketConnector(daemon.socketPath),
    checkVersion: false,
    configPath: join(daemon.folder, "config.toml"),
    timeZone: "UTC",
    backoff: [0.05, 0.1],
    readyMs: 200,
  });
  const second = await startTestBridge({ home: first.home, providers: new Map([["codex", late]]) });
  try {
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(daemon.calls.length, from, "Codex heard nothing while it took no connection");
    daemon.accepting = true;
    // Followed once Codex answers, with no phone asking for the thread.
    const resumed = await Promise.race([
      daemon.waitForCall((call) => call.method === "thread/resume" && call.params.threadId === session, from),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    assert.ok(resumed, "the thread Codex still runs was followed once Codex answered");
    // Its question reaches the bridge, which holds it for the phone.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const change = { type: "fileChange", id: "change-late", changes: [{ path: join(cwd, "late.txt"), kind: { type: "add" }, diff: "late\n" }], status: "inProgress" };
    daemon.broadcast("item/started", { threadId: session, turnId, item: change, startedAtMs: 1 });
    void daemon.request(session, "item/fileChange/requestApproval", { threadId: session, turnId, itemId: "change-late", startedAtMs: 1, reason: null, grantRoot: null });
    const again = await TestClient.open(second);
    try {
      const deadline = Date.now() + 3000;
      let reopened: Frame;
      for (;;) {
        reopened = await again.call("session.resume", { session_id: session, profile: "codex", inline_images: false });
        if (reopened.open_requests.length > 0 || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(reopened.running, true);
      assert.deepEqual(reopened.open_requests.map((request: Frame) => request.method), ["approval"]);
      const start = again.frames.length;
      again.answer(reopened.open_requests[0].id, { choice: "once" });
      await until(() => answersFor(session).some((answer) => (answer as { decision?: string }).decision === "accept"));
      daemon.finishTurn(session, turnId, "Built.");
      await completed(session, start, again);
    } finally {
      await again.close();
    }
  } finally {
    daemon.accepting = true;
    await second.dispose();
  }
});

test("after a restart while Codex does not answer yet, a message waiting behind a turn that ended meanwhile has its turn once Codex answers", async () => {
  const first = await startTestBridge({ keepHome: true, providers: new Map([["codex", codexProvider()]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(first);
  const session = (await phone.call("session.create", { profile: "codex", cwd, title: "Waiting late" })).session_id;
  await phone.call("prompt.submit", { session_id: session, text: "Build it." });
  const turnId = await daemon.activeTurn(session);
  assert.equal((await phone.call("prompt.submit", { session_id: session, text: "Then test it.", when_busy: "queue" })).status, "queued");
  await phone.close();
  await first.close();
  // While the bridge is away the turn ends, and Codex lets the thread go.
  daemon.finishTurn(session, turnId, "Built.");
  daemon.thread(session).loaded = false;

  daemon.accepting = false;
  const from = daemon.calls.length;
  const late = new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images },
    connect: socketConnector(daemon.socketPath),
    checkVersion: false,
    configPath: join(daemon.folder, "config.toml"),
    timeZone: "UTC",
    backoff: [0.05, 0.1],
    readyMs: 200,
  });
  const second = await startTestBridge({ home: first.home, providers: new Map([["codex", late]]) });
  try {
    // Past the time the bridge waits for Codex, for the threads it runs and then for the one with a message waiting.
    await new Promise((resolve) => setTimeout(resolve, 900));
    daemon.accepting = true;
    const started = await Promise.race([
      daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === session, from),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    assert.ok(started, "the message waiting had its turn once Codex answered");
    assert.deepEqual(started.params.input, [{ type: "text", text: "Then test it.", text_elements: [] }]);
    daemon.finishTurn(session, await daemon.activeTurn(session), "Tested.");
  } finally {
    daemon.accepting = true;
    await second.dispose();
  }
});

test("after a restart a thread Codex runs that could not be loaded when Codex said so is loaded again, before any phone asks", async () => {
  const first = await startTestBridge({ keepHome: true, providers: new Map([["codex", codexProvider()]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(first);
  const session = (await phone.call("session.create", { profile: "codex", cwd, title: "Resume fails once" })).session_id;
  await phone.call("prompt.submit", { session_id: session, text: "Build it." });
  const turnId = await daemon.activeTurn(session);
  await phone.close();
  await first.close();

  // Codex says the thread runs, then fails to resume it once (its connection dropped between, say).
  let refused = 0;
  daemon.onResume = (params) => {
    if (params.threadId !== session || refused > 0) return;
    refused += 1;
    throw new Error("the connection dropped");
  };
  const from = daemon.calls.length;
  const second = await startTestBridge({ home: first.home, providers: new Map([["codex", codexProvider()]]) });
  try {
    const resumes = () => daemon.calls.slice(from).filter((call) => call.method === "thread/resume" && call.params.threadId === session).length;
    await until(() => resumes() >= 2, 4000).catch(() => undefined);
    assert.equal(refused, 1);
    assert.equal(resumes(), 2, "the thread was loaded again after its load failed");
    const again = await TestClient.open(second);
    try {
      const resumed = await again.call("session.resume", { session_id: session, profile: "codex", inline_images: false });
      assert.equal(resumed.running, true);
      const start = again.frames.length;
      daemon.finishTurn(session, turnId, "Built.");
      await completed(session, start, again);
    } finally {
      await again.close();
    }
  } finally {
    daemon.onResume = () => {};
    await second.dispose();
  }
});

test("after a restart while Codex does not answer yet, a message waiting has its turn once Codex answers, though another thread Codex runs keeps failing to load", async () => {
  const first = await startTestBridge({ keepHome: true, providers: new Map([["codex", codexProvider()]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(first);
  const waiting = (await phone.call("session.create", { profile: "codex", cwd, title: "Waits" })).session_id;
  const broken = (await phone.call("session.create", { profile: "codex", cwd, title: "Never loads" })).session_id;
  await phone.call("prompt.submit", { session_id: waiting, text: "Build it." });
  const turnId = await daemon.activeTurn(waiting);
  assert.equal((await phone.call("prompt.submit", { session_id: waiting, text: "Then test it.", when_busy: "queue" })).status, "queued");
  await phone.close();
  await first.close();
  daemon.finishTurn(waiting, turnId, "Built.");
  daemon.thread(waiting).loaded = false;
  // Codex has the other thread open, and cannot resume it.
  daemon.thread(broken).loaded = true;
  daemon.onResume = (params) => {
    if (params.threadId === broken) throw new Error("no rollout found");
  };
  daemon.onRead = (params) => {
    if (params.threadId === broken) throw new Error("no rollout found");
  };

  daemon.accepting = false;
  const from = daemon.calls.length;
  const late = new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images },
    connect: socketConnector(daemon.socketPath),
    checkVersion: false,
    configPath: join(daemon.folder, "config.toml"),
    timeZone: "UTC",
    backoff: [0.05, 0.1],
    readyMs: 200,
  });
  const second = await startTestBridge({ home: first.home, providers: new Map([["codex", late]]) });
  try {
    // Past the bridge's first asking and its loading of the thread with a message waiting.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    daemon.accepting = true;
    const started = await Promise.race([
      daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === waiting, from),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    assert.ok(started, "the message waiting had its turn once Codex answered");
    daemon.finishTurn(waiting, await daemon.activeTurn(waiting), "Tested.");
  } finally {
    daemon.onResume = () => {};
    daemon.onRead = () => {};
    daemon.accepting = true;
    await second.dispose();
  }
});

test("after a restart a thread with a message waiting that could not be loaded when Codex first answered is loaded again, and the message has its turn", async () => {
  const first = await startTestBridge({ keepHome: true, providers: new Map([["codex", codexProvider()]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(first);
  const waiting = (await phone.call("session.create", { profile: "codex", cwd, title: "Waits, loads late" })).session_id;
  await phone.call("prompt.submit", { session_id: waiting, text: "Build it." });
  const turnId = await daemon.activeTurn(waiting);
  assert.equal((await phone.call("prompt.submit", { session_id: waiting, text: "Then test it.", when_busy: "queue" })).status, "queued");
  await phone.close();
  await first.close();
  daemon.finishTurn(waiting, turnId, "Built.");
  daemon.thread(waiting).loaded = false;
  // Once Codex answers, the thread cannot be loaded the first time (Codex went again, say).
  let failing = true;
  daemon.onResume = (params) => {
    if (params.threadId === waiting && failing) throw new Error("the connection dropped");
  };
  daemon.onRead = (params) => {
    if (params.threadId !== waiting || !failing) return;
    failing = false;
    throw new Error("the connection dropped");
  };

  daemon.accepting = false;
  const from = daemon.calls.length;
  const late = new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images },
    connect: socketConnector(daemon.socketPath),
    checkVersion: false,
    configPath: join(daemon.folder, "config.toml"),
    timeZone: "UTC",
    backoff: [0.05, 0.1],
    readyMs: 200,
  });
  const second = await startTestBridge({ home: first.home, providers: new Map([["codex", late]]) });
  try {
    // Past the bridge's first asking and its loading of the thread with a message waiting.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    daemon.accepting = true;
    const started = await Promise.race([
      daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === waiting, from),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 9000)),
    ]);
    assert.equal(failing, false, "the thread's load failed once Codex answered");
    assert.ok(started, "the message waiting had its turn once the thread loaded");
    daemon.finishTurn(waiting, await daemon.activeTurn(waiting), "Tested.");
  } finally {
    daemon.onResume = () => {};
    daemon.onRead = () => {};
    daemon.accepting = true;
    await second.dispose();
  }
});

test("after a restart a thread with a message waiting whose load fails once, Codex answering all along, is loaded again, and the message has its turn", async () => {
  const first = await startTestBridge({ keepHome: true, providers: new Map([["codex", codexProvider()]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(first);
  const waiting = (await phone.call("session.create", { profile: "codex", cwd, title: "Waits, fails once" })).session_id;
  await phone.call("prompt.submit", { session_id: waiting, text: "Build it." });
  const turnId = await daemon.activeTurn(waiting);
  assert.equal((await phone.call("prompt.submit", { session_id: waiting, text: "Then test it.", when_busy: "queue" })).status, "queued");
  await phone.close();
  await first.close();
  daemon.finishTurn(waiting, turnId, "Built.");
  daemon.thread(waiting).loaded = false;
  let failing = true;
  daemon.onResume = (params) => {
    if (params.threadId === waiting && failing) throw new Error("the connection dropped");
  };
  daemon.onRead = (params) => {
    if (params.threadId !== waiting || !failing) return;
    failing = false;
    throw new Error("the connection dropped");
  };
  const from = daemon.calls.length;
  const second = await startTestBridge({ home: first.home, providers: new Map([["codex", codexProvider()]]) });
  try {
    const started = await Promise.race([
      daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === waiting, from),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    assert.equal(failing, false, "the thread's first load failed");
    assert.ok(started, "the message waiting had its turn once the thread loaded");
    daemon.finishTurn(waiting, await daemon.activeTurn(waiting), "Tested.");
  } finally {
    daemon.onResume = () => {};
    daemon.onRead = () => {};
    await second.dispose();
  }
});
