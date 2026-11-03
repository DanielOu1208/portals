import "./environment.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DroidQueue } from "../src/providers/droid/queue.ts";
import type { DroidHandle } from "../src/providers/droid/sdk.ts";
import type { Prompt, ProviderEvent, ProviderSession, StoredMessage } from "../src/providers/types.ts";
import { Session } from "../src/sessions/session.ts";
import { Registry } from "../src/sessions/registry.ts";
import { WaitingStore } from "../src/sessions/waiting.ts";

const prompt: Prompt = { text: "same words", images: [] };
const next = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}
function sdkQueue() {
  const events: ProviderEvent[] = [], receipts: string[] = [], sent: unknown[] = [], deleted: unknown[] = [];
  const handle = {
    addUserMessage: async (...params: unknown[]) => { sent.push(params); return {}; },
    resolveQueuedUserMessage: async (params: unknown) => { deleted.push(params); return {}; },
  } as unknown as DroidHandle;
  const queue = new DroidQueue((event) => events.push(event), (id) => { receipts.push(id); });
  return { queue, handle, events, receipts, sent, deleted };
}
function consumed(requestId: string, role = "user") {
  return { type: "create_message", requestId, message: { role, content: [{ type: "text", text: prompt.text }] } };
}

test("Droid steering uses end_of_turn and explicit RPC and message IDs", async () => {
  const r = sdkQueue();
  assert.equal(await r.queue.add(r.handle, prompt, "portals-one"), true);
  assert.deepEqual(r.sent, [[{ text: prompt.text, messageId: "portals-one", queuePlacement: "end_of_turn" }, "portals-one"]]);
  assert.deepEqual(r.receipts, []);
  r.queue.notification(consumed("wrong"));
  r.queue.notification(consumed("portals-one", "assistant"));
  assert.deepEqual(r.receipts, []);
  r.queue.notification(consumed("portals-one"));
  r.queue.notification(consumed("portals-one"));
  assert.deepEqual(r.receipts, ["portals-one"]);
  assert.deepEqual(r.events, [{ type: "queue.consumed", requestId: "portals-one" }]);
});

test("Droid never drops images or file references when attachment steering is unsupported", async () => {
  const r = sdkQueue();
  assert.equal(await r.queue.add(r.handle, { ...prompt, images: [{ filename: "pic", data: Buffer.from("pic") }] }, "image"), false);
  assert.equal(await r.queue.add(r.handle, { ...prompt, files: ["/tmp/file"] }, "file"), false);
  assert.deepEqual(r.sent, []);
});

test("Droid deletion succeeds only for an ID still pending after the reply", async () => {
  const r = sdkQueue();
  await r.queue.add(r.handle, prompt, "one");
  assert.equal(await r.queue.delete(r.handle, "one"), true);
  assert.deepEqual(r.deleted, [{ action: "delete", requestId: "one" }]);
  assert.equal(await r.queue.delete(r.handle, "one"), false);
  // A receipt after Droid's {} (which it also answers for one it had taken): Droid has it
  // after all. Kept as taken, so a restart never sends it again, and the person is told;
  // it is no longer on the list to take off (recent-17).
  r.queue.notification(consumed("one"));
  assert.deepEqual(r.receipts, ["one"]);
  assert.deepEqual(r.events.map((event) => event.type), ["queue.taken", "notice"]);
  r.queue.notification(consumed("one"));
  assert.deepEqual(r.receipts, ["one"]);

  await r.queue.add(r.handle, prompt, "race");
  const held = gate();
  r.handle.resolveQueuedUserMessage = async () => { await held.promise; return {}; };
  const deleting = r.queue.delete(r.handle, "race");
  r.queue.notification(consumed("race"));
  held.resolve();
  assert.equal(await deleting, false);
  assert.deepEqual(r.receipts, ["one", "race"]);
});

test("a failed Droid deletion leaves the pending message removable on retry", async () => {
  const r = sdkQueue();
  await r.queue.add(r.handle, prompt, "one");
  r.handle.resolveQueuedUserMessage = async () => { throw new Error("connection failed"); };
  await assert.rejects(r.queue.delete(r.handle, "one"));
  r.handle.resolveQueuedUserMessage = async () => ({});
  assert.equal(await r.queue.delete(r.handle, "one"), true);
});

