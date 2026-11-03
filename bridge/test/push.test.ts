import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { sessionCookie, startTestBridge, TestClient, type TestBridge } from "./helpers.ts";

// The push routes keep registrations (docs/gateway-protocol.md, section 10). What is sent
// from them is in notifier.test.ts and apns.test.ts.

let bridge: TestBridge;
let cookie: string;

before(async () => {
  bridge = await startTestBridge();
  cookie = await sessionCookie(bridge);
});

after(() => bridge.dispose());

const token = "a1".repeat(32);
const device = { token, environment: "sandbox", bundle_id: "com.danielou.aeriportal" };

function push(method: string, path: string, body?: unknown, withCookie = true): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (withCookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${bridge.url}/api/plugins/aeriportal-push/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function stored(): { devices: Record<string, Record<string, unknown>>; threads: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(bridge.home, "state", "push.json"), "utf8"));
}

test("the push routes need a session", async () => {
  assert.equal((await push("GET", "status", undefined, false)).status, 401);
  assert.equal((await push("PUT", "registration", { device, threads: [] }, false)).status, 401);
});

test("a registration is stored, privately, with the host the app gave", async () => {
  const response = await push("PUT", "registration", {
    device,
    host: "mbp16",
    threads: [
      { id: "6f1c0a6e-1111-4c4c-9999-000000000001", agent: "fake", agent_name: "Fake agent", title: "First" },
      { id: "20261005_000000_abc123", agent: "fake" },
    ],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { devices: 1, threads: 2, apns_configured: false });

  const state = stored();
  assert.equal(statSync(join(bridge.home, "state", "push.json")).mode & 0o777, 0o600);
  assert.equal(state.devices[token].environment, "sandbox");
  assert.equal(state.devices[token].bundle_id, "com.danielou.aeriportal");
  assert.equal(state.devices[token].host, "mbp16");
  assert.deepEqual(state.threads["6f1c0a6e-1111-4c4c-9999-000000000001"].devices, [token]);
  assert.equal(state.threads["6f1c0a6e-1111-4c4c-9999-000000000001"].title, "First");
  // Missing names default as in the plugin.
  assert.equal(state.threads["20261005_000000_abc123"].agent_name, "fake");
  assert.equal(state.threads["20261005_000000_abc123"].title, "");
});

test("registering again only adds and updates", async () => {
  await push("PUT", "registration", { device: { ...device, environment: "production" }, threads: [{ id: "third", agent: "fake", title: "Third" }] });
  const state = stored();
  assert.equal(Object.keys(state.threads).length, 3);
  assert.equal(state.devices[token].environment, "production");
  // A registration without host leaves no host behind.
  assert.equal(state.devices[token].host, undefined);
});

test("a device's relay token and key are stored, and kept when a registration leaves them out", async () => {
  const key = Buffer.alloc(32, 9).toString("base64");
  await push("PUT", "registration", { device: { ...device, relay_token: "v1.claims.signature", key }, threads: [] });
  assert.equal(stored().devices[token].relay_token, "v1.claims.signature");
  assert.equal(stored().devices[token].key, key);
  // An app that could not reach the relay this time registers without a token.
  await push("PUT", "registration", { device: { ...device, environment: "production" }, threads: [] });
  assert.equal(stored().devices[token].relay_token, "v1.claims.signature");
  assert.equal(stored().devices[token].key, key);
  await push("PUT", "registration", { device: { ...device, environment: "production", relay_token: "v1.new.token" }, threads: [] });
  assert.equal(stored().devices[token].relay_token, "v1.new.token");
});

test("a device's muted kinds are stored sorted and once each, kept when a registration leaves them out, and an empty list mutes none", async () => {
  await push("PUT", "registration", { device: { ...device, muted: ["finished", "failed", "finished"] }, threads: [] });
  assert.deepEqual(stored().devices[token].muted, ["failed", "finished"]);
  // An app from before push_muting says nothing of it.
  await push("PUT", "registration", { device, threads: [] });
  assert.deepEqual(stored().devices[token].muted, ["failed", "finished"]);
  await push("PUT", "registration", { device: { ...device, muted: [] }, threads: [] });
  assert.equal(stored().devices[token].muted, undefined);
});

test("a thread is unwatched by its percent-encoded id", async () => {
  const response = await push("DELETE", `threads/${encodeURIComponent("20261005_000000_abc123")}`);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { threads: number }).threads, 2);
  assert.equal(stored().threads["20261005_000000_abc123"], undefined);
  // Feature push_watcher: the status says the route that stops notifying one device is here.
  assert.deepEqual(await (await push("GET", "status")).json(), { devices: 1, threads: 2, apns_configured: false, features: ["watcher"] });
  assert.equal((await push("DELETE", `threads/${encodeURIComponent("bad id/x")}`)).status, 422);
});

