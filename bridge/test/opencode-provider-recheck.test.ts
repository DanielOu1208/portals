import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenCodeSession } from "../src/providers/opencode/session.ts";
import { OpenCodeInbox, inboxRetentionLimit } from "../src/providers/opencode/inbox.ts";
import { OpenCodeForms } from "../src/providers/opencode/forms.ts";
import { OpenCodeTurn, recoveryBufferLimit } from "../src/providers/opencode/turn.ts";
import { OpenCodeSubagents } from "../src/providers/opencode/subagents.ts";
import { chooseModel } from "../src/fleet/fleet.ts";
import type { OpenCodeApi } from "../src/providers/opencode/client.ts";
import type { Message, OpenCodeEvent } from "../src/providers/opencode/protocol.ts";
import type { ModelCatalog, Provider, ProviderEvent, RequestAnswer, SessionSink } from "../src/providers/types.ts";
import type { FormInfo, SessionInboxInfo } from "@opencode/client";

const id = "ses_recheck";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const user = (id = "u1", text = "Question"): Message => ({ type: "user", id, text, time: { created: 1 } });
const reply = (text: string, id = "a1"): Message => ({ type: "assistant", id, content: [{ type: "text", text }], time: { created: 2 } });
const idle = (): Message => ({ type: "idle", id: "i1", outcome: "succeeded", time: { created: 3 } });
const event = (type: string, data: object = {}): OpenCodeEvent => ({ id: "evt_review", type, data: { sessionID: id, ...data } });
const text = (events: ProviderEvent[]) => events.filter((e) => e.type === "text").map((e) => e.text).join("");
async function rig() {
  const events: ProviderEvent[] = [];
  const sink: SessionSink = { emit: (e) => events.push(e), ask: async () => ({ kind: "withdrawn", reason: "unused" }) };
  const api = {
    prompt: async () => ({ id: "u1" }),
    sessions: async () => [],
    active: async () => new Set<string>(),
    messages: async () => [] as Message[],
    inbox: async () => [],
    pendingPermissions: async () => [],
    forms: async () => [],
    session: async () => ({ id, outcome: "succeeded", time: { created: 1, updated: 3 } }),
    interrupt: async () => false,
    cancelInbox: async () => {},
    commands: async () => [],
    command: async () => {},
    replyPermission: async () => {},
  };
  const host = { api: async () => api as unknown as OpenCodeApi, bind() {}, forget() {}, contextOf() { return 1000; }, levelsOf() { return []; } };
  const session = new OpenCodeSession(
    { id, cwd: "/tmp", settings: { model: "m", provider: "p", reasoningEffort: "" } }, sink, host,
    { info: { id, time: { created: 1, updated: 1 } }, messages: [], running: false },
  );
  session.attached();
  await tick();
  return { session, api, sink, events, host };
}

test("recheck: failed reconnect recovery must not resume corrupting deltas", async (t) => {
  const r = await rig();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  r.session.startTurn({ text: "Question", images: [] });
  await tick();
  r.session.event(event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "A" }));
  r.api.messages = async () => { throw new Error("One HTTP read failed while SSE stayed connected"); };
  r.session.reconnected();
  await r.session.catchingUp();
  r.api.messages = async () => [user(), reply("ABC"), idle()];
  r.session.event(event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "C" }));
  r.session.event(event("session.text.ended", { assistantMessageID: "a1", ordinal: 0, text: "ABC" }));
  r.session.event(event("session.execution.succeeded"));
  t.mock.timers.tick(100);
  await tick();
  await r.session.catchingUp();
  await r.session.close();
  assert.equal(text(r.events), "ABC");
});

