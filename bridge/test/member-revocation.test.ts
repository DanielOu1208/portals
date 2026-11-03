import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Connection } from "../src/gateway/connection.ts";
import type { GatewayContext } from "../src/gateway/methods.ts";
import { startTestBridge, TestClient } from "./helpers.ts";

test("a member cannot make another change from a frame behind the one that removes it", async (t) => {
  const bridge = await startTestBridge();
  t.after(() => bridge.dispose());
  const owner = await TestClient.open(bridge);
  t.after(() => owner.close());
  const ids = ["phone-revoke-0001", "phone-revoke-0002"];
  let token = "";
  for (const id of ids) {
    const { code } = await owner.call("net.invite");
    const response = await fetch(`${bridge.url}/net/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, member: { id, kind: "device", name: id, platform: "ios" } }),
    });
    assert.equal(response.status, 200);
    const joined = (await response.json()) as { token: string };
    if (id === ids[0]) token = joined.token;
  }
  const member = await TestClient.open(bridge, { token });
  t.after(() => member.close());
  // Both frames are sent before the client hears the close: the second is already
  // on its way when the first removes this device and starts the closing handshake.
  member.socket.send(JSON.stringify({ jsonrpc: "2.0", id: "self", method: "net.remove", params: { member: ids[0] } }));
  member.socket.send(JSON.stringify({ jsonrpc: "2.0", id: "other", method: "net.remove", params: { member: ids[1] } }));
  assert.equal(await member.closed, 4401);
  const listed = await owner.call("net.list");
  assert.equal(listed.members.find((entry: { id: string }) => entry.id === ids[0]).removed, true);
  assert.equal(listed.members.find((entry: { id: string }) => entry.id === ids[1]).removed, undefined);
});

test("closing a revoked connection cancels its waits before the closing handshake finishes", () => {
  const socket = Object.assign(new EventEmitter(), {
    OPEN: 1, readyState: 1, bufferedAmount: 0,
    send() {},
    close() { this.readyState = 2; },
    ping() {},
    terminate() {},
  });
  let waiting: AbortSignal | undefined;
  const gateway = {
    machine: "test-machine",
    net: { revision: () => ({ id: "test-net", revision: 1 }) },
    fleet: { wait: (_thread: string, _timeout: number, signal: AbortSignal) => {
      waiting = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } },
  } as unknown as GatewayContext;
  const connection = new Connection(socket, gateway, { replayEpoch: "test" }, { kind: "member", id: "phone-revoke-0001", member: "device", removed: false });
  socket.emit("message", Buffer.from(JSON.stringify({ id: "wait", method: "thread.wait", params: { thread: "test" } })), false);
  assert.equal(waiting?.aborted, false);
  connection.close(4401, "This device was removed from the net.");
  assert.equal(waiting?.aborted, true);
});
