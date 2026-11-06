import { join } from "node:path";
import { log } from "../log.ts";
import { readBackedUp, writeBytes } from "../store/jsonFile.ts";
import type { Cursor, ScanMessage } from "./scanner.ts";
import type { ReadRequest } from "./readers/common.ts";
import type { DayRow, HourRow, TokenCounts, UsageAgent, UsageVia } from "./types.ts";

// The counted usage (docs/plans/2026-11-06-token-analytics.md): daily totals by agent,
// model, folder and via (`DayRow`), and each day's tokens by hour (`HourRow`), on the
// host's own days. With them, every history file's cursor and what it gave, so a file
// read again from the start replaces what it gave before; when a file is gone, its record
// is let go of a while later and what it gave stays in the totals, which only grow.
//
// All in one file, `state/usage/usage.json`, so the cursors and the totals they led to
// are saved together and always agree: a stop between two saves reads again what the
// last save had not counted. Written whole, in one step (jsonFile.ts), with the one before
// kept as `.bak`; by the book, rarely (book.ts), never once a request.

/** A day's counts in a file's record: day, model, folder, via, then the seven counts. */
type FileRow = [day: string, model: string, folder: string, via: UsageVia, input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number, reasoning: number, requests: number];
/** An hour's tokens in a file's record: day, via, hour, tokens. */
type FileHour = [day: string, via: UsageVia, hour: number, tokens: number];

interface FileRecord {
  cursor: Cursor;
  rows: Map<string, FileRow>;
  hours: Map<string, FileHour>;
}

/** The file as saved. */
interface Saved {
  v: 1;
  timeZone: string;
  scannedAt?: number;
  days: [day: string, agent: UsageAgent, model: string, folder: string, via: UsageVia, ...counts: number[]][];
  hours: [day: string, agent: UsageAgent, via: UsageVia, tokens: number[]][];
  files: Record<string, [cursor: Cursor, rows: FileRow[], hours: FileHour[]]>;
}

const countKeys = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "requests"] as const;

/** The tokens of a request on the hour chart: every type once, the reasoning already in the output. */
export function hourTokens(counts: Pick<TokenCounts, "input" | "output" | "cacheRead" | "cacheWrite">): number {
  return counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
}

/** The host's time zone, as the system says. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The day ("YYYY-MM-DD") and hour (0 to 23) of a moment in a time zone. Remembered by
 * quarter hour: every time zone's offset is a whole number of quarter hours, so all of a
 * quarter hour is on one day and in one hour, and a scan of a year of history asks the
 * calendar a few thousand times, not once a request.
 */
export class Calendar {
  readonly timeZone: string;
  private readonly format: Intl.DateTimeFormat;
  private readonly known = new Map<number, [string, number]>();

  constructor(timeZone: string) {
    let format: Intl.DateTimeFormat;
    try {
      format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    } catch {
      // An unknown zone: the system's own.
      timeZone = systemTimeZone();
      format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    }
    this.timeZone = timeZone;
    this.format = format;
  }

  at(time: number): [day: string, hour: number] {
    const quarter = Math.floor(time / 900_000);
    const known = this.known.get(quarter);
    if (known) return known;
    let year = "", month = "", day = "", hour = 0;
    for (const part of this.format.formatToParts(quarter * 900_000)) {
      if (part.type === "year") year = part.value;
      else if (part.type === "month") month = part.value;
      else if (part.type === "day") day = part.value;
      else if (part.type === "hour") hour = Number(part.value) % 24;
    }
    const found: [string, number] = [`${year}-${month}-${day}`, hour];
    if (this.known.size > 50_000) this.known.clear();
    this.known.set(quarter, found);
    return found;
  }
}

export interface UsageStoreOptions {
  /** The host's time zone; the system's when not given. Days already counted keep the zone they were counted in. */
  timeZone?: string;
}

export class UsageStore {
  /** `state/usage/usage.json`. */
  readonly path: string;
  readonly calendar: Calendar;
  /** When the last scan ended (milliseconds). */
  scannedAt: number | undefined;
  /** Something changed since the last save. */
  dirty = false;
  private readonly days = new Map<string, DayRow>();
  private readonly hourRows = new Map<string, HourRow>();
  private readonly files = new Map<string, FileRecord>();
  /** A saved file that could not be used is kept aside under this name at the next save. */
  private aside: string | undefined;

