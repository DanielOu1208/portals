import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FakeProvider } from "../src/providers/fake.ts";
import type { Provider } from "../src/providers/types.ts";
import { createThread, runTurn, startTestBridge, temporaryHome, TestClient, type Frame } from "./helpers.ts";

// A thread is running, as `sessions.activity` says (what every device's sidebar, marks and
// tabs go by), while what it set to work goes on after its turn: a subagent or a workflow
// of its own, or a thread started from it at work, and that one's in turn (2026-10-27: "when there is a thread, subagent, or workflow working i think the parent
// thread should also be working", "but if there is only a background task i dont think it
// should be labelled as working").

async function setUp(t: TestContext): Promise<TestClient> {
  const data = temporaryHome();
  const bridge = await startTestBridge({ providers: new Map<string, Provider>([["fake", new FakeProvider({ directory: join(data, "fake"), delayMs: 3 })]]) });
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
    rmSync(data, { recursive: true, force: true });
  });
  return client;
}

/**
 * What `sessions.activity` says of each thread at work: its state, and `running+` for one
 * listed only for the threads started from it (`inherited: true`).
 */
async function activity(client: TestClient): Promise<Record<string, string>> {
  const { sessions } = await client.call("sessions.activity");
  return Object.fromEntries(sessions.map((entry: Frame) => [entry.session_id, entry.inherited === true ? `${entry.state}+` : entry.state]));
}

/** What `sessions.activity` lists of `thread`, as it lists it. */
async function entry(client: TestClient, thread: string): Promise<Frame | undefined> {
  const { sessions } = await client.call("sessions.activity");
  return (sessions as Frame[]).find((listed) => listed.session_id === thread);
}

/** `sessions.activity` once `check` holds of it, within a few seconds. */
async function until(client: TestClient, check: (states: Record<string, string>) => boolean): Promise<Record<string, string>> {
  let states: Record<string, string> = {};
  for (let tries = 0; tries < 250; tries += 1) {
    states = await activity(client);
    if (check(states)) return states;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`sessions.activity never came to it: ${JSON.stringify(states)}`);
}

/** A thread at rest after a turn of `text`, which this client follows. */
async function rested(client: TestClient, text = "hello"): Promise<string> {
  const thread = await createThread(client);
  await runTurn(client, thread, text);
  return thread;
}

/** A thread started from `from` through the fleet, as an agent starts one, its first turn `text`. */
async function startedFrom(client: TestClient, from: string, text: string): Promise<string> {
  return (await client.call("thread.start", { profile: "fake", from, text })).thread.id as string;
}

/** Stops the crew's rows of `kind` still at work in `thread`. */
async function stopAll(client: TestClient, thread: string, kind: string): Promise<void> {
  const { subagents } = await client.call("subagent.list", { session_id: thread });
  for (const row of subagents as Frame[]) {
    if (row.kind === kind && row.status === "running") await client.call("subagent.stop", { session_id: thread, subagent_id: row.subagent_id });
  }
}

test("a thread whose turn has ended is running while a subagent it started works on", async (t) => {
  const client = await setUp(t);
  const thread = await rested(client, "crew");
  await stopAll(client, thread, "workflow");
  assert.equal((await activity(client))[thread], "running");
});

