import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createThread, startTestBridge, TestClient, type Frame, type TestBridge } from "./helpers.ts";

// A thread started on another Mac of the net tells the thread that started it, there, when
// it finishes or asks something; a wait from that Mac says who waits, so that the thread
// that waits is not told twice (Fleet.tellStarter across the net; Codex's review of the
// branch). Two bridges on this Mac stand in for two Macs, as in net-bridges.test.ts.

let a: TestBridge;
let b: TestBridge;
let toA: TestClient;
let toB: TestClient;
let parent = "";

before(async () => {
  // B's agent slow enough that a wait sent after a message meets the turn still at work.
  a = await startTestBridge({ config: { fleet: { name: "Mac A", tellStarters: true } } });
  b = await startTestBridge({ config: { fleet: { name: "Mac B", tellStarters: true }, fake: { delayMs: 40 } } });
  toA = await TestClient.open(a);
  toB = await TestClient.open(b);
  await toB.call("net.join_with", { link: (await toA.call("net.invite")).link });
  // A reaches B's threads by the net's name for it.
  const ends = Date.now() + 10_000;
  while (!(await toA.call("machines.list")).machines?.some((machine: { name: string; reachable: boolean }) => machine.name === "mac-b" && machine.reachable)) {
    if (Date.now() > ends) throw new Error("A never reached B");
    await sleep(25);
  }
  parent = await createThread(toA);
});

after(async () => {
  await Promise.all([toA, toB].map((client) => client.close()));
  await Promise.all([a, b].map((bridge) => bridge.dispose()));
});

async function notices(): Promise<string[]> {
  const reading = await toA.call("thread.read", { thread: parent, last: 20 });
  return (reading.messages as Frame[]).map((message) => String(message.text)).filter((text) => text.startsWith("[Portals: from") && text.includes("Notice from the bridge"));
}

test("a thread started on another Mac tells its starter there when it finishes, and the start says it will", async () => {
  const started = await toA.call("thread.start", { profile: "fake", machine: "mac-b", from: parent, text: "far away" });
  assert.equal(started.tells_starter, true);
  assert.match(started.thread.id, /^mac-b\//);
  const ends = Date.now() + 10_000;
  let told: string | undefined;
  while (!(told = (await notices()).find((text) => text.includes("finished its turn")))) {
    if (Date.now() > ends) assert.fail("A's thread was not told of B's");
    await sleep(25);
  }
  // From B's thread, on Mac B.
  assert.match(told, /^\[Portals: from Fake agent .*on Mac B\]/m);
});

test("a wait from the starter's Mac says who waits: no notice follows the rest it is told of", async () => {
  const before = (await notices()).length;
  const started = await toA.call("thread.start", { profile: "fake", machine: "mac-b", from: parent, text: "and wait", wait: true, timeout_ms: 5000 });
  assert.equal(started.state, "idle");
  // `portals send --wait`: one call to B, which sends and waits in one step.
  const sent = await toA.call("thread.send", { thread: started.thread.id, text: "again", from: parent, wait: true, timeout_ms: 5000 });
  assert.equal(sent.state, "idle");
  // `portals wait` after a message: the wait says who waits.
  await toA.call("thread.send", { thread: started.thread.id, text: "once more", from: parent });
  const rest = await toA.call("thread.wait", { thread: started.thread.id, from: parent, timeout_ms: 5000 });
  assert.equal(rest.state, "idle");
  await sleep(400);
  assert.equal((await notices()).length, before);
});

test("a turn on the other Mac that fails as it begins is told to the starter's wait alone", async () => {
  const before = (await notices()).length;
  const started = await toA.call("thread.start", { profile: "fake", machine: "mac-b", from: parent, text: "fail there", wait: true, timeout_ms: 5000 });
  assert.equal(started.state, "error");
  await toA.call("thread.send", { thread: started.thread.id, text: "fail there again", from: parent, wait: true, timeout_ms: 5000 });
  await sleep(400);
  assert.equal((await notices()).length, before);
});

test("a message the starter sends from its Mac after a report, while that turn still runs, is told once done", async () => {
  // Bug hunt round 4, BC1: the report's mark took the rest of the work asked after it.
  const before = (await notices()).length;
  const started = await toA.call("thread.start", { profile: "fake", machine: "mac-b", from: parent, text: "do the first part" });
  const child = String(started.thread.id).split("/")[1];
  assert.equal((await toB.call("thread.wait", { thread: child, timeout_ms: 1 })).state, "working");
  await toB.call("thread.report", { text: "First part done.", from: child });
  await toA.call("thread.send", { thread: started.thread.id, text: "great, now the second part", from: parent });
  assert.equal((await toB.call("thread.wait", { thread: child, timeout_ms: 10_000 })).state, "idle");
  const ends = Date.now() + 10_000;
  while ((await notices()).length === before) {
    if (Date.now() > ends) assert.fail("A's thread was not told of the second part");
    await sleep(25);
  }
  await sleep(300);
  assert.equal((await notices()).length, before + 1);
});
