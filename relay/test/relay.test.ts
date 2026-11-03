import assert from "node:assert/strict";
import { generateKeyPairSync, verify as verifySignature, type KeyObject } from "node:crypto";
import { test } from "node:test";
import { Apns, ProviderTokens, tokenWindow, type Transport } from "../src/apns.ts";
import { makeRelay, payloadLimit, type Limiter } from "../src/relay.ts";
import { issue, tokenKey, verify } from "../src/tokens.ts";

// The relay's routes (docs/pairing-and-relay.md) against a stand-in for Apple, with a key
// made here: never Dana's.

const DEVICE_TOKEN = "ab".repeat(32);
const BUNDLE = "com.danielou.portals";
const SECRET = "test-secret-one";
const NOW = 1_800_000_123;

function makeKey(): { pem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string, publicKey };
}

const KEY = makeKey();

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Apple, as a transport: records each request and answers as told. */
function fakeApple(answer: { status: number; reason?: string } = { status: 200 }) {
  const sent: Sent[] = [];
  const state = { answer, fail: false };
  const transport: Transport = async (url, headers, body) => {
    if (state.fail) throw new Error("offline");
    sent.push({ url, headers, body });
    return { status: state.answer.status, body: state.answer.reason ? JSON.stringify({ reason: state.answer.reason }) : "" };
  };
  return { sent, state, transport };
}

function relay(options: { transport?: Transport; deviceLimit?: Limiter; notifyLimit?: Limiter; logged?: string[]; now?: () => number } = {}) {
  const apple = fakeApple();
  const logged = options.logged ?? [];
  const handle = makeRelay({
    secrets: [SECRET, "test-secret-old"],
    bundleIDs: [BUNDLE],
    apple: new Apns({ key: { pem: KEY.pem, keyId: "KEY1234567", teamId: "TEAM123456" }, transport: options.transport ?? apple.transport }),
    deviceLimit: options.deviceLimit,
    notifyLimit: options.notifyLimit,
    now: options.now ?? (() => NOW),
    log: (line) => logged.push(line),
  });
  return { handle, apple, logged };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://relay.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function register(handle: (request: Request) => Promise<Response>, environment = "sandbox"): Promise<string> {
  const response = await handle(post("/v1/devices", { token: DEVICE_TOKEN, environment, bundle_id: BUNDLE }));
  assert.equal(response.status, 200);
  return ((await response.json()) as { relay_token: string }).relay_token;
}

const PAYLOAD = { aps: { alert: { title: "Portals", body: "New activity" }, "mutable-content": 1 }, aeriportal: { thread: "t1", kind: "finished" } };

// MARK: Relay tokens

test("a relay token names its device, and only the relay's secrets verify it", async () => {
  const token = await issue({ token: DEVICE_TOKEN, environment: "production", bundleID: BUNDLE }, SECRET, NOW);
  assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(await verify(token, [SECRET]), { token: DEVICE_TOKEN, environment: "production", bundleID: BUNDLE });
  // A changed secret still takes the tokens signed with the one before it.
  assert.ok(await verify(token, ["new-secret", SECRET]));
  assert.equal(await verify(token, ["another-secret"]), null);

  const [version, claims, signature] = token.split(".");
  const otherDevice = Buffer.from(JSON.stringify({ t: "cd".repeat(32), e: "production", b: BUNDLE, i: NOW })).toString("base64url");
  assert.equal(await verify(`${version}.${otherDevice}.${signature}`, [SECRET]), null, "claims swapped under a valid signature");
  assert.equal(await verify(`v2.${claims}.${signature}`, [SECRET]), null);
  assert.equal(await verify(`${version}.${claims}`, [SECRET]), null);
  assert.equal(await verify("not a token", [SECRET]), null);
});

// MARK: Registering a device

test("the app gets a relay token for its device", async () => {
  const { handle } = relay();
  const token = await register(handle, "production");
  assert.deepEqual(await verify(token, [SECRET]), { token: DEVICE_TOKEN, environment: "production", bundleID: BUNDLE });
});

