import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenCodeSession } from "../src/providers/opencode/session.ts";
import { OpenCodeInbox } from "../src/providers/opencode/inbox.ts";
import { OpenCodeSubagents } from "../src/providers/opencode/subagents.ts";
import { OpenCodeProvider } from "../src/providers/opencode/provider.ts";
import { FakeOpenCode } from "./opencode-serve.ts";
import type { OpenCodeApi } from "../src/providers/opencode/client.ts";
import type { Message, OpenCodeEvent, PermissionRequest, SessionInfo } from "../src/providers/opencode/protocol.ts";
import type { ProviderEvent, SessionSink } from "../src/providers/types.ts";
import { log } from "../src/log.ts";

const id = "ses_review";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const user = (name = "u1", text = "Question"): Message => ({ type: "user", id: name, text, time: { created: 1 } });
const reply = (text: string): Message => ({ type: "assistant", id: "a1", content: [{ type: "text", text }], time: { created: 2 } });
const idle = (): Message => ({ type: "idle", id: "i1", outcome: "succeeded", time: { created: 3 } });
const event = (type: string, data: object = {}): OpenCodeEvent => ({ id: "evt_review", type, data: { sessionID: id, ...data } });

async function rig() {
  const events: ProviderEvent[] = [];
  const sink: SessionSink = { emit: (e) => events.push(e), ask: async () => ({ kind: "withdrawn", reason: "unused" }) };
  const api = {
    prompt: async () => ({ id: "u1" }),
    sessions: async () => [],
    active: async () => new Set<string>(),
    messages: async () => [] as Message[],
    inbox: async () => [],
    pendingPermissions: async () => [] as PermissionRequest[],
    forms: async () => [],
    session: async () => ({ id, outcome: "succeeded", time: { created: 1, updated: 3 } }),
    interrupt: async () => false,
    cancelInbox: async () => {},
    commands: async () => [] as { name: string }[],
    command: async () => {},
    replyPermission: async () => {},
  };
  const host = { api: async () => api as unknown as OpenCodeApi, bind() {}, forget() {}, contextOf() { return 1000; }, levelsOf() { return []; } };
  const session = new OpenCodeSession(
    { id, cwd: "/tmp", settings: { model: "m", provider: "p", reasoningEffort: "" } },
    sink,
    host,
    { info: { id, time: { created: 1, updated: 1 } }, messages: [], running: false },
  );
  session.attached();
  await tick();
  return { session, api, sink, events, host };
}

test("review: REST catch-up must precede post-reconnect deltas", async () => {
  const r = await rig();
  r.session.startTurn({ text: "Question", images: [] });
  await tick();
  r.session.event(event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "A" }));
  const entered = deferred<void>(), messages = deferred<Message[]>();
  r.api.active = async () => new Set([id]);
  r.api.messages = () => { entered.resolve(); return messages.promise; };
  r.session.reconnected();
  await entered.promise;
  // B was generated during the outage. C is live while the REST request is in flight.
  r.session.event(event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "C" }));
  messages.resolve([user(), reply("ABC")]);
  await r.session.catchingUp();
  r.session.event(event("session.text.ended", { assistantMessageID: "a1", ordinal: 0, text: "ABC" }));
  r.session.event(event("session.execution.succeeded"));
  await r.session.close();
  assert.equal(r.events.filter((e) => e.type === "text").map((e) => e.text).join(""), "ABC");
});

test("review: completion during REST catch-up must not open a phantom turn", async () => {
  const r = await rig();
  r.session.startTurn({ text: "Question", images: [] });
  await tick();
  const entered = deferred<void>(), messages = deferred<Message[]>();
  r.api.active = async () => new Set([id]);
  r.api.messages = () => { entered.resolve(); return messages.promise; };
  r.session.reconnected();
  await entered.promise;
  r.session.event(event("session.text.ended", { assistantMessageID: "a1", ordinal: 0, text: "ABC" }));
  r.session.event(event("session.execution.succeeded"));
  messages.resolve([user(), reply("ABC"), idle()]);
  await r.session.catchingUp();
  await r.session.close();
  assert.equal(r.events.filter((e) => e.type === "turn.begin").length, 0);
});

