import { log } from "../../log.ts";
import { readJSON, writeJSON } from "../../store/jsonFile.ts";

// What the user typed for the messages Hermes stored in its place. A command Hermes makes
// a message of (`command.dispatch`: `/plan`, `/init`, a skill) goes to Hermes as that
// message, which is what Hermes stores, so the thread read back (after a restart of the
// bridge, or Hermes's copy taken after a reconnect) would show it in place of the
// command. Kept by thread and by the id of the row Hermes stored (`prompt.submit`'s
// `user_row_id`), in the bridge's state, for as long as Hermes still has that row: one
// its stored copy no longer has, read back, is let go of (`rowsGone`, `forget`), and one
// it has is marked so (`confirm`).

/**
 * At most this many of each thread's rows never read back (`confirm`) are kept, the latest:
 * a bound for a thread whose stored copy is never read, not a limit a thread reaches. A
 * row read back is kept until a read shows it gone, however many there are.
 */
const unreadPerThread = 5_000;

/** A row's id, what was typed for it, and whether Hermes's stored copy was read back with it. */
type Kept = [number, string] | [number, string, true];

/**
 * The rows of `rows` Hermes's stored copy no longer has, as `messages` (its whole
 * conversation, read back) shows it: none up to the newest row it has. A row past that was
 * stored after the read. A read with a user message that has no row id tells nothing: that
 * message may be one of them.
 */
export function rowsGone(rows: Iterable<number>, messages: readonly unknown[]): number[] {
  const read = new Set<number>();
  for (const message of messages) {
    const row = (message as { row_id?: unknown } | null)?.row_id;
    if (typeof row === "number" && Number.isInteger(row)) read.add(row);
    else if ((message as { role?: unknown } | null)?.role === "user") return [];
  }
  if (read.size === 0) return [];
  const newest = Math.max(...read);
  return [...rows].filter((row) => row <= newest && !read.has(row));
}

export class TypedCommands {
  private readonly path: string;
  /** By thread: the stored row's id and what the user typed, oldest first. Read once, when first asked. */
  private threads: Record<string, Kept[]> | null = null;

  constructor(path: string) {
    this.path = path;
  }

  /** The thread's, by the stored row's id. */
  of(thread: string): Map<number, string> {
    return new Map((this.read()[thread] ?? []).map(([row, text]) => [row, text]));
  }

  /** Keeps `text` as what the user typed for the thread's stored row `row`. */
  keep(thread: string, row: number, text: string): void {
    const threads = this.read();
    const kept: Kept[] = [...(threads[thread] ?? []).filter(([id]) => id !== row), [row, text]];
    // Past the bound, the oldest never read back go: not one read back, nor this one.
    let over = kept.filter((entry) => entry.length === 2).length - unreadPerThread;
    threads[thread] = over <= 0 ? kept : kept.filter((entry) => !(entry.length === 2 && entry[0] !== row && over-- > 0));
    this.write();
  }

  /** Marks the thread's stored rows `rows` as read back: Hermes's stored copy has them. */
  confirm(thread: string, rows: readonly number[]): void {
    const kept = this.read()[thread];
    if (!kept) return;
    const read = new Set(rows);
    let changed = false;
    for (const [at, entry] of kept.entries()) {
      if (entry.length === 2 && read.has(entry[0])) {
        kept[at] = [entry[0], entry[1], true];
        changed = true;
      }
    }
    if (changed) this.write();
  }

  /** Lets go of what was typed for the thread's stored rows `rows`, which Hermes no longer has (`rowsGone`). */
  forget(thread: string, rows: readonly number[]): void {
    const threads = this.read();
    const kept = threads[thread];
    if (!kept) return;
    const gone = new Set(rows);
    const left = kept.filter(([id]) => !gone.has(id));
    if (left.length === kept.length) return;
    if (left.length === 0) delete threads[thread];
    else threads[thread] = left;
    this.write();
  }

  private write(): void {
    try {
      writeJSON(this.path, { threads: this.read() });
    } catch (error) {
      log.warn("could not keep what was typed for a Hermes command", { error: (error as Error).message });
    }
  }

  private read(): Record<string, Kept[]> {
    if (this.threads) return this.threads;
    const found = readJSON<{ threads?: unknown }>(this.path, {})?.threads;
    const threads: Record<string, Kept[]> = {};
    if (typeof found === "object" && found !== null && !Array.isArray(found)) {
      for (const [thread, rows] of Object.entries(found)) {
        if (!Array.isArray(rows)) continue;
        threads[thread] = rows
          .filter((row): row is unknown[] => Array.isArray(row) && Number.isInteger(row[0]) && typeof row[1] === "string")
          .map((row): Kept => (row[2] === true ? [row[0] as number, row[1] as string, true] : [row[0] as number, row[1] as string]));
      }
    }
    this.threads = threads;
    return threads;
  }
}
