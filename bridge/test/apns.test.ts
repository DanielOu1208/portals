import "./environment.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setLogLevel } from "../src/log.ts";
import { Apns, DryRun, providerToken, tokenLifetime } from "../src/push/apns.ts";
import { compose, Notifier } from "../src/push/notifier.ts";
import { PushStore, type DeviceEntry } from "../src/push/store.ts";

// Sending to Apple (docs/gateway-protocol.md, section 10), against a stand-in for APNs
// speaking HTTP/2 without TLS, with a key made here: never Dana's.

setLogLevel("silent");

const TOKEN = "ab".repeat(32);
const DEVICE: DeviceEntry = { environment: "sandbox", bundle_id: "com.danielou.aeriportal", updated_at: 1 };
const PAYLOAD = compose("finished", "t1", { agent: "karina", agent_name: "Karina", title: "Fix the build" }, "Done")!;

interface Received {
  headers: IncomingHttpHeaders;
  body: any;
}

/** A stand-in for one APNs server: records each request and answers as told. */
class FakeApple {
  readonly received: Received[] = [];
  answer: { status: number; reason?: string } = { status: 200 };
  private readonly server: Http2Server;

  private constructor(server: Http2Server) {
    this.server = server;
  }

  static async start(): Promise<FakeApple> {
    const server = createServer();
    const apple = new FakeApple(server);
    server.on("stream", (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        apple.received.push({ headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        const { status, reason } = apple.answer;
        stream.respond({ ":status": status, "apns-id": "00000000-0000-0000-0000-000000000000" });
        stream.end(reason ? JSON.stringify({ reason }) : undefined);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return apple;
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function setUp(t: { after(fn: () => void | Promise<void>): void }) {
  const directory = mkdtempSync(join(tmpdir(), "portals-apns-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyPath = join(directory, "AuthKey_KEY1234567.p8");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const clock = { now: 1_000_000 };
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, keyPath, publicKey, clock, config: { keyPath, keyId: "KEY1234567", teamId: "TEAM456789" } };
}

async function withApple(t: { after(fn: () => void | Promise<void>): void }) {
  const sandbox = await FakeApple.start();
  const production = await FakeApple.start();
  const base = setUp(t);
  const apns = new Apns({ config: base.config, now: () => base.clock.now, origins: { sandbox: sandbox.origin, production: production.origin }, timeoutMs: 2000 });
  t.after(async () => {
    apns.close();
    await sandbox.close();
    await production.close();
  });
  return { ...base, sandbox, production, apns };
}

function decode(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function checkToken(token: string, publicKey: KeyObject): { header: unknown; claims: unknown } {
  const [header, claims, signature] = token.split(".");
  const raw = Buffer.from(signature, "base64url");
  // ES256 as JWS wants it: r and s, 32 bytes each, not DER.
  assert.equal(raw.length, 64);
  assert.ok(verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, raw));
  return { header: decode(header), claims: decode(claims) };
}

test("a provider token is an ES256 JWT naming the key and the team, signed with the key", (t) => {
  const { publicKey, keyPath, config } = setUp(t);
  // The form Apple's .p8 files have.
  assert.ok(readFileSync(keyPath, "utf8").startsWith("-----BEGIN PRIVATE KEY-----"));
  const apns = new Apns({ config, now: () => 1_000_000.7 });
  const { header, claims } = checkToken(apns.providerToken(), publicKey);
  assert.deepEqual(header, { alg: "ES256", kid: "KEY1234567" });
  assert.deepEqual(claims, { iss: "TEAM456789", iat: 1_000_000 });
});

test("the provider token is reused for 50 minutes, then made again", (t) => {
  const { config, clock, publicKey } = setUp(t);
  const apns = new Apns({ config, now: () => clock.now });
  const first = apns.providerToken();
  clock.now += tokenLifetime - 1;
  assert.equal(apns.providerToken(), first);
  clock.now += 2;
  const second = apns.providerToken();
  assert.notEqual(second, first);
  assert.deepEqual(checkToken(second, publicKey).claims, { iss: "TEAM456789", iat: 1_000_000 + tokenLifetime + 1 });
});

test("a token signed with another key does not pass for this one", (t) => {
  const { publicKey } = setUp(t);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  assert.throws(() => checkToken(providerToken(privateKey, "KEY1234567", "TEAM456789", 1), publicKey));
});

test("a notification goes to Apple's sandbox with the headers APNs wants", async (t) => {
  const { apns, sandbox, production, clock, publicKey } = await withApple(t);
  assert.equal(await apns.send(TOKEN, DEVICE, PAYLOAD, "t1-finished"), "sent");
  assert.equal(production.received.length, 0);
  const [{ headers, body }] = sandbox.received;
  assert.equal(headers[":method"], "POST");
  assert.equal(headers[":path"], `/3/device/${TOKEN}`);
  assert.equal(headers["apns-topic"], "com.danielou.aeriportal");
  assert.equal(headers["apns-push-type"], "alert");
  assert.equal(headers["apns-priority"], "10");
  assert.equal(headers["apns-expiration"], String(clock.now + 3600));
  assert.equal(headers["apns-collapse-id"], "t1-finished");
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(body, PAYLOAD);
  const authorization = String(headers.authorization);
  assert.ok(authorization.startsWith("bearer "));
  assert.deepEqual(checkToken(authorization.slice("bearer ".length), publicKey).header, { alg: "ES256", kid: "KEY1234567" });

  // Another one goes over the same connection with the same token.
  assert.equal(await apns.send(TOKEN, DEVICE, PAYLOAD), "sent");
  assert.equal(sandbox.received[1].headers.authorization, authorization);
  assert.equal(sandbox.received[1].headers["apns-collapse-id"], undefined);
});

test("a production device goes to the production server", async (t) => {
  const { apns, sandbox, production } = await withApple(t);
  assert.equal(await apns.send(TOKEN, { ...DEVICE, environment: "production" }, PAYLOAD), "sent");
  assert.equal(production.received.length, 1);
  assert.equal(sandbox.received.length, 0);
});

test("Apple's answers are told apart, and a rejected provider token is made again", async (t) => {
  const { apns, sandbox, clock } = await withApple(t);
  const cases: [{ status: number; reason?: string }, string][] = [
    [{ status: 200 }, "sent"],
    [{ status: 410, reason: "Unregistered" }, "gone"],
    [{ status: 400, reason: "BadDeviceToken" }, "gone"],
    [{ status: 400, reason: "DeviceTokenNotForTopic" }, "gone"],
    [{ status: 413, reason: "PayloadTooLarge" }, "failed"],
    [{ status: 429, reason: "TooManyRequests" }, "failed"],
    [{ status: 403, reason: "ExpiredProviderToken" }, "failed"],
  ];
  for (const [answer, expected] of cases) {
    sandbox.answer = answer;
    assert.equal(await apns.send(TOKEN, DEVICE, PAYLOAD), expected, JSON.stringify(answer));
  }
  sandbox.answer = { status: 200 };
  clock.now += 1;
  await apns.send(TOKEN, DEVICE, PAYLOAD);
  const tokens = sandbox.received.map((received) => received.headers.authorization);
  assert.equal(new Set(tokens.slice(0, -1)).size, 1);
  assert.notEqual(tokens.at(-1), tokens[0]);
});

test("what is not a device token and a bundle id never reaches Apple", async (t) => {
  const { apns, sandbox } = await withApple(t);
  assert.equal(await apns.send(TOKEN, { ...DEVICE, bundle_id: "com.example/../x" }, PAYLOAD), "gone");
  assert.equal(await apns.send(`${TOKEN}/../x`, DEVICE, PAYLOAD), "gone");
  assert.equal(await apns.send(TOKEN, { environment: "sandbox" } as DeviceEntry, PAYLOAD), "gone");
  assert.equal(sandbox.received.length, 0);
  // A collapse id that is not a thread id is left out; a long one is cut to 64.
  await apns.send(TOKEN, DEVICE, PAYLOAD, "t1\nx: y");
  await apns.send(TOKEN, DEVICE, PAYLOAD, "x".repeat(80));
  assert.equal(sandbox.received[0].headers["apns-collapse-id"], undefined);
  assert.equal(sandbox.received[1].headers["apns-collapse-id"], "x".repeat(64));
});

test("without a readable key, or with Apple out of reach, a notification fails without an exception", async (t) => {
  const { config, keyPath, clock, sandbox } = await withApple(t);
  const unreadable = new Apns({ config: { ...config, keyPath: `${keyPath}.missing` }, now: () => clock.now, origins: { sandbox: sandbox.origin, production: sandbox.origin } });
  assert.equal(await unreadable.send(TOKEN, DEVICE, PAYLOAD), "failed");
  assert.equal(sandbox.received.length, 0);
  const unreachable = new Apns({ config, origins: { sandbox: "http://127.0.0.1:1", production: "http://127.0.0.1:1" }, timeoutMs: 2000 });
  t.after(() => unreachable.close());
  assert.equal(await unreachable.send(TOKEN, DEVICE, PAYLOAD), "failed");
});

test("a device Apple answers 410 for is dropped from the registrations", async (t) => {
  const { apns, sandbox, directory } = await withApple(t);
  const store = new PushStore(join(directory, "push.json"));
  store.register({ device: { token: TOKEN, environment: "sandbox", bundle_id: DEVICE.bundle_id }, threads: [{ id: "t1", agent: "karina", agent_name: "Karina", title: "Fix the build" }], host: "mbp16" });
  const notifier = new Notifier({ store, sender: apns });
  sandbox.answer = { status: 410, reason: "Unregistered" };
  notifier.turnEnded("t1", "complete", "Done");
  await notifier.idle();
  assert.equal(sandbox.received.length, 1);
  assert.equal(sandbox.received[0].body.aeriportal.host, "mbp16");
  assert.deepEqual(store.state().devices, {});
  // The thread stays registered, for a device that registers again.
  assert.ok(store.state().threads.t1);
});

test("a dry run writes each notification and where it would go to a private file", async (t) => {
  const { directory } = setUp(t);
  const path = join(directory, "push.jsonl");
  const dryRun = new DryRun(path);
  assert.equal(await dryRun.send(TOKEN, DEVICE, PAYLOAD, "t1-finished"), "sent");
  assert.equal(await dryRun.send(TOKEN, { ...DEVICE, environment: "production" }, PAYLOAD, "t1-finished"), "sent");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines[0], { device: "abababab", environment: "sandbox", topic: "com.danielou.aeriportal", collapse_id: "t1-finished", payload: PAYLOAD });
  assert.equal(lines[1].environment, "production");
  // Never the whole token.
  assert.ok(!readFileSync(path, "utf8").includes(TOKEN));
  assert.equal(await new DryRun(join(directory, "missing", "push.jsonl")).send(TOKEN, DEVICE, PAYLOAD), "failed");
});