test("review: a desk turn fully completed during an outage must be recovered", async () => {
  const r = await rig();
  r.api.messages = async () => [user(), reply("Completed while offline"), idle()];
  r.session.reconnected();
  await r.session.catchingUp();
  await r.session.close();
  assert.equal(r.events.filter((e) => e.type === "text").map((e) => e.text).join(""), "Completed while offline");
});

test("review: a late receipt after a no-op DELETE must reconcile the returned message", async () => {
  const events: ProviderEvent[] = [];
  const api = { prompt: async () => ({ id: "msg_portals-one" }), cancelInbox: async () => {} } as unknown as OpenCodeApi;
  const sink: SessionSink = { emit: (e) => events.push(e), ask: async () => ({ kind: "withdrawn", reason: "" }) };
  const inbox = new OpenCodeInbox(id, async () => api, sink, [], []);
  const prompt = { text: "Do the work once", images: [] };
  await inbox.add(prompt, "portals-one", []);
  // Native API: cancellation of already-delivered input is a successful no-op.
  // Its delivery event has not reached the bridge when DELETE's response arrives.
  assert.equal(await inbox.delete("portals-one"), true);
  inbox.delivered("msg_portals-one");
  assert.deepEqual(events, [{ type: "queue.taken", requestId: "portals-one", prompt }]);
});

test("review: child completion missed during outage must withdraw its pending form", async () => {
  let signal: AbortSignal | undefined;
  const sink: SessionSink = {
    emit() {},
    ask: async (_card, supplied) => {
      signal = supplied;
      return new Promise((resolve) => supplied!.addEventListener("abort", () => resolve({ kind: "withdrawn", reason: "" }), { once: true }));
    },
  };
  const child: SessionInfo = { id: "ses_child", parentID: id, time: { created: 1, updated: 1 } };
  const api = { sessions: async (_wanted: number, parent: string) => parent === id ? [{ ...child, outcome: "succeeded" }] : [], active: async () => new Set<string>(), forms: async () => [] } as unknown as OpenCodeApi;
  const agents = new OpenCodeSubagents(id, async () => api, sink, () => {}, [], [child], new Set([child.id]));
  agents.event({ id: "evt_form", type: "form.created", data: { form: { id: "frm_child", sessionID: child.id, title: "Question", fields: [{ type: "string", key: "answer" }] } } });
  assert.ok(signal);
  await agents.reconcile();
  const withdrawn = signal.aborted;
  agents.close();
  assert.equal(withdrawn, true);
});

test("review: Stop during prompt admission must cancel the admitted input", async () => {
  const r = await rig();
  const entered = deferred<void>(), admission = deferred<{ id: string }>();
  const cancellations: string[] = [];
  r.api.prompt = () => { entered.resolve(); return admission.promise; };
  r.api.cancelInbox = async (_sessionID?: string, inboxID?: string) => { cancellations.push(inboxID!); };
  r.session.startTurn({ text: "Question", images: [] });
  await entered.promise;
  await r.session.interrupt();
  admission.resolve({ id: "u1" });
  await tick();
  await r.session.close();
  assert.deepEqual(cancellations, ["u1"]);
});

test("review: closing a session while waiting for an API must not submit afterward", async () => {
  const r = await rig();
  const connected = deferred<OpenCodeApi>();
  let submitted = 0;
  r.host.api = () => connected.promise;
  r.api.prompt = async () => { submitted += 1; return { id: "u1" }; };
  r.session.startTurn({ text: "Do not run after shutdown", images: [] });
  await r.session.close();
  connected.resolve(r.api as unknown as OpenCodeApi);
  await tick();
  assert.equal(submitted, 0);
});

test("review: models sharing an ID must not overwrite another provider's variants", async () => {
  const fake = await FakeOpenCode.start();
  const provider = new OpenCodeProvider({ settings: { path: "/nonexistent/opencode", mode: "shared", start: false, folder: "/tmp", logPath: "/tmp/unused-review.log" }, locate: async () => fake.endpoint() });
  try {
    const catalog = await provider.models();
    // The existing stand-in includes anthropic/claude-sonnet-5 with high/max,
    // and opencode/claude-sonnet-5 without variants.
    assert.ok(catalog.levels?.["anthropic/claude-sonnet-5"]?.includes("high"));
    assert.deepEqual(catalog.levels?.["opencode/claude-sonnet-5"], []);
    assert.ok(catalog.names?.["anthropic/claude-sonnet-5"]);
    assert.ok(catalog.names?.["opencode/claude-sonnet-5"]);
  } finally {
    await provider.close();
    await fake.close();
  }
});