  /** `folder`: `state/usage`. */
  constructor(folder: string, options: UsageStoreOptions = {}) {
    this.path = join(folder, "usage.json");
    this.calendar = new Calendar(options.timeZone ?? systemTimeZone());
  }

  /** Reads what was saved; an unusable file costs only itself (its `.bak` is read in its place, else nothing). */
  load(): void {
    const { found, aside } = readBackedUp(this.path);
    this.aside = aside;
    if (!found) return;
    try {
      this.restore(found as unknown as Saved);
    } catch (error) {
      log.warn("usage: the saved totals could not be read; history is read again", { why: (error as Error).message });
      this.days.clear();
      this.hourRows.clear();
      this.files.clear();
      this.scannedAt = undefined;
    }
  }

  /** Whether nothing was ever counted: the next scan is the first read of everything. */
  get empty(): boolean {
    return this.files.size === 0;
  }

  /** The cursors, for the scanner. */
  cursors(): Record<string, Cursor> {
    const cursors: Record<string, Cursor> = {};
    for (const [path, record] of this.files) cursors[path] = record.cursor;
    return cursors;
  }

  /** Adds what a scan tells. `via` decides, for each request, whether it went through Portals. */
  apply(message: ScanMessage, via: (request: ReadRequest) => UsageVia): void {
    switch (message.type) {
      case "file": {
        let record = this.files.get(message.path);
        if (record && message.replace) this.subtract(record);
        for (const path of message.takeover) {
          const gone = this.files.get(path);
          if (!gone) continue;
          this.subtract(gone);
          this.files.delete(path);
        }
        if (!record || message.replace) {
          record = { cursor: message.cursor, rows: new Map(), hours: new Map() };
          this.files.set(message.path, record);
        }
        record.cursor = message.cursor;
        for (const request of message.requests) this.add(record, request, via(request));
        this.dirty = true;
        return;
      }
      case "moved": {
        const record = this.files.get(message.from);
        this.files.delete(message.from);
        if (record) this.files.set(message.to, { ...record, cursor: message.cursor });
        this.dirty = true;
        return;
      }
      case "gone": {
        const record = this.files.get(message.path);
        if (record) record.cursor = message.cursor;
        this.dirty = true;
        return;
      }
      case "forget":
        this.dirty = this.files.delete(message.path) || this.dirty;
        return;
      default:
        return;
    }
  }

  /** Day rows from `from` to `to` ("YYYY-MM-DD", inclusive), by day. */
  dayRows(from: string, to: string): DayRow[] {
    const rows: DayRow[] = [];
    for (const row of this.days.values()) if (row.day >= from && row.day <= to) rows.push({ ...row });
    return rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }

  hourRowsBetween(from: string, to: string): HourRow[] {
    const rows: HourRow[] = [];
    for (const row of this.hourRows.values()) if (row.day >= from && row.day <= to) rows.push({ ...row, tokens: [...row.tokens] });
    return rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }

  /** Writes everything, in one step. */
  save(): void {
    const saved: Saved = { v: 1, timeZone: this.calendar.timeZone, days: [], hours: [], files: {} };
    if (this.scannedAt !== undefined) saved.scannedAt = this.scannedAt;
    for (const row of this.days.values()) saved.days.push([row.day, row.agent, row.model, row.folder, row.via, ...countKeys.map((key) => row[key])]);
    for (const row of this.hourRows.values()) saved.hours.push([row.day, row.agent, row.via, row.tokens]);
    for (const [path, record] of this.files) saved.files[path] = [record.cursor, [...record.rows.values()], [...record.hours.values()]];
    // Without spaces: most of it is numbers in rows, which an indented file would put one to a line.
    writeBytes(this.path, () => Buffer.from(JSON.stringify(saved)), this.aside === undefined ? { backup: true } : { aside: this.aside });
    this.aside = undefined;
    this.dirty = false;
  }

