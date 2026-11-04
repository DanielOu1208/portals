import "./environment.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CodexProvider } from "../src/providers/codex/provider.ts";
import { socketConnector } from "../src/providers/codex/client.ts";
import type { CodexSession } from "../src/providers/codex/session.ts";
import type { SessionOptions, SessionSink } from "../src/providers/types.ts";
import { FakeDaemon } from "./codex-daemon.ts";
import { isEvent, startTestBridge, TestClient } from "./helpers.ts";

class IdleProvider extends CodexProvider {
  readonly opened = new Map<string, CodexSession>();
  override async startSession(options: SessionOptions, sink: SessionSink) {
    const session = await super.startSession(options, sink) as CodexSession;
    this.opened.set(options.id, session);
    return session;
  }
  override async resumeSession(options: SessionOptions, sink: SessionSink) {
    const session = await super.resumeSession(options, sink) as CodexSession;
    this.opened.set(options.id, session);
    return session;
  }
}

async function until(check: () => boolean, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t: TestContext, idleMs = 600_000, idleCheckMs = 30) {
  const daemon = await FakeDaemon.start();
  daemon.pagedHistory = true;
  daemon.subscriptionEventsOnly = true;
  const cwd = join(daemon.folder, "work");
  mkdirSync(cwd);
  const makeProvider = () => new IdleProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: join(daemon.folder, "images") },
    connect: socketConnector(daemon.socketPath), checkVersion: false, configPath: join(daemon.folder, "config.toml"), backoff: [0.01], idleMs, idleCheckMs,
  });
  const provider = makeProvider();
  const bridge = await startTestBridge({ keepHome: true, providers: new Map([["codex", provider]]), config: { generalFolder: cwd } });
  const client = await TestClient.open(bridge);
  t.after(async () => { await client.close(); await bridge.dispose(); await daemon.close(); });
  const create = async () => (await client.call("session.create", { profile: "codex", cwd, title: "Idle test" })).session_id as string;
  const work = async (id: string, text = "Work.") => {
    await client.call("prompt.submit", { session_id: id, text });
    return daemon.activeTurn(id);
  };
  const finish = async (id: string, turn: string, text = "Finished.") => {
    const from = client.frames.length;
    daemon.finishTurn(id, turn, text);
    await client.from(from, (frame) => isEvent(frame, "message.complete", id));
  };
  const leave = async (id: string) => { await client.call("session.leave", { session_id: id }); };
  const cool = async (id: string) => { await provider.opened.get(id)!.cool(); };
  return { daemon, provider, bridge, client, create, work, finish, leave, cool, makeProvider };
}

function deskTurn(daemon: FakeDaemon, id: string, turn: string, text: string) {
  daemon.thread(id).loaded = true;
  daemon.thread(id).updatedAt = Math.floor(Date.now() / 1000) + 1;
  daemon.broadcast("turn/started", { threadId: id, turn: { id: turn, status: "inProgress", items: [], startedAt: 1 } });
  daemon.broadcast("item/completed", { threadId: id, turnId: turn, item: { type: "userMessage", id: `u-${turn}`, content: [{ type: "text", text, text_elements: [] }] } });
}

test("any remaining device, a running turn, and an empty thread prevent release", async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  await f.leave(id);
  await f.cool(id);
  assert.equal(f.daemon.callsOf("thread/unsubscribe").length, 0, "empty threads must stay loaded");
  await f.client.call("session.resume", { session_id: id });
  const turn = await f.work(id);
  await f.leave(id);
  await f.cool(id);
  assert.equal(f.daemon.callsOf("thread/unsubscribe").length, 0, "a running turn stays followed");
  f.daemon.finishTurn(id, turn);
  await until(() => !f.provider.opened.get(id)!.busy);
  await f.client.call("session.resume", { session_id: id });
  const other = await TestClient.open(f.bridge);
  t.after(() => other.close());
  await other.call("session.resume", { session_id: id });
  await f.leave(id);
  await f.leave(id);
  await f.cool(id);
  assert.equal(f.daemon.callsOf("thread/unsubscribe").length, 0, "another device still retains the thread");
  await other.close();
  await until(() => !f.provider.opened.get(id)!.busy);
  await f.cool(id);
  assert.equal(f.provider.opened.get(id)!.isReleased, true);
  assert.equal(f.daemon.callsOf("thread/unsubscribe").length, 1);
});

test("the idle sweep releases after the last device leaves, and ignores an ordinary unload", async (t) => {
  const f = await fixture(t, 40);
  const id = await f.create();
  await f.finish(id, await f.work(id));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(f.daemon.callsOf("thread/unsubscribe").length, 0);
  await f.leave(id);
  await until(() => f.provider.opened.get(id)!.isReleased);
  const resumes = f.daemon.callsOf("thread/resume").length;
  f.daemon.thread(id).loaded = false;
  f.daemon.thread(id).status = { type: "notLoaded" };
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(f.daemon.callsOf("thread/resume").length, resumes, "unloading is not new work");
});

