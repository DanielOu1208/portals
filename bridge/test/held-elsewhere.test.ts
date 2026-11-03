import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { bridgeFeatures } from "../src/gateway/features.ts";
import { TellStarters, type Told } from "../src/fleet/heldElsewhere.ts";
import { createThread, runTurn, startTestBridge, TestClient, type Frame, type TestBridge } from "./helpers.ts";

// A thread started on another Mac of the net keeps the thread that started it running, as
// one started on the same Mac does (2026-10-27: "i feel like we should have parity
// here shouldnt bridge talk to each other to make cross device orchestration work
// smoother?"; feature held_elsewhere, docs/fleet-plan.md). Two bridges in one net: A, where
// the starting threads are, and B, where the threads they started work. A takes B's word
// for 1.5 s here, and B says it again every 0.3 s.

let a: TestBridge;
let b: TestBridge;
let toA: TestClient;
let toB: TestClient;

before(async () => {
  a = await startTestBridge({ config: { fleet: { name: "Mac A" } }, held: { for: 1500, every: 300 } });
  b = await startTestBridge({ config: { fleet: { name: "Mac B" } }, held: { for: 1500, every: 300 } });
  toA = await TestClient.open(a);
  toB = await TestClient.open(b);
  await toB.call("net.join_with", { link: (await toA.call("net.invite")).link });
  await eventually(async () => (await toA.call("net.list")).members.length === 2 && (await toB.call("net.list")).members.length === 2, "both Macs list both");
});

after(async () => {
  await Promise.all([toA, toB].map((client) => client?.close()));
  await Promise.all([a, b].map((bridge) => bridge?.dispose()));
});

/** Waits until `check` gives something, asking again every 20 ms for up to 10 s. */
async function eventually<T>(check: () => Promise<T | undefined | false>, what: string): Promise<T> {
  const ends = Date.now() + 10_000;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() > ends) throw new Error(`timed out waiting until ${what}`);
    await sleep(20);
  }
}

/** What `sessions.activity` lists of `thread` on the bridge `client` is on. */
async function entry(client: TestClient, thread: string): Promise<Frame | undefined> {
  return ((await client.call("sessions.activity")).sessions as Frame[]).find((listed) => listed.session_id === thread);
}

/** A thread at rest on A after a turn. */
async function starterOnA(): Promise<string> {
  const thread = await createThread(toA);
  await runTurn(toA, thread, "hello");
  return thread;
}

