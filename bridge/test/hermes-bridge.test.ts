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
let agents: Map<string, Provider>;
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
  agents = hermesAgents();
  bridge = await startTestBridge({ providers: agents, config: { generalFolder: cwd, push: { dryRun: join(state, "push.jsonl") } } });
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

test("Hermes's commands are offered but for those that change its settings: one that shows something runs in the thread's session, and /plan or a skill goes as the message Hermes makes of it", async () => {
  const thread = await createThread();
  const catalog = await client.call("commands.catalog", { session_id: thread, profile: "hermes" });
  const offered = catalog.pairs.map((pair: string[]) => pair[0]);
  for (const name of ["/status", "/mode", "/usage", "/compress", "/context", "/plan", "/tidy"]) assert.ok(offered.includes(name), name);
  for (const name of ["/model", "/yolo", "/agents"]) assert.ok(!offered.includes(name), `${name} is not offered`);
  assert.deepEqual(Object.keys(catalog.skills), ["/tidy"]);

  const runtime = hermes.sessions.get(thread)!.runtime;
  assert.deepEqual(await client.call("slash.exec", { session_id: thread, command: "/context", profile: "hermes" }), { type: "exec", output: "Hermes ran /context" });
  assert.deepEqual(hermes.callsOf("slash.exec").at(-1)?.params, { session_id: runtime, command: "/context", profile: "default" });
  // Not one of the bridge's, nor one that shows something: the app sends it as a message.
  await assert.rejects(client.call("slash.exec", { session_id: thread, command: "/yolo", profile: "hermes" }), (error: RpcFailure) => error.code === 4018);
  assert.deepEqual(await client.call("command.dispatch", { session_id: thread, name: "plan", arg: "the move", profile: "hermes" }), { type: "send", message: "/plan the move" });

  const dispatched = hermes.callsOf("command.dispatch").length;
  for (const [line, name, arg] of [["/plan the move", "plan", "the move"], ["/tidy", "tidy", ""]]) {
    const each = await createThread();
    await completed(each, await send(each, line, "chat-text-complete"));
    assert.deepEqual(hermes.callsOf("command.dispatch").at(-1)?.params, { session_id: hermes.sessions.get(each)!.runtime, name, arg, profile: "default" });
    assert.equal(hermes.callsOf("prompt.submit").at(-1)?.params.text, `[the ${name} prompt] ${arg}`.trim());
  }
  // One Hermes would only take as a setting is the user's words.
  const words = await createThread();
  await completed(words, await send(words, "/yolo please", "chat-text-complete"));
  assert.equal(hermes.callsOf("command.dispatch").length, dispatched + 2);
  assert.equal(hermes.callsOf("prompt.submit").at(-1)?.params.text, "/yolo please");
});

test("a Hermes thread's modes are its profile's approvals or Hermes's yolo for that session alone, and one changed in another Hermes app is shown", async () => {
  const options = await client.call("model.options", { profile: "hermes" });
  assert.deepEqual(options.modes, {});
  assert.deepEqual(options.mode_options.map((option: Frame) => option.id), ["default", "full"]);
  const thread = await createThread();
  const runtime = hermes.sessions.get(thread)!.runtime;
  assert.equal((await client.call("session.set_mode", { session_id: thread, mode: "full", profile: "hermes" })).mode, "full");
  assert.deepEqual(hermes.callsOf("config.set").at(-1)?.params, { session_id: runtime, key: "yolo", value: "on", scope: "session", profile: "default" });
  assert.equal(hermes.yolo.get(runtime), true);
  await assert.rejects(client.call("session.set_mode", { session_id: thread, mode: "plan", profile: "hermes" }));

  const start = client.frames.length;
  hermes.tell(thread, "session.info", { yolo: false });
  const changed = await client.from(start, (frame) => isEvent(frame, "session.mode", thread));
  assert.equal(changed.params.payload.mode, "default");
});

