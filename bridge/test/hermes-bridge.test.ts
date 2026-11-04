import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { FakeProvider } from "../src/providers/fake.ts";
import { HermesHost } from "../src/providers/hermes/provider.ts";
import type { Provider } from "../src/providers/types.ts";
import { Registry } from "../src/sessions/registry.ts";
import { FakeHermes } from "./hermes-serve.ts";
import { isEvent, RpcFailure, sessionCookie, startTestBridge, TestClient, type Frame, type TestBridge } from "./helpers.ts";

// Hermes threads through the whole bridge, as the app sees them, against a stand-in for
// `hermes serve` (test/hermes-serve.ts) that plays turns captured from Hermes: the
// connection, the sessions, turns, questions and notifications are the real code; only
// Hermes is played.

let hermes: FakeHermes;
let bridge: TestBridge;
let client: TestClient;
let cwd: string;
let state: string;

function hermesAgents(cachePath = join(state, "hermes.json")): Map<string, Provider> {
  const agents = new Map<string, Provider>();
  new HermesHost({
    settings: { path: "/nonexistent/hermes", start: false, folder: cwd, logPath: join(state, "hermes-serve.log") },
    cachePath,
    connect: hermes.connector(),
    backoff: [0.05, 0.1],
    // Threads made one after another, as before each profile kept one (test/hermes-bot-chat.test.ts).
    oneThread: false,
  }).addTo(agents);
  return agents;
}

before(async () => {
  hermes = await FakeHermes.start();
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "portals-hermes-test-")));
  state = mkdtempSync(join(tmpdir(), "portals-hermes-state-"));
  bridge = await startTestBridge({ providers: hermesAgents(), config: { generalFolder: cwd, push: { dryRun: join(state, "push.jsonl") } } });
  client = await TestClient.open(bridge);
});