test("a thread whose turn has ended is running while a workflow it started works on", async (t) => {
  const client = await setUp(t);
  const thread = await rested(client, "crew");
  await stopAll(client, thread, "agent");
  // The agents stopped, once the bridge has heard: the workflow and the command work on.
  for (let tries = 0; ; tries += 1) {
    const { subagents } = await client.call("subagent.list", { session_id: thread });
    const working = (subagents as Frame[]).filter((row) => row.status === "running").map((row) => row.kind).sort();
    if (working.join() === "command,workflow") break;
    assert.ok(tries < 100, `still at work: ${working.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await activity(client))[thread], "running");
});

test("a thread whose only work left is a command in the background is not running", async (t) => {
  const client = await setUp(t);
  const thread = await rested(client, "bgcommand");
  const { subagents } = await client.call("subagent.list", { session_id: thread });
  assert.deepEqual((subagents as Frame[]).map((row) => [row.kind, row.status]), [["command", "running"]]);
  assert.equal((await activity(client))[thread], undefined);
});

test("a thread is running while a thread started from it is at work, and at rest once that one is", async (t) => {
  const client = await setUp(t);
  const parent = await rested(client);
  assert.equal((await activity(client))[parent], undefined);
  const child = await startedFrom(client, parent, "slow");
  const working = await until(client, (states) => states[child] === "running");
  assert.equal(working[parent], "running+");
  // Its turn over, and nothing else of it at work: the one that started it rests too.
  const done = await until(client, (states) => states[child] === undefined);
  assert.equal(done[parent], undefined);
});

test("a thread is running while a thread started from one it started is at work", async (t) => {
  const client = await setUp(t);
  const parent = await rested(client);
  const child = await startedFrom(client, parent, "hello");
  await until(client, (states) => states[child] === undefined && states[parent] === undefined);
  const grandchild = await startedFrom(client, child, "slow");
  const working = await until(client, (states) => states[grandchild] === "running");
  assert.equal(working[child], "running+");
  assert.equal(working[parent], "running+");
});

test("a thread is running while a thread started from it has subagents at work after its turn", async (t) => {
  const client = await setUp(t);
  const parent = await rested(client);
  const child = await startedFrom(client, parent, "crew");
  // The crew's turn ends at once; its agents and workflow work on.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const states = await until(client, (now) => now[child] === "running");
  assert.equal(states[parent], "running+");
});

test("a thread started from another with only a command left in the background does not keep that one running", async (t) => {
  const client = await setUp(t);
  const parent = await rested(client);
  const child = await startedFrom(client, parent, "bgcommand");
  // Its turn over, its command running on.
  const states = await until(client, (now) => now[child] === undefined);
  assert.equal(states[parent], undefined);
});

test("a thread with work of its own keeps its own state: a thread started from it at work does not make it inherited", async (t) => {
  const client = await setUp(t);
  // Its own subagents at work, and a thread started from it at work too.
  const parent = await rested(client, "crew");
  const child = await startedFrom(client, parent, "slow");
  const states = await until(client, (now) => now[child] === "running");
  assert.equal(states[parent], "running");
  // Waiting for an answer itself, with a thread it started at work: it stays waiting.
  const asking = await startedFrom(client, parent, "approve");
  await until(client, (now) => now[asking] === "waiting");
  const below = await startedFrom(client, asking, "slow");
  const later = await until(client, (now) => now[below] === "running");
  assert.equal(later[asking], "waiting");
});

test("a thread started from another that waits for an answer keeps that one running, not waiting", async (t) => {
  const client = await setUp(t);
  const parent = await rested(client);
  const child = await startedFrom(client, parent, "approve");
  const states = await until(client, (now) => now[child] === "waiting");
  // Needs you is for the thread that asks; the one that started it has work going on.
  assert.equal(states[parent], "running+");
});

// A thread running with no turn of its own says so (`turn: false`), so that a device takes
// no turn's end from it leaving the list: its turn's end was told when it came (2026-10-27, of the unseen dot such a thread took when its subagents ended: "yes fix that").

test("a thread kept running only by its subagents says no turn of its own runs", async (t) => {
  const client = await setUp(t);
  const thread = await rested(client, "crew");
  assert.deepEqual(await entry(client, thread), { session_id: thread, state: "running", turn: false });
});

test("a thread in a turn says nothing of it, and one running for the threads it started says it has none", async (t) => {
  const client = await setUp(t);
  const parent = await rested(client);
  const child = await startedFrom(client, parent, "slow");
  await until(client, (states) => states[child] === "running");
  assert.deepEqual(await entry(client, child), { session_id: child, state: "running" });
  assert.deepEqual(await entry(client, parent), { session_id: parent, state: "running", inherited: true, turn: false });
});