test("review: context usage includes separate native reasoning tokens", async () => {
  const r = await rig();
  r.session.startTurn({ text: "Question", images: [] });
  await tick();
  r.session.event(event("session.step.ended", { tokens: { input: 100, output: 10, reasoning: 50, cache: { read: 20, write: 0 } } }));
  r.session.event(event("session.execution.succeeded"));
  const done = r.events.find((e) => e.type === "turn.end");
  await r.session.close();
  assert.equal(done?.type === "turn.end" ? done.usage?.used : undefined, 180);
});

test("review: child tool names come from native input.started, not tool.called", () => {
  const events: ProviderEvent[] = [];
  const child: SessionInfo = { id: "ses_child", parentID: id, time: { created: 1, updated: 1 } };
  const agents = new OpenCodeSubagents(id, async () => ({} as OpenCodeApi), { emit: (e) => events.push(e), ask: async () => ({ kind: "withdrawn", reason: "" }) }, () => {}, [], [child], new Set([child.id]));
  agents.event({ id: "evt_started", type: "session.tool.input.started", data: { sessionID: child.id, assistantMessageID: "a1", id: "call1", name: "shell" } });
  agents.event({ id: "evt_called", type: "session.tool.called", data: { sessionID: child.id, assistantMessageID: "a1", id: "call1", input: { command: "echo hello" }, executed: false } });
  agents.close();
  const latest = events.at(-1);
  assert.equal(latest?.type === "subagent" ? latest.subagent.tool : undefined, "terminal");
});

test("review: loading snapshots must not lose completion before event binding", async () => {
  const fake = await FakeOpenCode.start();
  fake.addSession({ id, location: { directory: "/tmp" } }, [user()]);
  fake.active.add(id);
  const entered = deferred<void>(), release = deferred<void>();
  const original = fake.server.listeners("request")[0] as (...args: any[]) => void;
  fake.server.removeAllListeners("request");
  fake.server.on("request", (req, res) => {
    if (req.url?.startsWith("/api/agent")) {
      entered.resolve();
      void release.promise.then(() => original(req, res));
    } else original(req, res);
  });
  const provider = new OpenCodeProvider({ settings: { path: "/nonexistent/opencode", mode: "shared", start: false, folder: "/tmp", logPath: "/tmp/unused-review.log" }, locate: async () => fake.endpoint(), backoff: [0.01] });
  const routed = deferred<void>();
  const originalRoute = (provider as any).route.bind(provider);
  (provider as any).route = (received: OpenCodeEvent) => {
    originalRoute(received);
    if (received.type === "session.execution.succeeded") routed.resolve();
  };
  const events: ProviderEvent[] = [];
  let session: OpenCodeSession | undefined;
  try {
    const loading = provider.resumeSession({ id, cwd: "/tmp", settings: { model: "m", provider: "p", reasoningEffort: "" } }, { emit: (e) => events.push(e), ask: async () => ({ kind: "withdrawn", reason: "" }) });
    await entered.promise;
    fake.sessions.get(id)!.messages = [user(), reply("Finished during load"), idle()];
    fake.sessions.get(id)!.info.outcome = "succeeded";
    fake.active.delete(id);
    fake.emit(event("session.text.ended", { assistantMessageID: "a1", ordinal: 0, text: "Finished during load" }));
    fake.emit(event("session.execution.succeeded"));
    // Observe the actual client route before allowing the constructor to bind.
    await routed.promise;
    release.resolve();
    session = await loading as OpenCodeSession;
    const running = session.attached();
    await session.catchingUp();
    await tick();
    assert.ok(running === null || events.some((e) => e.type === "turn.end"), "native completion must not leave an attached running turn");
  } finally {
    release.resolve();
    await session?.close();
    await provider.close();
    await fake.close();
  }
});

