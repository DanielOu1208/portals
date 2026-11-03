import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createThread, isEvent, RpcFailure, runTurn, startTestBridge, TestClient, type TestBridge } from "./helpers.ts";

// A connection that stops following a thread (feature session_leave): the app lets go of a
// thread at rest past the few it keeps, and another device, a terminal or the fleet may set
// it to work meanwhile; its events and questions went on coming to the app until it
// reconnected, all for a thread nobody looked at.

async function setUp(t: TestContext): Promise<{ bridge: TestBridge; app: TestClient; other: TestClient }> {
  const bridge = await startTestBridge();
  const app = await TestClient.open(bridge);
  const other = await TestClient.open(bridge);
  t.after(async () => {
    await app.close();
    await other.close();
    await bridge.dispose();
  });
  return { bridge, app, other };
}

/** Both connections follow a new thread: made on `other`, resumed on `app`. */
async function followedByBoth(app: TestClient, other: TestClient): Promise<string> {
  const thread = await createThread(other);
  await app.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
  return thread;
}

test("gateway.ready offers session_leave", async (t) => {
  const { app } = await setUp(t);
  assert.ok(app.readyPayload.bridge.features.includes("session_leave"));
});

test("a connection that leaves a thread hears nothing more of it, and the thread runs on for its other followers", async (t) => {
  const { app, other } = await setUp(t);
  const thread = await followedByBoth(app, other);
  await runTurn(other, thread, "hello");
  // Followed: it hears the first turn.
  await app.find((frame) => isEvent(frame, "message.complete", thread));

  assert.deepEqual(await app.call("session.leave", { session_id: thread, profile: "fake" }), {});
  const heard = app.events(thread).length;
  const events = await runTurn(other, thread, "and again");
  assert.ok(events.some((event) => event.type === "message.delta"), "the other follower hears the turn");
  await sleep(100);
  assert.equal(app.events(thread).length, heard, "nothing of the second turn came to the connection that left");
});

test("a question raised after leaving goes only to the followers", async (t) => {
  const { app, other } = await setUp(t);
  const thread = await followedByBoth(app, other);
  await app.call("session.leave", { session_id: thread, profile: "fake" });
  const askedBefore = app.frames.filter((frame) => typeof frame.id === "string" && frame.id.startsWith("srq-")).length;
  await other.call("prompt.submit", { session_id: thread, text: "approve", profile: "fake" });
  const asked = await other.nextRequest();
  assert.equal(asked.method, "approval");
  other.answer(asked.id, { choice: "once" });
  await other.find((frame) => isEvent(frame, "message.complete", thread));
  assert.equal(app.frames.filter((frame) => typeof frame.id === "string" && frame.id.startsWith("srq-")).length, askedBefore);
});

test("a resume after leaving follows the thread again", async (t) => {
  const { app, other } = await setUp(t);
  const thread = await followedByBoth(app, other);
  await app.call("session.leave", { session_id: thread, profile: "fake" });
  await app.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
  const start = app.frames.length;
  await runTurn(other, thread, "back again");
  await app.from(start, (frame) => isEvent(frame, "message.complete", thread));
});

test("leaving a thread not followed, or not loaded, changes nothing and answers {}", async (t) => {
  const { app, other } = await setUp(t);
  const thread = await createThread(other);
  // Never followed on this connection.
  assert.deepEqual(await app.call("session.leave", { session_id: thread, profile: "fake" }), {});
  // Left twice.
  const followed = await followedByBoth(app, other);
  await app.call("session.leave", { session_id: followed, profile: "fake" });
  assert.deepEqual(await app.call("session.leave", { session_id: followed, profile: "fake" }), {});
  // A thread the bridge does not have.
  assert.deepEqual(await app.call("session.leave", { session_id: "no-such-thread", profile: "fake" }), {});
  // The other connection still follows the thread it made.
  const events = await runTurn(other, thread, "still there");
  assert.ok(events.some((event) => event.type === "message.complete"));
});

test("leaving names the thread", async (t) => {
  const { app } = await setUp(t);
  await assert.rejects(app.call("session.leave", { profile: "fake" }), (error: unknown) => error instanceof RpcFailure && error.code === -32602);
});

test("one connection leaving changes nothing for another on the same thread", async (t) => {
  const { bridge, app, other } = await setUp(t);
  const third = await TestClient.open(bridge);
  t.after(() => third.close());
  const thread = await followedByBoth(app, other);
  await third.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
  await app.call("session.leave", { session_id: thread, profile: "fake" });
  const start = third.frames.length;
  await runTurn(other, thread, "for the two still following");
  await third.from(start, (frame) => isEvent(frame, "message.complete", thread));
});
