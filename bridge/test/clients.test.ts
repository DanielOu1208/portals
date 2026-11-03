import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setLogLevel } from "../src/log.ts";
import { CodexClient, CodexError } from "../src/providers/codex/client.ts";
import { HermesClient, HermesError } from "../src/providers/hermes/client.ts";
import "./helpers.ts";

// Codex's client and Hermes's (providers/codex/client.ts, providers/hermes/client.ts),
// the two that connect again when their connection drops, each through a stand-in
// connector of the test's own on mocked timers: what they do alike, run against both,
// and where they differ, each its own. Their callers rest on all of it: how each call
// fails and whether the agent may have taken it, when they try again, which connection
// counts, Hermes's greeting and heartbeat.

type Frame = Record<string, any>;

/** One connection the stand-in opened: what the client sent on it, and what it is sent. */
class Line {
  readonly sent: Frame[] = [];
  closedByClient = false;
  private readonly deliver: (frame: Frame) => void;
  private readonly drop: (reason: string) => void;

  constructor(deliver: (frame: Frame) => void, drop: (reason: string) => void) {
    this.deliver = deliver;
    this.drop = drop;
  }

  /** A frame from the agent's side, handed to the client as its connector would. */
  say(frame: Frame): void {
    this.deliver(frame);
  }

  /** The connection is gone, as its connector would say. */
  gone(reason = "the socket closed (1006)"): void {
    this.drop(reason);
  }
}

/** The agent's side: opens a line for each attempt and, unless told otherwise, answers each handshake at once. */
class StandIn {
  readonly lines: Line[] = [];
  readonly kind: Kind;
  /** Attempts to connect so far, refused or not. */
  attempts = 0;
  /** Nobody there: each attempt fails. */
  refusing = false;
  /** How long an attempt takes to open (Hermes's `locate`, a socket), in mocked time. */
  openingMs = 0;
  /** Hermes's greeting as each connection opens, `gateway.ready`'s payload; null for none. */
  greeting: Frame | null = {};
  /** How the handshake's call is answered: at once, with this error, or not at all (null). */
  handshake: "answer" | { code: number; message: string } | null = "answer";

  constructor(kind: Kind) {
    this.kind = kind;
  }

  get last(): Line {
    return this.lines.at(-1)!;
  }

  async open(deliver: (frame: Frame) => void, drop: (reason: string) => void): Promise<{ send(frame: Frame): void; close(): void }> {
    this.attempts += 1;
    if (this.openingMs > 0) await new Promise((resolve) => setTimeout(resolve, this.openingMs));
    if (this.refusing) throw new Error("nobody there");
    const line = new Line(deliver, drop);
    this.lines.push(line);
    // Hermes speaks first, as the connection opens.
    const greeting = this.greeting;
    if (this.kind === "hermes" && greeting) setImmediate(() => line.say(ready(greeting)));
    return {
      send: (frame) => {
        line.sent.push(frame);
        const handshake = this.handshake;
        if (frame.method !== kinds[this.kind].handshake || handshake === null) return;
        queueMicrotask(() => line.say(handshake === "answer" ? kinds[this.kind].answer(frame.id, {}) : kinds[this.kind].refuse(frame.id, handshake)));
      },
      close: () => {
        line.closedByClient = true;
      },
    };
  }
}

/** Hermes's greeting. */
function ready(payload: Frame): Frame {
  return { jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload } };
}

type Kind = "codex" | "hermes";

/** Either client, as these tests use it. */
interface Client {
  readonly isConnected: boolean;
  listen(listener: Ears): () => void;
  start(): Promise<void>;
  whenReady(timeoutMs?: number): Promise<void>;
  call(method: string, params: Frame, timeoutMs?: number): Promise<any>;
  respond(id: string, result: unknown): void;
  respondError(id: string, code: number, message: string): void;
  close(): void;
}

/** A listener of either client: Codex's notifications and Hermes's events alike. */
interface Ears {
  notification(method: string, params: any): void;
  event(type: string, sessionID: string | undefined, seq: number | undefined, payload: Frame): void;
  request(id: string | number, method: string, params: any): void;
  connected(again: boolean, sameRun?: boolean): void;
  disconnected(reason: string): void;
}

interface ClientOptions {
  backoff?: number[];
  timeoutMs?: number;
  /** Codex's. */
  readyMs?: number;
  prepare?: () => Promise<void>;
  /** Hermes's. */
  pingMs?: number;
}

const kinds: Record<
  Kind,
  {
    /** The call each connection starts with. */
    handshake: string;
    make(standIn: StandIn, options: ClientOptions): Client;
    answer(id: unknown, result: unknown): Frame;
    refuse(id: unknown, error: Frame): Frame;
    /** Something the listeners hear, and what they hear of it. */
    news: { frame: Frame; heard: string };
    /** A request from the agent's side, by id. */
    asks(id: string): Frame;
  }
> = {
  codex: {
    handshake: "initialize",
    make: (standIn, options) =>
      new CodexClient({
        connect: async (handlers) => standIn.open(handlers.message, handlers.closed),
        clientInfo: { name: "portals-bridge", title: "Portals", version: "0.1.0" },
        ...options,
      }) as unknown as Client,
    answer: (id, result) => ({ id, result }),
    refuse: (id, error) => ({ id, error }),
    news: { frame: { method: "thread/status/changed", params: { threadId: "t" } }, heard: "thread/status/changed" },
    asks: (id) => ({ id, method: "item/commandExecution/requestApproval", params: { threadId: "t" } }),
  },
  hermes: {
    handshake: "client.capabilities",
    make: (standIn, options) => new HermesClient({ connect: async (handlers) => standIn.open(handlers.frame, handlers.closed), ...options }) as unknown as Client,
    answer: (id, result) => ({ jsonrpc: "2.0", id, result }),
    refuse: (id, error) => ({ jsonrpc: "2.0", id, error }),
    news: { frame: { jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "s", seq: 1, payload: { text: "Hi" } } }, heard: "message.delta" },
    asks: (id) => ({ jsonrpc: "2.0", id, method: "approval.request", params: { session_id: "s" } }),
  },
};