test("a registration with any bad field is refused whole, with 422", async () => {
  const before = JSON.stringify(stored());
  const bad: unknown[] = [
    { device: { ...device, token: "xyz" }, threads: [] },
    { device: { ...device, token: "ab" }, threads: [] },
    { device: { ...device, bundle_id: "com.example/evil" }, threads: [] },
    { device, threads: [{ id: "has space" }] },
    { device, threads: [{ id: "" }] },
    { device, threads: [{ id: "ok", title: 3 }] },
    { device, threads: "nope" },
    { device, threads: Array.from({ length: 2001 }, (_, index) => ({ id: `t${index}` })) },
    { device, threads: [], host: 12 },
    { device: { ...device, relay_token: 3 }, threads: [] },
    { device: { ...device, relay_token: "has space" }, threads: [] },
    { device: { ...device, relay_token: "x".repeat(1001) }, threads: [] },
    { device: { ...device, key: "short" }, threads: [] },
    { device: { ...device, key: Buffer.alloc(16).toString("base64") }, threads: [] },
    { device: { ...device, key: Buffer.alloc(32, 0xff).toString("base64url") + "=" }, threads: [] },
    { device: { ...device, muted: "finished" }, threads: [] },
    { device: { ...device, muted: ["finished", "everything"] }, threads: [] },
    { device: { ...device, muted: [3] }, threads: [] },
    "not an object",
  ];
  for (const body of bad) {
    const response = await push("PUT", "registration", body);
    assert.equal(response.status, 422, JSON.stringify(body).slice(0, 80));
    assert.equal(typeof ((await response.json()) as { detail: string }).detail, "string");
  }
  assert.equal(JSON.stringify(stored()), before);
});

test("threads registered without a device are kept with no watchers", async (t) => {
  const other = await startTestBridge();
  t.after(() => other.dispose());
  const response = await fetch(`${other.url}/api/plugins/aeriportal-push/registration`, {
    method: "PUT",
    headers: { Cookie: await sessionCookie(other), "Content-Type": "application/json" },
    body: JSON.stringify({ threads: [{ id: "lonely", agent: "fake" }] }),
  });
  assert.deepEqual(await response.json(), { devices: 0, threads: 1, apns_configured: false });
});

test("the routes say whether an APNs key is set up", async (t) => {
  const other = await startTestBridge({ config: { apns: { keyPath: "/nonexistent/AuthKey_TEST.p8", keyId: "TEST", teamId: "TEAM" } } });
  t.after(() => other.dispose());
  const response = await fetch(`${other.url}/api/plugins/aeriportal-push/status`, { headers: { Cookie: await sessionCookie(other) } });
  assert.deepEqual(await response.json(), { devices: 0, threads: 0, apns_configured: true, features: ["watcher"] });
});

test("other push paths are 404, as for a missing plugin", async () => {
  assert.equal((await push("POST", "registration", {})).status, 404);
  assert.equal((await push("GET", "devices")).status, 404);
});

test("a local unsubscribe removes only that device's watcher", async (t) => {
  const other = await startTestBridge();
  t.after(() => other.dispose());
  const url = `${other.url}/api/plugins/aeriportal-push/`;
  const headers = { Cookie: await sessionCookie(other), "Content-Type": "application/json" };
  const request = (method: string, path: string, body?: unknown) =>
    fetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const second = { ...device, token: "b2".repeat(32) };
  for (const entry of [device, second]) {
    assert.equal((await request("PUT", "registration", { device: entry, threads: [{ id: "shared:thread" }] })).status, 200);
  }
  const state = () => JSON.parse(readFileSync(join(other.home, "state", "push.json"), "utf8"));
  const path = `threads/${encodeURIComponent("shared:thread")}/watcher`;
  assert.equal((await fetch(url + path, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_token: token }) })).status, 401);
  for (const body of [undefined, {}, { device_token: "" }, { device_token: "not-hex" }, { device_token: 12 }]) {
    assert.equal((await request("DELETE", path, body)).status, 422);
    assert.deepEqual(state().threads["shared:thread"].devices, [token, second.token]);
  }
  assert.equal((await request("DELETE", path, { device_token: token })).status, 200);
  assert.deepEqual(state().threads["shared:thread"].devices, [second.token]);
  assert.equal(Object.keys(state().devices).length, 2);
  assert.equal((await request("DELETE", path, { device_token: token })).status, 200);
  assert.equal((await request("DELETE", "threads/unknown/watcher", { device_token: token })).status, 200);
  assert.equal((await request("DELETE", "threads/bad%20id/watcher", { device_token: token })).status, 422);
  assert.equal((await request("DELETE", path, { device_token: second.token })).status, 200);
  assert.equal(state().threads["shared:thread"], undefined, "the last watcher must not turn into a broadcast");
});

