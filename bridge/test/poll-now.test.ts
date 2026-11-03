import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { pathsFor } from "../src/config.ts";
import { callOnce } from "../src/gateway/call.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import type { GatewayContext } from "../src/gateway/methods.ts";
import { PollNow, pollNowWaitMs, type ConnectionEvent } from "../src/gateway/pollNow.ts";
import { Looks } from "../src/looks.ts";
import { SidebarOrder } from "../src/order.ts";
import type { ProviderSession, SubagentInfo } from "../src/providers/types.ts";
import { Registry, type ThreadRecord } from "../src/sessions/registry.ts";
import { Session } from "../src/sessions/session.ts";
import { createThread, isEvent, mintTicket, socketURL, startTestBridge, TestClient, type Frame, type TestBridge } from "./helpers.ts";

// Telling the devices that ask when something their poll reads moved (feature poll_now):
// one `poll.now` event with no session, a moment after a change is saved, saying where
// the list is; then the device polls. A burst is one event, a change that was not saved
// or that no listing shows sends nothing, and a connection that did not ask (an app from
// before the feature, a link between Macs, the `portals` command) never gets one.

const isPollNow = (frame: Frame) => isEvent(frame, "poll.now");
const told = (client: TestClient) => client.frames.filter(isPollNow);

/** Longer than the wait, and some: a move that was told has been told by then. */
const settled = () => sleep(pollNowWaitMs + 250);

/** The list's id and revision as threads.json has them now. */
function savedList(bridge: TestBridge): { id: string; revision: number } {
  const saved = JSON.parse(readFileSync(pathsFor(bridge.home).threads, "utf8")) as { list: string; revision: number };
  return { id: saved.list, revision: saved.revision };
}

/** Where the net is, as `state/net.json` has it (feature net). */
function savedNet(bridge: TestBridge): { id: string; revision: number } {
  const saved = JSON.parse(readFileSync(pathsFor(bridge.home).net, "utf8")) as { net: string; revision: number };
  return { id: saved.net, revision: saved.revision };
}

async function setUp(t: TestContext): Promise<{ bridge: TestBridge; asking: TestClient; other: TestClient }> {
  const bridge = await startTestBridge();
  const asking = await TestClient.open(bridge, { capabilities: { poll_now: true } });
  const other = await TestClient.open(bridge);
  t.after(async () => {
    await asking.close();
    await other.close();
    await bridge.dispose();
  });
  return { bridge, asking, other };
}

test("gateway.ready offers poll_now", async (t) => {
  const { asking } = await setUp(t);
  assert.ok(asking.readyPayload.bridge.features.includes("poll_now"));
});

test("a device that asks is told once a change is saved, by one event with no session that says where the list is as saved", async (t) => {
  const { bridge, asking, other } = await setUp(t);
  const thread = await createThread(other);
  const event = await asking.find(isPollNow);
  // A connection-wide event: no session, and no seq, as it is never replayed.
  assert.deepEqual(Object.keys(event.params), ["type", "payload"]);
  assert.deepEqual(event.params.payload, { thread_list: savedList(bridge), net: savedNet(bridge) });
  assert.deepEqual(event.params.payload.thread_list, (await asking.call("sessions.activity")).thread_list);
  await settled();
  assert.equal(told(asking).length, 1);

  // A pin from another device: one more, with the revision its answer has.
  const pinned = await other.call("thread.mark", { thread, pinned: true });
  await asking.next((frame) => isPollNow(frame) && frame.params.payload.thread_list.revision === pinned.thread.revision);
  assert.deepEqual(told(asking).at(-1).params.payload, { thread_list: savedList(bridge), net: savedNet(bridge) });
  await settled();
  assert.equal(told(asking).length, 2);
  // The one that did not ask was told nothing.
  assert.equal(told(other).length, 0);
});

test("the event that tells of a turn's end comes after its message.complete, saying the list as the end left it", async (t) => {
  const { bridge, asking, other } = await setUp(t);
  // The asking device follows the thread, as a device with it open does.
  const thread = await createThread(asking);
  await settled();
  const from = asking.frames.length;
  // A question holds the turn open until it is answered: its start and its end are apart.
  await asking.call("prompt.submit", { session_id: thread, text: "ask me first", profile: "fake" });
  const question = await asking.nextRequest();
  await settled();
  asking.answer(question.id, { answers: { q0: "Swift" } });
  const complete = await asking.from(from, (frame) => isEvent(frame, "message.complete", thread));
  await settled();
  const end = savedList(bridge).revision;
  const frames = asking.frames.slice(from);
  const completeAt = frames.indexOf(complete);
  const events = frames.filter(isPollNow);
  // The turn's start (with its question) and its end: at least two, the last saying where the end left the list.
  assert.ok(events.length >= 2, `${events.length} events`);
  assert.equal(events.at(-1).params.payload.thread_list.revision, end);
  // None that says the end's revision comes before the end is told.
  for (const event of events) {
    if (event.params.payload.thread_list.revision >= end) assert.ok(frames.indexOf(event) > completeAt);
  }
  // A device that did not ask and follows nothing hears nothing of it.
  assert.deepEqual(other.frames.filter((frame) => frame.method === "event").map((frame) => frame.params.type), ["gateway.ready"]);
});