const names: Record<Kind, string> = { codex: "Codex", hermes: "Hermes" };

/** A listener that writes down what it hears, as words. */
function ears(heard: string[]): Ears {
  return {
    notification: (method) => heard.push(method),
    event: (type) => heard.push(type),
    request: (id, method) => heard.push(`${method} ${id}`),
    connected: (again) => heard.push(again ? "again" : "connected"),
    disconnected: () => heard.push("dropped"),
  };
}

/** A listener that throws at each of `on`, and hears the rest. */
function thrower(on: (keyof Ears)[]): Ears {
  const fail = (what: string) => () => {
    throw new Error(`this listener fails at ${what}`);
  };
  const listener = ears([]);
  for (const what of on) listener[what] = fail(what);
  return listener;
}

/** Lets what is due now run: answers in microtasks, and greetings a step later. */
async function settle(): Promise<void> {
  for (let step = 0; step < 5; step += 1) await new Promise((resolve) => setImmediate(resolve));
}

const mocked = new WeakSet<TestContext>();

/** Timers under the test's hand: `t.mock.timers.tick(ms)`, or `elapse`. */
function mockTime(t: TestContext): void {
  if (mocked.has(t)) return;
  mocked.add(t);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
}

/** Lets `ms` of mocked time pass in small steps, what each step set going settling before the next. */
async function elapse(t: TestContext, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 50) {
    t.mock.timers.tick(Math.min(left, 50));
    await settle();
  }
}

/** What the clients log while the test runs, a line each. */
function logLines(t: TestContext): string[] {
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  setLogLevel("error");
  t.after(() => {
    process.stderr.write = write;
    setLogLevel("silent");
  });
  return lines;
}

function fieldsOf(line: string): Frame {
  return JSON.parse(line.slice(line.indexOf("{")));
}

// MARK: Listeners

