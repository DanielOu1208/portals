import { statfs } from "node:fs/promises";
import { log } from "./log.ts";

// How much room is left on the disk the bridge keeps its folder on (feature disk_space,
// docs/gateway-protocol.md section 11). A full disk stopped a host three times on
// 2026-10-27, and since the bridge stays up through it, nothing told the user: agents just
// failed, and history came back short. So the bridge reads the free space of that volume
// as it starts and every few minutes (one `statfs`, never per event), says it in
// `gateway.ready`'s `bridge` block and the `sessions.activity` answer for Settings, and
// below a low mark tells each thread at work, and each that starts a turn, once.
// A write that fails for want of space has the disk read again at once.

/** How full the disk is: `low` below the low mark, `critical` below the lower one. */
export type DiskLevel = "ok" | "low" | "critical";

/** The volume's free space and size in bytes, as of the last reading, and its level. */
export interface DiskReading {
  free: number;
  total: number;
  level: DiskLevel;
}

const gigabyte = 1_000_000_000;

/** How often the disk is read: every five minutes. */
export const readEveryMs = 5 * 60 * 1000;

/** The least time between two readings a failed write asks for. */
const soonestMs = 10_000;

/**
 * Low below 5 GB free, critical below 1 GB; on a volume smaller than 50 GB, below a tenth
 * and a fiftieth of it, so that a small disk is not always low.
 */
export function diskLevel(free: number, total: number): DiskLevel {
  if (free < Math.min(1 * gigabyte, total / 50)) return "critical";
  if (free < Math.min(5 * gigabyte, total / 10)) return "low";
  return "ok";
}

/** Space enough again to end a spell of low space: a fifth over the low mark, so a disk near it does not start one after another. */
function roomAgain(free: number, total: number): boolean {
  return free >= Math.min(5 * gigabyte, total / 10) * 1.2;
}

/** Whether `error` is a write refused for want of space: a full disk (`ENOSPC`) or a used-up quota (`EDQUOT`). */
export function outOfSpace(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
}

/** What `statfs` gives that is read: blocks free to an unprivileged process, all blocks, and the size of one. */
export type ReadVolume = (path: string) => Promise<{ bavail: number | bigint; blocks: number | bigint; bsize: number | bigint }>;

export interface DiskSpaceOptions {
  /** A folder on the volume to read: the bridge's own. */
  path: string;
  /** The name of the host, as threads are told it (`macName`, or the one the net goes by). */
  name: () => string;
  /** How often to read, in ms (tests). */
  everyMs?: number;
  /** Reads the volume (tests give a stand-in). */
  statfs?: ReadVolume;
  /** What devices are told changed: the level, or the free space by a few hundred megabytes. */
  changed?: () => void;
  /** A spell of low space began: the threads at work are told. */
  low?: () => void;
}

export class DiskSpace {
  private readonly options: DiskSpaceOptions;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private last: DiskReading | undefined;
  /** The reading devices were last told of (`changed`). */
  private told: DiskReading | undefined;
  /** The spells of low space since the bridge started; the one now while `inSpell`. */
  private spells = 0;
  private inSpell = false;
  /** The reading under way, if any (tests wait for it). */
  private reading: Promise<void> | undefined;
  /** When the disk was last read, for a failed write's reading (`soonestMs`). */
  private readAt = 0;

  constructor(options: DiskSpaceOptions) {
    this.options = options;
  }

  /** The volume's free space as last read; undefined before the first reading, or when it cannot be read. */
  get now(): DiskReading | undefined {
    return this.last;
  }

  /**
   * The spell of low space the disk is in, which each thread is told of once; undefined
   * while there is room. A spell lasts until there is room enough again (`roomAgain`), but
   * a thread starting a turn just over the low mark is not told.
   */
  get lowSpell(): number | undefined {
    return this.inSpell && this.last?.level !== "ok" ? this.spells : undefined;
  }

  /** The name of the host, as threads are told it. */
  get hostName(): string {
    return this.options.name();
  }

  /** Reads the disk now, and every few minutes after. */
  start(): void {
    void this.read();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The reading under way, if any. */
  get settled(): Promise<void> {
    return this.reading ?? Promise.resolve();
  }

  /**
   * Whether a write failed for want of space; then the disk is read again soon, so
   * Settings and the threads hear of it before the next reading was due.
   */
  outOfSpace(error: unknown): boolean {
    if (!outOfSpace(error)) return false;
    if (!this.stopped && !this.reading && Date.now() - this.readAt >= soonestMs) void this.read();
    return true;
  }

  /** Reads the disk now, and again a reading's time after (a failed write; tests). */
  read(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.readAt = Date.now();
    this.reading = (this.options.statfs ?? statfs)(this.options.path)
      .then(
        (volume) => this.take(Number(volume.bavail) * Number(volume.bsize), Number(volume.blocks) * Number(volume.bsize)),
        (error: Error) => log.debug("could not read the free space on the bridge's disk", { error: error.message }),
      )
      .finally(() => {
        this.reading = undefined;
        if (this.stopped) return;
        this.timer = setTimeout(() => void this.read(), this.options.everyMs ?? readEveryMs);
        this.timer.unref();
      });
    return this.reading;
  }

  private take(free: number, total: number): void {
    if (this.stopped || !Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return;
    const before = this.last;
    const reading: DiskReading = { free, total, level: diskLevel(free, total) };
    this.last = reading;
    if (reading.level !== before?.level) {
      if (reading.level === "ok") log.info("the bridge's disk has room again", { free });
      else log.warn(`the bridge's disk is ${reading.level === "low" ? "low on space" : "almost out of space"}`, { free });
    }
    const starts = reading.level !== "ok" && !this.inSpell;
    if (starts) {
      this.spells += 1;
      this.inSpell = true;
    } else if (this.inSpell && roomAgain(free, total)) {
      this.inSpell = false;
    }
    if (!this.told || reading.level !== this.told.level || Math.abs(reading.free - this.told.free) >= 250_000_000) {
      this.told = reading;
      this.options.changed?.();
    }
    if (starts) this.options.low?.();
  }
}

/** The disk as devices are told it, only once it has been read (feature disk_space). */
export function diskFields(reading: DiskReading | undefined): { disk?: DiskReading } {
  return reading ? { disk: { free: reading.free, total: reading.total, level: reading.level } } : {};
}
