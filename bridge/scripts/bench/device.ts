import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import type { Account } from "./scratch.ts";

// A device, as the harness plays one: it does what the app does around the list of
// threads, and counts the bytes each way.
//
// - It signs in once and keeps the cookie; each connection after that takes only a
//   ticket (PasswordAuthenticator.swift). A sign-in is about 50 ms of CPU in the bridge.
// - A poll is one `sessions.activity` (MainScreen.swift, every five seconds while the
//   sidebar shows), and `threads.changes` follows only when the list's revision is not
//   the one held, or right after the device sent a change of its own (HostSync.runStep).
// - A thread it looks at whose turn ended is answered with a seen: `thread.mark` with
//   `unseen` false, the thread's revision as listed here and the list's id (HostSync.seen).
//   A pushing device takes the list from the seen's answer when the answer is all that
//   moved it, as the app does from a bridge that offers poll_now (HostSync.sendSeen), so
//   the poll its own seen brings fetches nothing.
// - `gateway.ping` every fifteen seconds is the connection's heartbeat (JSONRPCPeer.swift).
// - A pushing device (`pushes`) asks for `poll.now` in `client.capabilities` (feature
//   poll_now) and polls a while after one, once for every one heard meanwhile, as the app
//   does (HostSync.hostMoved, HostModel.pollNow); one told while a poll is on its way polls
//   once more after it. Its polls every five seconds, when it makes them, skip one on its
//   way, as the app's do.
// - A thread it followed is taken up again on a new connection as `CatchUp` says: as the
//   app did before `resume_replay`, or with only the events it missed (HermesBackend.resync
//   and catchUp), sending back where the replay of the conversation it took whole began.
//
// Bytes are WebSocket payloads and HTTP bodies: no headers, framing, compression or TLS.
// Nothing received is kept beyond what the rules above need (test/helpers.ts's client
// keeps every frame, and parsed, not as sizes).

/** What one kind of call cost: how many, the bytes each way, and each one's time. */
export interface CallStats {
  n: number;
  up: number;
  down: number;
  ms: number[];
}

/** A device's counts at one moment, to take the difference of (`Device.since`). */
export interface Totals {
  /** By method name; an HTTP request is `http login`, `http ticket` or `http push`. */
  calls: Map<string, CallStats>;
  /** Events received, and `gateway.ready`. */
  events: { n: number; bytes: number };
}

/**
 * How a device takes up a thread it followed, on a new connection: as the app does with a
 * bridge without `resume_replay` for a thread with a turn under way (`since`: the whole
 * `session.resume`, then `session.events.since`) or at rest (`whole`: the whole resume
 * alone), or as it does with one (`replay`: the resume with the last event it holds, which
 * brings only those after it when the bridge can).
 */
export type CatchUp = "since" | "whole" | "replay";

/** A bridge to connect to: its address and the sign-in it takes. */
export interface Host {
  url: string;
  account: Account;
}

type Frame = Record<string, any>;

interface Pending {
  done: (frame: Frame, bytes: number) => void;
  failed: (error: Error) => void;
}

interface EventWaiter {
  type: string;
  session?: string;
  done: (params: Frame) => void;
  failed: (error: Error) => void;
}

/** How long any one call or awaited event may take before the harness gives up. */
const patienceMs = 60_000;

export interface DeviceOptions {
  /** Asks for `poll.now` (feature poll_now) and polls `waitMs` after one, as the app does. */
  pushes?: { waitMs: number };
}