test("Droid discarded messages match IDs, not text, and warnings never copy raw discard text", async () => {
  const r = sdkQueue();
  await r.queue.add(r.handle, prompt, "one");
  await r.queue.add(r.handle, prompt, "two");
  r.queue.notification({ type: "queued_messages_discarded", requestId: "one", text: "private raw text" });
  r.queue.notification(consumed("two"));
  assert.deepEqual(r.receipts, ["two"]);
  assert.deepEqual(r.events.filter((e) => e.type === "queue.failed").map((e) => e.requestId), ["one"]);
  assert.ok(!JSON.stringify(r.events).includes("private raw text"));
  r.queue.finish();
  assert.equal(r.events.filter((e) => e.type === "queue.failed").length, 1);
});

test("Droid's ID-less discard and failed send become retryable failures, never automatic resends", async () => {
  const r = sdkQueue();
  await r.queue.add(r.handle, prompt, "one");
  await r.queue.add(r.handle, prompt, "two");
  r.queue.notification({ type: "queued_messages_discarded", text: "not an identity" });
  r.handle.addUserMessage = async () => { throw new Error("lost acknowledgement"); };
  assert.equal(await r.queue.add(r.handle, prompt, "three"), true);
  r.queue.finish();
  assert.deepEqual(r.events.filter((e) => e.type === "queue.failed").map((e) => e.requestId), ["one", "two", "three"]);
  assert.equal(r.sent.length, 2);
});

function bridgeQueue(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "portals-droid-queue-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const waiting = new WaitingStore(root);
  const session = new Session({
    id: "thread", agent: "droid", cwd: root, title: null, model: "m", provider: "droid", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone",
  }, { has: () => false } as unknown as Registry, { waiting });
  const starts: Prompt[] = [], handed: string[] = [], deletions: string[] = [];
  const provider: ProviderSession = {
    history: async () => [], settings: () => ({ model: "m", provider: "droid", reasoningEffort: "" }),
    startTurn: (prompt) => { starts.push(prompt); },
    enqueue: async (_prompt, requestId) => { handed.push(requestId); return true; },
    deleteQueued: async (id) => { deletions.push(id); return true; },
    queuedConsumed: () => false,
    setModel: async () => ({ deferred: false }), setReasoning: async () => {},
    interrupt: async () => false, close: async () => {},
  };
  return { session, provider, waiting, starts, handed, deletions };
}

test("Portals keeps Queue local and persists a Steer handoff until exact consumption", async (t) => {
  const r = bridgeQueue(t);
  await r.session.attach(r.provider);
  r.session.submit("first").begin?.();
  const queued = r.session.submit("second", { queue: true });
  assert.deepEqual(r.handed, []);
  assert.deepEqual(r.session.queuedMessages(), [{ id: queued.queueID, text: "second", placement: "queue" }]);
  assert.equal(await r.session.placeQueued(queued.queueID!, "steer"), "moved");
  const held = r.waiting.read("thread")[0];
  assert.equal(held.requestId, r.handed[0]);
  assert.equal(held.placement, "steer");
  assert.deepEqual(r.session.snapshot().queued, r.session.queuedMessages());
  assert.deepEqual(r.session.snapshot().queued, r.session.queuedMessages());
  assert.equal(r.handed.length, 1);
  r.session.sink.emit({ type: "queue.consumed", requestId: r.handed[0] });
  assert.deepEqual(r.session.queuedMessages(), []);
  assert.deepEqual(r.waiting.read("thread"), []);
  assert.deepEqual(r.session.messages.filter((m) => m.role === "user").map((m) => m.text), ["first", "second"]);
  r.session.sink.emit({ type: "turn.end", status: "complete" });
  await next();
  assert.equal(r.starts.length, 1);
});

test("moving Steer to Queue deletes first, then opens one new turn after completion", async (t) => {
  const r = bridgeQueue(t);
  await r.session.attach(r.provider);
  r.session.submit("first").begin?.();
  const queued = r.session.submit("second");
  await next();
  assert.equal(await r.session.placeQueued(queued.queueID!, "queue"), "moved");
  assert.deepEqual(r.deletions, [r.handed[0]]);
  assert.equal(r.waiting.read("thread")[0].requestId, undefined);
  assert.equal(r.starts.length, 1);
  r.session.sink.emit({ type: "turn.end", status: "complete" });
  await next();
  assert.deepEqual(r.starts.map((p) => p.text), ["first", "second"]);
});