test("the children Hermes's delegate_task starts are on the subagents line, and one is stopped by itself", async () => {
  const thread = await createThread();
  const start = client.frames.length;
  const child = { goal: "Count the files", task_count: 1, task_index: 0, subagent_id: "sa-0-1", depth: 0, model: "m" };
  hermes.tell(thread, "subagent.spawn_requested", child);
  hermes.tell(thread, "subagent.tool", { ...child, tool_name: "terminal", text: "ls | wc -l", tool_count: 1 });
  const tool = await client.from(start, (frame) => isEvent(frame, "subagent.progress", thread) && frame.params.payload.tool_name === "terminal");
  assert.equal(tool.params.payload.summary, "ls | wc -l");
  const listed = (await client.call("subagent.list", { session_id: thread, profile: "hermes" })).subagents;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].goal, "Count the files");
  assert.equal(listed[0].background, true);
  assert.equal(listed[0].can_stop, true);

  assert.equal((await client.call("subagent.stop", { session_id: thread, subagent_id: "sa-0-1", profile: "hermes" })).status, "stopped");
  assert.deepEqual(hermes.callsOf("subagent.interrupt").at(-1)?.params, { session_id: hermes.sessions.get(thread)!.runtime, subagent_id: "sa-0-1", profile: "default" });
  hermes.tell(thread, "subagent.complete", { ...child, status: "interrupted", summary: "Stopped after 3 files", input_tokens: 10, output_tokens: 5 });
  const ended = await client.from(start, (frame) => isEvent(frame, "subagent.complete", thread));
  assert.equal(ended.params.payload.status, "stopped");
  assert.equal(ended.params.payload.result, "Stopped after 3 files");
  assert.equal(ended.params.payload.tokens, 15);
  assert.equal((await client.call("subagent.stop", { session_id: thread, subagent_id: "sa-0-1", profile: "hermes" })).status, "not_running");
});

test("the children of a delegation Hermes recorded are on the subagents line with what each answered", async () => {
  const thread = await createThread();
  // The app asked Hermes for its list of children mid-turn; the bridge keeps its own.
  hermes.queueTurn(thread, "chat-delegation", ["subagent.list"]);
  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: thread, text: "Run two commands in two subagents.", profile: "hermes" });
  await completed(thread, start);
  const listed = (await client.call("subagent.list", { session_id: thread, profile: "hermes" })).subagents;
  assert.deepEqual(listed.map((child: Frame) => [child.subagent_id, child.status, child.model, child.tokens, child.tool_uses]), [
    ["sa-1-ac781d0b", "completed", "zai-org/GLM-5.3-Flash", 23_843, 1],
    ["sa-0-9b664774", "completed", "zai-org/GLM-5.3-Flash", 23_845, 1],
  ]);
  assert.match(listed[1].goal, /sleep 6 && echo alpha/);
  assert.match(listed[1].result, /alpha/);
  // A child's reasoning is not its row's line.
  assert.ok(!turnEvents(thread, start).some((event) => event.type.startsWith("subagent.") && /ruminating|reflecting/.test(String(event.payload.summary))));
});

test("a Hermes thread's limits are those of its model provider as Hermes's model picker shows them, and a Nous plan's gauges and credits", async () => {
  const thread = await createThread();
  const kept = hermes.modelOptions;
  try {
    const providers = kept.providers as Frame[];
    hermes.modelOptions = {
      ...kept,
      providers: [
        { ...providers[0], usage: { windows: [{ label: "Weekly", used_percent: 2, resets_at: "2026-11-11T06:35:49+00:00", scope: "account" }, { label: "Session", used_percent: 100, resets_at: null }] } },
        { slug: "nous", name: "Nous Portal", models: ["m"], authenticated: true, plan_usage: { kind: "window", plan: "plus", gauges: [{ label: "day", left_fraction: 0.25, style: "bar", resets_at_ms: 1_762_000_000_000 }, { label: "burst", title: "Burst", left_fraction: 0, style: "bar" }] } },
      ],
    };
    const hermesAgent = agents.get("hermes")!;
    assert.deepEqual(await hermesAgent.usage!(thread), {
      limits: [
        { name: "Weekly", percent: 2, resetsAt: Date.parse("2026-11-11T06:35:49+00:00") / 1000 },
        { name: "Session", percent: 100, resetsAt: null, reached: true },
      ],
    });
    hermes.modelOptions = { ...hermes.modelOptions, provider: "nous" };
    hermes.usageBars = { ok: true, available: true, plan_name: "plus", plan_bar: { kind: "plan", pct_used: 40, remaining_display: "$6.00", total_display: "$10.00", spent_display: "$4.00", fill_fraction: 0.4 }, renews_at: "2026-12-01T00:00:00Z", total_spendable_display: "$8.50" };
    assert.deepEqual(await hermesAgent.usage!("a thread not open here"), {
      plan: "plus",
      limits: [
        { name: "daily", percent: 75, resetsAt: 1_762_000_000 },
        { name: "Burst", percent: 100, resetsAt: null, reached: true },
        { name: "credits", percent: 40, resetsAt: Date.parse("2026-12-01T00:00:00Z") / 1000 },
      ],
      note: "$8.50 of credits left.",
    });
    hermes.modelOptions = kept;
    assert.deepEqual(await hermesAgent.usage!(thread), { limits: [], note: "Hermes shows no usage limits for GMI Cloud." });
  } finally {
    hermes.modelOptions = kept;
    hermes.usageBars = { ok: true, available: false };
  }
});