test("watcher is a legal thread id for both scoped and global unsubscribe", async (t) => {
  const other = await startTestBridge();
  t.after(() => other.dispose());
  const url = `${other.url}/api/plugins/aeriportal-push/`;
  const headers = { Cookie: await sessionCookie(other), "Content-Type": "application/json" };
  const second = { ...device, token: "b2".repeat(32) };
  for (const entry of [device, second]) {
    const response = await fetch(url + "registration", { method: "PUT", headers, body: JSON.stringify({ device: entry, threads: [{ id: "watcher" }] }) });
    assert.equal(response.status, 200);
  }
  const state = () => JSON.parse(readFileSync(join(other.home, "state", "push.json"), "utf8"));
  const scoped = await fetch(url + "threads/watcher/watcher", { method: "DELETE", headers, body: JSON.stringify({ device_token: token }) });
  assert.equal(scoped.status, 200);
  assert.deepEqual(state().threads.watcher.devices, [second.token]);
  assert.equal((await fetch(url + "threads/watcher", { method: "DELETE", headers })).status, 200);
  assert.equal(state().threads.watcher, undefined);
});

test("a member removed while its registration's body is on the way is refused, and nothing of it is kept", async (t) => {
  const other = await startTestBridge();
  const client = await TestClient.open(other);
  t.after(async () => {
    await client.close();
    await other.dispose();
  });
  const { code } = await client.call("net.invite");
  const joined = await fetch(`${other.url}/net/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, member: { id: "phone-push-0001", kind: "device", name: "iPhone", platform: "ios" } }),
  });
  const { token: memberToken } = (await joined.json()) as { token: string };

  // The headers, with the token, and half the body; the rest only once the device is removed.
  const body = JSON.stringify({ device, threads: [{ id: "late:thread" }] });
  const answered = new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${other.url}/api/plugins/aeriportal-push/registration`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${memberToken}` },
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.write(body.slice(0, 20));
    void sleep(100).then(async () => {
      await client.call("net.remove", { member: "phone-push-0001" });
      request.end(body.slice(20));
    });
  });
  assert.equal(await answered, 401);
  const path = join(other.home, "state", "push.json");
  const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { devices: {}, threads: {} };
  assert.equal(state.devices[token], undefined);
  assert.equal(state.threads["late:thread"], undefined);
});

test("a device token is kept in lower case, so one sent in upper case is the same device; a file with both cases keeps one (net-21)", async (t) => {
  const other = await startTestBridge();
  t.after(() => other.dispose());
  const url = `${other.url}/api/plugins/aeriportal-push/`;
  const headers = { Cookie: await sessionCookie(other), "Content-Type": "application/json" };
  const request = (method: string, path: string, body?: unknown) =>
    fetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const file = join(other.home, "state", "push.json");
  const state = () => JSON.parse(readFileSync(file, "utf8"));
  const lower = "c3".repeat(32) + "ab";
  const upper = lower.toUpperCase();
  assert.equal((await request("PUT", "registration", { device: { ...device, token: upper }, threads: [{ id: "case:thread" }] })).status, 200);
  assert.deepEqual(Object.keys(state().devices), [lower]);
  assert.deepEqual(state().threads["case:thread"].devices, [lower]);
  // The same device in lower case, then in upper case again: still one entry, one watcher.
  assert.equal((await request("PUT", "registration", { device: { ...device, token: lower, host: "mini" }, threads: [{ id: "case:thread" }] })).status, 200);
  assert.equal((await request("PUT", "registration", { device: { ...device, token: upper }, threads: [{ id: "case:thread" }, { id: "case:other" }] })).status, 200);
  assert.deepEqual(Object.keys(state().devices), [lower]);
  assert.deepEqual(state().threads["case:thread"].devices, [lower]);
  assert.deepEqual(state().threads["case:other"].devices, [lower]);
  // Its watcher goes whichever case the unsubscribe names it in.
  assert.equal((await request("DELETE", `threads/${encodeURIComponent("case:other")}/watcher`, { device_token: upper })).status, 200);
  assert.equal(state().threads["case:other"], undefined);

  // A file from before, with the device under both cases: the newer entry is kept, with
  // what only the older one had (its member, relay token and key), under the lower case.
  const older = { environment: "sandbox", bundle_id: "com.danielou.aeriportal", member: "phone-0001", relay_token: "v1.old", key: "a2V5", updated_at: 100 };
  const newer = { environment: "production", bundle_id: "com.danielou.aeriportal", host: "mini", updated_at: 200 };
  writeFileSync(file, JSON.stringify({
    devices: { [upper]: older, [lower]: newer },
    threads: { "two:cases": { agent: "fake", agent_name: "fake", title: "", devices: [upper, lower], updated_at: 1 } },
  }));
  assert.equal((await request("PUT", "registration", { threads: [{ id: "case:third" }] })).status, 200);
  assert.deepEqual(state().devices, { [lower]: { ...newer, member: "phone-0001", relay_token: "v1.old", key: "a2V5" } });
  assert.deepEqual(state().threads["two:cases"].devices, [lower]);
  assert.equal(((await (await request("GET", "status")).json()) as { devices: number }).devices, 1);
});
