import { log } from "../log.ts";

// The part of a JSON-RPC client that connects again, under Codex's (codex/client.ts)
// and Hermes's (hermes/client.ts): calls waiting for their answers, each with its timer;
// a connection made again after it drops, with growing pauses, each attempt a generation
// of its own whose frames and end count only while it is the newest; calls waiting for
// the connection, let in before the listeners hear it came up; every call failed when it
// drops or the client is closed; and one guard around every listener, whose log of a
// listener that keeps throwing is a stack and a count a minute. Each client keeps its
// connectors, its frames and ids, its handshake, its errors and their classes, and Hermes
// its ping.

/** One open connection. */
export interface RpcTransport<F> {
  send(frame: F): void;
  close(): void;
}

export interface RpcHandlers<F> {
  frame(frame: F): void;
  /** The connection is gone, for whatever reason. Called once. */
  closed(reason: string): void;
}

/** Why a call or a wait for the connection failed: each client makes its own error of it. */
export type RpcFailure = "not connected" | "timed out" | "dropped" | "closed" | "not reachable";

/** What every listener hears; each client's listener also hears its own. */
export interface RpcListener {
  disconnected(reason: string): void;
}

/** A connection whose handshake is done: what the listeners are told of it. */
export interface Connected<L> {
  /** Tells one listener the connection came up; `again` after a reconnect. */
  tell(listener: L, again: boolean): void;
  /** Once it is ready, before anyone is told. */
  ready?(): void;
}

export interface RpcOptions<F, L extends RpcListener, Id> {
  /** Who is at the other end, as the log and the errors name it. */
  name: string;
  /** Opens a connection; rejects when it cannot. */
  connect(handlers: RpcHandlers<F>): Promise<RpcTransport<F>>;
  /** Seconds between attempts after a drop; the last one repeats. */
  backoff?: number[];
  /** Milliseconds a call waits for its answer. */
  timeoutMs?: number;
  /** Milliseconds a wait for the connection lasts unless it is given its own. */
  readyMs: number;
  /** Before each attempt to connect, awaited when given. */
  prepare?: () => Promise<void> | undefined;
  /** The `n`th call (from 1) as it goes out, and the id its answer comes back with. */
  request(n: number, method: string, params: unknown): { id: Id; frame: F };
  /** Each frame of the newest connection. */
  receive(frame: F): void;
  /**
   * On the connection just opened, which `transport` now is: resolves once it takes
   * calls, rejects when it cannot. `generation` is the attempt's.
   */
  handshake(generation: number): Promise<Connected<L>>;
  /** The newest connection is gone, before the calls waiting fail. */
  dropped?(reason: string): void;
  /** The client is being closed, before the calls waiting fail. */
  closing?(): void;
  /** The error a call or a wait fails with, given its sentence. */
  error(why: RpcFailure, message: string): Error;
}

/** A call waiting for its answer. */
export interface Waiting {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

const defaultBackoff = [0.5, 1, 2, 4, 8, 10];

/** How long after a listener's throw at one kind of news its throws at that kind are only counted. */
const repeatsMs = 60_000;

/** A listener's throws at one kind of news in the minute after the one logged: how many, and the last one's message. */
interface Repeats {
  count: number;
  message: string;
}

export class RpcClient<F, L extends RpcListener, Id extends string | number> {
  private readonly options: RpcOptions<F, L, Id>;
  private readonly listeners = new Set<L>();
  private readonly waiting = new Map<Id, Waiting & { timer: NodeJS.Timeout }>();
  private current: RpcTransport<F> | null = null;
  private ready = false;
  private everConnected = false;
  private closed = false;
  private nextID = 1;
  /** The newest attempt's number. */
  private latest = 0;
  /** Attempts since the last that connected, for the pause before the next. */
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private readyWaiters: { resolve(): void; reject(error: Error): void }[] = [];
  private connecting: Promise<void> | null = null;
  /** By listener, and by what it threw at (`tell`'s words and fields): its throws counted since the one logged. */
  private readonly throwing = new WeakMap<L, Map<string, Repeats>>();
  /** The minutes still counting a listener's throws, each ending with the line of its count: ended at once by `close`. */
  private readonly counting = new Set<() => void>();

