import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OpenCodeProvider } from "../src/providers/opencode/provider.ts";
import type { ProviderEvent } from "../src/providers/types.ts";
import { FakeOpenCode } from "./opencode-serve.ts";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function rig(t: { after(fn: () => Promise<void>): void }) {
  const folder = mkdtempSync(join(tmpdir(), "opencode-integration-"));
  const fake = await FakeOpenCode.start();
  const provider = new OpenCodeProvider({
    settings: { path: "/nonexistent/opencode", mode: "shared", start: false, folder, logPath: join(folder, "serve.log"), portals: { bin: join(folder, "bin"), instructions: "Use portals when asked." } },
    env: { PATH: "/usr/bin:/bin", HOME: folder, OPENCODE_PASSWORD: "scratch-transport", PORTALS_THREAD: "old-thread" },
    locate: async () => fake.endpoint(), backoff: [0.01],
  });
  t.after(async () => { await provider.close(); await fake.close(); rmSync(folder, { recursive: true, force: true }); });
  return { folder, fake, provider };
}

const settings = { model: "opencode/deepseek-v4.1-flash-free", provider: "opencode", reasoningEffort: "" };

test("a reconnected writable thread restores shell setup before its next prompt", async (t) => {
  const { folder, fake, provider } = await rig(t);
  const id = await provider.newThread({ cwd: folder, settings });
  const events: ProviderEvent[] = [];
  const session = await provider.startSession({ id, cwd: folder, settings }, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
  t.after(() => session.close());
  session.attached?.();
  const envCalls = () => fake.callsOf("PUT", new RegExp(`/session/${id}/environment$`));
  assert.equal(envCalls().length, 1);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.after(async () => { release(); });
  const original = fake.server.listeners("request")[0] as (...args: any[]) => void;
  fake.server.removeAllListeners("request");
  let preparing = false;
  fake.server.on("request", (req, res) => {
    if (req.method === "PUT" && req.url?.includes(`/session/${id}/environment`)) {
      preparing = true;
      void held.then(() => original(req, res));
    } else original(req, res);
  });
  fake.dropStreams();
  await until(() => preparing);
  fake.queueTurn(id, "plain");
  session.startTurn({ text: "A harmless recorded reply", images: [] });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fake.callsOf("POST", new RegExp(`/session/${id}/prompt$`)).length, 0);
  release();
  await until(() => events.some((event) => event.type === "turn.end"));
  assert.equal(envCalls().length, 2);
  const variables = envCalls()[1].body.variables;
  assert.equal(variables.PORTALS_THREAD, id);
  assert.ok(variables.PATH.startsWith(join(folder, "bin")));
  assert.equal(variables.OPENCODE_PASSWORD, undefined);
  const envIndex = fake.calls.indexOf(envCalls()[1]);
  assert.ok(fake.calls.findIndex((call) => call.method === "POST" && call.path.endsWith(`/session/${id}/prompt`)) > envIndex);
});

