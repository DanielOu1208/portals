import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs, { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startBridge, type BridgeOptions, type RunningBridge } from "../src/bridge.ts";
import { pathsFor } from "../src/config.ts";
import { counters } from "../src/counters.ts";
import { writeLinks } from "../src/fleet/links.ts";
import { methods } from "../src/gateway/methods.ts";
import { hashPassword } from "../src/http/auth.ts";
import { setLogLevel } from "../src/log.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { AgentProfile, Provider, ProviderSession, SessionOptions, SessionSink } from "../src/providers/types.ts";
import { readJSON, writeJSON } from "../src/store/jsonFile.ts";
import { createThread, isEvent, password, roomyDisk, runTurn, sessionCookie, signIn, temporaryHome, TestClient, username, type Frame } from "./helpers.ts";
import { piProvider, standin } from "./pi-standin.ts";

// The counters (src/counters.ts): what they write, that it holds no
// one's words, and that nothing of theirs can stop the bridge or change what it does.
// The counters are one per process, so every test here starts its own bridge and stops
// it before the next begins.

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const portals = fileURLToPath(new URL("../src/portals.ts", import.meta.url));

/** A line of the counters' file. */
type Line = Record<string, any>;

interface Counted extends RunningBridge {
  /** The counters' file. */
  file: string;
  dispose(): Promise<void>;
}

interface StartOptions {
  /** What config.json's `counters` is; `{ enabled: true }` when not given, no key at all for null. */
  key?: unknown;
  config?: Record<string, unknown>;
  counters?: BridgeOptions["counters"];
  providers?: Map<string, Provider>;
  temporaryFolders?: string[];
  /** Reuse a folder, with the config it has. */
  home?: string;
  keepHome?: boolean;
  /** Called with the folder before the bridge starts. */
  prepare?: (home: string) => void;
}

let hash: Promise<string> | undefined;

/** What a test bridge's config.json holds: the scripted agent only, as in helpers.ts. */
async function configFor(key: unknown, more: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  hash ??= hashPassword(password);
  return {
    port: 0,
    auth: { username, passwordHash: await hash },
    generalFolder: realpathSync(tmpdir()),
    providers: { claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, fake: true },
    fake: { delayMs: 1 },
    push: { relay: null },
    relay: { enabled: false },
    updates: { check: false },
    ...(key === null ? {} : { counters: key === undefined ? { enabled: true } : key }),
    ...more,
  };
}

/** A bridge in a folder of its own, with the counters on and a short tick unless told otherwise; gone when the test ends. */
async function start(t: TestContext, options: StartOptions = {}): Promise<Counted> {
  const home = options.home ?? temporaryHome();
  if (!options.home) writeFileSync(join(home, "config.json"), JSON.stringify(await configFor(options.key, options.config)));
  options.prepare?.(home);
  const bridge = await startBridge({
    home,
    providers: options.providers,
    temporaryFolders: options.temporaryFolders,
    counters: { seconds: 0.03, ...options.counters },
    // The same disk from one run to the next, whatever the test machine's does meanwhile.
    disk: { statfs: roomyDisk },
  });
  const counted: Counted = {
    ...bridge,
    file: options.counters?.file ?? pathsFor(home).counters,
    async dispose() {
      await bridge.close();
      if (!options.keepHome) rmSync(home, { recursive: true, force: true });
    },
  };
  t.after(() => counted.dispose());
  return counted;
}

/** The lines in a counters file, oldest first; none when there is no file. Throws for a line that is not whole. */
function linesOf(file: string): Line[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Line);
}

async function until<T>(check: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const ends = Date.now() + timeoutMs;
  for (;;) {
    const found = check();
    if (found) return found;
    if (Date.now() > ends) throw new Error("timed out waiting");
    await sleep(5);
  }
}

/**
 * What `act` was counted as: the lines from after a line that closed off whatever came
 * before, to one written after `act` finished and the other side of its sockets had
 * the moment it needs to see them close.
 */
async function counted(file: string, act: () => Promise<unknown>): Promise<Line[]> {
  const earlier = linesOf(file).length;
  await until(() => linesOf(file).length > earlier);
  const before = linesOf(file).length;
  await act();
  await sleep(40);
  const done = linesOf(file).length;
  await until(() => linesOf(file).length > done);
  return linesOf(file).slice(before);
}

/** The sum over `lines` of the number at `path`, 0 where it is left out. */
function total(lines: Line[], ...path: string[]): number {
  let sum = 0;
  for (const line of lines) {
    let value: any = line;
    for (const key of path) value = value?.[key];
    if (typeof value === "number") sum += value;
  }
  return sum;
}

/** What the bridge logs while the test runs, a line each. */
function logLines(t: TestContext): string[] {
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  setLogLevel("info");
  t.after(() => {
    process.stderr.write = write;
    setLogLevel("silent");
  });
  return lines;
}

/** What is not a counting function of `counters`. */
const machinery = new Set(["constructor", "start", "stop", "state", "letGo", "turnOn", "turnOff", "fault", "clock", "tick", "writeLine", "append", "sample", "row"]);

/** Puts a note-taker in place of every counting function; `called` is the names entered, `restore` puts them back. */
function watchCounting(t: TestContext): { called: string[]; restore(): void } {
  const prototype = Object.getPrototypeOf(counters) as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(prototype).filter((name) => !machinery.has(name) && typeof prototype[name] === "function");
  assert.ok(names.includes("rpc") && names.includes("wrote") && names.length >= 15, "the counting functions were found");
  const called: string[] = [];
  const own = counters as unknown as Record<string, unknown>;
  for (const name of names) own[name] = () => void called.push(name);
  const restore = () => {
    for (const name of names) delete own[name];
  };
  t.after(restore);
  return { called, restore };
}

/** Sends a message and waits for its turn to end. */
async function turn(client: TestClient, session: string, text: string): Promise<void> {
  const from = client.frames.length;
  await client.call("prompt.submit", { session_id: session, text });
  await client.from(from, (frame) => isEvent(frame, "message.complete", session));
}

/** One call, with the bytes of the frame sent and of the answer as it arrived. */
async function weighed(client: TestClient, method: string, params: Record<string, unknown>, id: string): Promise<{ out: number; in: number; frame: Frame }> {
  const text = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const arrived = new Promise<{ bytes: number; frame: Frame }>((resolve) => {
    const listen = (data: Buffer) => {
      const frame = JSON.parse(data.toString());
      if (frame.id !== id) return;
      client.socket.off("message", listen);
      resolve({ bytes: data.length, frame });
    };
    client.socket.on("message", listen);
  });
  client.send(text);
  const answer = await arrived;
  return { out: Buffer.byteLength(text), in: answer.bytes, frame: answer.frame };
}

// MARK: What may be in the file

const rows = {
  rpc: ["n", "ms", "max", "wait_ms", "in", "out", "out_max", "err"],
  links: ["n", "ms", "max", "wait_ms", "out", "in", "err", "signins"],
  files: ["w", "w_bytes", "w_ms", "w_max", "r", "r_bytes", "r_ms"],
  frames: ["n", "bytes", "buffered_max"],
};