test("a registration that is not a Portals device is turned away", async () => {
  const { handle } = relay();
  const cases: [unknown, number][] = [
    ["not json", 400],
    [[], 400],
    [{ token: "xyz", environment: "sandbox", bundle_id: BUNDLE }, 400],
    [{ token: DEVICE_TOKEN, environment: "staging", bundle_id: BUNDLE }, 400],
    [{ token: DEVICE_TOKEN, environment: "sandbox", bundle_id: "has spaces" }, 400],
    [{ token: DEVICE_TOKEN, environment: "sandbox", bundle_id: "com.example.other" }, 403],
  ];
  for (const [body, status] of cases) {
    const response = await handle(post("/v1/devices", body));
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal(typeof ((await response.json()) as { detail: unknown }).detail, "string");
  }
  assert.equal((await handle(new Request("https://relay.example/v1/devices"))).status, 405);
  assert.equal((await handle(new Request("https://relay.example/v2/devices", { method: "POST" }))).status, 404);
});

test("registrations are limited per address", async () => {
  const keys: string[] = [];
  const { handle } = relay({ deviceLimit: { limit: async ({ key }) => (keys.push(key), { success: keys.length <= 1 }) } });
  const body = { token: DEVICE_TOKEN, environment: "sandbox", bundle_id: BUNDLE };
  assert.equal((await handle(post("/v1/devices", body, { "cf-connecting-ip": "203.0.113.9" }))).status, 200);
  const second = await handle(post("/v1/devices", body, { "cf-connecting-ip": "203.0.113.9" }));
  assert.equal(second.status, 429);
  assert.equal(second.headers.get("retry-after"), "60");
  assert.deepEqual(keys, ["203.0.113.9", "203.0.113.9"]);
});

// MARK: Notifying

test("a notification goes to the device's server with the bridge's payload and a signed provider token", async () => {
  const { handle, apple } = relay();
  const token = await register(handle);
  const response = await handle(post("/v1/notify", { payload: PAYLOAD, collapse_id: "t1-finished" }, { authorization: `Bearer ${token}` }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sent: true });

  assert.equal(apple.sent.length, 1);
  const [sent] = apple.sent;
  assert.equal(sent.url, `https://api.sandbox.push.apple.com/3/device/${DEVICE_TOKEN}`);
  assert.deepEqual(JSON.parse(sent.body), PAYLOAD);
  assert.equal(sent.headers["apns-topic"], BUNDLE);
  assert.equal(sent.headers["apns-push-type"], "alert");
  assert.equal(sent.headers["apns-priority"], "10");
  assert.equal(sent.headers["apns-expiration"], String(NOW + 3600));
  assert.equal(sent.headers["apns-collapse-id"], "t1-finished");

  const [header, claims, signature] = sent.headers.authorization.replace(/^bearer /, "").split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: "KEY1234567" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), { iss: "TEAM123456", iat: Math.floor(NOW / tokenWindow) * tokenWindow });
  assert.ok(verifySignature("sha256", Buffer.from(`${header}.${claims}`), { key: KEY.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
});

test("a production device goes to Apple's production server, with the bridge's priority and expiry", async () => {
  const { handle, apple } = relay();
  const token = await register(handle, "production");
  await handle(post("/v1/notify", { payload: PAYLOAD, priority: 5, expiration: 0 }, { authorization: `Bearer ${token}` }));
  assert.equal(apple.sent[0].url, `https://api.push.apple.com/3/device/${DEVICE_TOKEN}`);
  assert.equal(apple.sent[0].headers["apns-priority"], "5");
  assert.equal(apple.sent[0].headers["apns-expiration"], "0");
  assert.equal(apple.sent[0].headers["apns-collapse-id"], undefined);
});

test("only tokens the relay issued may send", async () => {
  const { handle, apple } = relay();
  const forged = await issue({ token: DEVICE_TOKEN, environment: "sandbox", bundleID: BUNDLE }, "someone-elses-secret", NOW);
  const otherApp = await issue({ token: DEVICE_TOKEN, environment: "sandbox", bundleID: "com.example.other" }, SECRET, NOW);
  for (const authorization of [undefined, "Bearer", `Bearer ${forged}`, `Bearer ${otherApp}`, `Basic ${forged}`]) {
    const response = await handle(post("/v1/notify", { payload: PAYLOAD }, authorization ? { authorization } : {}));
    assert.equal(response.status, 401, String(authorization));
  }
  assert.equal(apple.sent.length, 0);
});

test("a notification Apple would refuse is turned away first", async () => {
  const { handle, apple } = relay();
  const authorization = `Bearer ${await register(handle)}`;
  const big = { aps: { alert: { title: "x", body: "y".repeat(payloadLimit) } } };
  const cases: unknown[] = [
    "not json",
    { payload: "text" },
    { payload: { alert: "no aps" } },
    { payload: big },
    { payload: PAYLOAD, priority: 7 },
    { payload: PAYLOAD, collapse_id: "x".repeat(65) },
    { payload: PAYLOAD, collapse_id: "" },
    { payload: PAYLOAD, expiration: -1 },
    { payload: PAYLOAD, expiration: 1.5 },
  ];
  for (const body of cases) {
    assert.equal((await handle(post("/v1/notify", body, { authorization }))).status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(apple.sent.length, 0);
});

test("what Apple answers reaches the bridge: gone, too many, or failed", async () => {
  const { handle, apple, logged } = relay();
  const token = await register(handle);
  const send = () => handle(post("/v1/notify", { payload: PAYLOAD }, { authorization: `Bearer ${token}` }));

  apple.state.answer = { status: 410, reason: "Unregistered" };
  let response = await send();
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), { gone: true });

  apple.state.answer = { status: 400, reason: "BadDeviceToken" };
  assert.equal((await send()).status, 410);

  apple.state.answer = { status: 429, reason: "TooManyRequests" };
  response = await send();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");

  apple.state.answer = { status: 500, reason: "InternalServerError" };
  response = await send();
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { sent: false, reason: "InternalServerError" });

  apple.state.fail = true;
  response = await send();
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { sent: false, reason: "Unreachable" });

  // What was decided, never a token or the words.
  const all = logged.join("\n");
  assert.ok(logged.length > 0);
  assert.ok(!all.includes(DEVICE_TOKEN) && !all.includes(token) && !all.includes("New activity"), all);
});

