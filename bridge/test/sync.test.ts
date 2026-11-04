import assert from "node:assert/strict";
import fs, { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathsFor } from "../src/config.ts";
import { Fleet, shortSender } from "../src/fleet/fleet.ts";
import { Links } from "../src/fleet/links.ts";
import { Folders } from "../src/folders.ts";
import { setLogLevel } from "../src/log.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { AdoptMode, DeskAdoption, Provider, ProviderSession, SessionOptions, SessionSink, StoredMessage, ThreadMode } from "../src/providers/types.ts";
import { RemoveRefused, SessionManager } from "../src/sessions/manager.ts";
import { lastPreview, previewOf } from "../src/sessions/preview.ts";
import { Registry, type ThreadChanges, type ThreadRecord } from "../src/sessions/registry.ts";
import { Session } from "../src/sessions/session.ts";
import { createThread, isEvent, runTurn, sessionCookie, startTestBridge, temporaryHome, TestClient, type Frame, type RpcFailure, type TestBridge } from "./helpers.ts";

// The list every device shows (feature thread_sync, docs/sync-plan.md): the bridge's
// own threads with their pins, archive and unseen marks, previews and who started them.
// Two clients stand for two devices: one changes threads, the other asks what changed
// since the revision it holds, as the app does at each poll.

const unknown = (error: RpcFailure) => error.code === 4007;
const invalid = (error: RpcFailure) => error.code === -32602;

/** The scripted agent, with modes and sessions from the desk to take up, as Claude Code has. */
class DeskFake extends FakeProvider {
  readonly supportsModes = true;
  readonly directory: string;

  constructor(directory: string) {
    // Slow enough that a `slow` turn is still running when the next call arrives.
    super({ directory, delayMs: 3 });
    this.directory = directory;
  }

  override async startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    return withModes(await super.startSession(options, sink), options);
  }

  override async resumeSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    return withModes(await super.resumeSession(options, sink), options);
  }

  async adopt(id: string, _mode: AdoptMode): Promise<DeskAdoption> {
    return { id, cwd: realpathSync(tmpdir()), title: "From the desk", settings: { model: "fake-1", provider: "fake", reasoningEffort: "medium" } };
  }

  /** A session started at the desk, with what was said in it. */
  deskSession(id: string, messages: StoredMessage[]): void {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(join(this.directory, `${id}.json`), JSON.stringify({ messages, titled: true }));
  }
}

function withModes(session: ProviderSession, options: SessionOptions): ProviderSession {
  let mode: ThreadMode = options.mode ?? "default";
  return Object.assign(session, {
    mode: () => ({ mode }),
    setMode: async (next: ThreadMode) => {
      mode = next;
    },
  });
}

/**
 * An agent like Codex, whose turns can run without the bridge: a thread taken up or
 * loaded may have a turn running in it, opened by `running`, which ends while the
 * thread is still being taken up when `endsAtOnce` (Codex hands over what it held back
 * as soon as the bridge is wired up).
 */
class LiveDesk {
  readonly profile = { name: "desk", displayName: "Desk agent", description: "", model: "desk-1", provider: "desk" };
  running: string | null = null;
  endsAtOnce = false;
  /** How long each `adopt` and each load takes, in turn; no time when they run out. */
  adoptDelays: number[] = [];
  resumeDelays: number[] = [];
  /** How many sessions were loaded. */
  resumes = 0;
  /** How long reading a thread only read again takes, and letting go of a session. */
  reloadDelay = 0;
  closeDelay = 0;
  /** Whether each session loaded was only for reading, in order. */
  readOnly: boolean[] = [];
  /** What each session loaded reports through, in order: a test ends a turn found running with it. */
  sinks: SessionSink[] = [];
  /** Said at the desk after the sessions were loaded: reading a thread again finds it. */
  saidSince: StoredMessage[] = [];
  /** What the agent kept after the turn running, once it ended while the bridge was off. */
  endedWith: StoredMessage[] = [];
  /** The agent's record shows that turn was cut off mid-way rather than ended (`lastTurnCutOff`). */
  cutOff = false;
  private readonly settings = { model: "desk-1", provider: "desk", reasoningEffort: "" };

  async models() {
    return { providers: [{ slug: "desk", name: "Desk", models: ["desk-1"] }], model: "desk-1", provider: "desk", reasoning: "" };
  }

  async adopt(id: string): Promise<DeskAdoption> {
    await sleep(this.adoptDelays.shift() ?? 0);
    return { id, cwd: realpathSync(tmpdir()), title: "At the desk", settings: this.settings };
  }

  async startSession(): Promise<ProviderSession> {
    throw new Error("Threads of the desk agent are only taken up.");
  }

  async resumeSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    this.resumes += 1;
    this.readOnly.push(options.readOnly === true);
    this.sinks.push(sink);
    await sleep(this.resumeDelays.shift() ?? 0);
    const running = this.running;
    const endsAtOnce = this.endsAtOnce;
    const cutOff = this.cutOff;
    const history: StoredMessage[] = [{ role: "user", text: "Said at the desk before", timestamp: 1 }];
    if (running) history.push({ role: "user", text: running, timestamp: 2 });
    history.push(...this.endedWith);
    return {
      history: async () => history,
      attached: () => {
        if (running && endsAtOnce) {
          queueMicrotask(() => {
            sink.emit({ type: "text", text: "Done at the desk." });
            sink.emit({ type: "turn.end", status: "complete" });
          });
        }
        return running ? { user: running } : null;
      },
      lastTurnCutOff: () => cutOff,
      settings: () => this.settings,
      reload: async () => {
        await sleep(this.reloadDelay);
        return [...history, ...this.saidSince];
      },
      startTurn: () => {},
      interrupt: async () => false,
      setModel: async () => ({ deferred: false }),
      setReasoning: async () => {},
      close: () => sleep(this.closeDelay),
    };
  }
}

/** A device's hold on the list: the list's id and revision it last merged, and the threads as it last got them. */
class Device {
  readonly client: TestClient;
  list: string | undefined;
  revision: number | undefined;
  readonly threads = new Map<string, Frame>();

  constructor(client: TestClient) {
    this.client = client;
  }

  /** Asks for what changed since what it holds, merges it and returns the answer. */
  async sync(): Promise<Frame> {
    const answer = await this.client.call("threads.changes", this.list === undefined ? {} : { list: this.list, since: this.revision });
    if (answer.full) this.threads.clear();
    for (const thread of answer.threads) this.threads.set(thread.id, thread);
    for (const id of answer.removed) this.threads.delete(id);
    this.list = answer.list.id;
    this.revision = answer.list.revision;
    return answer;
  }

  thread(id: string): Frame {
    const thread = this.threads.get(id);
    assert.ok(thread, `${id} is not listed`);
    return thread;
  }
}

interface Setup {
  bridge: TestBridge;
  /** Where the agent keeps its conversations, apart from the bridge's folder. */
  data: string;
  agent: DeskFake;
  a: Device;
  b: Device;
}

/**
 * A bridge of the test's own and two devices on it, gone when the test ends. Given an
 * earlier one, it starts again in that one's folders: a restart.
 */
async function devices(t: TestContext, earlier?: Setup, more: [string, Provider][] = []): Promise<Setup> {
  const data = earlier?.data ?? temporaryHome();
  const agent = new DeskFake(join(data, "fake"));
  const bridge = await startTestBridge({ home: earlier?.bridge.home, keepHome: true, providers: new Map<string, Provider>([["fake", agent], ...more]) });
  const a = new Device(await TestClient.open(bridge));
  const b = new Device(await TestClient.open(bridge));
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= Promise.all([a.client.close(), b.client.close()]).then(() => bridge.dispose()));
  t.after(async () => {
    await close();
    rmSync(bridge.home, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });
  return { bridge: { ...bridge, dispose: close }, data, agent, a, b };
}

/** Starts a slow turn and waits until it has begun; returns where its frames start. */
async function startSlow(client: TestClient, thread: string): Promise<number> {
  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: thread, text: "slow please", profile: "fake" });
  await client.from(start, (frame) => isEvent(frame, "message.start", thread));
  return start;
}

/** Stops the turn started at `start` and returns its `message.complete`. */
async function stop(client: TestClient, thread: string, start: number): Promise<Frame> {
  await client.call("session.interrupt", { session_id: thread, profile: "fake" });
  return (await client.from(start, (frame) => isEvent(frame, "message.complete", thread))).params;
}

/** The bridge's threads.json, as it is on disk. */
function stored(home: string): Frame {
  return JSON.parse(readFileSync(pathsFor(home).threads, "utf8"));
}

function store(home: string, file: Frame): void {
  writeFileSync(pathsFor(home).threads, JSON.stringify(file));
}

/** The bridge's removed.json, as it is on disk: the threads taken off the list. */
function removedFile(home: string): Frame {
  return JSON.parse(readFileSync(pathsFor(home).removed, "utf8"));
}

// MARK: The list

test("gateway.ready lists thread_sync, and sessions.activity says the list's id and revision", async (t) => {
  const { a } = await devices(t);
  assert.ok(a.client.readyPayload.bridge.features.includes("thread_sync"));
  const before = (await a.client.call("sessions.activity")).thread_list;
  assert.match(before.id, /^[0-9a-f]{16}$/);
  assert.ok(Number.isInteger(before.revision));
  await createThread(a.client);
  const after = (await a.client.call("sessions.activity")).thread_list;
  assert.equal(after.id, before.id);
  assert.ok(after.revision > before.revision);
});

test("a thread started on one device is in the other's changes, with its preview and time, and no mark", async (t) => {
  const { a, b } = await devices(t);
  await b.sync();
  const thread = await createThread(a.client);
  await runTurn(a.client, thread, "hello there\nand more on a second line");

  const answer = await b.sync();
  assert.equal(answer.full, undefined);
  const listed = b.thread(thread);
  assert.equal(listed.agent, "fake");
  assert.equal(listed.agent_name, "Fake agent");
  assert.equal(listed.title, "Fake: hello there and more on a");
  assert.equal(listed.folder, realpathSync(tmpdir()));
  assert.equal(listed.state, "idle");
  assert.equal(listed.preview, "hello there");
  assert.equal(listed.unseen, true);
  assert.equal(listed.revision, answer.list.revision);
  assert.ok(Number.isInteger(listed.created) && listed.updated >= listed.created);
  for (const key of ["pinned", "archived", "started_by", "read_only"]) assert.equal(listed[key], undefined, key);
});

test("threads started through the fleet say who started them", async (t) => {
  const { a, b } = await devices(t);
  const own = await createThread(a.client);
  const start = async (params: Record<string, unknown>) => (await a.client.call("thread.start", { profile: "fake", ...params })).thread.id as string;
  const fromThread = await start({ from: own, text: "help me with this" });
  const fromNobody = await start({});
  const fromUnknown = await start({ from: "no-such-thread" });
  const passedOn = await start({ sender: 'Claude Code · "Fix the "login" page" (thread 6d3c-1) on mini', text: "from far away" });

  await b.sync();
  assert.equal(b.thread(own).started_by, undefined);
  assert.deepEqual(b.thread(fromThread).started_by, { name: "Fake agent", thread: own, from: { agent: "fake", agent_name: "Fake agent", thread: own } });
  assert.deepEqual(b.thread(fromNobody).started_by, { name: "the portals command" });
  assert.deepEqual(b.thread(fromUnknown).started_by, { name: "the portals command" });
  assert.deepEqual(b.thread(passedOn).started_by, { name: "Claude Code on mini" });
  // The preview is the message, without the line that says who it is from.
  assert.equal(b.thread(fromThread).preview, "help me with this");
  assert.equal(b.thread(passedOn).preview, "from far away");
});

test("a passed-on sender comes out short: no quoted title or thread id, one line, at most 80 characters", () => {
  assert.equal(shortSender('Claude Code · "Fix the login" (thread 6d3c8a9e-0000) on mini'), "Claude Code on mini");
  assert.equal(shortSender("Aeri (thread aeri) on mbp16"), "Aeri on mbp16");
  assert.equal(shortSender("the command line on mbp16"), "the command line on mbp16");
  assert.equal(shortSender("  Codex\n   on\tmini  "), "Codex on mini");
  const long = shortSender(`${"word ".repeat(40)}on mini`);
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
});

test("a thread taken up from the desk is listed with the preview of its history and no mark", async (t) => {
  const { agent, a, b } = await devices(t);
  agent.deskSession("desk-1", [
    { role: "user", text: "Look at the desk\nwith detail", timestamp: 1 },
    { role: "assistant", text: "Looked.", timestamp: 2 },
    { role: "user", text: "Background work finished", timestamp: 3, display_kind: "process_complete" },
  ]);
  await b.sync();
  await a.client.call("session.adopt", { profile: "fake", session_id: "desk-1", mode: "continue" });
  await b.sync();
  const listed = b.thread("desk-1");
  assert.equal(listed.title, "From the desk");
  assert.equal(listed.preview, "Look at the desk");
  assert.equal(listed.started_by, undefined);
  assert.equal(listed.unseen, undefined);
});

test("a turn running in a thread taken up from the desk, and one that ends while it is taken up, are on the list as they were", async (t) => {
  const desk = new LiveDesk();
  const { a, b } = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await b.sync();
  const held = b.revision!;
  desk.running = "Started at the desk";
  desk.endsAtOnce = true;
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-ended", mode: "continue" });
  await b.sync();
  const ended = b.thread("desk-ended");
  assert.equal(ended.preview, "Started at the desk");
  assert.equal(ended.unseen, true);
  assert.equal(ended.started_by, undefined);
  // A seen from before it was taken up leaves what that turn did.
  assert.equal((await a.client.call("thread.mark", { thread: "desk-ended", unseen: false, revision: held })).thread.unseen, true);
  assert.equal((await a.client.call("thread.mark", { thread: "desk-ended", unseen: false, revision: ended.revision })).thread.unseen, undefined);
});

test("a turn found running when a thread is loaded again is a turn's start: the thread comes out of the archive with its message", async (t) => {
  const desk = new LiveDesk();
  const first = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await first.a.client.call("session.adopt", { profile: "desk", session_id: "desk-idle", mode: "continue" });
  await first.a.client.call("thread.mark", { thread: "desk-idle", archived: true });
  await first.b.sync();
  const before = first.b.thread("desk-idle");
  assert.equal(before.preview, "Said at the desk before");
  await first.bridge.dispose();
  // Meanwhile a turn starts at the desk, and the thread is opened again.
  desk.running = "Started while the bridge was off";

  const again = await devices(t, first, [["desk", desk as unknown as Provider]]);
  again.b.list = first.b.list;
  again.b.revision = first.b.revision;
  await again.a.client.call("session.resume", { session_id: "desk-idle", profile: "desk", inline_images: false });
  const answer = await again.b.sync();
  assert.equal(answer.full, undefined);
  const listed = again.b.thread("desk-idle");
  assert.equal(listed.archived, undefined);
  assert.equal(listed.preview, "Started while the bridge was off");
  assert.equal(listed.state, "working");
  assert.ok(listed.updated >= before.updated);
});

test("a turn the bridge saw start, still running after a restart, keeps the thread where it was", async (t) => {
  const desk = new LiveDesk();
  desk.running = "Started before the restart";
  const first = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await first.a.client.call("session.adopt", { profile: "desk", session_id: "desk-long", mode: "continue" });
  await first.b.sync();
  const before = first.b.thread("desk-long");
  assert.equal(before.preview, "Started before the restart");
  await first.bridge.dispose();

  const again = await devices(t, first, [["desk", desk as unknown as Provider]]);
  again.b.list = first.b.list;
  again.b.revision = first.b.revision;
  await again.a.client.call("session.resume", { session_id: "desk-long", profile: "desk", inline_images: false });
  assert.deepEqual((await again.b.sync()).threads, []);
  assert.equal(again.b.revision, first.b.revision);
});

test("a turn started at the desk while the bridge was off, saying what the last one said, still moves the thread", async (t) => {
  const desk = new LiveDesk();
  desk.running = "Continue";
  desk.endsAtOnce = true;
  const first = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await first.a.client.call("session.adopt", { profile: "desk", session_id: "desk-again", mode: "continue" });
  await first.b.sync();
  assert.deepEqual([first.b.thread("desk-again").preview, first.b.thread("desk-again").unseen], ["Continue", true]);
  await first.b.client.call("thread.mark", { thread: "desk-again", unseen: false });
  await first.b.sync();
  await first.bridge.dispose();
  // That turn ended; another one starts at the desk with the same words.
  desk.endsAtOnce = false;

  const again = await devices(t, first, [["desk", desk as unknown as Provider]]);
  again.b.list = first.b.list;
  again.b.revision = first.b.revision;
  await again.a.client.call("session.resume", { session_id: "desk-again", profile: "desk", inline_images: false });
  const answer = await again.b.sync();
  assert.deepEqual(answer.threads.map((entry: Frame) => [entry.id, entry.state, entry.preview]), [["desk-again", "working", "Continue"]]);
  // Its start is recorded, so a seen from before it does not clear what it does.
  assert.equal(stored(first.bridge.home).threads[0].turnRevision, answer.list.revision);
});

