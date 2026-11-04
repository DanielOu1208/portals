import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { RunningBridge } from "../src/bridge.ts";
import { hashPassword } from "../src/http/auth.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderSession, SessionOptions, SessionSink } from "../src/providers/types.ts";
import WebSocket from "ws";
import { closeCode, createThread, mintTicket, password, socketURL, startTestBridge, temporaryHome, TestClient, username } from "./helpers.ts";

// How the bridge stops (src/lifetime.ts, main.ts, SessionManager.close): a session that
// fails to close keeps nothing else from closing; one that never closes holds the agents'
// closing up for six seconds, and anything else that never closes holds the stop up for
// eight seconds at most; an error nothing catches is logged, and either the bridge goes
// on (a promise's) or stops, closing its sessions first, and exits 1 (an exception's). A
// bridge run as a process, with test/lifetime-trouble.ts loaded before it to make the
// trouble.

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const trouble = fileURLToPath(new URL("./lifetime-trouble.ts", import.meta.url));

test("the bridge keeps its 8000ms default with no live owned provider and follows a live ownership hint", async () => {
  class Agent extends FakeProvider {
    owned = false;
    get stopDeadlineMs(): number | undefined { return this.owned ? 16_000 : undefined; }
  }
  const agent = new Agent({ directory: realpathSync(tmpdir()), delayMs: 1 });
  const bridge = await startTestBridge({ providers: new Map([["fake", agent]]) });
  try {
    assert.equal(bridge.stopDeadlineMs, 8000);
    agent.owned = true;
    assert.equal(bridge.stopDeadlineMs, 16_000);
    agent.owned = false;
    assert.equal(bridge.stopDeadlineMs, 8000);
  } finally { await bridge.dispose(); }
});

async function until<T>(check: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = check();
    if (found) return found;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a session that fails to close keeps neither the other sessions nor the agents from closing, and the bridge closes", async () => {
  const closed: string[] = [];
  let agentsClosed = false;
  let failing = "";
  class Agent extends FakeProvider {
    override async startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
      const session = await super.startSession(options, sink);
      session.close = async () => {
        if (options.id === failing) throw new Error("this session would not close");
        closed.push(options.id);
      };
      return session;
    }

    async close(): Promise<void> {
      agentsClosed = true;
    }
  }
  const folder = mkdtempSync(join(tmpdir(), "portals-lifetime-"));
  const bridge = await startTestBridge({ providers: new Map([["fake", new Agent({ directory: folder, delayMs: 1 })]]) });
  try {
    const client = await TestClient.open(bridge);
    failing = await createThread(client);
    const other = await createThread(client);
    await client.close();
    await bridge.close();
    assert.deepEqual(closed, [other]);
    assert.equal(agentsClosed, true);
    // And what closes after them: nothing answers any more.
    await assert.rejects(fetch(`${bridge.url}/api/status`));
  } finally {
    rmSync(bridge.home, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a device that connects while the bridge closes its sessions is turned away, and the bridge still closes", async () => {
  // Droid's turn takes a second or two to stop; the app reconnects at once when its
  // connection is closed (the n18 live check of PR #19, 2026-10-30): taken on then, the
  // new connection was never closed, the server waited for it, and every such stop ran
  // to the eight-second deadline.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let closing = false;
  class Agent extends FakeProvider {
    override async startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
      const session = await super.startSession(options, sink);
      session.close = async () => {
        closing = true;
        await held;
      };
      return session;
    }
  }
  const folder = mkdtempSync(join(tmpdir(), "portals-lifetime-"));
  const bridge = await startTestBridge({ providers: new Map([["fake", new Agent({ directory: folder, delayMs: 1 })]]) });
  let late: WebSocket | undefined;
  try {
    const client = await TestClient.open(bridge);
    await createThread(client);
    const ticket = await mintTicket(bridge);
    const closed = bridge.close();
    await until(() => closing);
    late = new WebSocket(socketURL(bridge, `?ticket=${encodeURIComponent(ticket)}`), { perMessageDeflate: false });
    const frames: string[] = [];
    late.on("message", (data) => frames.push(data.toString()));
    late.on("error", () => undefined);
    const code = await Promise.race([closeCode(late), new Promise((resolve) => setTimeout(() => resolve("still open"), 2000))]);
    assert.equal(code, 1001);
    assert.ok(!frames.some((frame) => frame.includes("gateway.ready")), "the late connection was taken on");
    release();
    assert.equal(await Promise.race([closed.then(() => "closed"), new Promise((resolve) => setTimeout(() => resolve("still closing"), 2000))]), "closed");
  } finally {
    release();
    // Before the fix the late connection stays open, and the server with it.
    late?.terminate();
    rmSync(bridge.home, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});

// MARK: A bridge run as a process

interface BridgeProcess {
  url: string;
  /** What it logged so far. */
  log(): string;
  /** What it wrote on standard output so far (`closed <thread>`, test/lifetime-trouble.ts). */
  said(): string;
  exited: Promise<number | null>;
  kill(signal: NodeJS.Signals): void;
}

/** A bridge of its own as a process, with `kind` of trouble; killed when the test ends. */
async function bridgeProcess(t: TestContext, kind: string): Promise<BridgeProcess> {
  const home = temporaryHome();
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      port: 0,
      auth: { username, passwordHash: await hashPassword(password) },
      generalFolder: realpathSync(tmpdir()),
      providers: { claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, opencode: false, fake: true },
      fake: { delayMs: 1 },
      push: { relay: null },
      relay: { enabled: false },
      updates: { check: false },
    }),
  );
  const child = spawn(process.execPath, ["--import", trouble, main], {
    env: { ...process.env, PORTALS_BRIDGE_HOME: home, PORTALS_BRIDGE_LOG: "info", PORTALS_TEST_TROUBLE: kind },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
    rmSync(home, { recursive: true, force: true });
  });
  let log = "";
  let said = "";
  child.stderr.on("data", (data: Buffer) => (log += data.toString()));
  child.stdout.on("data", (data: Buffer) => (said += data.toString()));
  const url = (await until(() => /listening on (http:\S+)/.exec(log), 20_000))[1];
  return { url, log: () => log, said: () => said, exited, kill: (signal) => child.kill(signal) };
}

