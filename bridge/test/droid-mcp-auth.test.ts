import "./environment.ts";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { authCode, DroidMcpAuth, safeAuthURL } from "../src/providers/droid/auth.ts";
import type { DroidHandle } from "../src/providers/droid/sdk.ts";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function rig(deadline?: number) {
  let changes = 0;
  const login = gate<{ success: boolean }>();
  const calls: unknown[] = [];
  const servers = [{ name: "test", requiresAuth: true, hasAuthTokens: false }];
  const handle = {
    listMcpServers: async () => ({ servers }),
    authenticateMcpServer: (params: unknown) => { calls.push(["start", params]); return login.promise; },
    submitMcpAuthCode: async (params: unknown) => { calls.push(["submit", params]); return { success: true }; },
    cancelMcpAuth: async (params: unknown) => { calls.push(["cancel", params]); return { success: true }; },
  } as unknown as DroidHandle;
  const auth = new DroidMcpAuth(() => { changes++; }, deadline);
  const notify = (state = "PRIVATE-state") => auth.notification({ type: "mcp_auth_required", serverName: "test",
    authUrl: "https://login.example.invalid/auth?state=public-state", state, message: "PRIVATE-message" }, handle);
  return { handle, auth, login, calls, servers, notify, changes: () => changes };
}

test("auth is explicit, ephemeral and out of the event payload; code and state stay on the host", async (t) => {
  const r = rig(); t.after(() => r.auth.close());
  r.notify();
  assert.equal(r.auth.list().servers[0].status, "required");
  assert.doesNotMatch(JSON.stringify(r.auth.list()), /https:|PRIVATE/);
  const started = await r.auth.run({ action: "start", server_name: "test" }, r.handle);
  assert.equal(started.servers[0].status, "starting");
  r.notify();
  const card = r.auth.list().servers[0];
  assert.equal(card.status, "waiting");
  assert.match(card.url!, /login\.example\.invalid/);
  assert.doesNotMatch(JSON.stringify(card), /PRIVATE/);
  await r.auth.run({ action: "submit", server_name: "test", auth_id: card.auth_id,
    code: "http://localhost:1234/callback?code=secret-code&state=public-state" }, r.handle);
  assert.deepEqual(r.calls[1], ["submit", { serverName: "test", code: "secret-code", state: "PRIVATE-state" }]);
  r.servers[0].requiresAuth = false; r.servers[0].hasAuthTokens = true;
  r.auth.notification({ type: "mcp_auth_completed", serverName: "test", outcome: "success", message: "PRIVATE" }, r.handle);
  r.login.resolve({ success: true });
  await sleep(0);
  assert.equal(r.auth.list().servers[0].status, "completed");
  assert.equal(r.auth.busy, false);
  assert.doesNotMatch(JSON.stringify(r.auth.list()), /https:|PRIVATE|secret-code/);
});

test("cancelled or expired attempts reject codes; an old authenticate result cannot settle a retry", async (t) => {
  const r = rig(20); t.after(() => r.auth.close());
  const { servers: [first] } = await r.auth.run({ action: "start", server_name: "test" }, r.handle);
  await r.auth.run({ action: "cancel", server_name: "test", auth_id: first.auth_id }, r.handle);
  const nextLogin = gate<{ success: boolean }>();
  r.handle.authenticateMcpServer = () => nextLogin.promise;
  await assert.rejects(r.auth.run({ action: "start", server_name: "test" }, r.handle), /still ending/);
  r.login.resolve({ success: true }); await sleep(0);
  const { servers: [second] } = await r.auth.run({ action: "start", server_name: "test" }, r.handle);
  r.auth.notification({ type: "mcp_auth_completed", serverName: "test", outcome: "success" }, r.handle);
  await sleep(0);
  assert.equal(r.auth.list().servers[0].status, "starting");
  await assert.rejects(r.auth.run({ action: "submit", server_name: "test", auth_id: first.auth_id, code: "code" }, r.handle), /ended/);
  await sleep(30);
  assert.equal(r.auth.list().servers[0].status, "cancelled");
  await assert.rejects(r.auth.run({ action: "submit", server_name: "test", auth_id: second.auth_id, code: "code" }, r.handle), /ended/);
});