test("a turn that ended while the bridge was off is no longer taken for the one running when the thread is next loaded, and its end marks the thread unseen", async (t) => {
  const desk = new LiveDesk();
  desk.running = "Continue";
  const first = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await first.a.client.call("session.adopt", { profile: "desk", session_id: "desk-ended-off", mode: "continue" });
  await first.bridge.dispose();
  assert.equal(stored(first.bridge.home).threads[0].inTurn, true);
  const { revision } = stored(first.bridge.home);

  // It ended at the desk meanwhile: loaded at rest, the thread forgets it, and its end
  // is told as any turn's end is: the thread is unseen (2026-10-26: "Notify + mark unseen").
  desk.running = null;
  const again = await devices(t, first, [["desk", desk as unknown as Provider]]);
  await again.a.client.call("session.resume", { session_id: "desk-ended-off", profile: "desk", inline_images: false });
  assert.equal(stored(first.bridge.home).threads[0].inTurn, undefined);
  assert.equal(stored(first.bridge.home).threads[0].unseen, true);
  assert.ok(stored(first.bridge.home).revision > revision);
});

test("a turn running as the bridge stopped that ended while it was down is notified and marked unseen once the bridge is back, without the app opening it, and only once", async (t) => {
  const desk = new LiveDesk();
  const notes = temporaryHome();
  const dryRun = join(notes, "push.jsonl");
  const providers = () => new Map<string, Provider>([["desk", desk as unknown as Provider]]);
  const open: { dispose(): Promise<void> }[] = [];
  const started = async (options: Parameters<typeof startTestBridge>[0]) => {
    const bridge = await startTestBridge({ keepHome: true, providers: providers(), ...options });
    open.push(bridge);
    return bridge;
  };
  const first = await started({ config: { push: { dryRun } } });
  const home = first.home;
  t.after(async () => {
    for (const bridge of open) await bridge.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(notes, { recursive: true, force: true });
  });
  const client = await TestClient.open(first);
  // A thread at rest: no turn of its was running, so a restart tells nothing of it.
  desk.running = null;
  await client.call("session.adopt", { profile: "desk", session_id: "desk-rest", mode: "continue" });
  desk.running = "Continue";
  await client.call("session.adopt", { profile: "desk", session_id: "desk-down", mode: "continue" });
  await watch(first, ["desk-down", "desk-rest"]);
  await client.close();
  await first.dispose();
  assert.equal(stored(home).threads.find((record: Frame) => record.id === "desk-down").inTurn, true);
  const notified = () => (existsSync(dryRun) ? readFileSync(dryRun, "utf8").trim().split("\n").filter(Boolean) : []).map((line) => JSON.parse(line).payload);
  const before = notified().length;

  // It ends at the desk while the bridge is down (a crash, a restart).
  desk.running = null;
  desk.endsAtOnce = false;
  desk.endedWith = [{ role: "assistant", text: "Finished at the desk.", timestamp: 3 }];
  const again = await started({ home });
  for (let tries = 0; tries < 200 && notified().length === before; tries++) await sleep(10);
  const told = notified().slice(before);
  assert.deepEqual(told.map((payload: Frame) => payload.aeriportal.thread), ["desk-down"]);
  assert.match(JSON.stringify(told[0]), /Finished at the desk\./);
  const device = new Device(await TestClient.open(again));
  await device.sync();
  assert.equal(device.thread("desk-down").unseen, true);
  assert.equal(stored(home).threads.find((record: Frame) => record.id === "desk-down").inTurn, undefined);
  await device.client.close();
  await again.dispose();

  // Not again at the next restart.
  const third = await started({ home });
  await sleep(200);
  assert.equal(notified().length, before + 1);
  await third.dispose();
});

/** What a bridge notifies at its start of a desk thread whose turn ran as the one before stopped and ended meanwhile, the agent keeping `endedWith`. */
async function toldOfTurnEndedAway(t: TestContext, endedWith: StoredMessage[], cutOff = false): Promise<Frame[]> {
  const desk = new LiveDesk();
  const notes = temporaryHome();
  const dryRun = join(notes, "push.jsonl");
  const providers = () => new Map<string, Provider>([["desk", desk as unknown as Provider]]);
  const open: { dispose(): Promise<void> }[] = [];
  const started = async (options: Parameters<typeof startTestBridge>[0]) => {
    const bridge = await startTestBridge({ keepHome: true, providers: providers(), ...options });
    open.push(bridge);
    return bridge;
  };
  const first = await started({ config: { push: { dryRun } } });
  const home = first.home;
  t.after(async () => {
    for (const bridge of open) await bridge.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(notes, { recursive: true, force: true });
  });
  const client = await TestClient.open(first);
  desk.running = "Continue";
  await client.call("session.adopt", { profile: "desk", session_id: "desk-away", mode: "continue" });
  await watch(first, ["desk-away"]);
  await client.close();
  await first.dispose();
  const notified = () => (existsSync(dryRun) ? readFileSync(dryRun, "utf8").trim().split("\n").filter(Boolean) : []).map((line) => JSON.parse(line).payload);
  const before = notified().length;
  desk.running = null;
  desk.endsAtOnce = false;
  desk.endedWith = endedWith;
  desk.cutOff = cutOff;
  const again = await started({ home });
  for (let tries = 0; tries < 200 && notified().length === before; tries++) await sleep(10);
  // Told, whether or not it was notified: the thread is unseen and no longer running.
  const record = stored(home).threads.find((thread: Frame) => thread.id === "desk-away");
  assert.equal(record.unseen, true);
  assert.equal(record.inTurn, undefined);
  await again.dispose();
  return notified().slice(before);
}

test("a turn that failed while the bridge was down, a steering message taken after its failure kept behind it, is notified as failed, not finished (Codex's review of the merge)", async (t) => {
  // Droid keeps a steering message it takes after the turn's end as a steer row behind the
  // failed turn's (recent-16, recent-17); the turn the bridge recorded as running still failed.
  const told = await toldOfTurnEndedAway(t, [
    { role: "assistant", text: "Working on it.", timestamp: 3 },
    { role: "assistant", text: "Droid could not reach the model.", timestamp: 4, display_kind: "failed_turn" },
    { role: "user", text: "and the tests too", timestamp: 5, display_kind: "steer" } as StoredMessage,
  ]);
  assert.deepEqual(told.map((payload) => [payload.aeriportal.thread, payload.aeriportal.kind]), [["desk-away", "failed"]]);
  assert.match(JSON.stringify(told[0]), /Droid could not reach the model\./);
});

test("a turn that ended while the bridge was down after a failed try, a steering message and a reply, is notified as finished with that reply (Codex's re-check)", async (t) => {
  // Pi keeps a failed try, then a steer it took and the reply that ended the turn well.
  const told = await toldOfTurnEndedAway(t, [
    { role: "assistant", text: "The model was overloaded.", timestamp: 3, display_kind: "failed_turn" },
    { role: "user", text: "try again", timestamp: 4, display_kind: "steer" } as StoredMessage,
    { role: "assistant", text: "Done after all.", timestamp: 5 },
  ]);
  assert.deepEqual(told.map((payload) => [payload.aeriportal.thread, payload.aeriportal.kind]), [["desk-away", "finished"]]);
  assert.match(JSON.stringify(told[0]), /Done after all\./);
});

test("a turn a crash cut off while the bridge was down, its agent's record showing no end, is told as stopped, not notified as finished with its last words (recovery-8)", async (t) => {
  // Claude Code's session file ends on a tool call that never ran (`turnCutOff`): the turn
  // was stopped when the bridge stopped, as a restart stops one (recovery-7). As for Stop,
  // a stopped turn is not notified; the thread is still unseen.
  const told = await toldOfTurnEndedAway(t, [{ role: "assistant", text: "Running the tests now.", timestamp: 3 }], true);
  assert.deepEqual(told, []);
});

test("a turn a crash cut off while the bridge was down, its record ending on the person's message or a tool's row with no mark of it, is told as stopped, not notified as finished", async (t) => {
  // Pi's file after a hard kill: the message only, mid-reply; the message and the row of a
  // command it ran, mid-command. Its record says nothing more (no `lastTurnCutOff`). As for
  // Stop, a stopped turn is not notified; the thread is still unseen.
  assert.deepEqual(await toldOfTurnEndedAway(t, [{ role: "user", text: "Run the tests", timestamp: 3 }]), []);
  assert.deepEqual(await toldOfTurnEndedAway(t, [
    { role: "user", text: "Run the tests", timestamp: 3 },
    { role: "assistant", text: "Running them now.", timestamp: 4 },
    { role: "tool", name: "terminal", args: { command: "npm test" }, content: JSON.stringify({ output: "", exit_code: null, error: "stopped" }), tool_call_id: "call-1", timestamp: 5 },
  ]), []);
  // A steering message kept behind it changes nothing.
  assert.deepEqual(await toldOfTurnEndedAway(t, [
    { role: "user", text: "Run the tests", timestamp: 3 },
    { role: "user", text: "and the linter", timestamp: 4, display_kind: "steer" } as StoredMessage,
  ]), []);
});

test("how a turn that ended while the bridge was down ended, as what hears of turns' ends is told it: stopped where the agent's record ends mid-turn", async () => {
  /** The status and text a session loaded at rest tells of the turn its record had running, from the agent's record `ended` after the person's message. */
  const told = async (ended: StoredMessage[], cutOff?: boolean): Promise<[string, string][]> => {
    const heard: [string, string][] = [];
    const record: ThreadRecord = { id: "away", agent: "desk", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "", createdAt: 0, updatedAt: 0, origin: "phone", inTurn: true };
    const thread = new Session(record, { has: () => false } as unknown as Registry, { listener: { turnEnded: (_id, status, text) => heard.push([status, text]) } });
    const history: StoredMessage[] = [{ role: "user", text: "Run the tests", timestamp: 1 }, ...ended];
    await thread.attach({
      history: async () => history,
      ...(cutOff === undefined ? {} : { lastTurnCutOff: () => cutOff }),
      settings: () => ({ model: "m", provider: "p", reasoningEffort: "" }),
      startTurn: () => {},
      interrupt: async () => false,
      close: async () => {},
    } as unknown as ProviderSession);
    // Told once, and so no longer running, and unseen.
    assert.deepEqual([record.inTurn, record.unseen], [undefined, true]);
    return heard;
  };
  const command: StoredMessage = { role: "tool", name: "terminal", args: { command: "npm test" }, content: JSON.stringify({ output: "" }), tool_call_id: "call-1", timestamp: 3 };
  // Cut off mid-reply, and mid-command.
  assert.deepEqual(await told([]), [["interrupted", ""]]);
  assert.deepEqual(await told([{ role: "assistant", text: "Running them.", timestamp: 2 }, command]), [["interrupted", ""]]);
  // Ended: with its reply, or with its failure.
  assert.deepEqual(await told([command, { role: "assistant", text: "All pass.", timestamp: 4 }]), [["complete", "All pass."]]);
  assert.deepEqual(await told([{ role: "assistant", text: "The model was overloaded.", timestamp: 2, display_kind: "failed_turn" }]), [["error", "The model was overloaded."]]);
  // An agent whose own record says it was cut off is taken at its word, both ways.
  assert.deepEqual(await told([{ role: "assistant", text: "Running them.", timestamp: 2 }], true), [["interrupted", ""]]);
  assert.deepEqual(await told([{ role: "assistant", text: "All pass.", timestamp: 2 }], false), [["complete", "All pass."]]);
});

test("a turn that ended while the bridge was down on a plan, on questions or with a command nothing answered is still notified as finished", async (t) => {
  // Each can be how a turn ends: Codex's plan mode ends on its plan, its questions asked
  // without waiting on their row, and a `/compact` that failed on the message alone.
  const plan = await toldOfTurnEndedAway(t, [
    { role: "assistant", text: "Here is the plan.", timestamp: 3 },
    { role: "tool", name: "plan", args: { content: "1. Read\n2. Write" }, content: JSON.stringify({ output: "Codex proposed this plan." }), tool_call_id: "plan-1", timestamp: 4 },
  ]);
  assert.deepEqual(plan.map((payload) => [payload.aeriportal.thread, payload.aeriportal.kind]), [["desk-away", "finished"]]);
  assert.match(JSON.stringify(plan[0]), /Here is the plan\./);
  const asked = await toldOfTurnEndedAway(t, [
    { role: "tool", name: "clarify", args: { questions: [{ question: "Which folder?" }] }, content: JSON.stringify({ responses: [], unanswered: true }), tool_call_id: "ask-1", timestamp: 3 },
  ]);
  assert.deepEqual(asked.map((payload) => payload.aeriportal.kind), ["finished"]);
  const command = await toldOfTurnEndedAway(t, [{ role: "user", text: "/compact", timestamp: 3 }]);
  assert.deepEqual(command.map((payload) => payload.aeriportal.kind), ["finished"]);
});

test("two devices taking up the same desk session at once get one thread, and a mark made in between stays", async (t) => {
  const desk = new LiveDesk();
  const { a, b } = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  // Both are past the agent's checks before either is loaded, and the first is loaded first.
  desk.adoptDelays = [0, 10];
  desk.resumeDelays = [40, 120];
  const fromA = a.client.call("session.adopt", { profile: "desk", session_id: "desk-twice", mode: "continue" });
  const fromB = b.client.call("session.adopt", { profile: "desk", session_id: "desk-twice", mode: "continue" });
  assert.equal((await fromA).session_id, "desk-twice");
  await a.client.call("thread.mark", { thread: "desk-twice", pinned: true });
  assert.equal((await fromB).session_id, "desk-twice");
  assert.equal(desk.resumes, 1);
  await b.sync();
  assert.equal(b.thread("desk-twice").pinned, true);
  assert.equal([...b.threads.keys()].filter((id) => id === "desk-twice").length, 1);
});

test("two devices continuing a thread only read, at once, continue it once", async (t) => {
  const desk = new LiveDesk();
  const { a, b } = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-read", mode: "read" });
  assert.equal(desk.resumes, 1);
  // Both are past the agent's checks before either has loaded the thread again.
  desk.adoptDelays = [40, 0];
  const answers = await Promise.all([a, b].map((device) => device.client.call("session.adopt", { profile: "desk", session_id: "desk-read", mode: "continue" })));
  assert.deepEqual(answers.map((answer: Frame) => answer.session_id), ["desk-read", "desk-read"]);
  assert.equal(desk.resumes, 2);
  await b.sync();
  assert.equal(b.thread("desk-read").read_only, undefined);
});

test("a seen sent as soon as a turn's end arrives clears it: the end was recorded first", async (t) => {
  const { a, b } = await devices(t);
  const thread = await createThread(a.client);
  await runTurn(a.client, thread, "first");
  // A looks at the thread: as its turn's end arrives, it asks what changed and says it has seen it.
  await a.sync();
  await a.client.call("thread.mark", { thread, unseen: false, revision: a.thread(thread).revision });
  const start = a.client.frames.length;
  await a.client.call("prompt.submit", { session_id: thread, text: "second", profile: "fake" });
  const seen = (async () => {
    await a.client.from(start, (frame) => isEvent(frame, "message.complete", thread));
    await a.sync();
    assert.equal(a.thread(thread).unseen, true);
    return a.client.call("thread.mark", { thread, unseen: false, revision: a.thread(thread).revision });
  })();
  assert.equal((await seen).thread.unseen, undefined);
  await b.sync();
  assert.equal(b.thread(thread).unseen, undefined);
});

/** Makes threads.json impossible to replace, until what it returns is called. */
function blockThreads(home: string): () => void {
  const blocker = `${pathsFor(home).threads}.${process.pid}.tmp`;
  mkdirSync(blocker);
  return () => rmSync(blocker, { recursive: true, force: true });
}