test("a successful Droid deletion racing turn completion unblocks the following local Queue", async (t) => {
  const r = bridgeQueue(t);
  const sdk = sdkQueue();
  const queue = new DroidQueue((event) => r.session.sink.emit(event), () => {});
  r.provider.enqueue = (prompt, id) => queue.add(sdk.handle, prompt, id);
  const reply = gate();
  sdk.handle.resolveQueuedUserMessage = async () => { await reply.promise; return {}; };
  r.provider.deleteQueued = async (id) => {
    const deleted = await queue.delete(sdk.handle, id);
    // Droid's queue no longer holds it, but Session is still awaiting the deletion.
    queue.finish();
    r.session.sink.emit({ type: "turn.end", status: "complete" });
    return deleted;
  };
  await r.session.attach(r.provider);
  r.session.submit("first").begin?.();
  const removing = r.session.submit("remove me");
  r.session.submit("local", { queue: true });
  await next();
  const deleted = r.session.removeQueued(removing.queueID!);
  reply.resolve();
  assert.equal(await deleted, true);
  await next();
  assert.deepEqual(r.starts.map((prompt) => prompt.text), ["first", "local"]);
  assert.deepEqual(r.session.queuedMessages(), []);
  assert.deepEqual(r.waiting.read("thread"), []);
});

test("a refused Droid deletion racing turn completion still fails that steer and sends the local Queue", async (t) => {
  const r = bridgeQueue(t);
  const sdk = sdkQueue();
  const queue = new DroidQueue((event) => r.session.sink.emit(event), () => {});
  r.provider.enqueue = (prompt, id) => queue.add(sdk.handle, prompt, id);
  const reply = gate();
  sdk.handle.resolveQueuedUserMessage = async () => { await reply.promise; throw new Error("Droid took too long to answer."); };
  r.provider.deleteQueued = async (id) => {
    try { return await queue.delete(sdk.handle, id); }
    finally {
      queue.finish();
      r.session.sink.emit({ type: "turn.end", status: "complete" });
    }
  };
  await r.session.attach(r.provider);
  r.session.submit("first").begin?.();
  const removing = r.session.submit("unconfirmed");
  r.session.submit("local", { queue: true });
  await next();
  const deleted = r.session.removeQueued(removing.queueID!);
  reply.resolve();
  assert.equal(await deleted, false);
  await next(); await next();
  assert.deepEqual(r.starts.map((prompt) => prompt.text), ["first", "local"]);
  assert.equal(r.waiting.readFailed("thread")[0].text, "unconfirmed");
});

test("Droid slash commands stay on the bridge Queue and cannot be steered as model text", async (t) => {
  const r = bridgeQueue(t);
  await r.session.attach(r.provider);
  r.session.submit("first").begin?.();
  const queued = r.session.submit("/compact keep this");
  assert.equal(r.session.queuedMessages()[0].placement, "queue");
  assert.equal(await r.session.placeQueued(queued.queueID!, "steer"), "queued");
  assert.deepEqual(r.handed, []);
});

test("failed deletion never claims removal or moves a pending steer into Queue", async (t) => {
  const r = bridgeQueue(t);
  await r.session.attach(r.provider);
  r.session.submit("first").begin?.();
  const queued = r.session.submit("second");
  await next();
  r.provider.deleteQueued = async () => { throw new Error("lost connection"); };
  assert.equal(await r.session.removeQueued(queued.queueID!), false);
  assert.equal(await r.session.placeQueued(queued.queueID!, "queue"), "queued");
  assert.equal(r.session.queuedMessages()[0].placement, "steer");
  assert.ok(r.waiting.read("thread")[0].requestId);
});

test("consumption wins a concurrent move to Queue without duplicating the message", async (t) => {
  const r = bridgeQueue(t);
  await r.session.attach(r.provider);
  r.session.submit("first").begin?.();
  const queued = r.session.submit("second");
  await next();
  const held = gate();
  r.provider.deleteQueued = async () => { await held.promise; return true; };
  const moving = r.session.placeQueued(queued.queueID!, "queue");
  r.session.sink.emit({ type: "queue.consumed", requestId: r.handed[0] });
  held.resolve();
  assert.equal(await moving, "gone");
  r.session.sink.emit({ type: "turn.end", status: "complete" });
  await next();
  assert.deepEqual(r.starts.map((p) => p.text), ["first"]);
});