test("Stop remains pending until callback settlement and native interruption finish, without guessing a DELETE", async () => {
  const r = await rig();
  const callback = deferred<void>(), interruption = deferred<void>();
  const cancelled: string[] = [];
  let interrupts = 0;
  r.api.commands = async () => [{ name: "task" }] as never[];
  r.api.command = () => callback.promise;
  r.api.cancelInbox = async (_session?: string, inboxID?: string) => { cancelled.push(inboxID!); };
  r.api.interrupt = async () => { if (++interrupts > 1) await interruption.promise; return false; };
  r.session.startTurn({ text: "/task", images: [] });
  await tick();
  r.session.event(event("session.inbox.enqueued", { inboxID: "msg_callback", item: { type: "user", payload: { text: "Expanded" } } }));
  await r.session.interrupt();
  r.session.event(event("session.execution.interrupted"));
  assert.equal(r.events.filter((event) => event.type === "turn.end").length, 0);
  assert.equal(await r.session.stopping(), true);
  callback.resolve();
  await tick();
  assert.deepEqual(cancelled, []);
  assert.equal(interrupts, 2);
  assert.equal(r.events.filter((event) => event.type === "turn.end").length, 0);
  interruption.resolve();
  await tick();
  assert.equal(r.events.filter((event) => event.type === "turn.end" && event.status === "interrupted").length, 1);
  assert.equal(await r.session.stopping(), false);
  await r.session.close();
});

test("an early execution terminal cannot release Stop responsibility while a callback can enqueue more work", async () => {
  const r = await rig();
  const callback = deferred<void>();
  let cancelled = "";
  r.api.commands = async () => [{ name: "task" }] as never[];
  r.api.command = () => callback.promise;
  r.api.cancelInbox = async (_session?: string, inboxID?: string) => { cancelled = inboxID!; };
  r.session.startTurn({ text: "/task", images: [] });
  await tick();
  r.session.event(event("session.execution.succeeded"));
  assert.equal(r.events.filter((event) => event.type === "turn.end").length, 0);
  assert.equal(await r.session.interrupt(), true);
  r.session.event(event("session.inbox.enqueued", { inboxID: "msg_late_callback", item: { type: "user", payload: { text: "Later" } } }));
  callback.resolve();
  await tick();
  assert.equal(cancelled, "", "an enqueue event alone cannot prove callback ownership");
  assert.equal(r.events.find((event) => event.type === "turn.end")?.status, "interrupted");
  await r.session.close();
});

test("ambiguous callback and simultaneous desk inputs use interruption without guessed deletes", async (t) => {
  const r = await rig();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const callback = deferred<void>();
  const deleted: string[] = [];
  let interrupts = 0;
  let waiting: SessionInboxInfo[] = [];
  r.api.inbox = async () => waiting as never[];
  r.api.commands = async () => [{ name: "task" }] as never[];
  r.api.command = () => callback.promise;
  r.api.cancelInbox = async (_session?: string, inboxID?: string) => { deleted.push(inboxID!); };
  r.api.interrupt = async () => { ++interrupts; return false; };
  r.session.startTurn({ text: "/task", images: [] });
  await tick();
  waiting = ["msg_callback", "msg_desk"].map((input) => ({ id: input, sessionID: id, type: "user", payload: { text: input }, delivery: "queue", time: { created: 1 } }));
  for (const input of waiting) r.session.event(event("session.inbox.enqueued", { inboxID: input.id, item: input }));
  await r.session.interrupt();
  callback.resolve();
  await tick();
  assert.deepEqual(deleted, []);
  assert.ok(interrupts >= 2, "interrupt again after the pending callback settles");
  assert.equal(await r.session.stopping(), true, "queued ambiguous work cannot be reported stopped");
  assert.equal(r.events.filter((event) => event.type === "turn.end").length, 0);
  waiting = []; // Native work drains; Stop interrupts it rather than choosing a message.
  t.mock.timers.tick(100);
  await tick();
  assert.deepEqual(deleted, []);
  assert.equal(await r.session.stopping(), false);
  assert.equal(r.events.filter((event) => event.type === "turn.end" && event.status === "interrupted").length, 1);
  await r.session.close();
});

