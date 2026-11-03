import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { pathsFor } from "../src/config.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { Provider } from "../src/providers/types.ts";
import { createThread, runTurn, startTestBridge, temporaryHome, TestClient, type Frame, type RpcFailure } from "./helpers.ts";

// Feature recent_threads: the threads under Recent in the sidebar, kept per thread on the
// thread's own host, as a pin is, so that every portal shows the same ones. Two clients
// stand for two portals: one marks, the other asks what changed since the revision it
// holds, as the app does at each poll.

const invalid = (error: RpcFailure) => error.code === -32602;

async function portals(t: TestContext) {
  const data = temporaryHome();
  const bridge = await startTestBridge({ providers: new Map<string, Provider>([["fake", new FakeProvider({ directory: data, delayMs: 3 })]]) });
  const a = await TestClient.open(bridge);
  const b = await TestClient.open(bridge);
  t.after(async () => {
    await Promise.all([a.close(), b.close()]);
    await bridge.dispose();
    rmSync(data, { recursive: true, force: true });
  });
  return { bridge, a, b };
}

const row = (answer: Frame, thread: string) => answer.threads.find((entry: Frame) => entry.id === thread);

test("gateway.ready lists recent_threads", async (t) => {
  const { a } = await portals(t);
  assert.ok(a.readyPayload.bridge.features.includes("recent_threads"));
});

test("a thread put in Recent on one portal is listed so on the other through threads.changes, and leaves it the same way, kept on disk", async (t) => {
  const { bridge, a, b } = await portals(t);
  const thread = await createThread(a);
  await runTurn(a, thread, "first");
  const first = await b.call("threads.changes");
  const before = row(first, thread);
  assert.equal(before.recent, undefined);

  // Set: the answer and the other portal's next look both say so, and only this thread moved.
  const marked = await a.call("thread.mark", { thread, recent: true });
  assert.equal(marked.thread.recent, true);
  assert.equal(marked.thread.revision, first.list.revision + 1);
  const delta = await b.call("threads.changes", { list: first.list.id, since: first.list.revision });
  assert.deepEqual(delta.threads.map((entry: Frame) => [entry.id, entry.recent]), [[thread, true]]);
  // Its place in every list stays: this is not something happening in the thread.
  assert.equal(delta.threads[0].updated, before.updated);
  const onDisk = () => JSON.parse(readFileSync(pathsFor(bridge.home).threads, "utf8")).threads.find((record: Frame) => record.id === thread);
  assert.equal(onDisk().recent, true);

  // Set again: nothing moves, so two portals carrying the same thread up costs nothing.
  const again = await b.call("thread.mark", { thread, recent: true });
  assert.equal(again.thread.revision, marked.thread.revision);
  assert.deepEqual((await b.call("threads.changes", { list: delta.list.id, since: delta.list.revision })).threads, []);

  // Cleared, on the other portal: gone from the listing and from the file.
  const cleared = await b.call("thread.mark", { thread, recent: false });
  assert.equal(cleared.thread.recent, undefined);
  const after = await a.call("threads.changes", { list: delta.list.id, since: delta.list.revision });
  assert.deepEqual(after.threads.map((entry: Frame) => [entry.id, entry.recent]), [[thread, undefined]]);
  assert.equal(onDisk().recent, undefined);
  // Cleared again: nothing moves, so two portals letting the same thread go cost nothing.
  const twice = await a.call("thread.mark", { thread, recent: false });
  assert.equal(twice.thread.revision, cleared.thread.revision);
});

test("a mark stays through a turn and a seen, and two portals marking at once end on the last word", async (t) => {
  const { a, b } = await portals(t);
  const thread = await createThread(a);
  await a.call("thread.mark", { thread, recent: true });
  await runTurn(a, thread, "something new");
  const listed = await a.call("threads.changes");
  assert.equal(row(listed, thread).recent, true);
  assert.equal(row(listed, thread).unseen, true);
  const seen = await a.call("thread.mark", { thread, unseen: false, revision: row(listed, thread).revision, list: listed.list.id });
  assert.equal(seen.thread.recent, true);
  assert.equal(seen.thread.unseen, undefined);

  for (const [first, second] of [[a, b], [b, a]] as const) {
    const answers = await Promise.all([first.call("thread.mark", { thread, recent: false }), second.call("thread.mark", { thread, recent: true })]);
    const last = answers[0].thread.revision > answers[1].thread.revision ? answers[0] : answers[1];
    assert.equal(row(await a.call("threads.changes"), thread).recent, last.thread.recent);
  }
});