test("after catch-up only the interrupted piece uses REST; new text and reasoning stream during its refresh", async () => {
  const r = await rig();
  r.session.startTurn({ text: "Question", images: [] });
  await tick();
  r.session.event(event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "A" }));
  r.api.messages = async () => [user(), reply("ABC")];
  r.api.active = async () => new Set([id]);
  r.session.reconnected();
  await r.session.catchingUp();
  const entered = deferred<void>(), snapshot = deferred<Message[]>();
  r.api.messages = () => { entered.resolve(); return snapshot.promise; };
  r.session.event(event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "C" }));
  await entered.promise;
  r.session.event(event("session.text.started", { assistantMessageID: "a2", ordinal: 0 }));
  r.session.event(event("session.text.delta", { assistantMessageID: "a2", ordinal: 0, delta: "D" }));
  r.session.event(event("session.reasoning.delta", { assistantMessageID: "a2", ordinal: 0, delta: "New thought" }));
  r.session.event(event("session.tool.input.started", { id: "call_new", name: "shell" }));
  r.session.event(event("session.tool.called", { id: "call_new", input: { command: "echo live" } }));
  assert.equal(r.events.filter((e) => e.type === "text").map((e) => e.text).join(""), "ABCD");
  assert.equal(r.events.filter((e) => e.type === "reasoning").map((e) => e.text).join(""), "New thought");
  assert.ok(r.events.some((e) => e.type === "tool.start" && e.name === "terminal"));
  snapshot.resolve([user(), reply("ABC"), { ...reply("D"), id: "a2" }]);
  await r.session.catchingUp();
  r.session.event(event("session.text.delta", { assistantMessageID: "a2", ordinal: 0, delta: "E" }));
  assert.equal(r.events.filter((e) => e.type === "text").map((e) => e.text).join(""), "ABCDE");
  await r.session.close();
});

test("an inactive crashed turn without a durable outcome is an error, never successful empty completion", async () => {
  const r = await rig();
  r.session.startTurn({ text: "Question", images: [] });
  await tick();
  r.api.messages = async () => [user(), reply("Partial")];
  r.session.reconnected();
  await r.session.catchingUp();
  const done = r.events.find((e) => e.type === "turn.end");
  assert.equal(done?.type === "turn.end" && done.status, "error");
  assert.match(done?.type === "turn.end" ? done.error ?? "" : "", /crashed or restarted/);
  await r.session.close();
});

test("several completed offline desk turns replay once, in order, across repeated recovery", async () => {
  const r = await rig();
  r.api.messages = async () => [
    user(), reply("First"), idle(),
    user("u2", "Second question"), { ...reply("Second"), id: "a2" }, { ...idle(), id: "i2" },
  ];
  r.session.reconnected();
  await r.session.catchingUp();
  r.session.reconnected();
  await r.session.catchingUp();
  assert.equal(r.events.filter((e) => e.type === "text").map((e) => e.text).join(""), "FirstSecond");
  assert.equal(r.events.filter((e) => e.type === "turn.begin").length, 2);
  assert.equal(r.events.filter((e) => e.type === "turn.end").length, 2);
  await r.session.close();
});

test("a successful native callback command with no execution closes its bridge turn", async () => {
  const r = await rig();
  r.api.commands = async () => [{ name: "callback" }];
  r.session.startTurn({ text: "/callback", images: [] });
  await tick();
  await r.session.catchingUp();
  assert.equal(r.events.find((e) => e.type === "turn.end")?.status, "complete");
  await r.session.close();
});

test("an approval already resolved on the desk does not emit a losing-phone warning", async () => {
  const r = await rig();
  r.sink.ask = async () => ({ kind: "approval.option", option: "once" });
  r.api.replyPermission = async () => { throw Object.assign(new Error("Permission request not found"), { name: "PermissionNotFoundError" }); };
  r.session.event(event("permission.asked", { id: "per_race", action: "shell", resources: ["echo harmless"] }));
  await tick();
  assert.ok(r.events.every((e) => e.type !== "notice"));
  await r.session.close();
});