test("an open card and a running sub-agent keep their parent followed", async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  const turn = await f.work(id);
  await f.finish(id, turn);
  const answer = f.daemon.request(id, "item/commandExecution/requestApproval", { threadId: id, turnId: turn, itemId: "cmd", command: "ls", cwd: f.daemon.thread(id).cwd, availableDecisions: ["accept", "decline"] });
  const card = await f.client.nextRequest();
  await f.leave(id);
  await f.cool(id);
  assert.equal(f.provider.opened.get(id)!.isReleased, false);
  f.daemon.answerFromTerminal(f.daemon.openRequests()[0].id, { decision: "accept" });
  await answer;
  const child = f.daemon.addThread(f.daemon.thread(id).cwd, [{ id: "child-turn", status: "inProgress", items: [] }], { loaded: true, status: { type: "active", activeFlags: [] }, parentThreadId: id });
  f.daemon.broadcast("item/completed", { threadId: id, turnId: turn, item: { type: "subAgentActivity", id: "spawn", kind: "started", agentThreadId: child, agentPath: "/root/worker" } });
  await until(() => f.provider.opened.get(id)!.busy);
  await f.cool(id);
  assert.equal(f.provider.opened.get(id)!.isReleased, false);
  f.daemon.finishTurn(child, "child-turn");
  await until(() => !f.provider.opened.get(id)!.busy);
  await f.cool(id);
  assert.equal(f.provider.opened.get(id)!.isReleased, true);
});

test("external work is recovered through paged history and reopening has no gap", async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  await f.finish(id, await f.work(id));
  await f.leave(id);
  await f.cool(id);
  const from = f.daemon.calls.length;
  deskTurn(f.daemon, id, "desk", "From Codex.");
  f.daemon.finishTurn(id, "desk", "Desk reply.");
  await until(() => !f.provider.opened.get(id)!.isReleased);
  const resumed = await f.client.call("session.resume", { session_id: id });
  assert.deepEqual(resumed.messages.filter((message: any) => message.role === "assistant").map((message: any) => message.text), ["Finished.", "Desk reply."]);
  assert.ok(f.daemon.calls.slice(from).some((call) => call.method === "thread/turns/list"));
  assert.ok(f.daemon.calls.slice(from).some((call) => call.method === "thread/list" && call.params.cursor === null && call.params.sortDirection === "desc"));
  assert.equal(f.daemon.calls.slice(from).some((call) => call.method === "thread/list" && call.params.cursor !== null), false);
});

test("a device opening while unsubscribe is in flight waits for catch-up before its snapshot", async (t) => {
  const f = await fixture(t, 600_000, 60_000);
  const id = await f.create();
  await f.finish(id, await f.work(id));
  await f.leave(id);
  let release!: () => void;
  f.daemon.onUnsubscribe = () => new Promise<void>((resolve) => { release = resolve; });
  const cooling = f.cool(id);
  await until(() => release !== undefined);
  const opening = f.client.call("session.resume", { session_id: id });
  deskTurn(f.daemon, id, "desk", "While away.");
  f.daemon.finishTurn(id, "desk", "Caught up.");
  release();
  await cooling;
  const result = await opening;
  assert.equal(result.messages.at(-1).text, "Caught up.");
  assert.equal(f.provider.opened.get(id)!.isReleased, false);
});