/** Every section a line may have: its keys when it is a table (null for a single row), and its rows' fields. */
const sections: Record<string, { keys: string[] | null; fields: string[] }> = {
  proc: { keys: null, fields: ["rss", "heap", "ext", "cpu_user", "cpu_sys", "loop_max"] },
  kids: { keys: null, fields: ["n", "rss", "ps_ms"] },
  now: { keys: null, fields: ["conns", "loaded", "threads", "removed", "revision", "waiters", "claude_sessions", "claude_warm"] },
  conn: { keys: ["opened", "closed"], fields: ["net", "local", "app", "link"] },
  out: { keys: ["ready", "answers", "events", "asks"], fields: rows.frames },
  rpc: { keys: [...Object.keys(methods), "other"], fields: rows.rpc },
  rpc_by: { keys: ["app", "link", "local"], fields: ["n", "in", "out"] },
  emit: { keys: null, fields: ["n", "ms", "max"] },
  turns: { keys: null, fields: ["started", "ended"] },
  threads: { keys: null, fields: ["added", "removed"] },
  changes: { keys: null, fields: ["empty", "delta", "full", "threads"] },
  files: { keys: ["threads", "removed", "push", "folders", "links", "config", "setup", "hermes", "fake", "other"], fields: rows.files },
  load: { keys: ["claude", "codex", "hermes", "fake", "pi", "cursor", "other"], fields: ["n", "ms", "max"] },
  links: { keys: [...Array.from({ length: 16 }, (_, index) => String(index)), "other"], fields: rows.links },
  http: { keys: ["login", "ticket", "status", "push", "other"], fields: ["n", "ms", "in", "out"] },
  spawn: { keys: null, fields: ["claude", "claude_cli", "codex", "pi", "cursor", "hermes", "ps"] },
  codex_folders: { keys: null, fields: ["n", "rows", "ms", "err"] },
  claude_checks: { keys: null, fields: ["n", "ms"] },
  log: { keys: null, fields: ["n", "bytes"] },
};

const scalars = ["v", "s", "late", "up", "dropped", "tick_ms"];