test("a message from a device whose turn cannot be saved in threads.json still opens it: the turn ends on every device, and the message waiting behind it starts", async (t) => {
  const { bridge, a, b } = await devices(t);
  const thread = await createThread(a.client);
  // Titled already: a title is a save of its own.
  await runTurn(a.client, thread, "hello");
  await b.client.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
  await b.sync();
  const before = readFileSync(pathsFor(bridge.home).threads, "utf8");
  const unblock = blockThreads(bridge.home);
  const start = b.client.frames.length;
  // Sent together: the second waits for the first's turn.
  const [first, second] = await Promise.all([
    a.client.call("prompt.submit", { session_id: thread, text: "first", profile: "fake" }),
    a.client.call("prompt.submit", { session_id: thread, text: "second", profile: "fake", when_busy: "queue" }),
  ]);
  assert.deepEqual([first.status, second.status], ["streaming", "queued"]);
  await b.client.from(start, (frame) => isEvent(frame, "message.complete", thread) && frame.params.payload.text === "Hello from the fake agent. You said: second.");
  const turns = b.client.frames
    .slice(start)
    .filter((frame) => isEvent(frame, "message.start", thread) || isEvent(frame, "message.complete", thread))
    .map((frame) => (frame.params.type === "message.start" ? frame.params.payload.text : frame.params.payload.status));
  assert.deepEqual(turns, ["first", "complete", "second", "complete"]);
  // At rest, and the list as it was: neither turn could be saved.
  const rest = await a.client.call("thread.wait", { thread, timeout_ms: 2000 });
  assert.deepEqual([rest.state, rest.timed_out], ["idle", false]);
  assert.equal(readFileSync(pathsFor(bridge.home).threads, "utf8"), before);
  assert.deepEqual((await b.sync()).threads, []);

  unblock();
  await runTurn(a.client, thread, "third");
  await b.sync();
  assert.deepEqual([b.thread(thread).preview, b.thread(thread).unseen], ["third", true]);
});

test("a message through the fleet whose turn cannot be saved in threads.json still opens it, and a wait for it is answered once it ends", async (t) => {
  const { bridge, a } = await devices(t);
  const thread = await createThread(a.client);
  await runTurn(a.client, thread, "hello");
  const unblock = blockThreads(bridge.home);
  const sent = await a.client.call("thread.send", { thread, text: "from the fleet", wait: true, timeout_ms: 4000 });
  assert.deepEqual([sent.status, sent.state, sent.timed_out], ["streaming", "idle", false]);
  assert.match(sent.reply, /from the fleet/);
  // Not left at work: the next message opens a turn of its own.
  unblock();
  await runTurn(a.client, thread, "after");
});

test("a turn whose end cannot be saved in threads.json still ends: its notification goes out, a wait is answered and the message waiting behind it starts", async (t) => {
  const { bridge, client, thread, notified } = await notifying(t);
  const start = client.frames.length;
  assert.equal((await client.call("prompt.submit", { session_id: thread, text: "approve this", profile: "fake" })).status, "streaming");
  const asked = await client.nextRequest();
  // Its start is saved; its end, and the next message's turn, cannot be.
  assert.equal(stored(bridge.home).threads.find((entry: Frame) => entry.id === thread).inTurn, true);
  const unblock = blockThreads(bridge.home);
  assert.equal((await client.call("prompt.submit", { session_id: thread, text: "next", profile: "fake", when_busy: "queue" })).status, "queued");
  client.answer(asked.id, { choice: "once" });
  await client.from(start, (frame) => isEvent(frame, "message.complete", thread));
  const rest = await client.call("thread.wait", { thread, timeout_ms: 4000 });
  assert.deepEqual([rest.state, rest.timed_out, rest.reply], ["idle", false, "Hello from the fake agent. You said: next."]);
  // The question, then both turns' ends.
  for (let tries = 0; tries < 200 && notified().length < 3; tries++) await sleep(10);
  assert.deepEqual(notified(), [thread, thread, thread]);

  unblock();
  await runTurn(client, thread, "after");
  const record = stored(bridge.home).threads.find((entry: Frame) => entry.id === thread);
  assert.deepEqual([record.inTurn, record.preview], [undefined, "after"]);
});

// MARK: Marks

test("pins and archive cross devices; archiving unpins, and a new turn brings a thread back", async (t) => {
  const { a, b } = await devices(t);
  const thread = await createThread(a.client);
  await runTurn(a.client, thread, "first");
  await a.sync();
  await b.sync();
  const before = b.thread(thread);

  const pinned = await a.client.call("thread.mark", { thread, pinned: true });
  assert.equal(pinned.thread.pinned, true);
  await b.sync();
  assert.equal(b.thread(thread).pinned, true);
  assert.equal(b.thread(thread).updated, before.updated);

  await b.client.call("thread.mark", { thread, archived: true });
  await a.sync();
  assert.equal(a.thread(thread).archived, true);
  assert.equal(a.thread(thread).pinned, undefined);

  // A turn's start brings it back; archived while the turn runs, its end does.
  const start = await startSlow(a.client, thread);
  await b.sync();
  assert.equal(b.thread(thread).archived, undefined);
  await b.client.call("thread.mark", { thread, archived: true });
  await stop(a.client, thread, start);
  await b.sync();
  assert.equal(b.thread(thread).archived, undefined);
  // And so does taking it out by hand.
  await a.client.call("thread.mark", { thread, archived: true });
  await a.client.call("thread.mark", { thread, archived: false });
  await b.sync();
  assert.equal(b.thread(thread).archived, undefined);
});

test("an archive sent with a pin made after it leaves the thread archived and pinned, as the two sent one by one do", async (t) => {
  const { a, b } = await devices(t);
  const thread = await createThread(a.client);
  // A device that could not reach the bridge archived the thread, then pinned it in the archive.
  const marked = await a.client.call("thread.mark", { thread, archived: true, pinned: true });
  assert.deepEqual([marked.thread.archived, marked.thread.pinned], [true, true]);
  await a.client.call("thread.mark", { thread, archived: false, pinned: false });
  await b.client.call("thread.mark", { thread, archived: true });
  await b.client.call("thread.mark", { thread, pinned: true });
  await a.sync();
  assert.deepEqual([a.thread(thread).archived, a.thread(thread).pinned], [true, true]);
  // Archived alone, it is unpinned, as always.
  assert.equal((await a.client.call("thread.mark", { thread, archived: true })).thread.pinned, undefined);
});

test("an incremental registry scan makes no whole-list snapshot and keeps stamp validation, order and record identity", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "threads.json");
  const records = [8, undefined, 4, 5.5, -2, Number.MAX_SAFE_INTEGER + 1, 6].map((revision, index) => ({
    id: `t${index}`, agent: "fake", revision,
  }));
  writeFileSync(path, JSON.stringify({ list: "incremental", revision: 8, threads: records }));
  const registry = new Registry(path);
  const snapshot = t.mock.method(registry, "all");
  const changed = registry.changedSince(4);
  assert.deepEqual(changed.map((record) => record.id), ["t0", "t6"]);
  assert.equal(changed[0], registry.get("t0"));
  assert.equal(changed[1], registry.get("t6"));
  changed.length = 0;
  assert.deepEqual(registry.changedSince(4).map((record) => record.id), ["t0", "t6"]);
  assert.deepEqual(registry.changedSince(8), []);
  assert.deepEqual(registry.changedSince(0).map((record) => record.id), ["t0", "t2", "t6"]);
  assert.equal(snapshot.mock.callCount(), 0);
});

test("a mark whose file cannot be written changes nothing, not even in memory, and sent again it is saved", async (t) => {
  const first = await devices(t);
  const thread = await createThread(first.a.client);
  await first.b.sync();
  const held = first.b.revision;
  // threads.json cannot be replaced.
  const path = pathsFor(first.bridge.home).threads;
  renameSync(path, `${path}.aside`);
  mkdirSync(join(path, "in-the-way"), { recursive: true });
  await assert.rejects(first.a.client.call("thread.mark", { thread, pinned: true }), (error: RpcFailure) => error.code === -32603);
  const answer = await first.b.sync();
  assert.deepEqual([answer.threads, answer.list.revision], [[], held]);

  rmSync(path, { recursive: true, force: true });
  renameSync(`${path}.aside`, path);
  assert.equal((await first.a.client.call("thread.mark", { thread, pinned: true })).thread.pinned, true);
  await first.bridge.dispose();
  const again = await devices(t, first);
  again.b.list = first.b.list;
  again.b.revision = first.b.revision;
  const after = await again.b.sync();
  assert.deepEqual(after.threads.map((entry: Frame) => [entry.id, entry.pinned]), [[thread, true]]);
});

test("two devices pinning and unpinning at once end on the last write", async (t) => {
  const { a, b } = await devices(t);
  const thread = await createThread(a.client);
  for (let round = 0; round < 6; round += 1) {
    const [first, second] = round % 2 === 0 ? [a, b] : [b, a];
    const answers = await Promise.all([first.client.call("thread.mark", { thread, pinned: true }), second.client.call("thread.mark", { thread, pinned: false })]);
    // The write the bridge took last is the one with the newer revision; one that changed nothing has the older.
    const last = answers.reduce((newest, answer) => (answer.thread.revision >= newest.thread.revision ? answer : newest));
    await a.sync();
    await b.sync();
    assert.equal(a.thread(thread).pinned, last.thread.pinned);
    assert.equal(b.thread(thread).pinned, last.thread.pinned);
  }
});

test("a turn's end marks the thread unseen on every device, a stopped or failed one too, and a seen clears it", async (t) => {
  const { a, b } = await devices(t);
  const thread = await createThread(a.client);
  await runTurn(a.client, thread, "hello");
  await b.sync();
  assert.equal(b.thread(thread).unseen, true);

  const seen = await b.client.call("thread.mark", { thread, unseen: false, revision: b.thread(thread).revision });
  assert.equal(seen.thread.unseen, undefined);
  await a.sync();
  assert.equal(a.thread(thread).unseen, undefined);

  // Stopped.
  const stopped = await stop(a.client, thread, await startSlow(a.client, thread));
  assert.equal(stopped.payload.status, "interrupted");
  await b.sync();
  assert.equal(b.thread(thread).unseen, true);

  // Failed.
  await b.client.call("thread.mark", { thread, unseen: false });
  await runTurn(a.client, thread, "fail now");
  await b.sync();
  assert.equal(b.thread(thread).unseen, true);

  // A seen without a revision clears it whatever came before.
  assert.equal((await b.client.call("thread.mark", { thread, unseen: false })).thread.unseen, undefined);
  // A device may mark it unseen itself, which is no turn: a seen from before the mark clears it.
  await b.sync();
  assert.equal((await a.client.call("thread.mark", { thread, unseen: true })).thread.unseen, true);
  assert.equal((await b.client.call("thread.mark", { thread, unseen: false, revision: b.thread(thread).revision })).thread.unseen, undefined);
});

test("a seen sent before a newer turn ended leaves that turn's unseen; a change elsewhere in between does not hold it back", async (t) => {
  const { a, b } = await devices(t);
  const thread = await createThread(a.client);
  await runTurn(a.client, thread, "one");
  await b.sync();
  const held = b.thread(thread).revision;

  // A turn ends after B listed the thread: B's seen, on its way meanwhile, is for the turn before.
  await runTurn(a.client, thread, "two");
  const late = await b.client.call("thread.mark", { thread, unseen: false, revision: held });
  assert.equal(late.thread.unseen, true);
  await a.sync();
  assert.equal(a.thread(thread).unseen, true);

  // A pin and a preview made after B listed it are not turns: B's seen still clears it.
  await b.sync();
  await a.client.call("thread.mark", { thread, pinned: true });
  const seen = await b.client.call("thread.mark", { thread, unseen: false, revision: b.thread(thread).revision });
  assert.equal(seen.thread.unseen, undefined);

  // A turn that started after B listed it holds back B's seen too: B has not seen what it says.
  await b.sync();
  const listedAt = b.thread(thread).revision;
  await a.client.call("thread.mark", { thread, unseen: true });
  const start = await startSlow(a.client, thread);
  assert.equal((await b.client.call("thread.mark", { thread, unseen: false, revision: listedAt })).thread.unseen, true);
  await stop(a.client, thread, start);

  // A seen listed under another list (a bridge home before this one) says nothing of this one: named so, or with a revision ahead of this list's.
  const now = (await b.sync()).list;
  assert.equal((await b.client.call("thread.mark", { thread, unseen: false, revision: now.revision, list: "a-list-before" })).thread.unseen, true);
  assert.equal((await b.client.call("thread.mark", { thread, unseen: false, revision: now.revision + 500 })).thread.unseen, true);
  assert.equal((await b.client.call("thread.mark", { thread, unseen: false, revision: now.revision, list: now.id })).thread.unseen, undefined);
});

test("a seen that names the turn it is of clears that turn's unseen, but not a later turn's, whichever revision it goes with (net-20)", async (t) => {
  const { a, b } = await devices(t);
  const thread = await createThread(a.client);
  // B followed the first turn's start, then read its end before its list had it.
  const start = await startSlow(a.client, thread);
  await b.sync();
  const read = b.thread(thread).turn;
  assert.equal(typeof read, "number");
  await stop(a.client, thread, start);
  // Another turn, from A, begins and ends before B's seen reaches the bridge: B's list,
  // fetched now, has the later turn, and the seen goes with the revision it lists.
  await runTurn(a.client, thread, "two");
  await b.sync();
  assert.notEqual(b.thread(thread).turn, read);
  const late = await b.client.call("thread.mark", { thread, unseen: false, revision: b.thread(thread).revision, turn: read });
  assert.equal(late.thread.unseen, true);
  await a.sync();
  assert.equal(a.thread(thread).unseen, true);

  // The other order: the seen of the turn read comes before another begins, and clears it;
  // the next turn's end marks it unseen again, and the same seen sent late leaves that.
  const latest = b.thread(thread).turn;
  assert.equal((await b.client.call("thread.mark", { thread, unseen: false, revision: b.thread(thread).revision, turn: latest })).thread.unseen, undefined);
  await runTurn(a.client, thread, "three");
  await b.sync();
  assert.equal(b.thread(thread).unseen, true);
  assert.equal((await b.client.call("thread.mark", { thread, unseen: false, revision: b.thread(thread).revision, turn: latest })).thread.unseen, true);
  // Without `turn` (an older app), the revision alone, as before.
  assert.equal((await b.client.call("thread.mark", { thread, unseen: false, revision: b.thread(thread).revision })).thread.unseen, undefined);
});

test("a turn's live message.complete names the turn as the list lists it, so a device that heard nothing of it before can name it in its seen (net-20)", async (t) => {
  const { a, b } = await devices(t);
  const thread = await createThread(a.client);
  const completeOf = (events: Frame[]) => events.find((event) => event.type === "message.complete")!.payload;
  // A quick turn B's list never had: its end alone names it.
  const first = completeOf(await runTurn(a.client, thread, "one"));
  await b.sync();
  assert.equal(typeof first.turn, "number");
  assert.equal(first.turn, b.thread(thread).turn);
  // The next turn is another one, and its end says so.
  const second = completeOf(await runTurn(a.client, thread, "two"));
  await b.sync();
  assert.notEqual(second.turn, first.turn);
  assert.equal(second.turn, b.thread(thread).turn);
  // A turn stopped ends naming its turn too, and the seen naming it clears it.
  const start = await startSlow(a.client, thread);
  const stopped = (await stop(a.client, thread, start)).payload;
  await b.sync();
  assert.equal(stopped.turn, b.thread(thread).turn);
  assert.equal((await b.client.call("thread.mark", { thread, unseen: false, revision: b.thread(thread).revision, turn: stopped.turn })).thread.unseen, undefined);
});

test("thread.mark refuses a thread it does not know, one on a linked Mac and a call that marks nothing; a preview is taken only by a thread with none", async (t) => {
  const { a, b } = await devices(t);
  await assert.rejects(a.client.call("thread.mark", { thread: "no-such-thread", pinned: true }), unknown);
  await assert.rejects(a.client.call("thread.mark", { thread: "mini/6d3c", pinned: true }), unknown);
  const thread = await createThread(a.client);
  await assert.rejects(a.client.call("thread.mark", { thread }), invalid);
  await assert.rejects(a.client.call("thread.mark", { thread, revision: 3 }), invalid);
  await assert.rejects(a.client.call("thread.mark", { thread, pinned: null }), invalid);
  await assert.rejects(a.client.call("thread.mark", { thread, pinned: "yes" }), invalid);
  await assert.rejects(a.client.call("thread.mark", {}), invalid);

  // A thread with no message yet has no preview: a device's own is taken, worded as the bridge words one.
  await b.sync();
  const before = b.thread(thread);
  assert.equal(before.preview, undefined);
  const given = await b.client.call("thread.mark", { thread, preview: "[Portals: from Aeri (thread aeri)]\nThe device's copy\nmore" });
  assert.equal(given.thread.preview, "The device's copy");
  assert.equal(given.thread.updated, before.updated);
  assert.equal((await a.client.call("thread.mark", { thread, preview: "Another" })).thread.preview, "The device's copy");
  // A turn's message is its preview from then on.
  await runTurn(a.client, thread, "the newest message");
  await b.sync();
  assert.equal(b.thread(thread).preview, "the newest message");
});

