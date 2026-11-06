import { basename, join, sep } from "node:path";
import { count, digest, emptyCounts, field, hasTokens, text, time, type FileParser, type ReadContext, type ReadRequest, type Source, type SourceOptions } from "./common.ts";

// Claude Code's history: `$CLAUDE_CONFIG_DIR/projects/<folder>/<session>.jsonl` (else
// `~/.claude`), one line per entry, the usage of each request to the model on its
// assistant lines (`message.usage`). Subagents keep their own transcripts beside the
// session, under `<session>/subagents/` (workflows one level deeper): their lines carry
// the parent's session id and `isSidechain`, and count with the parent. A workflow's
// `journal.jsonl` there is its own record of steps, not usage.
//
// The counting rules, learned from Tokscale's reader (THIRD_PARTY_NOTICES.md):
//
// - One response is written on several lines, one per content block, each with the
//   response's usage: a request is its message id and request id, counted once. The
//   lines of one request can differ while it streams, so a later line raises what was
//   counted, field by field, to the largest seen.
// - A resumed or forked session copies earlier lines into another file: the key is
//   claimed across files, and the second file's copy counts nothing.
// - `input_tokens` is the uncached remainder when the usage reports the cache split (its
//   cache keys are there, even at 0); a line without them is a bare snapshot of the
//   whole prompt, and does not replace a remainder.
// - `<synthetic>` is Claude Code's own notice (an API error, a sign-in prompt), no request.
// - An advisor's iterations (`usage.iterations`, `advisor_message`) are another model's
//   requests, apart from the top-level usage.
// - Reasoning (`output_tokens_details.thinking_tokens`) is inside the output tokens:
//   kept apart, never added to them.

/** How many of a file's latest requests are kept to raise from a later line of theirs. */
const tailKept = 16;

/** A counted request a later line may raise: its key, counts and where it went. */
type Tail = [key: string, input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number, reasoning: number, split: 0 | 1, at: number, model: string, folder: string, session: string, subagent: 0 | 1];

interface Saved {
  tail?: Tail[];
  /** The last time a line gave, for a line that gives none. */
  at?: number;
}

/** Claude Code's projects folder for this environment. */
export function claudeProjects({ home, env }: SourceOptions): string {
  const set = env.CLAUDE_CONFIG_DIR?.trim();
  return join(set || join(home, ".claude"), "projects");
}

export function claudeSources(options: SourceOptions): Source[] {
  return [
    {
      agent: "claude",
      root: claudeProjects(options),
      kind: () => "append",
      accepts: (path, name) => name.endsWith(".jsonl") && !(name === "journal.jsonl" && path.includes(`${sep}subagents${sep}`)),
      needles: ['"usage"'],
      parser: (path, saved, context) => new ClaudeParser(path, saved as Saved | undefined, context),
    },
  ];
}

class ClaudeParser implements FileParser {
  private readonly context: ReadContext;
  private readonly fileSession: string;
  private readonly inSubagents: boolean;
  private tail: Tail[];
  private at: number | undefined;

  constructor(path: string, saved: Saved | undefined, context: ReadContext) {
    this.context = context;
    this.fileSession = basename(path, ".jsonl");
    this.inSubagents = path.includes(`${sep}subagents${sep}`);
    this.tail = Array.isArray(saved?.tail) ? saved.tail.filter((entry) => Array.isArray(entry) && entry.length === 13) : [];
    this.at = typeof saved?.at === "number" ? saved.at : undefined;
  }

  line(entry: unknown): void {
    const at = time(field(entry, "timestamp"));
    if (at !== undefined) this.at = at;
    if (field(entry, "type") !== "assistant") return;
    const message = field(entry, "message");
    const usage = field(message, "usage");
    if (usage === null || typeof usage !== "object") return;
    const model = text(field(message, "model"));
    if (model === undefined || model.toLowerCase() === "<synthetic>") return;
    if (this.at === undefined) return;
    const subagent = field(entry, "isSidechain") === true || this.inSubagents;
    const request: ReadRequest = {
      agent: "claude",
      session: text(field(entry, "sessionId")) ?? this.fileSession,
      at: this.at,
      model,
      folder: text(field(entry, "cwd")) ?? "",
      ...counts(usage),
      requests: 1,
    };
    if (subagent) request.subagent = true;
    const id = text(field(message, "id"));
    const requestId = text(field(entry, "requestId"));
    const key = id === undefined ? undefined : requestId === undefined ? `message:${id}` : `${id}:${requestId}`;
    const split = reportsSplit(usage);
    if (key === undefined) {
      if (hasTokens(request)) this.context.emit(request);
    } else {
      const claim = this.context.claim(digest(key));
      if (claim === "new") {
        if (hasTokens(request)) this.context.emit(request);
        this.remember([key, request.input, request.output, request.cacheRead, request.cacheWrite, request.cacheWrite1h, request.reasoning, split ? 1 : 0, request.at, request.model, request.folder, request.session, subagent ? 1 : 0]);
      } else if (claim === "mine") {
        this.raise(key, request, split);
      }
    }
    this.advisors(usage, key, request);
  }

