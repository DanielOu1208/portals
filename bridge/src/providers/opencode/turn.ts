import { randomUUID } from "node:crypto";
import type { OpenCodeApi } from "./client.ts";
import type { OpenCodeEvent } from "./protocol.ts";
import { textPiece } from "./protocol.ts";
import type { AdmissionKind } from "./commands.ts";

export const recoveryBufferLimit = { frames: 1024, bytes: 1024 * 1024 };
const retryDelay = (failures: number): number => Math.min(100 * 2 ** Math.min(failures - 1, 6), 5000);

interface Turn {
  id: string | null;
  open: boolean;
  stopped: boolean;
  admitting: boolean;
  immediate: boolean;
  operation?: AdmissionKind;
  sent?: boolean;
  baseline: Set<string>;
  /** Stop ends what admission still waits for before it sends. */
  stopping: AbortController;
}

/** One owner for asynchronous admission, Stop, attachment and snapshot generations. */
export class OpenCodeTurn {
  private current: Turn | null = null;
  private generation = 0;
  private attached = false;
  private readonly held: OpenCodeEvent[] = [];
  private heldBytes = 0;
  private recovery: Promise<void> | undefined;
  private fullRequested = 0;
  private fullCompleted = 0;
  private readingFull = false;
  private retry: NodeJS.Timeout | undefined;
  private failures = 0;
  private withdrawalPause: { timer: NodeJS.Timeout; resolve(): void } | undefined;
  private readonly covered = new Set<string>();
  private readonly cancelled = new Set<string>();
  closed = false;

  get open(): boolean { return this.current?.open === true; }
  get message(): string | null { return this.current?.id ?? null; }
  set message(id: string | null) { if (this.current) this.current.id = id; }
  get catchingUp(): Promise<void> | undefined { return this.recovery; }
  get stoppingAdmission(): boolean { return this.current?.stopped === true && this.current.admitting; }
  get admitting(): boolean { return this.current?.admitting === true; }
  get admittingCommand(): boolean { return this.admitting && this.current?.operation === "command"; }
  get immediate(): boolean { return this.current?.immediate === true; }
  get hasHeld(): boolean { return this.held.length > 0; }
  private get boundary(): boolean { return this.fullRequested > this.fullCompleted; }
  abandoned(id: string): boolean { return this.cancelled.has(id); }

  begin(id: string | null = null): void {
    ++this.generation;
    this.current = { id, open: true, stopped: false, admitting: false, immediate: false, baseline: new Set(), stopping: new AbortController() };
    this.covered.clear();
  }

  end(): void {
    if (this.current) this.current.open = false;
    this.covered.clear();
  }

  stop(): void {
    if (this.current) {
      this.current.stopped = true;
      this.current.stopping.abort();
      if (this.current.id) this.cancelled.add(this.current.id);
    }
    ++this.generation; // Invalidates snapshots already in flight, not the admission's cleanup.
    this.cancelRecovery();
    this.wakeWithdrawal();
  }

  close(): void {
    this.closed = true;
    ++this.generation;
    this.cancelRecovery();
    this.wakeWithdrawal();
  }

  attach(): void { this.attached = true; }
  snapshotPiece(key: string): void { if (this.readingFull) this.covered.add(key); }
  covers(key: string): boolean { return this.covered.has(key); }
  endedPiece(key: string): void { this.covered.delete(key); }

  receive(event: OpenCodeEvent, live: (event: OpenCodeEvent) => void, recover: (boundary: boolean) => void): void {
    if (this.closed) return;
    const piece = textPiece(event);
    const ambiguous = piece?.phase === "delta" && this.covered.has(piece.key);
    const terminal = event.type.startsWith("session.execution.") && event.type !== "session.execution.started" && this.covered.size > 0;
    if (!this.attached || this.boundary || ambiguous || terminal) {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (this.held.length + 1 > recoveryBufferLimit.frames || this.heldBytes + bytes > recoveryBufferLimit.bytes) {
        this.dropFrames();
        // An in-flight read predates these dropped frames. Only a new full
        // snapshot can discharge this obligation, even if no frames remain.
        ++this.fullRequested;
      } else {
        this.held.push(event);
        this.heldBytes += bytes;
      }
      if (this.attached) recover(terminal);
    } else live(event);
  }

