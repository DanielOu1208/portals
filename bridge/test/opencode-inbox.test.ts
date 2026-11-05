import assert from "node:assert/strict";
import { test } from "./opencode-test.ts";
import { OpenCodeInbox } from "../src/providers/opencode/inbox.ts";
import type { OpenCodeApi } from "../src/providers/opencode/client.ts";
import type { ProviderEvent, SessionSink } from "../src/providers/types.ts";
import type { Message } from "../src/providers/opencode/protocol.ts";
import type { SessionInboxInfo } from "@opencode/client";

const prompt = { text: "Steer", images: [] };

function rig() {
  const events: ProviderEvent[] = [];
  let messages: Message[] = [];
  let waiting: SessionInboxInfo[] = [];
  let fail = false;
  let deleting = () => {};
  let submissions = 0;
  const api = {
    prompt: async () => { submissions += 1; if (fail) throw new Error("lost response"); },
    cancelInbox: async () => deleting(),
    inbox: async () => waiting,
    messages: async () => messages,
  } as unknown as OpenCodeApi;
  const sink: SessionSink = { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "not used" }) };
  const inbox = new OpenCodeInbox("ses_test", async () => api, sink, [], []);
  return { inbox, events, api, sink, submissions: () => submissions, fail: () => { fail = true; }, deletion: (fn: () => void) => { deleting = fn; }, stored: (value: Message[]) => { messages = value; }, waiting: (value: SessionInboxInfo[]) => { waiting = value; } };
}

test("OpenCode delivery receipts are once-only, including delivery that raced deletion", async () => {
  const r = rig();
  await r.inbox.add(prompt, "portals-one", []);
  await r.inbox.add(prompt, "portals-one", []);
  assert.equal(r.submissions(), 1);
  assert.equal(r.events.length, 0);
  r.deletion(() => r.inbox.delivered("msg_portals-one"));
  assert.equal(await r.inbox.delete("portals-one"), false);
  r.inbox.delivered("msg_portals-one");
  assert.deepEqual(r.events, [{ type: "queue.consumed", requestId: "portals-one" }]);
  assert.equal(r.inbox.queuedConsumed("portals-one"), true);
});

test("an uncertain admission never resends, and a late native receipt reconciles the failed handoff", async () => {
  const r = rig();
  r.fail();
  await assert.rejects(r.inbox.add(prompt, "portals-one", []), /lost response/);
  await assert.rejects(r.inbox.add(prompt, "portals-one", []), /not confirmed/);
  assert.equal(r.submissions(), 1);
  r.inbox.delivered("msg_portals-one");
  assert.deepEqual(r.events, [{ type: "queue.taken", requestId: "portals-one", prompt }]);
});

test("native history proves consumption on reconnect and after a bridge restart", async () => {
  const r = rig();
  await r.inbox.add(prompt, "portals-one", []);
  const messages: Message[] = [{ id: "msg_portals-one", type: "user", text: prompt.text, time: { created: 1 } }];
  r.stored(messages);
  await r.inbox.reconcile();
  assert.deepEqual(r.events, [{ type: "queue.consumed", requestId: "portals-one" }]);
  const restarted = new OpenCodeInbox("ses_test", async () => r.api, r.sink, messages, []);
  assert.equal(restarted.queuedConsumed("portals-one"), true);
});

test("native pending inbox IDs survive restart and a cancellation is not mistaken for delivery", async () => {
  const r = rig();
  const item: SessionInboxInfo = { id: "msg_portals-one", sessionID: "ses_test", type: "user", payload: { text: prompt.text }, delivery: "steer", time: { created: 1 } };
  const restored = new OpenCodeInbox("ses_test", async () => r.api, r.sink, [], [item]);
  r.waiting([item]);
  await restored.reconcile();
  assert.equal(r.events.length, 0);
  r.waiting([]);
  await restored.reconcile();
  assert.equal(r.events[0].type, "queue.failed");
  assert.equal(restored.queuedConsumed("portals-one"), false);
  restored.delivered("msg_portals-one");
  assert.equal(r.events[1].type, "queue.taken");
});

test("a closed inbox never emits delayed reconnect or delivery events", async () => {
  const r = rig();
  await r.inbox.add(prompt, "portals-one", []);
  r.inbox.close();
  await r.inbox.reconcile();
  r.inbox.delivered("msg_portals-one");
  r.inbox.cancelled("msg_portals-one");
  assert.equal(r.events.length, 0);
});

test("history reconciles a late delivery after a successful no-op takeback", async () => {
  const r = rig();
  await r.inbox.add(prompt, "portals-one", []);
  assert.equal(await r.inbox.delete("portals-one"), true);
  r.stored([{ id: "msg_portals-one", type: "user", text: prompt.text, time: { created: 1 } }]);
  await r.inbox.reconcile();
  assert.deepEqual(r.events, [{ type: "queue.taken", requestId: "portals-one", prompt }]);
});
