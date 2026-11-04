import "./environment.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { socketConnector } from "../src/providers/codex/client.ts";
import { CodexProvider } from "../src/providers/codex/provider.ts";
import { FakeDaemon } from "./codex-daemon.ts";
import { fixtureCwd, recordedHistory, rewrite } from "./codex-fixtures.ts";
import { isEvent, startTestBridge, TestClient } from "./helpers.ts";

async function fixture(t: TestContext, turns: any[], active = false, configure?: (daemon: FakeDaemon, id: string) => void) {
  const daemon = await FakeDaemon.start();
  daemon.pagedHistory = true;
  const cwd = join(daemon.folder, "work");
  mkdirSync(cwd);
  const id = daemon.addThread(cwd, rewrite(turns, [[fixtureCwd, cwd]]), { loaded: active, status: active ? { type: "active", activeFlags: [] } : { type: "notLoaded" } });
  configure?.(daemon, id);
  const seeded = await startTestBridge({ keepHome: true, providers: new Map(), config: { generalFolder: cwd } });
  await seeded.close();
  writeFileSync(join(seeded.home, "state", "threads.json"), JSON.stringify({ threads: [{ id, agent: "codex", cwd, title: "History", model: "gpt-6-luna", provider: "openai", reasoningEffort: "low", createdAt: 1, updatedAt: 1, origin: "phone" }] }));
  const provider = new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: join(daemon.folder, "images") },
    connect: socketConnector(daemon.socketPath), checkVersion: false, configPath: join(daemon.folder, "config.toml"), timeZone: "UTC", backoff: [0.01],
  });
  const bridge = await startTestBridge({ home: seeded.home, providers: new Map([["codex", provider]]) });
  const client = await TestClient.open(bridge);
  t.after(async () => { await client.close(); await bridge.dispose(); await daemon.close(); });
  return { daemon, client, id, cwd };
}

function turn(id: string, text = id) {
  return { id, status: "completed", itemsView: "full", startedAt: 1, completedAt: 2, durationMs: 1000, error: null, items: [
    { type: "userMessage", id: `u-${id}`, content: [{ type: "text", text, text_elements: [] }] },
    { type: "agentMessage", id: `a-${id}`, text: `Reply to ${text}` },
  ] };
}

function assertPaged(daemon: FakeDaemon) {
  assert.ok(daemon.callsOf("thread/turns/list").length > 0);
  assert.equal(daemon.callsOf("thread/read").some((call) => call.params.includeTurns === true), false);
  assert.equal(daemon.callsOf("thread/resume").some((call) => call.params.excludeTurns !== true), false);
}

test("opening paged history retains full tool rows across pages without loading an idle thread", async (t) => {
  const turns = [turn("old"), ...recordedHistory("tools").turns, turn("new")];
  const { daemon, client, id } = await fixture(t, turns);
  const result = await client.call("session.resume", { session_id: id, profile: "codex", inline_images: false });
  assert.equal(result.running, false);
  assert.deepEqual(result.messages.filter((message: any) => message.role === "user").map((message: any) => message.text), ["old", turns[1].items[0].content[0].text, "new"]);
  const patch = result.messages.find((message: any) => message.role === "tool" && message.name === "patch");
  assert.match(JSON.parse(patch.content).diff, /-hi\n\+hello/);
  assert.equal(daemon.callsOf("thread/resume").length, 0);
  assert.equal(daemon.callsOf("thread/turns/list").length, 2);
  assertPaged(daemon);
});

