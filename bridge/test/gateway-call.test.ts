import "./environment.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type WebSocket from "ws";
import { callOnce } from "../src/gateway/call.ts";

test("an outbound gateway call skips non-object frames before and after its greeting", async () => {
  const socket = new EventEmitter();
  const sent: string[] = [];
  let ended = false;
  const connection = Object.assign(socket, {
    send: (text: string) => sent.push(text),
    terminate: () => { ended = true; },
  });
  const answer = callOnce(() => connection as unknown as WebSocket, "threads.list", { local: true }, 1000);
  // The failure path closes the call too, without leaving a pending timer or rejection.
  void answer.catch(() => undefined);
  try {
    const garbage = ["not JSON", "null", "false", "12", '"text"', "[]"];
    for (const text of garbage) assert.doesNotThrow(() => socket.emit("message", Buffer.from(text)));
    assert.equal(sent.length, 0);
    socket.emit("message", Buffer.from(JSON.stringify({ method: "event", params: { type: "gateway.ready" } })));
    assert.deepEqual(sent.map((text) => JSON.parse(text)), [
      { jsonrpc: "2.0", id: "c1", method: "threads.list", params: { local: true } },
    ]);
    for (const text of garbage) assert.doesNotThrow(() => socket.emit("message", Buffer.from(text)));
    socket.emit("message", Buffer.from(JSON.stringify({ id: "c1", result: { threads: [] } })));
    assert.deepEqual(await answer, { threads: [] });
    assert.equal(ended, true);
  } finally {
    socket.emit("close", 1006);
  }
});

for (const features of [undefined, [], ["fleet_delta"], ["fleet_delta", "fleet_delta_positions"]]) {
  test(`one RPC selects the fleet call from gateway.ready features ${JSON.stringify(features)}`, async () => {
    const socket = new EventEmitter();
    const sent: string[] = [];
    const connection = Object.assign(socket, { send: (text: string) => sent.push(text), terminate() {} });
    const answer = callOnce(() => connection as unknown as WebSocket, "threads.delta", { since: 1 }, 1000, undefined, undefined, {
      feature: "fleet_delta_positions", method: "threads.list", params: { local: true },
    });
    socket.emit("message", Buffer.from(JSON.stringify({ method: "event", params: { type: "gateway.ready", payload: { bridge: { features } } } })));
    const supported = features?.includes("fleet_delta_positions");
    assert.deepEqual(sent, [JSON.stringify({ jsonrpc: "2.0", id: "c1", method: supported ? "threads.delta" : "threads.list", params: supported ? { since: 1 } : { local: true } })]);
    socket.emit("message", Buffer.from(JSON.stringify({ id: "c1", result: { threads: [] } })));
    assert.deepEqual(await answer, { threads: [] });
  });
}

test("a gateway call's receiver makes its result from the answer and the method asked, once; what it throws rejects the call", async () => {
  for (const throws of [false, true]) {
    const socket = new EventEmitter();
    const sent: string[] = [];
    let ended = 0;
    const received: string[] = [];
    const connection = Object.assign(socket, { send: (text: string) => sent.push(text), terminate: () => { ended++; } });
    const answer = callOnce(() => connection as unknown as WebSocket, "threads.delta", {}, 8000, undefined, undefined, {
      feature: "fleet_delta_positions", method: "threads.list", params: { local: true },
    }, (result, method) => {
      received.push(method);
      if (throws) throw new Error("invalid");
      return { result: { took: result } };
    });
    const ready = Buffer.from(JSON.stringify({ method: "event", params: { type: "gateway.ready", payload: { bridge: { features: [] } } } }));
    socket.emit("message", ready);
    socket.emit("message", ready);
    assert.equal(sent.length, 1, "a second greeting asks nothing more");
    socket.emit("message", Buffer.from(JSON.stringify({ id: "c1", result: { threads: [] } })));
    socket.emit("message", Buffer.from(JSON.stringify({ id: "c1", result: { threads: [] } })));
    if (throws) await assert.rejects(answer, /invalid/);
    else assert.deepEqual(await answer, { took: { threads: [] } });
    assert.deepEqual(received, ["threads.list"]);
    assert.equal(ended, 1);
  }
});

test("gateway continuations share one socket and timer and ignore settled replies", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new EventEmitter();
  const sent: string[] = [];
  let ended = 0, received = 0;
  const connection = Object.assign(socket, { send: (text: string) => sent.push(text), terminate: () => { ended++; } });
  const answer = callOnce(() => connection as unknown as WebSocket, "threads.page", {}, 8000, undefined, undefined, undefined, () => {
    received++;
    return { call: { method: "threads.page", params: { offset: received } } };
  });
  void answer.catch(() => undefined);
  socket.emit("message", Buffer.from(JSON.stringify({ method: "event", params: { type: "gateway.ready" } })));
  for (let id = 1; id <= 2; id++) {
    t.mock.timers.tick(3000);
    socket.emit("message", Buffer.from(JSON.stringify({ id: `c${id}`, result: {} })));
  }
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((frame) => JSON.parse(frame).id), ["c1", "c2", "c3"]);
  t.mock.timers.tick(2000);
  await assert.rejects(answer, { message: "The bridge did not answer within 8 seconds." });
  socket.emit("message", Buffer.from(JSON.stringify({ id: "c3", result: {} })));
  assert.equal(received, 2);
  assert.equal(ended, 1);
});

test("a greeting observer sees paging support even if the full RPC times out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new EventEmitter();
  const sent: string[] = [], greetings: unknown[][] = [];
  const connection = Object.assign(socket, { send: (text: string) => sent.push(text), terminate() {} });
  const answer = callOnce(() => connection as unknown as WebSocket, "threads.delta", {}, 8000,
    undefined, undefined, undefined, undefined, (features) => { greetings.push(features); });
  void answer.catch(() => undefined);
  const greeting = Buffer.from(JSON.stringify({ method: "event", params: { type: "gateway.ready", payload: { bridge: { features: ["fleet_pages"] } } } }));
  socket.emit("message", greeting);
  socket.emit("message", greeting);
  assert.deepEqual(greetings, [["fleet_pages"]]);
  assert.deepEqual(sent, [JSON.stringify({ jsonrpc: "2.0", id: "c1", method: "threads.delta", params: {} })]);
  t.mock.timers.tick(8000);
  await assert.rejects(answer, { message: "The bridge did not answer within 8 seconds." });
});