test("unsafe auth URLs fail closed; process loss strips live credentials", async () => {
  const r = rig();
  await r.auth.run({ action: "start", server_name: "test" }, r.handle);
  r.auth.notification({ type: "mcp_auth_required", serverName: "test", authUrl: "file:///private", state: "private" }, r.handle);
  assert.equal(r.auth.list().servers[0].status, "failed");
  r.login.resolve({ success: false }); await sleep(0);
  r.handle.authenticateMcpServer = () => new Promise(() => undefined);
  await r.auth.run({ action: "start", server_name: "test" }, r.handle);
  r.notify(); r.auth.close();
  assert.equal(r.auth.list().servers[0].status, "cancelled");
  assert.doesNotMatch(JSON.stringify(r.auth.list()), /https:|private|PRIVATE/);
});

test("redirect and bare codes are validated without leaking them in errors", () => {
  assert.equal(authCode(" bare-code ", "state"), "bare-code");
  assert.equal(authCode("abc:def", "state"), "abc:def");
  assert.equal(authCode("portal:callback?code=abc%3Adef&state=state", "state"), "abc:def");
  assert.equal(authCode("http://localhost/cb?code=a%2Bb&state=state", "state"), "a+b");
  for (const value of ["https://site/cb", "https://site/?code=x&code=y", "https://site/?code=x&state=SECRET", "line\nSECRET"]) {
    assert.throws(() => authCode(value, "state"), (error: Error) => !error.message.includes("SECRET"));
  }
  for (const value of ["javascript:alert(1)", "http://host/path", "https://user:password@host", "https://host/#SECRET", "https://host/\nSECRET"]) {
    assert.equal(safeAuthURL(value), undefined);
  }
});

test("a rejected code cancels the underlying flow before retry, including success:false submissions", async (t) => {
  const r = rig(); t.after(() => r.auth.close());
  const cancellation = gate<{ success: boolean }>();
  r.handle.cancelMcpAuth = () => { r.calls.push(["cancel"]); return cancellation.promise; };
  r.handle.submitMcpAuthCode = async () => ({ success: false });
  await r.auth.run({ action: "start", server_name: "test" }, r.handle); r.notify();
  const submit = r.auth.run({ action: "submit", server_name: "test", auth_id: r.auth.list().servers[0].auth_id, code: "secret" }, r.handle);
  await sleep(0);
  assert.equal(r.auth.list().servers[0].status, "failed");
  assert.equal(r.auth.busy, true);
  assert.equal(r.calls.filter((call) => (call as string[])[0] === "cancel").length, 1);
  await assert.rejects(r.auth.run({ action: "start", server_name: "test" }, r.handle), /still ending/);
  cancellation.resolve({ success: true });
  await assert.rejects(submit, /did not accept/);
  await assert.rejects(r.auth.run({ action: "start", server_name: "test" }, r.handle), /still ending/);
  r.login.resolve({ success: false }); await sleep(0);
  await r.auth.run({ action: "start", server_name: "test" }, r.handle);
});

test("failed authentication cancels; failed cancellation requires a process restart, not an unsafe retry", async (t) => {
  const r = rig(); t.after(() => r.auth.close());
  r.handle.cancelMcpAuth = async () => ({ success: false });
  await r.auth.run({ action: "start", server_name: "test" }, r.handle);
  r.login.resolve({ success: false }); await sleep(0);
  await assert.rejects(r.auth.run({ action: "start", server_name: "test" }, r.handle), /Restart/);
  r.auth.close();
  r.handle.authenticateMcpServer = () => new Promise(() => undefined);
  await r.auth.run({ action: "start", server_name: "test" }, r.handle);
});

test("discovery reconciles external login, removal and renewed auth requirements without refresh loops", async (t) => {
  const r = rig(); t.after(() => r.auth.close());
  await r.auth.discover(r.handle);
  assert.equal(r.auth.list().servers[0].status, "required");
  Object.assign(r.servers[0], { requiresAuth: true, hasAuthTokens: true, status: "connected" });
  await r.auth.discover(r.handle);
  const completed = r.auth.list().servers[0];
  assert.equal(completed.status, "completed");
  await r.auth.discover(r.handle);
  assert.equal(r.auth.list().servers[0].status, "completed", "requiresAuth alone does not mean tokens expired");
  r.notify();
  assert.equal(r.auth.list().servers[0].status, "required");
  assert.notEqual(r.auth.list().servers[0].auth_id, completed.auth_id);
  assert.equal(r.auth.list().servers[0].url, undefined);
  await r.auth.discover(r.handle);
  assert.equal(r.auth.list().servers[0].status, "required", "stale token metadata cannot undo a genuine new auth-required event");
  Object.assign(r.servers[0], { requiresAuth: false, hasAuthTokens: false, status: "connected" });
  await r.auth.discover(r.handle, true);
  assert.deepEqual(r.auth.list(), { servers: [] });
  const changes = r.changes();
  await r.auth.discover(r.handle);
  assert.equal(r.changes(), changes, "an unchanged hidden card never emits another invalidation");
  r.servers.length = 0;
  await r.auth.discover(r.handle);
  assert.deepEqual(r.auth.list(), { servers: [] });
});