test("callback Stop interrupts uncorrelated work even when its enqueue SSE was lost", async () => {
  const r = await rig();
  const callback = deferred<void>();
  let waiting: SessionInboxInfo[] = [], cancelled = "";
  r.api.inbox = async () => waiting as never[];
  r.api.commands = async () => [{ name: "task" }] as never[];
  r.api.command = () => callback.promise;
  r.api.cancelInbox = async (_session?: string, inboxID?: string) => { cancelled = inboxID!; waiting = []; };
  r.api.interrupt = async () => { waiting = []; return false; };
  r.session.startTurn({ text: "/task", images: [] });
  await tick();
  waiting = [{ id: "msg_native_lost_event", sessionID: id, type: "user", payload: { text: "Expanded" }, delivery: "queue", time: { created: 1 } }];
  await r.session.interrupt();
  callback.resolve();
  await tick();
  assert.equal(cancelled, "");
  assert.equal(r.events.find((event) => event.type === "turn.end")?.status, "interrupted");
  await r.session.close();
});

test("native cancellation received while DELETE is outstanding retires its payload even if the response is lost", async () => {
  const response = deferred<void>();
  const api = { prompt: async () => ({ id: "" }), cancelInbox: async () => { await response.promise; throw new Error("lost DELETE response"); } } as unknown as OpenCodeApi;
  const events: ProviderEvent[] = [];
  const inbox = new OpenCodeInbox(id, async () => api, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "" }) }, [], []);
  await inbox.add({ text: "Cancelled", images: [] }, "portals-during-delete", []);
  const deleting = inbox.delete("portals-during-delete");
  await tick();
  inbox.cancelled("msg_portals-during-delete");
  assert.equal((inbox as any).pending.size, 0);
  response.resolve();
  assert.equal(await deleting, true);
  assert.equal((inbox as any).pending.size, 0);
  assert.deepEqual(events, []);
  inbox.close();
});

test("uncertain receipts apply count backpressure without discarding a late receipt or its original payload", async () => {
  const events: ProviderEvent[] = [];
  const api = { prompt: async () => ({ id: "" }), cancelInbox: async () => {} } as unknown as OpenCodeApi;
  const inbox = new OpenCodeInbox(id, async () => api, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "" }) }, [], []);
  const prompt = { text: "Still uncertain", images: [] };
  for (let n = 0; n < inboxRetentionLimit.entries; ++n) {
    await inbox.add(prompt, `portals-${n}`, []);
    await inbox.delete(`portals-${n}`);
  }
  assert.equal(await inbox.add(prompt, "portals-overflow", []), false);
  assert.equal((inbox as any).pending.size, inboxRetentionLimit.entries);
  inbox.delivered("msg_portals-0");
  assert.deepEqual(events, [{ type: "queue.taken", requestId: "portals-0", prompt }]);
  assert.equal(await inbox.add(prompt, "portals-overflow", []), true);
  inbox.close();
});

test("uncertain-receipt retention counts image bytes as well as text", async () => {
  let posts = 0;
  const api = { prompt: async () => { ++posts; return { id: "" }; } } as unknown as OpenCodeApi;
  const inbox = new OpenCodeInbox(id, async () => api, { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "" }) }, [], []);
  assert.equal(await inbox.add({ text: "Image", images: [{ filename: "large.png", data: Buffer.alloc(inboxRetentionLimit.bytes) }] }, "portals-large", []), false);
  assert.equal(posts, 0);
  assert.equal((inbox as any).pending.size, 0);
  inbox.close();
});