  constructor(options: RpcOptions<F, L, Id>) {
    this.options = options;
  }

  get isConnected(): boolean {
    return this.ready;
  }

  /** The newest connection, from the moment it opened until it is gone. */
  get transport(): RpcTransport<F> | null {
    return this.current;
  }

  /** The newest attempt's number: a connection's frames count only while it is the attempt's that opened it. */
  get generation(): number {
    return this.latest;
  }

  listen(listener: L): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Connects (once); on failure keeps trying in the background. Resolves after the first attempt either way. */
  start(): Promise<void> {
    this.connecting ??= this.connect().catch((error: Error) => {
      if (this.closed) return;
      log.warn(`could not reach ${this.options.name}`, { error: error.message });
      this.scheduleRetry();
    });
    return this.connecting;
  }

  /** Waits until the client is connected, at most `timeoutMs`. */
  whenReady(timeoutMs = this.options.readyMs): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.closed) return Promise.reject(this.failure("closed"));
    void this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((waiter) => waiter !== entry);
        reject(this.failure("not reachable"));
      }, timeoutMs);
      timer.unref();
      const entry = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.readyWaiters.push(entry);
    });
  }

  /** Calls a method once connected and waits for its result. */
  async call<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    await this.whenReady();
    return this.send<T>(method, params, timeoutMs);
  }

  /** Calls a method on the connection there is, connected or not (a handshake's, a ping). */
  send<T>(method: string, params: unknown, timeoutMs = this.options.timeoutMs ?? 60_000): Promise<T> {
    const transport = this.current;
    if (!transport) return Promise.reject(this.failure("not connected"));
    const { id, frame } = this.options.request(this.nextID++, method, params);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(this.failure("timed out", method));
      }, timeoutMs);
      timer.unref();
      this.waiting.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
      transport.send(frame);
    });
  }

  /** The call an answer with this id is for, no longer waiting; undefined when none waits for it. */
  answered(id: Id): Waiting | undefined {
    const waiting = this.waiting.get(id);
    if (!waiting) return undefined;
    this.waiting.delete(id);
    clearTimeout(waiting.timer);
    return waiting;
  }

  /**
   * Tells every listener: one that throws is logged and the others are told all the
   * same. Its throw would leave the socket's handler and end the bridge, or fail an
   * attempt to connect after it had succeeded, which would then be made again beside it.
   */
  tell(what: string, fields: Record<string, unknown>, call: (listener: L) => void): void {
    for (const listener of this.listeners) {
      try {
        call(listener);
      } catch (error) {
        this.threw(listener, what, fields, error);
      }
    }
  }

  /**
   * Logs a listener's throw at `what` with its stack, and its throws at the same kind of
   * news (the same words and fields: a method, an event's type) in the minute after only
   * as a count, in one line as the minute ends, or as the client closes; the next after
   * that is logged with its stack again. One that throws at every delta of a reply
   * streamed writes two lines a minute, not one a frame.
   */
  private threw(listener: L, what: string, fields: Record<string, unknown>, error: unknown): void {
    const message = (error as Error)?.message ?? String(error);
    let kinds = this.throwing.get(listener);
    if (!kinds) {
      kinds = new Map();
      this.throwing.set(listener, kinds);
    }
    const kind = `${what} ${JSON.stringify(fields)}`;
    const repeats = kinds.get(kind);
    if (repeats) {
      repeats.count += 1;
      repeats.message = message;
      return;
    }
    log.error(`could not take in ${what}`, { ...fields, error: (error as Error)?.stack ?? String(error) });
    const counted: Repeats = { count: 0, message };
    kinds.set(kind, counted);
    const end = (): void => {
      clearTimeout(timer);
      this.counting.delete(end);
      kinds.delete(kind);
      if (counted.count > 0) log.error(`could not take in ${what} again, ${counted.count} ${counted.count === 1 ? "time" : "times"} in the minute after`, { ...fields, error: counted.message });
    };
    const timer = setTimeout(end, repeatsMs);
    timer.unref();
    this.counting.add(end);
  }

  close(): void {
    this.closed = true;
    // Frames already on their way as the socket closes, and its close, count for nothing.
    this.latest += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.options.closing?.();
    this.failAll(new Error(`The connection to ${this.options.name} was closed.`));
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(this.failure("closed"));
    this.current?.close();
    this.current = null;
    this.ready = false;
    // What a minute has counted is written now, not after the client is gone.
    for (const end of [...this.counting]) end();
  }

  /** The newest connection is gone: every call waiting fails, and the client connects again. */
  dropped(reason: string): void {
    this.latest += 1;
    this.current = null;
    this.options.dropped?.(reason);
    const wasReady = this.ready;
    this.ready = false;
    this.failAll(this.failure("dropped"));
    if (this.closed) return;
    if (wasReady) {
      log.warn(`the connection to ${this.options.name} dropped`, { reason });
      this.tell(`that the connection to ${this.options.name} dropped`, {}, (listener) => listener.disconnected(reason));
    }
    this.scheduleRetry();
  }

  // MARK: Connecting

  private async connect(): Promise<void> {
    if (this.closed) return;
    if (this.options.prepare) await this.options.prepare();
    // Closed while it prepared: no connection after.
    if (this.closed) return;
    // Frames and drops count only for the newest connection, and none once closed.
    const generation = ++this.latest;
    const transport = await this.options.connect({
      frame: (frame) => {
        if (this.latest === generation && !this.closed) this.options.receive(frame);
      },
      closed: (reason) => {
        if (this.latest === generation && !this.closed) this.dropped(reason);
      },
    });
    if (this.closed || this.latest !== generation) {
      transport.close();
      return;
    }
    this.current = transport;
    let connected: Connected<L>;
    try {
      connected = await this.options.handshake(generation);
    } catch (error) {
      // It counts for nothing from now on, its close too: heard while the next attempt
      // prepares, that would make another attempt beside it.
      this.current = null;
      this.latest += 1;
      transport.close();
      throw error;
    }
    // Closed, or dropped, while the handshake was answered: nothing more to do.
    if (this.closed || this.latest !== generation) {
      transport.close();
      return;
    }
    const again = this.everConnected;
    this.everConnected = true;
    this.ready = true;
    this.attempt = 0;
    connected.ready?.();
    log.info(again ? `reconnected to ${this.options.name}` : `connected to ${this.options.name}`);
    for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
    this.tell(`that ${this.options.name} connected`, {}, (listener) => connected.tell(listener, again));
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    const backoff = this.options.backoff ?? defaultBackoff;
    const seconds = backoff[Math.min(this.attempt, backoff.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect().catch((error: Error) => {
        log.debug(`${this.options.name} is still not reachable`, { error: error.message });
        this.scheduleRetry();
      });
    }, seconds * 1000);
    this.retryTimer.unref();
  }

  private failAll(error: Error): void {
    for (const [id, waiting] of this.waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
      this.waiting.delete(id);
    }
  }

  /** The client's error for `why`, with the sentence both clients say. */
  private failure(why: RpcFailure, method?: string): Error {
    return this.options.error(why, sentences[why](this.options.name, method));
  }
}

const sentences: Record<RpcFailure, (name: string, method?: string) => string> = {
  "not connected": (name) => `${name} is not connected.`,
  "timed out": (name, method) => `${name} did not answer ${method} in time.`,
  dropped: (name) => `The connection to ${name} dropped before it answered.`,
  closed: (name) => `The connection to ${name} is closed.`,
  "not reachable": (name) => `${name} is not reachable right now.`,
};
