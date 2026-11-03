import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToTheLoop } from "node:timers/promises";
import { after, before, test } from "node:test";
import type { WebSocket } from "ws";
import { Connection } from "../src/gateway/connection.ts";
import type { GatewayContext } from "../src/gateway/methods.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { Prompt, ProviderSession, SessionOptions, SessionSink } from "../src/providers/types.ts";
import { createThread, isEvent, startTestBridge, TestClient, type Frame, type TestBridge } from "./helpers.ts";

// A device that stops reading (a phone in a tunnel, an app the system suspended) while
// the bridge sends to it: what waits in its socket is bounded, and past the bound the
// connection is closed, so the device connects again and catches up by event number as
// after any drop (docs/gateway-protocol.md, sections 2 and 8). A large frame on its own,
// a whole list or a long conversation, never counts against a device that reads.

/**
 * The scripted agent, with two more scripts: `flood <pieces> <characters>` streams that
 * many pieces of text of that size, one a turn of the event loop, so a device that
 * reads keeps up and one that does not falls behind; `output <characters>` runs a
 * command whose output is that long, in the one event.
 */
class Floods extends FakeProvider {
  override async startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    const session = await super.startSession(options, sink);
    const start = session.startTurn.bind(session);
    return Object.assign(session, {
      startTurn(prompt: Prompt): void {
        const output = /^output (\d+)$/.exec(prompt.text);
        if (output) {
          sink.emit({ type: "tool.start", id: "t1", name: "terminal", args: { command: "cat build.log" } });
          sink.emit({ type: "tool.end", id: "t1", name: "terminal", args: { command: "cat build.log" }, result: { output: "x".repeat(Number(output[1])), exit_code: 0 } });
          sink.emit({ type: "text", text: "Done." });
          sink.emit({ type: "turn.end", status: "complete" });
          return;
        }
        const flood = /^flood (\d+) (\d+)$/.exec(prompt.text);
        if (!flood) return start(prompt);
        void (async () => {
          for (let index = 0; index < Number(flood[1]); index += 1) {
            sink.emit({ type: "text", text: String(index % 10).repeat(Number(flood[2])) });
            await yieldToTheLoop();
          }
          sink.emit({ type: "turn.end", status: "complete" });
        })();
      },
    });
  }
}

let directory: string;
let bridge: TestBridge;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "portals-backpressure-"));
  bridge = await startTestBridge({ providers: new Map([["fake", new Floods({ directory, delayMs: 1 })]]) });
});

after(async () => {
  await bridge.dispose();
  rmSync(directory, { recursive: true, force: true });
});

/** The bytes `client` receives from now on. */
function counting(client: TestClient): { bytes: number } {
  const received = { bytes: 0 };
  client.socket.on("message", (data: Buffer) => (received.bytes += data.length));
  return received;
}