test("a change threads.json could not take sends nothing; saved once it can, it is told", async (t) => {
  const { bridge, asking, other } = await setUp(t);
  const thread = await createThread(other);
  await settled();
  const before = told(asking).length;
  // threads.json cannot be replaced.
  const path = pathsFor(bridge.home).threads;
  renameSync(path, `${path}.aside`);
  mkdirSync(join(path, "in-the-way"), { recursive: true });
  await assert.rejects(other.call("thread.mark", { thread, pinned: true }), (error: { code: number }) => error.code === -32603);
  await settled();
  assert.equal(told(asking).length, before);

  rmSync(path, { recursive: true, force: true });
  renameSync(`${path}.aside`, path);
  await other.call("thread.mark", { thread, pinned: true });
  await settled();
  assert.equal(told(asking).length, before + 1);
  assert.deepEqual(told(asking).at(-1).params.payload, { thread_list: savedList(bridge), net: savedNet(bridge) });
});

test("a change no listing shows, or one that changes nothing, sends nothing", async (t) => {
  const { bridge, asking, other } = await setUp(t);
  const thread = await createThread(other);
  await other.call("thread.mark", { thread, pinned: true });
  await other.call("look.set", { profile: "fake", shape: 1, face: 2, tint: 3 });
  await other.call("order.set", { agents: ["fake"] });
  await settled();
  const before = told(asking).length;
  const revision = savedList(bridge).revision;

  // The model is not listed; the same pin, look and order again change nothing.
  await other.call("config.set", { key: "model", value: "fake-2 --session", session_id: thread, profile: "fake" });
  await other.call("thread.mark", { thread, pinned: true });
  await other.call("look.set", { profile: "fake", shape: 1, face: 2, tint: 3 });
  await other.call("order.set", { agents: ["fake"] });
  // A seen for a thread that is not unseen.
  await other.call("thread.mark", { thread, unseen: false, revision });
  await settled();
  assert.equal(savedList(bridge).revision, revision);
  assert.equal(told(asking).length, before);
});

test("the agents' looks and the sidebar's order moving are told too, the list where it was", async (t) => {
  const { bridge, asking, other } = await setUp(t);
  const list = savedList(bridge);
  const net = savedNet(bridge);
  await other.call("look.set", { profile: "fake", shape: 4, face: 5, tint: 6 });
  await settled();
  assert.equal(told(asking).length, 1);
  await other.call("order.set", { folders: ["/Users/dev/notes"] });
  await settled();
  assert.equal(told(asking).length, 2);
  for (const event of told(asking)) assert.deepEqual(event.params.payload, { thread_list: list, net });
});

test("a connection that did not ask, a link between Macs and the portals command are never told", async (t) => {
  const { bridge, asking, other } = await setUp(t);
  const thread = await createThread(other);
  await settled();
  const before = told(asking).length;
  // As a link and the command call: gateway.ready, one call, hang up; no client.capabilities.
  const recording = (open: () => WebSocket, frames: Frame[]) => () => {
    const socket = open();
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
    return socket;
  };
  const linkFrames: Frame[] = [];
  const ticket = await mintTicket(bridge);
  const link = callOnce(
    recording(() => new WebSocket(socketURL(bridge, `?ticket=${encodeURIComponent(ticket)}`), { perMessageDeflate: false }), linkFrames),
    "thread.send",
    { thread, text: "from the link", wait: true },
    10_000,
  );
  await link;
  await settled();
  const commandFrames: Frame[] = [];
  const socketPath = pathsFor(bridge.home).socket;
  await callOnce(
    recording(() => new WebSocket("ws://portals/api/ws", { createConnection: () => createConnection(socketPath), perMessageDeflate: false }), commandFrames),
    "thread.send",
    { thread, text: "from the command", wait: true },
    10_000,
  );
  await settled();
  // The list moved while each waited: the device that asked was told, they were not.
  assert.ok(told(asking).length >= before + 2, `${told(asking).length - before} events`);
  assert.equal(linkFrames.filter(isPollNow).length, 0);
  assert.equal(commandFrames.filter(isPollNow).length, 0);
  assert.ok(linkFrames.some((frame) => frame.id === "c1" && frame.result));
  assert.equal(told(other).length, 0);
});