/** Every key of `line` is one the plan lists, and every value under it a finite number (`t` aside, which is a time). */
function assertOnlyListed(line: Line): void {
  const number = (value: unknown, where: string) => assert.ok(typeof value === "number" && Number.isFinite(value), `${where} is a finite number`);
  const row = (value: unknown, fields: string[], where: string) => {
    assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${where} is a row`);
    for (const [field, item] of Object.entries(value as object)) {
      assert.ok(fields.includes(field), `${where}.${field} is a listed field`);
      number(item, `${where}.${field}`);
    }
  };
  for (const [key, value] of Object.entries(line)) {
    if (key === "t") {
      assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    } else if (scalars.includes(key)) {
      number(value, key);
    } else {
      const section = sections[key];
      assert.ok(section, `${key} is a listed section`);
      if (section.keys === null) {
        row(value, section.fields, key);
        continue;
      }
      for (const [name, item] of Object.entries(value as object)) {
        assert.ok(section.keys.includes(name), `${key}.${name} is a listed key`);
        row(item, section.fields, `${key}.${name}`);
      }
    }
  }
}

// MARK: Privacy

const marker = "Zq7MarkerXyzzy";

/** The scripted agent under a name of the user's choosing, whose tools give the marker back. */
class MarkedProvider extends FakeProvider {
  override readonly profile: AgentProfile = { name: marker, kind: "fake", displayName: `${marker} agent`, description: `${marker} description`, model: "fake-1", provider: "fake" };

  override startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    return super.startSession(options, marked(sink));
  }

  override resumeSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    return super.resumeSession(options, marked(sink));
  }
}

function marked(sink: SessionSink): SessionSink {
  return { ...sink, emit: (event) => sink.emit(event.type === "tool.end" ? { ...event, result: { output: `${marker} tool output` } } : event) };
}

test("nothing a person or an agent said, and no name or path, reaches the counters' file", async (t) => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "counters-privacy-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const folder = join(scratch, `${marker} folder`);
  const added = join(scratch, `${marker} added`);
  mkdirSync(folder);
  mkdirSync(added);

  const capBytes = 60_000;
  const earlier = `${JSON.stringify({ v: 1, t: new Date().toISOString(), s: 60, up: 60, tick_ms: 1 })}\n`;
  const near = await start(t, {
    providers: new Map<string, Provider>([[marker, new MarkedProvider({ directory: join(scratch, "fake"), delayMs: 1 })]]),
    temporaryFolders: [],
    // A file nearly at its cap already, so it is rotated early on and both files are read at the end.
    counters: { capBytes },
    prepare: (home) => writeFileSync(join(home, "counters.log"), earlier.repeat(Math.floor((capBytes - 1500) / earlier.length))),
  });
  const far = await start(t, { key: null });
  const link = marker.toLowerCase();
  writeLinks(pathsFor(near.home).links, [{ name: link, url: far.url, user: username, password }]);

  const there = await TestClient.open(far);
  const farThread = await createThread(there, { title: `${marker} far title` });
  await runTurn(there, farThread, `${marker} said over there`);
  const client = await TestClient.open(near);
  const refused = async (call: Promise<unknown>) => assert.ok(await call.then(() => false, () => true), "the call is refused");

  // Over HTTP: a user name, paths and queries, a push registration.
  assert.equal((await signIn(near, { username: marker, password: `${marker} password` })).status, 401);
  const cookie = await sessionCookie(near);
  await fetch(`${near.url}/${marker}?${marker}=${marker}`);
  await fetch(`${near.url}/api/plugins/aeriportal-push/threads/${marker}?${marker}=1`, { method: "DELETE", headers: { Cookie: cookie } });
  const token = "ab12cd34".repeat(8);

  // A thread whose every word is the marker, in a folder named with it.
  await client.call("folders.add", { path: folder });
  const thread = (await client.call("session.create", { profile: marker, source: "tui", title: `${marker} title`, cwd: folder })).session_id as string;
  const registered = await fetch(`${near.url}/api/plugins/aeriportal-push/registration`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ device: { token, bundle_id: `${marker}.app`, environment: "sandbox" }, host: `${marker} host`, threads: [{ id: thread, agent: marker, agent_name: marker, title: `${marker} pushed title` }] }),
  });
  assert.equal(registered.status, 200);
  await turn(client, thread, `${marker} prompt with a tool`);
  assert.ok(client.events(thread).some((event) => event.type === "tool.complete" && JSON.stringify(event.payload).includes(`${marker} tool output`)), "the tool's output had the marker");
  assert.ok(client.events(thread).some((event) => event.type === "message.complete" && event.payload.text.includes(marker)), "the reply had the marker");
  await turn(client, thread, `fail ${marker}`);
  await client.call("session.rename", { session_id: thread, title: `${marker} renamed` });
  await client.call("thread.send", { thread, text: `${marker} sent`, sender: `${marker} sender`, wait: true });
  await client.call("thread.mark", { thread, pinned: true, preview: `${marker} preview` });
  await client.call("thread.read", { thread, last: 5 });
  await client.call("threads.changes", {});
  await client.call("folders.add", { path: added });
  await client.call("folders.list", {});

  // Refusals, whose words name what was asked for.
  await refused(client.call(`${marker}.method`, { text: marker }));
  await refused(client.call("session.create", { profile: marker, model: `${marker}-model` }));
  await refused(client.call("session.create", { profile: `${marker}-nobody` }));
  await refused(client.call("thread.read", { thread: `${marker}-unknown` }));
  await refused(client.call("folders.add", { path: join(scratch, `${marker} missing`) }));

  // Through the link, whose name is the marker: a listing, a read, a send with a wait, and a refusal over there.
  const listed = await client.call("threads.list", {});
  assert.ok(listed.threads.some((entry: Frame) => entry.id === `${link}/${farThread}`), "the linked Mac's thread is listed");
  await client.call("thread.read", { thread: `${link}/${farThread}` });
  await client.call("thread.send", { thread: `${link}/${farThread}`, text: `${marker} sent over`, wait: true });
  await refused(client.call("thread.read", { thread: `${link}/${marker}-unknown` }));
  await refused(client.call("thread.read", { thread: `${marker}-nomac/thread` }));
  await client.call("thread.delete", { thread });

  await client.close();
  await there.close();
  await near.close();
  await far.close();
  assert.ok(existsSync(`${near.file}.1`), "the file was rotated");

  const files = [`${near.file}.1`, near.file];
  const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
  const lines = files.flatMap(linesOf);
  // The script was counted, so the file is not clean for being empty.
  assert.ok(total(lines, "rpc", "thread.send", "n") >= 2 && total(lines, "links", "0", "n") >= 3 && total(lines, "turns", "ended") >= 3 && total(lines, "http", "push", "n") >= 2);
  assert.ok(total(lines, "rpc", "other", "n") >= 1 && total(lines, "files", "fake", "w") >= 1 && total(lines, "threads", "removed") === 1);

  const lower = text.toLowerCase();
  const never = [marker, near.home, far.home, scratch, realpathSync(tmpdir()), tmpdir(), hostname(), hostname().replace(/\.local$/, ""), userInfo().username, userInfo().homedir, token, thread, farThread, username];
  for (const word of never) {
    if (word.length < 4) continue;
    assert.ok(!lower.includes(word.toLowerCase()), `the file does not hold ${word}`);
  }
  for (const line of lines) assertOnlyListed(line);
});

test("the writer keeps only plain keys with finite numbers under them", async (t) => {
  const gauges = () => ({ conns: 2, "Not A Key": 1, "with/slash": 1, [`${marker}`]: 1, endless: Infinity, missing: NaN, words: "text" as unknown as number, nested: { a: { b: { c: 1 } } } as unknown as number });
  const bridge = await start(t, { counters: { gauges } });
  const [line] = await until(() => (linesOf(bridge.file).length > 0 ? linesOf(bridge.file) : undefined));
  assert.deepEqual(line.now, { conns: 2 });
});

// MARK: Off

/** A script of calls as a device makes them; returns every frame the device received. */
async function script(bridge: RunningBridge): Promise<Frame[]> {
  const client = await TestClient.open(bridge);
  const thread = await createThread(client, { title: "Counted or not" });
  await turn(client, thread, "think, then use a tool");
  await client.call("thread.mark", { thread, pinned: true });
  await client.call("threads.changes", {});
  await client.call("session.rename", { session_id: thread, title: "Renamed" });
  await client.call("sessions.activity", {});
  await client.call("thread.read", { thread });
  await client.request("no.such.method", {});
  await client.call("thread.delete", { thread });
  await client.close();
  return client.frames;
}

/** Frames with what differs from one run to the next evened out: ids, the run's epoch, the list's id, times, and the scripted agent's made-up usage, which counts the digits of its times. */
function evened(frames: Frame[]): string[] {
  const ids = new Map<string, string>();
  return frames.map((frame) =>
    JSON.stringify(frame)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}|[0-9a-f]{16}/g, (id) => ids.get(id) ?? (ids.set(id, `<id ${ids.size + 1}>`), ids.get(id)!))
      .replace(/"(updated|created|timestamp|context_used|seconds|tokens)":\d+(\.\d+)?/g, '"$1":0'),
  );
}

test("with the switch off there is no file, no timer and no counting, and a device sees what it sees with it on", async (t) => {
  const watch = watchCounting(t);
  const off = await start(t, { key: null });
  assert.deepEqual(counters.state(), { on: false, ticking: false, monitoring: false, sampling: false, rows: 0 });
  const frames = await script(off);
  // Turned on in the file while it runs: a bridge started off never reads it again.
  writeFileSync(join(off.home, "config.json"), JSON.stringify(await configFor(undefined)));
  await sleep(150);
  assert.deepEqual(counters.state(), { on: false, ticking: false, monitoring: false, sampling: false, rows: 0 });
  assert.equal(counters.on, false);
  assert.deepEqual(watch.called, []);
  assert.deepEqual(readdirSync(off.home).filter((name) => name.startsWith("counters")), []);
  await off.dispose();

  // The same script with them on, the real functions back in place.
  watch.restore();
  const on = await start(t);
  const counted = await script(on);
  await until(() => linesOf(on.file).length > 0);
  assert.ok(total(linesOf(on.file), "rpc", "prompt.submit", "n") === 1, "the second run was counted");
  assert.deepEqual(evened(counted), evened(frames));
});

test("a counters key that cannot be used is off, with one warning that quotes nothing", async (t) => {
  const log = logLines(t);
  for (const key of ["yes", ["enabled"], { enabled: "yes" }, 1]) {
    log.length = 0;
    const bridge = await start(t, { key, config: { someSecret: "hunter2-not-for-the-log" } });
    assert.deepEqual(counters.state(), { on: false, ticking: false, monitoring: false, sampling: false, rows: 0 });
    const client = await TestClient.open(bridge);
    assert.deepEqual(await client.call("gateway.ping"), { ok: true });
    await client.close();
    assert.equal(existsSync(bridge.file), false);
    const warnings = log.filter((line) => line.includes("counters"));
    assert.equal(warnings.length, 1, JSON.stringify(key));
    assert.match(warnings[0], /warn  counters in config\.json is not \{"enabled": true\} or \{"enabled": false\}, so the counters are off\n$/);
    assert.ok(!log.join("").includes("hunter2") && !log.join("").includes("scrypt"));
    await bridge.dispose();
  }
  // Off said plainly is not worth a word.
  log.length = 0;
  const off = await start(t, { key: { enabled: false } });
  assert.equal(log.filter((line) => line.includes("counters")).length, 0);
  await off.dispose();
});

// MARK: The file

test("the file is rotated at its cap: two files at most, each within the cap, every line whole", async (t) => {
  const capBytes = 1500;
  const bridge = await start(t, { counters: { seconds: 0.02, capBytes } });
  const older = `${bridge.file}.1`;
  const seen = new Set<string>();
  await until(() => {
    if (existsSync(older)) seen.add(readFileSync(older, "utf8").split("\n")[0]);
    return seen.size >= 3;
  }, 20_000);
  await bridge.close();
  for (const file of [bridge.file, older]) {
    const text = readFileSync(file, "utf8");
    assert.ok(statSync(file).size <= capBytes, `${file} is within the cap`);
    assert.ok(text.endsWith("\n"));
    const lines = linesOf(file);
    assert.ok(lines.length >= 1);
    assert.equal(text.split("\n").length - 1, lines.length, "no line is cut in two or empty");
    for (const line of lines) assert.equal(line.v, 1);
  }
  assert.deepEqual(readdirSync(dirname(bridge.file)).filter((name) => name.startsWith("counters")).sort(), ["counters.log", "counters.log.1"]);
  assert.equal(statSync(bridge.file).mode & 0o777, 0o600);
});

test("a line that cannot be written is dropped, the bridge works on, and the next line that can says how many were", async (t) => {
  const log = logLines(t);
  const folder = mkdtempSync(join(realpathSync(tmpdir()), "counters-unwritable-"));
  t.after(() => {
    chmodSync(folder, 0o700);
    rmSync(folder, { recursive: true, force: true });
  });
  chmodSync(folder, 0o500);
  const file = join(folder, "counters.log");
  const bridge = await start(t, { counters: { file } });
  const client = await TestClient.open(bridge);
  const thread = await createThread(client);
  await turn(client, thread, "while the file cannot be written");
  // Ticks pass, nothing is kept for later, and calls are answered.
  await sleep(150);
  await until(() => counters.state().rows === 0);
  assert.deepEqual(await client.call("gateway.ping"), { ok: true });
  assert.equal(existsSync(file), false);
  assert.equal(counters.on, true);
  assert.equal(log.filter((line) => line.includes("could not be written")).length, 1);
  assert.match(log.find((line) => line.includes("could not be written"))!, /"error":"EACCES"/);

  chmodSync(folder, 0o700);
  const lines = await until(() => (linesOf(file).length >= 2 ? linesOf(file) : undefined));
  assert.ok(lines[0].dropped >= 3, "the first line written says how many were dropped");
  assert.equal(lines[1].dropped, undefined);
  // What was counted while it could not be written is gone, not piled up.
  assert.equal(total(lines, "turns", "ended"), 0);
  assert.ok(readFileSync(file, "utf8").startsWith("{"), "a new file starts with its first line");
  assert.equal(log.filter((line) => line.includes("could not be written")).length, 1);
  assert.equal(log.filter((line) => line.includes("is written again")).length, 1);
  await client.close();
});

test("a line after half a line starts on a line of its own, also when the half is from before the bridge started", async (t) => {
  // What a write that failed part way leaves (a full disk), found by the next bridge to start.
  const half = '{"v":1,"t":"2026-10-12T00:00:00.000Z","s":60,"up":120,"tick_';
  const whole = `${JSON.stringify({ v: 1, t: "2026-10-12T00:00:00.000Z", s: 60, up: 60, tick_ms: 1 })}\n`;
  const bridge = await start(t, { prepare: (home) => writeFileSync(join(home, "counters.log"), whole + half) });
  await until(() => readFileSync(bridge.file, "utf8").split("\n").length >= 5);
  await bridge.close();
  const [first, broken, ...rest] = readFileSync(bridge.file, "utf8").split("\n");
  assert.equal(`${first}\n`, whole);
  assert.equal(broken, half, "the half line is left as it was, with nothing joined to it");
  assert.equal(rest.pop(), "");
  assert.ok(rest.length >= 3);
  // Every line of this bridge's is whole, the first among them, and no line is empty.
  for (const line of rest) assert.equal(JSON.parse(line).v, 1);
  assert.equal(JSON.parse(rest[0]).up < 1, true, "the first line this bridge wrote is there");
});

test("a file made before with other permissions is the owner's alone from the first line on, and so is the older file", async (t) => {
  const earlier = `${JSON.stringify({ v: 1, t: "2026-10-12T00:00:00.000Z", s: 60, up: 60, tick_ms: 1 })}\n`;
  const bridge = await start(t, {
    counters: { capBytes: 1500 },
    prepare: (home) => {
      writeFileSync(join(home, "counters.log"), earlier);
      chmodSync(join(home, "counters.log"), 0o644);
    },
  });
  await until(() => linesOf(bridge.file).length >= 2 || existsSync(`${bridge.file}.1`));
  assert.equal(statSync(bridge.file).mode & 0o777, 0o600);
  await until(() => existsSync(`${bridge.file}.1`));
  assert.equal(statSync(`${bridge.file}.1`).mode & 0o777, 0o600);
  assert.equal(statSync(bridge.file).mode & 0o777, 0o600);
});

test("a file put in the counters' file's place as it is rotated is not written to: that line is dropped and the next finds it as any file", async (t) => {
  const log = logLines(t);
  // What somebody else made there between the rename and the new file: nearly full, not the owner's alone, ending in half a line.
  const stranger = `{"unfinished":${" ".repeat(1386)}`;
  const bridge = await start(t, { counters: { capBytes: 1500 } });
  // Every rotation, with what the file held and its mode as it was moved aside. After the first, the stranger's file is in its place.
  const moved: { text: string; mode: number }[] = [];
  const rename = fs.renameSync;
  const restore = () => {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  };
  t.after(restore);
  fs.renameSync = ((from, to) => {
    if (from !== bridge.file) return rename(from, to);
    moved.push({ text: readFileSync(bridge.file, "utf8"), mode: statSync(bridge.file).mode & 0o777 });
    rename(from, to);
    if (moved.length > 1) return;
    writeFileSync(bridge.file, stranger);
    chmodSync(bridge.file, 0o644);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  await until(() => moved.length >= 3, 20_000);
  restore();

  // Nothing was joined to it and it never went past the cap; it was the owner's alone before it became the older file.
  assert.equal(moved[1].text, stranger);
  assert.equal(moved[1].mode, 0o600);
  // The file after it: whole lines, the first of them saying that one was dropped.
  assert.ok(moved[2].text.endsWith("\n") && moved[2].text.length <= 1500);
  const lines = moved[2].text.split("\n").slice(0, -1).map((line) => JSON.parse(line) as Line);
  assert.deepEqual(lines.map((line) => line.dropped), [1, ...lines.slice(1).map(() => undefined)]);
  assert.equal(log.filter((line) => line.includes("could not be written")).length, 1);
  assert.match(log.find((line) => line.includes("could not be written"))!, /"error":"EEXIST"/);
  assert.equal(log.filter((line) => line.includes("is written again")).length, 1);
  assert.equal(counters.on, true);
});

test("the Pi processes a bridge starts are counted as pi", async (t) => {
  const pi = standin();
  t.after(async () => {
    await until(() => pi.alive().length === 0);
    pi.dispose();
  });
  // Asked for its models as the bridge starts: one short-lived process.
  const bridge = await start(t, { providers: new Map<string, Provider>([["pi", piProvider(pi, { folder: realpathSync(tmpdir()) })]]) });
  await until(() => total(linesOf(bridge.file), "spawn", "pi") >= 1);
});

test("a tick leaves no file open: lines, rotations, and a pipe or a folder in the file's place", async (t) => {
  // A file left open a minute would in a few hours be more than a process may hold.
  const open = () => readdirSync("/dev/fd").length;
  const bridge = await start(t, { counters: { seconds: 0.02, capBytes: 1500, ps: "/no/such/ps" } });
  // A pipe held open here at its other end, so that nothing in this process could wait on it.
  const pipe = `${bridge.file}.pipe`;
  await run("/usr/bin/mkfifo", [pipe]);
  const held = openSync(pipe, constants.O_RDWR | constants.O_NONBLOCK);
  t.after(() => closeSync(held));
  await until(() => linesOf(bridge.file).length >= 1 && !counters.state().sampling);
  const before = open();

  // Lines, and a rotation every few of them.
  await until(() => existsSync(`${bridge.file}.1`));
  await sleep(200);
  assert.equal(open(), before, "after lines and rotations");

  // A pipe in the file's place, then a folder: every line is dropped.
  rmSync(bridge.file);
  renameSync(pipe, bridge.file);
  await sleep(200);
  assert.ok(statSync(bridge.file).isFIFO());
  assert.equal(open(), before, "with a pipe in the file's place");
  rmSync(bridge.file);
  mkdirSync(bridge.file);
  await sleep(200);
  assert.equal(open(), before, "with a folder in the file's place");
  rmSync(bridge.file, { recursive: true });
  const line = await until(() => linesOf(bridge.file).find((entry) => entry.dropped));
  assert.ok(line.dropped >= 10, `the lines were dropped meanwhile: ${line.dropped}`);
  assert.equal(open(), before, "and with lines written again");
});

test("a line longer than the file may be is dropped, not written past the cap", async (t) => {
  const log = logLines(t);
  const capBytes = 1500;
  const bridge = await start(t, { counters: { capBytes } });
  await until(() => linesOf(bridge.file).length >= 1);
  // A call of every method in one tick: a line of about 3000 bytes.
  for (const method of Object.keys(methods)) counters.rpc(method, "app", 100.5, 10_000, 10_000, false, false);
  // Every line of the ticks after it, from both files: the file is rotated every few lines.
  const lines = new Map<string, Line>();
  let largest = 0;
  const ends = Date.now() + 300;
  while (Date.now() < ends) {
    for (const file of [bridge.file, `${bridge.file}.1`]) {
      if (!existsSync(file)) continue;
      largest = Math.max(largest, statSync(file).size);
      for (const line of linesOf(file)) lines.set(JSON.stringify(line), line);
    }
    await sleep(2);
  }
  assert.ok(largest <= capBytes, `the files stayed within ${capBytes} bytes: ${largest}`);
  assert.equal(total([...lines.values()], "rpc", "gateway.ping", "n"), 0, "the long line is not in the file");
  assert.equal(total([...lines.values()], "dropped"), 1, "and the next line says one was dropped");
  assert.equal(log.filter((line) => line.includes("could not be written")).length, 1);
  assert.equal(log.filter((line) => line.includes("is written again")).length, 1);
  assert.equal(counters.on, true);
});

test("the counters cannot keep the bridge from starting, whatever is wrong with their file, their tick or their ps", async (t) => {
  const log = logLines(t);
  const answers = async (bridge: Counted) => {
    const client = await TestClient.open(bridge);
    assert.deepEqual(await client.call("gateway.ping"), { ok: true });
    await client.close();
  };

  // The file's place is a folder.
  const folder = await start(t, { prepare: (home) => mkdirSync(join(home, "counters.log")) });
  await answers(folder);
  await until(() => log.some((line) => line.includes("could not be written")));
  await folder.dispose();

  // Its folder is a file.
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "a-file"), "x");
  const underFile = await start(t, { counters: { file: join(home, "a-file", "counters.log") } });
  await answers(underFile);
  await underFile.dispose();

  // Its folder cannot be read or searched.
  const closed = join(home, "closed");
  mkdirSync(closed, { mode: 0o000 });
  try {
    const unreadable = await start(t, { counters: { file: join(closed, "counters.log") } });
    await answers(unreadable);
    await unreadable.dispose();
  } finally {
    chmodSync(closed, 0o700);
  }

  // A tick length that is no length, or longer than a timer can be (about 24.8 days): a
  // minute, not Node's 1 ms for a bad interval.
  for (const seconds of ["abc", 0, -1, Number.NaN, Infinity, 2_147_484, "3000000", 1e300]) {
    const bridge = await start(t, { counters: { seconds: seconds as number } });
    assert.equal(counters.state().ticking, true);
    await answers(bridge);
    await sleep(60);
    assert.deepEqual(linesOf(bridge.file), [], `no line yet with a tick of ${seconds}`);
    await bridge.dispose();
  }

  // A ps that is not there: lines without the child processes.
  const noPs = await start(t, { counters: { ps: join(home, "no-such-ps") } });
  await answers(noPs);
  const lines = await until(() => (linesOf(noPs.file).length >= 3 ? linesOf(noPs.file) : undefined));
  assert.ok(lines.every((line) => line.kids === undefined));
  assert.equal(counters.on, true);
  await noPs.dispose();
  assert.equal(log.filter((line) => line.includes("fault of their own")).length, 0);
});

test("a ps that answers gives the bridge's child processes, without itself", async (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // A listing with this process's pid in it: two children, one of them with a child, and a stranger.
  const ps = join(home, "ps");
  writeFileSync(ps, `#!/bin/sh\nprintf '%s\\n' "  10 ${process.pid} 2048" "  11 ${process.pid} 1024" "  12 10 512" "  13 1 99999" "  $$ ${process.pid} 4096"\n`, { mode: 0o755 });
  const bridge = await start(t, { counters: { ps } });
  const line = await until(() => linesOf(bridge.file).find((entry) => entry.kids));
  // 2048 + 1024 + 512 kilobytes; the listing's own process is left out.
  assert.deepEqual({ n: line.kids.n, rss: line.kids.rss }, { n: 3, rss: 3.5 });
  // How long the listing's answer took to come, by the clock: no more than a range can be said of it.
  assert.ok(line.kids.ps_ms > 0 && line.kids.ps_ms < 5000, `ps_ms: ${line.kids.ps_ms}`);
});

// MARK: Stopping

test("stopping is not held up: a last line for the part of the minute, and nothing left running", async (t) => {
  // The real tick, a minute: only the last line is written.
  const bridge = await start(t, { counters: { seconds: undefined } });
  assert.deepEqual({ ...counters.state(), rows: 0, sampling: false }, { on: true, ticking: true, monitoring: true, sampling: false, rows: 0 });
  const client = await TestClient.open(bridge);
  await client.call("gateway.ping");
  await client.close();
  const began = Date.now();
  await bridge.close();
  assert.ok(Date.now() - began < 1500, "close returns promptly");
  assert.deepEqual(counters.state(), { on: false, ticking: false, monitoring: false, sampling: false, rows: 0 });
  const lines = linesOf(bridge.file);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].s < 30 && lines[0].late === undefined);
  assert.equal(lines[0].rpc["gateway.ping"].n, 1);
});