  private restore(saved: Saved): void {
    if (saved.v !== 1) throw new Error(`version ${String(saved.v)}`);
    if (typeof saved.scannedAt === "number") this.scannedAt = saved.scannedAt;
    for (const entry of saved.days ?? []) {
      const [day, agent, model, folder, via, ...counts] = entry;
      const row: DayRow = { day, agent, model, folder, via, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, requests: 0 };
      countKeys.forEach((key, index) => (row[key] = Number(counts[index]) || 0));
      this.days.set(dayKey(day, agent, model, folder, via), row);
    }
    for (const [day, agent, via, tokens] of saved.hours ?? []) {
      if (!Array.isArray(tokens) || tokens.length !== 24) continue;
      this.hourRows.set(hourKey(day, agent, via), { day, agent, via, tokens: tokens.map((value) => Number(value) || 0) });
    }
    for (const [path, entry] of Object.entries(saved.files ?? {})) {
      if (!Array.isArray(entry)) continue;
      const [cursor, rows, hours] = entry;
      if (!cursor || typeof cursor.id !== "number") continue;
      const record: FileRecord = { cursor, rows: new Map(), hours: new Map() };
      for (const row of rows ?? []) record.rows.set(`${row[0]}\t${row[1]}\t${row[2]}\t${row[3]}`, row);
      for (const hour of hours ?? []) record.hours.set(`${hour[0]}\t${hour[1]}\t${hour[2]}`, hour);
      this.files.set(path, record);
    }
  }

  private add(record: FileRecord, request: ReadRequest, via: UsageVia): void {
    const [day, hour] = this.calendar.at(request.at);
    const agent = record.cursor.agent;
    const fileKey = `${day}\t${request.model}\t${request.folder}\t${via}`;
    let fileRow = record.rows.get(fileKey);
    if (!fileRow) {
      fileRow = [day, request.model, request.folder, via, 0, 0, 0, 0, 0, 0, 0];
      record.rows.set(fileKey, fileRow);
    }
    countKeys.forEach((key, index) => ((fileRow as number[])[4 + index] += request[key]));
    const tokens = hourTokens(request);
    if (tokens !== 0) {
      const hourKeyInFile = `${day}\t${via}\t${hour}`;
      const fileHour = record.hours.get(hourKeyInFile);
      if (fileHour) fileHour[3] += tokens;
      else record.hours.set(hourKeyInFile, [day, via, hour, tokens]);
    }
    this.change(day, agent, request.model, request.folder, via, (row) => countKeys.forEach((key) => (row[key] += request[key])));
    if (tokens !== 0) this.changeHour(day, agent, via, hour, tokens);
  }

  /** Takes what a file gave out of the totals. */
  private subtract(record: FileRecord): void {
    const agent = record.cursor.agent;
    for (const [day, model, folder, via, ...counts] of record.rows.values()) {
      this.change(day, agent, model, folder, via, (row) => countKeys.forEach((key, index) => (row[key] -= counts[index])));
    }
    for (const [day, via, hour, tokens] of record.hours.values()) this.changeHour(day, agent, via, hour, -tokens);
    record.rows.clear();
    record.hours.clear();
  }

  private change(day: string, agent: UsageAgent, model: string, folder: string, via: UsageVia, how: (row: DayRow) => void): void {
    const key = dayKey(day, agent, model, folder, via);
    let row = this.days.get(key);
    if (!row) {
      row = { day, agent, model, folder, via, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, requests: 0 };
      this.days.set(key, row);
    }
    how(row);
    if (countKeys.every((name) => row[name] <= 0)) this.days.delete(key);
  }

  private changeHour(day: string, agent: UsageAgent, via: UsageVia, hour: number, tokens: number): void {
    const key = hourKey(day, agent, via);
    let row = this.hourRows.get(key);
    if (!row) {
      row = { day, agent, via, tokens: new Array<number>(24).fill(0) };
      this.hourRows.set(key, row);
    }
    row.tokens[hour] += tokens;
    if (row.tokens.every((value) => value <= 0)) this.hourRows.delete(key);
  }
}

function dayKey(day: string, agent: UsageAgent, model: string, folder: string, via: UsageVia): string {
  return `${day}\t${agent}\t${model}\t${folder}\t${via}`;
}

function hourKey(day: string, agent: UsageAgent, via: UsageVia): string {
  return `${day}\t${agent}\t${via}`;
}