test("resolving an absent form in a snapshot does not invalidate another form in that same list", async () => {
  const cards: string[] = [];
  const existing: FormInfo = { id: "frm_old", sessionID: id, title: "Old", fields: [{ key: "old", type: "string" }] };
  const fresh: FormInfo = { id: "frm_fresh", sessionID: id, title: "Fresh", fields: [{ key: "fresh", type: "string" }] };
  const api = { forms: async () => [fresh] } as unknown as OpenCodeApi;
  const forms = new OpenCodeForms(id, async () => api, { emit() {}, ask: async (card, signal) => {
    if (card.kind === "clarify") cards.push(card.questions[0].qid!);
    return new Promise((resolve) => signal!.addEventListener("abort", () => resolve({ kind: "withdrawn", reason: "" }), { once: true }));
  } });
  void forms.ask(existing);
  await forms.reconcile();
  assert.deepEqual(cards, ["old", "fresh"]);
  forms.close();
});

test("an older empty form list cannot withdraw a newer live-created request", async () => {
  const snapshot = deferred<FormInfo[]>();
  let signal: AbortSignal | undefined;
  const api = { forms: () => snapshot.promise } as unknown as OpenCodeApi;
  const forms = new OpenCodeForms(id, async () => api, { emit() {}, ask: async (_card, received) => {
    signal = received;
    return new Promise((resolve) => received!.addEventListener("abort", () => resolve({ kind: "withdrawn", reason: "" }), { once: true }));
  } });
  const reading = forms.reconcile();
  await tick();
  void forms.ask({ id: "frm_new", sessionID: id, title: "New", fields: [{ key: "answer", type: "string" }] });
  snapshot.resolve([]);
  await reading;
  assert.equal(signal?.aborted, false);
  forms.close();
});

test("a successful phone reply also prevents an older form list from re-offering the card", async () => {
  const snapshot = deferred<FormInfo[]>(), answer = deferred<RequestAnswer>();
  let cards = 0;
  const api = { forms: () => snapshot.promise, replyForm: async () => {} } as unknown as OpenCodeApi;
  const form: FormInfo = { id: "frm_phone", sessionID: id, title: "Answer", fields: [{ key: "answer", type: "string" }] };
  const forms = new OpenCodeForms(id, async () => api, { emit() {}, ask: async () => { ++cards; return answer.promise; } });
  const asking = forms.ask(form);
  const reading = forms.reconcile();
  await tick();
  answer.resolve({ kind: "clarify", answers: { answer: "Yes" } });
  await asking;
  snapshot.resolve([form]);
  await reading;
  assert.equal(cards, 1);
  forms.close();
});

test("an older child snapshot cannot overwrite a newer completed snapshot", async () => {
  const child = { id: "ses_child", parentID: id, time: { created: 1, updated: 1 } };
  const old = deferred<typeof child[]>();
  let lists = 0, activeReads = 0;
  const api = {
    sessions: async (_count: number, parent: string) => parent !== id ? [] : ++lists === 1 ? old.promise : [{ ...child, outcome: "succeeded" }],
    active: async () => ++activeReads === 1 ? new Set([child.id]) : new Set(),
    forms: async () => [],
  } as unknown as OpenCodeApi;
  const children = new OpenCodeSubagents(id, async () => api, { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "" }) }, () => {}, [], [child], new Set([child.id]));
  const older = children.reconcile();
  await tick();
  await children.reconcile();
  old.resolve([child]);
  await older;
  assert.equal(children.hasRunning(), false);
  children.close();
});

test("recheck: boundary escalation during a piece refresh must run full recovery", async () => {
  const r = await rig();
  r.session.startTurn({ text: "Question", images: [] });
  await tick();
  r.api.messages = async () => [user(), reply("A")];
  r.api.active = async () => new Set([id]);
  r.session.reconnected();
  await r.session.catchingUp();
  const entered = deferred<void>(), snapshot = deferred<Message[]>();
  r.api.messages = () => { entered.resolve(); return snapshot.promise; };
  r.session.event(event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "B" }));
  await entered.promise;
  // The SSE connection drops again while the old-piece refresh is outstanding.
  r.api.active = async () => new Set<string>();
  r.session.reconnected();
  snapshot.resolve([user(), reply("AB"), reply("New piece while offline", "a2"), idle()]);
  await r.session.catchingUp();
  await tick();
  await r.session.catchingUp();
  await r.session.close();
  assert.equal(text(r.events), "ABNew piece while offline");
  assert.equal(r.events.filter((e) => e.type === "turn.end").length, 1);
});