test("close finishes what it has to do when the last line cannot be written", async (t) => {
  const bridge = await start(t, { counters: { seconds: undefined }, prepare: (home) => mkdirSync(join(home, "counters.log")) });
  const socket = pathsFor(bridge.home).socket;
  assert.ok(existsSync(socket));
  await bridge.close();
  assert.equal(existsSync(socket), false, "the portals command's socket is gone");
  await assert.rejects(fetch(`${bridge.url}/api/status`), "the port is closed");
  assert.deepEqual(counters.state(), { on: false, ticking: false, monitoring: false, sampling: false, rows: 0 });
});

test("a bridge run as a process writes its lines and stops within two seconds of SIGTERM, with a last line", async (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "config.json"), JSON.stringify(await configFor(undefined)));
  const child = spawn(process.execPath, [main], { env: { ...process.env, PORTALS_BRIDGE_HOME: home, PORTALS_BRIDGE_LOG: "info", PORTALS_BRIDGE_COUNTERS_SECONDS: "0.05" }, stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => void child.kill("SIGKILL"));
  let output = "";
  child.stderr.on("data", (data: Buffer) => (output += data.toString()));
  await until(() => output.includes("listening on"), 20_000);
  assert.match(output, /counters on: a line every 0\.05 s in .*counters\.log\n/);
  const file = pathsFor(home).counters;
  await until(() => linesOf(file).length >= 2);
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const began = Date.now();
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.ok(Date.now() - began < 2000, "it stopped within two seconds");
  const lines = linesOf(file);
  // The last line counts the line the bridge logged as it stopped.
  assert.ok(lines.at(-1)!.log.n >= 1);
  for (const line of lines) assertOnlyListed(line);
});

