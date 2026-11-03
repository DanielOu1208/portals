import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { setLogLevel } from "../src/log.ts";
import { CodexClient, processConnector, socketConnector } from "../src/providers/codex/client.ts";
import { CodexProvider } from "../src/providers/codex/provider.ts";
import type { LoggedEvent } from "../src/sessions/eventLog.ts";
import type { Registry } from "../src/sessions/registry.ts";
import { Session, type Peer } from "../src/sessions/session.ts";
import { FakeDaemon } from "./codex-daemon.ts";
import { deafPid, deafRuns } from "./deaf-program.ts";
import "./helpers.ts";

// Codex in an app-server of the bridge's own (codex.mode "own"): a child process that
// speaks one message per line on its standard input and output, played here by small
// programs written for each test, or by one that passes the lines on to the stand-in
// daemon (test/codex-standin.ts), beside the shared daemon where the two ways in differ.

const folder = mkdtempSync(join(tmpdir(), "portals-codex-own-"));
/** What the stand-ins said their process ids were, to end whatever a failed test left. */
const pids: string[] = [];

after(() => {
  for (const file of pids) {
    if (!existsSync(file)) continue;
    // Only a whole id: a file a shell killed as it opened it is empty, and Number("") is 0,
    // which would be this process's whole group.
    const said = readFileSync(file, "utf8").trim();
    if (!/^[1-9]\d*$/.test(said)) continue;
    try {
      process.kill(Number(said), "SIGKILL");
    } catch {
      // Gone already, as it should be.
    }
  }
  rmSync(folder, { recursive: true, force: true });
});

/** A program at `name` in the test's folder that runs `body` as a shell script, after writing its process id to the file returned. */
function program(name: string, body: string): { path: string; pid: string } {
  const path = join(folder, name);
  const pid = join(folder, `${name}.pid`);
  writeFileSync(path, `#!/bin/sh\n${body.replaceAll("$PID_FILE", `'${pid}'`)}\n`);
  chmodSync(path, 0o755);
  pids.push(pid);
  return { path, pid };
}

/**
 * Waits for `check` to hold. `timeoutMs` only ends a wait for what never comes: a Mac busy
 * with the whole suite and a build may take seconds to start a stand-in in node, or to
 * have one end and be told so, and each test waits for the event itself.
 */
