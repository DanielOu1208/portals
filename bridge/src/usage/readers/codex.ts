import { join } from "node:path";
import { count, emptyCounts, field, text, time, type FileParser, type ReadContext, type ReadRequest, type Source, type SourceOptions } from "./common.ts";

// Codex's history: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (else `~/.codex`),
// and `archived_sessions/` for the ones put away; older ones compressed as `.jsonl.zst`.
// The first line, `session_meta`, says whose session it is (`id`), where it ran (`cwd`)
// and who started it (`originator`: "portals-bridge" for Portals); each turn's
// `turn_context` names its model; and `token_count` events hold the session's usage.
//
// The counting rules, learned from Tokscale's reader (THIRD_PARTY_NOTICES.md):
//
// - `token_count.info.total_token_usage` is a running total: a request is a rise of it,
//   its size `last_token_usage`. A total that does not move is the same request told
//   again; one that falls a little is a snapshot written out of order, which the next
//   one corrects; one that falls a lot is a reset (after compaction), from which it counts
//   again. The first total of a file is not all new: a resumed session starts from its
//   old total, so the first request is its `last_token_usage` only.
// - OpenAI's input tokens hold the cached ones, and its output tokens the reasoning ones:
//   input here is what was neither read from the cache nor written to it, and reasoning is
//   kept apart and never added to the output.
// - A fork (`forked_from_id`) begins with its parent's turns written again. Turn ids are
//   UUIDv7, whose first 48 bits are the time they were made: a turn made before the fork
//   itself is the parent's, already counted from the parent's file.
// - A session in two files (`sessions/` and `archived_sessions/`, or `.jsonl` and
//   `.jsonl.zst`) counts once, by its `session_meta` id.
// - A thread Codex started itself (a subagent, `source.subagent`) counts with the
//   session it was started from.

/** A running total: input (cached among it), cached, output (reasoning among it), reasoning. */
type Totals = [input: number, cached: number, output: number, reasoning: number];

interface Saved {
  id?: string;
  /** The session its requests count with: its own, or its parent's for a subagent. */
  session?: string;
  originator?: string;
  folder?: string;
  model?: string;
  subagent?: boolean;
  /** A fork's own time (milliseconds), from its id: turns made before it are its parent's. */
  fork?: number;
  /** The turn being read is one of the parent's, written again in a fork. */
  replay?: boolean;
  /** Another file reads this session. */
  duplicate?: boolean;
  previous?: Totals;
  at?: number;
}

/** Codex's own folder for this environment. */
export function codexHome({ home, env }: SourceOptions): string {
  return env.CODEX_HOME?.trim() || join(home, ".codex");
}

export function codexSources(options: SourceOptions): Source[] {
  const base = codexHome(options);
  return ["sessions", "archived_sessions"].map((folder) => ({
    agent: "codex",
    root: join(base, folder),
    kind: (path: string) => (path.endsWith(".zst") ? "snapshot" : "append"),
    accepts: (_path: string, name: string) => name.endsWith(".jsonl") || name.endsWith(".jsonl.zst"),
    needles: ['"token_count"', '"session_meta"', '"turn_context"'],
    parser: (_path: string, saved: unknown, context: ReadContext) => new CodexParser(saved as Saved | undefined, context),
  }));
}