test("idle resume restores native permissions and forms, without requiring an active turn", async () => {
  const fake = await FakeOpenCode.start();
  const native = fake.addSession({ id, location: { directory: "/tmp" } });
  native.permissions.push({ id: "per_idle", sessionID: id, action: "shell", resources: ["echo harmless"] });
  native.forms.push({ id: "frm_idle", sessionID: id, title: "Question", fields: [{ key: "answer", type: "string" }] });
  const cards: string[] = [];
  const provider = new OpenCodeProvider({ settings: { path: "/nonexistent", mode: "shared", start: false, folder: "/tmp", logPath: "/tmp/unused" }, locate: async () => fake.endpoint() });
  let session: OpenCodeSession | undefined;
  try {
    session = await provider.resumeSession({ id, cwd: "/tmp", settings: { model: "", provider: "", reasoningEffort: "" } }, {
      emit() {}, ask: async (card) => { cards.push(card.kind); return { kind: "withdrawn", reason: "" }; },
    }) as OpenCodeSession;
    assert.equal(session.attached(), null);
    await session.catchingUp();
    assert.deepEqual(cards.sort(), ["approval", "clarify"]);
  } finally {
    await session?.close();
    await provider.close();
    await fake.close();
  }
});

test("buffered delivery receipts cannot reopen a completed durable turn", async () => {
  const r = await rig();
  const entered = deferred<void>(), snapshot = deferred<Message[]>();
  r.api.messages = () => { entered.resolve(); return snapshot.promise; };
  r.session.reconnected();
  await entered.promise;
  r.session.event(event("session.inbox.delivered", { inboxID: "u1" }));
  r.session.event(event("session.execution.succeeded"));
  snapshot.resolve([user(), reply("Done"), idle()]);
  await r.session.catchingUp();
  assert.equal(r.events.filter((e) => e.type === "turn.begin").length, 1);
  assert.equal(r.events.filter((e) => e.type === "turn.end").length, 1);
  await r.session.close();
});

test("writable new/resume and native children get portals access; read adoption does not mutate", async () => {
  const fake = await FakeOpenCode.start();
  const provider = new OpenCodeProvider({
    settings: { path: "/nonexistent", mode: "own", start: false, folder: "/tmp", logPath: "/tmp/unused", portals: { bin: "/tmp/portals-bin", instructions: "The same commandAccess instructions" } },
    env: { PATH: "/usr/bin", PORTALS_THREAD: "stale", CODEX_THREAD_ID: "stale-codex", CURSOR_CONVERSATION_ID: "stale-cursor" },
    locate: async () => fake.endpoint(),
  });
  const sink: SessionSink = { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "" }) };
  const sessions: OpenCodeSession[] = [];
  try {
    const root = await provider.newThread({ cwd: "/tmp", settings: { model: "", provider: "", reasoningEffort: "" } });
    const configured = fake.callsOf("PUT", new RegExp(`^/api/session/${root}/environment$`)).at(-1)!.body.variables;
    assert.deepEqual(configured, { PATH: "/tmp/portals-bin:/usr/bin", PORTALS_THREAD: root, CODEX_THREAD_ID: "", CURSOR_CONVERSATION_ID: "" });
    const opts = { id: root, cwd: "/tmp", settings: { model: "", provider: "", reasoningEffort: "" } };
    const live = await provider.startSession(opts, sink) as OpenCodeSession;
    sessions.push(live);
    live.attached();
    fake.addSession({ id: "ses_access_child", parentID: root, location: { directory: "/tmp" } });
    fake.emit({ id: "evt_child_access", type: "session.created", data: { sessionID: "ses_access_child", parentID: root } });
    for (let tries = 0; tries < 20 && !fake.callsOf("PUT", /^\/api\/session\/ses_access_child\/environment$/).length; ++tries) await tick();
    assert.equal(fake.callsOf("PUT", /^\/api\/session\/ses_access_child\/environment$/).at(-1)?.body.variables.PORTALS_THREAD, root);
    await live.close();
    sessions.push(await provider.resumeSession(opts, sink) as OpenCodeSession);
    assert.equal(fake.callsOf("PUT", new RegExp(`^/api/session/${root}/environment$`)).length, 2);
    const instructions = fake.callsOf("PUT", new RegExp(`^/api/experimental/session/${root}/instructions/entries/portals$`));
    assert.equal(instructions.length, 2);
    assert.ok(instructions.every((call) => call.body.value === "The same commandAccess instructions"));
    for (let tries = 0; tries < 100 && fake.callsOf("PUT", /^\/api\/experimental\/session\/ses_access_child\/instructions\/entries\/portals$/).length < 2; ++tries) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.callsOf("PUT", /^\/api\/experimental\/session\/ses_access_child\/instructions\/entries\/portals$/).length, 2);
    const before = fake.calls.filter((call) => call.method !== "GET").length;
    const read = await provider.resumeSession({ ...opts, readOnly: true }, sink) as OpenCodeSession;
    sessions.push(read);
    assert.equal(read.attached(), null);
    assert.equal(fake.calls.filter((call) => call.method !== "GET").length, before);
  } finally {
    for (const session of sessions) await session.close();
    await provider.close();
    await fake.close();
  }
});

