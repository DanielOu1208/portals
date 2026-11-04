import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { HermesSession, type HermesHost, type Loaded } from "../src/providers/hermes/session.ts";
import type { Frame } from "../src/providers/hermes/client.ts";
import type { Registry, ThreadRecord } from "../src/sessions/registry.ts";
import { Session, stopWaitMs } from "../src/sessions/session.ts";

const settings = { model: "m", provider: "p", reasoningEffort: "" };
const step = () => new Promise<void>((resolve) => setImmediate(resolve));
const delta = (seq: number, text: string) => ({ type: "message.delta", seq, payload: { text } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const record: ThreadRecord = { id: "stored", agent: "hermes", cwd: "/tmp", title: null, ...settings, createdAt: 0, updatedAt: 0, origin: "phone" };
  const core = new Session(record, { has: () => false } as unknown as Registry);
  const loaded: Loaded = { session_id: "runtime", running: true, messages: [{ role: "user", text: "hello", timestamp: 0 }], inflight: { user: "hello", assistant: "" } };
  let dispatch: (method: string, params: Frame) => Promise<unknown> = async () => ({});
  const host: HermesHost = {
    call: <T>(method: string, params: Frame) => dispatch(method, params) as Promise<T>,
    bind() {}, forget() {}, respond() {}, respondError() {},
  };
  const adapter = new HermesSession({ id: "stored", cwd: "/tmp", settings }, "default", core.sink, host, loaded);
  await core.attach(adapter);
  await step();
  adapter.event("message.delta", 1, { text: "A" });
  return { core, adapter, loaded, host, setCall: (call: typeof dispatch) => { dispatch = call; } };
}

test("a Hermes submit failure arriving after its streamed completion cannot fail the next queued turn", async () => {
  const { core, adapter, setCall } = await fixture();
  const release = deferred<void>();
  const sent: string[] = [];
  setCall(async (method, params) => {
    if (method === "prompt.submit") {
      sent.push(params.text);
      if (sent.length === 1) {
        await release.promise;
        throw new Error("the first submit reply timed out");
      }
    }
    return {};
  });
  try {
    adapter.event("message.complete", 2, { status: "complete", text: "A" });
    core.submit("first").begin?.();
    await step();
    core.submit("second", { queue: true });
    adapter.event("message.start", 3, {});
    adapter.event("message.complete", 4, { status: "complete", text: "First reply" });
    await step();
    assert.deepEqual(sent, ["first", "second"]);
    release.resolve();
    await step();
    assert.equal(core.isRunning, true, "the first call's failure must not end the second turn");
    adapter.event("message.start", 5, {});
    adapter.event("message.delta", 6, { text: "Second reply" });
    adapter.event("message.complete", 7, { status: "complete", text: "Second reply" });
    assert.equal(core.isRunning, false);
    assert.ok(core.messages.some((message) => message.role === "assistant" && message.text === "Second reply"));
  } finally { release.resolve(); await core.close(); }
});

test("closing Hermes during image intake neither submits the message nor emits a late turn failure", async () => {
  const release = deferred<void>(), attaching = deferred<void>();
  const events: unknown[] = [], calls: string[] = [];
  const host: HermesHost = {
    call: async <T>(method: string) => {
      calls.push(method);
      if (method === "image.attach_bytes") {
        attaching.resolve();
        await release.promise;
      }
      return {} as T;
    },
    bind() {}, forget() {}, respond() {}, respondError() {},
  };
  const adapter = new HermesSession({ id: "stored", cwd: "/tmp", settings }, "default", {
    emit: (event) => { events.push(event); }, ask: async () => ({ kind: "withdrawn", reason: "test" }),
  }, host, { session_id: "runtime" });
  adapter.startTurn({ text: "look", images: [{ filename: "image.png", data: Buffer.from("image") }] });
  await attaching.promise;
  await adapter.close();
  release.resolve();
  await step();
  assert.deepEqual(calls, ["image.attach_bytes"]);
  assert.deepEqual(events, []);
});

for (const where of ["resume", "replay"] as const) {
  test(`Hermes holds live output arriving during ${where} behind the frozen replay cursor`, async () => {
    const { core, adapter, loaded, setCall } = await fixture();
    let cursor: unknown;
    adapter.connectionLost();
    setCall(async (method, params) => {
      if (method === "session.resume") {
        if (where === "resume") adapter.event("message.delta", 3, { text: "C" });
        return loaded;
      }
      cursor = params.last_seen;
      if (where === "replay") adapter.event("message.delta", 3, { text: "C" });
      return { events: [delta(2, "B"), delta(3, "C")], latest_seq: 3, truncated: false, open_requests: [] };
    });
    try {
      await adapter.reconnected(true);
      assert.equal(cursor, 1);
      assert.equal((core.snapshot().inflight as { assistant: string }).assistant, "ABC");
      adapter.event("message.complete", 4, { status: "complete", text: "ABC" });
      assert.equal(core.isRunning, false);
      assert.deepEqual(core.messages.filter((message) => message.role === "assistant").map((message) => message.text), ["ABC"]);
    } finally { await core.close(); }
  });
}

test("Hermes resets the upstream cursor before binding another runtime's early events", async () => {
  const { core, adapter, loaded, host, setCall } = await fixture();
  adapter.connectionLost();
  host.bind = () => adapter.event("message.delta", 1, { text: "New" });
  setCall(async () => ({ ...loaded, session_id: "new-runtime" }));
  try {
    await adapter.reconnected(false);
    adapter.event("message.complete", 2, { status: "complete", text: "New" });
    assert.match(core.messages.filter((message) => message.role === "assistant").map((message) => message.text).join(""), /New/);
  } finally { await core.close(); }
});

test("a second Hermes drop retires an outstanding replay without advancing the applied cursor", async () => {
  const { core, adapter, loaded, setCall } = await fixture();
  const old = deferred<Frame>(), requested = deferred<void>();
  let calls = 0;
  const cursors: unknown[] = [];
  setCall(async (method, params) => {
    if (method === "session.resume") return loaded;
    cursors.push(params.last_seen);
    if (calls++ === 0) { requested.resolve(); return old.promise; }
    return { events: [delta(2, "B"), delta(3, "C")], open_requests: [] };
  });
  try {
    adapter.connectionLost();
    const previous = adapter.reconnected(true);
    await requested.promise;
    adapter.event("message.delta", 3, { text: "C" });
    adapter.connectionLost();
    await adapter.reconnected(true);
    old.resolve({ events: [delta(2, "Wrong")], open_requests: [] });
    await previous;
    assert.deepEqual(cursors, [1, 1]);
    assert.equal((core.snapshot().inflight as { assistant: string }).assistant, "ABC");
  } finally { old.resolve({ events: [] }); await core.close(); }
});

test("closing Hermes while resume is outstanding cannot rebind or emit its delayed answer", async () => {
  const { core, adapter, loaded, host, setCall } = await fixture();
  const reply = deferred<Loaded>(), requested = deferred<void>();
  let bound = 0;
  host.bind = () => { bound++; };
  setCall(async () => { requested.resolve(); return reply.promise; });
  adapter.connectionLost();
  const resumed = adapter.reconnected(true);
  await requested.promise;
  await core.close();
  reply.resolve(loaded);
  await resumed;
  assert.equal(bound, 0);
});

test("a replayed Hermes cancellation cannot resurrect a live request held during resume", async () => {
  const { core, adapter, loaded, setCall } = await fixture();
  adapter.connectionLost();
  setCall(async (method) => {
    if (method === "session.resume") {
      adapter.request("cancelled", "approval", { command: "never ask", choices: ["once", "deny"] });
      return loaded;
    }
    return { events: [{ type: "request.cancel", seq: 2, payload: { id: "cancelled" } }], open_requests: [] };
  });
  try {
    await adapter.reconnected(true);
    assert.deepEqual(core.requests.list(), []);
  } finally { await core.close(); }
});

for (const complete of [false, true]) test(`a healthy Hermes socket retries failed replay without losing held ${complete ? "completion" : "approval"}`, async (t) => {
  const { core, adapter, loaded, host, setCall } = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cursors: unknown[] = [], answers: string[] = [];
  let resumes = 0;
  host.respond = (id) => { answers.push(id); };
  setCall(async (method, params) => {
    if (method === "session.resume") { resumes++; return loaded; }
    cursors.push(params.last_seen);
    if (cursors.length < 3) throw new Error("replay timed out");
    return { events: [delta(2, "B")], open_requests: [] };
  });
  try {
    adapter.connectionLost();
    await adapter.reconnected(true);
    adapter.event("message.delta", 2, { text: "B" });
    if (complete) adapter.event("message.complete", 3, { status: "complete", text: "AB" });
    else adapter.request("after-timeout", "approval", { command: "still answerable", choices: ["once", "deny"] });
    t.mock.timers.tick(399);
    await step();
    assert.equal(resumes, 1);
    t.mock.timers.tick(1);
    await step();
    assert.equal(resumes, 2);
    assert.equal((core.snapshot().inflight as { assistant: string }).assistant, "A");
    assert.deepEqual(core.requests.list(), []);
    t.mock.timers.tick(799);
    await step();
    assert.equal(resumes, 2);
    t.mock.timers.tick(1);
    await step();
    assert.equal(resumes, 3);
    assert.deepEqual(cursors, [1, 1, 1]);
    if (complete) {
      assert.equal(core.isRunning, false);
      assert.deepEqual(core.messages.filter((message) => message.role === "assistant").map((message) => message.text), ["AB"]);
    } else {
      assert.equal((core.snapshot().inflight as { assistant: string }).assistant, "AB");
      const [request] = core.requests.list();
      assert.ok(request);
      core.requests.answerFor(request.id, { result: { choice: "once" } }, {});
      await step();
      assert.deepEqual(answers, ["after-timeout"]);
    }
  } finally { core.requests.withdrawAll("test done"); await core.close(); }
});

for (const retire of ["close", "drop"] as const) test(`${retire} retires a scheduled Hermes replay retry`, async (t) => {
  const { core, adapter, loaded, setCall } = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resumes = 0;
  setCall(async (method) => {
    if (method === "session.resume") { resumes++; return loaded; }
    throw new Error("replay timed out");
  });
  try {
    adapter.connectionLost();
    await adapter.reconnected(true);
    if (retire === "close") await core.close();
    else adapter.connectionLost();
    t.mock.timers.tick(10_000);
    await step();
    assert.equal(resumes, 1);
  } finally { await core.close(); }
});

test("a Hermes call after failed replay resumes rather than bypassing recovery", async (t) => {
  const { core, adapter, loaded, setCall } = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[] = [];
  let replays = 0;
  setCall(async (method) => {
    calls.push(method);
    if (method === "session.resume") return loaded;
    if (method === "config.set") return {};
    if (++replays === 1) throw new Error("replay timed out");
    return { events: [], open_requests: [] };
  });
  try {
    adapter.connectionLost();
    await adapter.reconnected(true);
    await adapter.setReasoning("high");
    t.mock.timers.tick(10_000);
    await step();
    assert.deepEqual(calls, ["session.resume", "session.events.since", "session.resume", "session.events.since", "config.set"]);
  } finally { await core.close(); }
});

for (const failed of [false, true]) test(`Stop reaches a Hermes runtime while replay is ${failed ? "failed" : "pending"}`, async (t) => {
  const { core, adapter, loaded, setCall } = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const replay = deferred<Frame>(), requested = deferred<void>();
  let interrupted = false;
  setCall(async (method) => {
    if (method === "session.resume") return loaded;
    if (method === "session.interrupt") { interrupted = true; return { status: "interrupted" }; }
    requested.resolve();
    if (failed) throw new Error("replay timed out");
    return replay.promise;
  });
  adapter.connectionLost();
  const following = adapter.reconnected(true);
  try {
    await requested.promise;
    if (failed) await following;
    const stopping = adapter.interrupt();
    await step();
    assert.equal(interrupted, true, "Stop must not wait for history recovery on a bound runtime");
    assert.equal(await stopping, true);
  } finally {
    await core.close();
    replay.resolve({ events: [] });
    await following;
  }
});

test("what Hermes says of a stopped turn the grace timer ended is not shown, its late end closes it, and the next turn of Hermes's own opens as one", async () => {
  const { core, adapter, host, setCall } = await fixture();
  (host as { interruptGraceMs?: number }).interruptGraceMs = 20;
  setCall(async (method) => (method === "session.interrupt" ? { status: "interrupted" } : method === "session.active_list" ? { sessions: [{ session_key: "stored", status: "working" }] } : {}));
  try {
    assert.equal(await adapter.interrupt(), true);
    for (let tries = 0; tries < 100 && core.isRunning; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(core.isRunning, false);
    const said = core.messages.length;
    // Late output of the stopped turn: nothing shown, no turn opened.
    adapter.event("message.delta", 2, { text: "late" });
    adapter.event("tool.start", 3, { tool_id: "t1", name: "terminal", args: {} });
    assert.equal(core.isRunning, false);
    assert.equal(core.messages.length, said);
    // Hermes still runs it.
    assert.equal(await adapter.stopping(), true);
    // Its end closes it; Hermes's next turn of its own is one.
    adapter.event("message.complete", 4, { status: "interrupted", text: "" });
    assert.equal(await adapter.stopping(), false);
    adapter.event("message.start", 5, {});
    assert.equal(core.isRunning, true);
  } finally { await core.close(); }
});

test("a stopped turn the grace timer ended while the connection was down is followed again once it is back, so its end is heard (Codex review)", async () => {
  const { core, adapter, host, loaded, setCall } = await fixture();
  (host as { interruptGraceMs?: number }).interruptGraceMs = 20;
  const calls: string[] = [];
  setCall(async (method) => {
    calls.push(method);
    if (method === "session.interrupt") return { status: "interrupted" };
    if (method === "session.resume") return loaded;
    if (method === "session.events.since") return { events: [{ type: "message.complete", seq: 2, payload: { status: "interrupted", text: "" } }], latest_seq: 2, open_requests: [] };
    return {};
  });
  try {
    assert.equal(await adapter.interrupt(), true);
    adapter.connectionLost();
    for (let tries = 0; tries < 100 && core.isRunning; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(core.isRunning, false);
    await adapter.reconnected(true);
    assert.ok(calls.includes("session.resume"), calls.join(", "));
    // Its end came with the replay: no longer at work in Hermes.
    assert.equal(await adapter.stopping(), false);
  } finally { await core.close(); }
});

test("the stopped turn's own start, coming late (a replay), opens no turn, and its late reply and end are not shown (Codex review)", async () => {
  const { core, adapter, host, setCall } = await fixture();
  (host as { interruptGraceMs?: number }).interruptGraceMs = 20;
  setCall(async (method) => (method === "session.interrupt" ? { status: "interrupted" } : method === "session.active_list" ? { sessions: [{ session_key: "stored", status: "working" }] } : {}));
  try {
    adapter.event("message.complete", 2, { status: "complete", text: "A" });
    assert.equal(core.isRunning, false);
    // A turn the bridge starts, whose message.start Hermes has not sent yet.
    const outcome = core.submit("Count slowly.");
    assert.equal(outcome.status, "streaming");
    outcome.begin?.();
    await step();
    assert.equal(core.isRunning, true);
    assert.equal(await adapter.interrupt(), true);
    for (let tries = 0; tries < 100 && core.isRunning; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(core.isRunning, false);
    adapter.event("message.start", 3, {});
    assert.equal(core.isRunning, false);
    adapter.event("message.delta", 4, { text: "late original reply" });
    adapter.event("message.complete", 5, { status: "complete", text: "late original reply" });
    assert.equal(core.isRunning, false);
    assert.ok(!core.messages.some((message) => "text" in message && message.text === "late original reply"));
    // Hermes's next turn of its own is one.
    adapter.event("message.start", 6, {});
    assert.equal(core.isRunning, true);
  } finally { await core.close(); }
});

test("a message sent after a stopped turn that Hermes ended without a word (no start, no end) runs as its own turn (Codex re-check)", async () => {
  const { core, adapter, host, setCall } = await fixture();
  (host as { interruptGraceMs?: number }).interruptGraceMs = 20;
  // Hermes is idle: it lists no session at work.
  setCall(async (method) => (method === "session.interrupt" ? { status: "interrupted" } : method === "session.active_list" ? { sessions: [] } : {}));
  try {
    adapter.event("message.complete", 2, { status: "complete", text: "A" });
    const first = core.submit("Count slowly.");
    first.begin?.();
    await step();
    assert.equal(await adapter.interrupt(), true);
    for (let tries = 0; tries < 100 && core.isRunning; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(core.isRunning, false);
    // Hermes never began it, and says nothing of it. The next message:
    const next = core.submit("Something else.");
    next.begin?.();
    for (let index = 0; index < 5; index++) await step();
    adapter.event("message.start", 3, {});
    adapter.event("message.delta", 4, { text: "The new reply." });
    adapter.event("message.complete", 5, { status: "complete", text: "The new reply." });
    assert.equal(core.isRunning, false);
    assert.ok(core.messages.some((message) => "text" in message && message.text === "The new reply."));
  } finally { await core.close(); }
});

test("a message sent while Hermes still runs a stopped turn is not sent, and fails to be sent again; one stopped while Hermes is asked is never sent (Codex re-check)", async () => {
  const { core, adapter, host, setCall } = await fixture();
  (host as { interruptGraceMs?: number }).interruptGraceMs = 20;
  const calls: string[] = [];
  let listing = deferred<unknown>();
  setCall(async (method) => {
    calls.push(method);
    if (method === "session.interrupt") return { status: "interrupted" };
    if (method === "session.active_list") return listing.promise;
    return {};
  });
  const stopped = async () => {
    for (let tries = 0; tries < 100 && core.isRunning; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(core.isRunning, false);
  };
  try {
    adapter.event("message.complete", 2, { status: "complete", text: "A" });
    const first = core.submit("Count slowly.");
    first.begin?.();
    await step();
    assert.equal(await adapter.interrupt(), true);
    await stopped();
    // Hermes still lists it at work: the next message is not sent.
    listing.resolve({ sessions: [{ session_key: "stored", status: "working" }] });
    const next = core.submit("Something else.");
    next.begin?.();
    await stopped();
    assert.equal(calls.filter((call) => call === "prompt.submit").length, 1);
    // Stopped while Hermes is asked: not sent once the answer comes.
    listing = deferred<unknown>();
    const third = core.submit("And this.");
    third.begin?.();
    await step();
    assert.equal(await adapter.interrupt(), true);
    await stopped();
    listing.resolve({ sessions: [] });
    for (let index = 0; index < 5; index++) await step();
    assert.equal(calls.filter((call) => call === "prompt.submit").length, 1);
  } finally { await core.close(); }
});

test("a Stop Hermes never answers (it cannot be reached) ends the turn after stopWaitMs, and what Hermes says of that turn later is let go of", async (t) => {
  const { core, adapter, setCall } = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: string[] = [];
  setCall(async (method, params) => {
    if (method === "session.interrupt") return new Promise(() => {});
    if (method === "prompt.submit") sent.push(params.text);
    return {};
  });
  try {
    assert.equal(core.isRunning, true);
    const stopping = core.interrupt();
    await step();
    t.mock.timers.tick(stopWaitMs);
    assert.equal(await stopping, true);
    assert.equal(core.isRunning, false);
    // Hermes comes back and finishes the stopped turn: nothing of it shows, and the thread stays at rest.
    adapter.event("message.delta", 2, { text: "B" });
    adapter.event("message.complete", 3, { status: "complete", text: "AB" });
    assert.equal(core.isRunning, false);
    assert.deepEqual(core.messages.filter((message) => message.role === "assistant").map((message) => message.text), ["A"]);
    // The next message is a turn of its own, which Hermes ends.
    core.submit("next").begin?.();
    await step();
    assert.deepEqual(sent, ["next"]);
    adapter.event("message.start", 4, {});
    adapter.event("message.delta", 5, { text: "Next reply" });
    adapter.event("message.complete", 6, { status: "complete", text: "Next reply" });
    assert.equal(core.isRunning, false);
    assert.deepEqual(core.messages.filter((message) => message.role === "assistant").map((message) => message.text), ["A", "Next reply"]);
  } finally { await core.close(); }
});

test("a message sent after the Stop deadline but before Hermes ends the stopped turn waits for that end, and the stopped turn's output never reaches it", async (t) => {
  const { core, adapter, setCall } = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: string[] = [];
  const stop = deferred<unknown>();
  setCall(async (method, params) => {
    if (method === "session.interrupt") return stop.promise;
    if (method === "prompt.submit") sent.push(params.text);
    return {};
  });
  try {
    const stopping = core.interrupt();
    await step();
    t.mock.timers.tick(stopWaitMs);
    assert.equal(await stopping, true);
    assert.equal(core.isRunning, false);
    // Hermes may still run the stopped turn: the thread is still at work.
    assert.equal(await core.stopping(), true);
    // The next message waits; nothing goes to Hermes yet.
    assert.equal(core.submit("new request").status, "queued");
    await step();
    assert.deepEqual(sent, []);
    // Hermes answers the Stop late, then goes on with the stopped turn and ends it.
    stop.resolve({ status: "interrupted" });
    await step();
    adapter.event("message.delta", 2, { text: "OLD LATE OUTPUT" });
    adapter.event("message.complete", 3, { status: "complete", text: "AOLD LATE OUTPUT" });
    await step();
    await step();
    // Only now does the next message go, as a turn of its own.
    assert.deepEqual(sent, ["new request"]);
    assert.equal(core.isRunning, true);
    assert.equal(await core.stopping(), false);
    assert.ok(!core.messages.some((message) => message.role === "assistant" && message.text.includes("OLD LATE OUTPUT")));
    adapter.event("message.start", 4, {});
    adapter.event("message.delta", 5, { text: "New reply" });
    adapter.event("message.complete", 6, { status: "complete", text: "New reply" });
    assert.equal(core.isRunning, false);
    assert.deepEqual(core.messages.filter((message) => message.role === "assistant").map((message) => message.text), ["A", "New reply"]);
  } finally { stop.resolve({}); await core.close(); }
});