test("a released thread stays released after reconnect, then catches up when opened", async (t) => {
  const f = await fixture(t, 600_000, 60_000);
  const id = await f.create();
  await f.finish(id, await f.work(id));
  await f.leave(id);
  await f.cool(id);
  const resumes = f.daemon.callsOf("thread/resume").length;
  f.daemon.dropAll();
  await until(() => f.daemon.connections.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(f.daemon.callsOf("thread/resume").length, resumes);
  deskTurn(f.daemon, id, "desk", "After reconnect.");
  f.daemon.finishTurn(id, "desk", "Recovered.");
  const result = await f.client.call("session.resume", { session_id: id });
  assert.equal(result.messages.at(-1).text, "Recovered.");
});

test("after a host restart, external activity wakes a registered thread that was unloaded", async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  await f.finish(id, await f.work(id));
  await f.client.close();
  await f.bridge.close();
  f.daemon.thread(id).loaded = false;
  f.daemon.thread(id).status = { type: "notLoaded" };
  const nextProvider = f.makeProvider();
  const next = await startTestBridge({ home: f.bridge.home, providers: new Map([["codex", nextProvider]]) });
  const client = await TestClient.open(next);
  t.after(async () => { await client.close(); await next.dispose(); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(nextProvider.opened.has(id), false, "unchanged indexed history stays unloaded after restart");
  deskTurn(f.daemon, id, "desk", "After host restart.");
  await until(() => nextProvider.opened.has(id));
  const activity = await client.call("sessions.activity");
  assert.ok(activity.sessions.some((session: any) => session.session_id === id));
  f.daemon.finishTurn(id, "desk", "Restart reply.");
  const result = await client.call("session.resume", { session_id: id });
  assert.equal(result.messages.at(-1).text, "Restart reply.");
});

test("an unobserved warm thread unloaded at reconnect becomes cold and reopens with missed history", async (t) => {
  const f = await fixture(t, 600_000, 60_000);
  const id = await f.create();
  await f.finish(id, await f.work(id));
  await f.leave(id);
  f.daemon.thread(id).loaded = false;
  f.daemon.thread(id).status = { type: "notLoaded" };
  f.daemon.dropAll();
  await until(() => f.provider.opened.get(id)!.isReleased);
  deskTurn(f.daemon, id, "desk", "While the daemon restarted.");
  f.daemon.finishTurn(id, "desk", "Restored.");
  const snapshot = await f.client.call("session.resume", { session_id: id });
  assert.equal(snapshot.messages.at(-1).text, "Restored.");
});

test("native background terminals missing from history prevent release after cold catch-up", async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  await f.finish(id, await f.work(id));
  await f.leave(id);
  await f.cool(id);
  deskTurn(f.daemon, id, "desk", "Start background work.");
  f.daemon.backgroundTerminals = [{ itemId: "background", processId: "process", command: "sleep 30", cwd: f.daemon.thread(id).cwd }];
  f.daemon.finishTurn(id, "desk", "Started.");
  await until(() => !f.provider.opened.get(id)!.isReleased);
  await f.cool(id);
  assert.equal(f.provider.opened.get(id)!.isReleased, false);
  await f.client.close();
  await f.bridge.close();
  const provider = f.makeProvider();
  const restarted = await startTestBridge({ home: f.bridge.home, providers: new Map([["codex", provider]]) });
  t.after(() => restarted.dispose());
  await until(() => provider.opened.has(id));
  await provider.opened.get(id)!.cool();
  assert.equal(provider.opened.get(id)!.isReleased, false, "background work absent from history also protects a restarted host");
  f.daemon.backgroundTerminals = [];
  await provider.opened.get(id)!.cool();
  assert.equal(provider.opened.get(id)!.isReleased, true);
});

test("one unreadable cold thread does not block discovery of another, and is retried", async (t) => {
  const f = await fixture(t);
  const bad = await f.create(), good = await f.create();
  for (const id of [bad, good]) {
    await f.finish(id, await f.work(id));
    await f.leave(id);
    await f.cool(id);
  }
  f.daemon.onRead = (params) => { if (params.threadId === bad) throw new Error("history is unavailable"); };
  for (const id of [bad, good]) {
    deskTurn(f.daemon, id, `desk-${id}`, "From Codex.");
    f.daemon.finishTurn(id, `desk-${id}`, "Found.");
  }
  await until(() => !f.provider.opened.get(good)!.isReleased);
  const snapshot = await f.client.call("session.resume", { session_id: good });
  assert.equal(snapshot.messages.at(-1).text, "Found.");
  await until(() => f.daemon.callsOf("thread/read").filter((call) => call.params.threadId === bad).length > 4);
  await assert.rejects(f.provider.opened.get(bad)!.prepareOpen(), /history is unavailable/);
  assert.equal(f.provider.opened.get(bad)!.isReleased, true);
});

test("opening during reconnect rechecks whether recovery left the thread cold", async (t) => {
  const f = await fixture(t, 600_000, 60_000);
  const id = await f.create();
  await f.finish(id, await f.work(id));
  await f.leave(id);
  f.daemon.accepting = false;
  f.daemon.dropAll();
  await until(() => !f.provider.client.isConnected);
  const opening = f.client.call("session.resume", { session_id: id });
  deskTurn(f.daemon, id, "desk", "Missed before restart.");
  f.daemon.finishTurn(id, "desk", "Recovered before opening.");
  f.daemon.thread(id).loaded = false;
  f.daemon.thread(id).status = { type: "notLoaded" };
  f.daemon.accepting = true;
  const result = await opening;
  assert.equal(result.messages.at(-1).text, "Recovered before opening.");
  assert.equal(f.provider.opened.get(id)!.isReleased, false);
});

test("a server that cannot report background work keeps its subscription", async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  await f.finish(id, await f.work(id));
  await f.leave(id);
  const call = f.provider.client.call.bind(f.provider.client);
  f.provider.client.call = async (method, params, timeout) => {
    if (method === "thread/backgroundTerminals/list") throw new Error("Method not supported");
    return call(method, params, timeout);
  };
  await f.cool(id);
  assert.equal(f.provider.opened.get(id)!.isReleased, false);
  assert.equal(f.daemon.callsOf("thread/unsubscribe").length, 0);
});