test("read-only adoption and reconnect never install shell environment or instructions", async (t) => {
  const { folder, fake, provider } = await rig(t);
  const id = "ses_read_only";
  fake.addSession({ id, location: { directory: folder } });
  const session = await provider.resumeSession({ id, cwd: folder, settings, readOnly: true }, { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
  t.after(() => session.close());
  fake.dropStreams();
  await until(() => fake.callsOf("GET", /^\/api\/info$/).length > 1);
  await session.history();
  assert.equal(fake.calls.filter((call) => call.path.includes("/environment") || call.path.includes("/instructions/")).length, 0);
});

test("OpenCode's version report uses the installed policy and the actual connected server", async (t) => {
  const { provider } = await rig(t);
  assert.equal(provider.version.policy.minimum, "2.2.0");
  assert.equal(provider.version.policy.tested, "2.2.5");
  provider.version.installedIs("1.18.35");
  assert.equal(provider.version.current()?.standing, "too old");
  await provider.models();
  assert.equal(provider.version.statusLine(), "Version: OpenCode 2.2.5");
  assert.equal(provider.version.current()?.running, true);
});

test("/mcp is a host command with folder-scoped native status and sign-in guidance", async (t) => {
  const { folder, fake, provider } = await rig(t);
  fake.mcp = [
    { name: "ready", status: { status: "connected" } },
    { name: "starting", status: { status: "pending" } },
    { name: "off", status: { status: "disabled" } },
    { name: "broken", status: { status: "failed", error: "Connection refused\nTry later" } },
    { name: "private", status: { status: "needs_auth", error: "Sign in" } },
  ];
  assert.ok(provider.executes.includes("mcp"));
  const command = (await provider.commands({ id: "ses_mcp", cwd: folder }, "mcp"))[0];
  const text = await command.execute!("");
  assert.match(text, /ready: connected/);
  assert.match(text, /starting: starting/);
  assert.match(text, /off: off/);
  assert.match(text, /broken: failed \(Connection refused Try later\)/);
  assert.match(text, /private: needs sign-in/);
  assert.match(text, /opencode auth login/);
  assert.ok(decodeURIComponent(fake.callsOf("GET", /^\/api\/mcp$/)[0].query.toString()).includes(folder));
  assert.equal(fake.callsOf("GET", /^\/api\/command$/).length, 0);
  const gone = (await provider.commands({ id: "ses_gone", cwd: join(folder, "gone") }, "mcp"))[0];
  await assert.rejects(gone.execute!(""), /thread's folder.*no longer there/);
  assert.equal(fake.callsOf("GET", /^\/api\/mcp$/).length, 1);
});

test("recent folders refresh without holding the picker and include native sandboxes", async (t) => {
  const { folder, fake, provider } = await rig(t);
  fake.projects = [{ id: "project", canonical: folder, sandboxes: [join(folder, "worktree")], time: { created: 1, updated: 2, active: 300 } }];
  assert.deepEqual(await provider.recentFolders(), []);
  await until(async () => (await provider.recentFolders()).length === 2);
  assert.deepEqual(await provider.recentFolders(), [{ path: folder, lastUsed: 300 }, { path: join(folder, "worktree"), lastUsed: 300 }]);
  assert.equal(fake.callsOf("GET", /^\/api\/project$/).length, 1);
});

test("deleted sessions still reconcile when their shell setup disappears after reconnect", async (t) => {
  const { folder, fake, provider } = await rig(t);
  const id = await provider.newThread({ cwd: folder, settings });
  const events: ProviderEvent[] = [];
  const session = await provider.startSession({ id, cwd: folder, settings }, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
  t.after(() => session.close());
  session.attached?.();
  fake.sessions.delete(id);
  fake.dropStreams();
  await until(() => events.some((event) => event.type === "notice" && /deleted in OpenCode/.test(event.text)));
  assert.ok(fake.callsOf("GET", new RegExp(`/session/${id}$`)).length >= 2);
});

test("stalled thread loads bound both frame count and bytes before a fresh snapshot", async (t) => {
  const { folder, fake, provider } = await rig(t);
  for (const large of [false, true]) {
    const id = large ? "ses_large_load" : "ses_busy_load";
    fake.addSession({ id, location: { directory: folder } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    t.after(async () => { release(); });
    let reading = false;
    const original = fake.server.listeners("request")[0] as (...args: any[]) => void;
    fake.server.removeAllListeners("request");
    fake.server.on("request", (req, res) => {
      if (req.url?.startsWith("/api/agent")) { reading = true; void held.then(() => original(req, res)); }
      else original(req, res);
    });
    const loading = provider.resumeSession({ id, cwd: folder, settings }, { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "unused" }) });
    await until(() => reading);
    const native = provider as unknown as { route(event: unknown): void; pendingLoads: Map<string, { frames: unknown[]; bytes: number; overflow: boolean }> };
    for (let n = 0; n < (large ? 2 : 1025); ++n) native.route({ id: `evt_${n}`, type: "session.text.delta", data: { sessionID: "ses_other", delta: large ? "x".repeat(600_000) : "x" } });
    assert.deepEqual(native.pendingLoads.get(id), { frames: [], bytes: 0, overflow: true });
    release();
    const session = await loading;
    session.attached?.();
    assert.equal(native.pendingLoads.has(id), false);
    await session.close();
    fake.server.removeAllListeners("request");
    fake.server.on("request", original);
  }
});