for (const mode of ["shared", "own"] as const) test(`${mode} shell environment preserves normal variables but excludes exactly the three transport passwords`, async () => {
  const fake = await FakeOpenCode.start();
  const ordinary = {
    PATH: "/usr/bin:/bin", HOME: "/tmp/bridge-home", USER: "bridge-user", SHELL: "/bin/sh",
    XDG_CONFIG_HOME: "/tmp/bridge-config", XDG_DATA_HOME: "/tmp/bridge-data",
    XDG_STATE_HOME: "/tmp/bridge-state", XDG_CACHE_HOME: "/tmp/bridge-cache", XDG_RUNTIME_DIR: "/tmp/bridge-runtime",
    CUSTOM_SETTING: "ordinary", ANTHROPIC_API_KEY: "harmless-provider-sentinel",
    PORTALS_BRIDGE_HOME: "/tmp/bridge", PORTALS_BRIDGE_LOG: "/tmp/bridge/log",
    OPENCODE_PASSWORD_FILE: "/tmp/control-file", PORTALS_PASSWORD_HINT: "ordinary-hint", AERIPORTAL_PASSWORD_OLD: "ordinary-legacy",
  };
  const provider = new OpenCodeProvider({
    settings: { path: "/nonexistent", mode, start: false, folder: "/tmp", logPath: "/tmp/unused", portals: { bin: "/tmp/portals-bin", instructions: "Guide" } },
    env: { ...ordinary, OPENCODE_PASSWORD: "harmless-native-control", PORTALS_PASSWORD: "harmless-bridge-setup", AERIPORTAL_PASSWORD: "harmless-legacy-setup",
      PORTALS_THREAD: "stale-root", CODEX_THREAD_ID: "stale-codex", CURSOR_CONVERSATION_ID: "stale-cursor", ABSENT_SETTING: undefined },
    locate: async () => fake.endpoint(),
  });
  try {
    const root = await provider.newThread({ cwd: "/tmp", settings: { model: "", provider: "", reasoningEffort: "" } });
    assert.deepEqual(fake.callsOf("PUT", new RegExp(`^/api/session/${root}/environment$`)).at(-1)!.body.variables,
      { ...ordinary, PATH: "/tmp/portals-bin:/usr/bin:/bin", PORTALS_THREAD: root, CODEX_THREAD_ID: "", CURSOR_CONVERSATION_ID: "" });
  } finally {
    await provider.close();
    await fake.close();
  }
});

test("experimental instructions failure warns once and preserves usable command environment", async () => {
  const fake = await FakeOpenCode.start();
  fake.instructionsStatus = 404;
  const warnings: string[] = [], warn = log.warn;
  log.warn = (message) => { warnings.push(message); };
  const provider = new OpenCodeProvider({
    settings: { path: "/nonexistent", mode: "shared", start: false, folder: "/tmp", logPath: "/tmp/unused", portals: { bin: "/tmp/portals-bin", instructions: "Guide" } },
    env: { PATH: "/usr/bin" }, locate: async () => fake.endpoint(),
  });
  try {
    const settings = { model: "", provider: "", reasoningEffort: "" };
    const first = await provider.newThread({ cwd: "/tmp", settings });
    const second = await provider.newThread({ cwd: "/tmp", settings });
    assert.notEqual(first, second);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /command is still available/);
    assert.equal(fake.callsOf("PUT", /\/environment$/).length, 2);
  } finally {
    log.warn = warn;
    await provider.close();
    await fake.close();
  }
});