test("a discarded or failed steer emits a queue change and remains removable without replay", async (t) => {
  for (const thrown of [false, true]) {
    const r = bridgeQueue(t);
    await r.session.attach(r.provider);
    if (thrown) r.provider.enqueue = async () => { throw new Error("send failed"); };
    r.session.submit("first").begin?.();
    const queued = r.session.submit("discard me");
    await next();
    const before = r.session.eventsSince(0).events.length;
    if (!thrown) r.session.sink.emit({ type: "queue.failed", requestId: r.handed[0], error: "Droid discarded it." });
    assert.equal(r.waiting.read("thread")[0].requestId, undefined);
    assert.ok(r.waiting.read("thread")[0].failure);
    assert.equal(r.session.queuedMessages()[0].placement, "queue");
    if (!thrown) assert.ok(r.session.eventsSince(0).events.length > before);
    assert.equal(await r.session.removeQueued(queued.queueID!), true);
    assert.deepEqual(r.deletions, []);
    assert.deepEqual(r.session.queuedMessages(), []);
    r.session.sink.emit({ type: "turn.end", status: "complete" });
    await next();
    assert.deepEqual(r.starts.map((p) => p.text), ["first"]);
  }
});

test("a discarded steer becomes a durable failed turn, while the local Queue still sends", async (t) => {
  const r = bridgeQueue(t);
  await r.session.attach(r.provider);
  r.session.submit("first").begin?.();
  r.session.submit("discard me");
  r.session.submit("local", { queue: true });
  await next();
  r.session.sink.emit({ type: "queue.failed", requestId: r.handed[0], error: "Droid discarded it." });
  r.session.sink.emit({ type: "turn.end", status: "complete" });
  await next(); await next();
  assert.deepEqual(r.starts.map((p) => p.text), ["first", "local"]);
  assert.equal(r.waiting.readFailed("thread")[0].text, "discard me");
  assert.ok(r.session.messages.some((m) => m.role === "assistant" && m.display_kind === "failed_turn"));
});

test("a late Droid receipt removes only its own failed turn, before telling devices the message was steered (D5)", async (t) => {
  const r = bridgeQueue(t);
  await r.session.attach(r.provider);
  const peerEvents: { type: string; payload?: Record<string, unknown> }[] = [];
  r.session.follow({ isOpen: true, takesRequests: false, messageReconciliation: true, sendEvent: (event) => { peerEvents.push(event); }, sendRequest() {} });
  const oldEvents: string[] = [];
  let legacyResyncs = 0;
  r.session.follow({ isOpen: true, takesRequests: false, sendEvent: (event) => { oldEvents.push(event.type); }, sendRequest() {}, resync() { legacyResyncs++; } });
  r.session.submit("first").begin?.();
  r.session.submit("same words", { messageID: "message-one" });
  r.session.submit("same words", { messageID: "message-two" });
  await next();
  const [one, two] = r.handed;
  for (const id of [one, two]) r.session.sink.emit({ type: "queue.failed", requestId: id, error: "No receipt." });
  r.session.sink.emit({ type: "turn.end", status: "complete" });
  await next(); await next();
  assert.equal(r.waiting.readFailed("thread").length, 2);
  r.session.sink.emit({ type: "turn.begin", user: "", host: { kind: "hidden", text: "" } });
  r.session.sink.emit({ type: "text", text: "Already answering background work." });
  const mark = peerEvents.length;
  r.session.sink.emit({ type: "queue.taken", requestId: one, prompt: { text: "same words", images: [] } });
  assert.equal(r.waiting.readFailed("thread").length, 1);
  assert.equal(r.waiting.readFailed("thread")[0].requestId, two);
  assert.equal(r.session.messages.filter((message) => message.role === "assistant" && message.display_kind === "failed_turn").length, 1);
  assert.deepEqual(peerEvents.slice(mark).map((event) => event.type), ["message.taken", "message.steered"]);
  assert.equal(peerEvents[mark].payload?.request_id, one);
  assert.equal(peerEvents[mark + 1].payload?.message_id, "message-one");
  assert.equal(oldEvents.at(-1), "session.invalidated");
  assert.equal(legacyResyncs, 1);
  assert.equal((r.session.snapshot().inflight as { user: string }).user, "same words");
});