test("a device that says it no longer asks, or closes, is told nothing more; the others still are", async (t) => {
  const { bridge, asking, other } = await setUp(t);
  const leaving = await TestClient.open(bridge, { capabilities: { poll_now: true } });
  const thread = await createThread(other);
  await settled();
  assert.equal(told(asking).length, 1);
  assert.equal(told(leaving).length, 1);

  await leaving.call("client.capabilities", { server_requests: true });
  await other.call("thread.mark", { thread, pinned: true });
  await settled();
  assert.equal(told(leaving).length, 1);
  assert.equal(told(asking).length, 2);

  // Asking again, then closing.
  await leaving.call("client.capabilities", { server_requests: true, poll_now: true });
  await leaving.close();
  await other.call("thread.mark", { thread, pinned: false });
  await settled();
  assert.equal(told(asking).length, 3);
});

// MARK: The parts on their own

test("a burst is one event: later moves do not start the wait again, and the event says what is there when it goes", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  let revision = 1;
  const pollNow = new PollNow(() => ({ thread_list: { id: "l", revision } }), 200);
  const sent: ConnectionEvent[] = [];
  const peer = { sendConnectionEvent: (event: ConnectionEvent) => sent.push(event) };

  // Nobody asks: nothing waits.
  pollNow.moved();
  mock.timers.tick(500);
  assert.equal(sent.length, 0);

  pollNow.ask(peer, true);
  revision = 2;
  pollNow.moved();
  mock.timers.tick(150);
  revision = 3;
  pollNow.moved();
  mock.timers.tick(49);
  assert.equal(sent.length, 0);
  // 200 ms after the first move, not after the last.
  mock.timers.tick(1);
  assert.deepEqual(sent, [{ type: "poll.now", payload: { thread_list: { id: "l", revision: 3 } } }]);
  mock.timers.tick(1000);
  assert.equal(sent.length, 1);

  // The next move waits again.
  revision = 4;
  pollNow.moved();
  mock.timers.tick(200);
  assert.equal(sent.length, 2);

  // One that leaves before the wait is over is not told; closing sends nothing more.
  pollNow.moved();
  pollNow.leave(peer);
  mock.timers.tick(200);
  assert.equal(sent.length, 2);
  pollNow.ask(peer, true);
  pollNow.moved();
  pollNow.close();
  mock.timers.tick(200);
  assert.equal(sent.length, 2);
  assert.equal(pollNow.asking, 0);
});

test("one device whose send throws costs only itself the event", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const pollNow = new PollNow(() => ({}), 200);
  const sent: ConnectionEvent[] = [];
  pollNow.ask({ sendConnectionEvent: () => { throw new Error("gone"); } }, true);
  pollNow.ask({ sendConnectionEvent: (event) => sent.push(event) }, true);
  pollNow.moved();
  mock.timers.tick(200);
  assert.equal(sent.length, 1);
});

/** A socket that takes every frame at once, as a device that reads does. */
class ReadingSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Frame[] = [];

  send(text: string, written?: () => void): void {
    this.sent.push(JSON.parse(text));
    written?.();
  }

  ping(): void {}

  close(): void {
    this.readyState = 3;
    this.emit("close", 1000);
  }
}

test("a connection that asked is forgotten as it closes", async () => {
  const pollNow = new PollNow(() => ({}));
  const gateway = new Gateway({ machine: "m", net: { revision: () => ({ id: "n", revision: 1 }) }, pollNow, sessions: { disconnected: () => {} } } as unknown as GatewayContext);
  const socket = new ReadingSocket();
  gateway.accept(socket as unknown as WebSocket, { kind: "password" });
  socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "r1", method: "client.capabilities", params: { server_requests: true, poll_now: true } })));
  await sleep(0);
  assert.deepEqual(socket.sent.at(-1), { jsonrpc: "2.0", id: "r1", result: { server_requests: ["approval", "clarify"] } });
  assert.equal(pollNow.asking, 1);
  socket.close();
  assert.equal(pollNow.asking, 0);
});

function record(id: string): ThreadRecord {
  return { id, agent: "fake", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "", createdAt: 0, updatedAt: 0, origin: "phone" };
}

