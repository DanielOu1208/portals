import { performance } from "node:perf_hooks";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { createHash } from "node:crypto";
import { log } from "../log.ts";
import type { Provider, StoredMessage } from "../providers/types.ts";
import type { ThreadRecord } from "../sessions/registry.ts";
import { holds, parseQuery, snippet, type Query, type Range } from "./match.ts";
import { compactionView, scanFile, ScanStopped, storedMessages, type Budget, type SearchedMessage, type SearchFile } from "./readers.ts";

// Search inside threads (feature thread_search, `thread.search`,
// docs/plans/2026-10-26-thread-search.md): the user's and the agent's words in every
// thread the bridge lists, grouped by thread, newest thread first.
//
// Every thread is searched in its agent's own file (`Provider.searchFile`), loaded or
// not, read in chunks without loading it; in memory, in the messages the app is shown,
// only a thread whose agent keeps no such file (Hermes) or whose file is not written yet.
// A hit from before a compaction the thread no longer shows (Claude Code's) is marked
// `before_compaction`, with the compaction's time as `compacted_at`. A page ends when it
// has `limit` threads with hits, or when it has spent its time or its bytes, checked
// between threads; its cursor says where to go on. The scan gives the event loop its turn every few milliseconds, at most two
// searches run at once, and a connection's newer search replaces its older one.
//
// Nothing of a query or of what it finds is logged.

export const defaultLimit = 20;
export const maxLimit = 50;
export const defaultHits = 3;
export const maxHits = 10;
/** How long a page may scan before it ends with a cursor. */
export const pageTimeMs = 1500;
/** How many bytes of files a page may read before it ends with a cursor. */
export const pageBytes = 256 * 1024 * 1024;
/** How long the scan keeps the event loop before it gives it a turn. */
const sliceMs = 10;
/** How long before its file's last write a loaded message is taken to be perhaps not in it yet. */
const unsavedSlackSeconds = 5;
/** How many searches run at once on a bridge; the others wait their turn. */
const runningAtOnce = 2;

export interface SearchParams {
  query: string;
  limit?: number;
  hits?: number;
  cursor?: string;
  /** Only the threads of this agent (its profile name). */
  agent?: string;
  /** Only the threads in this folder, or in a folder inside it, or listed under it (a worktree's main checkout). */
  folder?: string;
}

export interface SearchHit {
  role: "user" | "assistant";
  /** A snippet around the first match. */
  text: string;
  /** The matches in `text`, in UTF-16 code units. */
  ranges: Range[];
  /** Unix seconds. */
  timestamp: number;
  /** The agent's own id for the message, where its file has one. */
  id?: string;
  /**
   * Said before the thread's latest compaction, which the thread no longer shows (Claude
   * Code's): the app opens the thread at the compaction row (`compacted_at`), with the
   * snippet in a note (2026-10-26: "Open at compaction + note").
   */
  before_compaction?: true;
}

export interface ThreadHits {
  id: string;
  agent: string;
  agent_name: string;
  title?: string;
  folder: string;
  /** Unix seconds: the thread's place in the list. */
  updated: number;
  archived?: true;
  /** How many of its messages hold every word. */
  count: number;
  /** The newest of them, newest first. */
  hits: SearchHit[];
  /**
   * Unix seconds: when the thread's latest compaction was, the `timestamp` of the
   * `compaction` row its history shows there. Given when a hit is `before_compaction`.
   */
  compacted_at?: number;
  /** Its file is larger than the bridge reads: only its end was searched. */
  partial?: true;
  /** For a thread on a linked Mac (`machine/id`): that Mac's name. */
  machine?: string;
}

export interface Unsearched {
  agent: string;
  count: number;
  reason: string;
}

export interface SearchResult {
  threads: ThreadHits[];
  /** Where the next page starts; null when every thread was searched. */
  cursor: string | null;
  /** How many threads this page searched. */
  scanned: number;
  /** Threads that could not be searched, by agent, with why. */
  unsearched?: Unsearched[];
  /** A newer search on the same connection took this one's place: no threads. */
  replaced?: true;
}

/** A query that has nothing to look for. */
export class EmptyQuery extends Error {}
/** A cursor that is not this bridge's, or belongs to another query. */
export class BadCursor extends Error {}

/** What a search stopped by a newer one (or by its caller going) answers. */
export function replacedResult(): SearchResult {
  return { threads: [], cursor: null, scanned: 0, replaced: true };
}