/** The fields of the first line logged at `level` that says `message` (none: `{}`); undefined when there is none. */
function logged(log: string, level: string, message: string): Record<string, any> | undefined {
  const line = log.split("\n").find((entry) => entry.split(" ")[1] === level && entry.includes(` ${message}`));
  if (line === undefined) return undefined;
  return line.includes("{") ? JSON.parse(line.slice(line.indexOf("{"))) : {};
}

test("a promise that fails with nothing to catch it is logged with its stack, and the bridge goes on", async (t) => {
  const bridge = await bridgeProcess(t, "rejection");
  bridge.kill("SIGUSR2");
  const fields = await until(() => logged(bridge.log(), "error", "a promise failed with nothing to catch it; the bridge goes on"));
  assert.match(fields.error, /^Error: nobody waits for this\n\s+at /);
  assert.equal((await fetch(`${bridge.url}/api/status`)).status, 200);
  bridge.kill("SIGTERM");
  assert.equal(await bridge.exited, 0);
});

test("an exception nothing catches is logged with its stack, and the bridge closes its sessions and exits 1", async (t) => {
  const bridge = await bridgeProcess(t, "exception");
  const client = await TestClient.open({ url: bridge.url } as RunningBridge);
  const thread = await createThread(client);
  bridge.kill("SIGUSR2");
  assert.equal(await bridge.exited, 1);
  await client.close();
  const fields = logged(bridge.log(), "error", "an error nothing caught; the bridge stops");
  assert.match(fields?.error, /^Error: nothing catches this\n\s+at /);
  assert.match(bridge.log(), / info {2}stopping \(an error nothing caught\)\n/);
  // Its sessions closed before it exited, and then the agent: they do not run on without it.
  assert.equal(bridge.said(), `closed ${thread}\nagent closed\n`);
});

test("a session that never closes holds the agents' closing up for six seconds, after which they close and the bridge exits", async (t) => {
  const bridge = await bridgeProcess(t, "hang");
  const client = await TestClient.open({ url: bridge.url } as RunningBridge);
  await createThread(client);
  const began = Date.now();
  bridge.kill("SIGTERM");
  const code = await Promise.race([bridge.exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 12_000))]);
  const took = Date.now() - began;
  await client.close();
  assert.equal(code, 0);
  assert.ok(took >= 5900 && took < 7900, `it exited after ${took} ms`);
  assert.equal(bridge.said(), "agent closed\n");
  assert.ok(logged(bridge.log(), "warn", "the sessions had not closed after 6 seconds; the agents close all the same"));
  assert.equal(logged(bridge.log(), "warn", "the bridge had not closed after 8 seconds; it stops without waiting for the rest"), undefined);
});

test("an agent that never closes holds a stop up for eight seconds, after which the bridge exits all the same", async (t) => {
  const bridge = await bridgeProcess(t, "hang-agent");
  const client = await TestClient.open({ url: bridge.url } as RunningBridge);
  const thread = await createThread(client);
  const began = Date.now();
  bridge.kill("SIGTERM");
  const code = await Promise.race([bridge.exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 12_000))]);
  const took = Date.now() - began;
  await client.close();
  assert.equal(code, 0);
  assert.ok(took >= 7900 && took < 11_000, `it exited after ${took} ms`);
  assert.equal(bridge.said(), `closed ${thread}\n`);
  assert.ok(logged(bridge.log(), "warn", "the bridge had not closed after 8 seconds; it stops without waiting for the rest"));
});

test("SIGINT reads an owned-process deadline before close clears ownership, allowing native cleanup beyond eight seconds", async (t) => {
  const bridge = await bridgeProcess(t, "slow-owned-agent");
  const began = Date.now();
  bridge.kill("SIGINT");
  const code = await Promise.race([bridge.exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 18_000))]);
  const took = Date.now() - began;
  assert.equal(code, 0);
  assert.ok(took >= 8900 && took < 15_000, `it exited after ${took} ms`);
  assert.equal(bridge.said(), "agent closed\n");
  assert.equal(logged(bridge.log(), "warn", "the bridge had not closed after 8 seconds; it stops without waiting for the rest"), undefined);
});
