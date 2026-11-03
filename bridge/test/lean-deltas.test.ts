import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Connection } from "../src/gateway/connection.ts";
import type { GatewaySocket } from "../src/gateway/gateway.ts";
import type { GatewayContext } from "../src/gateway/methods.ts";
import type { Provider, ProviderSession, SessionSink } from "../src/providers/types.ts";
import type { LoggedEvent } from "../src/sessions/eventLog.ts";
import { createThread, isEvent, runTurn, startTestBridge, TestClient, type Frame } from "./helpers.ts";

/** Expands only the new live frame type; replay objects are already canonical. */
function eventOf(frame: Frame): LoggedEvent | undefined {
  if (frame.method === "event") return frame.params;
  const key = Object.hasOwn(frame, "d") ? "d" : Object.hasOwn(frame, "t") ? "t" : undefined;
  if (!key) return undefined;
  assert.deepEqual(Object.keys(frame), [key]);
  const [session_id, seq, text] = frame[key];
  assert.equal(typeof session_id, "string");
  assert.equal(typeof seq, "number");
  assert.equal(typeof text, "string");
  return { type: key === "d" ? "message.delta" : "reasoning.delta", session_id, seq, payload: { text } };
}

function events(client: TestClient, session: string): LoggedEvent[] {
  return client.frames.map(eventOf).filter((event): event is LoggedEvent => event?.session_id === session);
}

function standIn(sinks: SessionSink[]): Provider {
  const settings = { model: "m", provider: "p", reasoningEffort: "" };
  const agent: ProviderSession = {
    history: async () => [], settings: () => settings, startTurn() {}, interrupt: async () => false, close: async () => {},
    setModel: async () => ({ deferred: false }), setReasoning: async () => {},
  };
  return {
    profile: { name: "stand-in", kind: "fake", displayName: "Stand-in", description: "", model: "m", provider: "p" },
    start() {}, models: async () => ({ providers: [{ slug: "p", name: "P", models: ["m"] }], ...settings, reasoning: "" }),
    startSession: async (_options: unknown, sink: SessionSink) => { sinks.push(sink); return agent; },
    close: async () => {},
  } as unknown as Provider;
}

test("lean deltas preserve legacy bytes and unknown payload fields, with no JSON-RPC ambiguity", () => {
  const sent: string[] = [];
  const socket = Object.assign(new EventEmitter(), {
    OPEN: 1, readyState: 1, bufferedAmount: 0, send: (text: string) => sent.push(text),
  }) as unknown as GatewaySocket;
  const gateway = { machine: "test", net: { revision: () => ({ id: "net", revision: 1 }) } } as unknown as GatewayContext;
  const connection = new Connection(socket, gateway, { replayEpoch: "test" }, { kind: "password" });
  const send = (event: LoggedEvent) => { connection.sendEvent(event); return sent.at(-1); };
  const canonical = (event: LoggedEvent) => JSON.stringify({ jsonrpc: "2.0", method: "event", params: event });
  const plain: LoggedEvent = { type: "message.delta", session_id: "a", seq: 3, payload: { text: '"d": [null]\n日本語' } };
  assert.equal(send(plain), canonical(plain));
  Object.assign(connection, { leanDeltas: true });
  assert.equal(send(plain), JSON.stringify({ d: ["a", 3, plain.payload!.text] }));
  assert.equal(send({ ...plain, type: "reasoning.delta", payload: { text: "" } }), '{"t":["a",3,""]}');
  for (const event of [
    { ...plain, payload: { text: "future", extra: true } },
    { ...plain, payload: { text: 12 } },
    { ...plain, payload: undefined },
    { ...plain, type: "thinking.delta" },
    { ...plain, type: "tool.progress" },
  ]) assert.equal(send(event), canonical(event));
  assert.deepEqual(plain.payload, { text: '"d": [null]\n日本語' }, "encoding never changes the logged event");
});