/** Resolves once `client`'s socket closes, or with "open" when it is still open `ms` from now. */
async function closedWithin(client: TestClient, ms: number): Promise<number | "open"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([client.closed, new Promise<"open">((done) => (timer = setTimeout(() => done("open"), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

test("a device that stops reading is closed once more than a few megabytes wait for it, and catches up by event number when it connects again", async (t) => {
  const owner = await TestClient.open(bridge);
  const stalled = await TestClient.open(bridge);
  t.after(() => Promise.all([owner.close(), stalled.close()]));
  const session = await createThread(owner);
  await stalled.call("session.resume", { session_id: session, profile: "fake" });
  const before = stalled.events(session).at(-1)?.seq ?? 0;

  // 32 MB of text, 64 KB an event, to a device that reads none of it.
  const pieces = 512;
  const size = 64 * 1024;
  const received = counting(stalled);
  stalled.socket.pause();
  const start = owner.frames.length;
  await owner.call("prompt.submit", { session_id: session, text: `flood ${pieces} ${size}`, profile: "fake" });
  await owner.from(start, (frame) => isEvent(frame, "message.complete", session), 30_000);
  // The device that read had all of it.
  assert.equal(owner.events(session).filter((event: Frame) => event.type === "message.delta" && event.seq > before).length, pieces);

  // Reading again, the stalled device takes what was already on its way, and then finds its connection closed.
  stalled.socket.resume();
  assert.notEqual(await closedWithin(stalled, 5000), "open", "the bridge closed the connection of the device that stopped reading");
  assert.ok(received.bytes < (pieces * size) / 2, `it was sent ${received.bytes} bytes of ${pieces * size}: the rest never waited for it`);

  // Connected again, it is told what it missed from the last event it holds, the turn's end too.
  const again = await TestClient.open(bridge);
  t.after(() => again.close());
  const held = stalled.events(session).at(-1)?.seq ?? before;
  const resumed = await again.call("session.resume", { session_id: session, profile: "fake" });
  const missed = await again.call("session.events.since", { session_id: resumed.session_id, last_seen: held });
  assert.equal(missed.truncated, false);
  assert.equal(missed.events[0].seq, held + 1);
  assert.equal(missed.events.at(-1).type, "message.complete");
  assert.equal(missed.events.filter((event: Frame) => event.type === "message.delta").length + stalled.events(session).filter((event: Frame) => event.type === "message.delta" && event.seq > before).length, pieces);
});

test("one event larger than the bound is sent whole to a device that is slow to read it, and what follows it does not close the connection", async (t) => {
  const owner = await TestClient.open(bridge);
  const slow = await TestClient.open(bridge);
  t.after(() => Promise.all([owner.close(), slow.close()]));
  const session = await createThread(owner);
  await slow.call("session.resume", { session_id: session, profile: "fake" });

  // A command's 24 MB of output in one event, then a turn of small ones, while the device reads nothing.
  slow.socket.pause();
  let start = owner.frames.length;
  await owner.call("prompt.submit", { session_id: session, text: `output ${24 * 1024 * 1024}`, profile: "fake" });
  await owner.from(start, (frame) => isEvent(frame, "message.complete", session), 30_000);
  start = owner.frames.length;
  await owner.call("prompt.submit", { session_id: session, text: "flood 64 1024", profile: "fake" });
  await owner.from(start, (frame) => isEvent(frame, "message.complete", session), 30_000);

  slow.socket.resume();
  await slow.find((frame) => isEvent(frame, "message.complete", session) && frame.params.seq === owner.events(session).at(-1).seq, 30_000);
  assert.equal(await closedWithin(slow, 200), "open");
  assert.equal(slow.events(session).find((event: Frame) => event.type === "tool.complete").payload.result.output.length, 24 * 1024 * 1024);
  assert.equal(slow.events(session).filter((event: Frame) => event.type === "message.delta").length, 65);
});

test("concurrent large reconnect answers remain exempt from the smaller unsolicited-event bound", async (t) => {
  const owner = await TestClient.open(bridge);
  const slow = await TestClient.open(bridge);
  t.after(() => Promise.all([owner.close(), slow.close()]));
  // Six threads of 3 MB each, as after a reconnect with that many turns under way.
  const sessions: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const session = await createThread(owner);
    const start = owner.frames.length;
    await owner.call("prompt.submit", { session_id: session, text: `flood 3 ${1024 * 1024}`, profile: "fake" });
    await owner.from(start, (frame) => isEvent(frame, "message.complete", session), 30_000);
    sessions.push(session);
  }

  slow.socket.pause();
  const resumed = sessions.map((session, index) => slow.request("session.resume", { session_id: session, profile: "fake" }, `resume-${index}`));
  // Answered while it reads nothing; then one more turn in the first.
  await new Promise((done) => setTimeout(done, 200));
  const start = owner.frames.length;
  await owner.call("prompt.submit", { session_id: sessions[0], text: "flood 16 1024", profile: "fake" });
  await owner.from(start, (frame) => isEvent(frame, "message.complete", sessions[0]), 30_000);

  slow.socket.resume();
  for (const answer of await Promise.all(resumed)) assert.ok(answer.result.messages.length > 0);
  await slow.find((frame) => isEvent(frame, "message.complete", sessions[0]) && frame.params.seq === owner.events(sessions[0]).at(-1).seq, 30_000);
  assert.equal(await closedWithin(slow, 200), "open");
});

/**
 * A socket whose device reads only when told to (`read`), as `ws` keeps what waits: what
 * is handed to it is counted in `bufferedAmount` until the device has read it, oldest
 * first, and the callback given with a frame is called once it is all gone.
 */
class SlowSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  /** What waited when the bridge dropped it; undefined while it has not. */
  droppedWith: number | undefined;
  private readonly waiting: { bytes: number; written?: () => void }[] = [];

  send(text: string, written?: () => void): void {
    const bytes = Buffer.byteLength(text);
    this.waiting.push({ bytes, written });
    this.bufferedAmount += bytes;
  }

  /** The device reads `bytes` of what waits. */
  read(bytes: number): void {
    while (bytes > 0 && this.waiting.length > 0) {
      const frame = this.waiting[0];
      const taken = Math.min(bytes, frame.bytes);
      frame.bytes -= taken;
      this.bufferedAmount -= taken;
      bytes -= taken;
      if (frame.bytes > 0) break;
      this.waiting.shift();
      frame.written?.();
    }
  }

  terminate(): void {
    this.droppedWith = this.bufferedAmount;
    this.readyState = 3;
  }
}

test("a device that reads slowly, never all that waits for it, is closed once more than the bound of what it did not ask for waits, whatever it asked for before and has read since", async () => {
  const kilobytes = 1024;
  const megabytes = 1024 * kilobytes;
  const socket = new SlowSocket();
  // A conversation of 6 MB, as one large thread opened after a reconnect.
  const conversation = { events: [{ type: "message.delta", session_id: "s", seq: 1, payload: { text: "x".repeat(6 * megabytes) } }], truncated: false, latest_seq: 1, open_requests: [] };
  const gateway = { machine: "m", net: { revision: () => ({ id: "n", revision: 1 }) }, sessions: { get: () => ({ eventsSince: () => conversation }) } } as unknown as GatewayContext;
  const connection = new Connection(socket as unknown as WebSocket, gateway, { replayEpoch: "e" }, { kind: "password" });
  socket.read(socket.bufferedAmount);
  socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.events.since", params: { session_id: "s", last_seen: 0 } })));
  await yieldToTheLoop();
  assert.ok(socket.bufferedAmount > 6 * megabytes);

  // Events of 64 KB, two at a time, of which the device reads three quarters: it takes the
  // conversation in, and falls behind on the events, never reading all that waits.
  let seq = 1;
  for (let round = 0; round < 1000 && socket.droppedWith === undefined; round += 1) {
    for (let event = 0; event < 2; event += 1) connection.sendEvent({ type: "message.delta", session_id: "s", seq: ++seq, payload: { text: "y".repeat(64 * kilobytes) } });
    socket.read(96 * kilobytes);
    assert.ok(socket.bufferedAmount > 0);
  }
  assert.ok(socket.droppedWith !== undefined, "the bridge dropped it");
  // Events alone by then, and no more than the bound and one more of them: the conversation it had read counts for nothing.
  assert.ok(socket.droppedWith > 8 * megabytes && socket.droppedWith < 8 * megabytes + 2 * 66 * kilobytes, `dropped with ${socket.droppedWith} bytes waiting`);
});