test("expired credentials restore a required card and removed active servers cancel without exposing their URL", async (t) => {
  const r = rig(); t.after(() => r.auth.close());
  await r.auth.run({ action: "start", server_name: "test" }, r.handle);
  r.login.resolve({ success: true }); await sleep(0);
  Object.assign(r.servers[0], { requiresAuth: true, hasAuthTokens: false, status: "failed" });
  await r.auth.discover(r.handle);
  assert.equal(r.auth.list().servers[0].status, "required");
  r.handle.authenticateMcpServer = () => new Promise(() => undefined);
  await r.auth.run({ action: "start", server_name: "test" }, r.handle); r.notify();
  r.servers.length = 0;
  await r.auth.discover(r.handle); await sleep(0);
  assert.deepEqual(r.auth.list(), { servers: [] });
  assert.ok(r.calls.some((call) => (call as string[])[0] === "cancel"));
});

test("discovery snapshots cannot overtake newer discovery, auth-required or explicit Start", async (t) => {
  const r = rig(); t.after(() => r.auth.close());
  await r.auth.discover(r.handle);
  const old = gate<Awaited<ReturnType<DroidHandle["listMcpServers"]>>>();
  const original = r.handle.listMcpServers;
  r.handle.listMcpServers = () => old.promise;
  const earlier = r.auth.discover(r.handle);
  r.handle.listMcpServers = original;
  await r.auth.discover(r.handle);
  old.resolve({ servers: [], summary: { total: 0, connected: 0, connecting: 0, failed: 0 } });
  await earlier;
  assert.equal(r.auth.list().servers[0].status, "required", "latest list wins");

  await r.auth.run({ action: "start", server_name: "test" }, r.handle);
  r.login.resolve({ success: true }); await sleep(0);
  const staleConnected = gate<Awaited<ReturnType<DroidHandle["listMcpServers"]>>>();
  r.handle.listMcpServers = () => staleConnected.promise;
  const statusLookup = r.auth.discover(r.handle, true);
  r.notify();
  staleConnected.resolve({ servers: [{ ...r.servers[0], status: "connected", hasAuthTokens: true }] as never, summary: { total: 1, connected: 1, connecting: 0, failed: 0 } });
  await statusLookup;
  assert.equal(r.auth.list().servers[0].status, "required", "stale connected tokens cannot erase a newer auth-required notification");

  const staleMissing = gate<Awaited<ReturnType<DroidHandle["listMcpServers"]>>>();
  r.handle.listMcpServers = () => staleMissing.promise;
  const missingLookup = r.auth.discover(r.handle);
  r.handle.listMcpServers = original;
  r.handle.authenticateMcpServer = () => new Promise(() => undefined);
  await r.auth.run({ action: "start", server_name: "test" }, r.handle); r.notify();
  staleMissing.resolve({ servers: [], summary: { total: 0, connected: 0, connecting: 0, failed: 0 } });
  await missingLookup;
  assert.equal(r.auth.list().servers[0].status, "waiting", "old missing-server metadata cannot cancel a new attempt");
});

test("auth-required protects existing required cards and revives hidden ones without exposing a URL", async (t) => {
  const r = rig(); t.after(() => r.auth.close());
  await r.auth.discover(r.handle);
  const id = r.auth.list().servers[0].auth_id;
  r.notify();
  Object.assign(r.servers[0], { hasAuthTokens: true, status: "connected" });
  await r.auth.discover(r.handle);
  assert.deepEqual(r.auth.list().servers, [{ auth_id: id, server_name: "test", status: "required" }]);

  Object.assign(r.servers[0], { requiresAuth: false, hasAuthTokens: false });
  await r.auth.discover(r.handle, true);
  assert.deepEqual(r.auth.list().servers, []);
  const changes = r.changes();
  r.notify();
  assert.equal(r.changes(), changes + 1);
  assert.deepEqual(r.auth.list().servers, [{ auth_id: id, server_name: "test", status: "required" }]);
});