/** The millisecond time a UUIDv7 was made, from its first 48 bits; undefined for another kind of id. */
export function uuidTime(id: string | undefined): number | undefined {
  if (id === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(id)) return undefined;
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

class CodexParser implements FileParser {
  private readonly context: ReadContext;
  private readonly state: Saved;

  constructor(saved: Saved | undefined, context: ReadContext) {
    this.context = context;
    this.state = saved && typeof saved === "object" ? { ...saved } : {};
  }

  line(entry: unknown): void {
    const at = time(field(entry, "timestamp"));
    if (at !== undefined) this.state.at = at;
    const type = field(entry, "type");
    const payload = field(entry, "payload");
    if (type === "session_meta") this.meta(payload);
    else if (type === "turn_context") this.turn(payload);
    else if (type === "event_msg" && field(payload, "type") === "token_count") this.tokens(field(payload, "info"));
  }

  save(): Saved {
    return this.state;
  }

  private meta(payload: unknown): void {
    // A fork writes its parent's session_meta again after its own: the first one is the file's.
    if (this.state.id !== undefined) return;
    const id = text(field(payload, "id"));
    if (id === undefined) return;
    const state = this.state;
    state.id = id;
    state.session = id;
    state.originator = text(field(payload, "originator"));
    state.folder = text(field(payload, "cwd"));
    const subagent = field(field(payload, "source"), "subagent");
    if (subagent !== undefined || field(payload, "thread_source") === "subagent") {
      state.subagent = true;
      const root = text(field(payload, "session_id"));
      const parent = text(field(field(subagent, "thread_spawn"), "parent_thread_id")) ?? text(field(payload, "parent_thread_id"));
      state.session = (root !== undefined && root !== id ? root : undefined) ?? parent ?? id;
    }
    if (text(field(payload, "forked_from_id")) !== undefined) state.fork = uuidTime(id);
    if (this.context.session(id) === "duplicate") state.duplicate = true;
  }

  private turn(payload: unknown): void {
    const model = text(field(payload, "model"));
    if (model !== undefined) this.state.model = model;
    const folder = text(field(payload, "cwd"));
    if (folder !== undefined) this.state.folder = folder;
    if (this.state.fork !== undefined) {
      const made = uuidTime(text(field(payload, "turn_id")));
      this.state.replay = made !== undefined && made < this.state.fork;
    }
  }

  private tokens(info: unknown): void {
    if (info === null || typeof info !== "object") return;
    const total = totals(field(info, "total_token_usage"));
    const last = totals(field(info, "last_token_usage"));
    const previous = this.state.previous;
    let request: Totals | undefined;
    let next: Totals | undefined = total;
    if (total && previous) {
      if (same(total, previous)) return;
      if (rises(total, previous)) request = last ?? minus(total, previous);
      // Fallen a little: a snapshot out of order, the next one goes on from the higher total.
      else if (last && stale(total, previous, last)) return;
      else request = last ?? total;
    } else if (total) {
      request = last ?? total;
    } else if (last) {
      request = last;
      next = previous ? [previous[0] + last[0], previous[1] + last[1], previous[2] + last[2], previous[3] + last[3]] : undefined;
    }
    if (!request || request.every((value) => value === 0)) return;
    if (next) this.state.previous = next;
    if (this.state.duplicate || this.state.replay || this.state.at === undefined) return;
    this.context.emit(this.request(request));
  }

  private request([input, cached, output, reasoning]: Totals): ReadRequest {
    const state = this.state;
    const counts = emptyCounts();
    counts.cacheRead = Math.min(cached, input);
    counts.input = input - counts.cacheRead;
    counts.output = output;
    counts.reasoning = Math.min(reasoning, output);
    counts.requests = 1;
    const request: ReadRequest = {
      agent: "codex",
      session: state.session ?? state.id ?? "",
      at: state.at ?? 0,
      model: state.model ?? "unknown",
      folder: state.folder ?? "",
      ...counts,
    };
    if (state.subagent) request.subagent = true;
    if (state.originator !== undefined) request.originator = state.originator;
    return request;
  }
}

/** A usage object as a running total; undefined when it holds no count. */
function totals(usage: unknown): Totals | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const input = count(field(usage, "input_tokens"));
  const cached = Math.max(count(field(usage, "cached_input_tokens")), count(field(usage, "cache_read_input_tokens")));
  const output = count(field(usage, "output_tokens"));
  const reasoning = count(field(usage, "reasoning_output_tokens"));
  if (field(usage, "input_tokens") === undefined && field(usage, "output_tokens") === undefined && field(usage, "cached_input_tokens") === undefined) return undefined;
  return [input, cached, output, reasoning];
}

function same(a: Totals, b: Totals): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** Whether no part of the total fell. */
function rises(total: Totals, previous: Totals): boolean {
  return total[0] >= previous[0] && total[1] >= previous[1] && total[2] >= previous[2] && total[3] >= previous[3];
}

function minus(total: Totals, previous: Totals): Totals {
  return [total[0] - previous[0], total[1] - previous[1], total[2] - previous[2], total[3] - previous[3]];
}

/**
 * Whether a total that fell is a stale snapshot rather than a reset: it fell by at most
 * about two recent requests, or by no more than a fiftieth. A reset after compaction
 * falls to a fraction of what it was.
 */
function stale(total: Totals, previous: Totals, last: Totals): boolean {
  const sum = (values: Totals) => values[0] + values[2];
  const now = sum(total);
  const before = sum(previous);
  if (now <= 0 || before <= 0) return false;
  return now * 50 >= before * 49 || now + 2 * sum(last) >= before;
}