export class Device {
  /** The list as last fetched: its id and revision. */
  list: { id: string; revision: number } | null = null;
  /** By thread: its revision as listed here, and whether it is unseen. */
  readonly threads = new Map<string, { revision: number; unseen: boolean }>();
  /** By thread followed: the last event's `seq`, or the `latest_seq` of the resume answer taken since. */
  readonly lastSeq = new Map<string, number>();
  /** By thread taken whole from a bridge with `resume_replay`: where the replay of the conversation it took begins (`replay_base`). */
  readonly replayBase = new Map<string, number>();
  /** What the last `gateway.ready` said: the bridge's run, and the extensions it offers. */
  epoch = "";
  features = new Set<string>();
  /** Times the connection went without `disconnect`: the bridge closed it, or the link under it was cut. */
  drops = 0;
  /** By thread: the highest revision a fetch merged it at as unseen. */
  readonly shownUnseen = new Map<string, number>();
  /** By thread: each revision a fetch merged it at, with when (`performance.now()`). */
  readonly merged = new Map<string, { revision: number; at: number }[]>();
  /** `poll.now` events heard, and their bytes. */
  told = 0;
  toldBytes = 0;
  private readonly url: string;
  private readonly account: Account;
  private readonly pushes: { waitMs: number } | undefined;
  /** The poll asked for by a `poll.now`, waiting its time. */
  private pollSoon: NodeJS.Timeout | undefined;
  /** A poll is on its way; another was asked for meanwhile. */
  private polling = false;
  private pollAgain = false;
  private readonly calls = new Map<string, CallStats>();
  private readonly events = { n: 0, bytes: 0 };
  private cookie = "";
  private socket: WebSocket | null = null;
  private nextID = 0;
  private readonly pending = new Map<string, Pending>();
  private waiters: EventWaiter[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(bridge: Host, options: DeviceOptions = {}) {
    this.url = bridge.url;
    this.account = bridge.account;
    this.pushes = options.pushes;
  }

  /** A device signed in and connected, as after the app's first launch. */
  static async open(bridge: Host, options: DeviceOptions = {}): Promise<Device> {
    const device = new Device(bridge, options);
    await device.signIn();
    await device.connect();
    return device;
  }

  // MARK: Signing in and connecting

  async signIn(): Promise<void> {
    const response = await this.http("login", "POST", "/auth/password-login", { provider: "basic", ...this.account });
    this.cookie = response.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
    if (response.status !== 200 || this.cookie === "") throw new Error(`the sign-in answered ${response.status}`);
  }

  /** A ticket, the socket, `gateway.ready`, then `client.capabilities`, as the app opens a connection. */
  async connect(): Promise<void> {
    const response = await this.http("ticket", "POST", "/api/auth/ws-ticket", {});
    if (response.status !== 200) throw new Error(`the ticket route answered ${response.status}`);
    const { ticket } = JSON.parse(response.text) as { ticket: string };
    // Compression offered, as the app's URLSessionWebSocketTask offers it. ws's offer also
    // names client_max_window_bits, which the bridge leaves out of its answer: what is
    // agreed is what the app agrees.
    const socket = new WebSocket(`${this.url.replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(ticket)}`, { perMessageDeflate: true });
    this.socket = socket;
    const ready = this.event("gateway.ready");
    socket.on("message", (data) => this.received(Array.isArray(data) ? Buffer.concat(data) : (data as Buffer)));
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.drops += 1;
      }
      this.hungUp(new Error("the bridge closed the connection"));
    });
    socket.on("error", (error) => this.hungUp(error));
    const said = (await ready).payload as { replay_epoch: string; bridge?: { features?: string[] } };
    this.epoch = said.replay_epoch;
    this.features = new Set(said.bridge?.features ?? []);
    await this.call("client.capabilities", this.pushes ? { server_requests: true, poll_now: true } : { server_requests: true });
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Closes the connection, keeping the sign-in and the list held: the app in the background. */
  async disconnect(): Promise<void> {
    this.stopTimers();
    clearTimeout(this.pollSoon);
    this.pollSoon = undefined;
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((done) => {
      socket.once("close", () => done());
      socket.close();
    });
  }

  // MARK: Calls

  /** One call on the connection: its result, or an error with the bridge's sentence. */
  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${method}: the device is not connected`));
    const id = `r${++this.nextID}`;
    const text = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const started = performance.now();
    return new Promise((done, failed) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        failed(new Error(`${method} was not answered in ${patienceMs / 1000} s`));
      }, patienceMs);
      this.pending.set(id, {
        done: (frame, bytes) => {
          clearTimeout(timer);
          this.count(method, Buffer.byteLength(text), bytes, performance.now() - started);
          if (frame.error) failed(new Error(`${method}: ${frame.error.message}`));
          else done(frame.result);
        },
        failed: (error) => {
          clearTimeout(timer);
          failed(error);
        },
      });
      socket.send(text);
    });
  }

  /** One HTTP request with the session cookie, counted as `http <what>` with the bytes of both bodies. */
  async http(what: "login" | "ticket" | "push", method: string, path: string, body: unknown): Promise<{ status: number; text: string; headers: Headers }> {
    const sent = JSON.stringify(body);
    const started = performance.now();
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: sent,
    });
    const text = await response.text();
    this.count(`http ${what}`, Buffer.byteLength(sent), Buffer.byteLength(text), performance.now() - started);
    return { status: response.status, text, headers: response.headers };
  }

  /**
   * The next event of `type` (for `session`, when given), with its params. Asked for
   * before the call that causes it, so it cannot be missed.
   */
  event(type: string, session?: string): Promise<Frame> {
    return new Promise((done, failed) => {
      const waiter: EventWaiter = {
        type,
        session,
        done: (params) => {
          clearTimeout(timer);
          done(params);
        },
        failed: (error) => {
          clearTimeout(timer);
          failed(error);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((other) => other !== waiter);
        failed(new Error(`no ${type} event in ${patienceMs / 1000} s`));
      }, patienceMs);
      this.waiters.push(waiter);
    });
  }

  // MARK: What the app does around the list

  /** A poll: `sessions.activity`, and the list fetched when its revision is not the one held. True when it fetched. */
  async poll(): Promise<boolean> {
    const activity = await this.call("sessions.activity");
    const now = activity.thread_list as { id: string; revision: number };
    if (this.list && this.list.id === now.id && this.list.revision === now.revision) return false;
    await this.fetch();
    return true;
  }

  /** `threads.changes` since the list held (everything when none is), merged into what is held. */
  async fetch(): Promise<Frame> {
    const changes = await this.call("threads.changes", this.list ? { list: this.list.id, since: this.list.revision } : {});
    if (changes.full) this.threads.clear();
    this.take(changes.list, changes.threads as Frame[]);
    for (const id of changes.removed as string[]) this.threads.delete(id);
    return changes;
  }

  /** Threads as the list gives them, merged into what is held, and the list where they put it. */
  private take(list: { id: string; revision: number }, threads: Frame[]): void {
    const at = performance.now();
    for (const thread of threads) {
      this.threads.set(thread.id, { revision: thread.revision, unseen: thread.unseen === true });
      const merged = this.merged.get(thread.id) ?? [];
      merged.push({ revision: thread.revision, at });
      this.merged.set(thread.id, merged);
      if (thread.unseen === true) this.shownUnseen.set(thread.id, Math.max(thread.revision, this.shownUnseen.get(thread.id) ?? 0));
    }
    this.list = list;
  }

  /** A change made on this device (a pin, an archive): sent, and the list it moved fetched at once. */
  async mark(thread: string, marks: Record<string, unknown>): Promise<void> {
    await this.call("thread.mark", { thread, ...marks });
    await this.fetch();
  }

  /**
   * The thread is looked at: when it is unseen as listed here, the bridge is told it was seen. True when it was told.
   * A pushing device takes the thread from the answer, with the list one revision on, when the list held is the
   * one just before it: the seen is then all that moved it (HostSync.sendSeen, `take`).
   */
  async seen(thread: string): Promise<boolean> {
    const held = this.threads.get(thread);
    if (!held?.unseen || !this.list) return false;
    held.unseen = false;
    const answer = await this.call("thread.mark", { thread, unseen: false, revision: held.revision, list: this.list.id });
    const listed = answer.thread as Frame | undefined;
    if (this.pushes && this.features.has("poll_now") && listed && this.list && listed.revision === this.list.revision + 1) {
      this.take({ id: this.list.id, revision: listed.revision as number }, [listed]);
    }
    return true;
  }

  /**
   * `session.resume`, the whole answer: what it holds counts as the events up to its
   * `latest_seq`. To a bridge with `resume_replay` it names the run, as the app does
   * (`replays`; not as it does with a bridge without it), and keeps where the replay of
   * what it took begins, which a catch-up sends back.
   */
  async resume(thread: string, replays = this.features.has("resume_replay")): Promise<Frame> {
    const resumed = await this.call("session.resume", { session_id: thread, profile: "fake", inline_images: false, ...(replays ? { replay_epoch: this.epoch } : {}) });
    this.took(resumed);
    return resumed;
  }

  /**
   * A thread it followed, taken up again on a new connection (`CatchUp`). How many events
   * it missed; null when it took the thread whole: the bridge's log no longer reached back
   * that far, or the way taken brings no events.
   */
  async catchUp(thread: string, how: CatchUp = "since"): Promise<number | null> {
    // The last event held before: what arrives live from the resume on is held apart until the missed ones are in.
    const lastSeen = this.lastSeq.get(thread);
    const base = this.replayBase.get(thread);
    if (how === "replay" && lastSeen !== undefined && base !== undefined && this.features.has("resume_replay")) {
      const resumed = await this.call("session.resume", { session_id: thread, profile: "fake", inline_images: false, since: lastSeen, replay_epoch: this.epoch, replay_base: base });
      if (resumed.replayed !== true) {
        this.took(resumed);
        return null;
      }
      const events = resumed.events as Frame[];
      this.held(thread, events.reduce((seq, event) => Math.max(seq, event.seq as number), 0));
      return events.length;
    }
    const resumed = await this.resume(thread, false);
    if (how !== "since") return null;
    const session = resumed.session_id as string;
    const missed = await this.call("session.events.since", { session_id: session, last_seen: lastSeen ?? 0 });
    const events = missed.events as Frame[];
    this.held(session, events.reduce((seq, event) => Math.max(seq, event.seq as number), 0));
    return missed.truncated === true ? null : events.length;
  }

  /** A whole resume answer was taken: the thread holds every event up to its `latest_seq`, and its replay begins where it says. */
  private took(resumed: Frame): void {
    const thread = resumed.session_id as string;
    this.held(thread, resumed.latest_seq as number);
    if (typeof resumed.replay_base === "number") this.replayBase.set(thread, resumed.replay_base);
  }

  /** The thread holds every event up to `seq`. */
  private held(thread: string, seq: number): void {
    this.lastSeq.set(thread, Math.max(this.lastSeq.get(thread) ?? 0, seq));
  }

  /** Polls every `everyMs` and sends the heartbeat every `heartbeatMs`, until `stopTimers` or `disconnect`. */
  startPolling(everyMs: number, heartbeatMs: number): void {
    const quietly = (work: Promise<unknown>) => void work.catch(() => undefined);
    // A pushing device's poll skips one on its way, as the app's (HostModel.refreshActivity).
    this.timers.push(setInterval(() => (this.pushes ? !this.polling && this.pollNow() : quietly(this.poll())), everyMs));
    this.timers.push(setInterval(() => quietly(this.call("gateway.ping")), heartbeatMs));
  }

  /** Until no poll a `poll.now` asked for waits or is on its way. */
  async quiet(): Promise<void> {
    while (this.pollSoon || this.polling) await sleep(10);
  }

  /** A `poll.now`: a poll `waitMs` from the first one heard since the last such wait. */
  private toldToPoll(): void {
    this.told += 1;
    if (!this.pushes || this.pollSoon) return;
    this.pollSoon = setTimeout(() => {
      this.pollSoon = undefined;
      this.pollNow();
    }, this.pushes.waitMs);
  }

  /** Polls, or, with one on its way, once more after it. */
  private pollNow(): void {
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = true;
    void (async () => {
      do {
        this.pollAgain = false;
        await this.poll().catch(() => undefined);
      } while (this.pollAgain && this.connected);
      this.polling = false;
    })();
  }

  stopTimers(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  // MARK: Counts

  totals(): Totals {
    const calls = new Map<string, CallStats>();
    for (const [method, stats] of this.calls) calls.set(method, { ...stats, ms: [...stats.ms] });
    return { calls, events: { ...this.events } };
  }

  /** What was counted since `mark` was taken. */
  since(mark: Totals): Totals {
    const calls = new Map<string, CallStats>();
    for (const [method, now] of this.calls) {
      const before = mark.calls.get(method) ?? { n: 0, up: 0, down: 0, ms: [] };
      if (now.n === before.n) continue;
      calls.set(method, { n: now.n - before.n, up: now.up - before.up, down: now.down - before.down, ms: now.ms.slice(before.ms.length) });
    }
    return { calls, events: { n: this.events.n - mark.events.n, bytes: this.events.bytes - mark.events.bytes } };
  }

  // MARK: Internals

  private count(method: string, up: number, down: number, ms: number): void {
    let stats = this.calls.get(method);
    if (!stats) {
      stats = { n: 0, up: 0, down: 0, ms: [] };
      this.calls.set(method, stats);
    }
    stats.n += 1;
    stats.up += up;
    stats.down += down;
    stats.ms.push(ms);
  }

  private received(data: Buffer): void {
    const frame = JSON.parse(data.toString("utf8")) as Frame;
    if (frame.method === "event") {
      this.events.n += 1;
      this.events.bytes += data.length;
      const params = frame.params as Frame;
      if (typeof params.session_id === "string" && typeof params.seq === "number") this.lastSeq.set(params.session_id, params.seq);
      if (params.type === "poll.now" && params.session_id === undefined) {
        this.toldBytes += data.length;
        this.toldToPoll();
      }
      const waiting = this.waiters.filter((waiter) => waiter.type === params.type && (!waiter.session || waiter.session === params.session_id));
      if (waiting.length === 0) return;
      this.waiters = this.waiters.filter((waiter) => !waiting.includes(waiter));
      for (const waiter of waiting) waiter.done(params);
      return;
    }
    // One of the bridge's own questions: the scripted turns the harness runs ask none.
    if (typeof frame.method === "string") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    pending.done(frame, data.length);
  }

  /** The connection went: whatever waited on it fails now, not after its own time is up. */
  private hungUp(error: Error): void {
    for (const pending of this.pending.values()) pending.failed(error);
    this.pending.clear();
    for (const waiter of this.waiters) waiter.failed(error);
    this.waiters = [];
  }
}

/** A device that sends `gateway.ping` one after another, `gapMs` apart: how long each takes shows when the bridge was held up. */
export class Pinger {
  /** Each ping's time, in milliseconds. */
  readonly times: number[] = [];
  private readonly device: Device;
  private readonly running: Promise<void>;
  private stopped = false;

  private constructor(device: Device, gapMs: number) {
    this.device = device;
    this.running = this.run(gapMs);
  }

  static async start(bridge: Host, gapMs = 5): Promise<Pinger> {
    return new Pinger(await Device.open(bridge), gapMs);
  }

  async stop(): Promise<number[]> {
    this.stopped = true;
    await this.running;
    await this.device.disconnect();
    return this.times;
  }

  private async run(gapMs: number): Promise<void> {
    while (!this.stopped) {
      const started = performance.now();
      try {
        await this.device.call("gateway.ping");
      } catch {
        return;
      }
      this.times.push(performance.now() - started);
      await sleep(gapMs);
    }
  }
}
