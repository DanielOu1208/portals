import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { setImmediate as yieldToTheLoop, setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Connection } from "../src/gateway/connection.ts";
import { Gateway, type GatewaySocket } from "../src/gateway/gateway.ts";
import { Atomic, methods, type CallContext, type GatewayContext } from "../src/gateway/methods.ts";
import { log } from "../src/log.ts";
import { TunnelDevice } from "../scripts/tunnel-device.ts";
import { Tunnel } from "../src/relay/tunnel.ts";
import type { EventLog } from "../src/sessions/eventLog.ts";
import { createThread, isEvent, runTurn, startTestBridge, TestClient, type TestBridge } from "./helpers.ts";
import { RelayStandIn } from "./relay-standin.ts";

const MiB = 1024 * 1024;
const ceiling = 128 * MiB;

/** Counts queued bytes, not retained payloads; a test may model an oversized frame. */
class UnreadSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent = 0;
  nextBytes?: number;

  send(text: string): void {
    this.sent += 1;
    this.bufferedAmount += this.nextBytes ?? Buffer.byteLength(text);
    this.nextBytes = undefined;
  }
  terminate(): void { this.readyState = 3; this.emit("close", 1006, Buffer.alloc(0)); }
  close(): void { this.terminate(); }
  ping(): void {}
}

function connection(socket: UnreadSocket, answer: unknown = { text: "界".repeat(100) }): Connection {
  const gateway = { machine: "m", net: { revision: () => ({ id: "n", revision: 1 }) }, sessions: { get: () => ({ eventsSince: () => answer }) } } as unknown as GatewayContext;
  const caller = new Connection(socket as unknown as GatewaySocket, gateway, { replayEpoch: "e" }, { kind: "password" });
  socket.bufferedAmount = 0;
  return caller;
}

function ask(socket: UnreadSocket, id: number): void {
  socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "session.events.since", params: { session_id: "s", last_seen: 0 } })));
}

test("queued answers have an independent ceiling and the projected frame counts UTF-8 bytes", async (t) => {
  const socket = new UnreadSocket();
  connection(socket);
  const warn = t.mock.method(log, "warn", () => {});
  socket.nextBytes = ceiling - 200;
  ask(socket, 1);
  await yieldToTheLoop();
  assert.equal(socket.readyState, socket.OPEN);
  const sent = socket.sent;
  ask(socket, 2); // About 150 UTF-16 units, but over 300 UTF-8 bytes.
  await yieldToTheLoop();
  assert.equal(socket.readyState, 3, "reject before adding a frame past the queued ceiling");
  assert.equal(socket.sent, sent);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[1]?.reason), /queued outbound bytes/);
  assert.equal(warn.mock.calls[0].arguments[1]?.limit, ceiling);
});

test("an empty queue admits one oversized frame, then closes before serializing another", async () => {
  const socket = new UnreadSocket();
  const caller = connection(socket, { text: "x".repeat(ceiling + MiB) });
  ask(socket, 1);
  await yieldToTheLoop();
  assert.equal(socket.readyState, socket.OPEN, "one huge direct answer can start on an empty queue");
  const sent = socket.sent;
  let serialized = false;
  caller.sendConnectionEvent({ type: "poll.now", payload: { toJSON() { serialized = true; return {}; } } });
  assert.equal(socket.readyState, 3);
  assert.equal(socket.sent, sent);
  assert.equal(serialized, false, "a full queue is checked before JSON allocation");
});

test("cap-close aborts that connection's pending calls, not another connection", async (t) => {
  const signals: AbortSignal[] = [];
  const built: AbortSignal[] = [];
  t.mock.method(methods["thread.wait"], "handle", (_params: Record<string, unknown>, context: CallContext) => {
    signals.push(context.hungUp);
    return new Promise((resolve) => context.hungUp.addEventListener("abort", () => resolve(new Atomic(() => {
      built.push(context.hungUp);
      return {};
    })), { once: true }));
  });
  const sockets = [new UnreadSocket(), new UnreadSocket()];
  sockets.forEach(socket => connection(socket));
  for (const socket of sockets) socket.emit("message", Buffer.from('{"id":"pending","method":"thread.wait","params":{"thread":"s"}}'));
  assert.equal(signals.length, 2);
  sockets[0].nextBytes = ceiling;
  ask(sockets[0], 1);
  await yieldToTheLoop();
  ask(sockets[0], 2);
  await yieldToTheLoop();
  assert.equal(signals[0].aborted, true);
  assert.equal(built.includes(signals[0]), false, "aborted calls cannot rebuild a subscription");
  assert.equal(signals[1].aborted, false);
  assert.equal(sockets[1].readyState, sockets[1].OPEN);
  sockets[1].terminate();
});