// MARK: Revisions

test("changing the model, level, mode or title leaves the thread's time; the model, level and mode leave the list's revision too", async (t) => {
  const first = await devices(t);
  const thread = await createThread(first.a.client);
  await runTurn(first.a.client, thread, "hello");
  await first.bridge.dispose();
  // Its last turn long ago.
  const file = stored(first.bridge.home);
  file.threads.find((record: Frame) => record.id === thread).updatedAt = 1000;
  store(first.bridge.home, file);

  const { a, b } = await devices(t, first);
  await a.client.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
  await b.sync();
  const revision = b.revision;
  assert.equal(b.thread(thread).updated, 1000);

  await a.client.call("config.set", { key: "model", value: "fake-2 --session", session_id: thread, profile: "fake" });
  await a.client.call("config.set", { key: "reasoning", value: "high", session_id: thread, profile: "fake" });
  assert.deepEqual(await a.client.call("session.set_mode", { session_id: thread, mode: "plan", profile: "fake" }), { mode: "plan" });
  const unchanged = await b.sync();
  assert.deepEqual(unchanged.threads, []);
  assert.equal(unchanged.list.revision, revision);
  const record = stored(first.bridge.home).threads.find((entry: Frame) => entry.id === thread);
  assert.deepEqual([record.model, record.reasoningEffort, record.mode, record.modeBeforePlan, record.updatedAt], ["fake-2", "high", "plan", "default", 1000]);

  await a.client.call("session.rename", { session_id: thread, title: "A title of my own", profile: "fake" });
  const renamed = await b.sync();
  assert.deepEqual(renamed.threads.map((entry: Frame) => [entry.id, entry.title, entry.updated]), [[thread, "A title of my own", 1000]]);

  // A turn moves it.
  await runTurn(a.client, thread, "again");
  await b.sync();
  assert.ok(b.thread(thread).updated > 1000);
});

test("a delta carries only what changed, and nothing while nothing changes", async (t) => {
  const { a, b } = await devices(t);
  const one = await createThread(a.client);
  const two = await createThread(a.client);
  const full = await b.sync();
  assert.equal(full.full, true);
  assert.deepEqual(new Set(full.threads.map((entry: Frame) => entry.id)), new Set([one, two]));

  await a.client.call("thread.mark", { thread: two, pinned: true });
  const delta = await b.sync();
  assert.equal(delta.full, undefined);
  assert.deepEqual(delta.threads.map((entry: Frame) => entry.id), [two]);
  assert.deepEqual(delta.removed, []);
  // A mark that changes nothing moves nothing.
  await a.client.call("thread.mark", { thread: two, pinned: true });
  const none = await b.sync();
  assert.deepEqual(none.threads, []);
  assert.equal(none.list.revision, delta.list.revision);
});

test("another list's id, a revision ahead or none at all is answered with the whole list", async (t) => {
  const { a } = await devices(t);
  const thread = await createThread(a.client);
  const { id, revision } = (await a.client.call("sessions.activity")).thread_list;
  const whole = (params: Record<string, unknown>) => a.client.call("threads.changes", params);
  for (const params of [{}, { list: id }, { since: revision }, { list: "0123456789abcdef", since: revision }, { list: id, since: revision + 5 }, { list: id, since: -1 }, { list: id, since: null }]) {
    const answer = await whole(params);
    assert.equal(answer.full, true, JSON.stringify(params));
    assert.deepEqual(answer.list, { id, revision });
    assert.deepEqual(answer.threads.map((entry: Frame) => entry.id), [thread]);
  }
  assert.deepEqual(await whole({ list: id, since: revision }), { list: { id, revision }, threads: [], removed: [] });
  await assert.rejects(whole({ list: id, since: "3" }), invalid);
});

test("the list's id and revision survive a restart", async (t) => {
  const first = await devices(t);
  const thread = await createThread(first.a.client);
  await first.a.client.call("thread.mark", { thread, pinned: true });
  await first.b.sync();
  await first.bridge.dispose();

  const { a, b } = await devices(t, first);
  const restarted = new Device(b.client);
  restarted.list = first.b.list;
  restarted.revision = first.b.revision;
  const answer = await restarted.sync();
  assert.equal(answer.full, undefined);
  assert.deepEqual(answer.threads, []);
  assert.deepEqual(answer.list, { id: first.b.list, revision: first.b.revision });
  // Changes go on from there.
  await a.client.call("thread.mark", { thread, pinned: false });
  const after = await restarted.sync();
  assert.deepEqual(after.threads.map((entry: Frame) => entry.id), [thread]);
  assert.equal(after.list.revision, first.b.revision! + 1);
});

test("a seen from before a turn that ended before a restart still leaves that turn's unseen", async (t) => {
  const first = await devices(t);
  const thread = await createThread(first.a.client);
  await runTurn(first.a.client, thread, "one");
  await first.b.sync();
  const held = first.b.thread(thread).revision;
  await runTurn(first.a.client, thread, "two");
  await first.bridge.dispose();

  const { b } = await devices(t, first);
  assert.equal((await b.client.call("thread.mark", { thread, unseen: false, revision: held })).thread.unseen, true);
});