test("the capability's answer is the boundary: a delta sent while it is handled keeps the old shape, either way", async () => {
  const sent: string[] = [];
  const socket = Object.assign(new EventEmitter(), {
    OPEN: 1, readyState: 1, bufferedAmount: 0, send: (text: string) => sent.push(text),
  });
  const gateway = {
    machine: "test", net: { revision: () => ({ id: "net", revision: 1 }) }, pollNow: { ask() {} },
  } as unknown as GatewayContext;
  const connection = new Connection(socket as unknown as GatewaySocket, gateway, { replayEpoch: "test" }, { kind: "password" });
  const delta: LoggedEvent = { type: "message.delta", session_id: "a", seq: 1, payload: { text: "x" } };
  const canonical = JSON.stringify({ jsonrpc: "2.0", method: "event", params: delta });
  const compact = '{"d":["a",1,"x"]}';
  const answered = (id: string) => new Promise<void>((resolve) => {
    const check = () => (sent.some((text) => JSON.parse(text).id === id) ? resolve() : setImmediate(check));
    check();
  });
  for (const [id, lean, before, after] of [["on", true, canonical, compact], ["off", false, compact, canonical]] as const) {
    const from = sent.length;
    // The call is read and handled at once; its answer goes out only after an await.
    socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "client.capabilities", params: { lean_deltas: lean } })));
    connection.sendEvent(delta);
    await answered(id);
    connection.sendEvent(delta);
    const frames = sent.slice(from);
    assert.equal(frames.length, 3, frames.join("\n"));
    assert.equal(frames[0], before, "a delta before the answer keeps the shape the client was last told");
    assert.equal(JSON.parse(frames[1]).id, id);
    assert.equal(JSON.parse(frames[1]).result.lean_deltas, lean ? true : undefined);
    assert.equal(frames[2], after, "a delta after the answer takes the shape it acknowledged");
  }
});

test("lean deltas negotiate through capabilities and leave a simultaneous legacy follower byte-identical", async (t) => {
  const bridge = await startTestBridge();
  t.after(() => bridge.dispose());
  const modern = await TestClient.open(bridge, { capabilities: { lean_deltas: true } });
  const legacy = await TestClient.open(bridge);
  t.after(() => Promise.all([modern.close(), legacy.close()]));
  assert.ok(modern.readyPayload.bridge.features.includes("lean_deltas"));
  assert.equal((await modern.call("client.capabilities", { server_requests: true, lean_deltas: true })).lean_deltas, true);
  const id = await createThread(modern);
  await legacy.call("session.resume", { session_id: id });
  const legacyBytes: string[] = [];
  legacy.socket.on("message", (data) => legacyBytes.push(data.toString()));
  await runTurn(modern, id, "think about this please");
  await legacy.find((frame) => isEvent(frame, "message.complete", id));
  const canonical = legacy.events(id);
  assert.deepEqual(events(modern, id), canonical);
  assert.ok(modern.frames.some((frame) => frame.d));
  assert.ok(modern.frames.some((frame) => frame.t));
  assert.ok(!legacy.frames.some((frame) => frame.d || frame.t));
  for (const event of canonical) {
    assert.ok(legacyBytes.includes(JSON.stringify({ jsonrpc: "2.0", method: "event", params: event })));
  }
  const replay = await modern.call("session.events.since", { session_id: id, last_seen: 0 });
  assert.deepEqual(replay.events, canonical);
});