test("notifications are limited per relay token", async () => {
  // As the Workers binding counts: per key, a few allowed, then refused.
  const counts = new Map<string, number>();
  const notifyLimit: Limiter = {
    limit: async ({ key }) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key)! <= 2 };
    },
  };
  const { handle, apple } = relay({ notifyLimit });
  const authorization = `Bearer ${await register(handle)}`;
  const statuses: number[] = [];
  for (let index = 0; index < 3; index++) statuses.push((await handle(post("/v1/notify", { payload: PAYLOAD }, { authorization }))).status);
  assert.deepEqual(statuses, [200, 200, 429]);
  assert.equal(apple.sent.length, 2);
});

test("equivalent signature encodings share the authenticated token's quota", async () => {
  const counts = new Map<string, number>();
  const { handle, apple } = relay({
    notifyLimit: {
      limit: async ({ key }) => {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return { success: count <= 2 };
      },
    },
  });
  const token = await register(handle);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const final = alphabet.indexOf(token.at(-1)!);
  const spellings = Array.from({ length: 4 }, (_, index) => token.slice(0, -1) + alphabet[(final & ~3) + index]);
  for (const spelling of spellings) {
    assert.deepEqual(await verify(spelling, [SECRET]), await verify(token, [SECRET]));
    assert.equal(tokenKey(spelling), tokenKey(token));
  }
  const statuses = [];
  for (const spelling of spellings) {
    statuses.push((await handle(post("/v1/notify", { payload: PAYLOAD }, { authorization: `Bearer ${spelling}` }))).status);
  }
  assert.deepEqual(statuses, [200, 200, 429, 429]);
  assert.equal(counts.size, 1);
  assert.equal(apple.sent.length, 2);
});

function streamed(path: string, bytes: Uint8Array, headers: Record<string, string> = {}, chunkSize = 1024) {
  let bytesRead = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (bytesRead === bytes.length) {
        controller.close();
        return;
      }
      const chunk = bytes.subarray(bytesRead, bytesRead + chunkSize);
      bytesRead += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body, duplex: "half" };
  return {
    request: new Request(`https://relay.example${path}`, init),
    bytesRead: () => bytesRead,
    cancelled: () => cancelled,
  };
}