test("recheck: resumed steering execution must be known after its live completion", async () => {
  const r = await rig();
  await r.session.close();
  const events: ProviderEvent[] = [];
  const messages = [user(), user("u2", "Steered before the first answer"), reply("Current", "a2")];
  r.api.messages = async () => messages;
  r.api.active = async () => new Set([id]);
  const restored = new OpenCodeSession(
    { id, cwd: "/tmp", settings: { model: "m", provider: "p", reasoningEffort: "" } },
    { ...r.sink, emit: (event) => events.push(event) }, r.host,
    { info: { id, time: { created: 1, updated: 2 } }, messages, running: true, recover: true },
  );
  restored.attached();
  await restored.catchingUp();
  // Uncover the final piece then finish over the live stream.
  restored.event(event("session.text.ended", { assistantMessageID: "a2", ordinal: 0, text: "Current" }));
  restored.event(event("session.execution.succeeded"));
  const before = events.length;
  r.api.messages = async () => [...messages, idle()];
  r.api.active = async () => new Set<string>();
  restored.reconnected();
  await restored.catchingUp();
  await restored.close();
  assert.equal(events.slice(before).filter((e) => e.type === "turn.begin").length, 0);
  assert.equal(text(events), "Current");
});

test("recheck: confirmed native cancellation must retire prompt tombstones", async () => {
  const api = { prompt: async () => ({ id: "unused" }), cancelInbox: async () => {} } as unknown as OpenCodeApi;
  const inbox = new OpenCodeInbox(id, async () => api, { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "" }) }, [], []);
  for (let i = 0; i < 100; ++i) {
    const requestId = `portals-${i}`;
    await inbox.add({ text: "Cancelled payload", images: [] }, requestId, []);
    await inbox.delete(requestId);
    inbox.cancelled(`msg_${requestId}`); // A native cancellation event proves that delivery did not win.
  }
  const retained = (inbox as any).pending.size;
  inbox.close();
  assert.equal(retained, 0);
});

test("recheck: resolved form must not be resurrected by an old list response", async () => {
  const cards: string[] = [];
  const snapshot = deferred<any[]>();
  const api = { forms: () => snapshot.promise } as unknown as OpenCodeApi;
  const form: FormInfo = { id: "frm_old", sessionID: id, title: "Answer", fields: [{ key: "answer", type: "string" }] };
  const forms = new OpenCodeForms(id, async () => api, {
    emit() {},
    ask: async (_card, signal) => {
      cards.push("card");
      return new Promise((resolve) => signal!.addEventListener("abort", () => resolve({ kind: "withdrawn", reason: "" }), { once: true }));
    },
  });
  void forms.ask(form);
  const reconciling = forms.reconcile();
  await tick();
  forms.resolved(form.id);
  snapshot.resolve([form]);
  await reconciling;
  const shown = cards.length;
  forms.close();
  assert.equal(shown, 1);
});

test("recheck: explicit provider must normalize its native ID despite another provider's exact key", () => {
  const catalog: ModelCatalog = {
    providers: [
      { slug: "anthropic", name: "Anthropic", models: ["anthropic/shared"] },
      { slug: "openrouter", name: "OpenRouter", models: ["openrouter/anthropic/shared"] },
    ],
    model: "anthropic/shared", provider: "anthropic", reasoning: "",
    names: { "anthropic/shared": "Shared", "openrouter/anthropic/shared": "Shared" },
  };
  const agent = { profile: { kind: "opencode", displayName: "OpenCode" } } as Provider;
  assert.deepEqual(chooseModel(agent, catalog, "anthropic/shared", "openrouter"), { model: "openrouter/anthropic/shared", provider: "openrouter" });
});