test("lean deltas can be disabled or omitted and a wrong capability type is refused", async (t) => {
  const sinks: SessionSink[] = [];
  const bridge = await startTestBridge({ providers: new Map([["stand-in", standIn(sinks)]]) });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const id = await createThread(client, { profile: "stand-in" });
  await assert.rejects(client.call("client.capabilities", { lean_deltas: "yes" }), /must be a boolean/);
  for (const [params, compact] of [[{ lean_deltas: true }, true], [{ lean_deltas: false }, false], [{ lean_deltas: true }, true], [{}, false], [{ lean_deltas: null }, false]] as const) {
    const answer = await client.call("client.capabilities", params);
    assert.deepEqual(answer, compact ? { server_requests: ["approval", "clarify"], lean_deltas: true } : { server_requests: ["approval", "clarify"] });
    const from = client.frames.length;
    sinks[0].emit({ type: "text", text: "next" });
    const frame = await client.from(from, (frame) => eventOf(frame)?.session_id === id);
    assert.equal(Object.hasOwn(frame, "d"), compact);
  }
});

test("lean deltas keep multi-thread ordering through tools, reconnect replay and resumed live events", async (t) => {
  const sinks: SessionSink[] = [];
  const bridge = await startTestBridge({ providers: new Map([["stand-in", standIn(sinks)]]) });
  t.after(() => bridge.dispose());
  const first = await TestClient.open(bridge, { capabilities: { lean_deltas: true } });
  const legacy = await TestClient.open(bridge);
  t.after(() => Promise.all([first.close(), legacy.close()]));
  const id = await createThread(first, { profile: "stand-in" });
  const other = await createThread(first, { profile: "stand-in" });
  const baseline = await first.call("session.resume", { session_id: id, replay_epoch: bridge.replayEpoch });
  await legacy.call("session.resume", { session_id: id });
  // A conversation larger than the missed events, so light replay is useful.
  await first.call("prompt.submit", { session_id: id, text: "hello ".repeat(2000) });
  sinks[0].emit({ type: "text", text: "before " });
  sinks[1].emit({ type: "text", text: "another thread" });
  sinks[0].emit({ type: "tool.start", id: "read", name: "read_file", args: { path: "a" } });
  sinks[0].emit({ type: "reasoning", text: "checking " });
  await first.find((frame) => frame.t?.[0] === id);
  assert.equal(events(first, other).at(-1)?.payload?.text, "another thread");
  const seen = events(first, id);
  const last = seen.at(-1)!.seq;
  await first.close();
  sinks[0].emit({ type: "tool.end", id: "read", name: "read_file", args: { path: "a" }, result: "contents" });
  sinks[0].emit({ type: "text", text: "missed " });
  const again = await TestClient.open(bridge, { capabilities: { lean_deltas: true } });
  t.after(() => again.close());
  const response = await again.request("session.resume", {
    session_id: id, replay_epoch: bridge.replayEpoch, replay_base: baseline.replay_base, since: last,
  });
  assert.equal(response.result.replayed, true);
  assert.ok(response.result.events.some((event: LoggedEvent) => event.type === "tool.complete"));
  assert.ok(response.result.events.some((event: LoggedEvent) => event.type === "message.delta"));
  assert.ok(response.result.events.every((event: LoggedEvent) => !("d" in event) && !("t" in event)));
  sinks[0].emit({ type: "reasoning", text: "resumed thought " });
  sinks[0].emit({ type: "text", text: "after 日本語\n" });
  sinks[0].emit({ type: "turn.end", status: "complete" });
  await again.find((frame) => isEvent(frame, "message.complete", id));
  await legacy.find((frame) => isEvent(frame, "message.complete", id));
  const combined = [...seen, ...response.result.events, ...events(again, id)];
  const canonical = legacy.events(id);
  assert.deepEqual(combined, canonical);
  assert.deepEqual(combined.map((event) => event.seq), canonical.map((event, index) => canonical[0].seq + index));
  assert.ok(again.frames.findIndex((frame) => frame.t) > again.frames.indexOf(response));
  const third = await TestClient.open(bridge);
  t.after(() => third.close());
  await third.call("session.resume", { session_id: id });
  const oldReplay = await third.call("session.events.since", { session_id: id, last_seen: last });
  assert.deepEqual(oldReplay.events, canonical.filter((event) => event.seq > last));
});