after(async () => {
  await client.close();
  await bridge.dispose();
  await hermes.close();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function createThread(params: Record<string, unknown> = {}, on = client): Promise<string> {
  return (await on.call("session.create", { profile: "hermes", source: "tui", cwd, ...params })).session_id;
}

/** Sends a message that plays `fixture`, and returns where the thread's frames start. */
async function send(thread: string, text: string, fixture: string, on = client): Promise<number> {
  hermes.queueTurn(thread, fixture);
  const start = on.frames.length;
  const reply = await on.call("prompt.submit", { session_id: thread, text, profile: "hermes" });
  assert.equal(reply.status, "streaming");
  return start;
}

function turnEvents(thread: string, start: number, on = client): Frame[] {
  return on.frames.slice(start).filter((frame) => frame.method === "event" && frame.params.session_id === thread).map((frame) => frame.params);
}

async function completed(thread: string, start: number, on = client): Promise<Frame> {
  return (await on.from(start, (frame) => isEvent(frame, "message.complete", thread))).params;
}

test("each Hermes profile is an agent, the default one called hermes, and the list is kept for the next start", async () => {
  await until(() => existsSync(join(state, "hermes.json")));
  const profiles = (await client.call("profiles.list")).profiles;
  assert.deepEqual(
    profiles.map((profile: Frame) => [profile.name, profile.display_name, profile.kind]),
    [
      ["hermes", "Hermes", "hermes"],
      ["aeri", "Aeri", "hermes"],
    ],
  );
  const kept = JSON.parse(readFileSync(join(state, "hermes.json"), "utf8")).profiles;
  assert.deepEqual(
    kept.map((profile: Frame) => [profile.profile, profile.name]),
    [
      ["default", "hermes"],
      ["aeri", "aeri"],
    ],
  );
  // Started again, the bridge has both at once, before Hermes answers.
  assert.deepEqual([...hermesAgents().keys()], ["hermes", "aeri"]);
});

test("a Hermes profile called pi or cursor, on a bridge that runs neither agent, keeps its name and is listed as Hermes's", async () => {
  const usual = hermes.profiles;
  hermes.profiles = [
    ...usual,
    { name: "pi", is_default: false, model: null, provider: null, description: "", display_name: "" },
    { name: "Cursor", is_default: false, model: null, provider: null, description: "", display_name: "" },
  ];
  const cache = join(state, "named.json");
  const named = await startTestBridge({ providers: hermesAgents(cache), config: { generalFolder: cwd } });
  const phone = await TestClient.open(named);
  try {
    await until(() => existsSync(cache));
    // The names are Pi's and Cursor's own on a bridge that runs them, so the app cannot
    // go by the name for whose agent it is: `kind` says.
    assert.deepEqual(
      (await phone.call("profiles.list")).profiles.map((profile: Frame) => [profile.name, profile.display_name, profile.kind]),
      [
        ["hermes", "Hermes", "hermes"],
        ["aeri", "Aeri", "hermes"],
        ["pi", "Pi", "hermes"],
        ["cursor", "Cursor", "hermes"],
      ],
    );
  } finally {
    hermes.profiles = usual;
    await phone.close();
    await named.dispose();
  }
});

test("model.options shows the providers Hermes is signed in to, and config.get its thinking level", async () => {
  const options = await client.call("model.options", { profile: "hermes" });
  assert.deepEqual(options.providers, [{ slug: "gmi", name: "GMI Cloud", models: ["zai-org/GLM-5.3-Flash", "google/gemini-3.8-flash"], authenticated: true }]);
  assert.equal(options.model, "zai-org/GLM-5.3-Flash");
  assert.equal(options.provider, "gmi");
  assert.deepEqual(await client.call("config.get", { key: "reasoning", profile: "hermes" }), { value: "medium" });
  assert.deepEqual(hermes.callsOf("model.options").at(-1)?.params, { profile: "default" });
});

test("session.create makes a Hermes session for the profile, and its stored id is the thread's", async () => {
  const created = await client.call("session.create", { profile: "aeri", source: "tui", cwd, title: "Probe" });
  const call = hermes.callsOf("session.create").at(-1)!;
  assert.deepEqual(call.params, { profile: "aeri", source: "tui", cwd, model: "zai-org/GLM-5.3-Flash", provider: "gmi", reasoning_effort: "medium" });
  assert.ok(hermes.sessions.has(created.session_id));
  assert.equal(created.stored_session_id, created.session_id);
  assert.equal(created.info.cwd, cwd);
  // The title the app gave is Hermes's too.
  await hermes.waitFor(() => hermes.sessions.get(created.session_id)?.title === "Probe");
  await assert.rejects(client.call("session.create", { profile: "hermes", cwd: "/no/such/folder" }), (error: RpcFailure) => error.code === -32602);
});

test("a turn with tools comes through as Hermes sent it, its diffs included, and is kept for session.resume", async () => {
  const thread = await createThread();
  const start = await send(thread, "Create hello.txt, then change hi to hello.", "chat-tools");
  const done = await completed(thread, start);
  assert.equal(done.payload.status, "complete");
  assert.match(done.payload.text, /hello/);
  // What it spent: how far Hermes's session total rose from where session.info said it stood.
  assert.equal(done.payload.turn_usage.tokens, 51_761);
  const events = turnEvents(thread, start);
  assert.equal(events.filter((event) => event.type === "message.start").length, 1);
  const tools = events.filter((event) => event.type === "tool.complete").map((event) => event.payload);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["write_file", "read_file", "patch"],
  );
  // write_file's diff is only in Hermes's terminal form, which the app reads.
  assert.match(tools[0].inline_diff, /review diff/);
  assert.equal(tools[2].result.success, true);
  // Every event has the bridge's own seq, from 1 on.
  const seqs = events.map((event) => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  const prompt = hermes.callsOf("prompt.submit").at(-1)!;
  assert.deepEqual(prompt.params, { session_id: hermes.sessions.get(thread)!.runtime, text: "Create hello.txt, then change hi to hello.", profile: "default" });

  const resumed = await client.call("session.resume", { session_id: thread, profile: "hermes" });
  assert.equal(resumed.running, false);
  const roles = resumed.messages.map((message: Frame) => (message.role === "tool" ? `tool:${message.name}` : message.role));
  assert.deepEqual(roles.slice(0, 4), ["user", "tool:write_file", "tool:read_file", "tool:patch"]);
  assert.match(resumed.messages[1].display_metadata.tool_result_metadata.inline_diff, /review diff/);
  assert.equal(resumed.messages.at(-1).role, "assistant");
});

test("an approval goes to the phone, its answer back to Hermes, and it notifies", async () => {
  const thread = await createThread();
  // A device that wants to hear about the thread.
  const cookie = await sessionCookie(bridge);
  const registered = await fetch(`${bridge.url}/api/plugins/aeriportal-push/registration`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ device: { token: "ab".repeat(32), environment: "sandbox", bundle_id: "com.danielou.portals" }, threads: [{ id: thread, agent: "hermes", agent_name: "Hermes", title: "" }] }),
  });
  assert.equal(registered.status, 200);

  const start = await send(thread, "Run the approval test.", "chat-approval-denied");
  const request = await client.from(start, (frame) => frame.method === "approval");
  assert.match(request.params.command, /rm -rf \/nonexistent-aeriportal-approval-test/);
  assert.equal(request.params.description, "delete in root path");
  assert.deepEqual(request.params.choices, ["once", "session", "always", "deny"]);
  client.send({ jsonrpc: "2.0", id: request.id, result: { choice: "deny" } });
  assert.deepEqual((await hermes.waitFor(() => hermes.answers.has("srq-cf5bad148214")), hermes.answers.get("srq-cf5bad148214")?.result), { choice: "deny" });
  // As captured, the model then failed on the denied result; Hermes said why, and not to retry.
  const done = await completed(thread, start);
  assert.equal(done.payload.status, "error");
  assert.match(done.payload.text, /GMI Cloud rejected this request/);
  assert.deepEqual(done.payload.error_surface, { retryable: false });

  // The approval was notified, and so was the end of the turn.
  const sent = () => (existsSync(join(state, "push.jsonl")) ? readFileSync(join(state, "push.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  await until(() => sent().filter((line) => line.payload.aeriportal.thread === thread).length >= 2);
  const kinds = sent().filter((line) => line.payload.aeriportal.thread === thread).map((line) => line.payload.aeriportal.kind);
  assert.deepEqual(kinds, ["approval", "failed"]);
});

test("a question goes to the phone and its answer back to Hermes", async () => {
  const thread = await createThread();
  const start = await send(thread, "Ask me which language to use.", "chat-clarify");
  const request = await client.from(start, (frame) => frame.method === "clarify");
  assert.deepEqual(request.params.questions, [{ qid: "q0", question: "Which language should I use?", choices: ["Python (Recommended)", "Swift"], multi_select: false }]);
  client.send({ jsonrpc: "2.0", id: request.id, result: { answers: { q0: "Swift" } } });
  const done = await completed(thread, start);
  assert.equal(done.payload.text.trim(), "You chose Swift.");
  assert.deepEqual(hermes.answers.get("srq-b050e16811aa")?.result, { answers: { q0: "Swift" } });
});

test("stopping a turn interrupts it in Hermes, and the turn ends interrupted", async () => {
  const thread = await createThread();
  const start = await send(thread, "Count slowly to a hundred.", "chat-interrupt");
  await client.from(start, (frame) => isEvent(frame, "thinking.delta", thread));
  assert.deepEqual(await client.call("session.interrupt", { session_id: thread, profile: "hermes" }), { status: "interrupted" });
  const done = await completed(thread, start);
  assert.equal(done.payload.status, "interrupted");
  assert.equal(hermes.callsOf("session.interrupt").at(-1)?.params.session_id, hermes.sessions.get(thread)!.runtime);
});

test("a stop Hermes takes but never ends the turn after is ended for the app after a grace, as Codex's is, and the thread is at work until Hermes is done with it", async () => {
  const agents = new Map<string, Provider>();
  new HermesHost({
    settings: { path: "/nonexistent/hermes", start: false, folder: cwd, logPath: join(state, "hermes-serve.log") },
    cachePath: join(state, "hermes-grace.json"),
    connect: hermes.connector(),
    backoff: [0.05, 0.1],
    // Threads made one after another, as before each profile kept one (test/hermes-bot-chat.test.ts).
    oneThread: false,
    interruptGraceMs: 200,
  }).addTo(agents);
  const graced = await startTestBridge({ providers: agents, config: { generalFolder: cwd } });
  const phone = await TestClient.open(graced);
  try {
    const thread = await createThread({}, phone);
    // Hermes answers the stop, and then says nothing more of the turn.
    hermes.queueTurn(thread, "chat-interrupt", [], "session.interrupt");
    const start = phone.frames.length;
    assert.equal((await phone.call("prompt.submit", { session_id: thread, text: "Count slowly to a hundred.", profile: "hermes" })).status, "streaming");
    await phone.from(start, (frame) => isEvent(frame, "thinking.delta", thread));
    assert.deepEqual(await phone.call("session.interrupt", { session_id: thread, profile: "hermes" }), { status: "interrupted" });
    const done = (await phone.from(start, (frame) => isEvent(frame, "message.complete", thread), 3000)).params;
    assert.equal(done.payload.status, "interrupted");
    // Hermes still lists it at work: the thread is, and cannot be removed.
    hermes.active = [{ session_key: thread, status: "working" }];
    await assert.rejects(phone.call("thread.delete", { thread }), (error: RpcFailure) => /still working/.test(error.message));
    // Done in Hermes: it can.
    hermes.active = [];
    assert.deepEqual(await phone.call("thread.delete", { thread }), {});
  } finally {
    hermes.active = [];
    await phone.close();
    await graced.dispose();
  }
});

test("a turn Hermes cannot run fails with its reason", async () => {
  const thread = await createThread();
  const start = await send(thread, "Hello", "chat-no-provider");
  const done = await completed(thread, start);
  assert.equal(done.payload.status, "error");
  assert.match(done.payload.text, /not connected to any AI provider/);
});

test("/mcp says how the profile's MCP servers are, as Hermes last found them; a Hermes from before that says it cannot", async () => {
  const created = await client.call("session.create", { profile: "aeri", source: "tui", cwd });
  const thread = created.session_id as string;
  const mcp = async () => (await client.call("slash.exec", { session_id: thread, command: "mcp", profile: "aeri" })).output as string;
  const catalog = await client.call("commands.catalog", { session_id: thread, profile: "aeri" });
  assert.ok(catalog.pairs.some(([name]: [string]) => name === "/mcp"));
  hermes.mcpServers = [
    { name: "docs", transport: "stdio", tools: 3, connected: true, disabled: false, status: "connected", source: "config", plugin: null },
    { name: "web", transport: "http", tools: 0, connected: false, disabled: false, status: "failed", source: "config", plugin: null },
    { name: "notes", transport: "stdio", tools: 0, connected: false, disabled: false, status: "lazy", source: "plugin", plugin: "notes" },
    { name: "old", transport: "stdio", tools: 0, connected: false, disabled: true, status: "disabled", source: "config", plugin: null },
    { name: "new", transport: "stdio", tools: 0, connected: false, disabled: false, status: "configured", source: "config", plugin: null },
  ];
  try {
    assert.equal(await mcp(), ["Aeri MCP servers:", "docs: connected, 3 tools", "new: not started", "notes: starts when first used", "old: off", "web: failed"].join("\n"));
    assert.deepEqual(hermes.callsOf("mcp.servers.status").at(-1)!.params, { profile: "aeri" });
    hermes.mcpServers = null;
    await assert.rejects(mcp(), /This Hermes cannot say how its MCP servers are: a newer one can\./);
  } finally {
    hermes.mcpServers = [];
  }
});

test("model and thinking level change for the thread only, through Hermes's own /model", async () => {
  const thread = await createThread();
  assert.deepEqual(await client.call("config.set", { key: "model", value: "google/gemini-3.8-flash --provider gmi --session", session_id: thread, profile: "hermes" }), {});
  const runtime = hermes.sessions.get(thread)!.runtime;
  assert.deepEqual(hermes.callsOf("config.set").at(-1)?.params, {
    session_id: runtime,
    key: "model",
    value: "google/gemini-3.8-flash --provider gmi --session",
    confirm_expensive_model: true,
    profile: "default",
  });
  await client.call("config.set", { key: "reasoning", value: "high", session_id: thread, profile: "hermes" });
  assert.deepEqual(hermes.callsOf("config.set").at(-1)?.params, { session_id: runtime, key: "reasoning", value: "high", profile: "default" });
  assert.equal((await client.call("session.resume", { session_id: thread, profile: "hermes" })).info.reasoning_effort, "high");
});

test("after the connection to Hermes drops, a thread is followed again when it is next used", async () => {
  const thread = await createThread();
  const before = hermes.connectionCountSoFar;
  hermes.dropAll();
  await hermes.waitFor(() => hermes.connectionCountSoFar > before);
  const start = await send(thread, "Hello again", "chat-text-complete");
  const done = await completed(thread, start);
  assert.equal(done.payload.status, "complete");
  // Resumed on the new connection before the message went.
  const resume = hermes.callsOf("session.resume").filter((call) => call.params.session_id === thread).at(-1);
  assert.ok(resume && resume.connection > before);
});

test("when Hermes itself restarts during a turn, the turn ends interrupted and says why", async () => {
  const thread = await createThread();
  // A turn that waits for a stop that never comes.
  const start = await send(thread, "Count slowly to a hundred.", "chat-interrupt");
  await client.from(start, (frame) => isEvent(frame, "thinking.delta", thread));
  hermes.restart();
  const done = await completed(thread, start);
  assert.equal(done.payload.status, "interrupted");
  const notice = turnEvents(thread, start).find((event) => event.type === "status.update" && event.payload.kind === "warn");
  assert.match(notice?.payload.text, /Hermes restarted before it finished this turn/);
  // Followed on the new run, under a new runtime id.
  assert.notEqual(hermes.sessions.get(thread)!.runtime, "");
});

test("after a restart the bridge follows a thread Hermes is still running, and the open approval is asked again", async () => {
  // A thread the bridge made before it stopped, which Hermes runs and waits on now.
  const stored = "20261004_232141_0156b5";
  hermes.addSession(stored);
  hermes.active = [{ session_key: stored, status: "waiting" }];
  hermes.queueResume(stored, "reattach-approval", ["session.events.since"]);
  const first = await startTestBridge({ providers: new Map(), config: { generalFolder: cwd }, keepHome: true });
  await first.dispose();
  new Registry(join(first.home, "state", "threads.json")).add({
    id: stored,
    agent: "hermes",
    cwd,
    title: "Run rm -rf approval test command",
    model: "zai-org/GLM-5.3-Flash",
    provider: "gmi",
    reasoningEffort: "",
    createdAt: 1791181301,
    updatedAt: 1791181301,
    origin: "phone",
  });
  const restarted = await startTestBridge({ home: first.home, providers: hermesAgents(join(first.home, "hermes.json")) });
  // Followed from the start: the approval is waiting before the phone is back.
  await hermes.waitFor(() => hermes.callsOf("session.resume").some((call) => call.params.session_id === stored));
  const phone = await TestClient.open(restarted);
  try {
    const resumed = await phone.call("session.resume", { session_id: stored, profile: "hermes" });
    assert.equal(resumed.running, true);
    assert.equal(resumed.open_requests.length, 1);
    assert.equal(resumed.open_requests[0].method, "approval");
    const start = phone.frames.length;
    phone.send({ jsonrpc: "2.0", id: resumed.open_requests[0].id, result: { choice: "deny" } });
    const done = await completed(stored, start, phone);
    assert.equal(done.payload.status, "complete");
    assert.deepEqual(hermes.answers.get("srq-faf23295555f")?.result, { choice: "deny" });
  } finally {
    await phone.close();
    await restarted.dispose();
  }
});

test("after a restart an agent slow to say which threads it runs does not hold up following Hermes's, which Hermes interrupts 20 s after its client went", async () => {
  const stored = "20261026_150500_51ow00";
  hermes.addSession(stored);
  hermes.active = [{ session_key: stored, status: "waiting" }];
  hermes.queueResume(stored, "reattach-approval", ["session.events.since"]);
  const first = await startTestBridge({ providers: new Map(), config: { generalFolder: cwd }, keepHome: true });
  await first.dispose();
  const registry = new Registry(join(first.home, "state", "threads.json"));
  const base = { cwd, model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1791181301, updatedAt: 1791181301, origin: "phone" } as const;
  registry.add({ ...base, id: "slow-thread", agent: "fake", title: "Slow" });
  registry.add({ ...base, id: stored, agent: "hermes", title: "Run rm -rf approval test command", model: "zai-org/GLM-5.3-Flash", provider: "gmi" });
  // An agent the bridge asks first, which takes as long to answer as Codex may (its 15 s wait for a connection).
  let answer: (ids: string[]) => void = () => {};
  const slow = Object.assign(new FakeProvider({ directory: join(first.home, "fake"), delayMs: 0 }), {
    liveThreads: () => new Promise<string[]>((resolve) => (answer = resolve)),
  });
  const providers = new Map<string, Provider>([["fake", slow], ...hermesAgents(join(first.home, "hermes.json"))]);
  const restarted = await startTestBridge({ home: first.home, providers });
  try {
    await hermes.waitFor(() => hermes.callsOf("session.resume").some((call) => call.params.session_id === stored), 1500);
  } finally {
    answer([]);
    await restarted.dispose();
  }
});

test("after a restart the threads Hermes runs are taken up at once, so one slow to resume does not hold up the others, which Hermes interrupts 20 s after their client went", async () => {
  const slow = "20261026_154500_510w00";
  const quick = "20261026_154501_9u1c00";
  hermes.addSession(slow);
  hermes.addSession(quick);
  hermes.active = [{ session_key: slow, status: "working" }, { session_key: quick, status: "working" }];
  const first = await startTestBridge({ providers: new Map(), config: { generalFolder: cwd }, keepHome: true });
  await first.dispose();
  const registry = new Registry(join(first.home, "state", "threads.json"));
  const base = { agent: "hermes", cwd, model: "zai-org/GLM-5.3-Flash", provider: "gmi", reasoningEffort: "", createdAt: 1791181301, updatedAt: 1791181301, origin: "phone" } as const;
  registry.add({ ...base, id: slow, title: "Slow" });
  registry.add({ ...base, id: quick, title: "Quick" });
  // The first resume answers only once the other has been asked for.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  hermes.onResume = (params) => (params.session_id === slow ? held : undefined);
  const restarted = await startTestBridge({ home: first.home, providers: hermesAgents(join(first.home, "hermes.json")) });
  try {
    await hermes.waitFor(() => hermes.callsOf("session.resume").some((call) => call.params.session_id === quick), 1500);
  } finally {
    release();
    hermes.onResume = () => {};
    hermes.active = [];
    await restarted.dispose();
  }
});