test("a named pipe in place of the counters' file, or of config.json, holds the bridge up no more than a file would", async (t) => {
  // Opening a pipe nobody reads waits for ever, and a bridge waiting there answers
  // nobody and cannot be stopped. So this bridge is a process: one that hangs is killed.
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = join(home, "config.json");
  writeFileSync(config, JSON.stringify(await configFor(undefined)));
  const file = pathsFor(home).counters;
  await run("/usr/bin/mkfifo", [file]);
  const child = spawn(process.execPath, [main], { env: { ...process.env, PORTALS_BRIDGE_HOME: home, PORTALS_BRIDGE_LOG: "info", PORTALS_BRIDGE_COUNTERS_SECONDS: "0.05" }, stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => void child.kill("SIGKILL"));
  let output = "";
  child.stderr.on("data", (data: Buffer) => (output += data.toString()));
  const url = (await until(() => /listening on (http:\S+)/.exec(output), 20_000))[1];
  const answers = async () => (await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(3000) })).status;

  // Ticks pass with the pipe in the file's place: the lines are dropped, with one warning.
  await until(() => output.includes("could not be written"));
  await sleep(200);
  assert.equal(await answers(), 200);
  assert.equal(output.split("could not be written").length - 1, 1);
  assert.ok(statSync(file).isFIFO(), "the pipe is left as it was");

  // A plain file again: lines. Then config.json becomes a pipe: the counters stay as they were.
  rmSync(file);
  await until(() => linesOf(file).length >= 2);
  rmSync(config);
  await run("/usr/bin/mkfifo", [config]);
  const before = linesOf(file).length;
  await until(() => linesOf(file).length >= before + 3);
  assert.equal(await answers(), 200);

  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const began = Date.now();
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.ok(Date.now() - began < 2000, "it stopped within two seconds");
  assert.ok(!output.includes("fault of their own"));
});