/** The query's words and the cursor's position; throws `EmptyQuery` and `BadCursor`. */
export function checkSearch(params: SearchParams): { query: Query; position: Position | null } {
  const query = parseQuery(params.query);
  if (!query) throw new EmptyQuery("The query has no words to look for.");
  return { query, position: params.cursor ? decodeCursor(params, params.cursor) : null };
}

export interface SearchSource {
  /** Every thread the bridge lists. */
  records(): ThreadRecord[];
  /** The thread's messages when it is loaded now, else undefined. */
  loaded(id: string): readonly StoredMessage[] | undefined;
}

interface Position {
  updated: number;
  id: string;
}

/** Threads in the order searched: newest first, then by id, so that a position in it holds. */
function order(a: Position, b: Position): number {
  return b.updated - a.updated || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function after(at: Position, position: Position): boolean {
  return at.updated < position.updated || (at.updated === position.updated && at.id > position.id);
}

/** What a cursor is tied to: the query and the filters, so that one given with another query is refused. */
export function cursorKey(params: SearchParams): string {
  return createHash("sha256").update(JSON.stringify([params.query, params.agent ?? "", params.folder ?? ""])).digest("base64url").slice(0, 12);
}

export function encodeCursor(params: SearchParams, position: Position): string {
  return Buffer.from(JSON.stringify({ v: 1, k: cursorKey(params), u: position.updated, i: position.id })).toString("base64url");
}

export function decodeCursor(params: SearchParams, cursor: string): Position {
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new BadCursor("The cursor is not one this bridge gave.");
  }
  if (parsed?.v !== 1 || typeof parsed.u !== "number" || typeof parsed.i !== "string") throw new BadCursor("The cursor is not one this bridge gave.");
  if (parsed.k !== cursorKey(params)) throw new BadCursor("The cursor belongs to another search.");
  return { updated: parsed.u, id: parsed.i };
}

function inFolder(record: ThreadRecord, folder: string): boolean {
  const base = folder.replace(/\/+$/, "");
  // The root, `/`, holds every folder.
  if (base === "") return record.cwd.startsWith("/");
  return record.cwd === base || record.cwd.startsWith(`${base}/`) || record.repo === base;
}

const unreadable = "This agent keeps its threads where the bridge cannot read them without opening each one: a thread of it is searched only while it is open.";
const notRunning = "This agent is not turned on in the bridge's settings: its threads are not searched.";

export interface ThreadSearchOptions {
  source: SearchSource;
  providers: Map<string, Provider>;
  /** Unless a test says otherwise. */
  pageTimeMs?: number;
  pageBytes?: number;
  /** The most read of one file (`fileLimit`). */
  fileLimit?: number;
  now?: () => number;
}

export class ThreadSearch {
  private readonly source: SearchSource;
  private readonly providers: Map<string, Provider>;
  private readonly timeMs: number;
  private readonly bytes: number;
  private readonly fileLimit: number | undefined;
  private readonly now: () => number;
  /** Each caller's search under way, which its next one replaces. */
  private readonly running = new WeakMap<object, AbortController>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(options: ThreadSearchOptions) {
    this.source = options.source;
    this.providers = options.providers;
    this.timeMs = options.pageTimeMs ?? pageTimeMs;
    this.bytes = options.pageBytes ?? pageBytes;
    this.fileLimit = options.fileLimit;
    this.now = options.now ?? (() => performance.now());
  }

  /**
   * A page of the threads whose messages hold the query. `caller`: whose search it is,
   * whose next one replaces it; `signal`: stops it (the caller went).
   * Throws `EmptyQuery` and `BadCursor`, before it replaces anything.
   */
  async search(params: SearchParams, caller: object, signal?: AbortSignal): Promise<SearchResult> {
    checkSearch(params);
    const claim = this.claim(caller, signal);
    try {
      return await this.searchUnder(params, claim.signal);
    } finally {
      claim.done();
    }
  }

  /**
   * Makes what follows the caller's search: its older one is stopped, and `signal` (the
   * claim's) aborts when a newer one of the caller's, or `given`, stops this one. `done`
   * once it has answered. A search of the linked Macs holds its claim until every Mac has
   * answered, so that a newer search replaces all of it.
   */
  claim(caller: object, given?: AbortSignal): { signal: AbortSignal; done(): void } {
    this.running.get(caller)?.abort();
    const controller = new AbortController();
    this.running.set(caller, controller);
    return {
      signal: given ? AbortSignal.any([controller.signal, given]) : controller.signal,
      done: () => {
        if (this.running.get(caller) === controller) this.running.delete(caller);
      },
    };
  }

