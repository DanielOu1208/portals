// The sessions that have a process running ("warm"), for an agent that runs one process
// per thread: Claude Code, and others on the same rule. A process costs memory and
// keeps MCP servers connected, so a session goes cold (its process exits; the next
// message resumes it) after `idleMinutes` with no turn running, no question open and no
// background work running, and at most `maxWarm` are kept: when one more warms up, the
// least recently used idle one goes cold first. A busy session is never cooled; when
// every warm session is busy the limit is passed for a while rather than cut work short.

export interface Warmable {
  /** A turn is running, a question is open, background work is running, or the process is starting. */
  readonly busy: boolean;
  /** Stops the process; the session stays usable and starts one again when needed. */
  cool(): Promise<void>;
}

export interface PoolOptions {
  maxWarm: number;
  idleMs: number;
  now?: () => number;
}

export class WarmPool {
  private readonly options: PoolOptions;
  private readonly now: () => number;
  /** Warm sessions and when each was last used; Map order is not used. */
  private readonly warm = new Map<Warmable, number>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(options: PoolOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.warm.size;
  }

  has(session: Warmable): boolean {
    return this.warm.has(session);
  }

  /** A session's process started. Cools the least recently used idle ones over the limit. */
  warmed(session: Warmable): void {
    this.warm.set(session, this.now());
    this.trim(session);
    this.schedule();
  }

  /** The session was used just now. */
  touch(session: Warmable): void {
    if (this.warm.has(session)) this.warm.set(session, this.now());
  }

  /** Its process is gone (cooled, crashed or closed). */
  cooled(session: Warmable): void {
    this.warm.delete(session);
    if (this.warm.size === 0) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Cools idle sessions past `idleMs`, and any over the warm limit. */
  sweep(now = this.now()): void {
    for (const [session, used] of [...this.warm.entries()]) {
      if (session.busy) {
        // Still in use: idle time counts from when it stops being busy.
        this.warm.set(session, now);
        continue;
      }
      if (now - used >= this.options.idleMs) {
        this.cooled(session);
        void session.cool();
      }
    }
    // Busy sessions may have passed the limit together; once idle, the excess goes.
    this.trim();
  }

  private trim(except?: Warmable): void {
    if (this.warm.size <= this.options.maxWarm) return;
    const idle = [...this.warm.entries()].filter(([session]) => session !== except && !session.busy).sort((a, b) => a[1] - b[1]);
    while (this.warm.size > this.options.maxWarm && idle.length > 0) {
      const [oldest] = idle.shift()!;
      this.cooled(oldest);
      void oldest.cool();
    }
  }

  /** Sweeps warm sessions every minute (or sooner for a short idle time) until `stop`. */
  start(): void {
    this.started = true;
    this.schedule();
  }

  private schedule(): void {
    // No process means nothing can expire, so an empty pool need not wake the bridge.
    if (!this.started || this.timer || this.warm.size === 0) return;
    this.timer = setInterval(() => this.sweep(), Math.min(60_000, Math.max(1000, this.options.idleMs / 4)));
    this.timer.unref();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
