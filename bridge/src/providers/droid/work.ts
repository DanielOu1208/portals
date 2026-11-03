import type { DroidStreamEvent } from "@factory/droid-sdk/node";
import { ended, type Ended } from "../claude/background.ts";
import type { ProviderEvent, SubagentInfo, SubagentStatus } from "../types.ts";
import { tokenTotal } from "./activity.ts";
import { runsInBackground, type OpenCall } from "./stream.ts";
import { contentText, gatewayResult, gatewayTool } from "./tools.ts";

interface Call {
  id: string;
  name: "Task" | "Execute" | "Script";
  input: Record<string, unknown>;
  started: number;
  lastSeen: number;
  parent?: string;
  child?: SubagentInfo;
  launched: boolean;
  done: boolean;
  observedTools: Set<string>;
  progress?: string;
  completion?: Extract<ProviderEvent, { type: "tool.end" }>;
  /** Tracking ended after an hour of silence: the process is no longer held, but Droid's real report still counts. */
  expired?: boolean;
  /** The id the app knows the call by, when it is not Droid's (a background command's, `gatewayId`). */
  as?: string;
  /** The completion message's text that ended a background command, to tell it told again from another's; empty when it ended at its launch, with none to come. */
  ended?: string;
  /** Since it ended, a background command was announced under its id: a newer one, whose completion may look the same. */
  again?: boolean;
  /** The turn it was begun in (`DroidWork.turnBegan`): a Task under the id of one begun in an earlier turn is another. */
  turn: number;
  /**
   * Another command had its Droid id while it was at work: Droid's completion names only
   * the id, so which of them a completion ends is not known, and its row says so.
   */
  uncertain?: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, limit = 4000): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, limit) : undefined;
}

function terminal(reason: unknown): Exclude<SubagentStatus, "running"> | undefined {
  if (reason === "completed") return "completed";
  if (["cancelled", "process_exit", "interrupted", "stopped"].includes(String(reason))) return "stopped";
  if (["error", "failed", "permission_rejected", "model_usage_exhausted", "model_authentication_failed",
    "model_request_rejected", "model_provider_unreachable", "structured_output_invalid"].includes(String(reason))) return "failed";
  return undefined;
}

/** How long a completion that came ahead of its command's row waits for it (`DroidWork.early`). */
const earlyMs = 30_000;

/** What a background command's row and the person are told when Droid's completion could be either of two commands under one id. */
function ambiguousNote(id: string): string {
  return `Droid finished a background command under the id ${id}, which more than one command had at once; Portals cannot tell which one ended, so this outcome may be another's.`;
}

/**
 * Whether Script call `id`'s result says it runs on after its call returned: CLI 0.250
 * answers a Script still at work with its status as the result's last text,
 * `{"toolCallId": "<id>", "status": "running"}` (also "stalled", or while it is being
 * stopped), or `[Script running · …]`, after what it printed; Droid reads only that last
 * text, which a Script's own output never is. Its end comes later, as a completion of its
 * own (`script-completion:…`), and closing Droid's process meanwhile stops it and loses its
 * result.
 */