test("after restart a failed Droid steer with a saved receipt is not shown failed a second time (D5)", async (t) => {
  const r = bridgeQueue(t);
  r.waiting.write("thread", [], [{ text: "same words", error: "No receipt.", at: 1, requestId: "taken", messageID: "mine" }]);
  r.provider.queuedConsumed = (id) => id === "taken";
  r.provider.history = async () => [{ role: "user", text: "same words", display_kind: "steer", timestamp: 1 }];
  await r.session.attach(r.provider);
  assert.equal(r.session.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(r.session.messages.some((message) => message.role === "assistant" && message.display_kind === "failed_turn"), false);
  assert.deepEqual(r.waiting.readFailed("thread"), []);
});

test("a late receipt repairs an evicted failure and tells paged followers where history moved", async (t) => {
  const r = bridgeQueue(t);
  await r.session.attach(r.provider);
  const events: { type: string; payload?: Record<string, unknown> }[] = [];
  r.session.follow({ isOpen: true, takesRequests: false, messageReconciliation: true, sendEvent: (event) => { events.push(event); }, sendRequest() {} });
  r.session.submit("first").begin?.();
  for (let i = 0; i < 21; i++) r.session.submit(`failed-${i}`, { messageID: `message-${i}` });
  await next();
  for (const requestId of r.handed) r.session.sink.emit({ type: "queue.failed", requestId, error: "No receipt." });
  r.session.sink.emit({ type: "turn.end", status: "complete" });
  for (let i = 0; i < 23; i++) await next();
  assert.equal(r.waiting.readFailed("thread").length, 20);
  assert.equal(r.session.messages.filter((m) => m.role === "assistant" && m.display_kind === "failed_turn").length, 21);
  assert.ok(!r.waiting.readFailed("thread").some((m) => m.requestId === r.handed[0]));
  r.session.sink.emit({ type: "turn.begin", user: "", host: { kind: "hidden", text: "" } });
  const before = r.session.snapshot(2);
  const mark = events.length;
  r.session.sink.emit({ type: "queue.taken", requestId: r.handed[0], prompt: { text: "failed-0", images: [] } });
  assert.equal(r.session.messages.filter((m) => m.role === "assistant" && m.display_kind === "failed_turn").length, 20);
  assert.deepEqual(events.slice(mark).map((e) => e.type), ["message.taken", "message.steered"]);
  const taken = events[mark].payload!;
  assert.equal(taken.request_id, r.handed[0]);
  assert.equal(taken.removed_start, 1);
  assert.equal(taken.removed_count, 2);
  assert.equal(taken.replay_base, r.session.snapshot(2).replay_base);
  assert.notEqual(taken.replay_base, before.replay_base);
  assert.equal(events[mark + 1].payload?.message_id, "message-0");
  assert.equal(events[mark + 1].payload?.reconciled, true);
  assert.notEqual(r.session.history((before.history_start as number) - 2, 2, taken.replay_base as number), null);
});

test("saved Droid receipt cleanup cannot stop readable history or lose the local Queue when the waiting store is unwritable", async (t) => {
  const r = bridgeQueue(t);
  r.waiting.write("thread", [{ id: "4", text: "local", images: [] }], [
    { text: "accepted", error: "No receipt.", at: 1, requestId: "taken" },
    { text: "not accepted", error: "No receipt.", at: 2, requestId: "unknown" },
  ]);
  r.provider.queuedConsumed = (id) => id === "taken";
  r.provider.history = async () => [{ role: "user", text: "accepted", display_kind: "steer", timestamp: 1 }];
  const write = r.waiting.write.bind(r.waiting);
  r.waiting.write = () => { throw new Error("disk full"); };
  await assert.doesNotReject(r.session.attach(r.provider));
  assert.equal(r.session.messages.some((message) => message.role === "assistant" && message.display_metadata?.failed_request_id === "taken"), false);
  assert.equal(r.session.messages.some((message) => message.role === "assistant" && message.display_metadata?.failed_request_id === "unknown"), true);
  assert.deepEqual(r.session.queuedMessages().map(({ text }) => text), ["local"]);
  assert.equal(r.waiting.readFailed("thread").length, 2, "failed cleanup leaves the durable source intact");
  r.waiting.write = write;
  await next(); await next();
  assert.deepEqual(r.starts.map(({ text }) => text), ["local"]);
  assert.deepEqual(r.waiting.readFailed("thread").map(({ requestId }) => requestId), ["unknown"]);
});

test("a receipt after deletion at rest unblocks the following local Queue even while the deletion answer is held", async (t) => {
  const r = bridgeQueue(t);
  const sdk = sdkQueue();
  const queue = new DroidQueue((event) => r.session.sink.emit(event), () => {});
  r.provider.enqueue = (prompt, id) => queue.add(sdk.handle, prompt, id);
  const answer = gate();
  r.provider.deleteQueued = async (id) => {
    const deleted = await queue.delete(sdk.handle, id);
    await answer.promise;
    return deleted;
  };
  await r.session.attach(r.provider);
  r.session.submit("first").begin?.();
  const queued = r.session.submit("accepted");
  r.session.submit("local", { queue: true });
  await next();
  const requestId = r.waiting.read("thread")[0].requestId;
  assert.ok(requestId);
  const removing = r.session.removeQueued(queued.queueID!);
  await next();
  r.session.sink.emit({ type: "turn.end", status: "complete" });
  assert.equal(r.session.isRunning, false);
  queue.notification(consumed(requestId));
  answer.resolve();
  assert.equal(await removing, false, "known consumption wins deletion");
  await next(); await next();
  assert.deepEqual(r.starts.map(({ text }) => text), ["first", "local"]);
  assert.deepEqual(r.session.queuedMessages(), []);
  assert.equal(r.session.messages.filter((message) => message.role === "user" && message.text === "accepted").length, 1);
});

test("restart drops consumed SDK entries, fails unconfirmed entries and sends only the bridge Queue", async (t) => {
  const r = bridgeQueue(t);
  r.waiting.write("thread", [
    { id: "5", ...prompt, requestId: "consumed", placement: "steer" },
    { id: "6", ...prompt, text: "unconfirmed", requestId: "unknown", placement: "steer" },
    { id: "7", ...prompt, text: "local", placement: "queue" },
  ]);
  const history: StoredMessage[] = [{ role: "user", text: prompt.text, display_kind: "steer", timestamp: 1 }];
  r.provider.history = async () => history;
  r.provider.queuedConsumed = (id) => id === "consumed";
  await r.session.attach(r.provider);
  await next(); await next(); await next();
  assert.deepEqual(r.handed, []);
  assert.deepEqual(r.starts.map((p) => p.text), ["local"]);
  assert.equal(r.session.messages.filter((m) => m.role === "user" && m.text === prompt.text).length, 1);
  assert.equal(r.waiting.readFailed("thread")[0].text, "unconfirmed");
  assert.equal(r.session.latestQueueID, 7);
});

test("a steer Droid deleted is never sent, whenever in the step after its deletion the turn ends", async (t) => {
  for (let hops = 0; hops < 6; hops += 1) {
    const r = bridgeQueue(t);
    const deletion = gate();
    r.provider.deleteQueued = async (id) => { r.deletions.push(id); await deletion.promise; return true; };
    await r.session.attach(r.provider);
    r.session.submit("first").begin?.();
    const removing = r.session.submit("remove me");
    r.session.submit("local", { queue: true });
    await next();
    assert.equal(r.handed.length, 1);
    const removed = r.session.removeQueued(removing.queueID!);
    // Droid answers the deletion, and the turn ends a few microtasks later: before the
    // removal has taken the message off the list, or after.
    deletion.resolve();
    const end = (left: number): void => left === 0 ? r.session.sink.emit({ type: "turn.end", status: "complete" }) : queueMicrotask(() => end(left - 1));
    end(hops);
    assert.equal(await removed, true, `removed, ${hops} hops`);
    await next();
    await next();
    assert.deepEqual(r.starts.map((prompt) => prompt.text), ["first", "local"], `${hops} hops`);
  }
});

test("a steer moved back to Queue that Droid takes late all the same is not sent again as a new turn (PR #19 review B1)", async (t) => {
  const r = bridgeQueue(t);
  const sdk = sdkQueue();
  const queue = new DroidQueue((event) => r.session.sink.emit(event), () => {});
  r.provider.enqueue = (prompt, id) => queue.add(sdk.handle, prompt, id);
  r.provider.deleteQueued = (id) => queue.delete(sdk.handle, id);
  await r.session.attach(r.provider);
  r.session.submit("first").begin?.();
  const steer = r.session.submit("steer me");
  await next();
  const requestId = r.waiting.read("thread")[0].requestId!;
  assert.ok(requestId);
  // Droid answers {} for the deletion, which it also answers for one it had taken already.
  assert.equal(await r.session.placeQueued(steer.queueID!, "queue"), "moved");
  // Its receipt comes after all: Droid has it.
  queue.notification(consumed(requestId));
  r.session.sink.emit({ type: "turn.end", status: "complete" });
  await next(); await next(); await next();
  assert.deepEqual(r.starts.map(({ text }) => text), ["first"]);
  assert.deepEqual(r.session.queuedMessages(), []);
  assert.deepEqual(r.waiting.read("thread"), []);
  assert.equal(r.session.messages.filter((m) => m.role === "user" && m.text === "steer me").length, 1);
});

test("after a restart a steer moved back to Queue whose late receipt was saved is not sent again (PR #19 review B1)", async (t) => {
  const r = bridgeQueue(t);
  await r.session.attach(r.provider);
  r.session.submit("first").begin?.();
  const steer = r.session.submit("steer me");
  r.session.submit("local", { queue: true });
  await next();
  const requestId = r.handed[0];
  assert.equal(await r.session.placeQueued(steer.queueID!, "queue"), "moved");
  // The bridge stops before the turn ends; Droid's receipt for the message was saved.
  const again = bridgeQueue(t);
  const restarted = new Session({
    id: "thread", agent: "droid", cwd: "/", title: null, model: "m", provider: "droid", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone",
  }, { has: () => false } as unknown as Registry, { waiting: r.waiting });
  again.provider.queuedConsumed = (id) => id === requestId;
  again.provider.history = async () => [{ role: "user", text: "first", timestamp: 1 }, { role: "user", text: "steer me", display_kind: "steer", timestamp: 2 }];
  await restarted.attach(again.provider);
  await next(); await next(); await next();
  assert.deepEqual(again.starts.map(({ text }) => text), ["local"]);
});

test("after a restart a failed steer whose late receipt was saved is not shown failed with Try again (PR #19 review G1)", async (t) => {
  const r = bridgeQueue(t);
  r.waiting.write("thread", [
    { id: "3", text: "taken late", images: [], placement: "queue", failure: "Droid discarded it.", failedRequestId: "taken" },
    { id: "4", text: "local", images: [], placement: "queue" },
  ]);
  r.provider.queuedConsumed = (id) => id === "taken";
  r.provider.history = async () => [{ role: "user", text: "taken late", display_kind: "steer", timestamp: 1 }];
  await r.session.attach(r.provider);
  await next(); await next(); await next();
  assert.deepEqual(r.starts.map(({ text }) => text), ["local"]);
  assert.equal(r.session.messages.some((m) => m.role === "assistant" && m.display_kind === "failed_turn"), false);
  assert.deepEqual(r.waiting.readFailed("thread"), []);
});

test("a steering message Droid refuses fails at once with Droid's reason, not later with a generic one (PR #19 review R3)", async () => {
  const r = sdkQueue();
  await r.queue.add(r.handle, prompt, "refused");
  await r.queue.add(r.handle, prompt, "other");
  const note = (requestId: string, text: string, visibility = "user_only") => ({
    type: "create_message", requestId, message: { id: `note-${requestId}`, role: "system", visibility, content: [{ type: "text", text }] },
  });
  r.queue.notification(note("refused", "A note that is no error."));
  r.queue.notification(note("refused", "Error: hidden from the person", "llm_only"));
  r.queue.notification(note("unknown", "Error: not one of ours"));
  assert.equal(r.events.length, 0);
  r.queue.notification(note("refused", "Error: Your message is too large. The message was not sent."));
  assert.deepEqual(r.events.filter((e) => e.type === "queue.failed"), [
    { type: "queue.failed", requestId: "refused", error: "Droid did not take this steering message: Your message is too large. The message was not sent." },
  ]);
  r.queue.finish();
  assert.deepEqual(r.events.filter((e) => e.type === "queue.failed").map((e) => e.requestId), ["refused", "other"]);
});