test("a threads.json that is not JSON, or whose list is not one, gives a new list, saved at once", () => {
  const home = temporaryHome();
  try {
    const path = join(home, "threads.json");
    writeFileSync(path, "{ not json");
    const fresh = new Registry(path);
    assert.match(fresh.list, /^[0-9a-f]{16}$/);
    assert.equal(fresh.revision, 1);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { list: fresh.list, revision: 1, threads: [] });

    const record = { id: "t1", agent: "fake", cwd: home, title: null, model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone", revision: 7, turnRevision: 9 };
    for (const odd of [{ list: 5, revision: 3 }, { list: "", revision: 3 }, { list: "abc", revision: "3" }, { list: "abc", revision: -1 }]) {
      writeFileSync(path, JSON.stringify({ ...odd, threads: [record] }));
      const made = new Registry(path);
      assert.notEqual(made.list, "abc");
      assert.equal(made.revision, 10, JSON.stringify(odd));
      assert.equal(made.get("t1")?.title, null);
    }
    // A list that is one is kept.
    writeFileSync(path, JSON.stringify({ list: "abc", revision: 12, threads: [record] }));
    assert.deepEqual([new Registry(path).list, new Registry(path).revision], ["abc", 12]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** The errors logged from now until the test ends, a line each. */
function loggedErrors(t: TestContext): () => string[] {
  const written = t.mock.method(process.stderr, "write", () => true);
  setLogLevel("error");
  t.after(() => setLogLevel("silent"));
  return () => written.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes(" error "));
}

/** The files in `home` moved aside from `name`, by their contents; each is taken out of the folder. */
function movedAsideIn(home: string, name: string): string[] {
  return readdirSync(home)
    .filter((file) => file.startsWith(`${name}.corrupt-`))
    .map((file) => {
      chmodSync(join(home, file), 0o600);
      const bytes = readFileSync(join(home, file), "utf8");
      rmSync(join(home, file));
      return bytes;
    });
}

test("a threads.json or removed.json that is there but cannot be read, is not JSON or holds no object is moved aside, with an error in the log, and with no file kept from before it the bridge goes on without it", (t) => {
  const errors = loggedErrors(t);
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "threads.json");
  const removedPath = join(home, "removed.json");
  const record = { id: "t1", agent: "fake", cwd: home, title: null, model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone", revision: 3 };
  const list = JSON.stringify({ list: "abc", revision: 12, threads: [record] });
  const movedAside = (name: string) => movedAsideIn(home, name);
  // Cut short (a power cut while it was written), not JSON, and JSON with no object in it.
  const unusable = ["", list.slice(0, 40), "{ not json", "null", "[]", "7", '"threads"'];
  for (const bytes of unusable) {
    writeFileSync(path, bytes);
    const fresh = new Registry(path);
    assert.deepEqual(movedAside("threads.json"), [bytes], JSON.stringify(bytes));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { list: fresh.list, revision: fresh.revision, threads: [] });
  }
  // One that cannot be read.
  writeFileSync(path, list);
  chmodSync(path, 0o000);
  assert.deepEqual(new Registry(path).all(), []);
  assert.deepEqual(movedAside("threads.json"), [list]);
  assert.equal(errors().length, unusable.length + 1);
  assert.ok(errors().every((line) => line.includes("threads.json")));

  // removed.json: the list is kept, and the threads taken off it are none.
  writeFileSync(path, list);
  for (const bytes of unusable) {
    writeFileSync(removedPath, bytes);
    const registry = new Registry(path);
    assert.deepEqual([registry.list, registry.revision, registry.allRemoved()], ["abc", 12, []]);
    assert.deepEqual(movedAside("removed.json"), [bytes], JSON.stringify(bytes));
    assert.equal(existsSync(removedPath), false);
  }
  assert.equal(errors().filter((line) => line.includes("removed.json")).length, unusable.length);
  // A list that is one, and removed.json missing, are taken as they are.
  assert.deepEqual(new Registry(path).get("t1")?.revision, 3);
  assert.deepEqual([movedAside("threads.json"), movedAside("removed.json")], [[], []]);
});

test("each save of threads.json and removed.json keeps the file it replaces as <file>.bak, never taking the file away from its name; the first save, with no file before it, keeps none", (t) => {
  const home = temporaryHome();
  const path = join(home, "threads.json");
  const removedPath = join(home, "removed.json");
  // The renames, in order: each from where to where.
  let steps: string[] = [];
  const { renameSync: rename } = fs;
  t.after(() => {
    fs.renameSync = rename;
    syncBuiltinESMExports();
    rmSync(home, { recursive: true, force: true });
  });
  const named = (file: string) => String(file).slice(home.length + 1).replace(String(process.pid), "<pid>");
  fs.renameSync = ((from, to) => {
    steps.push(`${named(String(from))} to ${named(String(to))}`);
    rename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  const read = (file: string) => readFileSync(file, "utf8");
  const replaces = (name: string) => [`${name}.bak.<pid>.tmp to ${name}.bak`, `${name}.<pid>.tmp to ${name}`];

  const registry = new Registry(path);
  assert.deepEqual(steps, ["threads.json.<pid>.tmp to threads.json"]);
  assert.equal(existsSync(`${path}.bak`), false);
  let before = read(path);
  steps = [];
  registry.add({ id: "t1", agent: "fake", cwd: home, title: null, model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone" });
  assert.deepEqual(steps, replaces("threads.json"));
  assert.equal(read(`${path}.bak`), before);
  assert.equal(statSync(`${path}.bak`).mode & 0o777, 0o600);
  // Each save moves it on: the one before is let go of.
  before = read(path);
  registry.set("t1", { pinned: true });
  assert.equal(read(`${path}.bak`), before);

  // removed.json: its first save keeps none, its next keeps the one before.
  before = read(path);
  steps = [];
  registry.remove("t1");
  assert.deepEqual(steps, ["removed.json.<pid>.tmp to removed.json", ...replaces("threads.json")]);
  assert.equal(read(`${path}.bak`), before);
  assert.equal(existsSync(`${removedPath}.bak`), false);
  const removedBefore = read(removedPath);
  before = read(path);
  steps = [];
  registry.add({ id: "t1", agent: "fake", cwd: home, title: null, model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone" });
  assert.deepEqual(steps, [...replaces("threads.json"), ...replaces("removed.json")]);
  assert.deepEqual([read(`${path}.bak`), read(`${removedPath}.bak`)], [before, removedBefore]);

  // A second name left behind by a process with this one's id that stopped in between is no matter.
  writeFileSync(`${path}.bak.${process.pid}.tmp`, "left behind");
  before = read(path);
  registry.set("t1", { pinned: true });
  assert.equal(read(`${path}.bak`), before);
  assert.equal(existsSync(`${path}.bak.${process.pid}.tmp`), false);
});

test("on a disk that cannot give a file a second name (exFAT, some network shares), threads.json is saved all the same, with no .bak and one warning", (t) => {
  const written = t.mock.method(process.stderr, "write", () => true);
  setLogLevel("warn");
  const home = temporaryHome();
  const path = join(home, "threads.json");
  const { linkSync: link } = fs;
  t.after(() => {
    fs.linkSync = link;
    syncBuiltinESMExports();
    setLogLevel("silent");
    rmSync(home, { recursive: true, force: true });
  });
  fs.linkSync = (() => {
    throw Object.assign(new Error("ENOTSUP: operation not supported, link"), { code: "ENOTSUP" });
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();

  const registry = new Registry(path);
  registry.add({ id: "t1", agent: "fake", cwd: home, title: null, model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone" });
  registry.set("t1", { pinned: true });
  assert.equal(new Registry(path).get("t1")?.pinned, true);
  assert.deepEqual(readdirSync(home).sort(), ["threads.json"]);
  const warnings = written.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes(" warn "));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], / warn  threads\.json\.bak could not be kept: the file is saved without one \{/);
});

test("a threads.json that cannot be used is kept aside, and the threads come from threads.json.bak, the file it replaced, as a new list whose revision is above every stamp in the files, with an error in the log", (t) => {
  const errors = loggedErrors(t);
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "threads.json");
  const record = { id: "t1", agent: "fake", cwd: home, title: "Kept", model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone", pinned: true, revision: 3, turnRevision: 9 };
  const backup = JSON.stringify({ list: "abc", revision: 12, threads: [record] });
  writeFileSync(`${path}.bak`, backup);
  writeFileSync(join(home, "removed.json"), JSON.stringify({ threads: [{ revision: 15, thread: { ...record, id: "t2" } }] }));
  // What a power cut while it was written can leave.
  writeFileSync(path, "");

  const registry = new Registry(path);
  assert.match(registry.list, /^[0-9a-f]{16}$/);
  assert.notEqual(registry.list, "abc");
  assert.equal(registry.revision, 16);
  assert.deepEqual(registry.all(), [record]);
  assert.deepEqual(registry.removedSince(0), ["t2"]);
  // Nothing stamped under the list before counts as changed in this one.
  assert.deepEqual(registry.changedSince(registry.revision), []);
  // Saved at once as the new list, the bad file aside; threads.json.bak is as it was, until the next save.
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { list: registry.list, revision: 16, threads: [record] });
  assert.deepEqual(movedAsideIn(home, "threads.json"), [""]);
  assert.equal(readFileSync(`${path}.bak`, "utf8"), backup);
  assert.equal(errors().length, 1);
  assert.match(errors()[0], / error threads\.json could not be used: it is kept aside, and the bridge goes on with threads\.json\.bak, the file it replaced \{/);
  assert.equal(JSON.parse(errors()[0].slice(errors()[0].indexOf("{"))).why, "not JSON");
});

test("with neither threads.json nor threads.json.bak usable the list is a new, empty one, and both are kept aside", (t) => {
  const errors = loggedErrors(t);
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "threads.json");
  writeFileSync(`${path}.bak`, "{ not json");
  writeFileSync(path, "");

  const registry = new Registry(path);
  assert.deepEqual(registry.all(), []);
  assert.equal(registry.revision, 1);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { list: registry.list, revision: 1, threads: [] });
  assert.deepEqual([movedAsideIn(home, "threads.json"), movedAsideIn(home, "threads.json.bak")], [[""], ["{ not json"]]);
  assert.equal(existsSync(`${path}.bak`), false);
  assert.equal(errors().length, 2);
  assert.match(errors()[0], / error threads\.json could not be used: it was moved aside, and the bridge goes on without it \{/);
  assert.match(errors()[1], / error threads\.json\.bak, the file it replaced, could not be used either: it was moved aside \{/);
});

test("a removed.json that cannot be used is kept aside, and the threads taken off the list come from removed.json.bak, saved at once, the list kept; with neither usable there are none, and both are kept aside", (t) => {
  const errors = loggedErrors(t);
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "threads.json");
  const removedPath = join(home, "removed.json");
  const record = { id: "t1", agent: "fake", cwd: home, title: null, model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone", revision: 3 };
  writeFileSync(path, JSON.stringify({ list: "abc", revision: 12, threads: [record] }));
  const backup = JSON.stringify({ threads: [{ revision: 10, thread: { ...record, id: "t2" } }] });
  writeFileSync(`${removedPath}.bak`, backup);
  writeFileSync(removedPath, "");

  const registry = new Registry(path);
  assert.deepEqual([registry.list, registry.revision, registry.removedSince(0), registry.removedSince(10)], ["abc", 12, ["t2"], []]);
  assert.deepEqual(JSON.parse(readFileSync(removedPath, "utf8")), JSON.parse(backup));
  assert.deepEqual(movedAsideIn(home, "removed.json"), [""]);
  assert.equal(errors().length, 1);
  assert.match(errors()[0], / error removed\.json could not be used: it is kept aside, and the bridge goes on with removed\.json\.bak, the file it replaced \{/);

  writeFileSync(removedPath, "");
  writeFileSync(`${removedPath}.bak`, "[]");
  const again = new Registry(path);
  assert.deepEqual([again.list, again.revision, again.allRemoved()], ["abc", 12, []]);
  assert.deepEqual([movedAsideIn(home, "removed.json"), movedAsideIn(home, "removed.json.bak")], [[""], ["[]"]]);
  assert.deepEqual([existsSync(removedPath), existsSync(`${removedPath}.bak`)], [false, false]);
  assert.equal(errors().length, 3);
});

/** Makes `fs[name]` throw `code` for `file`, its first argument, until what this returns is called or the test ends. */
function failingAt(t: TestContext, name: "linkSync" | "renameSync" | "writeFileSync", file: string, code: string): () => void {
  const methods = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const real = methods[name];
  const restore = () => {
    methods[name] = real;
    syncBuiltinESMExports();
  };
  t.after(restore);
  methods[name] = (...args: unknown[]) => {
    if (String(args[0]) === file) throw Object.assign(new Error(`${code}: ${name} ${file}`), { code });
    return real(...args);
  };
  syncBuiltinESMExports();
  return restore;
}

/**
 * A save that fails as the file is written (the disk full), before the file it replaces is
 * kept aside, and a stop once it is, before the new one is renamed into its place: what is
 * kept aside after each.
 */
const failedSaves = [
  { step: "writeFileSync", code: "ENOSPC", keptAside: [] },
  { step: "renameSync", code: "EIO", keptAside: [""] },
] as const;

test("a threads.json that cannot be used keeps its name until the list from threads.json.bak has taken its place: a save that fails, or a stop before, leaves it, removed.json and their backups as they were, and the next start takes both from their backups again", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "threads.json");
  const removedPath = join(home, "removed.json");
  const record = { id: "t1", agent: "fake", cwd: home, title: "Kept", model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone", revision: 3 };
  const backup = JSON.stringify({ list: "abc", revision: 12, threads: [record] });
  const removedBackup = JSON.stringify({ threads: [{ revision: 10, thread: { ...record, id: "t2" } }] });
  const files = () => [path, `${path}.bak`, removedPath, `${removedPath}.bak`].map((file) => (existsSync(file) ? readFileSync(file, "utf8") : null));
  for (const { step, code, keptAside } of failedSaves) {
    writeFileSync(`${path}.bak`, backup);
    writeFileSync(`${removedPath}.bak`, removedBackup);
    writeFileSync(path, "");
    writeFileSync(removedPath, "");
    const restore = failingAt(t, step, `${path}.${process.pid}.tmp`, code);
    assert.throws(() => new Registry(path), { code });
    restore();
    assert.deepEqual(files(), ["", backup, "", removedBackup], step);
    assert.deepEqual([movedAsideIn(home, "threads.json"), movedAsideIn(home, "removed.json")], [keptAside, []], step);

    const registry = new Registry(path);
    assert.deepEqual([registry.all(), registry.removedSince(0)], [[record], ["t2"]], step);
    assert.notEqual(registry.list, "abc", step);
    // Each backup as it was until the next save, which keeps the file taken from it: never the one that could not be used.
    const [restored, , removedRestored] = files();
    assert.deepEqual([files()[1], files()[3]], [backup, removedBackup], step);
    registry.remove("t1");
    assert.deepEqual([files()[1], files()[3]], [restored, removedRestored], step);
    assert.deepEqual([movedAsideIn(home, "threads.json"), movedAsideIn(home, "removed.json")], [[""], [""]], step);
  }
});

test("a removed.json that cannot be used keeps its name until the threads taken off the list from removed.json.bak have taken its place: a save that fails, or a stop before, leaves it and its backup as they were, and the next start takes them from the backup again", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "threads.json");
  const removedPath = join(home, "removed.json");
  const record = { id: "t1", agent: "fake", cwd: home, title: null, model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone", revision: 3 };
  const removedBackup = JSON.stringify({ threads: [{ revision: 10, thread: { ...record, id: "t2" } }] });
  const files = () => [removedPath, `${removedPath}.bak`].map((file) => (existsSync(file) ? readFileSync(file, "utf8") : null));
  for (const { step, code, keptAside } of failedSaves) {
    writeFileSync(path, JSON.stringify({ list: "abc", revision: 12, threads: [record] }));
    writeFileSync(`${removedPath}.bak`, removedBackup);
    writeFileSync(removedPath, "");
    const restore = failingAt(t, step, `${removedPath}.${process.pid}.tmp`, code);
    assert.throws(() => new Registry(path), { code });
    restore();
    assert.deepEqual(files(), ["", removedBackup], step);
    assert.deepEqual(movedAsideIn(home, "removed.json"), keptAside, step);

    const registry = new Registry(path);
    assert.deepEqual([registry.list, registry.revision, registry.removedSince(0)], ["abc", 12, ["t2"]], step);
    const [restored, kept] = files();
    assert.equal(kept, removedBackup, step);
    registry.remove("t1");
    assert.equal(files()[1], restored, step);
    assert.deepEqual(movedAsideIn(home, "removed.json"), [""], step);
  }
});

test("on a disk that cannot give a file a second name, a threads.json that cannot be used is moved aside as the list from threads.json.bak takes its place", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "threads.json");
  const record = { id: "t1", agent: "fake", cwd: home, title: "Kept", model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone", revision: 3 };
  const backup = JSON.stringify({ list: "abc", revision: 12, threads: [record] });
  writeFileSync(`${path}.bak`, backup);
  writeFileSync(path, "");
  failingAt(t, "linkSync", path, "ENOTSUP");

  assert.deepEqual(new Registry(path).all(), [record]);
  assert.deepEqual(movedAsideIn(home, "threads.json"), [""]);
  assert.equal(readFileSync(`${path}.bak`, "utf8"), backup);
});

test("on a disk that cannot give a file a second name, a restore that fails or is stopped before the restored list takes its place still leaves threads.json at its name, for the next start to take from threads.json.bak again", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "threads.json");
  const record = { id: "t1", agent: "fake", cwd: home, title: "Kept", model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone", revision: 3 };
  const backup = JSON.stringify({ list: "abc", revision: 12, threads: [record] });
  writeFileSync(`${path}.bak`, backup);
  writeFileSync(path, "");
  failingAt(t, "linkSync", path, "ENOTSUP");
  const restore = failingAt(t, "renameSync", `${path}.${process.pid}.tmp`, "EIO");

  assert.throws(() => new Registry(path), /EIO/);
  assert.equal(readFileSync(path, "utf8"), "");
  assert.equal(readFileSync(`${path}.bak`, "utf8"), backup);
  restore();
  assert.deepEqual(new Registry(path).all(), [record]);
  assert.equal(readFileSync(`${path}.bak`, "utf8"), backup);
});

test("a second name that fails for any other reason (the disk, a quota) leaves threads.json where it is and the start fails, so the next start takes the list from threads.json.bak again", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "threads.json");
  const record = { id: "t1", agent: "fake", cwd: home, title: "Kept", model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone", revision: 3 };
  const backup = JSON.stringify({ list: "abc", revision: 12, threads: [record] });
  writeFileSync(`${path}.bak`, backup);
  writeFileSync(path, "");
  const restore = failingAt(t, "linkSync", path, "EIO");

  assert.throws(() => new Registry(path), /EIO/);
  assert.equal(readFileSync(path, "utf8"), "");
  assert.equal(readFileSync(`${path}.bak`, "utf8"), backup);
  assert.deepEqual(movedAsideIn(home, "threads.json"), []);
  restore();
  assert.deepEqual(new Registry(path).all(), [record]);
  assert.deepEqual(movedAsideIn(home, "threads.json"), [""]);
});

test("a device that held the list before threads.json could not be used takes the list from threads.json.bak whole, and nothing in it counts as changed after", async (t) => {
  const first = await devices(t);
  const thread = await createThread(first.a.client);
  await runTurn(first.a.client, thread, "first words");
  await first.a.client.call("thread.mark", { thread, pinned: true });
  await first.b.sync();
  // Saved after: the file before it is kept.
  await createThread(first.a.client);
  await first.bridge.dispose();
  const path = pathsFor(first.bridge.home).threads;
  const backup = JSON.parse(readFileSync(`${path}.bak`, "utf8"));
  writeFileSync(path, "");

  const { b } = await devices(t, first);
  b.list = first.b.list;
  b.revision = first.b.revision;
  for (const [id, listed] of first.b.threads) b.threads.set(id, listed);
  const answer = await b.sync();
  assert.equal(answer.full, true);
  assert.notEqual(answer.list.id, first.b.list);
  const stamps = backup.threads.flatMap((record: Frame) => [record.revision ?? 0, record.turnRevision ?? 0]);
  assert.ok(answer.list.revision > Math.max(backup.revision, ...stamps));
  assert.deepEqual([...b.threads.keys()].sort(), backup.threads.map((record: Frame) => record.id).sort());
  assert.equal(b.thread(thread).pinned, true);
  // Nothing stamped under the old list counts as changed in the new one.
  assert.deepEqual((await b.sync()).threads, []);
});

test("a file saved by a bridge from before the list gives a new list, whose revision starts above the old stamps", async (t) => {
  const first = await devices(t);
  const thread = await createThread(first.a.client);
  await first.a.client.call("thread.mark", { thread, pinned: true });
  await first.b.sync();
  await first.bridge.dispose();
  // An older bridge keeps the records' keys and drops the rest.
  const { list: _list, revision: _revision, ...older } = stored(first.bridge.home);
  older.threads[0].revision = 50;
  older.threads[0].turnRevision = 60;
  store(first.bridge.home, older);

  const { b } = await devices(t, first);
  const now = (await b.client.call("sessions.activity")).thread_list;
  assert.notEqual(now.id, first.b.list);
  assert.ok(now.revision > 60);
  assert.equal(stored(first.bridge.home).list, now.id);

  // A device that held the old list takes the new one whole, marks and all.
  const device = new Device(b.client);
  device.list = first.b.list;
  device.revision = first.b.revision;
  const answer = await device.sync();
  assert.equal(answer.full, true);
  assert.equal(device.thread(thread).pinned, true);
  // Nothing stamped under the old list counts as changed in the new one.
  assert.deepEqual((await device.sync()).threads, []);
});

test("a thread from before previews takes one the first time it is loaded, and keeps its place", async (t) => {
  const first = await devices(t);
  const thread = await createThread(first.a.client);
  await runTurn(first.a.client, thread, "an old message\nwith more");
  await first.bridge.dispose();
  const file = stored(first.bridge.home);
  const record = file.threads.find((entry: Frame) => entry.id === thread);
  delete record.preview;
  record.updatedAt = 1000;
  store(first.bridge.home, file);

  const { a, b } = await devices(t, first);
  await b.sync();
  assert.equal(b.thread(thread).preview, undefined);
  // Listing loads nothing; opening it does.
  await a.client.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
  await b.sync();
  assert.equal(b.thread(thread).preview, "an old message");
  assert.equal(b.thread(thread).updated, 1000);
});

test("a thread loads when threads.json cannot be written: neither the end of a turn that ended while the bridge was off nor a first preview fails its load, the record only left out", async (t) => {
  const first = await devices(t);
  const ended = await createThread(first.a.client);
  await runTurn(first.a.client, ended, "an old message");
  const older = await createThread(first.a.client);
  await runTurn(first.a.client, older, "from before previews");
  await first.bridge.dispose();
  const file = stored(first.bridge.home);
  // Its turn's start recorded, its end not: the bridge stopped in between.
  file.threads.find((entry: Frame) => entry.id === ended).inTurn = true;
  delete file.threads.find((entry: Frame) => entry.id === older).preview;
  store(first.bridge.home, file);

  const { bridge, a } = await devices(t, first);
  const before = readFileSync(pathsFor(bridge.home).threads, "utf8");
  const unblock = blockThreads(bridge.home);
  for (const thread of [ended, older]) {
    const resumed = await a.client.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
    assert.equal(resumed.session_id, thread);
    assert.equal(resumed.running, false);
  }
  assert.equal(readFileSync(pathsFor(bridge.home).threads, "utf8"), before);
  // Loaded, and at work as any other.
  unblock();
  await runTurn(a.client, ended, "after");
  await runTurn(a.client, older, "after too");
  const records = stored(bridge.home).threads;
  assert.deepEqual(
    [ended, older].map((id) => [records.find((entry: Frame) => entry.id === id).inTurn, records.find((entry: Frame) => entry.id === id).preview]),
    [[undefined, "after"], [undefined, "after too"]],
  );
});

// MARK: Older clients

test("a client that never calls the new methods sees what it saw before", async (t) => {
  const { a, b } = await devices(t);
  const thread = await createThread(a.client);
  const events = await runTurn(a.client, thread, "hello");
  await b.client.call("thread.mark", { thread, pinned: true });

  // A turn's events are the ones it always had, and nothing else is sent.
  assert.deepEqual([...new Set(events.map((event: Frame) => event.type))].sort(), ["message.complete", "message.delta", "message.start", "session.title"]);
  assert.ok(a.client.frames.every((frame: Frame) => frame.method !== "event" || frame.params.session_id === thread || frame.params.type === "gateway.ready"));
  // The fleet's listing and answers carry no new keys.
  const fleetKeys = ["agent", "agent_name", "folder", "id", "state", "title", "updated"];
  const listed = (await a.client.call("threads.list", { local: true })).threads.find((entry: Frame) => entry.id === thread);
  assert.deepEqual(Object.keys(listed).sort(), fleetKeys);
  const started = (await a.client.call("thread.start", { profile: "fake" })).thread;
  assert.deepEqual(Object.keys(started).sort(), fleetKeys.filter((key) => key !== "title"));
  // sessions.activity still lists what is at work, beside the keys such a client never reads.
  const activity = await a.client.call("sessions.activity");
  assert.deepEqual(Object.keys(activity).sort(), ["looks", "order", "sessions", "thread_list"]);
  assert.deepEqual(activity.sessions, []);
  const read = await a.client.call("thread.read", { thread });
  assert.deepEqual(Object.keys(read).sort(), ["messages", "open_requests", "thread"]);
  assert.deepEqual(Object.keys(read.thread).sort(), fleetKeys);
  const sent = await a.client.call("thread.send", { thread, text: "and again", wait: true });
  assert.deepEqual(Object.keys(sent).sort(), ["open_requests", "reply", "state", "status", "timed_out"]);
  assert.deepEqual(Object.keys(await a.client.call("thread.wait", { thread })).sort(), ["open_requests", "reply", "state", "timed_out"]);
  // A thread's own answers carry none of the list's keys (`latest_seq`, of turn_messages, is
  // the answer's own: an app that does not read it takes every event after the answer, as before).
  const resumed = await a.client.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
  assert.deepEqual(Object.keys(resumed).sort(), ["info", "latest_seq", "messages", "open_requests", "running", "session_id"]);
  const listKeys = ["created", "revision", "preview", "pinned", "archived", "unseen", "started_by"];
  assert.ok(listKeys.every((key) => !(key in resumed.info)));
});

// MARK: Previews

test("a preview is the first line of the message with something on it, without the fleet's line, cut as the app cuts it", () => {
  assert.equal(previewOf("hello\nworld"), "hello");
  // A line of spaces says nothing; the app leaves out such lines too (S4).
  assert.equal(previewOf("\n\n   \nsecond"), "second");
  assert.equal(previewOf("[Portals: from Aeri (thread aeri)]\ndo the thing"), "do the thing");
  assert.equal(previewOf("look at this\n@image:a.jpg"), "look at this");
  assert.equal(previewOf("@image:a.jpg"), "Image");
  assert.equal(previewOf("@image:a.jpg\n@image:b.png"), "2 images");
  assert.equal(previewOf(""), undefined);
  assert.equal(previewOf("x".repeat(300)), "x".repeat(140));
  // By characters as a person sees them: an emoji with a skin tone is never cut in two.
  assert.equal(previewOf("👍🏽".repeat(150)), "👍🏽".repeat(140));
  const messages: StoredMessage[] = [
    { role: "user", text: "the first", timestamp: 1 },
    { role: "assistant", text: "Done.", timestamp: 2 },
    { role: "user", text: "steered in", timestamp: 3, display_kind: "steer" },
    { role: "user", text: "", timestamp: 4, display_kind: "hidden" },
    { role: "user", text: "A background process finished", timestamp: 5, display_kind: "process_complete" },
  ];
  assert.equal(lastPreview(messages), "steered in");
  assert.equal(lastPreview(messages.slice(0, 2)), "the first");
  assert.equal(lastPreview([]), undefined);
});

test("a message handed to the running turn is the preview, and stays when the agent turns it down", async (t) => {
  // An agent like Codex, whose turn can end before it says it did not take the message.
  const home = temporaryHome();
  const settings = { model: "stub", provider: "stub", reasoningEffort: "" };
  const provider = {
    profile: { name: "stub", displayName: "Stub", description: "", model: "stub", provider: "stub" },
    async startSession(_options: unknown, sink: SessionSink): Promise<ProviderSession> {
      return {
        history: async () => [],
        settings: () => settings,
        startTurn() {
          setTimeout(() => sink.emit({ type: "turn.end", status: "complete" }), 20);
        },
        steer: async () => {
          await sleep(50);
          return false;
        },
        interrupt: async () => false,
        close: async () => {},
      } as unknown as ProviderSession;
    },
  } as unknown as Provider;
  const providers = new Map<string, Provider>([["stub", provider]]);
  const registry = new Registry(join(home, "threads.json"));
  const sessions = new SessionManager({ registry, providers });
  const fleet = new Fleet({ sessions, providers, folders: new Folders({ general: home, hide: [], own: [], sources: [] }), links: new Links(join(home, "links.json")), here: { id: "0123456789abcdef", name: "Test Mac" } });
  t.after(async () => {
    fleet.close();
    await sessions.close();
    rmSync(home, { recursive: true, force: true });
  });

  const session = await sessions.create({ agent: "stub", cwd: home, title: null, settings });
  session.submit("first").begin?.();
  assert.equal(registry.get(session.id)?.preview, "first");
  assert.equal(session.submit("second\nmore").status, "steered");
  assert.equal(registry.get(session.id)?.preview, "second");
  // Turned down, it runs in a turn of its own, which keeps the preview it gave.
  await fleet.wait(session.id, 5000);
  assert.equal(registry.get(session.id)?.preview, "second");
  assert.equal(session.messages.filter((message) => message.role === "user").length, 3);
});

test("a message handed to the running turn whose preview cannot be saved in threads.json still reaches the agent", async (t) => {
  const home = temporaryHome();
  const settings = { model: "stub", provider: "stub", reasoningEffort: "" };
  let end: (() => void) | undefined;
  const steered: string[] = [];
  const provider = {
    profile: { name: "stub", displayName: "Stub", description: "", model: "stub", provider: "stub" },
    async startSession(_options: unknown, sink: SessionSink): Promise<ProviderSession> {
      return {
        history: async () => [],
        settings: () => settings,
        startTurn() {
          end = () => sink.emit({ type: "turn.end", status: "complete" });
        },
        steer: async (prompt: { text: string }) => {
          steered.push(prompt.text);
          return true;
        },
        interrupt: async () => false,
        close: async () => {},
      } as unknown as ProviderSession;
    },
  } as unknown as Provider;
  const providers = new Map<string, Provider>([["stub", provider]]);
  const registry = new Registry(join(home, "threads.json"));
  const sessions = new SessionManager({ registry, providers });
  const fleet = new Fleet({ sessions, providers, folders: new Folders({ general: home, hide: [], own: [], sources: [] }), links: new Links(join(home, "links.json")), here: { id: "0123456789abcdef", name: "Test Mac" } });
  t.after(async () => {
    fleet.close();
    await sessions.close();
    rmSync(home, { recursive: true, force: true });
  });

  const session = await sessions.create({ agent: "stub", cwd: home, title: null, settings });
  session.submit("first").begin?.();
  const blocker = join(home, `threads.json.${process.pid}.tmp`);
  mkdirSync(blocker);
  assert.equal(session.submit("second").status, "steered");
  await sleep(0);
  assert.deepEqual(steered, ["second"]);
  // Left out of the record only.
  assert.equal(registry.get(session.id)?.preview, "first");
  assert.equal(JSON.parse(readFileSync(join(home, "threads.json"), "utf8")).threads[0].preview, "first");

  rmSync(blocker, { recursive: true });
  end!();
  const rest = await fleet.wait(session.id, 2000);
  assert.deepEqual([rest.state, rest.timed_out], ["idle", false]);
  assert.deepEqual(
    session.messages.filter((message) => message.role === "user").map((message) => message.text),
    ["first", "second"],
  );
});

// MARK: Removing

/** What `thread.delete` answers for a thread at work. */
const atWork = (agent: string) => (error: RpcFailure) => error.code === -32602 && error.message === `${agent} is still working in this thread. Stop it, then remove it.`;

/** Registers threads for notifications on `bridge`, as the app does. */
async function watch(bridge: TestBridge, threads: string[]): Promise<void> {
  const response = await fetch(`${bridge.url}/api/plugins/aeriportal-push/registration`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: await sessionCookie(bridge) },
    body: JSON.stringify({ device: { token: "b2".repeat(32), environment: "sandbox", bundle_id: "com.danielou.portals" }, threads: threads.map((id) => ({ id, agent: "fake", agent_name: "Fake agent", title: "" })) }),
  });
  assert.equal(response.status, 200);
}

test("thread.delete takes an idle thread off the list: the other device's changes say so, and its notifications stop", async (t) => {
  const { bridge, agent, a, b } = await devices(t);
  const thread = await createThread(a.client);
  const kept = await createThread(a.client);
  await runTurn(a.client, thread, "hello");
  await watch(bridge, [thread, kept]);
  await b.sync();
  const held = b.revision!;

  assert.deepEqual(await a.client.call("thread.delete", { thread }), {});
  const answer = await b.sync();
  assert.equal(answer.full, undefined);
  assert.deepEqual(answer.threads, []);
  assert.deepEqual(answer.removed, [thread]);
  assert.equal(answer.list.revision, held + 1);
  assert.deepEqual([...b.threads.keys()], [kept]);
  // Asked again, nothing more; a device that holds another list hears of it among every removal.
  assert.deepEqual((await b.sync()).removed, []);
  const whole = await a.client.call("threads.changes", {});
  assert.deepEqual([whole.full, whole.removed, whole.threads.map((entry: Frame) => entry.id)], [true, [thread], [kept]]);
  assert.deepEqual(
    (await a.client.call("threads.list", { local: true })).threads.map((entry: Frame) => entry.id),
    [kept],
  );

  // Its notifications stop; the other thread's go on.
  const push = JSON.parse(readFileSync(pathsFor(bridge.home).push, "utf8"));
  assert.deepEqual(Object.keys(push.threads), [kept]);
  // The record is kept in removed.json, with the revision it was removed at; the agent's own conversation is untouched.
  const [entry] = removedFile(bridge.home).threads;
  assert.equal(entry.revision, held + 1);
  assert.equal(entry.thread.id, thread);
  assert.equal(entry.thread.preview, "hello");
  assert.deepEqual(stored(bridge.home).threads.map((record: Frame) => record.id), [kept]);
  assert.ok(existsSync(join(agent.directory, `${thread}.json`)));

  // Gone, it is a thread the bridge does not know.
  await assert.rejects(a.client.call("thread.delete", { thread }), unknown);
  await assert.rejects(a.client.call("thread.delete", { thread: `mini/${kept}` }), unknown);
  await assert.rejects(a.client.call("thread.delete", {}), invalid);
});

test("thread.delete is refused while a turn runs or a question waits, and takes the thread once it is at rest", async (t) => {
  const { a, b } = await devices(t);
  const thread = await createThread(a.client);
  await b.sync();

  // A turn running, followed here or not.
  const start = await startSlow(a.client, thread);
  await assert.rejects(b.client.call("thread.delete", { thread }), atWork("Fake agent"));
  await stop(a.client, thread, start);

  // A question open.
  const asked = a.client.frames.length;
  await a.client.call("prompt.submit", { session_id: thread, text: "ask me", profile: "fake" });
  const question = await a.client.nextRequest();
  await assert.rejects(b.client.call("thread.delete", { thread }), atWork("Fake agent"));
  a.client.answer(question.id, { answers: { q0: "Swift" } });
  await a.client.from(asked, (frame) => isEvent(frame, "message.complete", thread));

  // Nothing of it was removed meanwhile.
  assert.deepEqual((await b.sync()).removed, []);
  assert.deepEqual(await b.client.call("thread.delete", { thread }), {});
  assert.deepEqual((await a.sync()).threads.map((entry: Frame) => entry.id), []);
});

test("thread.delete is refused while a message handed to the running turn is not yet taken, and a removed session starts nothing", async (t) => {
  // An agent like Codex, which says late whether it took a message handed to its turn.
  const home = temporaryHome();
  const settings = { model: "stub", provider: "stub", reasoningEffort: "" };
  let turns = 0;
  let steered: ((taken: boolean) => void) | undefined;
  const provider = {
    profile: { name: "stub", displayName: "Stub", description: "", model: "stub", provider: "stub" },
    async startSession(_options: unknown, sink: SessionSink): Promise<ProviderSession> {
      return {
        history: async () => [],
        settings: () => settings,
        startTurn() {
          turns += 1;
          setTimeout(() => sink.emit({ type: "turn.end", status: "complete" }), 10);
        },
        steer: () => new Promise<boolean>((resolve) => (steered = resolve)),
        interrupt: async () => false,
        close: async () => {},
      } as unknown as ProviderSession;
    },
  } as unknown as Provider;
  const providers = new Map<string, Provider>([["stub", provider]]);
  const registry = new Registry(join(home, "threads.json"));
  const sessions = new SessionManager({ registry, providers });
  t.after(async () => {
    await sessions.close();
    rmSync(home, { recursive: true, force: true });
  });

  const session = await sessions.create({ agent: "stub", cwd: home, title: null, settings });
  // A turn reserved by a message, not begun yet.
  const first = session.submit("first");
  await assert.rejects(sessions.remove(session.id), RemoveRefused);
  first.begin?.();
  assert.equal(session.submit("second").status, "steered");
  while (session.isRunning) await sleep(5);
  // The turn has ended, but the agent may still answer the message with a turn of its own.
  await assert.rejects(sessions.remove(session.id), (error: Error) => error instanceof RemoveRefused && error.message === "Stub is still working in this thread. Stop it, then remove it.");
  steered!(true);
  await sleep(0);
  await sessions.remove(session.id);
  assert.equal(registry.get(session.id), undefined);
  assert.equal(sessions.get(session.id), undefined);
  // Whatever still holds the session starts nothing with it, and changes no record.
  assert.throws(() => session.submit("third"));
  assert.equal(turns, 1);
  assert.deepEqual(registry.allRemoved().map((record) => record.id), [session.id]);
  await assert.rejects(sessions.load(session.id), /There is no thread/);
});

test("after a delete, a message, a resume and thread.send start nothing", async (t) => {
  const { agent, a, b } = await devices(t);
  const thread = await createThread(a.client);
  await runTurn(a.client, thread, "hello");
  await b.client.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
  const conversation = readFileSync(join(agent.directory, `${thread}.json`), "utf8");
  await b.client.call("thread.delete", { thread });
  const after = a.client.frames.length;

  // The device that had it open is told it is not open, and resuming it finds no thread.
  await assert.rejects(a.client.call("prompt.submit", { session_id: thread, text: "again", profile: "fake" }), (error: RpcFailure) => error.code === 4001);
  await assert.rejects(a.client.call("session.resume", { session_id: thread, profile: "fake", inline_images: false }), unknown);
  await assert.rejects(a.client.call("thread.send", { thread, text: "again" }), unknown);
  await assert.rejects(a.client.call("thread.read", { thread }), unknown);
  await assert.rejects(a.client.call("thread.wait", { thread }), unknown);
  await assert.rejects(a.client.call("thread.mark", { thread, pinned: true }), unknown);
  await assert.rejects(a.client.call("session.rename", { session_id: thread, title: "New", profile: "fake" }), unknown);
  assert.deepEqual(await a.client.call("session.events.since", { session_id: thread, last_seen: 1 }), { events: [], truncated: true, latest_seq: 0, open_requests: [] });
  await sleep(30);
  assert.equal(a.client.frames.slice(after).filter((frame: Frame) => frame.method === "event").length, 0);
  assert.equal(readFileSync(join(agent.directory, `${thread}.json`), "utf8"), conversation);
  assert.deepEqual((await b.sync()).threads, []);
});

test("a removed thread of an agent with no sessions from the desk is offered there, and taken up again as it was", async (t) => {
  // The scripted agent of a plain test bridge lists no sessions from the desk and takes none up, as Hermes.
  const bridge = await startTestBridge();
  const a = new Device(await TestClient.open(bridge));
  const b = new Device(await TestClient.open(bridge));
  t.after(async () => {
    await Promise.all([a.client.close(), b.client.close()]);
    await bridge.dispose();
  });
  const thread = await createThread(a.client);
  const empty = await createThread(a.client);
  const first = await runTurn(a.client, thread, "remember this");
  await a.client.call("thread.mark", { thread, pinned: true });
  await a.client.call("thread.mark", { thread, unseen: false });
  assert.deepEqual((await a.client.call("desk.list", { profile: "fake" })).sessions, []);
  await b.sync();
  const before = b.thread(thread);
  await a.client.call("thread.delete", { thread });
  await a.client.call("thread.delete", { thread: empty });
  await b.sync();

  // Offered from the desk, as closed; one that never had a message has nothing to take up.
  assert.deepEqual((await a.client.call("threads.changes", {})).removed.sort(), [thread, empty].sort());
  const offered = (await a.client.call("desk.list", { profile: "fake" })).sessions;
  assert.deepEqual(offered, [{ id: thread, title: before.title, folder: before.folder, updated: before.updated, state: "closed" }]);
  // Only continued: there is nothing of the agent's own to fork or read.
  await assert.rejects(a.client.call("session.adopt", { profile: "fake", session_id: thread, mode: "fork" }), invalid);
  await assert.rejects(a.client.call("session.adopt", { profile: "fake", session_id: thread, mode: "read" }), invalid);
  await assert.rejects(a.client.call("session.adopt", { profile: "fake", session_id: "never-a-thread", mode: "continue" }), invalid);

  // Two devices at once get the one thread.
  const [adopted, alsoAdopted] = await Promise.all([a, b].map((device) => device.client.call("session.adopt", { profile: "fake", session_id: thread, mode: "continue" })));
  assert.equal(adopted.session_id, thread);
  assert.equal(alsoAdopted.session_id, thread);
  assert.equal(adopted.info.title, before.title);
  // As it was: its marks, preview and origin, and its conversation.
  const answer = await b.sync();
  assert.deepEqual(answer.removed, []);
  const back = b.thread(thread);
  assert.deepEqual([back.pinned, back.preview, back.title, back.created, back.updated, back.unseen], [true, "remember this", before.title, before.created, before.updated, undefined]);
  assert.equal(stored(bridge.home).threads.find((record: Frame) => record.id === thread).origin, "phone");
  assert.deepEqual(removedFile(bridge.home).threads.map((entry: Frame) => entry.thread.id), [empty]);
  assert.deepEqual((await a.client.call("desk.list", { profile: "fake" })).sessions, []);
  const resumed = await a.client.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
  assert.deepEqual(resumed.messages.map((message: Frame) => message.role), ["user", "assistant"]);

  // Its events number on past where the removed session's stopped, with a replay that
  // starts afresh: a device that held the thread before takes it whole. One that took it
  // since holds the number the answer gave, which no event has.
  const last = first.at(-1).seq;
  assert.deepEqual(await a.client.call("session.events.since", { session_id: thread, last_seen: last }), { events: [], truncated: true, latest_seq: last + 1, open_requests: [] });
  assert.equal((await a.client.call("session.events.since", { session_id: thread, last_seen: 1 })).truncated, true);
  assert.equal(resumed.latest_seq, last + 1);
  assert.deepEqual(await a.client.call("session.events.since", { session_id: thread, last_seen: last + 1 }), { events: [], truncated: false, latest_seq: last + 1, open_requests: [] });
  const again = await runTurn(a.client, thread, "and again");
  assert.equal(again[0].seq, last + 2);

  // Removed again, it is offered again.
  await a.client.call("thread.delete", { thread });
  assert.deepEqual((await b.sync()).removed, [thread]);
  assert.deepEqual((await a.client.call("desk.list", { profile: "fake" })).sessions.map((entry: Frame) => entry.id), [thread]);
});

test("a device that held a thread removed and taken up again from the desk is told to take it whole, with what was said there meanwhile", async (t) => {
  const { agent, a, b } = await devices(t);
  const thread = await createThread(a.client);
  const first = await runTurn(a.client, thread, "remember this");
  const last = first.at(-1).seq;
  await b.client.call("thread.delete", { thread });
  // Gone on at the desk while it was off the list.
  const file = join(agent.directory, `${thread}.json`);
  const kept = JSON.parse(readFileSync(file, "utf8"));
  kept.messages.push({ role: "user", text: "Asked at the desk", timestamp: 2 }, { role: "assistant", text: "Answered at the desk", timestamp: 3 });
  writeFileSync(file, JSON.stringify(kept));
  await b.client.call("session.adopt", { profile: "fake", session_id: thread, mode: "continue" });

  // A reconnects as the app does: the resume, then what it missed since the last event it applied.
  const resumed = await a.client.call("session.resume", { session_id: thread, profile: "fake", inline_images: false });
  assert.equal(resumed.messages.at(-1).text, "Answered at the desk");
  const missed = await a.client.call("session.events.since", { session_id: thread, last_seen: last });
  // No event brings the desk's turn to the copy it holds: it takes the resume's instead.
  assert.equal(missed.truncated, true);
  assert.deepEqual(missed.events, []);

  // Feature resume_replay: asked for only what it missed since then, it is given the whole
  // thread (made with session.create and nothing said before it, its replay began with it at 0).
  const epoch = a.client.readyPayload.replay_epoch;
  const again = await a.client.call("session.resume", { session_id: thread, profile: "fake", since: last, replay_epoch: epoch, replay_base: 0 });
  assert.equal(again.replayed, undefined);
  assert.equal(again.messages.at(-1).text, "Answered at the desk");
  // Since the answer it took, it misses nothing.
  const light = await a.client.call("session.resume", { session_id: thread, profile: "fake", since: again.latest_seq, replay_epoch: epoch, replay_base: again.replay_base });
  assert.deepEqual([light.replayed, light.events], [true, []]);
});

test("a removed thread taken up again from the desk the agent's usual way keeps its model, level and mode", async (t) => {
  const { bridge, a } = await devices(t);
  const thread = await createThread(a.client);
  await runTurn(a.client, thread, "hello");
  await a.client.call("config.set", { key: "model", value: "fake-2 --session", session_id: thread, profile: "fake" });
  await a.client.call("config.set", { key: "reasoning", value: "high", session_id: thread, profile: "fake" });
  await a.client.call("session.set_mode", { session_id: thread, mode: "ask", profile: "fake" });
  await a.client.call("session.set_mode", { session_id: thread, mode: "plan", profile: "fake" });
  await a.client.call("thread.delete", { thread });

  // The agent itself would take it up on its own settings (`DeskFake.adopt`), which may allow everything.
  const adopted = await a.client.call("session.adopt", { profile: "fake", session_id: thread, mode: "continue" });
  assert.deepEqual([adopted.info.model, adopted.info.reasoning_effort, adopted.info.mode], ["fake-2", "high", "plan"]);
  const record = stored(bridge.home).threads.find((entry: Frame) => entry.id === thread);
  assert.deepEqual([record.model, record.reasoningEffort, record.mode, record.modeBeforePlan], ["fake-2", "high", "plan", "ask"]);
});

test("a removed thread taken up again from the desk keeps the subagents that had left its line off it", async (t) => {
  const first = await devices(t);
  const thread = await createThread(first.a.client);
  await runTurn(first.a.client, thread, "hello");
  await first.bridge.dispose();
  // Two had left its line before the bridge stopped.
  const file = stored(first.bridge.home);
  const left = [{ id: "sub-1", run: "turn-1" }, { id: "sub-2" }];
  file.threads.find((entry: Frame) => entry.id === thread).subagentsCleared = left;
  store(first.bridge.home, file);

  const { bridge, a } = await devices(t, first);
  await a.client.call("thread.delete", { thread });
  await a.client.call("session.adopt", { profile: "fake", session_id: thread, mode: "continue" });
  const record = stored(bridge.home).threads.find((entry: Frame) => entry.id === thread);
  assert.deepEqual(record.subagentsCleared, left);
});

test("a thread.delete whose files cannot be written leaves the thread on the list and at work as it was", async (t) => {
  const { bridge, a, b } = await devices(t);
  const thread = await createThread(a.client);
  await runTurn(a.client, thread, "hello");
  await watch(bridge, [thread]);
  await b.sync();
  // removed.json cannot be replaced.
  mkdirSync(join(pathsFor(bridge.home).removed, "in-the-way"), { recursive: true });
  await assert.rejects(a.client.call("thread.delete", { thread }), (error: RpcFailure) => error.code === -32603);
  const answer = await b.sync();
  assert.deepEqual([answer.threads, answer.removed], [[], []]);
  assert.deepEqual((await a.client.call("threads.changes", {})).removed, []);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(pathsFor(bridge.home).push, "utf8")).threads), [thread]);
  // Still open where it was, and still taking messages.
  await runTurn(a.client, thread, "still here");

  rmSync(pathsFor(bridge.home).removed, { recursive: true, force: true });
  await a.client.call("thread.delete", { thread });
  assert.deepEqual((await b.sync()).removed, [thread]);
});

test("a removed thread's registration still in push.json when the bridge stopped is forgotten when it is taken up again, or when the bridge starts", async (t) => {
  const first = await devices(t);
  const thread = await createThread(first.a.client);
  const again = await createThread(first.a.client);
  const kept = await createThread(first.a.client);
  await runTurn(first.a.client, again, "hello");
  await watch(first.bridge, [thread, again, kept]);
  const push = pathsFor(first.bridge.home).push;
  const watched = () => Object.keys(JSON.parse(readFileSync(push, "utf8")).threads).sort();
  // Removed while the file cannot be written, and the bridge stops before any write.
  const blocker = `${push}.${process.pid}.tmp`;
  mkdirSync(blocker);
  assert.deepEqual(await first.a.client.call("thread.delete", { thread }), {});
  assert.deepEqual(await first.a.client.call("thread.delete", { thread: again }), {});
  await first.bridge.dispose();
  rmSync(blocker, { recursive: true, force: true });

  // It starts while the file cannot be read, so it finds nothing to forget then.
  renameSync(push, `${push}.aside`);
  mkdirSync(join(push, "in-the-way"), { recursive: true });
  const second = await devices(t, first);
  rmSync(push, { recursive: true, force: true });
  renameSync(`${push}.aside`, push);
  assert.deepEqual(watched(), [thread, again, kept].sort());
  // Taken up again: it comes back with nobody registered, until a device asks.
  await second.a.client.call("session.adopt", { profile: "fake", session_id: again, mode: "continue" });
  assert.deepEqual(watched(), [thread, kept].sort());
  await watch(second.bridge, [again]);
  await second.bridge.dispose();

  await devices(t, first);
  assert.deepEqual(watched(), [again, kept].sort());
});

/** A bridge that writes its notifications to a file, and a device watching two threads, the first with a turn to take up again. */
async function notifying(t: TestContext) {
  const notes = temporaryHome();
  const dryRun = join(notes, "push.jsonl");
  const bridge = await startTestBridge({ config: { push: { dryRun } } });
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
    rmSync(notes, { recursive: true, force: true });
  });
  const thread = await createThread(client);
  const other = await createThread(client);
  await runTurn(client, thread, "hello");
  await watch(bridge, [thread, other]);
  const push = pathsFor(bridge.home).push;
  const watched = () => Object.keys(JSON.parse(readFileSync(push, "utf8")).threads).sort();
  const notified = () => (existsSync(dryRun) ? readFileSync(dryRun, "utf8").trim().split("\n").filter(Boolean) : []).map((line) => JSON.parse(line).payload.aeriportal.thread);
  /** The threads notified about once a turn has ended in each of these: they go out in order, so once the last one's is out, the others' would be. */
  const notifiedAfterTurnsIn = async (...threads: string[]) => {
    for (const id of threads) await runTurn(client, id, "who hears this?");
    const last = threads[threads.length - 1];
    for (let tries = 0; tries < 200 && !notified().includes(last); tries++) await sleep(10);
    return notified();
  };
  return { bridge, client, thread, other, push, watched, notified, notifiedAfterTurnsIn };
}