test("archiving takes a thread out of Recent, and a second portal sees it leave; a turn in it does not put it back, only marking does", async (t) => {
  const { a, b } = await portals(t);
  const thread = await createThread(a);
  await runTurn(a, thread, "first");
  await a.call("thread.mark", { thread, recent: true, pinned: true });
  const first = await b.call("threads.changes");
  assert.equal(row(first, thread).recent, true);

  // On one portal; the other's next look has it gone, unpinned, archived.
  const archived = await a.call("thread.mark", { thread, archived: true });
  assert.equal(archived.thread.recent, undefined);
  assert.equal(archived.thread.pinned, undefined);
  const delta = await b.call("threads.changes", { list: first.list.id, since: first.list.revision });
  assert.deepEqual(delta.threads.map((entry: Frame) => [entry.id, entry.archived, entry.recent]), [[thread, true, undefined]]);

  // Taken back out of the archive: not back under Recent.
  const unarchived = await b.call("thread.mark", { thread, archived: false });
  assert.deepEqual([unarchived.thread.archived, unarchived.thread.recent], [undefined, undefined]);

  // Something new brings it out of the archive: unread, which every portal shows by itself, and not marked.
  await a.call("thread.mark", { thread, archived: true });
  await runTurn(a, thread, "something new");
  const after = row(await b.call("threads.changes"), thread);
  assert.deepEqual([after.archived, after.unseen, after.recent], [undefined, true, undefined]);

  // An archive and a mark made after it, sent as one change by a portal that was away: marked, as a pin is.
  const together = await a.call("thread.mark", { thread, archived: true, recent: true });
  assert.deepEqual([together.thread.archived, together.thread.recent], [true, true]);
  // A pin or a seen says nothing of it.
  const pinned = await b.call("thread.mark", { thread, pinned: true });
  assert.equal(pinned.thread.recent, true);
});

test("a thread from before the feature has no mark, and a file saved so reads as ever", async (t) => {
  const data = temporaryHome();
  const providers = () => new Map<string, Provider>([["fake", new FakeProvider({ directory: data, delayMs: 3 })]]);
  const first = await startTestBridge({ keepHome: true, providers: providers() });
  const home = first.home;
  const client = await TestClient.open(first);
  const thread = await createThread(client);
  await client.call("thread.mark", { thread, pinned: true });
  await client.close();
  await first.dispose();
  // As an older bridge wrote it: no thread has the key.
  const file = JSON.parse(readFileSync(pathsFor(home).threads, "utf8"));
  assert.ok(file.threads.every((record: Frame) => !("recent" in record)));
  writeFileSync(pathsFor(home).threads, JSON.stringify(file));

  const again = await startTestBridge({ home, keepHome: true, providers: providers() });
  const other = await TestClient.open(again);
  t.after(async () => {
    await other.close();
    await again.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });
  const old = row(await other.call("threads.changes"), thread);
  assert.equal(old.recent, undefined);
  assert.equal(old.pinned, true);
  assert.equal((await other.call("thread.mark", { thread, recent: true })).thread.recent, true);
  // It survives a restart of the bridge like any other mark.
  assert.equal(JSON.parse(readFileSync(pathsFor(home).threads, "utf8")).threads.find((record: Frame) => record.id === thread).recent, true);
});

test("the fleet's own listing says nothing of the mark, and a client that never sends it sees only that a row has one more key", async (t) => {
  const { a, b } = await portals(t);
  const thread = await createThread(a);
  await a.call("thread.mark", { thread, recent: true });
  const fleet = (await b.call("threads.list", { local: true })).threads.find((entry: Frame) => entry.id === thread);
  assert.equal(fleet.recent, undefined);
  // A pin made by a client that knows nothing of recent leaves the mark as it is.
  assert.equal((await b.call("thread.mark", { thread, pinned: true })).thread.recent, true);
});

test("thread.mark checks the mark, and says what to mark", async (t) => {
  const { a } = await portals(t);
  const thread = await createThread(a);
  await assert.rejects(a.call("thread.mark", { thread, recent: "yes" }), invalid);
  await assert.rejects(a.call("thread.mark", { thread }), (error: RpcFailure) => invalid(error) && /recent/.test(error.message));
  await assert.rejects(a.call("thread.mark", { thread: "no-such-thread", recent: true }), (error: RpcFailure) => error.code === 4007);
});