async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a write to Codex's own app-server once it no longer reads ends nothing but that write: its exit says the rest", async () => {
  // It closes its standard input first, so every write from then on fails (EPIPE).
  const codex = program("deaf-codex", "exec 0<&-\necho $$ > $PID_FILE\nexec sleep 30");
  const closed: string[] = [];
  const transport = await processConnector(codex.path, process.env)({ message() {}, closed: (reason) => closed.push(reason) });
  await until(() => existsSync(codex.pid) && readFileSync(codex.pid, "utf8").trim() !== "");
  const pid = Number(readFileSync(codex.pid, "utf8"));
  for (let write = 0; write < 20; write += 1) {
    transport.send({ id: write, method: "model/list", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(closed, []);
  transport.close();
  await until(() => closed.length === 1);
  assert.match(closed[0], /^codex app-server exited \(SIGTERM\)$/);
  assert.equal(alive(pid), false);
});

for (const endedBy of ["stop", "exit"] as const) {
  test(`Codex's own app-server takes its SIGTERM-resistant child with it after ${endedBy}`, async () => {
    const standin = fileURLToPath(new URL("./child-standin.ts", import.meta.url));
    const codex = program(`codex-group-${endedBy}`, `echo $$ > $PID_FILE\nexec '${process.execPath}' '${standin}'`);
    const messages: any[] = [];
    const closed: string[] = [];
    const transport = await processConnector(codex.path, process.env)({ message: (value) => messages.push(value), closed: (reason) => closed.push(reason) });
    let child: number | undefined;
    try {
      transport.send({ do: "spawn", deaf: true } as any);
      await until(() => messages.some((message) => message.spawned));
      child = messages.find((message) => message.spawned).spawned;
      assert.ok(child && alive(child));
      if (endedBy === "stop") transport.close();
      else transport.send({ do: "exit", code: 3 } as any);
      await until(() => closed.length === 1);
      // Its SIGKILL, two seconds after the SIGTERM it ignored; it never ends by itself.
      await until(() => !alive(child!), 15_000);
    } finally {
      transport.close();
      if (child && alive(child)) process.kill(child, "SIGKILL");
    }
  });
}

test("Codex's own app-server is killed after the grace time when it ignores SIGTERM", async () => {
  const standin = fileURLToPath(new URL("./child-standin.ts", import.meta.url));
  const codex = program("codex-deaf", `echo $$ > $PID_FILE\nexec '${process.execPath}' '${standin}'`);
  const messages: any[] = [];
  const closed: string[] = [];
  const transport = await processConnector(codex.path, process.env)({ message: (value) => messages.push(value), closed: (reason) => closed.push(reason) });
  let pid: number | undefined;
  try {
    transport.send({ do: "deaf" } as any);
    await until(() => messages.some((message) => message.deaf));
    pid = Number(readFileSync(codex.pid, "utf8"));
    const asked = Date.now();
    transport.close();
    // It never ends by itself: only the SIGKILL after the grace time ends it.
    await until(() => closed.length === 1, 15_000);
    assert.equal(alive(pid), false);
    assert.equal(closed[0], "codex app-server exited (SIGKILL)");
    // Not before the grace time (two seconds), which the stop gives it to end by itself.
    assert.ok(Date.now() - asked >= 2000, `ended ${Date.now() - asked} ms after the stop`);
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  }
});

test("closing the Codex provider waits for its own starting process to stop", async () => {
  const script = join(folder, "codex-starting.mjs");
  const codex = program("codex-starting", `exec '${process.execPath}' '${script}'`);
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => undefined);\nwriteFileSync(${JSON.stringify(codex.pid)}, String(process.pid));\nsetInterval(() => undefined, 60_000);\n`);
  const provider = new CodexProvider({
    settings: { mode: "own", path: codex.path, socket: null, imagesDir: join(folder, "images") },
    checkVersion: false,
    configPath: join(folder, "config.toml"),
  });
  const starting = provider.client.start();
  let pid: number | undefined;
  try {
    await until(() => existsSync(codex.pid) && readFileSync(codex.pid, "utf8").trim() !== "");
    pid = Number(readFileSync(codex.pid, "utf8"));
    await provider.close();
    assert.equal(alive(pid), false);
    await starting;
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await provider.close();
    await starting;
  }
});

// MARK: An event the bridge fails to take in

const standin = fileURLToPath(new URL("./codex-standin.ts", import.meta.url));

/** What the bridge logs while the test runs, a line each, down to debug. */
function logLines(t: TestContext): string[] {
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  setLogLevel("debug");
  t.after(() => {
    process.stderr.write = write;
    setLogLevel("silent");
  });
  return lines;
}

for (const mode of ["own", "shared"] as const) {
  test(`${mode}: a Codex turn's end the bridge fails to take in is logged as an error, and the message waiting behind the turn still starts`, async (t) => {
    const daemon = await FakeDaemon.start();
    const cwd = realpathSync(mkdtempSync(join(folder, `${mode}-`)));
    // Codex of its own: the stand-in that passes each line on to the daemon.
    const codex = program(`codex-${mode}`, `exec '${process.execPath}' '${standin}' '${daemon.socketPath}' $PID_FILE "$@"`);
    const provider = new CodexProvider({
      settings: { mode, path: codex.path, socket: daemon.socketPath, imagesDir: join(cwd, "images") },
      connect: mode === "shared" ? socketConnector(daemon.socketPath) : undefined,
      checkVersion: false,
      configPath: join(daemon.folder, "config.toml"),
      timeZone: "UTC",
      backoff: [0.05, 0.1],
    });
    const settings = { model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "" };
    try {
      const id = await provider.newThread({ cwd, settings });
      // Back in default from another mode: as the turn ends, the session asks the agent's side whether it still has that mode's policy to undo.
      const record = { id, agent: "codex", cwd, title: null, model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "", createdAt: 0, updatedAt: 0, origin: "phone" as const, modeReset: true };
      const thread = new Session(record, { has: () => false } as unknown as Registry);
      const session = await provider.startSession({ id, cwd, settings, title: null }, thread.sink);
      // Which fails, once: the turn's end is not taken in.
      let failed = false;
      session.modeResetPending = () => {
        if (failed) return false;
        failed = true;
        throw new Error("the agent's side could not say");
      };
      await thread.attach(session);
      const events: LoggedEvent[] = [];
      thread.follow({ isOpen: true, takesRequests: false, sendRequest: () => {}, sendEvent: (event: LoggedEvent) => events.push(event) } as unknown as Peer);
      const lines = logLines(t);

      thread.submit("First.").begin?.();
      const turn = await daemon.activeTurn(id);
      assert.equal(thread.submit("Second.", { queue: true }).status, "queued");
      const from = daemon.calls.length;
      daemon.finishTurn(id, turn);
      const second = await Promise.race([
        daemon.waitForCall((call) => call.method === "turn/start" && call.params.input?.[0]?.text === "Second.", from),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000).unref()),
      ]);
      assert.ok(second, "the message waiting never started");
      assert.deepEqual(events.find((event) => event.type === "message.complete")?.payload, { status: "complete", text: "Done.", turn_usage: { seconds: 1 } });
      const errors = lines.filter((line) => line.split(" ")[1] === "error");
      assert.equal(errors.length, 1);
      const fields = JSON.parse(errors[0].slice(errors[0].indexOf("{")));
      assert.deepEqual([fields.session, fields.event], [id, "turn.end"]);
      assert.match(fields.error, /^Error: the agent's side could not say\n\s+at /);
      // Not taken for a line that is not JSON.
      assert.equal(lines.some((line) => /not JSON/.test(line)), false);
      await thread.close();
    } finally {
      await provider.close();
      await daemon.close();
    }
    if (mode === "own") {
      const pid = Number(readFileSync(codex.pid, "utf8"));
      await until(() => !alive(pid));
    }
  });
}