  /** A page searched under a claim (`claim`): `replaced` once `stop` aborts. Throws `EmptyQuery` and `BadCursor`. */
  async searchUnder(params: SearchParams, stop: AbortSignal): Promise<SearchResult> {
    const { query, position } = checkSearch(params);
    try {
      await this.turn(stop);
      try {
        return await this.page(params, query, position, stop);
      } finally {
        this.release();
      }
    } catch (error) {
      if (error instanceof ScanStopped) return replacedResult();
      throw error;
    }
  }

  /** Waits for one of the slots; throws `ScanStopped` when stopped while it waits. */
  private async turn(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new ScanStopped();
    if (this.active < runningAtOnce) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal.removeEventListener("abort", gone);
        this.active += 1;
        resolve();
      };
      const gone = () => {
        const at = this.waiting.indexOf(go);
        if (at !== -1) this.waiting.splice(at, 1);
        reject(new ScanStopped());
      };
      this.waiting.push(go);
      signal.addEventListener("abort", gone, { once: true });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  private async page(params: SearchParams, query: Query, position: Position | null, signal: AbortSignal): Promise<SearchResult> {
    const limit = Math.min(Math.max(params.limit ?? defaultLimit, 1), maxLimit);
    const wanted = Math.min(Math.max(params.hits ?? defaultHits, 1), maxHits);
    const started = this.now();
    let sliceStarted = started;
    const budget: Budget = {
      bytes: this.bytes,
      signal,
      pause: async () => {
        if (this.now() - sliceStarted < sliceMs) return;
        await yieldToLoop();
        sliceStarted = this.now();
        if (signal.aborted) throw new ScanStopped();
      },
    };
    // Each thread's place as it is now: a thread whose time moves while the page runs (a
    // turn ends, it is renamed) keeps the place it was searched at, which the cursor holds.
    const records = this.source
      .records()
      .filter((record) => (!params.agent || record.agent === params.agent) && (!params.folder || inFolder(record, params.folder)))
      .map((record) => ({ record, at: { updated: record.updatedAt, id: record.id } }))
      .sort((a, b) => order(a.at, b.at))
      .filter(({ at }) => !position || after(at, position));
    const threads: ThreadHits[] = [];
    const unsearched = new Map<string, number>();
    let scanned = 0;
    let last: Position | null = null;
    for (const { record, at } of records) {
      // Replaced, or its caller went: stopped between threads too, where a thread in memory or a small file never waits.
      if (signal.aborted) throw new ScanStopped();
      if (threads.length >= limit || (scanned > 0 && (this.now() - started >= this.timeMs || budget.bytes <= 0))) {
        // Where the next page starts: after the last thread searched.
        log.debug("thread search page", { scanned, found: threads.length, ms: Math.round(this.now() - started), more: true });
        return this.result(threads, last ? encodeCursor(params, last) : position ? encodeCursor(params, position) : null, scanned, unsearched);
      }
      const found = await this.searchThread(record, at.updated, query, wanted, budget);
      scanned += 1;
      last = at;
      if (found === "unsearched") unsearched.set(record.agent, (unsearched.get(record.agent) ?? 0) + 1);
      else if (found) threads.push(found);
    }
    // Replaced while the last thread was searched: none of it is answered.
    if (signal.aborted) throw new ScanStopped();
    log.debug("thread search page", { scanned, found: threads.length, ms: Math.round(this.now() - started), more: false });
    return this.result(threads, null, scanned, unsearched);
  }

  private result(threads: ThreadHits[], cursor: string | null, scanned: number, unsearched: Map<string, number>): SearchResult {
    const result: SearchResult = { threads, cursor, scanned };
    if (unsearched.size > 0) result.unsearched = [...unsearched].map(([agent, count]) => ({ agent, count, reason: this.providers.has(agent) ? unreadable : notRunning }));
    return result;
  }