test("cap-close still begins a prompt already accepted by the session", async (t) => {
  let gateway!: Gateway;
  const accept = Gateway.prototype.accept;
  t.mock.method(Gateway.prototype, "accept", function(this: Gateway, ...args: Parameters<Gateway["accept"]>) {
    gateway = this;
    return accept.apply(this, args);
  });
  const bridge = await startTestBridge();
  const owner = await TestClient.open(bridge);
  const socket = new UnreadSocket();
  try {
    const id = await createThread(owner);
    const caller = new Connection(socket as unknown as GatewaySocket, gateway.context, { replayEpoch: gateway.replayEpoch }, { kind: "password" });
    const session = gateway.context.sessions.get(id)!;
    session.follow(caller);
    socket.on("close", () => session.unfollow(caller));
    socket.bufferedAmount = ceiling;
    // Both handlers run before either await continuation: the history reply
    // closes the socket after submit has reserved the turn, before begin runs.
    for (const [method, params] of [
      ["session.events.since", { session_id: id, last_seen: 0 }],
      ["prompt.submit", { session_id: id, text: "accepted before close", profile: "fake" }],
    ] as const) socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: method, method, params })));
    assert.equal(session.isRunning, true, "submit reserved the turn synchronously");
    await yieldToTheLoop();
    assert.equal(socket.readyState, 3);
    assert.ok(session.eventsSince(0).events.some(event => event.type === "message.start"), "the accepted turn begins despite losing its reply");
    await owner.next(frame => isEvent(frame, "message.complete", id));
    assert.equal(session.isRunning, false);
    await runTurn(owner, id, "the following turn also runs");
  } finally {
    socket.terminate();
    await owner.close();
    await bridge.dispose();
  }
});

/** Observe the actual accepted transport without changing its send/read behavior. */
function observe(t: TestContext): GatewaySocket[] {
  const sockets: GatewaySocket[] = [];
  const accept = Gateway.prototype.accept;
  t.mock.method(Gateway.prototype, "accept", function(this: Gateway, ...[socket, signedIn]: Parameters<Gateway["accept"]>) {
    sockets.push(socket);
    return accept.call(this, socket, signedIn);
  });
  return sockets;
}

function seed(bridge: TestBridge, id: string, bytes: number): unknown {
  const session = (bridge.fleet as unknown as { sessions: { get(id: string): { log: EventLog; eventsSince(seq: number): unknown } } }).sessions.get(id);
  session.log.append("message.delta", { text: "x".repeat(bytes) });
  return session.eventsSince(0);
}

test("a scratch non-reading client's replies are bounded and a fresh connection can replay", async (t) => {
  const sockets = observe(t);
  const bridge = await startTestBridge();
  const stalled = await TestClient.open(bridge);
  let again: TestClient | undefined;
  try {
    const id = await createThread(stalled);
    const expected = seed(bridge, id, MiB);
    const closed = once(sockets[0] as unknown as EventEmitter, "close");
    let peak = 0;
    const send = sockets[0].send.bind(sockets[0]);
    t.mock.method(sockets[0], "send", (...args: Parameters<GatewaySocket["send"]>) => {
      send(...args);
      peak = Math.max(peak, sockets[0].bufferedAmount);
    });
    stalled.socket.pause();
    for (let request = 0; request < 160; request += 1) stalled.send({ jsonrpc: "2.0", id: `unread-${request}`, method: "session.events.since", params: { session_id: id, last_seen: 0 } });
    let expired = false;
    const deadline = setTimeout(() => { expired = true; stalled.socket.terminate(); }, 5000);
    try {
      const [code] = await closed;
      assert.equal(code, 1006);
      assert.equal(stalled.socket.isPaused, true);
      assert.equal(expired, false, "the bridge closed it before the test deadline");
      assert.ok(peak > 100 * MiB && peak <= ceiling + 14, `bounded real queue: ${peak}`);
    } finally { clearTimeout(deadline); stalled.socket.terminate(); }
    again = await TestClient.open(bridge);
    const resumed = await again.call("session.resume", { session_id: id, profile: "fake" });
    assert.equal(resumed.session_id, id);
    assert.deepEqual(await again.call("session.events.since", { session_id: id, last_seen: 0 }), expected);
  } finally {
    stalled.socket.terminate();
    await again?.close();
    await bridge.dispose();
  }
});