// MARK: A frame that is JSON but no message

for (const mode of ["own", "shared"] as const) {
  test(`${mode}: a null from Codex is passed over, as a frame that is not JSON is, and the connection goes on`, async () => {
    const daemon = await FakeDaemon.start();
    const codex = program(`codex-null-${mode}`, `exec '${process.execPath}' '${standin}' '${daemon.socketPath}' $PID_FILE "$@"`);
    const client = new CodexClient({
      connect: mode === "own" ? processConnector(codex.path, process.env) : socketConnector(daemon.socketPath),
      clientInfo: { name: "portals-bridge", title: "Portals", version: "0.1.0" },
      backoff: [0.05],
    });
    const heard: string[] = [];
    client.listen({ notification: (method) => heard.push(method), request() {}, connected() {}, disconnected: () => heard.push("dropped") });
    try {
      await client.start();
      assert.equal(client.isConnected, true);
      const connection = daemon.connections.at(-1)!;
      // `null` is JSON; and what comes after it is still heard.
      connection.socket.send("null");
      connection.send({ method: "thread/status/changed", params: { threadId: "t" } });
      await until(() => heard.length > 0);
      assert.deepEqual(heard, ["thread/status/changed"]);
      assert.equal((await client.call("model/list", {})).data.length, 2);
      assert.equal(daemon.connections.length, 1);
    } finally {
      client.close();
      await daemon.close();
    }
    if (mode === "own") {
      const pid = Number(readFileSync(codex.pid, "utf8"));
      await until(() => !alive(pid));
    }
  });
}

test("a `codex app-server daemon start` that ignores SIGTERM is killed at its time, so the connection to the shared daemon is tried again", async () => {
  // Started again with twice the time while a busy Mac killed it before it was deaf
  // (test/deaf-program.ts); each in a provider of its own, with its own images folder.
  const { result: endedBy, pid } = await deafRuns(folder, "deaf-daemon-start", 300, async (program, daemonStartMs) => {
    // No daemon: its socket is missing, so the bridge starts one before it connects.
    const provider = new CodexProvider({
      settings: { mode: "shared", path: program.path, socket: join(folder, "no-daemon.sock"), imagesDir: join(folder, `deaf-images-${daemonStartMs}`) },
      checkVersion: false,
      backoff: [60],
      readyMs: 100,
      daemonStartMs,
      configPath: join(folder, "config.toml"),
    });
    provider.start();
    try {
      // Killed at its time whether deaf by then or not: by three times that, it said it is
      // deaf, or it never will.
      await until(() => deafPid(program) !== null, 3 * daemonStartMs).catch(() => undefined);
      const deaf = deafPid(program);
      if (deaf === null) return "never deaf";
      // Its end, which SIGTERM alone never brings: it sleeps far longer (deafLifetimeS).
      return await until(() => !alive(deaf), 15_000).then(() => "ended", () => "still running 15 s after its time");
    } finally {
      await provider.close();
    }
  }, (program) => pids.push(program.pidFile));
  assert.ok(pid !== null, "the program never got as far as ignoring SIGTERM");
  assert.equal(endedBy, "ended");
});

test("a shared daemon's socket left by a daemon that died has the daemon started, as a missing one does", async () => {
  // A daemon killed (or crashed) leaves its socket behind, which nothing listens on.
  const socket = join(folder, "dead-daemon.sock");
  const dead = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => dead.stdout!.once("data", resolve));
  dead.kill("SIGKILL");
  await new Promise((resolve) => dead.once("exit", resolve));
  assert.ok(existsSync(socket), "the socket stays after its daemon died");
  const started = join(folder, "dead-daemon-started");
  const { path } = program("restarting-codex", `[ "$1 $2 $3" = "app-server daemon start" ] && echo started > '${started}'\nexit 0`);
  const provider = new CodexProvider({
    settings: { mode: "shared", path, socket, imagesDir: join(folder, "dead-images") },
    checkVersion: false,
    backoff: [0.05],
    readyMs: 100,
    configPath: join(folder, "config.toml"),
  });
  provider.start();
  try {
    await until(() => existsSync(started)).catch(() => undefined);
    assert.ok(existsSync(started), "`codex app-server daemon start` ran");
  } finally {
    await provider.close();
  }
});
