import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// The lines a harness bridge's counters write (`counters.log`, src/counters.ts), read
// as they are appended, and summed between two edges: the harness waits for a line,
// does what it measures, waits for the next line, and adds up only the lines in between.

/** One line of the counters: sections of numbers. */
export type Line = Record<string, unknown>;

/** What a line says of the moment or of the process, not of what happened in its period: never summed. */
const notCounted = new Set(["v", "t", "s", "late", "up", "dropped", "tick_ms", "proc", "kids", "now"]);

/** What some lines counted, together. */
export interface Counted {
  /** How many lines. */
  lines: number;
  /** The seconds they cover. */
  seconds: number;
  /** What the counters' own ticks took in them, in milliseconds. */
  tickMs: number;
  /** The last line's `now`: how many of each thing there were at the end. */
  now: Record<string, number>;
  /** Everything else, added up; a field that is a longest or largest (`max`, `w_max`) keeps the largest. */
  sections: Record<string, unknown>;
}

export class Lines {
  private readonly path: string;
  private readonly pollMs: number;
  private readonly lines: Line[] = [];
  private offset = 0;
  private partial = "";

  constructor(path: string, pollMs = 20) {
    this.path = path;
    this.pollMs = pollMs;
  }

  /** Every line written so far. */
  all(): Line[] {
    this.read();
    return [...this.lines];
  }

  /**
   * Resolves once the bridge has written a line after this call, with how many lines
   * there are then. Whatever was counted before the call is in a line at or before that
   * one, and whatever is counted after it resolves is in a later one.
   */
  async edge(timeoutMs = 90_000): Promise<number> {
    this.read();
    const before = this.lines.length;
    const ends = Date.now() + timeoutMs;
    while (this.lines.length === before) {
      if (Date.now() > ends) throw new Error(`the counters wrote no line to ${this.path} in ${Math.round(timeoutMs / 1000)} s`);
      await sleep(this.pollMs);
      this.read();
    }
    return this.lines.length;
  }

  /** What the lines after edge `from`, up to edge `to`, counted. */
  between(from: number, to: number): Counted {
    return sum(this.lines.slice(from, to));
  }

  private read(): void {
    let file: number;
    try {
      file = openSync(this.path, "r");
    } catch {
      return; // Not written yet.
    }
    try {
      const size = fstatSync(file).size;
      if (size < this.offset) {
        // Rotated at its cap: the new file from its start.
        this.offset = 0;
        this.partial = "";
      }
      if (size === this.offset) return;
      const bytes = Buffer.alloc(size - this.offset);
      this.offset += readSync(file, bytes, 0, bytes.length, this.offset);
      this.partial += bytes.toString("utf8");
    } finally {
      closeSync(file);
    }
    const whole = this.partial.split("\n");
    this.partial = whole.pop() ?? "";
    for (const text of whole) {
      try {
        const line: unknown = JSON.parse(text);
        if (typeof line === "object" && line !== null) this.lines.push(line as Line);
      } catch {
        // Half a line after a write that failed: skipped, as the recipe in DEVELOPING.md's Counters section does.
      }
    }
  }
}

export function sum(lines: Line[]): Counted {
  const counted: Counted = { lines: lines.length, seconds: 0, tickMs: 0, now: {}, sections: {} };
  for (const line of lines) {
    counted.seconds += number(line.s);
    counted.tickMs += number(line.tick_ms);
    if (typeof line.now === "object" && line.now !== null) counted.now = line.now as Record<string, number>;
    for (const [key, value] of Object.entries(line)) {
      if (!notCounted.has(key)) merge(counted.sections, key, value);
    }
  }
  return counted;
}

function merge(into: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "number") {
    const before = number(into[key]);
    into[key] = key === "max" || key.endsWith("_max") ? Math.max(before, value) : before + value;
  } else if (typeof value === "object" && value !== null) {
    const inner = (into[key] ??= {}) as Record<string, unknown>;
    for (const [field, item] of Object.entries(value)) merge(inner, field, item);
  }
}

/**
 * One number of what was counted, by the keys that lead to it (a method's name has dots,
 * so the keys are given one by one): `pick(counted, "rpc", "threads.changes", "n")`.
 * 0 when nothing was counted there, or when the counters were off (`counted` null).
 */
export function pick(counted: Counted | null, ...keys: string[]): number {
  let at: unknown = counted?.sections;
  for (const key of keys) {
    if (typeof at !== "object" || at === null) return 0;
    at = (at as Record<string, unknown>)[key];
  }
  return number(at);
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