function scriptRunning(content: unknown, id: string): boolean {
  const last = typeof content === "string" ? content : Array.isArray(content)
    ? ([...content].reverse().find((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text") as { text?: unknown } | undefined)?.text
    : undefined;
  if (typeof last !== "string") return false;
  const text = last.trim();
  if (/^\[Script running \u00B7 .*\]$/u.test(text)) return true;
  try {
    const status = JSON.parse(text) as { toolCallId?: unknown; status?: unknown };
    return status.toolCallId === id && typeof status.status === "string" && ["running", "stalled", "interrupting", "killing"].includes(status.status);
  } catch {
    return false;
  }
}

function field(body: string, name: string): string | undefined {
  return new RegExp(`^${name}: ([^\\r\\n]+)\\r?$`, "m").exec(body)?.[1];
}

/** Actual terminal reports win; silent background work has a bounded tracking lease. */
export class DroidWork {
  private readonly calls = new Map<string, Call>();
  private readonly children = new Map<string, SubagentInfo>();
  private readonly emit: (event: ProviderEvent) => void;
  private readonly session: () => string | undefined;
  private readonly completions = new Set<string>();
  private readonly autonomous = new Map<string, number>();
  private readonly now: () => number;
  private readonly holdMs: number;
  /** Ids the turn's stream gave background calls not tracked here yet (`named`), by Droid's id. */
  private readonly names = new Map<string, string>();
  /**
   * A completion that came under the id of a background command that had ended, with
   * other words than that one's: a newer command's with the same Droid id, whose raw
   * notifications ran ahead of the turn's stream. Taken by the call begun next under that
   * id (after `named` made way), if within `earlyMs`.
   */
  private readonly early = new Map<string, { message: Record<string, unknown>; parent?: string; at: number }>();
  /**
   * Background commands a newer one took the Droid id of (a model that numbers its calls
   * afresh in each answer, recent-15), still at work or their tracking expired: Droid's
   * completion names only the id, so each waits here for one, the oldest first
   * (`completing`). The latest 64.
   */
  private readonly older: Call[] = [];
  /** How many turns have begun (`turnBegan`). */
  private turns = 0;
  /**
   * Droid ids under which Droid announced another command while one was at work: the
   * command tracked next under the id (once the stream names it) is in doubt from its
   * start, as the one at work is (`Call.uncertain`). The latest 64.
   */
  private readonly collisions = new Set<string>();
  /** The thread's own background work Droid was told last had ended, and the line that says so (`takeEnd`). */
  private lastEnd: Ended | undefined;
  /** Calls a turn ended under, by Droid's id, with the thread's folder: a result Droid tells for one later goes to its row (`leftOpen`). The latest 64. */
  private readonly open = new Map<string, OpenCall & { cwd: string; at: number }>();
  /** Results for calls nobody tracks, told raw within the last minute: one for a call the turn is still closing under is its (`leftOpen`). The latest 64. */
  private readonly unmatched = new Map<string, { content: unknown; error: boolean; at: number }>();

  constructor(session: () => string | undefined, emit: (event: ProviderEvent) => void, saved: SubagentInfo[] = [],
    options: { holdMs?: number; now?: () => number } = {}) {
    this.session = session;
    this.emit = emit;
    this.now = options.now ?? Date.now;
    this.holdMs = options.holdMs ?? 60 * 60_000;
    for (const child of saved) this.children.set(child.id, child.status === "running"
      ? { ...child, status: "stopped", endedAt: Date.now(), result: "Live tracking ended when the bridge stopped. Droid did not report a terminal outcome." }
      : { ...child });
  }

  /** A turn of the thread's own begins. */
  turnBegan(): void { this.turns += 1; }

  /** What the last trusted completion of the thread's own said ended (`notification`), once: Droid begins a turn by itself to answer it. */
  takeEnd(): Ended | undefined {
    const end = this.lastEnd;
    this.lastEnd = undefined;
    return end;
  }

  /** Every call tracked: those under their Droid id, and those a newer one took it from (`older`). */
  private tracked(): Call[] { return [...this.older, ...this.calls.values()]; }

  get busy(): boolean {
    const now = this.now();
    for (const [id, seen] of this.autonomous) if (now - seen >= this.holdMs) this.autonomous.delete(id);
    for (const call of this.tracked()) if (!call.done
      && (call.name !== "Task" || call.input.await !== true || call.parent)
      && now - call.lastSeen >= this.holdMs) {
      this.stop(call, "Background tracking ended after an hour without activity. No terminal outcome was reported.");
      call.expired = true;
    }
    return this.autonomous.size > 0 || this.tracked().some((call) => !call.done);
  }
  /**
   * The turn's stream gave the background call Droid calls `droidId` the id `as`
   * (`gatewayId`): its final result goes out under it. Taken by the call tracked under
   * that id that has none yet, or by the one begun next.
   */
  named(droidId: string, as: string): void {
    const call = this.calls.get(droidId);
    if (call && !call.parent) {
      if (!call.as) { call.as = as; return; }
      if (call.as === as || call.name !== "Execute") return;
      // A new command with the id of an earlier one (a model that numbers its calls afresh):
      // only the turn's stream names a call, once, so a notification told again never
      // brings an ended call back. The earlier one makes way for the new one, which is
      // tracked and takes its own completion; still at work, or its tracking expired, it
      // waits aside for its own (`older`), so its end is never lost nor its process let go.
      this.calls.delete(droidId);
      for (const key of this.completions) if (key.startsWith(`execute-completion:${droidId}\n`)) this.completions.delete(key);
      if (!call.done || call.expired) {
        this.older.push(call);
        // The oldest whose tracking expired first, else the oldest.
        if (this.older.length > 64) this.older.splice(Math.max(0, this.older.findIndex((older) => older.done)), 1);
      }
    } else if (call) return;
    this.names.set(droidId, as);
    if (this.names.size > 64) this.names.delete(this.names.keys().next().value!);
  }

  /**
   * The calls a turn that ended as it should left open: one a Script runs in the background
   * (Droid 0.247 shows a Script's calls as calls of their own) ends after the turn, and its
   * result, told then, goes to its row instead of the turn's "ended before this tool
   * reported a result". Those tracked here already (background commands, Tasks) are not.
   */
  leftOpen(calls: readonly OpenCall[], cwd: string): void {
    for (const call of calls) {
      if (this.calls.has(call.droidId)) continue;
      this.open.delete(call.droidId);
      this.open.set(call.droidId, { ...call, cwd, at: this.now() });
      if (this.open.size > 64) this.open.delete(this.open.keys().next().value!);
      // Told already, after Droid's end of the turn and before the bridge's.
      const told = this.unmatched.get(call.droidId);
      this.unmatched.delete(call.droidId);
      if (told && this.now() - told.at < 60_000) this.lateResult(call.droidId, told.content, told.error);
    }
  }

  snapshot(): SubagentInfo[] { return [...this.children.values()].slice(-200).map((child) => ({ ...child })); }

  /**
   * The child of a background Task (one not awaited) at work among `sessions`: the sessions
   * an approval Droid asks is for (its `associatedSessionIds`, the child's and the thread's),
   * which may come after the turn the Task was begun in has ended.
   */
  backgroundChild(sessions: readonly string[] | undefined): SubagentInfo | undefined {
    for (const id of sessions ?? []) {
      const child = this.children.get(id);
      const call = this.callOf(child);
      if (child?.status === "running" && call && !call.done && call.input.await !== true) return child;
    }
    return undefined;
  }

  private news(call: Call): void {
    if (call.child && this.children.get(call.child.id) === call.child) this.emit({ type: "subagent", subagent: { ...call.child } });
  }

  /** A call announced, by Droid's raw notification (`raw`) or by the turn's stream, which tells each again. */
  private begin(id: string, name: string, input: Record<string, unknown>, parent?: string, raw = false): void {
    if (parent) {
      const owner = this.children.get(parent);
      const running = this.callOf(owner);
      if (owner?.status === "running" && running && !running.observedTools.has(id)) {
        running.observedTools.add(id);
        owner.tool = gatewayTool(name, input).name;
        owner.toolUses = running.observedTools.size;
        this.news(running);
      }
    }
    let known = this.calls.get(id);
    // A Task under the id of one begun in an earlier turn that has ended is another (a
    // model that numbers its calls afresh): it is tracked, and its child bound to it.
    if (known && !parent && !known.parent && name === "Task" && known.name === "Task" && known.done && known.turn !== this.turns) {
      this.calls.delete(id);
      known = undefined;
    }
    // A Script under the id of one that returned is another (a call is not told again after
    // its result): one still at work in the background waits aside for its own end (`older`).
    if (known && known.parent === parent && name === "Script" && known.name === "Script" && (known.done || known.launched)) {
      this.calls.delete(id);
      // Its completion will have the same id as the earlier one's (CLI 0.250's run id is the
      // call's): one told from now on is this one's.
      for (const key of this.completions) if (key.startsWith("script-completion:") && key.endsWith(`:${id}`)) this.completions.delete(key);
      if (!known.done || known.expired) {
        this.older.push(known);
        if (this.older.length > 64) this.older.splice(Math.max(0, this.older.findIndex((older) => older.done)), 1);
      }
      known = undefined;
    }
    // Only a raw announcement is of a newer command: the stream's of an ended one is that
    // one's own, told after its completion when that came first.
    if (raw && known && known.done && known.ended !== undefined && known.parent === parent && name === "Execute" && runsInBackground(name, input)) {
      known.again = true;
    }
    // Announced under the id of a command at work that was begun in an earlier turn, or
    // launched already (a call is not announced after its result): another command, which
    // the stream will name; meanwhile a completion under the id may be either's.
    if (raw && known && !known.done && known.parent === parent && known.name === "Execute" && name === "Execute" && runsInBackground(name, input)
      && (known.turn !== this.turns || known.launched)) {
      known.uncertain = true;
      this.collisions.add(id);
      if (this.collisions.size > 64) this.collisions.delete(this.collisions.values().next().value!);
    }
    if (known || (name !== "Task" && name !== "Script" && !runsInBackground(name, input))) return;
    const as = parent ? undefined : this.names.get(id);
    this.names.delete(id);
    const uncertain = !parent && this.collisions.delete(id);
    this.calls.set(id, { id, name: name as Call["name"], input, parent, started: this.now(), lastSeen: this.now(), launched: false, done: false, observedTools: new Set(), turn: this.turns, ...(as ? { as } : {}), ...(uncertain ? { uncertain } : {}) });
    const early = this.early.get(id);
    if (early) {
      this.early.delete(id);
      if (early.parent === parent && this.now() - early.at <= earlyMs) this.completion(early.message, parent);
    }
  }

  private bind(call: Call, id: string, description?: unknown, role?: unknown): boolean {
    if (!id || id === this.session() || id === call.parent || call.done || (call.child && call.child.id !== id)) return false;
    const known = this.children.get(id);
    if (known?.status === "running" && known.run !== call.id) return false;
    call.lastSeen = this.now();
    if (call.child) return true;
    call.child = {
      id, kind: "agent", goal: text(description) ?? text(call.input.description) ?? "Droid task",
      role: text(role) ?? text(call.input.subagent_type), parent: call.parent, run: call.id,
      startedAt: call.started, status: "running", background: call.input.await !== true, stoppable: false,
    };
    this.children.set(id, call.child);
    this.news(call);
    return true;
  }

  private finish(call: Call, status: Exclude<SubagentStatus, "running">, result?: string): void {
    result = result?.slice(0, 65_536);
    if (call.done) {
      // Terminal child notices can arrive before the Task's fuller source-of-record report.
      if (call.child && result && (call.child.result !== result || call.child.status !== status)) {
        Object.assign(call.child, { status, result });
        this.news(call);
      }
      return;
    }
    call.done = true;
    if (call.child) {
      Object.assign(call.child, { status, endedAt: Date.now(), ...(result ? { result } : {}) });
      this.news(call);
    }
    // Keep enough settled runs for duplicate notifications, without unbounded growth.
    if (this.calls.size > 512) for (const [id, older] of this.calls) {
      if (this.calls.size <= 512) break;
      if (older.done) this.calls.delete(id);
    }
    if (this.children.size > 200) for (const [id, child] of this.children) {
      if (this.children.size <= 200) break;
      if (child.status !== "running" && !this.autonomous.has(id)
        && ![...this.calls.values()].some((call) => !call.done && call.parent === id)) this.children.delete(id);
    }
  }

  private result(id: string, content: unknown, error: boolean): void {
    const call = this.calls.get(id);
    if (!call) return;
    const output = contentText(content);
    call.lastSeen = this.now();
    if (call.name === "Task") {
      const launched = output.startsWith("Task launched in background.\n");
      const childId = launched ? field(output.split("\nsubagent_type:")[0], "session_id")
        : /^session_id: ([^\r\n]+)(?:\r?\n|$)/.exec(output)?.[1];
      if (childId && (call.child ? call.child.id !== childId : !this.bind(call, childId))) return;
      if (call.done && launched) return;
      if (launched && !error) { call.launched = true; return; }
      const report = output.replace(/^session_id: [^\r\n]+\r?\n/, "")
        .replace(/^Use this report as the source of record\.[^\n]*\n/, "");
      this.finish(call, error ? "failed" : "completed", report);
    } else if (call.name === "Script") {
      // One still at work runs on in the background, until its completion (`scriptsEnded`).
      if (call.launched) return;
      if (!error && scriptRunning(content, call.id)) call.launched = true;
      else this.finish(call, error ? "failed" : "completed");
    } else if (call.launched) {
      // A launched command's final result comes as its completion message: a result
      // with its id now is another call's, which a model that numbers its calls afresh
      // in each answer gave the same id.
      return;
    } else if (!error && /^Background process started \(PID: \d+\)/.test(output)) {
      call.launched = true;
    } else {
      // Ended as it began (it exited at once, or could not start): no completion follows,
      // so one under its id is a newer command's (`ahead`).
      if (!call.done && call.name === "Execute") call.ended = "";
      this.finish(call, error ? "failed" : "completed");
    }
  }

  private progress(id: string, update: Record<string, unknown>): void {
    const call = this.calls.get(id);
    if (!call || call.name !== "Task" || call.done) return;
    if (typeof update.subagentSessionId === "string" && !this.bind(call, update.subagentSessionId)) return;
    const child = call.child;
    if (!child) return;
    call.lastSeen = this.now();
    const summary = text(update.error) ?? text(update.status) ?? text(update.details) ?? text(update.text) ?? text(update.valueSnippet);
    const fingerprint = JSON.stringify([update.type, update.toolName, update.timestamp, summary]);
    if (call.progress === fingerprint) return;
    call.progress = fingerprint;
    if (typeof update.toolName === "string") child.tool = gatewayTool(update.toolName, object(update.parameters) ?? {}).name;
    if (summary) child.summary = summary;
    // Progress has no nested tool-use ID, so it cannot supply an exact tool count.
    this.news(call);
  }

  /** Returns true only for a trusted asynchronous completion message. */
  private completion(message: Record<string, unknown>, parent?: string): boolean {
    if (typeof message.id === "string" && /^script-completion(-batch)?:/.test(message.id)) return this.scriptsEnded(message, parent);
    if (message.visibility !== "llm_only" || typeof message.id !== "string") return false;
    const body = contentText(message.content);
    if (this.ahead(message, body, parent) || this.completions.has(message.id)) return false;
    const boundary = body.indexOf("\noutput: ");
    if (boundary === -1) return false;
    const header = body.slice(0, boundary);
    if (message.role === "system" && message.id.startsWith("task-completion:") && body.startsWith("Background task completed.\n")) {
      const id = field(header, "task_id"), status = terminal(field(header, "reason"));
      const call = this.callOf(id ? this.children.get(id) : undefined);
      if (!call || call.parent !== parent || !status) return false;
      if (parent) this.autonomous.set(parent, this.now());
      this.remember(message.id);
      let report = body.slice(boundary + "\noutput: ".length);
      const trailer = report.lastIndexOf("\n\nBackground task ");
      if (trailer !== -1 && report.slice(trailer).includes(`(${id}) just completed.`)) report = report.slice(0, trailer);
      this.finish(call, status, report);
      if (!parent) this.lastEnd = ended({ type: "local_agent", description: field(header, "description") ?? call.child?.goal ?? "" }, status, "");
      return true;
    }
    if (message.role === "user" && body.startsWith("Background Execute command finished.\n")) {
      const id = field(header, "tool_use_id");
      const atWork = id ? this.tracked().filter((call) => call.id === id && call.parent === parent && call.name === "Execute" && !call.done) : [];
      // Told again, word for word, with no other command under its id at work: the same one.
      const told = this.completions.has(`${message.id}\n${body}`);
      if (told && atWork.length === 0) return false;
      const call = id ? this.completing(id, parent) : undefined;
      // A command whose tracking expired may still finish: its real outcome replaces the stand-in.
      if (!call || call.parent !== parent || call.name !== "Execute" || (call.done && !call.expired) || message.id !== `execute-completion:${id}`) return false;
      // Droid's completion names only the id: with two commands under it at work, or the same
      // words again while another is, which of them ended is not known. It ends the one
      // launched first, and says so on its row and to the person.
      const ambiguous = atWork.length > 1 || told || call.uncertain === true;
      // Which one ended is not known: those left at work under the id stay in doubt too.
      if (ambiguous) for (const other of atWork) if (other !== call) other.uncertain = true;
      call.expired = false;
      call.ended = body;
      if (parent) this.autonomous.set(parent, this.now());
      // By its words too: another command under the same id (`older`) ends with the same
      // message id, and other words.
      this.remember(`${message.id}\n${body}`);
      const aside = this.older.indexOf(call);
      if (aside !== -1) this.older.splice(aside, 1);
      const code = /^code (-?\d+)$/.exec(field(header, "exit_status") ?? "");
      const said = body.slice(boundary + "\noutput: ".length).split("\n\nThis is a new asynchronous completion event,")[0].slice(0, 65_536);
      const output = ambiguous ? `${ambiguousNote(id!)}\n${said}` : said;
      if (ambiguous) this.emit({ type: "notice", level: "warn", text: ambiguousNote(id!) });
      const result = code ? { output, exit_code: Number(code[1]) }
        : { output, success: false, error: `Command ended: ${field(header, "exit_status") ?? "unknown exit status"}.` };
      this.finish(call, code?.[1] === "0" ? "completed" : "failed");
      if (!parent) this.lastEnd = ended({ type: "local_bash", description: typeof call.input.command === "string" ? call.input.command.replace(/\s+/g, " ").trim().slice(0, 200) : "" }, code?.[1] === "0" ? "completed" : "failed", "");
      call.completion = { type: "tool.end", id: call.id, ...gatewayTool("Execute", call.input), result,
        durationSeconds: (Date.now() - call.started) / 1000 };
      // Before the turn's stream has given the call its row (and its id, `named`), it is
      // sent with the launch's result (`accept`).
      if (call.as || call.parent) this.emit({ ...call.completion, id: call.as ?? call.id });
      return true;
    }
    return false;
  }

  /**
   * The Script a Script completion ends, the turn Droid delivers when one that ran on in the
   * background ends (CLI 0.250): `script-completion:<parent session>:<run>:<tool use id>`
   * names its call, and ends the one launched first under that id. A
   * `script-completion-batch:…` tells of Script runs that ended "while this session was not
   * loaded", none of this process's: it ends none, and those at work are held until their own
   * end (or an hour of silence, as any background work).
   */
  private scriptsEnded(message: Record<string, unknown>, parent?: string): boolean {
    const id = message.id as string;
    const named = /^script-completion:.*:([^:]+)$/.exec(id)?.[1];
    if (named === undefined || this.completions.has(id)) return false;
    const call = this.tracked().find((call) => call.name === "Script" && call.id === named && call.parent === parent && call.launched && (!call.done || call.expired));
    if (!call) return false;
    this.remember(id);
    const aside = this.older.indexOf(call);
    if (aside !== -1) this.older.splice(aside, 1);
    call.expired = false;
    this.finish(call, "completed");
    if (parent) this.autonomous.set(parent, this.now());
    return true;
  }

  /** The Task call that started `child`, while it is still the one tracked under its id (a newer Task may have taken the id since). */
  private callOf(child: SubagentInfo | undefined): Call | undefined {
    const call = child?.run ? this.calls.get(child.run) : undefined;
    return call?.child?.id === child?.id ? call : undefined;
  }

  /**
   * The background command a completion naming Droid's id `id` ends: of those under that
   * id still at work, the one launched first (Droid's completion names only the id, so
   * two at work at once under one id are told apart by no more than their order), else
   * one whose tracking expired, whose real outcome still counts.
   */
  private completing(id: string, parent?: string): Call | undefined {
    const candidates = this.tracked().filter((call) => call.id === id && call.parent === parent && call.name === "Execute");
    return candidates.find((call) => !call.done && call.launched) ?? candidates.find((call) => !call.done)
      ?? candidates.find((call) => call.expired) ?? this.calls.get(id);
  }

  /**
   * Whether `message` completes a background command under the id of one that ended, with
   * other words than that one's, or after a newer command was announced under that id
   * (the same words: the same command run again): not the ended command's told again but
   * a newer one's, ahead of its row. Kept for it (`early`).
   */
  private ahead(message: Record<string, unknown>, body: string, parent?: string): boolean {
    if (message.role !== "user" || !body.startsWith("Background Execute command finished.\n")) return false;
    const id = field(body.slice(0, body.indexOf("\noutput: ")), "tool_use_id");
    const call = id ? this.calls.get(id) : undefined;
    // An earlier command under the id still at work, or whose tracking expired (`older`), is the one it ends.
    if (id && this.older.some((older) => older.id === id && older.parent === parent && (!older.done || older.expired))) return false;
    if (!id || !call || call.parent !== parent || call.name !== "Execute" || !call.done || call.expired
      || call.ended === undefined || (call.ended === body && !call.again) || message.id !== `execute-completion:${id}`) return false;
    this.early.set(id, { message, parent, at: this.now() });
    if (this.early.size > 64) this.early.delete(this.early.keys().next().value!);
    return true;
  }

  private remember(id: string): void {
    this.completions.add(id);
    if (this.completions.size > 512) this.completions.delete(this.completions.values().next().value!);
  }

  notification(params: Record<string, unknown>): boolean {
    const notification = object(params.notification);
    if (!notification || typeof params.sessionId !== "string") return false;
    const source = params.sessionId;
    const own = source === this.session();
    if (!own && (!source || !this.children.has(source))) return false;
    const parent = own ? undefined : source;
    if (parent) {
      const call = this.callOf(this.children.get(parent));
      if (call) call.lastSeen = this.now();
      if (this.autonomous.has(parent)) this.autonomous.set(parent, this.now());
    }
    if (parent && notification.type === "agent_turn_completed") this.autonomous.delete(parent);
    const id = notification.toolUseId;
    if (typeof id === "string") {
      const call = this.calls.get(id);
      if (call && call.parent === parent) call.lastSeen = this.now();
    }
    if (notification.type === "tool_call") {
      const tool = object(notification.toolUse);
      if (tool && typeof tool.id === "string" && typeof tool.name === "string") this.begin(tool.id, tool.name, object(tool.input) ?? {}, parent, true);
    } else if (notification.type === "child_session_available" && typeof id === "string" && typeof notification.childSessionId === "string") {
      const call = this.calls.get(id);
      if (call?.name === "Task" && call.parent === parent) this.bind(call, notification.childSessionId, notification.description, notification.subagentType);
    } else if (notification.type === "tool_progress_update" && typeof id === "string") {
      const call = this.calls.get(id), update = object(notification.update);
      if (call?.parent === parent && update) this.progress(id, update);
    } else if (notification.type === "tool_result" && typeof id === "string") {
      const call = this.calls.get(id);
      if (call && call.parent === parent) this.result(id, notification.content, notification.isError === true);
      else if (!call && !parent) this.lateResult(id, notification.content, notification.isError === true);
    } else if (notification.type === "create_message") {
      const message = object(notification.message);
      // A call Droid announces (its message's tool_use) after a result kept for its id is a
      // newer one: that result is not its (`leftOpen`). Droid's own order, not the stream's,
      // which can give an announcement late.
      if (!parent && message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) if (object(block)?.type === "tool_use" && typeof object(block)?.id === "string") this.unmatched.delete(object(block)!.id as string);
      }
      const completed = message ? this.completion(message, parent) : false;
      return own && completed;
    } else if (parent) {
      const child = this.children.get(parent)!;
      const call = this.callOf(child);
      if (!call || call.done) return false;
      if (notification.type === "session_token_usage_changed") {
        const tokens = tokenTotal(notification.tokenUsage);
        if (tokens !== undefined) { child.tokens = tokens; this.news(call); }
      } else if (notification.type === "assistant_text_complete") {
        const report = text(notification.text, 65_536);
        if (report) child.result = report;
      } else if (notification.type === "agent_turn_completed") {
        const status = terminal(notification.reason);
        if (status) this.finish(call, status, child.result);
      }
    }
    return false;
  }

  accept(event: DroidStreamEvent): void {
    if (event.type === "tool_call") this.begin(event.toolUseId, event.name, event.input);
    if (event.type === "tool_result") {
      this.result(event.toolUseId, event.content, event.isError);
      // A very fast asynchronous completion may precede the SDK's queued launch result.
      const call = this.calls.get(event.toolUseId);
      if (call?.completion) this.emit({ ...call.completion, id: call.as ?? call.id });
    }
    if (event.type === "tool_progress") this.progress(event.toolUseId, event.update);
  }

  /**
   * The turn ended, or (`stopping`) Stop was asked of it: Droid settles it after, and may
   * still say then that a background command it had not acknowledged started (its launch
   * receipt) or did not (a cancelled result), so such a one is left for the turn's end
   * (recent-18). At the end one still unacknowledged fails, as its tracking expiring
   * does: should Droid have started it after all, its real completion still counts.
   */
  turnEnded(interrupted = false, stopping = false): void {
    for (const call of this.calls.values()) {
      if (call.done || call.parent) continue;
      if (call.name === "Task" && call.input.await === true) {
        this.finish(call, "stopped", interrupted
          ? "The parent turn was interrupted before Droid reported this task's outcome."
          : "The parent turn ended without a terminal report for this awaited task.");
      } else if (!call.launched && !call.child) {
        if (stopping && call.name !== "Task") continue;
        this.finish(call, "failed", "The turn ended before Droid reported this task's result.");
        if (call.name !== "Task") call.expired = true;
      }
    }
  }

  /** A result for a call a turn ended under (`leftOpen`), within the hour: its row's. */
  private lateResult(droidId: string, content: unknown, error: boolean): void {
    const call = this.open.get(droidId);
    if (!call) {
      this.unmatched.delete(droidId);
      this.unmatched.set(droidId, { content, error, at: this.now() });
      if (this.unmatched.size > 64) this.unmatched.delete(this.unmatched.keys().next().value!);
      return;
    }
    this.open.delete(droidId);
    if (this.now() - call.at >= this.holdMs) return;
    this.emit({ type: "tool.end", id: call.id, ...call.tool, result: gatewayResult(call.tool, content, error, call.cwd),
      durationSeconds: (Date.now() - call.started) / 1000 });
  }

  private stop(call: Call, error: string): void {
    this.finish(call, "stopped", error);
    if (call.name === "Execute") {
      call.completion = { type: "tool.end", id: call.id, ...gatewayTool("Execute", call.input), result: { success: false, error, output: error } };
      this.emit({ ...call.completion, id: call.as ?? call.id });
    }
  }

  stopped(reason = "Live tracking ended when the Droid process stopped. No terminal report was received."): void {
    this.autonomous.clear();
    for (const call of this.tracked()) if (!call.done) {
      this.stop(call, reason);
    }
  }
}