test("a reconnect pages through missed turns once and reads a sub-agent's own paged history", async (t) => {
  const { daemon, client, id, cwd } = await fixture(t, [turn("old-1"), turn("old-2"), turn("known")]);
  await client.call("session.resume", { session_id: id, profile: "codex" });
  await client.call("prompt.submit", { session_id: id, text: "Work." });
  const running = await daemon.activeTurn(id);
  const start = client.frames.length;
  daemon.accepting = false;
  daemon.dropAll();
  daemon.finishTurn(id, running, "Finished while away.");
  const missed = turn("missed", "A desk message.");
  daemon.thread(id).turns.push(missed);
  const child = daemon.addThread(cwd, [turn("c1"), turn("c2"), turn("c3")], { loaded: true, parentThreadId: id, status: { type: "idle" } });
  missed.items.push({ type: "subAgentActivity", id: "spawn", kind: "started", agentThreadId: child, agentPath: "/root/worker" } as never);
  const from = daemon.calls.length;
  daemon.accepting = true;
  const done = await client.from(start, (frame) => isEvent(frame, "message.complete", id) && frame.params.payload.text === "Reply to A desk message.");
  assert.equal(done.params.payload.status, "complete");
  await daemon.waitForCall((call) => call.method === "thread/turns/list" && call.params.threadId === child && call.params.cursor !== null, from);
  const settled = await client.from(start, (frame) => isEvent(frame, "subagent.complete", id) && frame.params.payload.subagent_id === child);
  assert.equal(settled.params.payload.result, "Reply to c3");
  const reads = daemon.calls.slice(from).filter((call) => call.method === "thread/turns/list" && call.params.threadId === id);
  assert.ok(reads.length > 0);
  assert.ok(reads.every((call) => call.params.cursor === null), "catch-up stops before the known older history");
  assert.equal(client.frames.slice(start).filter((frame) => isEvent(frame, "message.complete", id) && frame.params.payload.text === "Reply to A desk message.").length, 1);
  assertPaged(daemon);
});

test("a paged resume recovers a missing pending approval diff with a live read", async (t) => {
  const running = { ...turn("running", "Build it."), status: "inProgress", completedAt: null, durationMs: null };
  running.items = running.items.slice(0, 1);
  const { daemon, client, id, cwd } = await fixture(t, [turn("older"), running], true);
  await client.call("session.resume", { session_id: id, profile: "codex" });
  const change = { type: "fileChange", id: "change", changes: [{ path: join(cwd, "built.txt"), kind: { type: "add" }, diff: "built\n" }], status: "inProgress" };
  // Miss the item's start; paging only has persisted items, so the request needs a live read.
  daemon.thread(id).turns.at(-1).started = [change];
  const from = daemon.calls.length;
  const start = client.frames.length;
  const answer = daemon.request(id, "item/fileChange/requestApproval", { threadId: id, turnId: "running", itemId: "change", reason: null, grantRoot: null });
  const card = await client.nextRequest();
  assert.match(card.params.command, /\+built/);
  const resumes = daemon.calls.slice(from).filter((call) => call.method === "thread/resume");
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].params.excludeTurns, undefined);
  client.answer(card.id, { choice: "once" });
  assert.deepEqual((await answer).result, { decision: "accept" });
  daemon.finishTurn(id, "running", "Built.");
  await client.from(start, (frame) => isEvent(frame, "message.complete", id));
  assert.equal(daemon.callsOf("thread/read").some((call) => call.params.includeTurns === true), false);
});

for (const during of ["metadata", "older pages"]) {
  test(`a running turn finishing during ${during} of a paged load keeps its final reply exactly once`, async (t) => {
    const running = { ...turn("running", "Work."), status: "inProgress", completedAt: null, durationMs: null };
    running.items = running.items.slice(0, 1);
    const { daemon, client, id } = await fixture(t, [turn("old-1"), turn("old-2"), running], true, (daemon, id) => {
      let summaries = 0;
      let finished = false;
      const finish = () => { finished = true; daemon.finishTurn(id, "running", "Finished during load."); };
      daemon.onRead = (params) => {
        if (params.threadId !== id || params.includeTurns !== false) return;
        summaries += 1;
        if (during === "metadata" && summaries === 2) finish();
      };
      daemon.onTurnsRead = (params) => {
        if (!finished && during === "older pages" && params.threadId === id && params.cursor !== null && summaries === 2) finish();
      };
    });
    const result = await client.call("session.resume", { session_id: id, profile: "codex" });
    assert.equal(result.running, false);
    assert.equal(result.messages.filter((message: any) => message.text === "Finished during load.").length, 1);
    assert.equal(result.messages.some((message: any) => message.display_metadata?.interrupted), false);
    assertPaged(daemon);
  });
}
