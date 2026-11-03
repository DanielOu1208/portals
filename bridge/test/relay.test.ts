import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setLogLevel } from "../src/log.ts";
import { compose, Notifier } from "../src/push/notifier.ts";
import { Relay } from "../src/push/relay.ts";
import { PushStore, type DeviceEntry } from "../src/push/store.ts";
import { createThread, sessionCookie, startTestBridge, TestClient } from "./helpers.ts";

// Sending through the Portals relay (docs/pairing-and-relay.md), against a stand-in for
// it: never the deployed one.

setLogLevel("silent");

const TOKEN = "ab".repeat(32);
const DEVICE: DeviceEntry = { environment: "production", bundle_id: "com.danielou.portals", relay_token: "v1.claims.signature", updated_at: 1 };
const PAYLOAD = compose("finished", "t1", { agent: "karina", agent_name: "Karina", title: "Fix the build" }, "Done")!;

/** A stand-in for the relay: records each request and answers as told. */
class FakeRelay {
  readonly received: { url: string; headers: IncomingHttpHeaders; body: any }[] = [];
  answer: { status: number; body?: unknown } = { status: 200, body: { sent: true } };
  private readonly server: Server;

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<FakeRelay> {
    const server = createServer();
    const relay = new FakeRelay(server);
    server.on("request", (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        relay.received.push({ url: request.url ?? "", headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        response.writeHead(relay.answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(relay.answer.body ?? {}));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return relay;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

test("a notification goes to the relay with the device's relay token, and the relay's answer is the result", async (t) => {
  const relay = await FakeRelay.start();
  t.after(() => relay.close());
  const sender = new Relay({ url: relay.url, now: () => 1_000_000 });

  assert.equal(await sender.send(TOKEN, DEVICE, PAYLOAD, "t1-finished"), "sent");
  const [request] = relay.received;
  assert.equal(request.url, "/v1/notify");
  assert.equal(request.headers.authorization, "Bearer v1.claims.signature");
  assert.deepEqual(request.body, { payload: PAYLOAD, priority: 10, expiration: 1_003_600, collapse_id: "t1-finished" });
  // The device token itself never goes to the relay: the relay token names the device.
  assert.ok(!JSON.stringify(request).includes(TOKEN));

  relay.answer = { status: 410, body: { gone: true } };
  assert.equal(await sender.send(TOKEN, DEVICE, PAYLOAD), "gone");
  for (const status of [401, 429, 400, 502, 500]) {
    relay.answer = { status, body: { detail: "no" } };
    assert.equal(await sender.send(TOKEN, DEVICE, PAYLOAD), "failed", String(status));
  }
});

test("a device without a relay token is not sent to, and an unreachable relay fails that notification only", async (t) => {
  const relay = await FakeRelay.start();
  t.after(() => relay.close());
  const { relay_token: _, ...untokened } = DEVICE;
  assert.equal(await new Relay({ url: relay.url }).send(TOKEN, untokened, PAYLOAD), "failed");
  assert.equal(relay.received.length, 0);

  const closed = await FakeRelay.start();
  const address = closed.url;
  await closed.close();
  assert.equal(await new Relay({ url: address, timeoutMs: 2000 }).send(TOKEN, DEVICE, PAYLOAD), "failed");
});

test("a device the relay says is gone is forgotten", async (t) => {
  const relay = await FakeRelay.start();
  const directory = mkdtempSync(join(tmpdir(), "portals-relay-test-"));
  t.after(async () => {
    await relay.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const store = new PushStore(join(directory, "push.json"));
  store.register({ device: { token: TOKEN, environment: "production", bundle_id: "com.danielou.portals", relay_token: "v1.a.b" }, threads: [{ id: "t1", agent: "karina", agent_name: "Karina", title: "" }] });
  const notifier = new Notifier({ store, sender: new Relay({ url: relay.url }) });
  relay.answer = { status: 410, body: { gone: true } };
  assert.deepEqual(await notifier.handle({ kind: "finished", thread: "t1", text: "Done" }), ["gone"]);
  assert.deepEqual(store.state().devices, {});
});

test("a bridge with no APNs key notifies through the relay, sealed to the device's key", async (t) => {
  const relay = await FakeRelay.start();
  const bridge = await startTestBridge({ config: { apns: null, push: { relay: relay.url } } });
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
    await relay.close();
  });
  const cookie = await sessionCookie(bridge);
  const thread = await createThread(client);
  const key = Buffer.alloc(32, 7).toString("base64");
  const registered = await fetch(`${bridge.url}/api/plugins/aeriportal-push/registration`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      device: { token: TOKEN, environment: "sandbox", bundle_id: "com.danielou.portals", relay_token: "v1.x.y", key },
      host: "mbp16",
      threads: [{ id: thread, agent: "fake", agent_name: "Fake agent", title: "Try the relay" }],
    }),
  });
  assert.deepEqual(await registered.json(), { devices: 1, threads: 1, apns_configured: true });

  await client.call("prompt.submit", { session_id: thread, text: "hello", profile: "fake" });
  await client.next((frame) => frame.method === "event" && frame.params.type === "message.complete" && frame.params.session_id === thread);
  await bridge.close(); // waits for what is queued

  assert.equal(relay.received.length, 1);
  const [request] = relay.received;
  assert.equal(request.headers.authorization, "Bearer v1.x.y");
  assert.deepEqual(request.body.payload.aps.alert, { title: "Portals", body: "New activity" });
  assert.equal(request.body.payload.aeriportal.host, "mbp16");
  assert.equal(typeof request.body.payload.aeriportal.sealed, "string");
  assert.ok(!JSON.stringify(request.body).includes("Try the relay"));
});