for (const kind of ["codex", "hermes"] as const) {
  const name = names[kind];

  test(`${name}: a listener that throws at what ${name} says, or at the connection dropping, is logged as an error, and the listeners after it, and the client, go on`, async (t) => {
    mockTime(t);
    const standIn = new StandIn(kind);
    const client = kinds[kind].make(standIn, { backoff: [1] });
    const heard: string[] = [];
    client.listen(thrower(["notification", "event", "request", "disconnected"]));
    client.listen(ears(heard));
    const lines = logLines(t);
    void client.start();
    await settle();
    assert.equal(client.isConnected, true);

    // As a connector would hand them on, from the socket's own handler: nothing comes back out.
    assert.doesNotThrow(() => standIn.last.say(kinds[kind].news.frame));
    assert.doesNotThrow(() => standIn.last.say(kinds[kind].asks("srq-1")));
    assert.doesNotThrow(() => standIn.last.gone());
    assert.deepEqual(heard, ["connected", kinds[kind].news.heard, `${kinds[kind].asks("srq-1").method} srq-1`, "dropped"]);
    const errors = lines.filter((line) => / error /.test(line));
    assert.equal(errors.length, 3);
    assert.match(errors[0], kind === "codex" ? / error could not take in a notification from Codex \{/ : / error could not take in an event from Hermes \{/);
    assert.deepEqual(fieldsOf(errors[0])[kind === "codex" ? "method" : "event"], kinds[kind].news.heard);
    assert.match(fieldsOf(errors[0]).error, /^Error: this listener fails at (notification|event)\n\s+at /);
    assert.match(errors[1], new RegExp(` error could not take in a request from ${name} \\{`));
    assert.equal(fieldsOf(errors[1]).method, kinds[kind].asks("srq-1").method);
    assert.match(errors[2], new RegExp(` error could not take in that the connection to ${name} dropped \\{`));
    assert.match(fieldsOf(errors[2]).error, /^Error: this listener fails at disconnected\n\s+at /);
    // Never what was said.
    assert.equal(
      errors.some((line) => /Hi|threadId|session_id/.test(line)),
      false,
    );

    // It connects again after its pause, as after any drop.
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(standIn.lines.length, 2);
    assert.equal(client.isConnected, true);
    assert.deepEqual(heard.slice(4), ["again"]);
    client.close();
  });
}

for (const kind of ["codex", "hermes"] as const) {
  const name = names[kind];

  test(`${name}: a listener that throws at the connection coming up is logged as an error, and the connection stays the one made, where another was made beside it, again and again`, async (t) => {
    mockTime(t);
    const standIn = new StandIn(kind);
    const client = kinds[kind].make(standIn, { backoff: [1] });
    const before: string[] = [];
    const after: string[] = [];
    client.listen(ears(before));
    client.listen(thrower(["connected"]));
    client.listen(ears(after));
    const lines = logLines(t);
    await Promise.all([client.start(), settle()]);
    assert.equal(client.isConnected, true);

    // Nothing tries again: one line, still open, which calls go out on.
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(standIn.lines.length, 1);
    assert.equal(standIn.last.closedByClient, false);
    const answer = client.call("model/list", {});
    await settle();
    const sent = standIn.last.sent.at(-1)!;
    assert.equal(sent.method, "model/list");
    standIn.last.say(kinds[kind].answer(sent.id, { data: [] }));
    assert.deepEqual(await answer, { data: [] });
    // Every listener heard it once.
    assert.deepEqual([before, after], [["connected"], ["connected"]]);
    const errors = lines.filter((line) => / error /.test(line));
    assert.equal(errors.length, 1);
    assert.match(errors[0], new RegExp(` error could not take in that ${name} connected \\{`));
    assert.match(fieldsOf(errors[0]).error, /^Error: this listener fails at connected\n\s+at /);
    client.close();
  });
}

for (const kind of ["codex", "hermes"] as const) {
  const name = names[kind];
  const what = kind === "codex" ? "a notification from Codex" : "an event from Hermes";
  const key = kind === "codex" ? "method" : "event";
  /** Something else the listeners hear, of another kind than `news`. */
  const other =
    kind === "codex"
      ? { frame: { method: "turn/completed", params: { threadId: "t" } }, heard: "turn/completed" }
      : { frame: { jsonrpc: "2.0", method: "event", params: { type: "message.complete", session_id: "s", seq: 2, payload: {} } }, heard: "message.complete" };

  test(`${name}: a listener that throws at every frame is logged with its stack once a minute for each kind, and how many more times it threw in one line as the minute ends`, async (t) => {
    mockTime(t);
    const standIn = new StandIn(kind);
    const client = kinds[kind].make(standIn, { backoff: [1] });
    const heard: string[] = [];
    client.listen(thrower(["notification", "event"]));
    client.listen(ears(heard));
    const lines = logLines(t);
    void client.start();
    await settle();
    const errors = () => lines.filter((line) => / error /.test(line));

    // A reply streamed: a frame each piece, every one thrown at.
    for (let piece = 0; piece < 5; piece += 1) standIn.last.say(kinds[kind].news.frame);
    standIn.last.say(other.frame);
    assert.deepEqual(heard, ["connected", ...Array(5).fill(kinds[kind].news.heard), other.heard]);
    assert.equal(errors().length, 2);
    assert.deepEqual(fieldsOf(errors()[0])[key], kinds[kind].news.heard);
    assert.match(fieldsOf(errors()[0]).error, /^Error: this listener fails at (notification|event)\n\s+at /);
    assert.deepEqual(fieldsOf(errors()[1])[key], other.heard);

    // As the minute ends, the four more of the first kind in one line, without the stack;
    // nothing for the other, which threw once.
    await elapse(t, 59_000);
    standIn.last.say(kinds[kind].news.frame);
    assert.equal(errors().length, 2);
    await elapse(t, 1000);
    assert.equal(errors().length, 3);
    assert.match(errors()[2], new RegExp(` error could not take in ${what} again, 5 times in the minute after \\{`));
    assert.deepEqual(fieldsOf(errors()[2]), { [key]: kinds[kind].news.heard, error: `this listener fails at ${kind === "codex" ? "notification" : "event"}` });
    await elapse(t, 60_000);
    assert.equal(errors().length, 3);

    // Thrown at again after that: its stack once more.
    standIn.last.say(kinds[kind].news.frame);
    assert.equal(errors().length, 4);
    assert.match(fieldsOf(errors()[3]).error, /^Error: this listener fails at (notification|event)\n\s+at /);
    client.close();
  });

  test(`${name}: the throws a listener's minute has counted are written as the client closes, and nothing after`, async (t) => {
    mockTime(t);
    const standIn = new StandIn(kind);
    const client = kinds[kind].make(standIn, { backoff: [1] });
    client.listen(thrower(["notification", "event"]));
    const lines = logLines(t);
    void client.start();
    await settle();
    const errors = () => lines.filter((line) => / error /.test(line));

    for (let piece = 0; piece < 3; piece += 1) standIn.last.say(kinds[kind].news.frame);
    standIn.last.say(other.frame);
    assert.equal(errors().length, 2);
    await elapse(t, 10_000);
    client.close();
    // The two more of the first kind; nothing for the other, which threw once.
    assert.equal(errors().length, 3);
    assert.match(errors()[2], new RegExp(` error could not take in ${what} again, 2 times in the minute after \\{`));
    await elapse(t, 60_000);
    assert.equal(errors().length, 3);
  });

  test(`${name}: frames the connection still hands over after the client closed (those already on their way as its socket closes) reach no listener, so nothing is counted or written a minute later`, async (t) => {
    mockTime(t);
    const standIn = new StandIn(kind);
    const client = kinds[kind].make(standIn, { backoff: [1] });
    const heard: string[] = [];
    client.listen(thrower(["notification", "event"]));
    client.listen(ears(heard));
    const lines = logLines(t);
    void client.start();
    await settle();
    const errors = () => lines.filter((line) => / error /.test(line));

    standIn.last.say(kinds[kind].news.frame);
    assert.equal(errors().length, 1);
    client.close();
    standIn.last.say(kinds[kind].news.frame);
    standIn.last.say(kinds[kind].news.frame);
    assert.deepEqual(heard, ["connected", kinds[kind].news.heard]);
    await elapse(t, 60_000);
    assert.equal(errors().length, 1);
  });
}

// MARK: Connections

test("Codex: a connection whose initialize failed counts for nothing from then on, so its close heard while the next attempt prepares makes no attempt beside the one that connects", async (t) => {
  mockTime(t);
  const standIn = new StandIn("codex");
  standIn.handshake = { code: -32600, message: "Not now." };
  let release: (() => void) | null = null;
  const client = kinds.codex.make(standIn, { prepare: () => (release ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()) });
  const heard: string[] = [];
  client.listen(ears(heard));
  t.after(() => client.close());
  await client.start();
  await settle();
  const failed = standIn.last;
  assert.equal(failed.closedByClient, true);
  // What it says before its close arrives is not heard either.
  failed.say(kinds.codex.news.frame);
  standIn.handshake = "answer";
  release = () => {};
  await elapse(t, 500);
  // The next attempt prepares (Codex's daemon being started) as the failed one's close arrives.
  failed.gone();
  release();
  release = null;
  await settle();
  assert.equal(standIn.lines.length, 2);
  assert.equal(client.isConnected, true);
  await elapse(t, 10_000);
  assert.equal(standIn.lines.length, 2);
  assert.equal(standIn.last.closedByClient, false);
  assert.deepEqual(heard, ["connected"]);
});

// MARK: How calls fail

interface Failure {
  type: typeof CodexError | typeof HermesError | typeof Error;
  code?: number;
  message: string;
  /** Codex's: the call never reached it, or it refused it. */
  notTaken?: boolean;
}

/** What each way a call or a wait fails gives, by client. */
const failures: Record<
  Kind,
  {
    notConnected: Failure;
    timedOut(method: string): Failure;
    dropped: Failure;
    /** A call waiting as the client is closed. */
    closedCall: Failure;
    /** A wait for the connection as the client is closed, or one begun after. */
    closed: Failure;
    unreachable: Failure;
    refused(code: number, message: string): Failure;
    /** How long a wait for the connection lasts unless told. */
    readyMs: number;
  }
> = {
  codex: {
    notConnected: { type: CodexError, code: -32000, message: "Codex is not connected.", notTaken: true },
    timedOut: (method) => ({ type: CodexError, code: -32001, message: `Codex did not answer ${method} in time.`, notTaken: false }),
    dropped: { type: CodexError, code: -32000, message: "The connection to Codex dropped before it answered.", notTaken: false },
    closedCall: { type: Error, message: "The connection to Codex was closed." },
    closed: { type: CodexError, code: -32000, message: "The connection to Codex is closed.", notTaken: true },
    unreachable: { type: CodexError, code: -32000, message: "Codex is not reachable right now.", notTaken: true },
    refused: (code, message) => ({ type: CodexError, code, message, notTaken: true }),
    readyMs: 15_000,
  },
  hermes: {
    notConnected: { type: HermesError, code: -32000, message: "Hermes is not connected." },
    timedOut: (method) => ({ type: HermesError, code: -32001, message: `Hermes did not answer ${method} in time.` }),
    dropped: { type: HermesError, code: -32000, message: "The connection to Hermes dropped before it answered." },
    closedCall: { type: Error, message: "The connection to Hermes was closed." },
    closed: { type: Error, message: "The connection to Hermes is closed." },
    unreachable: { type: Error, message: "Hermes is not reachable right now." },
    refused: (code, message) => ({ type: HermesError, code, message }),
    readyMs: 20_000,
  },
};

function assertFailure(error: unknown, expected: Failure): void {
  assert.ok(error instanceof Error, `not an error: ${String(error)}`);
  assert.equal(error.constructor, expected.type);
  assert.equal(error.message, expected.message);
  if (expected.type !== Error) assert.equal((error as CodexError | HermesError).code, expected.code);
  if (expected.type === CodexError) assert.equal((error as CodexError).notTaken, expected.notTaken);
}

/** Whether a promise has settled yet, and how. */
function watch(promise: Promise<unknown>): { settled: boolean; value?: unknown; error?: unknown } {
  const box: { settled: boolean; value?: unknown; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(box, { settled: true, value }),
    (error) => Object.assign(box, { settled: true, error }),
  );
  return box;
}

/** A client of `kind` connected to a stand-in, on mocked time. */
async function connected(t: TestContext, kind: Kind, options: ClientOptions = {}): Promise<{ client: Client; standIn: StandIn; heard: string[] }> {
  mockTime(t);
  const standIn = new StandIn(kind);
  const client = kinds[kind].make(standIn, options);
  const heard: string[] = [];
  client.listen(ears(heard));
  t.after(() => client.close());
  void client.start();
  await settle();
  assert.equal(client.isConnected, true);
  return { client, standIn, heard };
}

/** The last call the client sent on `line`. */
function lastCall(line: Line): Frame {
  return line.sent.filter((frame) => frame.id !== undefined && frame.method !== undefined).at(-1)!;
}

for (const kind of ["codex", "hermes"] as const) {
  const name = names[kind];
  const fails = failures[kind];

  test(`${name}: a call made as the connection drops, in the same step, fails as not connected, and nothing is sent`, async (t) => {
    const { client, standIn } = await connected(t, kind);
    const sent = standIn.last.sent.length;
    const call = client.call("model/list", {}).catch((error: unknown) => error);
    standIn.last.gone();
    assertFailure(await call, fails.notConnected);
    assert.equal(standIn.last.sent.length, sent);
  });

  test(`${name}: a call nobody answers fails after 60 seconds, or the time the client or the call was given, and its answer after that is passed over`, async (t) => {
    const { client, standIn } = await connected(t, kind);
    const late = watch(client.call("model/list", {}));
    await settle();
    const id = lastCall(standIn.last).id;
    t.mock.timers.tick(59_999);
    await settle();
    assert.equal(late.settled, false);
    t.mock.timers.tick(1);
    await settle();
    assertFailure(late.error, fails.timedOut("model/list"));
    standIn.last.say(kinds[kind].answer(id, "too late"));

    const given = watch(client.call("thread/read", {}, 100));
    await settle();
    t.mock.timers.tick(100);
    await settle();
    assertFailure(given.error, fails.timedOut("thread/read"));

    const other = await connected(t, kind, { timeoutMs: 250 });
    const own = watch(other.client.call("model/list", {}));
    await settle();
    t.mock.timers.tick(249);
    await settle();
    assert.equal(own.settled, false);
    t.mock.timers.tick(1);
    await settle();
    assertFailure(own.error, fails.timedOut("model/list"));
    assert.equal(client.isConnected, true);
  });

  test(`${name}: every call waiting as the connection drops fails as dropped, the listeners hear it once, and a pause later the client connects again`, async (t) => {
    const { client, standIn, heard } = await connected(t, kind);
    const first = client.call("model/list", {}).catch((error: unknown) => error);
    const second = client.call("thread/read", {}).catch((error: unknown) => error);
    await settle();
    standIn.last.gone();
    assertFailure(await first, fails.dropped);
    assertFailure(await second, fails.dropped);
    assert.equal(client.isConnected, false);
    assert.deepEqual(heard, ["connected", "dropped"]);
    t.mock.timers.tick(500);
    await settle();
    assert.equal(standIn.lines.length, 2);
    assert.deepEqual(heard, ["connected", "dropped", "again"]);
  });

  test(`${name}: closing fails the calls waiting and every wait for the connection, closes the connection, tells the listeners nothing and tries no more`, async (t) => {
    const { client, standIn, heard } = await connected(t, kind);
    const call = client.call("model/list", {}).catch((error: unknown) => error);
    await settle();
    client.close();
    assertFailure(await call, fails.closedCall);
    assert.equal(standIn.last.closedByClient, true);
    assert.equal(client.isConnected, false);
    assertFailure(await client.whenReady().catch((error: unknown) => error), fails.closed);
    assertFailure(await client.call("model/list", {}).catch((error: unknown) => error), fails.closed);
    // Its connector saying it closed changes nothing.
    standIn.last.gone();
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(standIn.attempts, 1);
    assert.deepEqual(heard, ["connected"]);

    // A wait for a connection that never came.
    const away = new StandIn(kind);
    away.refusing = true;
    const other = kinds[kind].make(away, {});
    const waiting = other.whenReady().catch((error: unknown) => error);
    await settle();
    other.close();
    assertFailure(await waiting, fails.closed);
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(away.attempts, 1);
  });

  test(`${name}: an error answer fails the call with its code and sentence`, async (t) => {
    const { client, standIn } = await connected(t, kind);
    const call = client.call("thread/read", {}).catch((error: unknown) => error);
    await settle();
    standIn.last.say(kinds[kind].refuse(lastCall(standIn.last).id, { code: 4007, message: "No such thread." }));
    assertFailure(await call, fails.refused(4007, "No such thread."));
    assert.equal(client.isConnected, true);
  });

  test(`${name}: a wait for a connection that does not come fails after ${fails.readyMs / 1000} seconds, or the time it was given, and the client keeps trying`, async (t) => {
    mockTime(t);
    const standIn = new StandIn(kind);
    standIn.refusing = true;
    const client = kinds[kind].make(standIn, { backoff: [1] });
    t.after(() => client.close());
    const call = watch(client.call("model/list", {}));
    const short = watch(client.whenReady(100));
    await settle();
    t.mock.timers.tick(100);
    await settle();
    assertFailure(short.error, fails.unreachable);
    await elapse(t, fails.readyMs - 101);
    assert.equal(call.settled, false);
    t.mock.timers.tick(1);
    await settle();
    assertFailure(call.error, fails.unreachable);
    assert.equal(standIn.attempts, 1 + Math.floor(fails.readyMs / 1000));
    // And it connects once it can, for whoever waits then.
    standIn.refusing = false;
    const later = client.whenReady();
    t.mock.timers.tick(1000);
    await settle();
    await later;
    assert.equal(client.isConnected, true);
  });

  // MARK: Reconnecting

  test(`${name}: attempts that fail are made again after 0.5, 1, 2, 4, 8 and then every 10 seconds, telling the listeners nothing, and the pauses start over once connected`, async (t) => {
    mockTime(t);
    const standIn = new StandIn(kind);
    standIn.refusing = true;
    const client = kinds[kind].make(standIn, {});
    const heard: string[] = [];
    client.listen(ears(heard));
    t.after(() => client.close());
    await client.start();
    assert.equal(standIn.attempts, 1);
    for (const seconds of [0.5, 1, 2, 4, 8, 10, 10]) {
      const before: number = standIn.attempts;
      t.mock.timers.tick(seconds * 1000 - 1);
      await settle();
      assert.equal(standIn.attempts, before, `before ${seconds} s`);
      t.mock.timers.tick(1);
      await settle();
      assert.equal(standIn.attempts, before + 1, `at ${seconds} s`);
    }
    assert.deepEqual(heard, []);
    standIn.refusing = false;
    t.mock.timers.tick(10_000);
    await settle();
    assert.equal(client.isConnected, true);
    assert.deepEqual(heard, ["connected"]);
    // Dropped: the first pause again.
    standIn.last.gone();
    t.mock.timers.tick(499);
    await settle();
    assert.equal(standIn.lines.length, 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(standIn.lines.length, 2);
    assert.deepEqual(heard, ["connected", "dropped", "again"]);
  });

  test(`${name}: the pauses can be given, the last repeating`, async (t) => {
    mockTime(t);
    const standIn = new StandIn(kind);
    standIn.refusing = true;
    const client = kinds[kind].make(standIn, { backoff: [0.1, 0.3] });
    t.after(() => client.close());
    await client.start();
    const at: number[] = [];
    for (let ms = 0; ms < 1000; ms += 50) {
      t.mock.timers.tick(50);
      await settle();
      if (standIn.attempts > at.length + 1) at.push(Date.now());
    }
    assert.deepEqual(at, [100, 400, 700, 1000]);
  });

  test(`${name}: a handshake answered with an error closes that connection and is tried again after the pause, and whoever waits is let in once one succeeds`, async (t) => {
    mockTime(t);
    const standIn = new StandIn(kind);
    standIn.handshake = { code: -32600, message: "Not now." };
    const client = kinds[kind].make(standIn, {});
    const heard: string[] = [];
    client.listen(ears(heard));
    t.after(() => client.close());
    const waiting = watch(client.whenReady(60_000));
    await client.start();
    await settle();
    assert.equal(standIn.last.closedByClient, true);
    assert.equal(client.isConnected, false);
    // What it says before its close arrives is not heard.
    standIn.last.say(kinds[kind].news.frame);
    t.mock.timers.tick(500);
    await settle();
    assert.equal(standIn.lines.length, 2);
    assert.equal(standIn.last.closedByClient, true);
    // A failed handshake does not start the pauses over.
    standIn.handshake = "answer";
    t.mock.timers.tick(999);
    await settle();
    assert.equal(standIn.lines.length, 2);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(client.isConnected, true);
    assert.equal(waiting.settled, true);
    assert.equal(waiting.error, undefined);
    assert.deepEqual(heard, ["connected"]);
  });

  test(`${name}: once it connects again, what the connection before says, and its end, count for nothing`, async (t) => {
    const { client, standIn, heard } = await connected(t, kind);
    const old = standIn.last;
    old.gone();
    t.mock.timers.tick(500);
    await settle();
    const call = watch(client.call("model/list", {}));
    await settle();
    const id = lastCall(standIn.last).id;
    old.say(kinds[kind].answer(id, "from the old one"));
    old.say(kinds[kind].news.frame);
    old.gone();
    await settle();
    assert.equal(call.settled, false);
    assert.equal(client.isConnected, true);
    standIn.last.say(kinds[kind].answer(id, "from the new one"));
    await settle();
    assert.equal(call.value, "from the new one");
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(standIn.attempts, 2);
    assert.deepEqual(heard, ["connected", "dropped", "again"]);
  });

  test(`${name}: a connection that opens after the client was closed is closed at once`, async (t) => {
    mockTime(t);
    const standIn = new StandIn(kind);
    standIn.openingMs = 1000;
    const client = kinds[kind].make(standIn, {});
    const heard: string[] = [];
    client.listen(ears(heard));
    const started = client.start();
    await settle();
    client.close();
    t.mock.timers.tick(1000);
    await started;
    await settle();
    assert.equal(standIn.lines.length, 1);
    assert.equal(standIn.last.closedByClient, true);
    assert.equal(client.isConnected, false);
    assert.deepEqual(heard, []);
  });

  test(`${name}: a call that waited for the connection goes out before anything the listeners send as they hear it came up`, async (t) => {
    mockTime(t);
    const standIn = new StandIn(kind);
    const client = kinds[kind].make(standIn, {});
    t.after(() => client.close());
    client.listen({ ...ears([]), connected: () => void client.call("from/the/listener", {}).catch(() => undefined) });
    void client.call("waited", {}).catch(() => undefined);
    await settle();
    assert.deepEqual(
      standIn.last.sent.slice(-2).map((frame) => frame.method),
      ["waited", "from/the/listener"],
    );
  });
}

// MARK: Codex's own

test("Codex: each connection starts with initialize and initialized; calls go out with numbers for ids and no jsonrpc key, and an answer by a string id is no answer to one", async (t) => {
  const { client, standIn } = await connected(t, "codex");
  assert.deepEqual(standIn.last.sent, [
    { id: 1, method: "initialize", params: { clientInfo: { name: "portals-bridge", title: "Portals", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } } },
    { method: "initialized" },
  ]);
  const first = watch(client.call("model/list", { limit: 1 }));
  const second = watch(client.call("thread/read", { threadId: "t" }));
  await settle();
  assert.deepEqual(standIn.last.sent.slice(2), [
    { id: 2, method: "model/list", params: { limit: 1 } },
    { id: 3, method: "thread/read", params: { threadId: "t" } },
  ]);
  standIn.last.say({ id: "2", result: "by a string" });
  standIn.last.say({ id: 3, result: { thread: {} } });
  await settle();
  assert.equal(first.settled, false);
  assert.deepEqual(second.value, { thread: {} });
  // One without a result is answered with nothing.
  standIn.last.say({ id: 2 });
  await settle();
  assert.equal(first.settled, true);
  assert.equal(first.value, undefined);
});

test("Codex: a message with a method and an id is a request, by the id as given; one without an id, or with a null one, a notification; their params are {} when left out", async (t) => {
  mockTime(t);
  const standIn = new StandIn("codex");
  const client = kinds.codex.make(standIn, {}) as unknown as CodexClient;
  t.after(() => client.close());
  const heard: unknown[] = [];
  client.listen({
    notification: (method, params) => heard.push(["notification", method, params]),
    request: (id, method, params) => heard.push(["request", id, method, params]),
    connected() {},
    disconnected() {},
  });
  void client.start();
  await settle();
  standIn.last.say({ id: 7, method: "item/tool/requestUserInput", params: { threadId: "t" } });
  standIn.last.say({ id: "srv-1", method: "ping" });
  standIn.last.say({ method: "thread/started", params: { thread: { id: "t" } } });
  standIn.last.say({ id: null, method: "turn/started" });
  assert.deepEqual(heard, [
    ["request", 7, "item/tool/requestUserInput", { threadId: "t" }],
    ["request", "srv-1", "ping", {}],
    ["notification", "thread/started", { thread: { id: "t" } }],
    ["notification", "turn/started", {}],
  ]);
  client.respond(7, { answers: {} });
  client.respondError("srv-1", -32601, "No.");
  client.notify("thread/unsubscribe", { threadId: "t" });
  assert.deepEqual(standIn.last.sent.slice(-3), [
    { id: 7, result: { answers: {} } },
    { id: "srv-1", error: { code: -32601, message: "No." } },
    { method: "thread/unsubscribe", params: { threadId: "t" } },
  ]);
});

test("Codex: a wait for the connection lasts what the client was given (readyMs)", async (t) => {
  mockTime(t);
  const standIn = new StandIn("codex");
  standIn.refusing = true;
  const client = kinds.codex.make(standIn, { readyMs: 300 });
  t.after(() => client.close());
  const waiting = watch(client.whenReady());
  await elapse(t, 299);
  assert.equal(waiting.settled, false);
  await elapse(t, 1);
  assertFailure(waiting.error, failures.codex.unreachable);
});

test("Codex: a client closed while it prepares (its daemon being started) opens no connection after, and nothing reaches its listeners", async (t) => {
  mockTime(t);
  const standIn = new StandIn("codex");
  const preparing: { release?: () => void } = {};
  const client = kinds.codex.make(standIn, { prepare: () => new Promise<void>((resolve) => (preparing.release = resolve)) });
  const heard: string[] = [];
  client.listen(ears(heard));
  const started = watch(client.start());
  await settle();
  assert.ok(preparing.release);
  assert.equal(standIn.attempts, 0);

  client.close();
  preparing.release();
  await settle();
  assert.equal(standIn.attempts, 0);
  assert.equal(started.settled, true);
  assert.equal(client.isConnected, false);
  assert.deepEqual(heard, []);
});

test("Codex: prepare runs before each attempt, and the attempt waits for it", async (t) => {
  mockTime(t);
  const standIn = new StandIn("codex");
  const prepared: number[] = [];
  let release = () => {};
  const client = kinds.codex.make(standIn, {
    backoff: [1],
    prepare: () => {
      prepared.push(standIn.attempts);
      return new Promise<void>((resolve) => (release = resolve));
    },
  });
  t.after(() => client.close());
  void client.start();
  await settle();
  assert.deepEqual([prepared, standIn.attempts], [[0], 0]);
  release();
  await settle();
  assert.equal(client.isConnected, true);
  standIn.last.gone();
  await elapse(t, 1000);
  assert.deepEqual([prepared, standIn.attempts], [[0, 1], 1]);
  release();
  await settle();
  assert.deepEqual([standIn.attempts, client.isConnected], [2, true]);
});

// MARK: Hermes's own

test("Hermes: calls go out as JSON-RPC 2.0 with ids b1, b2…, a frame answering one by a number is no answer to it, and one without a result is answered with null", async (t) => {
  const { client, standIn } = await connected(t, "hermes");
  assert.deepEqual(standIn.last.sent, [{ jsonrpc: "2.0", id: "b1", method: "client.capabilities", params: { server_requests: true } }]);
  const call = watch(client.call("model.options", {}));
  await settle();
  assert.deepEqual(standIn.last.sent.at(-1), { jsonrpc: "2.0", id: "b2", method: "model.options", params: {} });
  standIn.last.say({ jsonrpc: "2.0", id: 2, result: "by a number" });
  await settle();
  assert.equal(call.settled, false);
  standIn.last.say({ jsonrpc: "2.0", id: "b2" });
  await settle();
  assert.equal(call.value, null);

  // Without a code or a sentence.
  const refused = client.call("session.resume", {}).catch((error: unknown) => error);
  await settle();
  standIn.last.say({ jsonrpc: "2.0", id: "b3", error: {} });
  assertFailure(await refused, failures.hermes.refused(-32000, "Hermes refused the call."));

  client.respond("srq-1", { choice: "once" });
  client.respondError("srq-2", -32601, "No.");
  assert.deepEqual(standIn.last.sent.slice(-2), [
    { jsonrpc: "2.0", id: "srq-1", result: { choice: "once" } },
    { jsonrpc: "2.0", id: "srq-2", error: { code: -32601, message: "No." } },
  ]);
});

test("Hermes: events reach the listeners unpacked; other notifications, and events without a type, do not; a request's id reaches them as a string", async (t) => {
  mockTime(t);
  const standIn = new StandIn("hermes");
  const client = kinds.hermes.make(standIn, {}) as unknown as HermesClient;
  t.after(() => client.close());
  const heard: unknown[] = [];
  client.listen({
    event: (type, sessionID, seq, payload) => heard.push(["event", type, sessionID, seq, payload]),
    request: (id, method, params) => heard.push(["request", id, method, params]),
    connected() {},
    disconnected() {},
  });
  void client.start();
  await settle();
  const event = (params: Frame) => standIn.last.say({ jsonrpc: "2.0", method: "event", params });
  event({ type: "message.delta", session_id: "s", seq: 4, payload: { text: "Hi" } });
  event({ type: "session.info", session_id: "", seq: 1.5 });
  event({ session_id: "s", payload: {} });
  standIn.last.say({ jsonrpc: "2.0", method: "session.info", params: { session_id: "s" } });
  standIn.last.say({ jsonrpc: "2.0", id: 9, method: "clarify.request", params: { session_id: "s" } });
  standIn.last.say({ jsonrpc: "2.0", id: "srq-3", method: "approval.request" });
  assert.deepEqual(heard, [
    ["event", "message.delta", "s", 4, { text: "Hi" }],
    ["event", "session.info", undefined, undefined, {}],
    ["request", "9", "clarify.request", { session_id: "s" }],
    ["request", "srq-3", "approval.request", {}],
  ]);
});

test("Hermes: its gateway.ping is answered with ok under its id, as a string, and never reaches the listeners", async (t) => {
  const { standIn, heard } = await connected(t, "hermes");
  standIn.last.say({ jsonrpc: "2.0", id: 5, method: "gateway.ping", params: {} });
  standIn.last.say({ jsonrpc: "2.0", id: "p-1", method: "gateway.ping" });
  assert.deepEqual(standIn.last.sent.slice(-2), [
    { jsonrpc: "2.0", id: "5", result: { ok: true } },
    { jsonrpc: "2.0", id: "p-1", result: { ok: true } },
  ]);
  assert.deepEqual(heard, ["connected"]);
});

test("Hermes: events before its greeting are passed over; after it they count, before the handshake has ended too", async (t) => {
  mockTime(t);
  const standIn = new StandIn("hermes");
  standIn.greeting = null;
  standIn.handshake = null;
  const client = kinds.hermes.make(standIn, {});
  const heard: string[] = [];
  client.listen(ears(heard));
  t.after(() => client.close());
  void client.start();
  await settle();
  const event = (type: string) => standIn.last.say({ jsonrpc: "2.0", method: "event", params: { type, session_id: "s", payload: {} } });
  event("before.greeting");
  standIn.last.say(ready({}));
  await settle();
  assert.equal(lastCall(standIn.last).method, "client.capabilities");
  event("before.capabilities.answered");
  standIn.last.say(kinds.hermes.answer("b1", {}));
  await settle();
  event("after");
  assert.deepEqual(heard, ["before.capabilities.answered", "connected", "after"]);
});

test("Hermes: its greeting is waited for 15 seconds from the start of the attempt, before the connector finds and opens Hermes, not from the connection opening", async (t) => {
  mockTime(t);
  const standIn = new StandIn("hermes");
  standIn.greeting = null;
  standIn.openingMs = 10_000;
  const client = kinds.hermes.make(standIn, {});
  const heard: string[] = [];
  client.listen(ears(heard));
  t.after(() => client.close());
  void client.start();
  await elapse(t, 10_000);
  assert.equal(standIn.lines.length, 1);
  await elapse(t, 4_950);
  assert.equal(standIn.last.closedByClient, false);
  await elapse(t, 50);
  assert.equal(standIn.last.closedByClient, true);
  assert.equal(client.isConnected, false);
  // The next attempt, 0.5 seconds on, opens 10 seconds later, and is greeted 4.9 seconds after that.
  await elapse(t, 10_500);
  assert.equal(standIn.lines.length, 2);
  await elapse(t, 4_900);
  standIn.last.say(ready({}));
  await settle();
  assert.equal(client.isConnected, true);
  assert.deepEqual(heard, ["connected"]);
});

for (const kind of ["codex", "hermes"] as const) {
  test(`${names[kind]}: a client closed as its handshake is answered stays closed: not connected, no listener told it connected${kind === "hermes" ? ", no pings" : ""}`, async (t) => {
    mockTime(t);
    const standIn = new StandIn(kind);
    standIn.handshake = null;
    if (kind === "hermes") standIn.greeting = { heartbeat: true };
    const client = kinds[kind].make(standIn, { backoff: [1] });
    const heard: string[] = [];
    client.listen(ears(heard));
    const started = watch(client.start());
    await settle();
    const line = standIn.last;
    const handshake = lastCall(line);
    assert.equal(handshake.method, kinds[kind].handshake);

    // The answer arrives, and the client is closed before the handshake takes it in.
    line.say(kinds[kind].answer(handshake.id, {}));
    client.close();
    await settle();
    assert.equal(client.isConnected, false);
    assert.deepEqual(heard, []);
    await assert.rejects(client.whenReady(1000));
    await elapse(t, 60_000);
    assert.equal(line.sent.filter((frame) => frame.method === "gateway.ping").length, 0);
    assert.equal(started.settled, true);
  });
}

test("Hermes: a client closed before Hermes greeted it is done at once, with no warning, not when the greeting's time is up", async (t) => {
  mockTime(t);
  const standIn = new StandIn("hermes");
  standIn.greeting = null;
  const client = kinds.hermes.make(standIn, { backoff: [1] });
  const lines = logLines(t);
  const started = watch(client.start());
  await settle();
  assert.equal(standIn.lines.length, 1);
  assert.equal(started.settled, false);

  client.close();
  await settle();
  assert.equal(started.settled, true);
  await elapse(t, 15_000);
  assert.deepEqual(lines.filter((line) => / (warn|error) /.test(line)), []);
  assert.equal(standIn.attempts, 1);
});

test("Hermes: with a heartbeat it pings every 15 seconds, any frame counts as Hermes alive, and after more than three times that with none the connection is closed and made again", async (t) => {
  mockTime(t);
  const standIn = new StandIn("hermes");
  standIn.greeting = { heartbeat: true };
  const client = kinds.hermes.make(standIn, {});
  const heard: string[] = [];
  const reasons: string[] = [];
  client.listen(ears(heard));
  client.listen({ ...ears([]), disconnected: (reason) => reasons.push(reason) });
  t.after(() => client.close());
  void client.start();
  await settle();
  const first = standIn.last;
  const pings = () => first.sent.filter((frame) => frame.method === "gateway.ping").length;
  await elapse(t, 15_000);
  assert.deepEqual(first.sent.at(-1), { jsonrpc: "2.0", id: "b2", method: "gateway.ping", params: {} });
  // A frame at 50 s: the next 45 have to pass without one.
  await elapse(t, 35_000);
  assert.equal(pings(), 3);
  standIn.last.say({ jsonrpc: "2.0", method: "event", params: { type: "session.info", session_id: "s", payload: {} } });
  await elapse(t, 45_000);
  assert.equal(pings(), 6);
  assert.equal(client.isConnected, true);
  // At 105 s, 55 after that frame.
  await elapse(t, 10_000);
  assert.equal(pings(), 6);
  assert.equal(first.closedByClient, true);
  assert.equal(client.isConnected, false);
  assert.deepEqual(reasons, ["no frame for too long"]);
  // And it connects again after the pause.
  await elapse(t, 500);
  assert.equal(standIn.lines.length, 2);
  assert.equal(client.isConnected, true);
  assert.deepEqual(heard, ["connected", "session.info", "dropped", "again"]);
});

test("Hermes: without a heartbeat in its greeting nothing is pinged and a quiet connection stays", async (t) => {
  const { standIn, client } = await connected(t, "hermes");
  await elapse(t, 120_000);
  assert.equal(
    standIn.last.sent.some((frame) => frame.method === "gateway.ping"),
    false,
  );
  assert.equal(client.isConnected, true);
});

test("Hermes: the ping's pace can be given", async (t) => {
  mockTime(t);
  const standIn = new StandIn("hermes");
  standIn.greeting = { heartbeat: true };
  const client = kinds.hermes.make(standIn, { pingMs: 1000 });
  t.after(() => client.close());
  void client.start();
  await settle();
  await elapse(t, 3000);
  assert.equal(standIn.last.sent.filter((frame) => frame.method === "gateway.ping").length, 3);
  await elapse(t, 1000);
  assert.equal(standIn.last.closedByClient, true);
});

test("Hermes: the listeners hear whether it connected again to the same run of Hermes, by its replay epoch", async (t) => {
  mockTime(t);
  const standIn = new StandIn("hermes");
  const client = kinds.hermes.make(standIn, {}) as unknown as HermesClient;
  t.after(() => client.close());
  const heard: [boolean, boolean][] = [];
  client.listen({ event() {}, request() {}, connected: (again, sameRun) => heard.push([again, sameRun]), disconnected() {} });
  for (const epoch of ["e1", "e1", "e2", null, null]) {
    standIn.greeting = epoch === null ? {} : { replay_epoch: epoch };
    if (standIn.lines.length === 0) void client.start();
    else standIn.last.gone();
    await elapse(t, 500);
  }
  assert.deepEqual(heard, [
    [false, false],
    [true, true],
    [true, false],
    [true, false],
    [true, false],
  ]);
});