/** A thread started on B from A's thread `from`, as an agent on A starts one with `portals start --machine`. */
async function startedOnB(from: string, text: string): Promise<string> {
  const started = await toA.call("thread.start", { machine: "mac-b", profile: "fake", from, text });
  return (started.thread.id as string).replace(/^mac-b\//, "");
}

test("a thread started on another Mac keeps the thread that started it running there, and lets it rest once it is done", async () => {
  const parent = await starterOnA();
  assert.equal(await entry(toA, parent), undefined);
  const child = await startedOnB(parent, "slow");
  await eventually(async () => (await entry(toB, child))?.state === "running", "the child works on B");
  const held = await eventually(async () => entry(toA, parent), "A lists its thread as running");
  assert.deepEqual(held, { session_id: parent, state: "running", inherited: true, turn: false });
  // Its turn over: B says so, and A's thread rests.
  await eventually(async () => (await entry(toB, child)) === undefined, "the child rests");
  await eventually(async () => (await entry(toA, parent)) === undefined, "A's thread rests");
});

test("through a thread started back on the first Mac, each Mac's starter is kept running", async () => {
  const parent = await starterOnA();
  const child = await startedOnB(parent, "hello");
  await eventually(async () => (await entry(toB, child)) === undefined, "the child rests");
  // From the child on B, a thread back on A, at work.
  const started = await toB.call("thread.start", { machine: "mac-a", profile: "fake", from: child, text: "slow" });
  const grandchild = (started.thread.id as string).replace(/^mac-a\//, "");
  await eventually(async () => (await entry(toA, grandchild))?.state === "running", "the grandchild works on A");
  await eventually(async () => (await entry(toB, child))?.inherited === true, "B lists the child as running for it");
  await eventually(async () => (await entry(toA, parent))?.inherited === true, "A lists the first thread as running for it");
});

test("a Mac gone keeps nothing running for long: its word runs out", async () => {
  const c = await startTestBridge({ config: { fleet: { name: "Mac C" } }, held: { for: 1500, every: 300 } });
  const toC = await TestClient.open(c);
  try {
    await toC.call("net.join_with", { link: (await toA.call("net.invite")).link });
    await eventually(async () => (await toA.call("net.list")).members.length === 3, "A lists C");
    const parent = await starterOnA();
    const started = await toA.call("thread.start", { machine: "mac-c", profile: "fake", from: parent, text: "slow" });
    assert.match(started.thread.id, /^mac-c\//);
    await eventually(async () => entry(toA, parent), "A lists its thread as running");
    // C stops at once, its thread at work: it says nothing more.
    await toC.close();
    await c.dispose();
    const gone = Date.now();
    await eventually(async () => (await entry(toA, parent)) === undefined, "A's thread rests once C's word runs out");
    assert.ok(Date.now() - gone < 5000);
  } finally {
    await toC.close();
    await c.dispose();
  }
});

test("only a Mac of the net says which threads its threads keep at work", async () => {
  const thread = await starterOnA();
  await assert.rejects(toA.call("threads.held", { threads: [thread] }), (error: { code?: number }) => error.code === 4003);
  assert.equal(await entry(toA, thread), undefined);
});

test("a Mac whose bridge is from before is not told, and its thread is listed as before", async () => {
  // A greets without the feature, as a bridge from before does.
  const features = bridgeFeatures as unknown as string[];
  const at = features.indexOf("held_elsewhere");
  features.splice(at, 1);
  try {
    const parent = await starterOnA();
    const child = await startedOnB(parent, "slow");
    await eventually(async () => (await entry(toB, child))?.state === "running", "the child works on B");
    await sleep(800);
    assert.equal(await entry(toA, parent), undefined);
  } finally {
    features.splice(at, 0, "held_elsewhere");
  }
});

test("a thread removed between two Macs' threads lets the first Mac's starter rest at once, not at the next renewal", async () => {
  // Words held a minute and said again each minute: only being told at once lets it rest in time.
  const near = await startTestBridge({ config: { fleet: { name: "Mac N" } }, held: { for: 60_000, every: 60_000 } });
  const far = await startTestBridge({ config: { fleet: { name: "Mac F" } }, held: { for: 60_000, every: 60_000 } });
  const toNear = await TestClient.open(near);
  const toFar = await TestClient.open(far);
  try {
    await toFar.call("net.join_with", { link: (await toNear.call("net.invite")).link });
    await eventually(async () => (await toNear.call("net.list")).members.length === 2, "both Macs list both");
    const parent = await createThread(toNear);
    await runTurn(toNear, parent, "hello");
    // On F, a thread from N's at rest, and one from it at work there.
    const middle = ((await toNear.call("thread.start", { machine: "mac-f", profile: "fake", from: parent, text: "hello" })).thread.id as string).replace(/^mac-f\//, "");
    await eventually(async () => (await entry(toFar, middle)) === undefined, "the middle thread rests");
    // Its crew at work for minutes: only the removal can let N's thread rest within the test.
    const below = (await toFar.call("thread.start", { profile: "fake", from: middle, text: "crew long" })).thread.id as string;
    await eventually(async () => (await entry(toFar, below))?.turn === false, "the thread below works on, its turn over");
    await eventually(async () => (await entry(toNear, parent))?.inherited === true, "N lists its thread as running");
    // The middle thread taken off F's list: nothing on F is N's thread's any more.
    await toFar.call("thread.delete", { thread: middle });
    await eventually(async () => (await entry(toNear, parent)) === undefined, "N's thread rests");
  } finally {
    await Promise.all([toNear.close(), toFar.close()]);
    await Promise.all([near.dispose(), far.dispose()]);
  }
});

// Telling, by itself.

test("a set that empties while the call telling it is on its way is told empty once that call is answered", async () => {
  const told: string[][] = [];
  let answer: () => void = () => {};
  let working = [{ session_id: "c1" }];
  const starters = new TellStarters({
    activity: () => working,
    startedFrom: () => ({ machine: "mac-a-id", thread: "p" }),
    tell: (_machine, threads) => {
      told.push(threads);
      return new Promise<Told>((resolve) => {
        answer = () => resolve("told");
      });
    },
    every: 60_000,
  });
  try {
    starters.update();
    await sleep(20);
    assert.deepEqual(told, [["p"]]);
    // The child rests before the first answer comes.
    working = [];
    starters.update();
    await sleep(20);
    assert.deepEqual(told, [["p"]]);
    answer();
    await sleep(40);
    assert.deepEqual(told, [["p"], []]);
    answer();
  } finally {
    starters.close();
  }
});

test("each Mac is told when its set changes, again while it is not empty, and once when it empties", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const told: [string, string[]][] = [];
  let working = [{ session_id: "c1" }, { session_id: "c2" }, { session_id: "local" }];
  const starters = new TellStarters({
    activity: () => working,
    startedFrom: (id) => (id === "local" ? undefined : { machine: "mac-a-id", thread: `p-${id}` }),
    tell: async (machine, threads) => {
      told.push([machine, threads]);
      return "told";
    },
    every: 60,
  });
  try {
    starters.update();
    t.mock.timers.tick(0);
    await Promise.resolve();
    assert.deepEqual(told, [["mac-a-id", ["p-c1", "p-c2"]]]);
    // The same set: not again until it is renewed.
    starters.update();
    t.mock.timers.tick(0);
    t.mock.timers.tick(59);
    assert.equal(told.length, 1);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(told.length, 2);
    assert.deepEqual(told.at(-1), ["mac-a-id", ["p-c1", "p-c2"]]);
    // Emptied: once, and nothing after.
    working = [{ session_id: "local" }];
    starters.update();
    t.mock.timers.tick(0);
    await Promise.resolve();
    const count = told.length;
    assert.deepEqual(told.at(-1), ["mac-a-id", []]);
    t.mock.timers.tick(180);
    assert.equal(told.length, count);
  } finally {
    starters.close();
  }
});

test("a Mac from before is not asked again soon, and one not reached is asked again", async () => {
  const asked: string[] = [];
  let answer: Told | "fail" = "older";
  const starters = new TellStarters({
    activity: () => [{ session_id: "c1" }],
    startedFrom: () => ({ machine: "old", thread: "p" }),
    tell: async (machine) => {
      asked.push(machine);
      if (answer === "fail") throw new Error("Could not reach old.");
      return answer;
    },
    every: 40,
  });
  try {
    starters.update();
    await sleep(150);
    assert.equal(asked.length, 1);
    starters.close();
    // Not reached: asked again at each renewal.
    asked.length = 0;
    answer = "fail";
    const again = new TellStarters({
      activity: () => [{ session_id: "c1" }],
      startedFrom: () => ({ machine: "away", thread: "p" }),
      tell: async (machine) => {
        asked.push(machine);
        throw new Error(`Could not reach ${machine}.`);
      },
      every: 40,
    });
    try {
      again.update();
      await sleep(150);
      assert.ok(asked.length >= 3, `asked ${asked.length} times`);
    } finally {
      again.close();
    }
  } finally {
    starters.close();
  }
});