/** Runs a command to its end. */
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(command, args, (error) => (error ? reject(error) : resolve())));
}

// MARK: The switch while running

test("counters started on are turned off and on again by editing config.json, with no restart", async (t) => {
  const log = logLines(t);
  const bridge = await start(t);
  const config = join(bridge.home, "config.json");
  const set = async (key: unknown) => writeFileSync(config, JSON.stringify(await configFor(key)));
  const client = await TestClient.open(bridge);
  await until(() => linesOf(bridge.file).length >= 2);
  assert.equal(log.filter((line) => line.includes(`counters on: a line every 0.03 s in ${bridge.file}`)).length, 1);
  assert.ok(total(linesOf(bridge.file), "log", "n") >= 1, "the bridge's own log lines are counted");

  // Off: one last line, then none; only the tick is left, and nothing is counted.
  await set({ enabled: false });
  await until(() => !counters.on);
  const after = linesOf(bridge.file).length;
  assert.deepEqual(counters.state(), { on: false, ticking: true, monitoring: false, sampling: false, rows: 0 });
  const watch = watchCounting(t);
  await client.call("gateway.ping");
  await sleep(120);
  assert.deepEqual(watch.called, []);
  assert.equal(linesOf(bridge.file).length, after);
  assert.equal(log.filter((line) => line.endsWith("counters off\n")).length, 1);
  watch.restore();
  // A device that connects while they are off.
  const later = await TestClient.open(bridge);

  // Not JSON while it is edited: as they were, here off.
  writeFileSync(config, '{ "counters": { "enabled": tr');
  await sleep(100);
  assert.equal(counters.on, false);

  // On again: lines begin again.
  await set({ enabled: true });
  await until(() => counters.on && linesOf(bridge.file).length >= after + 2);
  assert.equal(counters.state().monitoring, true);
  assert.equal(log.filter((line) => line.includes("counters on:")).length, 2);
  // The device that connected meanwhile is counted as a device, not as a linked Mac.
  const lines = await counted(bridge.file, async () => {
    await later.call("gateway.ping");
    await later.close();
  });
  assert.deepEqual({ app: total(lines, "rpc_by", "app", "n"), link: total(lines, "rpc_by", "link", "n") }, { app: 1, link: 0 });
  assert.deepEqual({ app: total(lines, "conn", "closed", "app"), link: total(lines, "conn", "closed", "link") }, { app: 1, link: 0 });

  // Not JSON while on: they stay on.
  writeFileSync(config, "{");
  const during = linesOf(bridge.file).length;
  await until(() => linesOf(bridge.file).length >= during + 2);
  assert.equal(counters.on, true);

  // A value that cannot be used: off, said once however many ticks pass.
  await set("yes");
  await until(() => !counters.on);
  await sleep(120);
  assert.equal(log.filter((line) => line.includes("so the counters are off")).length, 1);
  assert.deepEqual(await client.call("gateway.ping"), { ok: true });
  await client.close();
});

test("a fault in the counters turns them off with one warning and costs the call being counted nothing", async (t) => {
  const log = logLines(t);
  const faults = () => log.filter((line) => line.includes("fault of their own")).length;

  // A gauge that throws, at the tick.
  const first = await start(t, {
    counters: {
      gauges: () => {
        throw new Error("a gauge broke");
      },
    },
  });
  await until(() => !counters.on);
  await sleep(100);
  assert.equal(faults(), 1);
  assert.deepEqual(counters.state(), { on: false, ticking: true, monitoring: false, sampling: false, rows: 0 });
  const client = await TestClient.open(first);
  assert.deepEqual(await client.call("gateway.ping"), { ok: true });
  await client.close();
  await first.dispose();

  // A counting function that throws, in the middle of a call.
  log.length = 0;
  const second = await start(t, { counters: { seconds: 60 } });
  const own = counters as unknown as Record<string, unknown>;
  own.row = () => {
    throw new Error("a table broke");
  };
  t.after(() => delete own.row);
  assert.equal(counters.on, true);
  const device = await TestClient.open(second);
  const thread = await createThread(device);
  await turn(device, thread, "counted until the counters broke");
  assert.deepEqual(await device.call("gateway.ping"), { ok: true });
  assert.equal(counters.on, false);
  assert.equal(faults(), 1);
  delete own.row;
  await device.close();
});

test("of two bridges in one process the first holds the counters, and only its stopping stops them", async (t) => {
  const first = await start(t);
  const second = await start(t);
  // The second's traffic goes into the first's line; it has no file of its own.
  const client = await TestClient.open(second);
  const lines = await counted(first.file, () => client.call("gateway.ping"));
  assert.equal(total(lines, "rpc", "gateway.ping", "n"), 1);
  assert.equal(existsSync(second.file), false);
  await client.close();
  await second.dispose();
  assert.equal(counters.state().ticking, true);
  const before = linesOf(first.file).length;
  await until(() => linesOf(first.file).length > before);
  await first.dispose();
  assert.deepEqual(counters.state(), { on: false, ticking: false, monitoring: false, sampling: false, rows: 0 });
});

test("a line written long after the last, as when the Mac slept, says so and gives no event-loop delay", async (t) => {
  let ahead = 0;
  const began = Date.now();
  const bridge = await start(t, { counters: { seconds: 2.6, clock: () => Date.now() + ahead } });
  /** Holds the event loop from `from` ms after the start for 700 ms. */
  const hold = async (from: number) => {
    await sleep(Math.max(began + from - Date.now(), 0));
    const ends = Date.now() + 700;
    while (Date.now() < ends);
  };
  // The monitor's one-second timer measures from its first run to its second, two
  // seconds after the start (and again after each line): the loop is held across that.
  await hold(1500);
  const [first] = await until(() => (linesOf(bridge.file).length >= 1 ? linesOf(bridge.file) : undefined));
  assert.equal(first.late, undefined);
  assert.ok(first.s >= 2.5 && first.s < 3.5);
  assert.ok(first.proc.loop_max > 50, `a held loop shows: ${first.proc.loop_max}`);

  // An hour passes on the clock; the loop is held as before, and it is not read as a delay.
  ahead = 3_600_000;
  await hold(4000);
  const second = (await until(() => (linesOf(bridge.file).length >= 2 ? linesOf(bridge.file) : undefined)))[1];
  assert.equal(second.late, 1);
  assert.ok(second.s >= 3600 && second.s < 3610);
  assert.equal(second.proc.loop_max, undefined);
  assert.ok(second.up >= 3600);
});