test("background task scheduling is not child completion, and a late parent result cannot resurrect a finished child", async () => {
  const events: ProviderEvent[] = [];
  const sink: SessionSink = { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "" }) };
  const children = new OpenCodeSubagents(id, async () => ({}) as OpenCodeApi, sink, () => {}, [], [], new Set());
  const input = { description: "Real child", background: true };
  const metadata = { sessionID: "ses_background" };
  const scheduling = { ok: true as const, content: [{ type: "text" as const, text: "Background task started." }] };
  children.tool("call_child", "subagent", input, metadata, scheduling, 1000);
  const launched = events.at(-1);
  assert.equal(launched?.type === "subagent" && launched.subagent.status, "running");
  assert.ok(events.every((event) => event.type !== "subagent" || !event.subagent.result));
  children.event({ ...event("session.execution.started"), data: { sessionID: "ses_background" } });
  children.event({ ...event("session.text.delta"), data: { sessionID: "ses_background", delta: "Actual child result" } });
  children.event({ ...event("session.execution.succeeded"), data: { sessionID: "ses_background" } });
  children.tool("call_child", "subagent", input, metadata, scheduling, 3000);
  const last = events.at(-1);
  assert.equal(last?.type === "subagent" && last.subagent.status, "completed");
  assert.equal(last?.type === "subagent" && last.subagent.result, "Actual child result");
  assert.equal(events.filter((event) => event.type === "subagent" && event.subagent.status === "completed").length, 1);
  children.close();
});

test("restart without a native outcome emits a clear error, even if session.outcome describes an older success", async () => {
  const r = await rig();
  const events: ProviderEvent[] = [];
  const restored = new OpenCodeSession(
    { id, cwd: "/tmp", settings: { model: "", provider: "", reasoningEffort: "" } },
    { ...r.sink, emit: (event) => events.push(event) }, r.host,
    { info: { id, outcome: "succeeded", time: { created: 1, updated: 2 } }, messages: [user(), reply("Partial")], running: false, recover: true },
  );
  r.api.messages = async () => [user(), reply("Partial")];
  assert.ok(restored.attached());
  await restored.catchingUp();
  await tick();
  await restored.catchingUp();
  const done = events.find((event) => event.type === "turn.end");
  assert.equal(done?.type === "turn.end" && done.status, "error");
  assert.match(done?.type === "turn.end" ? done.error ?? "" : "", /crashed or restarted/);
  await restored.close();
  await r.session.close();
});

test("resume with steering history does not repeat already stored text from the same execution", async () => {
  const r = await rig();
  const events: ProviderEvent[] = [];
  const messages = [user(), reply("Already visible"), user("u2", "Steered"), { ...reply("Current"), id: "a2" }];
  const restored = new OpenCodeSession(
    { id, cwd: "/tmp", settings: { model: "", provider: "", reasoningEffort: "" } },
    { ...r.sink, emit: (event) => events.push(event) }, r.host,
    { info: { id, time: { created: 1, updated: 2 } }, messages, running: true, recover: true },
  );
  r.api.messages = async () => messages;
  r.api.active = async () => new Set([id]);
  assert.ok(restored.attached());
  await tick();
  await restored.catchingUp();
  assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "Current");
  await restored.close();
  await r.session.close();
});

test("a stale child's reconciliation failure cannot swallow the parent's approval", async () => {
  const r = await rig();
  const cards: string[] = [];
  r.sink.ask = async (card) => { cards.push(card.kind); return { kind: "withdrawn", reason: "" }; };
  r.api.pendingPermissions = async () => [{ id: "per_parent", sessionID: id, action: "shell", resources: ["echo harmless"] }];
  r.api.sessions = async () => { throw new Error("Stale child snapshot"); };
  r.session.reconnected();
  await r.session.catchingUp();
  assert.deepEqual(cards, ["approval"]);
  await r.session.close();
});

test("close while admission is in flight takes back only pending input, without interrupting an established native turn", async () => {
  const r = await rig();
  const response = deferred<{ id: string }>();
  let cancelled = "", interrupted = 0;
  r.api.prompt = () => response.promise;
  r.api.cancelInbox = async (_sessionID?: string, inputID?: string) => { cancelled = inputID ?? ""; };
  r.api.interrupt = async () => { ++interrupted; return false; };
  r.session.startTurn({ text: "Question", images: [] });
  await tick();
  await r.session.close();
  response.resolve({ id: "msg_late_admission" });
  await tick();
  assert.equal(cancelled, "msg_late_admission");
  assert.equal(interrupted, 0);
});