test("recheck: late refresh for the previous execution cannot end the next execution", async () => {
  const r = await rig();
  r.session.startTurn({ text: "Question", images: [] });
  await tick();
  r.api.messages = async () => [user(), reply("A")];
  r.api.active = async () => new Set([id]);
  r.session.reconnected();
  await r.session.catchingUp();
  const entered = deferred<void>(), snapshot = deferred<Message[]>();
  r.api.messages = () => { entered.resolve(); return snapshot.promise; };
  r.session.event(event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "B" }));
  await entered.promise;
  r.session.event(event("session.text.ended", { assistantMessageID: "a1", ordinal: 0, text: "AB" }));
  r.session.event(event("session.execution.succeeded"));
  r.session.startTurn({ text: "Next", images: [] });
  await tick();
  snapshot.resolve([user(), reply("AB"), idle()]);
  await r.session.catchingUp();
  assert.equal(r.events.filter((e) => e.type === "turn.end").length, 1);
  await r.session.close();
});

test("recheck: Stop interrupts slash-command work without deleting uncorrelated native input", async () => {
  const r = await rig();
  const entered = deferred<void>(), response = deferred<void>();
  const cancelled: string[] = [];
  let interrupts = 0;
  r.api.commands = async () => [{ name: "task" }] as never[];
  r.api.command = () => { entered.resolve(); return response.promise; };
  r.api.cancelInbox = async (_session?: string, inboxID?: string) => { cancelled.push(inboxID!); };
  r.api.interrupt = async () => { ++interrupts; return false; };
  r.session.startTurn({ text: "/task", images: [] });
  await entered.promise;
  r.session.event(event("session.inbox.enqueued", { inboxID: "msg_native_command", item: { type: "user", payload: { text: "Expanded command" }, delivery: "steer" } }));
  await r.session.interrupt();
  response.resolve();
  await tick();
  await r.session.close();
  assert.deepEqual(cancelled, [], "native callback input has no ownership correlation, even with only one enqueue");
  assert.ok(interrupts >= 2, "interrupt again after the callback has settled");
});

test("recheck: stale child snapshots cannot resurrect a live-completed execution", async () => {
  const events: ProviderEvent[] = [];
  const child = { id: "ses_child", parentID: id, time: { created: 1, updated: 1 } };
  const listed = deferred<any[]>();
  const api = {
    sessions: async (_limit: number, parent: string) => parent === id ? listed.promise : [],
    active: async () => new Set([child.id]),
    forms: async () => [],
  } as unknown as OpenCodeApi;
  const children = new OpenCodeSubagents(id, async () => api, { emit: (e) => events.push(e), ask: async () => ({ kind: "withdrawn", reason: "" }) }, () => {}, [], [child], new Set([child.id]));
  const recovering = children.reconcile();
  await tick();
  children.event({ ...event("session.execution.succeeded"), data: { sessionID: child.id } });
  listed.resolve([child]); // The read began while the child was still active.
  await recovering;
  const running = children.hasRunning();
  children.close();
  assert.equal(running, false);
});

test("recheck: buffered frames are released on close", async () => {
  const turn = new OpenCodeTurn(id);
  const release = deferred<void>(), entered = deferred<void>();
  turn.begin("u1");
  turn.attach();
  turn.recover(async () => { entered.resolve(); await release.promise; }, () => {});
  await entered.promise;
  for (let i = 0; i < 10000; ++i) turn.receive(event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "x" }), () => {}, () => {});
  assert.ok((turn as any).held.length <= recoveryBufferLimit.frames);
  assert.ok((turn as any).heldBytes <= recoveryBufferLimit.bytes);
  turn.close();
  assert.equal((turn as any).held.length, 0);
  release.resolve();
  await turn.catchingUp;
});
