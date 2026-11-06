import { closeSync, openSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { count, emptyCounts, field, text, type FileParser, type ReadContext, type ReadRequest, type Source, type SourceOptions } from "./common.ts";

// Droid's history: `~/.factory/sessions/<folder>/<session>.jsonl` with the conversation,
// and beside it `<session>.settings.json` with the session's model and its running total
// of tokens (`tokenUsage`: inputTokens, outputTokens, cacheCreationTokens,
// cacheReadTokens, thinkingTokens). The conversation's messages carry no usage of their
// own, so the settings are what is read: rewritten whole at each change, each read gives
// the rise since the last one, at the time the file was written. A session read for the
// first time gives all it spent so far at its last change; from then on each rise lands
// on its own day.
//
// `tokenUsage` is the session's own; what its subagents spent is in their own sessions
// (and in `inclusiveTokenUsage`, which is not read, so nothing counts twice). Thinking
// tokens are inside the output: kept apart, never added to it.

/** A running total: input, output, cache read, cache write, thinking. */
type Totals = [input: number, output: number, cacheRead: number, cacheWrite: number, thinking: number];

interface Saved {
  previous?: Totals;
  folder?: string;
}

/** How much of a conversation's first line is read to find the session's folder. */
const headBytes = 64 * 1024;

/** Droid's sessions folder for this environment. */
export function droidSessions({ home, env }: SourceOptions): string {
  return join(env.FACTORY_HOME_OVERRIDE?.trim() || home, ".factory", "sessions");
}

export function droidSources(options: SourceOptions): Source[] {
  return [
    {
      agent: "droid",
      root: droidSessions(options),
      kind: () => "total",
      accepts: (_path, name) => name.endsWith(".settings.json"),
      needles: [],
      parser: (path, saved, context) => new DroidParser(path, saved as Saved | undefined, context),
    },
  ];
}

class DroidParser implements FileParser {
  private readonly path: string;
  private readonly context: ReadContext;
  private readonly session: string;
  private readonly state: Saved;

  constructor(path: string, saved: Saved | undefined, context: ReadContext) {
    this.path = path;
    this.context = context;
    this.session = basename(path, ".settings.json");
    this.state = saved && typeof saved === "object" ? { ...saved } : {};
  }

  whole(settings: unknown, modified: number): void {
    const usage = field(settings, "tokenUsage");
    if (usage === null || typeof usage !== "object") return;
    if (this.context.session(this.session) === "duplicate") return;
    const now: Totals = [
      count(field(usage, "inputTokens")),
      count(field(usage, "outputTokens")),
      count(field(usage, "cacheReadTokens")),
      count(field(usage, "cacheCreationTokens")),
      count(field(usage, "thinkingTokens")),
    ];
    const previous = this.state.previous;
    // A total that fell was started again: all of it is new.
    const rise = previous && now.every((value, index) => value >= previous[index]) ? now.map((value, index) => value - previous[index]) : now;
    this.state.previous = now;
    if (rise[0] + rise[1] + rise[2] + rise[3] === 0) return;
    this.state.folder ??= folderOf(this.path.replace(/\.settings\.json$/, ".jsonl"));
    const counts = emptyCounts();
    counts.input = rise[0];
    counts.output = rise[1];
    counts.cacheRead = rise[2];
    counts.cacheWrite = rise[3];
    counts.reasoning = Math.min(rise[4], rise[1]);
    counts.requests = 1;
    const request: ReadRequest = {
      agent: "droid",
      session: this.session,
      at: modified,
      model: modelOf(settings),
      folder: this.state.folder ?? "",
      ...counts,
    };
    this.context.emit(request);
  }

  save(): Saved {
    return this.state;
  }
}

/** The model a session's settings name; a router's ("auto") is the model it picked, when it says. */
function modelOf(settings: unknown): string {
  const model = text(field(settings, "model"));
  if (model === undefined || model.toLowerCase() === "auto") {
    return text(field(field(settings, "effectiveFactoryRouterModel"), "modelId")) ?? model ?? "unknown";
  }
  return model;
}

/** The folder in a conversation's first line (`session_start.cwd`); "" when there is none to read. */
function folderOf(conversation: string): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(conversation, "r");
    const head = Buffer.alloc(headBytes);
    const read = readSync(descriptor, head, 0, headBytes, 0);
    const end = head.subarray(0, read).indexOf(10);
    if (end < 0) return "";
    const first: unknown = JSON.parse(head.subarray(0, end).toString("utf8"));
    return field(first, "type") === "session_start" ? text(field(first, "cwd")) ?? "" : "";
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