  /** The thread's hits; null for none, `unsearched` for a thread whose words the bridge cannot read. */
  private async searchThread(record: ThreadRecord, updated: number, query: Query, wanted: number, budget: Budget): Promise<ThreadHits | null | "unsearched"> {
    const kept: SearchedMessage[] = [];
    let count = 0;
    const hit = (message: SearchedMessage) => {
      kept.push(message);
      count += 1;
      if (kept.length > wanted) kept.shift();
    };
    // Whether the file has a compaction after which the thread may no longer show what came before it.
    let compacted = false;
    // How large the file is: reading the conversation as the agent tells it reads it all again.
    let size = 0;
    let partial = false;
    const provider = this.providers.get(record.agent);
    // The agent's own file whenever it has one, the thread loaded or not: a thread finds the
    // same whether or not it is open somewhere (a loaded Claude thread holds only what
    // followed its last compaction, a loaded Pi thread only its branch). The messages in
    // memory only for an agent without such a file (Hermes), or a thread with none yet.
    let file: SearchFile | null = null;
    if (provider?.searchFile) {
      try {
        file = await provider.searchFile({ id: record.id, cwd: record.cwd });
      } catch {
        file = null;
      }
    }
    if (file) {
      // How many times the file says each thing that holds the words, by role and text.
      const inFile = new Map<string, number>();
      const scanned = await scanFile(
        file,
        query,
        budget,
        (message) => {
          const key = `${message.role}\n${message.text}`;
          inFile.set(key, (inFile.get(key) ?? 0) + 1);
          hit(message);
        },
        this.fileLimit,
        () => {
          compacted = true;
        },
      );
      partial = scanned.partial;
      size = scanned.size;
      // A loaded thread's messages not written to the bridge's own record yet (Cursor and
      // Droid save theirs when a tool or the turn ends). The record holds the words of the
      // messages loaded, not their times (the thread's own are the bridge's), so a message
      // said N times loaded and M times in the record is unsaved N - M times: its last
      // N - M sayings, those of them newer than the record, give or take a few seconds.
      // (Claude Code, Codex and Pi write each message as it ends, in words of their own.)
      const loaded = file.format === "stored" ? this.source.loaded(record.id) : undefined;
      if (loaded && loaded.length > 0) {
        const since = scanned.modified - unsavedSlackSeconds;
        const sayings = new Map<string, SearchedMessage[]>();
        let index = 0;
        for (const message of storedMessages(loaded)) {
          if (holds(message.text, query)) {
            const key = `${message.role}\n${message.text}`;
            const said = sayings.get(key);
            if (said) said.push(message);
            else sayings.set(key, [message]);
          }
          if ((++index & 63) === 0) await budget.pause();
        }
        const unsaved = [...sayings].flatMap(([key, said]) => said.slice(inFile.get(key) ?? 0)).filter((message) => message.timestamp >= since);
        for (const message of unsaved.sort((a, b) => a.timestamp - b.timestamp)) hit(message);
      }
    } else {
      const loaded = this.source.loaded(record.id);
      if (!loaded) return provider?.searchFile ? null : "unsearched";
      let index = 0;
      for (const message of storedMessages(loaded)) {
        if (holds(message.text, query)) hit(message);
        if ((++index & 63) === 0) await budget.pause();
      }
      await budget.pause();
    }
    if (count === 0) return null;
    // Which of the hits shown the thread no longer shows, for a compaction: read from the
    // conversation as the agent tells it, only for a file with a compaction and a hit in it,
    // and read whole by the bridge's search (not over `fileLimit`: the agent's reading would
    // parse it all, at once, with nothing to stop it). Its bytes count against the page.
    let chain: Awaited<ReturnType<typeof compactionView>> = null;
    if (file?.shown && compacted && !partial && kept.some((message) => message.id !== undefined)) {
      if (budget.signal.aborted) throw new ScanStopped();
      budget.bytes -= size;
      try {
        chain = await compactionView(await file.shown());
      } catch {
        chain = null;
      }
      await budget.pause();
    }
    const hits: SearchHit[] = [];
    for (const message of kept.reverse()) {
      const shown = await snippet(message.text, query, budget.pause);
      if (!shown) continue;
      const before = chain !== null && message.id !== undefined && !chain.shownIds.has(message.id) && message.timestamp <= chain.compactedAt;
      hits.push({
        role: message.role,
        text: shown.text,
        ranges: shown.ranges,
        timestamp: message.timestamp,
        ...(message.id ? { id: message.id } : {}),
        ...(before ? { before_compaction: true as const } : {}),
      });
    }
    return {
      id: record.id,
      agent: record.agent,
      agent_name: provider?.profile.displayName ?? record.agent,
      ...(record.title ? { title: record.title } : {}),
      folder: record.cwd,
      updated,
      ...(record.archived ? { archived: true as const } : {}),
      count,
      hits,
      ...(chain && hits.some((each) => each.before_compaction) ? { compacted_at: chain.compactedAt } : {}),
      ...(partial ? { partial: true as const } : {}),
    };
  }
}
