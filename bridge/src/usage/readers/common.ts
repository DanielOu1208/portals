import { createHash } from "node:crypto";
import type { UsageAgent, UsageRequest } from "../types.ts";

// What every reader of an agent's history shares (claude.ts, codex.ts, pi.ts, droid.ts):
// the shape a reader gives the scanner, and the small checks each makes on what an agent
// wrote. A reader never trusts a number it did not check: a negative, a string or a
// missing count is 0, so one odd line costs only itself.

/** A request as a reader found it, with what the via decision may need beyond the session. */
export interface ReadRequest extends UsageRequest {
  /** Codex's `session_meta.originator`: who started the session ("portals-bridge", "codex-tui"). */
  originator?: string;
}

/** What a file's reader is told by the scanner, and tells it. */
export interface ReadContext {
  /** A request found: it is counted. */
  emit(request: ReadRequest): void;
  /**
   * Claims a request's key for this file, so a request written in two files (a resumed
   * or forked session copies earlier lines) is counted once: "new" the first time any
   * file claims it, "mine" when this file did before, "other" when another file did.
   */
  claim(key: string): "new" | "mine" | "other";
  /**
   * Claims a session for this file, so one session in two files (Codex's `sessions/` and
   * `archived_sessions/`) counts once: "own" when this file reads it, "duplicate" when
   * another file that is still there does, and this one is to emit nothing.
   */
  session(id: string): "own" | "duplicate";
}

/** How a kind of file is read. */
export type FileKind =
  // Lines appended, never rewritten (`.jsonl`): read from where the last read stopped.
  | "append"
  // One whole file, read again whole whenever it changes (`.jsonl.zst`): what it gave
  // before is replaced by what it gives now.
  | "snapshot"
  // A small file of running totals rewritten in place (Droid's settings): each read
  // gives the rise since the last one.
  | "total";

/** One file's reader, from the start of the file or from what it saved. */
export interface FileParser {
  /** A complete line of an append or snapshot file, parsed. */
  line?(value: unknown): void;
  /** The whole of a total file, parsed; `modified` is its time (milliseconds). */
  whole?(value: unknown, modified: number): void;
  /** What to start from next time; small, and JSON. */
  save(): unknown;
}

/** Where an agent keeps its history, and how to read it. */
export interface Source {
  agent: UsageAgent;
  /** A folder walked for files; one that is not there has none. */
  root: string;
  kind(path: string): FileKind;
  /** Whether a file found under `root` is read. */
  accepts(path: string, name: string): boolean;
  /**
   * Bytes a line must hold one of to be parsed at all: tool output and images are most of
   * the bytes, and a text search costs far less than JSON.parse. Empty: every line.
   */
  needles: readonly string[];
  parser(path: string, saved: unknown, context: ReadContext): FileParser;
}

/** Where to look, as the host's environment says. */
export interface SourceOptions {
  home: string;
  env: NodeJS.ProcessEnv;
}

/** A count as an agent wrote it: a finite number at or above 0, else 0. */
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** A string an agent wrote, trimmed; undefined for anything else or nothing. */
export function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** An object's field, for values parsed from JSON. */
export function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** A time an agent wrote (ISO text, seconds or milliseconds) in milliseconds; undefined when it is not one. */
export function time(value: unknown): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value >= 1e12 ? value : value * 1000;
  return undefined;
}

/**
 * A short fixed-width digest of a request key, 8 characters: what the scanner keeps for
 * every request it counted, so tens of thousands of keys stay small. 48 bits: two keys
 * of one Mac's history meeting by chance is about one in a billion.
 */
export function digest(key: string): string {
  return createHash("sha256").update(key).digest("base64url").slice(0, 8);
}

/** A request with every count 0, for a reader to fill in. */
export function emptyCounts(): Pick<UsageRequest, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "reasoning" | "requests"> {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, requests: 0 };
}

/** Whether a request holds any token at all: one with none is not counted. */
export function hasTokens(request: Pick<UsageRequest, "input" | "output" | "cacheRead" | "cacheWrite">): boolean {
  return request.input + request.output + request.cacheRead + request.cacheWrite > 0;
}

/** `~` and `~/...` in a folder an environment variable gives, as the shell would. */
export function expandHome(set: string, home: string): string {
  if (set === "~") return home;
  return set.startsWith("~/") ? `${home}/${set.slice(2)}` : set;
}
