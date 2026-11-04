import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { endGroup } from "../src/providers/child.ts";
import { OpenCodeProvider } from "../src/providers/opencode/provider.ts";
import { ServerLocator, type Endpoint, type ServerOptions } from "../src/providers/opencode/server.ts";
import { TestClient, startTestBridge } from "./helpers.ts";
import { FakeOpenCode } from "./opencode-serve.ts";

// Which OpenCode server the bridge talks to: OpenCode's background service, found from
// its registration, in shared mode; else, or in own mode, an `opencode serve` of the
// bridge's own (test/opencode-standin.ts), with a password only the bridge knows.

const standin = fileURLToPath(new URL("./opencode-standin.ts", import.meta.url));
const owner = fileURLToPath(new URL("./opencode-server-owner.ts", import.meta.url));

let folder: string;
let program: string;
let service: FakeOpenCode;

before(async () => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), "portals-opencode-server-")));
  program = join(folder, "opencode");
  writeFileSync(program, `#!/bin/sh\nexec "${process.execPath}" "${standin}" "$@"\n`);
  chmodSync(program, 0o755);
  service = await FakeOpenCode.start({ password: "service-password" });
});

after(async () => {
  await service.close();
  rmSync(folder, { recursive: true, force: true });
});

function locator(options: Partial<ServerOptions> & { args?: string; fail?: boolean } = {}): ServerLocator {
  const { args, fail, ...rest } = options;
  return new ServerLocator({
    path: program,
    mode: "shared",
    start: false,
    cwd: folder,
    logPath: join(folder, "opencode-serve.log"),
    registration: join(folder, "none.json"),
    startTimeoutMs: 10_000,
    env: { ...process.env, ...(args ? { OPENCODE_STANDIN_ARGS: args } : {}), ...(fail ? { OPENCODE_STANDIN_FAIL: "1" } : {}) },
    ...rest,
  });
}

function register(file: string, info: Record<string, unknown> = {}): string {
  writeFileSync(file, JSON.stringify({ id: "svc_test", version: "2.2.5", url: service.url, pid: process.pid, password: "service-password", ...info }));
  return file;
}

test("in shared mode the bridge joins OpenCode's background service, signed in with the password it registered", async () => {
  const servers = locator({ registration: register(join(folder, "service.json")) });
  try {
    const endpoint = await servers.locate();
    assert.deepEqual(endpoint, { url: service.url, headers: { authorization: `Basic ${Buffer.from("opencode:service-password").toString("base64")}` }, own: false, pid: process.pid, serverIdentity: `${process.pid}:2.2.5` });
  } finally {
    await servers.close();
  }
});