test("the registry tells of a move once the change is saved, and of none that was not saved or that no listing shows", (t) => {
  const home = mkdtempSync(join(tmpdir(), "portals-poll-now-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "threads.json");
  const registry = new Registry(path);
  let moves = 0;
  registry.moved = () => (moves += 1);

  registry.add(record("t1"));
  assert.equal(moves, 1);
  registry.set("t1", { model: "other", mode: "plan" });
  registry.set("t1", { pinned: undefined });
  assert.equal(moves, 1);
  registry.set("t1", { pinned: true });
  registry.update("t1", { inTurn: true });
  assert.equal(moves, 3);

  // threads.json cannot be replaced: nothing moves.
  renameSync(path, `${path}.aside`);
  mkdirSync(join(path, "in-the-way"), { recursive: true });
  assert.throws(() => registry.set("t1", { archived: true }));
  assert.throws(() => registry.update("t1", { inTurn: false }));
  assert.throws(() => registry.add(record("t2")));
  assert.equal(moves, 3);
  rmSync(path, { recursive: true, force: true });
  renameSync(`${path}.aside`, path);

  registry.remove("t1");
  assert.equal(moves, 4);
});

test("looks and the order tell of a change once it is saved, and of none that changes nothing", (t) => {
  const home = mkdtempSync(join(tmpdir(), "portals-poll-now-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const looks = new Looks(join(home, "looks.json"));
  const order = new SidebarOrder(join(home, "order.json"));
  let moves = 0;
  looks.moved = order.moved = () => (moves += 1);
  looks.set("fake", { shape: 1, face: 1, tint: 1, origin: "chosen" });
  looks.set("fake", { shape: 1, face: 1, tint: 1, origin: "chosen" });
  looks.set("fake", { shape: 2, face: 2, tint: 2, origin: "assigned" });
  assert.equal(moves, 1);
  order.set({ agents: ["fake"] });
  order.set({ agents: ["fake"] });
  order.set({ machines: { ids: ["a"], at: 5 } });
  order.set({ machines: { ids: ["b"], at: 4 } });
  assert.equal(moves, 3);

  // A file that cannot be written: the change is refused and nothing is told.
  rmSync(join(home, "order.json"));
  mkdirSync(join(home, "order.json", "in-the-way"), { recursive: true });
  assert.throws(() => order.set({ agents: ["other"] }));
  assert.equal(moves, 3);
});

/** A session on its own, with an agent that only starts turns and asks what it is told to. */
function session(told: string[]): Session {
  const thread = new Session(record("activity-thread"), { has: () => false } as unknown as Registry, {
    listener: { activityChanged: () => told.push(thread.activity ?? "idle") },
  });
  return thread;
}

const agent = {
  history: async () => [],
  settings: () => ({ model: "m", provider: "p", reasoningEffort: "" }),
  startTurn: () => {},
  interrupt: async () => false,
  close: async () => {},
} as unknown as ProviderSession;

function subagent(status: SubagentInfo["status"]): SubagentInfo {
  return { id: "s1", kind: "agent", goal: "Look around", status, startedAt: 1000, background: true, stoppable: status === "running", ...(status === "running" ? {} : { endedAt: 2000 }) };
}

test("a session tells when what sessions.activity says of it changes: a turn, a question, a subagent at work after the turn", async () => {
  const told: string[] = [];
  const thread = session(told);
  await thread.attach(agent);
  assert.deepEqual(told, []);

  thread.submit("hello").begin?.();
  assert.deepEqual(told, ["running"]);
  const asked = thread.sink.ask({ kind: "clarify", questions: [{ qid: "q0", question: "Which?", choices: ["A"], multiSelect: false }] });
  assert.deepEqual(told, ["running", "waiting"]);
  const [open] = thread.requests.list();
  thread.requests.withdraw(open.id, "withdrawn");
  await asked;
  assert.deepEqual(told, ["running", "waiting", "running"]);
  // A subagent at work in a running turn changes nothing; at work after it, the thread stays at work.
  thread.sink.emit({ type: "subagent", subagent: subagent("running") });
  thread.sink.emit({ type: "text", text: "Working." });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.deepEqual(told, ["running", "waiting", "running"]);
  thread.sink.emit({ type: "subagent", subagent: subagent("completed") });
  assert.deepEqual(told, ["running", "waiting", "running", "idle"]);
  // Let go of: nothing more is told.
  thread.retire();
  thread.sink.emit({ type: "subagent", subagent: subagent("running") });
  assert.equal(told.length, 4);
});
