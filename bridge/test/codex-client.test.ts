import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CodexClient, CodexError, socketConnector, type Connector } from "../src/providers/codex/client.ts";
import { FakeDaemon } from "./codex-daemon.ts";
import "./helpers.ts";

// The JSON-RPC connection to Codex's app server, against the stand-in daemon: the
// handshake, ids as Codex sends them, and reconnecting after a drop.

let daemon: FakeDaemon;

before(async () => {
  daemon = await FakeDaemon.start();
});

after(async () => {
  await daemon.close();
});

function newClient(connect: Connector = socketConnector(daemon.socketPath)): CodexClient {
  return new CodexClient({ connect, clientInfo: { name: "portals-bridge", title: "Portals", version: "0.1.0" }, backoff: [0.02, 0.05] });
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("every connection starts with initialize and initialized, in frames without a jsonrpc key", async () => {
  const client = newClient();
  await client.start();
  try {
    const connection = daemon.connections.at(-1)!;
    await until(() => connection.received.length >= 2);
    assert.deepEqual(
      connection.received.map((message) => message.method),
      ["initialize", "initialized"],
    );
    assert.equal(connection.received.some((message) => "jsonrpc" in message), false);
    assert.deepEqual((await client.call("model/list", {})).data.length, 2);
    await assert.rejects(client.call("no/such/method", {}), (error: CodexError) => error instanceof CodexError && error.code === -32600);
  } finally {
    client.close();
  }
});

test("requests from Codex are answered by the id as given, string or number", async () => {
  const client = newClient();
  const asked: unknown[] = [];
  client.listen({
    notification() {},
    request(id, method) {
      asked.push(id);
      if (method === "ping") client.respond(id, { pong: true });
      else client.respondError(id, -32601, "no");
    },
    connected() {},
    disconnected() {},
  });
  await client.start();
  try {
    const connection = daemon.connections.at(-1)!;
    connection.send({ id: "srv-1", method: "ping", params: {} });
    connection.send({ id: 7, method: "other", params: {} });
    await until(() => connection.received.filter((message) => message.method === undefined).length === 2);
    assert.deepEqual(asked, ["srv-1", 7]);
    assert.deepEqual(connection.received.slice(-2), [
      { id: "srv-1", result: { pong: true } },
      { id: 7, error: { code: -32601, message: "no" } },
    ]);
  } finally {
    client.close();
  }
});

test("after a drop it connects again with growing pauses, says so, and calls that were waiting fail", async () => {
  const client = newClient();
  const seen: string[] = [];
  client.listen({ notification() {}, request() {}, connected: (again) => seen.push(again ? "again" : "first"), disconnected: () => seen.push("dropped") });
  await client.start();
  try {
    daemon.accepting = false;
    const waiting = client.call("turn/start", { threadId: "nope" }).catch((error: Error) => error);
    daemon.dropAll();
    assert.ok((await waiting) instanceof Error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(client.isConnected, false);
    daemon.accepting = true;
    await until(() => client.isConnected);
    assert.deepEqual(seen, ["first", "dropped", "again"]);
    assert.equal((await client.call("model/list", {})).data.length, 2);
  } finally {
    client.close();
  }
});

test("a call waits for a connection a while, then fails with a sentence", async () => {
  const client = newClient(async () => {
    throw new Error("no socket");
  });
  void client.start();
  try {
    await assert.rejects(client.whenReady(60), /Codex is not reachable right now\./);
  } finally {
    client.close();
  }
  await assert.rejects(client.call("model/list", {}), /closed/);
});