/** Ways push.json can fail the bridge for a while: each takes the file's path and returns what puts it right. */
const pushFailures: [string, (push: string) => () => void][] = [
  [
    "can be read but not written",
    (push) => {
      const blocker = `${push}.${process.pid}.tmp`;
      mkdirSync(blocker);
      return () => rmSync(blocker, { recursive: true, force: true });
    },
  ],
  [
    "can be neither read nor written",
    (push) => {
      renameSync(push, `${push}.aside`);
      mkdirSync(join(push, "in-the-way"), { recursive: true });
      return () => {
        rmSync(push, { recursive: true, force: true });
        renameSync(`${push}.aside`, push);
      };
    },
  ],
  [
    "cannot be read though it can be replaced",
    (push) => {
      chmodSync(push, 0o000);
      return () => chmodSync(push, 0o600);
    },
  ],
];

for (const [failure, fail] of pushFailures) {
  test(`a removed thread whose push.json ${failure} through its removal and its take-up notifies nobody, the file keeps every other registration, and loses it at its next write`, async (t) => {
    const { bridge, client, thread, other, push, watched, notifiedAfterTurnsIn } = await notifying(t);
    // Put right before the end; a test that fails sooner leaves it to the folder's removal.
    const putRight = fail(push);
    assert.deepEqual(await client.call("thread.delete", { thread }), {});
    await client.call("session.adopt", { profile: "fake", session_id: thread, mode: "continue" });
    putRight();
    // Nothing has written the file since.
    assert.deepEqual(watched(), [thread, other].sort());
    assert.deepEqual(await notifiedAfterTurnsIn(thread, other), [other]);

    // The next write, here a device registering the other thread again, takes it out.
    await watch(bridge, [other]);
    assert.deepEqual(watched(), [other]);
  });
}