test("streamed bodies stop at the byte cap, even without an honest content length", async () => {
  const { handle, apple } = relay();
  const authorization = `Bearer ${await issue({ token: DEVICE_TOKEN, environment: "sandbox", bundleID: BUNDLE }, SECRET, NOW)}`;
  for (const path of ["/v1/devices", "/v1/notify"]) {
    for (const length of [undefined, "1"]) {
      const headers: Record<string, string> = { authorization };
      if (length) headers["content-length"] = length;
      const stream = streamed(path, new Uint8Array(64 * 1024).fill(32), headers);
      assert.equal((await handle(stream.request)).status, 400);
      assert.equal(stream.cancelled(), true);
      assert.ok(stream.bytesRead() <= 8192 + 1024, `${stream.bytesRead()} bytes read`);
      assert.equal(stream.request.body!.locked, false);
    }
  }
  assert.equal(apple.sent.length, 0);
});

test("the body cap counts UTF-8 bytes, accepts its exact boundary, and cancels declared oversize", async () => {
  const { handle } = relay();
  const base = { token: DEVICE_TOKEN, environment: "sandbox", bundle_id: BUNDLE, padding: "" };
  const exact = { ...base, padding: "x".repeat(8192 - Buffer.byteLength(JSON.stringify(base))) };
  const exactStream = streamed("/v1/devices", Buffer.from(JSON.stringify(exact)));
  assert.equal((await handle(exactStream.request)).status, 200);
  assert.equal(exactStream.bytesRead(), 8192);
  assert.equal(exactStream.cancelled(), false);

  const unicode = JSON.stringify({ ...base, padding: "😀".repeat(2100) });
  assert.ok(unicode.length < 8192 && Buffer.byteLength(unicode) > 8192);
  const over = streamed("/v1/devices", Buffer.from(unicode));
  assert.equal((await handle(over.request)).status, 400);
  assert.equal(over.cancelled(), true);
  const split = streamed("/v1/devices", Buffer.from(JSON.stringify({ ...base, padding: "é😀" })), {}, 1);
  assert.equal((await handle(split.request)).status, 200, "UTF-8 can span chunks");

  const declared = streamed("/v1/devices", Buffer.from(JSON.stringify(base)), { "content-length": "8193" });
  assert.equal((await handle(declared.request)).status, 400);
  assert.equal(declared.bytesRead(), 0);
  assert.equal(declared.cancelled(), true);
});

test("health says the relay is up", async () => {
  const { handle } = relay();
  const response = await handle(new Request("https://relay.example/v1/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: "portals-relay" });
});

// MARK: Provider tokens

test("a provider token is kept for its half hour, and made again after it or when Apple refuses it", async () => {
  const tokens = new ProviderTokens({ pem: KEY.pem, keyId: "KEY1234567", teamId: "TEAM123456" });
  const start = Math.floor(NOW / tokenWindow) * tokenWindow;
  const first = await tokens.current(start + 1);
  assert.equal(await tokens.current(start + tokenWindow - 1), first);
  const next = await tokens.current(start + tokenWindow);
  assert.notEqual(next, first);
  assert.equal(JSON.parse(Buffer.from(next.split(".")[1], "base64url").toString()).iat, start + tokenWindow);
  tokens.reset();
  assert.notEqual(await tokens.current(start + tokenWindow), next, "ECDSA signs afresh each time");

  await assert.rejects(new ProviderTokens({ pem: "not a key", keyId: "K", teamId: "T" }).current(NOW));
});

test("Apple refusing the provider token makes a new one for the next notification", async () => {
  const apple = fakeApple({ status: 403, reason: "InvalidProviderToken" });
  const { handle } = relay({ transport: apple.transport });
  const authorization = `Bearer ${await register(handle)}`;
  assert.equal((await handle(post("/v1/notify", { payload: PAYLOAD }, { authorization }))).status, 502);
  apple.state.answer = { status: 200 };
  assert.equal((await handle(post("/v1/notify", { payload: PAYLOAD }, { authorization }))).status, 200);
  // Same half hour, but signed again: ECDSA never signs the same way twice.
  assert.notEqual(apple.sent[0].headers.authorization, apple.sent[1].headers.authorization);
});
