import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Provider, SessionOptions, SessionSink, StoredMessage } from "../src/providers/types.ts";
import { createThread, startTestBridge, TestClient } from "./helpers.ts";

async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "portals-file-undo-gateway-")));
  const child = join(root, "child");
  mkdirSync(child);
  const file = join(child, "note.txt");
  writeFileSync(file, "after\n");
  let restoring: Promise<void> | undefined;
  let reached!: () => void;
  const restoringStarted = new Promise<void>((resolve) => { reached = resolve; });
  let actualCalls = 0;
  const started = new Map<string, string[]>();
  const sinks = new Map<string, SessionSink>();
  const provider: Provider = {
    profile: { name: "fake", kind: "fake", displayName: "Test agent", description: "", model: "test", provider: "test" },
    models: async () => ({ providers: [{ slug: "test", name: "Test", models: ["test"] }], model: "test", provider: "test", reasoning: "low" }),
    startSession: async (options, sink) => session(options, sink), resumeSession: async (options, sink) => session(options, sink),
  };
  function session(options: SessionOptions, sink: SessionSink) {
    sinks.set(options.id, sink);
    let restored = false;
    const messages: StoredMessage[] = [
      { role: "user", text: "Change note", timestamp: 1, checkpoint: { id: "native-user", can_edit: true, can_fork: true, can_undo_files: true } },
      { role: "assistant", text: "Done", timestamp: 2 },
    ];
    return {
      history: async () => structuredClone(messages), settings: () => options.settings,
      startTurn: (prompt: { text: string }) => { started.set(options.id, [...started.get(options.id) ?? [], prompt.text]); }, interrupt: async () => false,
      setModel: async () => ({ deferred: false }), setReasoning: async () => {}, close: async () => {},
      async rewindFiles(_id: string, dryRun: boolean) {
        if (dryRun) return { canRewind: true, filesChanged: restored ? [] : [file], insertions: 1, deletions: 1 };
        reached();
        await restoring;
        actualCalls += 1;
        writeFileSync(file, "before\n");
        restored = true;
        return { canRewind: true, skippedLinks: 0 };
      },
    };
  }
  const bridge = await startTestBridge({ providers: new Map([["fake", provider]]), config: { generalFolder: child }, temporaryFolders: [] });
  const client = await TestClient.open(bridge, { capabilities: { session_resync: true } });
  t.after(async () => { await client.close(); await bridge.dispose(); rmSync(root, { recursive: true, force: true }); });
  await client.call("folders.add", { path: root });
  const source = await createThread(client);
  return { root, child, file, bridge, client, source, started, sinks, restoringStarted, actualCalls: () => actualCalls, hold: (wait: Promise<void>) => { restoring = wait; } };
}

test("file undo requires explicit confirmation, original connection and one unexpired preview", async (t) => {
  const run = await setup(t);
  const other = await TestClient.open(run.bridge, { capabilities: { session_resync: true } });
  t.after(() => other.close());
  await other.call("session.resume", { session_id: run.source });
  const before = (await run.client.call("session.resume", { session_id: run.source })).messages;
  const preview = await run.client.call("session.files.preview", { session_id: run.source, checkpoint_id: "native-user" });
  assert.deepEqual(preview.files, [run.file]);
  for (const confirmed of [undefined, false, "true"]) {
    assert.equal((await run.client.request("session.files.undo", { session_id: run.source, preview_id: preview.preview_id, ...(confirmed !== undefined ? { confirmed } : {}) })).error.code, -32602);
  }
  assert.equal((await other.request("session.files.undo", { session_id: run.source, preview_id: preview.preview_id, confirmed: true })).error.code, -32602);
  assert.equal(run.actualCalls(), 0);
  assert.deepEqual(await run.client.call("session.files.undo", { session_id: run.source, preview_id: preview.preview_id, confirmed: true }), { restored: true, skipped_links: 0 });
  assert.equal(readFileSync(run.file, "utf8"), "before\n");
  const after = (await run.client.call("session.resume", { session_id: run.source })).messages;
  assert.equal(after.length, before.length);
  assert.deepEqual(after.map(({ role, text }: any) => ({ role, text })), before.map(({ role, text }: any) => ({ role, text })));
  assert.equal(after[0].checkpoint.can_undo_files, false);
  assert.equal((await run.client.request("session.files.undo", { session_id: run.source, preview_id: preview.preview_id, confirmed: true })).error.code, -32602);
  assert.equal(run.actualCalls(), 1);
});

test("known active threads in an overlapping parent folder prevent file restoration", async (t) => {
  const run = await setup(t);
  const parent = await createThread(run.client, { cwd: run.root });
  await run.client.call("prompt.submit", { session_id: parent, text: "Keep working" });
  const response = await run.client.request("session.files.preview", { session_id: run.source, checkpoint_id: "native-user" });
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /every thread using this folder/);
  assert.equal(run.actualCalls(), 0);
});

test("a legacy follower receives the restore result before reconnecting for invalidation", async (t) => {
  const run = await setup(t);
  const legacy = await TestClient.open(run.bridge);
  t.after(() => legacy.close());
  await legacy.call("session.resume", { session_id: run.source });
  const preview = await legacy.call("session.files.preview", { session_id: run.source, checkpoint_id: "native-user" });
  assert.deepEqual(await legacy.call("session.files.undo", { session_id: run.source, preview_id: preview.preview_id, confirmed: true }), { restored: true, skipped_links: 0 });
  assert.equal(readFileSync(run.file, "utf8"), "before\n");
  assert.equal(run.actualCalls(), 1);
});

test("file restore holds its source and overlapping sibling against new submissions", async (t) => {
  const run = await setup(t);
  const parent = await createThread(run.client, { cwd: run.root });
  const preview = await run.client.call("session.files.preview", { session_id: run.source, checkpoint_id: "native-user" });
  let release!: () => void;
  run.hold(new Promise<void>((resolve) => { release = resolve; }));
  const applying = run.client.call("session.files.undo", { session_id: run.source, preview_id: preview.preview_id, confirmed: true });
  await run.restoringStarted;
  for (const id of [run.source, parent]) assert.ok((await run.client.request("prompt.submit", { session_id: id, text: "Wait" })).error);
  release();
  assert.equal((await applying).restored, true);
  assert.equal(run.actualCalls(), 1);
  assert.equal((await run.client.call("prompt.submit", { session_id: parent, text: "Continue" })).status, "streaming");
});

test("releasing a file preview never starts an unrelated thread's queued turn early", async (t) => {
  const run = await setup(t);
  const otherFolder = join(run.root, "other");
  mkdirSync(otherFolder);
  await run.client.call("folders.add", { path: otherFolder });
  const other = await createThread(run.client, { cwd: otherFolder });
  await run.client.call("prompt.submit", { session_id: other, text: "First" });
  await run.client.call("prompt.submit", { session_id: other, text: "Second", when_busy: "queue" });
  await run.client.call("session.files.preview", { session_id: run.source, checkpoint_id: "native-user" });
  assert.deepEqual(run.started.get(other), ["First"]);
  const snapshot = await run.client.call("session.resume", { session_id: other });
  assert.equal(snapshot.queued.length, 1);
  assert.equal(snapshot.running, true);
});