test("a thread only read, opened elsewhere while it is being continued, is opened as continued", async (t) => {
  const desk = new LiveDesk();
  const { a, b } = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-hold", mode: "read" });
  // A continues it; B opens it while A's read-only session is still letting go.
  desk.closeDelay = 60;
  const continued = a.client.call("session.adopt", { profile: "desk", session_id: "desk-hold", mode: "continue" });
  await sleep(20);
  const resumed = await b.client.call("session.resume", { session_id: "desk-hold", profile: "desk", inline_images: false });
  assert.equal((await continued).session_id, "desk-hold");
  assert.equal(resumed.session_id, "desk-hold");
  // Loaded again once, to be continued: never again only for reading.
  assert.deepEqual(desk.readOnly, [true, false]);
  assert.equal((await b.client.call("prompt.submit", { session_id: "desk-hold", text: "go on", profile: "desk" })).status, "streaming");
});

test("a thread only read, being loaded when another device continues it, is continued and not joined as it was", async (t) => {
  const desk = new LiveDesk();
  const first = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await first.a.client.call("session.adopt", { profile: "desk", session_id: "desk-slow", mode: "read" });
  await first.bridge.dispose();

  // After a restart B opens it, slowly; A continues it meanwhile.
  const { a, b } = await devices(t, first, [["desk", desk as unknown as Provider]]);
  desk.resumeDelays = [80];
  const resumed = b.client.call("session.resume", { session_id: "desk-slow", profile: "desk", inline_images: false });
  await sleep(20);
  assert.equal((await a.client.call("session.adopt", { profile: "desk", session_id: "desk-slow", mode: "continue" })).session_id, "desk-slow");
  assert.equal((await resumed).session_id, "desk-slow");
  assert.deepEqual(desk.readOnly, [true, true, false]);
  assert.equal((await b.client.call("prompt.submit", { session_id: "desk-slow", text: "go on", profile: "desk" })).status, "streaming");
});

test("a resume under way while a thread only read is continued elsewhere answers with the thread as continued", async (t) => {
  const desk = new LiveDesk();
  const { a, b } = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-swap", mode: "read" });
  // B's resume reads the thread again while A continues it.
  desk.reloadDelay = 80;
  const resumed = b.client.call("session.resume", { session_id: "desk-swap", profile: "desk", inline_images: false });
  await sleep(15);
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-swap", mode: "continue" });
  const answer = await resumed;
  assert.equal(answer.session_id, "desk-swap");
  // B follows the session that replaced the one it loaded: it takes B's message.
  assert.equal((await b.client.call("prompt.submit", { session_id: "desk-swap", text: "go on", profile: "desk" })).status, "streaming");
});

test("a wait under way when its thread is loaded again as another session answers with what that session did", async (t) => {
  const desk = new LiveDesk();
  // A turn the agent runs at the desk when the thread is taken up, only to be read.
  desk.running = "Asked at the desk";
  const { a, b } = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-wait", mode: "read" });
  const waiting = b.client.call("thread.wait", { thread: "desk-wait", timeout_ms: 5000 });
  await sleep(20);
  // Continued elsewhere: the session waited on is let go of, and the thread loaded again with its turn still running.
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-wait", mode: "continue" });
  assert.equal(desk.sinks.length, 2);
  desk.sinks[1].emit({ type: "text", text: "Done at the desk." });
  desk.sinks[1].emit({ type: "turn.end", status: "complete" });
  const rest = await waiting;
  assert.deepEqual([rest.state, rest.timed_out, rest.reply], ["idle", false, "Done at the desk."]);
});

test("a wait whose thread's turn ends in the moment it is loaded again as another session is told at once, not when its time is up", async (t) => {
  const desk = new LiveDesk();
  desk.running = "Asked at the desk";
  const { a, b } = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-ends", mode: "read" });
  const began = Date.now();
  const waiting = b.client.call("thread.wait", { thread: "desk-ends", timeout_ms: 1500 });
  await sleep(20);
  // Continued elsewhere, and the agent hands over the turn's end as soon as the new session is wired up.
  desk.endsAtOnce = true;
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-ends", mode: "continue" });
  const rest = await waiting;
  assert.deepEqual([rest.state, rest.timed_out, rest.reply, Date.now() - began < 1000], ["idle", false, "Done at the desk.", true]);
});

test("a device that held a thread only read is told to take it whole once it is continued", async (t) => {
  const desk = new LiveDesk();
  // A turn the agent runs at the desk as the thread is taken up only to be read: the
  // session only read gives out events.
  desk.running = "Asked at the desk";
  desk.endsAtOnce = true;
  const { a, b } = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-held", mode: "read" });
  const read = await a.client.call("session.resume", { session_id: "desk-held", profile: "desk", inline_images: false });
  assert.ok(read.latest_seq > 0);
  desk.running = null;
  await b.client.call("session.adopt", { profile: "desk", session_id: "desk-held", mode: "continue" });

  const missed = await a.client.call("session.events.since", { session_id: "desk-held", last_seen: read.latest_seq });
  assert.equal(missed.truncated, true);
  assert.deepEqual(missed.events, []);
});

test("a thread only read is resumed whole also for a device that holds every event of it (feature resume_replay)", async (t) => {
  const desk = new LiveDesk();
  desk.running = "Asked at the desk";
  desk.endsAtOnce = true;
  const { a } = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-only-read", mode: "read" });
  const epoch = a.client.readyPayload.replay_epoch;
  const read = await a.client.call("session.resume", { session_id: "desk-only-read", profile: "desk", inline_images: false, replay_epoch: epoch });
  assert.ok(read.latest_seq > 0);
  // Each resume reads its conversation from the agent again, which no event tells of.
  const again = await a.client.call("session.resume", { session_id: "desk-only-read", profile: "desk", since: read.latest_seq, replay_epoch: epoch, replay_base: read.replay_base });
  assert.equal(again.replayed, undefined);
  assert.deepEqual(again.messages, read.messages);
  // Read again, it is numbered on past what it was read as (`EventLog.rebase`).
  assert.equal(again.latest_seq, read.latest_seq + 1);
});