  save(): Saved {
    return this.at === undefined ? { tail: this.tail } : { tail: this.tail, at: this.at };
  }

  /** A later line of a request counted from this file: what it adds, field by field. */
  private raise(key: string, line: ReadRequest, split: boolean): void {
    const kept = this.tail.find((entry) => entry[0] === key);
    if (!kept) return;
    // `input` only compares between two lines that both report the cache split, or
    // neither; when one does, its remainder is what the request's input is.
    let input = kept[1];
    if (split && !kept[7]) input = line.input;
    else if (split === Boolean(kept[7])) input = Math.max(kept[1], line.input);
    const raised = [input, Math.max(kept[2], line.output), Math.max(kept[3], line.cacheRead), Math.max(kept[4], line.cacheWrite), Math.max(kept[5], line.cacheWrite1h), Math.max(kept[6], line.reasoning)];
    const before = kept.slice(1, 7) as number[];
    if (raised.every((value, index) => value === before[index]) && (kept[7] || !split)) return;
    const [rInput, rOutput, rCacheRead, rCacheWrite, rCacheWrite1h, rReasoning] = raised;
    const cacheWrite1h = Math.min(rCacheWrite1h, rCacheWrite);
    const delta: ReadRequest = {
      agent: "claude",
      session: kept[11],
      at: kept[8],
      model: kept[9],
      folder: kept[10],
      input: rInput - kept[1],
      output: rOutput - kept[2],
      cacheRead: rCacheRead - kept[3],
      cacheWrite: rCacheWrite - kept[4],
      cacheWrite1h: cacheWrite1h - Math.min(kept[5], kept[4]),
      reasoning: Math.min(rReasoning, rOutput) - Math.min(kept[6], kept[2]),
      requests: 0,
    };
    if (kept[12]) delta.subagent = true;
    kept[1] = rInput;
    kept[2] = rOutput;
    kept[3] = rCacheRead;
    kept[4] = rCacheWrite;
    kept[5] = rCacheWrite1h;
    kept[6] = rReasoning;
    if (split) kept[7] = 1;
    if (delta.input || delta.output || delta.cacheRead || delta.cacheWrite || delta.cacheWrite1h || delta.reasoning) this.context.emit(delta);
  }

  /** An advisor's requests within this one, each once by its place in `iterations`. */
  private advisors(usage: object, key: string | undefined, parent: ReadRequest): void {
    const iterations = field(usage, "iterations");
    if (!Array.isArray(iterations)) return;
    iterations.forEach((iteration, index) => {
      if (field(iteration, "type") !== "advisor_message") return;
      const model = text(field(iteration, "model"));
      if (model === undefined || model.toLowerCase() === "<synthetic>") return;
      if (key !== undefined && this.context.claim(digest(`${key}:advisor:${index}`)) !== "new") return;
      const request: ReadRequest = { ...parent, model, ...counts(iteration), requests: 0 };
      if (hasTokens(request)) this.context.emit(request);
    });
  }

  private remember(entry: Tail): void {
    this.tail.push(entry);
    if (this.tail.length > tailKept) this.tail.splice(0, this.tail.length - tailKept);
  }
}

/** Whether a usage reports the prompt's cache split: its cache keys are there, even at 0. */
function reportsSplit(usage: object): boolean {
  return field(usage, "cache_read_input_tokens") !== undefined || field(usage, "cache_creation_input_tokens") !== undefined;
}

/** An Anthropic usage object's tokens, each type once. */
function counts(usage: unknown): ReturnType<typeof emptyCounts> {
  const result = emptyCounts();
  result.input = count(field(usage, "input_tokens"));
  result.output = count(field(usage, "output_tokens"));
  result.cacheRead = count(field(usage, "cache_read_input_tokens"));
  result.cacheWrite = count(field(usage, "cache_creation_input_tokens"));
  result.cacheWrite1h = Math.min(count(field(field(usage, "cache_creation"), "ephemeral_1h_input_tokens")), result.cacheWrite);
  const details = field(usage, "output_tokens_details");
  result.reasoning = Math.min(count(field(details, "thinking_tokens")) || count(field(details, "reasoning_tokens")), result.output);
  return result;
}
