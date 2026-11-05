import assert from "node:assert/strict";
import { test } from "./opencode-test.ts";
import { OpenCodeSession } from "../src/providers/opencode/session.ts";
import { OpenCodeTurn, recoveryBufferLimit } from "../src/providers/opencode/turn.ts";
import type { OpenCodeApi } from "../src/providers/opencode/client.ts";
import type { Message, OpenCodeEvent } from "../src/providers/opencode/protocol.ts";
import type { ProviderEvent, SessionSink } from "../src/providers/types.ts";

const id = "ses_recovery";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const user = (): Message => ({ type: "user", id: "u1", text: "Question", time: { created: 1 } });
const reply = (text: string): Message => ({ type: "assistant", id: "a1", content: [{ type: "text", text }], time: { created: 2 } });
const idle = (): Message => ({ type: "idle", id: "i1", outcome: "succeeded", time: { created: 3 } });
const event = (type: string, data: object = {}): OpenCodeEvent => ({ id: "evt_recovery", type, data: { sessionID: id, ...data } });
const missing = () => Object.assign(new Error("Session not found"), { name: "SessionNotFoundError" });

async function rig(running = false, messages: Message[] = running ? [user()] : []) {
  const events: ProviderEvent[] = [], signals: AbortSignal[] = [];
  const sink: SessionSink = {
    emit: (event) => events.push(event),
    ask: async (_card, signal) => {
      signals.push(signal!);
      return new Promise((resolve) => signal!.addEventListener("abort", () => resolve({ kind: "withdrawn", reason: "resolved" }), { once: true }));
    },
  };
  const api = {
    prompt: async () => ({ id: "u1" }), messages: async () => [] as Message[],
    active: async () => new Set<string>(), inbox: async () => [], pendingPermissions: async () => [], forms: async () => [],
    sessions: async () => [], session: async () => ({ id, time: { created: 1, updated: 1 } }),
    interrupt: async () => false, commands: async () => [],
  };
  const session = new OpenCodeSession(
    { id, cwd: "/tmp", settings: { model: "m", provider: "p", reasoningEffort: "" } }, sink,
    { api: async () => api as unknown as OpenCodeApi, bind() {}, forget() {}, contextOf() {}, levelsOf() {} },
    { info: { id, time: { created: 1, updated: 1 } }, messages, running },
  );
  session.attached();
  await tick();
  return { session, api, events, signals };
}

test("resumed steering uses the first execution opener after live completion and reconnect", async () => {
  const messages = [user(), { ...user(), id: "u2", text: "Steer" }, reply("Current")];
  const r = await rig(true, messages);
  try {
    r.api.messages = async () => messages;
    r.api.active = async () => new Set([id]);
    r.session.reconnected();
    await r.session.catchingUp();
    r.session.event(event("session.text.ended", { assistantMessageID: "a1", ordinal: 0, text: "Current" }));
    r.session.event(event("session.execution.succeeded"));
    r.api.active = async () => new Set();
    r.api.messages = async () => [...messages, idle()];
    r.session.reconnected();
    await r.session.catchingUp();
    assert.equal(r.events.filter((event) => event.type === "turn.begin").length, 0);
    assert.equal(r.events.filter((event) => event.type === "text").map((event) => event.text).join(""), "Current");
  } finally { await r.session.close(); }
});

for (const bound of ["count", "bytes"]) test(`recovery ${bound} overflow requires a fresh full snapshot with exact, once-only text`, async () => {
  const r = await rig();
  try {
    r.session.startTurn({ text: "Question", images: [] });
    await tick();
    r.session.event(event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "A" }));
    const entered = deferred<void>(), oldSnapshot = deferred<Message[]>();
    const suffix = bound === "count" ? "x".repeat(recoveryBufferLimit.frames + 12) : "猫".repeat(Math.ceil(recoveryBufferLimit.bytes / 3) + 12);
    const native = `A${suffix}`;
    let reads = 0;
    r.api.messages = async () => {
      if (++reads === 1) { entered.resolve(); return oldSnapshot.promise; }
      return [user(), reply(native), idle()];
    };
    r.session.reconnected();
    await entered.promise;
    const deltas = bound === "count" ? [...suffix] : [suffix];
    for (const delta of deltas) r.session.event(event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta }));
    const owner = (r.session as any).turn;
    assert.ok(owner.held.length <= recoveryBufferLimit.frames);
    assert.ok(owner.heldBytes <= recoveryBufferLimit.bytes);
    oldSnapshot.resolve([user(), reply("A")]); // This read predates the dropped frames.
    await r.session.catchingUp();
    assert.ok(reads >= 2, "overflow must request another authoritative snapshot");
    assert.equal(r.events.filter((event) => event.type === "text").map((event) => event.text).join(""), native);
    assert.equal(r.events.filter((event) => event.type === "turn.end").length, 1);
  } finally { await r.session.close(); }
});