  /**
   * Native SSE has no durable cursor or text offsets. After a cut, deltas cannot
   * safely be appended to a REST prefix: a delayed frame may already be in it.
   * Use authoritative whole text only for pieces covered by a snapshot; new
   * pieces still stream normally. Each batch's
   * snapshot is requested AFTER its frames, never before their terminal event.
   */
  recover(read: (frames: OpenCodeEvent[], current: () => boolean, boundary: boolean) => Promise<void>, failed: (error: unknown, attempt: number) => void, boundary = true): void {
    if (this.closed || !this.attached) return;
    if (boundary) ++this.fullRequested;
    // Incoming traffic adds work, but never turns a failed read's backoff into
    // another immediate HTTP request. The timer itself starts the next attempt.
    if (this.recovery || this.retry) return;
    this.recovery = Promise.resolve().then(async () => {
      for (let pass = 0; pass < 3 && !this.closed; pass += 1) {
        const frames = this.held.splice(0);
        const bytes = this.heldBytes;
        this.heldBytes = 0;
        const generation = this.generation;
        const epoch = this.fullRequested;
        const full = this.boundary;
        const current = () => !this.closed && generation === this.generation && epoch === this.fullRequested;
        this.readingFull = full;
        try {
          await read(frames, current, full);
        } catch (error) {
          if (!this.closed && generation === this.generation) {
            this.retain(frames, bytes);
            ++this.fullRequested;
            failed(error, ++this.failures);
          }
          return;
        } finally { this.readingFull = false; }
        if (current()) {
          if (full) this.fullCompleted = epoch;
          this.failures = 0;
          // Frames arriving during a full read can describe a new execution that
          // was absent from that snapshot. Drain them with another full read.
          if (full && this.held.length > 0) ++this.fullRequested;
        } else if (!this.closed && generation === this.generation) this.retain(frames, bytes);
        if (!this.boundary && this.held.length === 0) break;
      }
    }).finally(() => {
      this.recovery = undefined;
      if (this.closed || !this.boundary && this.held.length === 0) return;
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.recover(read, failed, false);
      }, this.failures ? retryDelay(this.failures) : 0);
      this.retry.unref();
    });
  }

  /** Failed or superseded reads keep older metadata ahead of the next batch. */
  private retain(frames: OpenCodeEvent[], bytes: number): void {
    if (frames.length + this.held.length > recoveryBufferLimit.frames || bytes + this.heldBytes > recoveryBufferLimit.bytes) {
      this.dropFrames();
      ++this.fullRequested;
      return;
    }
    this.held.unshift(...frames);
    this.heldBytes += bytes;
  }

  private dropFrames(): void {
    this.held.length = 0;
    this.heldBytes = 0;
  }

  private cancelRecovery(): void {
    clearTimeout(this.retry);
    this.retry = undefined;
    this.fullCompleted = this.fullRequested;
    this.failures = 0;
    this.covered.clear();
    this.dropFrames();
  }

  /** A close before send prevents admission; Stop after send always retains its cleanup. */
  async admit(
    connect: () => Promise<OpenCodeApi>,
    send: (api: OpenCodeApi, id: string, current: (kind: AdmissionKind) => Promise<boolean>, signal: AbortSignal) => Promise<{ id: string } | undefined>,
    failed: (error: unknown) => void,
    immediate: () => void,
    stopped: () => void,
    blocked: (error: unknown, api: OpenCodeApi, attempt: number) => Promise<void>,
  ): Promise<void> {
    const turn = this.current!;
    const mine = () => !this.closed && this.current === turn && turn.open && !turn.stopped;
    const id = `msg_portals_turn_${randomUUID()}`;
    turn.admitting = true;
    let api: OpenCodeApi | undefined;
    let admitted: { id: string } | undefined;
    let failure: { error: unknown } | undefined;
    try {
      api = await connect();
      if (!mine()) return;
      admitted = await send(api, id, async (kind) => {
        if (kind === "command" && mine()) {
          turn.baseline = new Set((await api!.inbox(this.sessionID)).map((item) => item.id));
        }
        if (!mine()) return false;
        turn.operation = kind;
        turn.sent = true;
        if (kind === "prompt" || kind === "compact") turn.id = id;
        return true;
      }, turn.stopping.signal);
      if (admitted) turn.id = admitted.id;
    } catch (error) {
      failure = { error };
    } finally {
      // Command callbacks have no admission ID. Keep responsibility until the
      // callback settles and its real native work has been withdrawn/stopped.
      if (turn.sent && api && (this.closed || turn.stopped)) await this.withdraw(turn, api, blocked);
      turn.admitting = false;
      if (!this.closed && turn.stopped) stopped();
    }
    if (mine()) {
      if (failure) failed(failure.error);
      else if (!admitted) {
        turn.immediate = true;
        immediate();
      }
    }
  }

  private async withdraw(turn: Turn, api: OpenCodeApi, blocked: (error: unknown, api: OpenCodeApi, attempt: number) => Promise<void>): Promise<void> {
    let attempt = 0;
    do {
      ++attempt;
      try {
        // Callback commands expose no origin or admission ID. Even a sole new
        // input may belong to the desk: only prompt/compact IDs prove ownership.
        if (turn.operation !== "command" && turn.id) {
          this.cancelled.add(turn.id);
          await api.cancelInbox(this.sessionID, turn.id);
        }
        // Closing a view must not interrupt established native execution.
        if (this.closed) return;
        await api.interrupt(this.sessionID);
        if (turn.operation !== "command") return;
        const [active, waiting] = await Promise.all([api.active(), api.inbox(this.sessionID)]);
        if (!active.has(this.sessionID) && waiting.every((item) => turn.baseline.has(item.id))) return;
      } catch (error) {
        if (this.closed) return;
        await blocked(error, api, attempt);
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.withdrawalPause = undefined; resolve(); }, retryDelay(attempt));
        timer.unref();
        this.withdrawalPause = { timer, resolve };
      });
    } while (!this.closed);
  }

  private wakeWithdrawal(): void {
    if (this.withdrawalPause) {
      clearTimeout(this.withdrawalPause.timer);
      this.withdrawalPause.resolve();
      this.withdrawalPause = undefined;
    }
  }

  private readonly sessionID: string;
  constructor(sessionID: string) { this.sessionID = sessionID; }
}

export function isTurnEvent(event: OpenCodeEvent): boolean {
  return /^session\.(execution|text|reasoning|tool|step|compaction)\./.test(event.type);
}