test("with no background service to join, the bridge runs an opencode serve of its own on a loopback port, with a password of its own", async () => {
  const args = join(folder, "own-args.json");
  const servers = locator({ args });
  try {
    const endpoint = await servers.locate();
    assert.equal(endpoint.own, true);
    assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const started = JSON.parse(readFileSync(args, "utf8"));
    assert.deepEqual(started.args, ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    assert.equal(started.cwd, folder);
    assert.ok(started.password.length >= 24);
    assert.equal(endpoint.headers.authorization, `Basic ${Buffer.from(`opencode:${started.password}`).toString("base64")}`);
    // Only with it.
    assert.equal((await fetch(`${endpoint.url}/api/info`)).status, 401);
    assert.equal((await fetch(`${endpoint.url}/api/info`, { headers: endpoint.headers })).status, 200);
    // Asked again, it is the same server.
    assert.deepEqual(await servers.locate(), endpoint);
    await servers.close();
    // Stopped with the bridge.
    const deadline = Date.now() + 5000;
    while (await fetch(`${endpoint.url}/api/info`, { headers: endpoint.headers }).then(() => true, () => false)) {
      if (Date.now() > deadline) throw new Error("the bridge's own server is still running");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await servers.close();
  }
});

test("in own mode the bridge runs its own server even when a background service runs", async () => {
  const servers = locator({ mode: "own", registration: register(join(folder, "service-own.json")) });
  try {
    const endpoint = await servers.locate();
    assert.equal(endpoint.own, true);
    assert.notEqual(endpoint.url, service.url);
  } finally {
    await servers.close();
  }
});

test("a background service whose process is gone is passed over", async () => {
  const servers = locator({ registration: register(join(folder, "stale.json"), { pid: 999_999 }) });
  try {
    assert.equal((await servers.locate()).own, true);
  } finally {
    await servers.close();
  }
});

test("a server of its own that fails says where its output is, and is not started again at once", async () => {
  const servers = locator({ fail: true });
  try {
    await assert.rejects(servers.locate(), /opencode serve stopped \(3\)\. Its output is in .*opencode-serve\.log/);
    assert.match(readFileSync(join(folder, "opencode-serve.log"), "utf8"), /the port is taken/);
    await assert.rejects(servers.locate(), /OpenCode did not start\. Its output is in/);
  } finally {
    await servers.close();
  }
  assert.ok(existsSync(join(folder, "opencode-serve.log")));
});

test("a hung shared service is neither terminated nor replaced", async () => {
  const child = spawn(process.execPath, ["-e", `
    const server = require("node:http").createServer(() => {});
    process.on("SIGTERM", () => process.send({ terminated: true }));
    server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
  `], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const gone = once(child, "exit");
  let terminated = false;
  child.on("message", (message: any) => { if (message.terminated) terminated = true; });
  const [message] = await once(child, "message") as [{ port: number }];
  const file = join(folder, "hung-service.json");
  const registration = JSON.stringify({ id: "svc_hung", version: "2.2.5", url: `http://127.0.0.1:${message.port}`, pid: child.pid, password: "scratch-only" });
  writeFileSync(file, registration);
  const servers = locator({ registration: file, start: true });
  try {
    assert.equal((await servers.locate()).own, true);
    assert.equal(terminated, false);
    assert.equal(readFileSync(file, "utf8"), registration);
    process.kill(child.pid!, 0);
  } finally {
    await servers.close();
    child.kill("SIGKILL");
    await gone;
  }
});

test("an enabled OpenCode 1 executable is refused before any serve command", async () => {
  const args = join(folder, "legacy-args.json");
  const servers = locator({ mode: "own", env: { ...process.env, OPENCODE_STANDIN_VERSION: "1.19.5", OPENCODE_STANDIN_ARGS: args } });
  try {
    await assert.rejects(servers.locate(), /OpenCode 1\.19\.5.*OpenCode 2.*opencode upgrade --major/);
    assert.equal(existsSync(args), false);
  } finally { await servers.close(); }
});

test("a different OpenCode 2 service is joined without replacing its PID or registration", async () => {
  const other = await FakeOpenCode.start();
  other.version = "2.2.4";
  const file = register(join(folder, "other-version.json"), { url: other.url, version: other.version, password: other.password });
  const before = readFileSync(file, "utf8");
  const servers = locator({ start: true, registration: file });
  try {
    const endpoint = await servers.locate();
    assert.equal(endpoint.own, false);
    assert.equal(endpoint.url, other.url);
    assert.equal(endpoint.pid, process.pid);
    assert.equal(readFileSync(file, "utf8"), before);
    await servers.close();
    assert.equal((await fetch(`${other.url}/api/info`, { headers: endpoint.headers })).status, 200);
  } finally { await servers.close(); await other.close(); }
});

test("a late concurrent shared registration wins without being killed or rewritten", async () => {
  const file = join(folder, "late-winner.json");
  const winner = JSON.stringify({ id: "svc_late", version: service.version, pid: process.pid, url: service.url, password: service.password });
  const servers = locator({ start: true, registration: file, env: { ...process.env, OPENCODE_STANDIN_WINNER: winner, OPENCODE_STANDIN_REGISTRATION: file } });
  try {
    const endpoint = await servers.locate();
    assert.equal(endpoint.own, false);
    assert.equal(endpoint.url, service.url);
    assert.equal(endpoint.pid, process.pid);
    assert.equal(readFileSync(file, "utf8"), winner);
    await servers.close();
    assert.equal(readFileSync(file, "utf8"), winner);
    assert.equal((await fetch(`${service.url}/api/info`, { headers: endpoint.headers })).status, 200);
  } finally { await servers.close(); }
});

test("a shared OpenCode 1 registration is left alone, never joined", async () => {
  const old = await FakeOpenCode.start();
  old.version = "1.19.5";
  const file = register(join(folder, "old-service.json"), { url: old.url, version: old.version, password: old.password });
  const before = readFileSync(file, "utf8");
  const servers = locator({ start: true, registration: file });
  try {
    const endpoint = await servers.locate();
    assert.equal(endpoint.own, true);
    assert.notEqual(endpoint.url, old.url);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally { await servers.close(); await old.close(); }
});

test("shared discovery does not forward credentials through a redirect", async () => {
  let forwarded = 0;
  const destination = createServer((_request, response) => { forwarded++; response.end("{}"); });
  await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const to = `http://127.0.0.1:${(destination.address() as { port: number }).port}`;
  const redirect = createServer((_request, response) => { response.writeHead(302, { location: `${to}/api/info` }); response.end(); });
  await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  const file = register(join(folder, "redirect.json"), { url: `http://127.0.0.1:${(redirect.address() as { port: number }).port}` });
  const servers = locator({ start: true, registration: file });
  try {
    assert.equal((await servers.locate()).own, true);
    assert.equal(forwarded, 0);
  } finally {
    await servers.close();
    await Promise.all([destination, redirect].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});

function present(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("test process did not settle");
    await sleep(20);
  }
}

async function orphan(name: string, env: NodeJS.ProcessEnv = {}, duringStartup = false) {
  const directory = realpathSync(mkdtempSync(join(folder, `${name}-`)));
  const options: ServerOptions = { path: program, mode: "own", start: false, cwd: directory, logPath: join(directory, "serve.log"), startTimeoutMs: 5000 };
  const recordPath = `${options.logPath}.server.json`;
  const bridge = fork(owner, [JSON.stringify(options)], { execArgv: [], env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exit = once(bridge, "exit");
  await once(bridge, "message");
  const response = once(bridge, "message");
  bridge.send("locate");
  let endpoint: Endpoint | undefined;
  if (duringStartup) {
    await until(() => existsSync(recordPath) && Boolean(JSON.parse(readFileSync(recordPath, "utf8")).server));
  } else {
    const [message] = await response;
    assert.equal((message as { error?: string }).error, undefined);
    endpoint = (message as { endpoint: Endpoint }).endpoint;
  }
  bridge.kill("SIGKILL");
  await exit;
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  return { options, recordPath, record, endpoint, async cleanup() {
    if (present(record.server.pid)) await endGroup(record.server.pid);
    rmSync(directory, { recursive: true, force: true });
  } };
}

test("an own server survives bridge SIGKILL and is reclaimed with the same PID and identity", async () => {
  const first = await orphan("reclaim");
  const servers = new ServerLocator(first.options);
  try {
    assert.equal(statSync(first.recordPath).mode & 0o777, 0o600);
    assert.equal(present(first.record.server.pid), true);
    const endpoint = await servers.locate();
    assert.equal(endpoint.pid, first.endpoint!.pid);
    assert.equal(endpoint.url, first.endpoint!.url);
    assert.equal(endpoint.serverIdentity, first.endpoint!.serverIdentity);
    assert.equal(endpoint.reclaimed, true);
    assert.deepEqual(endpoint.headers, first.endpoint!.headers);
    const close = servers.close();
    assert.equal(servers.close(), close);
    await close;
    assert.equal(present(endpoint.pid!), false);
    assert.equal(existsSync(first.recordPath), false);
    assert.equal(existsSync(`${first.recordPath}.lock`), false);
  } finally { await servers.close(); await first.cleanup(); }
});

test("a dead bridge's startup lease is taken over, and its unfinished server is stopped", async () => {
  const first = await orphan("startup-reclaim", { OPENCODE_STANDIN_HANG_START: "1" }, true);
  const servers = new ServerLocator(first.options);
  try {
    assert.equal(existsSync(`${first.recordPath}.lock`), true);
    const endpoint = await servers.locate();
    assert.notEqual(endpoint.pid, first.record.server.pid);
    assert.equal(endpoint.reclaimed, false);
    assert.equal(present(first.record.server.pid), false);
  } finally { await servers.close(); await first.cleanup(); }
});

test("a verified but hung orphan is stopped before a replacement starts", async () => {
  const first = await orphan("hung-orphan");
  const servers = new ServerLocator(first.options);
  try {
    process.kill(first.record.server.pid, "SIGSTOP");
    const endpoint = await servers.locate();
    assert.notEqual(endpoint.pid, first.record.server.pid);
    assert.equal(present(first.record.server.pid), false);
  } finally { await servers.close(); await first.cleanup(); }
});

test("an uncertain ownership record fails visibly without signaling or starting a second server", async () => {
  const first = await orphan("uncertain");
  const altered = { ...first.record, server: { ...first.record.server, start: "not-this-process" } };
  writeFileSync(first.recordPath, JSON.stringify(altered));
  const servers = new ServerLocator(first.options);
  const provider = new OpenCodeProvider({ settings: { path: program, mode: "own", start: false, folder, logPath: first.options.logPath }, locate: () => servers.locate() });
  const bridge = await startTestBridge({ providers: new Map([["opencode", provider]]), config: { generalFolder: folder } });
  const phone = await TestClient.open(bridge);
  try {
    await assert.rejects(phone.call("session.create", { profile: "opencode", cwd: folder }), (error: Error) => {
      assert.match(error.message, /Cannot safely reclaim OpenCode.*different or unreadable start identity/);
      assert.ok(error.message.includes(first.recordPath));
      assert.match(error.message, /Stop the host first/);
      return true;
    });
    assert.equal(present(first.record.server.pid), true);
    assert.deepEqual(JSON.parse(readFileSync(first.recordPath, "utf8")), altered);
    assert.equal(existsSync(`${first.recordPath}.lock`), false);
  } finally { await phone.close(); await bridge.dispose(); await servers.close(); await first.cleanup(); }
});

test("a wrong recorded password never authorizes killing the recorded process", async () => {
  const first = await orphan("wrong-password");
  const altered = { ...first.record, password: "x".repeat(32) };
  writeFileSync(first.recordPath, JSON.stringify(altered));
  const servers = new ServerLocator(first.options);
  try {
    await assert.rejects(servers.locate(), /Cannot safely reclaim OpenCode.*HTTP 401/);
    assert.equal(present(first.record.server.pid), true);
    assert.deepEqual(JSON.parse(readFileSync(first.recordPath, "utf8")), altered);
  } finally { await servers.close(); await first.cleanup(); }
});

test("a live bridge lease prevents another locator taking its server", async () => {
  const recordPath = join(folder, "live-owner.json");
  const first = locator({ mode: "own", recordPath });
  const second = locator({ mode: "own", recordPath });
  try {
    const endpoint = await first.locate();
    await assert.rejects(second.locate(), /host PID .* still owns the recorded server/);
    assert.equal(present(endpoint.pid!), true);
  } finally { await second.close(); await first.close(); }
});

test("concurrent bridge processes recover a stale lease without taking each other's new lease", async () => {
  const first = await orphan("concurrent-reclaim");
  writeFileSync(`${first.recordPath}.lock`, JSON.stringify(first.record.bridge), { mode: 0o600 });
  const bridges = [0, 1].map(() => fork(owner, [JSON.stringify(first.options)], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] }));
  try {
    await Promise.all(bridges.map((bridge) => once(bridge, "message")));
    const replies = bridges.map((bridge) => once(bridge, "message"));
    for (const bridge of bridges) bridge.send("locate");
    const results = (await Promise.all(replies)).map(([message]) => message as { endpoint?: Endpoint; error?: string });
    assert.equal(results.filter((result) => result.endpoint).length, 1);
    assert.equal(results.filter((result) => result.error).length, 1);
    assert.equal(results.find((result) => result.endpoint)!.endpoint!.pid, first.record.server.pid);
    assert.equal(present(first.record.server.pid), true);
  } finally {
    await Promise.all(bridges.map(async (bridge) => { const exit = once(bridge, "exit"); bridge.kill("SIGTERM"); await exit; }));
    await first.cleanup();
  }
});

test("a nonprivate ownership record is refused without touching its server", async () => {
  const first = await orphan("nonprivate");
  chmodSync(first.recordPath, 0o644);
  const servers = new ServerLocator(first.options);
  try {
    await assert.rejects(servers.locate(), /Cannot safely reclaim OpenCode.*not a private, owner-only regular file/);
    assert.equal(present(first.record.server.pid), true);
  } finally { await servers.close(); await first.cleanup(); }
});

test("own close escalates TERM for the whole process group and clears the private record", async () => {
  const childFile = join(folder, "descendant.pid");
  const recordPath = join(folder, "term-owner.json");
  const servers = locator({ mode: "own", recordPath, env: { ...process.env, OPENCODE_STANDIN_IGNORE_TERM: "1", OPENCODE_STANDIN_CHILD: childFile } });
  try {
    const endpoint = await servers.locate();
    const descendant = Number(readFileSync(childFile, "utf8"));
    const started = Date.now();
    await servers.close();
    assert.ok(Date.now() - started >= 1900);
    assert.equal(present(endpoint.pid!), false);
    await until(() => !present(descendant));
    assert.equal(existsSync(recordPath), false);
  } finally { await servers.close(); }
});

test("timed out startup cleans up a TERM-ignoring server and its descendants", async () => {
  const args = join(folder, "timeout-args.json");
  const childFile = join(folder, "timeout-child.pid");
  const recordPath = join(folder, "timeout-owner.json");
  const servers = locator({ mode: "own", recordPath, startTimeoutMs: 1500, env: { ...process.env, OPENCODE_STANDIN_ARGS: args, OPENCODE_STANDIN_HANG_START: "1", OPENCODE_STANDIN_CHILD: childFile } });
  try {
    await assert.rejects(servers.locate(), /did not start in time/);
    const root = JSON.parse(readFileSync(args, "utf8")).pid;
    assert.equal(present(root), false);
    await until(() => !present(Number(readFileSync(childFile, "utf8"))));
    assert.equal(existsSync(recordPath), false);
  } finally { await servers.close(); }
});

test("close aborts startup and does not return until the owned process has exited", async () => {
  const args = join(folder, "closing-args.json");
  const servers = locator({ mode: "own", env: { ...process.env, OPENCODE_STANDIN_ARGS: args, OPENCODE_STANDIN_HANG_START: "1" } });
  const starting = servers.locate();
  const failed = assert.rejects(starting, /OpenCode was stopped/);
  await until(() => existsSync(args));
  const pid = JSON.parse(readFileSync(args, "utf8")).pid;
  await servers.close();
  await failed;
  assert.equal(present(pid), false);
  assert.equal(existsSync(join(folder, "opencode-serve.log.server.json")), false);
});

test("the own server never inherits a parent agent's thread identity", async () => {
  const args = join(folder, "clean-env.json");
  const servers = locator({ mode: "own", env: { ...process.env, PORTALS_THREAD: "old-portals", CODEX_THREAD_ID: "old-codex", CURSOR_CONVERSATION_ID: "old-cursor", OPENCODE_STANDIN_ARGS: args } });
  try {
    await servers.locate();
    const given = JSON.parse(readFileSync(args, "utf8"));
    assert.deepEqual(given.threadVariables, {});
  } finally { await servers.close(); }
});

test("a missing service helper names the latest setup/update repair", () => {
  const module = new URL("../src/providers/opencode/server.ts", import.meta.url).href;
  const script = `
    import { registerHooks } from "node:module";
    import assert from "node:assert/strict";
    registerHooks({ resolve(name, context, next) {
      if (name === "@opencode/client/service") throw new Error("intentionally absent");
      return next(name, context);
    }});
    const { serviceModule } = await import(${JSON.stringify(module)});
    await assert.rejects(serviceModule(), /npx portals-host@latest update.*npx portals-host@latest setup/);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
});

test("a missing new-server start identity is actionable and the spawned child is cleaned up", async () => {
  const args = join(folder, "unidentified-args.json");
  const recordPath = join(folder, "unidentified-owner.json");
  const servers = locator({ mode: "own", recordPath, env: { ...process.env, OPENCODE_STANDIN_ARGS: args } });
  // Inject the outcome of an OS identity read failure while keeping the native
  // listener and authentication intact. A missing identity must never be dereferenced.
  const state = servers as any;
  const listener = state.listener.bind(servers);
  state.listener = async (child: unknown) => {
    const url = await listener(child);
    delete state.record.server;
    return url;
  };
  try {
    await assert.rejects(servers.locate(), /Cannot safely reclaim OpenCode.*start identity of newly started server PID.*could not be read/);
    assert.equal(present(JSON.parse(readFileSync(args, "utf8")).pid), false);
    assert.equal(existsSync(recordPath), false);
  } finally { await servers.close(); }
});

test("a failed version check is retried without restarting the host", async () => {
  const retry = join(folder, "opencode-retry");
  const marker = join(folder, "version-tried");
  writeFileSync(retry, `#!/bin/sh\nif [ "$1" = "--version" ] && [ ! -f "${marker}" ]; then\n  touch "${marker}"\n  exit 1\nfi\nexec "${process.execPath}" "${standin}" "$@"\n`);
  chmodSync(retry, 0o755);
  const servers = locator({ path: retry, registration: register(join(folder, "retry-service.json")) });
  try {
    await assert.rejects(servers.locate(), /Could not verify OpenCode 2/);
    assert.equal((await servers.locate()).own, false);
  } finally { await servers.close(); }
});

test("an older shared server is left untouched when the installed CLI meets the minimum", async () => {
  const other = await FakeOpenCode.start();
  other.version = "2.1.9";
  const file = register(join(folder, "below-minimum.json"), { url: other.url, version: other.version, password: other.password });
  const before = readFileSync(file, "utf8");
  const servers = locator({ registration: file, start: true });
  try {
    assert.equal((await servers.locate()).own, true);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal((await fetch(`${other.url}/api/info`, { headers: other.endpoint().headers })).status, 200);
  } finally { await servers.close(); await other.close(); }
});
