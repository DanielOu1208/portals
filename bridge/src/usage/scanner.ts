import { closeSync, createReadStream, openSync, readdirSync, readSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import type { UsageAgent } from "./types.ts";
import { claudeSources } from "./readers/claude.ts";
import { codexSources } from "./readers/codex.ts";
import type { FileKind, FileParser, ReadContext, ReadRequest, Source, SourceOptions } from "./readers/common.ts";
import { droidSources } from "./readers/droid.ts";
import { piSources } from "./readers/pi.ts";

// Reading the agents' history a little at a time (docs/plans/2026-11-06-token-analytics.md).
// Every file read is remembered by its cursor: its size, inode, time and how far it was
// read. A scan with nothing new costs a stat a file. A file that grew is read from where
// the last read stopped, up to its last newline (an agent writing a line has written only
// part of it); one that shrank or is another file under the same name (another inode) is
// read again from the start, and what it gave before is replaced, not added to. A file
// that is gone keeps what it gave: agents delete old transcripts, and the totals only grow.
//
// Runs in a worker thread (scanWorker.ts), so the host's loop never waits on it, or in
// the host's own for tests. It keeps no totals: it tells its owner each file's new
// requests and cursor (`ScanMessage`), and the owner (book.ts, store.ts) adds them up and
// saves both together, so a stop at any moment leaves cursors and totals that agree.
//
// Memory stays small whatever the history weighs: files are read in pieces, lines that
// cannot hold usage are passed over by a text search without being made into strings,
// and a line longer than `longestLine` is passed over too.

/** How far a file was read, and what its reader needs to go on from there. */
export interface Cursor {
  /** A number for the file, for the keys and sessions it claims. */
  id: number;
  agent: UsageAgent;
  kind: FileKind;
  dev: number;
  ino: number;
  size: number;
  mtime: number;
  /** Bytes read, up to the last newline; a snapshot's or total's whole size. */
  offset: number;
  /** The reader's own (FileParser.save). */
  state?: unknown;
  /** The request keys it claimed (readers/common.ts `digest`), 8 characters each, one after another. */
  keys?: string;
  /** The session it claimed, if its reader claims one. */
  session?: string;
  /** Another file reads its session. */
  duplicate?: boolean;
  /** When it was found gone (milliseconds); kept a while so a copy of it elsewhere still counts once. */
  gone?: number;
  /** The size it could not be read at: tried again once it changes. */
  failed?: number;
}

/** What a scan tells its owner, in order. */
export type ScanMessage =
  /** A file read: its new requests and cursor. `replace`: what it gave before is replaced. `takeover`: gone files whose session it now reads, whose counts it replaces. */
  | { type: "file"; path: string; cursor: Cursor; requests: ReadRequest[]; replace: boolean; takeover: string[] }
  /** A file under another name (same inode): its cursor and counts go with it. */
  | { type: "moved"; from: string; to: string; cursor: Cursor }
  /** A file no longer there: what it gave stays counted. */
  | { type: "gone"; path: string; cursor: Cursor }
  /** A file gone long enough to be let go of: its record goes, its counts stay. */
  | { type: "forget"; path: string }
  /** A file about to be read: should the worker end while reading it, its owner tells the next one to leave it (`ScannerOptions.avoid`). */
  | { type: "reading"; path: string; size: number }
  /** Bytes read so far of the bytes this scan reads. */
  | { type: "progress"; done: number; total: number }
  | { type: "done"; files: number; read: number; bytes: number; ms: number }
  | { type: "log"; level: "warn" | "error"; message: string; fields?: Record<string, unknown> };

export interface ScannerOptions extends SourceOptions {
  now?: () => number;
  /** The cursors kept from before. */
  cursors?: Record<string, Cursor>;
  /** Where to read; every agent's by default. */
  sources?: Source[];
  /** Files not to read at these sizes: a worker ended while reading them. */
  avoid?: Record<string, number>;
}

/** How long a gone file's record is kept. */
export const goneKept = 30 * 24 * 60 * 60_000;
/** Bytes read at once from a file. */
const pieceBytes = 256 * 1024;
/**
 * Lines longer than this are passed over: the longest usage line of a year of one Mac's
 * history was 2 MB, and a line many times that, parsed, could cost the worker its memory
 * (its heap is 48 MB: book.ts).
 */
export const longestLine = 8 * 1024 * 1024;
/** The largest total file read (Droid's settings are a few KB). */
const largestTotal = 4 * 1024 * 1024;
/** How deep under a source's folder files are looked for. */
const deepest = 8;
/** How often progress is told, at most. */
const progressMs = 250;

/** Every agent's history this version reads. */
export function allSources(options: SourceOptions): Source[] {
  return [...claudeSources(options), ...codexSources(options), ...piSources(options), ...droidSources(options)];
}

/** The agents `allSources` reads, for the wire's `agents`. */
export const readAgents: UsageAgent[] = ["claude", "codex", "pi", "droid"];

interface Found {
  path: string;
  source: Source;
  stat: Stats;
}

export class Scanner {
  private readonly sources: Source[];
  private readonly now: () => number;
  private readonly cursors = new Map<string, Cursor>();
  private readonly paths = new Map<number, string>();
  /** Request key digest → the id of the file that claimed it. */
  private readonly keys = new Map<string, number>();
  /** "<agent>:<session>" → the id of the file that reads it. */
  private readonly sessions = new Map<string, number>();
  private nextId = 1;
  private readonly avoid: Map<string, number>;

  constructor(options: ScannerOptions) {
    this.sources = options.sources ?? allSources(options);
    this.avoid = new Map(Object.entries(options.avoid ?? {}));
    this.now = options.now ?? Date.now;
    for (const [path, cursor] of Object.entries(options.cursors ?? {})) this.adopt(path, cursor);
  }

  /** Reads what is new, telling `post` as it goes. Never throws: a file that cannot be read is told as a log line. */
  async scan(post: (message: ScanMessage) => void): Promise<void> {
    const started = this.now();
    const clock = performance.now();
    this.forgetOld(started, post);
    const found = this.list(post);
    const seen = new Set(found.map((one) => one.path));
    const forced = this.missing(found, seen, started, post);
    const work: { found: Found; from: number; replace: boolean }[] = [];
    let total = 0;
    for (const one of found) {
      const plan = this.plan(one, forced.has(one.path));
      if (!plan) continue;
      work.push({ found: one, ...plan });
      total += Math.max(0, one.stat.size - plan.from);
    }
    let done = 0;
    let told = 0;
    for (const item of work) {
      if (this.avoid.get(item.found.path) === item.found.stat.size) continue;
      post({ type: "reading", path: item.found.path, size: item.found.stat.size });
      try {
        await this.read(item.found, item.from, item.replace, post);
      } catch (error) {
        post({ type: "log", level: "warn", message: "usage: a history file could not be read; it is tried again when it changes", fields: { agent: item.found.source.agent, why: (error as Error).message } });
      }
      done += Math.max(0, item.found.stat.size - item.from);
      if (performance.now() - told >= progressMs) {
        told = performance.now();
        post({ type: "progress", done, total });
      }
    }
    post({ type: "progress", done: total, total });
    post({ type: "done", files: found.length, read: work.length, bytes: total, ms: Math.round(performance.now() - clock) });
  }

  /** The cursors as they are now, for a test or a restarted worker's owner. */
  snapshot(): Record<string, Cursor> {
    return Object.fromEntries(this.cursors);
  }

  private adopt(path: string, cursor: Cursor): void {
    if (!cursor || typeof cursor.id !== "number") return;
    this.cursors.set(path, cursor);
    this.paths.set(cursor.id, path);
    this.nextId = Math.max(this.nextId, cursor.id + 1);
    for (let index = 0; index + 8 <= (cursor.keys?.length ?? 0); index += 8) this.keys.set(cursor.keys!.slice(index, index + 8), cursor.id);
    if (cursor.session !== undefined && !cursor.duplicate) this.sessions.set(`${cursor.agent}:${cursor.session}`, cursor.id);
  }

  /** Lets go of a file's record: its keys and session are free to be claimed. */
  private drop(path: string): void {
    const cursor = this.cursors.get(path);
    if (!cursor) return;
    this.cursors.delete(path);
    this.paths.delete(cursor.id);
    for (let index = 0; index + 8 <= (cursor.keys?.length ?? 0); index += 8) {
      const key = cursor.keys!.slice(index, index + 8);
      if (this.keys.get(key) === cursor.id) this.keys.delete(key);
    }
    const session = `${cursor.agent}:${cursor.session}`;
    if (cursor.session !== undefined && this.sessions.get(session) === cursor.id) this.sessions.delete(session);
  }

  private forgetOld(now: number, post: (message: ScanMessage) => void): void {
    for (const [path, cursor] of [...this.cursors]) {
      if (cursor.gone === undefined || now - cursor.gone < goneKept) continue;
      this.drop(path);
      post({ type: "forget", path });
    }
  }

  /** Every file the sources hold, with its stat. */
  private list(post: (message: ScanMessage) => void): Found[] {
    const found: Found[] = [];
    for (const source of this.sources) {
      const walk = (folder: string, depth: number) => {
        let entries;
        try {
          entries = readdirSync(folder, { withFileTypes: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") post({ type: "log", level: "warn", message: "usage: a history folder could not be listed", fields: { agent: source.agent, why: code } });
          return;
        }
        for (const entry of entries) {
          const path = join(folder, entry.name);
          if (entry.isDirectory()) {
            if (depth < deepest) walk(path, depth + 1);
          } else if (entry.isFile() && source.accepts(path, entry.name)) {
            try {
              found.push({ path, source, stat: statSync(path) });
            } catch {
              // Gone between the listing and the stat: the next scan sees it gone.
            }
          }
        }
      };
      walk(source.root, 0);
    }
    return found;
  }

  /**
   * Cursors whose file is not where it was: under another name (the same inode, as when
   * Codex archives a session) the cursor goes with it; otherwise the file is gone, and a
   * copy of its session that waited as a duplicate is to be read whole now (the paths
   * this returns).
   */
  private missing(found: Found[], seen: Set<string>, now: number, post: (message: ScanMessage) => void): Set<string> {
    const forced = new Set<string>();
    const unknown = new Map<string, Found>();
    for (const one of found) if (!this.cursors.has(one.path)) unknown.set(`${one.stat.dev}:${one.stat.ino}`, one);
    for (const [path, cursor] of [...this.cursors]) {
      if (seen.has(path) || cursor.gone !== undefined) continue;
      const moved = unknown.get(`${cursor.dev}:${cursor.ino}`);
      if (moved && moved.source.agent === cursor.agent && moved.stat.size >= cursor.offset) {
        unknown.delete(`${cursor.dev}:${cursor.ino}`);
        this.cursors.delete(path);
        this.cursors.set(moved.path, cursor);
        this.paths.set(cursor.id, moved.path);
        post({ type: "moved", from: path, to: moved.path, cursor: { ...cursor } });
        continue;
      }
      cursor.gone = now;
      post({ type: "gone", path, cursor: { ...cursor } });
      if (cursor.session === undefined || cursor.duplicate) continue;
      for (const [other, copy] of this.cursors) {
        if (copy.duplicate && copy.agent === cursor.agent && copy.session === cursor.session && copy.gone === undefined) forced.add(other);
      }
    }
    return forced;
  }

  /** Where to read a file from, and whether what it gave is replaced; undefined when nothing is new. */
  private plan(one: Found, forced: boolean): { from: number; replace: boolean } | undefined {
    const cursor = this.cursors.get(one.path);
    const { size, mtimeMs, ino } = one.stat;
    if (!cursor) return { from: 0, replace: false };
    if (cursor.gone !== undefined) {
      // Back where it was: read again from the start, in place of what it gave.
      return { from: 0, replace: true };
    }
    if (forced) return { from: 0, replace: true };
    const changed = size !== cursor.size || mtimeMs !== cursor.mtime || ino !== cursor.ino;
    if (!changed) return undefined;
    if (cursor.failed === size) return undefined;
    if (cursor.kind === "append") {
      if (ino !== cursor.ino || size < cursor.offset) return { from: 0, replace: true };
      if (size === cursor.offset) {
        cursor.mtime = mtimeMs;
        return undefined;
      }
      return { from: cursor.offset, replace: false };
    }
    return { from: 0, replace: cursor.kind === "snapshot" };
  }

  private async read(one: Found, from: number, replace: boolean, post: (message: ScanMessage) => void): Promise<void> {
    const { path, source, stat } = one;
    const kind = source.kind(path);
    const before = this.cursors.get(path);
    const id = before?.id ?? this.nextId++;
    // Read again from the start: the keys it claimed before are its own still, and are
    // let go of only when this read did not claim them again.
    const formerKeys = replace && before?.keys ? before.keys : "";
    const former = new Set<string>();
    for (let index = 0; index + 8 <= formerKeys.length; index += 8) former.add(formerKeys.slice(index, index + 8));
    const formerAll = new Set(former);
    const claimed: string[] = [];
    const requests: ReadRequest[] = [];
    const takeover: string[] = [];
    let session = before?.session;
    let duplicate = replace ? false : before?.duplicate ?? false;
    const keys = this.keys;
    const context: ReadContext = {
      emit: (request) => requests.push(request),
      claim: (key) => {
        const owner = keys.get(key);
        if (owner === undefined || (owner === id && former.has(key))) {
          if (owner === undefined) keys.set(key, id);
          former.delete(key);
          claimed.push(key);
          return "new";
        }
        return owner === id ? "mine" : "other";
      },
      session: (claim) => {
        const name = `${source.agent}:${claim}`;
        const owner = this.sessions.get(name);
        session = claim;
        if (owner === undefined || owner === id) {
          this.sessions.set(name, id);
          duplicate = false;
          return "own";
        }
        const ownerPath = this.paths.get(owner);
        const ownerCursor = ownerPath === undefined ? undefined : this.cursors.get(ownerPath);
        if (ownerPath === undefined || !ownerCursor || ownerCursor.gone !== undefined) {
          // Its file is gone: this one reads the session now, in place of what that one gave.
          if (ownerPath !== undefined && !takeover.includes(ownerPath)) takeover.push(ownerPath);
          this.sessions.set(name, id);
          duplicate = false;
          return "own";
        }
        duplicate = true;
        return "duplicate";
      },
    };
    const sessionsBefore = new Map(this.sessions);
    const parser = source.parser(path, replace ? undefined : before?.state, context);
    let offset = stat.size;
    try {
      if (kind === "append") offset = from + readLines(path, from, stat.size, source.needles, parser);
      else if (kind === "snapshot") await readSnapshot(path, source.needles, parser);
      else readTotal(path, stat, parser);
    } catch (error) {
      // Nothing of this read stays: what it claimed is let go of, and the file is tried
      // again once it changes.
      for (const key of claimed) if (keys.get(key) === id && !formerAll.has(key)) keys.delete(key);
      this.sessions.clear();
      for (const [name, owner] of sessionsBefore) this.sessions.set(name, owner);
      const failed: Cursor = before ? { ...before, failed: stat.size } : { id, agent: source.agent, kind, dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, offset: 0, failed: stat.size };
      this.cursors.set(path, failed);
      this.paths.set(id, path);
      post({ type: "file", path, cursor: { ...failed }, requests: [], replace: false, takeover: [] });
      throw error;
    }
    // Done: what was claimed and given away happens now, and not before, so a read that
    // fails changes nothing.
    for (const key of former) if (keys.get(key) === id) keys.delete(key);
    for (const gone of takeover) this.drop(gone);
    const keptKeys = replace ? claimed.join("") : (before?.keys ?? "") + claimed.join("");
    const cursor: Cursor = { id, agent: source.agent, kind, dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, offset };
    const state = parser.save();
    if (state !== undefined) cursor.state = state;
    if (keptKeys) cursor.keys = keptKeys;
    if (session !== undefined) cursor.session = session;
    if (duplicate) cursor.duplicate = true;
    this.cursors.set(path, cursor);
    this.paths.set(id, path);
    post({ type: "file", path, cursor: { ...cursor }, requests, replace: replace || before?.gone !== undefined, takeover });
  }
}

/** Splits bytes into lines, and gives the parser each complete one that holds a needle. */
class Lines {
  private readonly needles: Buffer[];
  private readonly parser: FileParser;
  private carry: Buffer[] = [];
  private carried = 0;
  private skipping = false;
  /** Bytes given so far. */
  private given = 0;
  /** Bytes up to and with the last newline. */
  consumed = 0;

  constructor(needles: readonly string[], parser: FileParser) {
    this.needles = needles.map((needle) => Buffer.from(needle));
    this.parser = parser;
  }

  push(piece: Buffer, reused: boolean): void {
    let start = 0;
    if (this.carried > 0 || this.skipping) {
      const end = piece.indexOf(10);
      if (end < 0) {
        this.keep(piece, reused);
        this.given += piece.length;
        return;
      }
      if (!this.skipping && this.carried + end <= longestLine) {
        this.carry.push(piece.subarray(0, end));
        const line = Buffer.concat(this.carry);
        this.lines(line, 0, line.length);
      }
      this.carry = [];
      this.carried = 0;
      this.skipping = false;
      start = end + 1;
      this.consumed = this.given + start;
    }
    const last = piece.lastIndexOf(10);
    if (last >= start) {
      this.lines(piece, start, last);
      this.consumed = this.given + last + 1;
      start = last + 1;
    }
    if (start < piece.length) this.keep(piece.subarray(start), reused);
    this.given += piece.length;
  }

  /** The end of a whole file: a last line without a newline is complete too. */
  finish(): void {
    if (this.carried > 0 && !this.skipping) {
      const line = Buffer.concat(this.carry);
      this.lines(line, 0, line.length);
    }
    this.carry = [];
    this.carried = 0;
  }

  private keep(bytes: Buffer, reused: boolean): void {
    if (this.skipping) return;
    this.carried += bytes.length;
    if (this.carried > longestLine) {
      this.carry = [];
      this.carried = 0;
      this.skipping = true;
      return;
    }
    this.carry.push(reused ? Buffer.from(bytes) : bytes);
  }

  /** The lines of `bytes` from `start` to `end` (a newline, or the end of a lone line). */
  private lines(bytes: Buffer, start: number, end: number): void {
    if (this.needles.length === 0) {
      let at = start;
      while (at < end) {
        let stop = bytes.indexOf(10, at);
        if (stop < 0 || stop > end) stop = end;
        this.give(bytes, at, stop);
        at = stop + 1;
      }
      return;
    }
    // Where each needle is next, looked for again only once passed: each needle's search
    // goes over the bytes about once, however few lines hold it.
    const next = this.needles.map((needle) => bytes.indexOf(needle, start));
    let at = start;
    for (;;) {
      let hit = -1;
      for (let index = 0; index < next.length; index++) {
        if (next[index] >= 0 && next[index] < at) next[index] = bytes.indexOf(this.needles[index], at);
        if (next[index] >= 0 && next[index] < end && (hit < 0 || next[index] < hit)) hit = next[index];
      }
      if (hit < 0) return;
      const lineStart = Math.max(at, bytes.lastIndexOf(10, hit) + 1);
      let lineEnd = bytes.indexOf(10, hit);
      if (lineEnd < 0 || lineEnd > end) lineEnd = end;
      this.give(bytes, lineStart, lineEnd);
      at = lineEnd + 1;
      if (at >= end) return;
    }
  }

  private give(bytes: Buffer, start: number, end: number): void {
    if (end <= start || end - start > longestLine || !this.parser.line) return;
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8", start, end));
    } catch {
      return;
    }
    this.parser.line(value);
  }
}

/** The buffer files are read into, one for all: a read is synchronous, so two never share it at once. */
let sharedPiece: Buffer | undefined;

/** Reads an append file's lines from `from` to `to`; how many bytes up to its last newline. */
function readLines(path: string, from: number, to: number, needles: readonly string[], parser: FileParser): number {
  const lines = new Lines(needles, parser);
  const descriptor = openSync(path, "r");
  try {
    const piece = (sharedPiece ??= Buffer.allocUnsafe(pieceBytes));
    let at = from;
    while (at < to) {
      const read = readSync(descriptor, piece, 0, Math.min(pieceBytes, to - at), at);
      if (read <= 0) break;
      lines.push(read === piece.length ? piece : piece.subarray(0, read), true);
      at += read;
    }
  } finally {
    closeSync(descriptor);
  }
  return lines.consumed;
}

/** Reads a compressed file whole, as it streams out of zstd. */
async function readSnapshot(path: string, needles: readonly string[], parser: FileParser): Promise<void> {
  const lines = new Lines(needles, parser);
  // Node 22.15 and later have zstd; only the whole-file call where the stream is missing.
  if (typeof zlib.createZstdDecompress === "function") {
    await pipeline(createReadStream(path, { highWaterMark: 256 * 1024 }), zlib.createZstdDecompress(), async (source: AsyncIterable<Buffer>) => {
      for await (const piece of source) lines.push(piece, false);
    });
  } else if (typeof zlib.zstdDecompressSync === "function") {
    const { readFileSync } = await import("node:fs");
    lines.push(zlib.zstdDecompressSync(readFileSync(path)), false);
  } else {
    throw new Error("this Node has no zstd");
  }
  lines.finish();
}

/** Reads a small whole file of totals. */
function readTotal(path: string, stat: Stats, parser: FileParser): void {
  if (stat.size > largestTotal || !parser.whole) return;
  const descriptor = openSync(path, "r");
  let bytes: Buffer;
  try {
    bytes = Buffer.alloc(stat.size);
    const read = readSync(descriptor, bytes, 0, stat.size, 0);
    bytes = bytes.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
  // Half-written (a writer that does not replace it in one step): tried again when it changes.
  parser.whole(JSON.parse(bytes.toString("utf8")), stat.mtimeMs);
}
