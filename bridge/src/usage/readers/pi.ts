import { basename, isAbsolute, join, resolve } from "node:path";
import { count, digest, emptyCounts, expandHome, field, hasTokens, text, time, type FileParser, type ReadContext, type ReadRequest, type Source, type SourceOptions } from "./common.ts";

// Pi's history: `$PI_CODING_AGENT_DIR/sessions/<folder>/<time>_<id>.jsonl` (else
// `~/.pi/agent`), or the one folder `$PI_CODING_AGENT_SESSION_DIR` names. The first line,
// `session`, has the session's id and folder; each assistant message has the usage of
// its request (`message.usage`: input, output, cacheRead, cacheWrite, reasoning) and the
// model it went to.
//
// The counting rules, learned from Tokscale's reader (THIRD_PARTY_NOTICES.md):
//
// - Pi forks a session by copying its messages into a new file: a request is its
//   provider's response id (else the entry's id and time), counted once across files.
// - Work outside replies is billed too: `usage` entries, and `compaction` and
//   `branch_summary` entries with a usage of their own, and a tool result that reports
//   the call behind it.
// - `input` is what was not read from the cache; reasoning is inside the output.

/** Entries outside replies that carry a request's usage of their own. */
const operations = new Set(["usage", "compaction", "branch_summary"]);

interface Saved {
  session?: string;
  folder?: string;
  /** The model the session last changed to, for an entry that names none. */
  model?: string;
  at?: number;
}

/** Pi's own folder for this environment. */
export function piAgentFolder({ home, env }: SourceOptions): string {
  const set = env.PI_CODING_AGENT_DIR?.trim();
  return set ? expandHome(set, home) : join(home, ".pi", "agent");
}

export function piSources(options: SourceOptions): Source[] {
  const roots = [join(piAgentFolder(options), "sessions")];
  const moved = options.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  // A folder relative to each thread's own is no one place to look: only a whole path is read.
  if (moved) {
    const folder = expandHome(moved, options.home);
    if (isAbsolute(folder) && !roots.includes(resolve(folder))) roots.push(resolve(folder));
  }
  return roots.map((root) => ({
    agent: "pi",
    root,
    kind: () => "append",
    accepts: (_path: string, name: string) => name.endsWith(".jsonl"),
    needles: ['"usage"', '"session"', '"model_change"'],
    parser: (path: string, saved: unknown, context: ReadContext) => new PiParser(path, saved as Saved | undefined, context),
  }));
}

class PiParser implements FileParser {
  private readonly context: ReadContext;
  private readonly state: Saved;

  constructor(path: string, saved: Saved | undefined, context: ReadContext) {
    this.context = context;
    this.state = saved && typeof saved === "object" ? { ...saved } : {};
    // The file's name ends with the session's id, for a file whose first line is lost.
    this.state.session ??= basename(path, ".jsonl").split("_").pop();
  }

  line(entry: unknown): void {
    const at = time(field(entry, "timestamp"));
    if (at !== undefined) this.state.at = at;
    const type = field(entry, "type");
    if (type === "session") {
      this.state.session = text(field(entry, "id")) ?? this.state.session;
      this.state.folder = text(field(entry, "cwd")) ?? this.state.folder;
      return;
    }
    if (type === "model_change") {
      this.state.model = text(field(entry, "modelId")) ?? this.state.model;
      return;
    }
    const message = field(entry, "message");
    const role = field(message, "role");
    let usage: unknown;
    let model: string | undefined;
    let key: string | undefined;
    const id = text(field(entry, "id"));
    if (type === "message" && (role === "assistant" || role === "toolResult")) {
      usage = field(message, "usage");
      model = text(field(message, "model"));
      if (role === "assistant" && model !== undefined) this.state.model = model;
      const response = text(field(message, "responseId"));
      const made = field(message, "timestamp") ?? field(entry, "timestamp");
      key = response !== undefined ? `response:${response}` : id !== undefined ? `entry:${id}:${String(made)}` : undefined;
    } else if (typeof type === "string" && operations.has(type)) {
      usage = field(entry, "usage");
      model = text(field(entry, "model"));
      key = id !== undefined ? `${type}:${id}:${String(field(entry, "timestamp"))}` : undefined;
    } else {
      return;
    }
    if (usage === null || typeof usage !== "object" || this.state.at === undefined) return;
    const counts = emptyCounts();
    counts.input = count(field(usage, "input"));
    counts.output = count(field(usage, "output"));
    counts.cacheRead = count(field(usage, "cacheRead"));
    counts.cacheWrite = count(field(usage, "cacheWrite"));
    counts.cacheWrite1h = Math.min(count(field(usage, "cacheWrite1h")), counts.cacheWrite);
    counts.reasoning = Math.min(count(field(usage, "reasoning")), counts.output);
    counts.requests = 1;
    if (!hasTokens(counts)) return;
    if (key !== undefined && this.context.claim(digest(`pi:${key}`)) !== "new") return;
    const request: ReadRequest = {
      agent: "pi",
      session: this.state.session ?? "",
      at: this.state.at,
      model: model ?? this.state.model ?? "unknown",
      folder: this.state.folder ?? "",
      ...counts,
    };
    this.context.emit(request);
  }

  save(): Saved {
    return this.state;
  }
}