test("recovery retries without more SSE, uses capped backoff, and Stop cancels the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const turn = new OpenCodeTurn(id);
  turn.attach();
  let reads = 0;
  turn.recover(async () => { ++reads; throw new Error("temporary outage"); }, () => {});
  await turn.catchingUp;
  for (const delay of [100, 200, 400, 800, 1600, 3200, 5000, 5000]) {
    const before = reads;
    t.mock.timers.tick(delay - 1);
    await tick();
    assert.equal(reads, before);
    t.mock.timers.tick(1);
    await tick();
    await turn.catchingUp;
    assert.equal(reads, before + 1);
  }
  turn.stop();
  const stopped = reads;
  t.mock.timers.tick(100_000);
  await tick();
  assert.equal(reads, stopped);
  turn.close();
});

test("repeated recovery failure becomes visible, then succeeds without another reconnect", async (t) => {
  const r = await rig();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    r.api.messages = async () => { throw new Error("temporary read failure"); };
    r.session.reconnected();
    await r.session.catchingUp();
    for (const delay of [100, 200]) {
      t.mock.timers.tick(delay);
      await tick();
      await r.session.catchingUp();
    }
    assert.equal(r.events.filter((event) => event.type === "notice" && /could not restore/.test(event.text)).length, 1);
    r.api.messages = async () => [user(), reply("Recovered without SSE"), idle()];
    t.mock.timers.tick(400);
    await tick();
    await r.session.catchingUp();
    assert.equal(r.events.filter((event) => event.type === "text").map((event) => event.text).join(""), "Recovered without SSE");
    assert.equal(r.events.filter((event) => event.type === "turn.end").length, 1);
  } finally { await r.session.close(); }
});

test("close cancels pending recovery retries", async (t) => {
  const r = await rig();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  r.api.messages = async () => { ++reads; throw new Error("outage"); };
  r.session.reconnected();
  await r.session.catchingUp();
  await r.session.close();
  t.mock.timers.tick(100_000);
  await tick();
  assert.equal(reads, 1);
});

test("confirmed deletion ends an adopted running turn, withdraws cards and makes Stop succeed", async (t) => {
  const r = await rig(true);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0, confirmations = 0;
  r.session.event(event("permission.asked", { id: "per_root", action: "shell", resources: ["echo harmless"], save: [] }));
  r.session.event(event("form.created", { form: { id: "frm_root", sessionID: id, fields: [{ key: "answer", type: "string" }] } }));
  r.api.messages = async () => { ++reads; throw missing(); };
  r.api.session = async () => { ++confirmations; throw missing(); };
  r.session.reconnected();
  await r.session.catchingUp();
  assert.equal(confirmations, 1, "confirm the first not-found with an independent get");
  assert.equal(r.events.filter((event) => event.type === "turn.end" && event.status === "error" && /deleted in OpenCode/.test(event.error ?? "")).length, 1);
  assert.equal(r.signals.length, 2);
  assert.ok(r.signals.every((signal) => signal.aborted));
  assert.equal(await r.session.stopping(), false);
  assert.equal(await r.session.interrupt(), true);
  r.session.reconnected();
  t.mock.timers.tick(100_000);
  await tick();
  assert.equal(reads, 1);
  await r.session.close();
});

test("a transient not-found during restart is retried, not declared deleted", async (t) => {
  const r = await rig(true);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let reads = 0;
    r.api.messages = async () => {
      if (++reads === 1) throw missing();
      return [user(), reply("Still here"), idle()];
    };
    r.session.reconnected();
    await r.session.catchingUp();
    assert.equal(r.events.filter((event) => event.type === "turn.end").length, 0);
    t.mock.timers.tick(100);
    await tick();
    await r.session.catchingUp();
    assert.equal(r.events.find((event) => event.type === "turn.end")?.status, "complete");
  } finally { await r.session.close(); }
});

test("Stop also confirms native not-found and settles deletion without throwing", async () => {
  const r = await rig(true);
  try {
    r.api.interrupt = async () => { throw missing(); };
    r.api.session = async () => { throw missing(); };
    assert.equal(await r.session.interrupt(), true);
    assert.equal(await r.session.stopping(), false);
    const ended = r.events.find((event) => event.type === "turn.end");
    assert.equal(ended?.status, "error");
    assert.match(ended?.error ?? "", /deleted in OpenCode/);
  } finally { await r.session.close(); }
});