// MARK: The numbers

test("a known script gives known counts, in bytes", async (t) => {
  const near = await start(t);
  const far = await start(t, { key: null });
  writeLinks(pathsFor(near.home).links, [{ name: "far", url: far.url, user: username, password }]);
  const there = await TestClient.open(far);
  const farThread = await createThread(there);
  await runTurn(there, farThread, "over there");

  // A connection as the app makes it, and calls with their bytes each way.
  let client!: TestClient;
  let lines = await counted(near.file, async () => {
    client = await TestClient.open(near);
  });
  assert.equal(total(lines, "conn", "opened", "net"), 1);
  assert.equal(total(lines, "out", "ready", "n"), 1);
  assert.equal(total(lines, "out", "ready", "bytes"), Buffer.byteLength(JSON.stringify(client.frames[0])));
  assert.equal(total(lines, "http", "login", "n"), 1);
  assert.equal(total(lines, "http", "ticket", "n"), 1);
  assert.equal(total(lines, "http", "login", "in"), Buffer.byteLength(JSON.stringify({ provider: "basic", username, password })));
  assert.equal(total(lines, "http", "login", "out"), Buffer.byteLength(JSON.stringify({ ok: true })));
  assert.equal(total(lines, "rpc", "client.capabilities", "n"), 1);
  assert.equal(total(lines, "rpc_by", "app", "n"), 1);

  const sent = { out: 0, in: 0 };
  lines = await counted(near.file, async () => {
    for (let index = 0; index < 5; index += 1) {
      const call = await weighed(client, "sessions.activity", { note: "héllo 你好 🎈" }, `w${index}`);
      sent.out += call.out;
      sent.in += call.in;
    }
  });
  assert.deepEqual(
    { n: total(lines, "rpc", "sessions.activity", "n"), in: total(lines, "rpc", "sessions.activity", "in"), out: total(lines, "rpc", "sessions.activity", "out") },
    { n: 5, in: sent.out, out: sent.in },
  );
  // Calls may span several samples under load: maxima are not additive.
  assert.equal(Math.max(...lines.map((line) => total([line], "rpc", "sessions.activity", "out_max"))), sent.in / 5);
  assert.equal(total(lines, "rpc_by", "app", "n"), 5);
  assert.equal(total(lines, "out", "answers", "bytes"), sent.in);
  assert.equal(total(lines, "rpc", "sessions.activity", "err"), 0);

  // A thread with a title that is not ASCII, and a turn in it.
  let thread = "";
  lines = await counted(near.file, async () => {
    thread = await createThread(client, { title: "Ünïcödé 标题 🎈" });
  });
  assert.equal(total(lines, "threads", "added"), 1);
  assert.equal(total(lines, "files", "threads", "w"), 1);
  assert.equal(total(lines, "files", "threads", "w_bytes"), statSync(pathsFor(near.home).threads).size, "bytes, not characters");
  assert.equal(total(lines, "rpc", "session.create", "n"), 1);

  lines = await counted(near.file, () => turn(client, thread, "héllo 你好 🎈, with a tool"));
  assert.equal(total(lines, "turns", "started"), 1);
  assert.equal(total(lines, "turns", "ended"), 1);
  // The start, the title the agent gave, and the end.
  assert.equal(total(lines, "files", "threads", "w"), 3);
  assert.ok(total(lines, "files", "fake", "w") >= 1);
  const events = client.events(thread).length;
  assert.equal(total(lines, "emit", "n"), events);
  assert.equal(total(lines, "out", "events", "n"), events);
  assert.equal(total(lines, "rpc", "prompt.submit", "n"), 1);

  // threads.changes: everything, nothing, one.
  const list = (await client.call("threads.changes", {})).list;
  lines = await counted(near.file, async () => {
    await client.call("threads.changes", {});
    await client.call("threads.changes", { list: list.id, since: list.revision });
    await client.call("thread.mark", { thread, pinned: true });
    await client.call("threads.changes", { list: list.id, since: list.revision });
  });
  assert.deepEqual(
    { full: total(lines, "changes", "full"), empty: total(lines, "changes", "empty"), delta: total(lines, "changes", "delta"), threads: total(lines, "changes", "threads") },
    { full: 1, empty: 1, delta: 1, threads: 2 },
  );
  assert.equal(total(lines, "files", "threads", "w"), 1);
  assert.equal(total(lines, "files", "threads", "w_bytes"), statSync(pathsFor(near.home).threads).size);
  assert.equal(lines.at(-1)!.now.threads, 1);
  assert.equal(lines.at(-1)!.now.loaded, 1);
  assert.equal(lines.at(-1)!.now.conns, 1);
  assert.equal(lines.at(-1)!.now.revision, (await client.call("threads.changes", {})).list.revision);

  // A refusal is an error, and a method the bridge does not have is `other`.
  lines = await counted(near.file, async () => {
    await client.request("thread.read", { thread: "no-such-thread" });
    await client.request("made.up", {});
  });
  assert.equal(total(lines, "rpc", "thread.read", "err"), 1);
  assert.deepEqual({ n: total(lines, "rpc", "other", "n"), err: total(lines, "rpc", "other", "err") }, { n: 1, err: 1 });

  // A call that waits for a thread has its time kept apart.
  lines = await counted(near.file, () => client.call("thread.send", { thread, text: "answer, please", wait: true }));
  assert.ok(total(lines, "rpc", "thread.send", "wait_ms") > 0);
  assert.equal(total(lines, "rpc", "thread.send", "ms"), 0);
  assert.equal(total(lines, "rpc", "thread.send", "max"), 0);
  assert.equal(lines.at(-1)!.now.waiters, undefined);

  // Through the link: by its place in links.json, with the sign-in the first call makes.
  lines = await counted(near.file, () => client.call("thread.read", { thread: `far/${farThread}` }));
  assert.deepEqual({ n: total(lines, "links", "0", "n"), signins: total(lines, "links", "0", "signins"), err: total(lines, "links", "0", "err") }, { n: 1, signins: 1, err: 0 });
  assert.ok(total(lines, "links", "0", "ms") > 0 && total(lines, "links", "0", "out") > 100 && total(lines, "links", "0", "in") > 400);
  // The far bridge is in this process: its side of the call is in the same line.
  assert.equal(total(lines, "conn", "closed", "link"), 1);
  assert.equal(total(lines, "rpc_by", "link", "n"), 1);
  assert.equal(total(lines, "rpc", "thread.read", "n"), 2);
  lines = await counted(near.file, async () => {
    await client.call("thread.wait", { thread: `far/${farThread}`, timeout_ms: 1000 });
    await client.request("thread.read", { thread: "far/no-such-thread" });
  });
  assert.deepEqual({ n: total(lines, "links", "0", "n"), signins: total(lines, "links", "0", "signins"), err: total(lines, "links", "0", "err") }, { n: 2, signins: 0, err: 1 });
  assert.ok(total(lines, "links", "0", "wait_ms") > 0);

  // The `portals` command, on its socket.
  lines = await counted(near.file, async () => {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [portals, "threads"], { env: { ...process.env, PORTALS_BRIDGE_HOME: near.home } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
    assert.ok(JSON.parse(out).threads.length >= 2);
  });
  assert.deepEqual(
    { opened: total(lines, "conn", "opened", "local"), closed: total(lines, "conn", "closed", "local"), calls: total(lines, "rpc_by", "local", "n") },
    { opened: 1, closed: 1, calls: 1 },
  );

  // Taken off the list.
  lines = await counted(near.file, () => client.call("thread.delete", { thread }));
  assert.equal(total(lines, "threads", "removed"), 1);
  assert.equal(total(lines, "files", "removed", "w"), 1);
  assert.equal(lines.at(-1)!.now.removed, 1);

  lines = await counted(near.file, () => client.close());
  assert.equal(total(lines, "conn", "closed", "app"), 1);
  await there.close();
  for (const line of linesOf(near.file)) assertOnlyListed(line);
});

test("a session loaded from the registry is counted under its agent's kind, with its time", async (t) => {
  const first = await start(t, { key: null, keepHome: true });
  const client = await TestClient.open(first);
  const thread = await createThread(client);
  await turn(client, thread, "before the restart");
  await client.close();
  await first.dispose();

  writeFileSync(join(first.home, "config.json"), JSON.stringify(await configFor(undefined)));
  const again = await start(t, { home: first.home });
  const device = await TestClient.open(again);
  const lines = await counted(again.file, async () => {
    await device.call("thread.read", { thread });
    await device.call("thread.read", { thread });
  });
  assert.equal(total(lines, "load", "fake", "n"), 1);
  assert.ok(total(lines, "load", "fake", "ms") > 0);
  assert.equal(lines.at(-1)!.now.loaded, 1);
  await device.close();
});

test("a call to a linked Mac that fails part way still counts what it sent and the sign-in it tried", async (t) => {
  // A Mac that takes a request whole and hangs up without answering: the sign-in at
  // first, then (signed in) the ticket.
  let hangUpAt = "/auth/password-login";
  let received = 0;
  const server = createServer((request, response) => {
    request.on("data", (chunk: Buffer) => (received += chunk.length));
    request.on("end", () => {
      if (request.url === hangUpAt) response.destroy();
      else response.writeHead(200, { "Content-Type": "application/json", "Content-Length": 11, "Set-Cookie": "session=abc; Path=/" }).end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => void server.close());
  const near = await start(t);
  writeLinks(pathsFor(near.home).links, [{ name: "far", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, user: username, password }]);
  const client = await TestClient.open(near);
  const signInBytes = Buffer.byteLength(JSON.stringify({ provider: "basic", username, password }));

  let lines = await counted(near.file, () => client.request("thread.read", { thread: "far/some-thread" }));
  assert.equal(received, signInBytes, "the other Mac had the whole request");
  assert.deepEqual(
    { n: total(lines, "links", "0", "n"), err: total(lines, "links", "0", "err"), out: total(lines, "links", "0", "out"), signins: total(lines, "links", "0", "signins"), in: total(lines, "links", "0", "in") },
    { n: 1, err: 1, out: signInBytes, signins: 1, in: 0 },
  );

  hangUpAt = "/api/auth/ws-ticket";
  lines = await counted(near.file, () => client.request("thread.read", { thread: "far/some-thread" }));
  assert.deepEqual(
    { n: total(lines, "links", "0", "n"), err: total(lines, "links", "0", "err"), out: total(lines, "links", "0", "out"), signins: total(lines, "links", "0", "signins"), in: total(lines, "links", "0", "in") },
    { n: 1, err: 1, out: signInBytes + 2, signins: 1, in: 11 },
  );
  await client.close();
});

test("a state file that is read but is not JSON is counted as read", async (t) => {
  const bridge = await start(t);
  const folder = temporaryHome();
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // Counted as `hermes`, which this bridge never reads itself.
  const broken = join(folder, "hermes.json");
  writeFileSync(broken, '{ "profiles": [ "héllo", ');
  const missing = join(folder, "elsewhere", "hermes.json");
  const lines = await counted(bridge.file, async () => {
    for (let index = 0; index < 5; index += 1) assert.deepEqual(readJSON(broken, { none: true }), { none: true });
    assert.deepEqual(readJSON(missing, { none: true }), { none: true });
  });
  // The five that were read, in bytes; the one that is not there was no read.
  assert.deepEqual({ r: total(lines, "files", "hermes", "r"), bytes: total(lines, "files", "hermes", "r_bytes") }, { r: 5, bytes: 5 * statSync(broken).size });
});

test("a state file is weighed by the bytes written and read, with no second pass over its text", async (t) => {
  const bridge = await start(t);
  const folder = temporaryHome();
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // Counted as `hermes`, which this bridge never reads or writes itself.
  const file = join(folder, "hermes.json");
  const value = { profiles: ["héllo 你好 🎈", "weighed-once"] };
  // Every text that is weighed apart from being written or read. The counters' own lines hold no one's words.
  const weighed: string[] = [];
  const byteLength = Buffer.byteLength;
  t.after(() => {
    Buffer.byteLength = byteLength;
  });
  Buffer.byteLength = ((text: Parameters<typeof byteLength>[0], encoding?: BufferEncoding) => {
    if (typeof text === "string" && text.includes("weighed-once")) weighed.push(text);
    return byteLength(text, encoding);
  }) as typeof Buffer.byteLength;
  const lines = await counted(bridge.file, async () => {
    for (let index = 0; index < 3; index += 1) {
      writeJSON(file, value);
      assert.deepEqual(readJSON(file, null), value);
    }
  });
  Buffer.byteLength = byteLength;
  const size = statSync(file).size;
  assert.equal(size, byteLength(JSON.stringify(value, null, 1) + "\n"));
  assert.deepEqual(
    { w: total(lines, "files", "hermes", "w"), written: total(lines, "files", "hermes", "w_bytes"), r: total(lines, "files", "hermes", "r"), read: total(lines, "files", "hermes", "r_bytes") },
    { w: 3, written: 3 * size, r: 3, read: 3 * size },
  );
  assert.equal(weighed.length, 0);
});

test("the tables are bounded: made-up methods are one entry, and a link past the sixteenth is `other`", async (t) => {
  const near = await start(t);
  const far = await start(t, { key: null });
  const there = await TestClient.open(far);
  const farThread = await createThread(there);
  const links = Array.from({ length: 16 }, (_, index) => ({ name: `mac-${index}`, url: "http://127.0.0.1:9", user: "nobody", password: "none" }));
  writeLinks(pathsFor(near.home).links, [...links, { name: "last", url: far.url, user: username, password }]);

  const client = await TestClient.open(near);
  const lines = await counted(near.file, async () => {
    await Promise.all(Array.from({ length: 1000 }, (_, index) => client.request(`made.up.${index}`, {})));
    await client.call("thread.read", { thread: `last/${farThread}` });
    // Whatever a caller passes as a key, a table stays small.
    for (let index = 0; index < 500; index += 1) counters.rpc(`key.${index}`, "app", 1, 1, 1, false, false);
  });
  assert.equal(total(lines, "rpc", "other", "n") >= 1000, true);
  assert.equal(total(lines, "links", "other", "n"), 1);
  for (const line of lines) {
    assert.ok(Object.keys(line.rpc ?? {}).length <= 64, `${Object.keys(line.rpc ?? {}).length} rows: ${Object.keys(line.rpc ?? {}).slice(0, 5)}`);
    assert.deepEqual(Object.keys(line.links ?? {}).filter((key) => key !== "other"), []);
  }
  assert.equal(total(lines, "rpc_by", "app", "n"), 1501);
  await client.close();
  await there.close();
});