test("a scratch slow reader fetches large replies repeatedly without being cut off", async (t) => {
  const sockets = observe(t);
  const bridge = await startTestBridge();
  const slow = await TestClient.open(bridge);
  try {
    const id = await createThread(slow);
    seed(bridge, id, 8 * MiB);
    // Three batches of six 8 MiB pages, with intermittent transport reads. Each
    // burst is well above the old 8 MiB event bound, but has ample reply headroom.
    for (let batch = 0; batch < 3; batch += 1) {
      slow.socket.pause();
      const replies = Array.from({ length: 6 }, (_, page) => slow.request("session.events.since", { session_id: id, last_seen: 0 }, `slow-${batch}-${page}`));
      await sleep(30);
      assert.equal(sockets[0].readyState, sockets[0].OPEN);
      slow.socket.resume();
      for (const reply of await Promise.all(replies)) assert.equal(reply.result.events.at(-1).payload.text.length, 8 * MiB);
      slow.frames.length = 0;
    }
    assert.equal(sockets[0].readyState, sockets[0].OPEN);
  } finally {
    slow.socket.resume();
    await slow.close();
    await bridge.dispose();
  }
});

test("the scratch bridge's sealed tunnel leg is bounded when the relay stops reading it", async (t) => {
  const sockets = observe(t);
  const relay = await RelayStandIn.start();
  const bridge = await startTestBridge({ config: { relay: { enabled: true, url: relay.url } } });
  const owner = await TestClient.open(bridge);
  let device: TunnelDevice | undefined;
  try {
    const listing = await owner.call("net.list");
    const mac = listing.members.find((member: { id: string }) => member.id === listing.here);
    for (const end = Date.now() + 5000; relay.open(mac.relay, "mac").length === 0;) {
      assert.ok(Date.now() < end, "scratch relay standby opens");
      await sleep(10);
    }
    const { code } = await owner.call("net.invite");
    const joined = await fetch(`${bridge.url}/net/join`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, member: { id: "unread-tunnel-device", kind: "device", name: "Test phone", platform: "ios" } }),
    });
    assert.equal(joined.status, 200);
    const { token } = await joined.json() as { token: string };
    device = await TunnelDevice.open({ relay: relay.url, relayID: mac.relay, macKey: mac.key, token });
    await device.find(frame => frame.params?.type === "gateway.ready");
    const tunnel = sockets.find(socket => socket instanceof Tunnel)!;
    assert.ok(tunnel);
    const id = await createThread(owner);
    seed(bridge, id, MiB);
    const closed = once(tunnel as unknown as EventEmitter, "close");
    let peak = 0;
    const send = tunnel.send.bind(tunnel);
    t.mock.method(tunnel, "send", (...args: Parameters<GatewaySocket["send"]>) => {
      send(...args);
      peak = Math.max(peak, tunnel.bufferedAmount);
    });
    const channel = relay.open(mac.relay, "channel")[0];
    channel.pause(); // Bytes queue in the bridge's actual sealed ws leg, not the Worker.
    for (let request = 0; request < 160; request += 1) device.sendText(JSON.stringify({ jsonrpc: "2.0", id: request, method: "session.events.since", params: { session_id: id, last_seen: 0 } }));
    let expired = false;
    const deadline = setTimeout(() => { expired = true; tunnel.terminate(); }, 5000);
    try {
      await closed;
      assert.equal(expired, false, "the gateway ceiling closes the actual sealed transport");
      assert.ok(peak > 100 * MiB && peak <= ceiling + 32, `bounded sealed queue: ${peak}`);
      assert.equal(sockets[0].readyState, sockets[0].OPEN, "the direct owner is unaffected");
      assert.equal((await owner.call("threads.list")).threads.some((thread: { id: string }) => thread.id === id), true);
    } finally { clearTimeout(deadline); channel.resume(); }
  } finally {
    device?.socket.terminate();
    await owner.close();
    relay.dropAll();
    await bridge.dispose();
    await relay.close();
  }
});