test("a device that held a thread only read is told to take it whole once it is read again with more said at the desk", async (t) => {
  const desk = new LiveDesk();
  desk.running = "Asked at the desk";
  desk.endsAtOnce = true;
  const { a, b } = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-reread", mode: "read" });
  const read = await a.client.call("session.resume", { session_id: "desk-reread", profile: "desk", inline_images: false });
  assert.ok(read.latest_seq > 0);
  // Said at the desk, which no event tells: another device reads the thread again.
  desk.saidSince.push({ role: "user", text: "Asked again at the desk", timestamp: 3 }, { role: "assistant", text: "Answered at the desk", timestamp: 4 });
  const again = await b.client.call("session.resume", { session_id: "desk-reread", profile: "desk", inline_images: false });
  assert.equal(again.messages.at(-1).text, "Answered at the desk");

  const missed = await a.client.call("session.events.since", { session_id: "desk-reread", last_seen: read.latest_seq });
  assert.equal(missed.truncated, true);
  assert.deepEqual(missed.events, []);
  // One that took the thread as read again has missed nothing.
  assert.equal((await b.client.call("session.events.since", { session_id: "desk-reread", last_seen: again.latest_seq })).truncated, false);
});

test("a device that held a running turn later found to be opened by a message is told to take it whole", async (t) => {
  const desk = new LiveDesk();
  const { a, b } = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-opener", mode: "continue" });
  const sink = desk.sinks.at(-1)!;
  // A turn at the desk the agent took for a /compact, as Codex does one begun with nothing in it.
  sink.emit({ type: "turn.begin", user: "/compact" });
  const epoch = a.client.readyPayload.replay_epoch;
  const held = await a.client.call("session.resume", { session_id: "desk-opener", profile: "desk", inline_images: false, replay_epoch: epoch });
  assert.equal(held.inflight.user, "/compact");
  // A message in it after all: the stored one that opened it says so, which no event tells.
  sink.emit({ type: "turn.opener", user: "Asked at the desk" });

  const missed = await a.client.call("session.events.since", { session_id: "desk-opener", last_seen: held.latest_seq });
  assert.equal(missed.truncated, true);
  // Feature resume_replay: asked for only what it missed since then, it is given the whole thread.
  const again = await b.client.call("session.resume", { session_id: "desk-opener", profile: "desk", since: held.latest_seq, replay_epoch: epoch, replay_base: held.replay_base });
  assert.equal(again.replayed, undefined);
  assert.equal(again.inflight.user, "Asked at the desk");
  assert.equal(again.messages.at(-1).text, "Asked at the desk");
  // One that took it since misses nothing, and follows the turn on.
  assert.equal((await b.client.call("session.events.since", { session_id: "desk-opener", last_seen: again.latest_seq })).truncated, false);
  const ended = b.client.nextEvent("message.complete", "desk-opener");
  sink.emit({ type: "text", text: "Done at the desk." });
  sink.emit({ type: "turn.end", status: "complete" });
  assert.equal((await ended).seq, again.latest_seq + 2);
});

test("a device that followed a running turn on through its opener found to be a message takes it whole at its next resume, however many events it applied after (feature resume_replay)", async (t) => {
  const desk = new LiveDesk();
  const { a } = await devices(t, undefined, [["desk", desk as unknown as Provider]]);
  await a.client.call("session.adopt", { profile: "desk", session_id: "desk-followed", mode: "continue" });
  const sink = desk.sinks.at(-1)!;
  sink.emit({ type: "turn.begin", user: "/compact" });
  const epoch = a.client.readyPayload.replay_epoch;
  const resume = (since?: number, base?: number) => a.client.call("session.resume", { session_id: "desk-followed", profile: "desk", inline_images: false, since, replay_epoch: epoch, replay_base: base });
  const held = await resume();
  assert.equal(held.inflight.user, "/compact");
  // Found to be opened by a message while A follows the turn, which goes on: A applies
  // every event after it, its copy still opened by /compact.
  sink.emit({ type: "turn.opener", user: "Asked at the desk" });
  const said = a.client.nextEvent("message.delta", "desk-followed");
  sink.emit({ type: "text", text: "Working on it." });
  const last = (await said).seq;
  assert.ok(last > held.latest_seq);

  // Its numbers alone cannot tell it from a device that took the thread after the change:
  // where the replay of what it holds begins says it.
  const again = await resume(last, held.replay_base);
  assert.equal(again.replayed, undefined);
  assert.equal(again.inflight.user, "Asked at the desk");
  assert.equal(again.messages.at(-1).text, "Asked at the desk");
  assert.notEqual(again.replay_base, held.replay_base);
  // From the answer it took, it catches up with only what it missed.
  const light = await resume(again.latest_seq, again.replay_base);
  assert.deepEqual([light.replayed, light.events, light.replay_base], [true, [], again.replay_base]);
});

test("a thread removed and taken up again is listed, not removed, for a device that missed both", async (t) => {
  const { bridge, agent, a, b } = await devices(t);
  const c = new Device(await TestClient.open(bridge));
  t.after(() => c.client.close());
  agent.deskSession("desk-back", [{ role: "user", text: "Started at the desk", timestamp: 1 }]);
  await a.client.call("session.adopt", { profile: "fake", session_id: "desk-back", mode: "continue" });
  await b.sync();
  await c.sync();

  await a.client.call("thread.delete", { thread: "desk-back" });
  // C sees the removal, B does not look.
  assert.deepEqual((await c.sync()).removed, ["desk-back"]);
  // Taken up again from the desk (the agent's own way, as Claude Code's or Codex's).
  await a.client.call("session.adopt", { profile: "fake", session_id: "desk-back", mode: "continue" });

  const missed = await b.sync();
  assert.deepEqual(missed.removed, []);
  assert.deepEqual(missed.threads.map((entry: Frame) => entry.id), ["desk-back"]);
  const seen = await c.sync();
  assert.deepEqual(seen.removed, []);
  assert.deepEqual(seen.threads.map((entry: Frame) => entry.id), ["desk-back"]);
  assert.deepEqual(removedFile(bridge.home).threads, []);
});

test("removed.json survives a restart and a save by a bridge from before it", async (t) => {
  const first = await devices(t);
  const thread = await createThread(first.a.client);
  const kept = await createThread(first.a.client);
  await runTurn(first.a.client, thread, "soon gone");
  await first.a.client.call("thread.delete", { thread });
  await first.b.sync();
  const removedAt = removedFile(first.bridge.home).threads[0].revision;
  await first.bridge.dispose();

  // Restarted: a device that held the list hears of nothing new; one that holds none hears of the removal.
  const second = await devices(t, first);
  const held = new Device(second.b.client);
  held.list = first.b.list;
  held.revision = first.b.revision;
  assert.deepEqual(await held.sync(), { list: { id: first.b.list, revision: first.b.revision }, threads: [], removed: [] });
  assert.deepEqual((await second.a.client.call("threads.changes", {})).removed, [thread]);
  assert.deepEqual((await second.a.client.call("desk.list", { profile: "fake" })).sessions.map((entry: Frame) => entry.id), [thread]);
  await second.bridge.dispose();

  // A bridge from before the list saves threads.json without its list, and never writes removed.json.
  const { list: _list, revision: _revision, ...older } = stored(first.bridge.home);
  store(first.bridge.home, older);
  const third = await devices(t, first);
  const now = (await third.a.client.call("sessions.activity")).thread_list;
  assert.notEqual(now.id, first.b.list);
  assert.ok(now.revision > removedAt);
  const whole = await third.a.client.call("threads.changes", { list: first.b.list, since: first.b.revision });
  assert.equal(whole.full, true);
  assert.deepEqual(whole.removed, [thread]);
  assert.deepEqual(whole.threads.map((entry: Frame) => entry.id), [kept]);
  // A removal stamped under the old list is no change in the new one.
  assert.deepEqual((await third.a.client.call("threads.changes", { list: now.id, since: now.revision - 1 })).removed, []);
  // Still there to take up again.
  await third.a.client.call("session.adopt", { profile: "fake", session_id: thread, mode: "continue" });
  assert.deepEqual(removedFile(first.bridge.home).threads, []);
});

test("removed.json: an id also on the list is on it (the removal did not finish), and an entry that is not one is skipped", () => {
  const home = temporaryHome();
  try {
    const threads = join(home, "threads.json");
    const removed = join(home, "removed.json");
    const record = (id: string) => ({ id, agent: "fake", cwd: home, title: null, model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone" });
    writeFileSync(threads, JSON.stringify({ list: "abc", revision: 9, threads: [record("both")] }));
    writeFileSync(removed, JSON.stringify({ threads: [{ revision: 8, thread: record("both") }, { revision: 7, thread: record("gone") }, { revision: 0, thread: record("unstamped") }, { revision: 6, thread: { id: "no-agent" } }, null] }));
    const registry = new Registry(threads);
    assert.deepEqual(registry.all().map((entry) => entry.id), ["both"]);
    assert.deepEqual(registry.allRemoved().map((entry) => entry.id), ["gone"]);
    assert.deepEqual(registry.removedSince(0), ["gone"]);
    assert.deepEqual(registry.removedSince(7), []);
    // Saved so at once.
    assert.deepEqual(JSON.parse(readFileSync(removed, "utf8")).threads.map((entry: Frame) => entry.thread.id), ["gone"]);
    // A threads.json that cannot be written leaves the thread on the list, and out of removed.json.
    rmSync(threads);
    mkdirSync(join(threads, "in-the-way"), { recursive: true });
    assert.throws(() => registry.remove("both"));
    assert.deepEqual([registry.has("both"), registry.revision, registry.removedSince(0)], [true, 9, ["gone"]]);
    assert.deepEqual(JSON.parse(readFileSync(removed, "utf8")).threads.map((entry: Frame) => entry.thread.id), ["gone"]);
    // Taking a thread off writes removed.json, then threads.json.
    rmSync(threads, { recursive: true });
    registry.remove("both");
    assert.deepEqual(registry.removedSince(9), ["both"]);
    assert.equal(registry.revision, 10);
    assert.deepEqual(JSON.parse(readFileSync(threads, "utf8")).threads, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** threads.json as making text of the whole list gives it: what every save wrote before the registry kept each record's bytes. */
function wholeText(registry: Registry): string {
  return JSON.stringify({ list: registry.list, revision: registry.revision, threads: registry.all() }, null, 1) + "\n";
}

test("threads.json is after every change, byte for byte, what making text of the whole list gives", () => {
  const home = temporaryHome();
  try {
    const path = join(home, "threads.json");
    const registry = new Registry(path);
    const same = (after: string) => {
      assert.equal(readFileSync(path, "utf8"), wholeText(registry), after);
      // And a bridge that starts on the file has the list as it is here (a key with no value is no key).
      const read = new Registry(path);
      assert.deepEqual([read.list, read.revision, read.all()], [registry.list, registry.revision, JSON.parse(JSON.stringify(registry.all()))], after);
    };
    same("a new list, with no thread");

    const titles = ["Fix the login", 'It said "no"\nand then a second line', "naïve café 日本語 🚀", "", "}\n  ],\n {", "  and a lone \ud83d half"];
    const record = (index: number): ThreadRecord => ({
      id: `t${index}`,
      agent: "fake",
      cwd: join(home, `project ${index % 3}`),
      title: index % 4 === 0 ? null : titles[index % titles.length],
      model: "fake-1",
      provider: "fake",
      reasoningEffort: index % 2 ? "medium" : "",
      createdAt: 1000 + index,
      updatedAt: 1000 + index,
      origin: index % 5 ? "phone" : "desk",
      ...(index % 3 === 0 ? { startedBy: { name: "Claude Code on mini", thread: `t${index - 1}` } } : {}),
      ...(index % 7 === 0 ? { mode: undefined } : {}),
    });
    for (let index = 0; index < 12; index += 1) {
      registry.add(record(index));
      same(`thread ${index} added`);
    }

    // What a turn, a device and the agent change, in every order a seeded draw gives.
    let seed = 20261012;
    const draw = (below: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % below;
    };
    const changes: ThreadChanges[] = [
      { pinned: true },
      { pinned: false },
      { archived: true, pinned: false },
      { archived: undefined, unseen: true, inTurn: false },
      { unseen: false },
      { title: titles[1] },
      { title: titles[2], preview: "première ligne ✓" },
      { model: "fake-2", reasoningEffort: "high" },
      { mode: "plan", modeBeforePlan: "default" },
      { mode: undefined, modeBeforePlan: undefined },
      { startedBy: { name: "Aeri" } },
      { readOnly: true },
      {},
    ];
    let added = 12;
    for (let step = 0; step < 400; step += 1) {
      const ids = registry.all().map((entry) => entry.id);
      const id = ids[draw(ids.length)];
      const what = draw(20);
      if (what < 9) registry.set(id, changes[draw(changes.length)]);
      else if (what < 16) registry.update(id, draw(2) ? { archived: undefined, inTurn: true, preview: titles[draw(titles.length)] } : { archived: undefined, unseen: true, inTurn: false });
      else if (what < 18 && ids.length > 3) registry.remove(id);
      else if (what < 19) registry.add(record(added++));
      else {
        // Taken up again, as the manager does it: the record as it was when removed.
        const gone = registry.allRemoved();
        if (gone.length > 0) registry.add(gone[draw(gone.length)]);
      }
      same(`step ${step}`);
    }

    // A change that cannot be saved leaves the record, and what the next save writes of it, as they were.
    const [first, second] = registry.all();
    const before = structuredClone(first);
    rmSync(path);
    mkdirSync(join(path, "in-the-way"), { recursive: true });
    assert.throws(() => registry.set(first.id, { title: "never saved", pinned: !first.pinned }));
    assert.throws(() => registry.update(first.id, { unseen: !first.unseen }));
    const late = record(999);
    assert.throws(() => registry.add(late));
    assert.deepEqual(registry.get(first.id), before);
    rmSync(path, { recursive: true });
    registry.set(second.id, { preview: "saved after the ones that were not" });
    same("after changes that could not be saved");
    assert.deepEqual(new Registry(path).get(first.id), JSON.parse(JSON.stringify(before)));
    // The thread that could not be added changes meanwhile, as one being taken up does, and is added as it then is.
    late.title = "Titled while it waited";
    registry.add(late);
    same("a thread added at the second try");

    // Down to no thread again.
    for (const entry of registry.all()) registry.remove(entry.id);
    same("every thread removed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a change to one thread makes text of that thread, not of the whole list", () => {
  const home = temporaryHome();
  const stringify = JSON.stringify;
  const ownBlock = Buffer.allocUnsafeSlow;
  try {
    const path = join(home, "threads.json");
    const record = (index: number) => ({ id: `t${index}`, agent: "fake", cwd: home, title: `Thread number ${index}, with a title of the usual length`, model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: index, updatedAt: index, origin: "phone", preview: "What the last message said, in a line" });
    writeFileSync(path, stringify({ list: "abc", revision: 500, threads: Array.from({ length: 200 }, (_, index) => record(index)) }));
    const registry = new Registry(path);
    // The first save after a start makes text of every record once.
    registry.set("t0", { pinned: true });
    const whole = readFileSync(path, "utf8").length;

    // Every character of text made from here on, and every block of bytes made to be kept.
    let made = 0;
    JSON.stringify = ((...given: Parameters<typeof stringify>) => {
      const text = stringify(...given);
      made += text?.length ?? 0;
      return text;
    }) as typeof JSON.stringify;
    let blocks = 0;
    Buffer.allocUnsafeSlow = ((size: number) => {
      blocks += 1;
      return ownBlock(size);
    }) as typeof Buffer.allocUnsafeSlow;
    registry.update("t7", { archived: undefined, inTurn: true, preview: "A turn started ✓" });
    registry.update("t7", { archived: undefined, unseen: true, inTurn: false });
    registry.set("t7", { unseen: false });
    JSON.stringify = stringify;
    Buffer.allocUnsafeSlow = ownBlock;

    // A turn's three saves: a few records' worth of text, where each made the whole file's before.
    assert.ok(made < whole / 20, `${made} characters of text made for three saves of a file of ${whole}`);
    // And the changed record's bytes are a block of their own each time, not a piece of one
    // shared with whatever else was made then, which bytes kept this long would hold on to.
    assert.equal(blocks, 3);
    assert.equal(readFileSync(path, "utf8"), wholeText(registry));
    assert.equal(registry.get("t7")?.preview, "A turn started ✓");
  } finally {
    JSON.stringify = stringify;
    Buffer.allocUnsafeSlow = ownBlock;
    rmSync(home, { recursive: true, force: true });
  }
});
