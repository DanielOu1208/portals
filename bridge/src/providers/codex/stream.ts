import { LiveOutput } from "../liveOutput.ts";
import type { ContextUsage, ProviderEvent, UsageLimit, UsageReport } from "../types.ts";
import { asyncQuestions } from "./requests.ts";
import { gatewayResult, gatewayTool, isToolItem } from "./tools.ts";
import type { RateLimitSnapshot, RateLimitWindow, Turn } from "./types/index.ts";

// What Codex reports about one thread, as the bridge's neutral events
// (providers/types.ts). One of these per thread; the session feeds it the
// notifications of the turn it follows, in order, and it keeps what it needs across
// them: which tools are open, which messages streamed, how full the context is.
//
// - `agentMessage` items stream word by word (`item/agentMessage/delta`). One in the
//   commentary phase (written beside tool calls) is closed with a `commentary` event
//   when it completes, so the reply that follows does not run into it. The final
//   answer is the turn's reply. One that asks questions without waiting
//   (`delivery: "async"`, ./requests.ts) is a `questions` event in its text's place,
//   unless some of it streamed already; what was written before it is closed off.
// - Reasoning summaries stream as reasoning (`item/reasoning/summaryTextDelta`).
// - A tool row opens with its item's `item/started` and closes with `item/completed`.
// - A `contextCompaction` item is a compaction: a passing status line while it runs,
//   then a mark of its place, with the context use from before it.
// - A message sent mid-turn (a steer) is a second `userMessage` item: what was written
//   before it is closed off, as for commentary.
// - An item that started before the bridge was listening (after a reconnect or a
//   restart) is reported whole when it completes, never from the middle. One that was
//   streaming when the connection dropped takes no more pieces once it is back (some
//   were lost meanwhile): the rest of it comes whole when it completes.
// - A command's output streams as it runs (`item/commandExecution/outputDelta`), as its
//   row's live output (`tool.progress`, through `progress`, at most four a second).
// - `turn/completed` ends the turn. A command still running then was left running in
//   the background (a background terminal, which goes on printing and completes later):
//   its row closes with the output so far, and `background` is told of it.

export interface StreamOptions {
  /** The thread's folder, for paths in diffs. */
  cwd: string;
  /** Milliseconds; for tool durations. */
  now?: () => number;
  /** Who a call about the thread's sub-agents was about, by name (`CodexAgents.calledAbout`). */
  calledAbout?: (item: Record<string, any>) => string[] | undefined;
  /**
   * An item told from a read of the turn rather than as it happened (`reconcile`), just
   * before its row: what it says of the sub-agents is taken in first, as it would have
   * been live, so a wait among them names them.
   */
  heardLate?: (item: Record<string, any>) => void;
  /** A running command's live output (`tool.progress`), sent apart from `map`'s answer. */
  progress?: (event: ProviderEvent) => void;
  /**
   * A command still running when its turn completed: it runs on in the background, its
   * row closed. What it printed so far comes with it; the rest of its output and its
   * completion come under its item's id after the turn.
   */
  background?: (command: { id: string; turn: string | null; command: string; processId?: string; startedAt: number; output?: string; outputTruncated?: boolean }) => void;
}

type Item = Record<string, any>;

interface OpenTool {
  name: string;
  args: Record<string, unknown>;
  context?: string;
  startedAt: number;
  /** A command's own words and the process Codex runs it in, for one left running in the background. */
  command?: string;
  processId?: string;
}

/** A message or a reasoning summary as it streams. */
interface Streaming {
  /** Text sent on so far. */
  streamed: string;
  /** Every piece since its `item/started` has come, so the next follows on from `streamed`. */
  live: boolean;
}

export class CodexStream {
  private readonly cwd: string;
  private readonly now: () => number;
  private readonly calledAbout: (item: Item) => string[] | undefined;
  private readonly heardLate: (item: Item) => void;
  private readonly live: LiveOutput;
  private readonly background: NonNullable<StreamOptions["background"]>;
  private turnId: string | null = null;
  private readonly tools = new Map<string, OpenTool>();
  private readonly messages = new Map<string, Streaming>();
  private readonly reasoned = new Map<string, Streaming>();
  /**
   * Items of the turn already reported (or already in the stored history); only this
   * turn's, so that a thread loaded for days does not keep every item it ever had. Codex
   * gives each item an id of its own, and the session hands in nothing of another turn (a
   * turn it tells from a read, it begins first).
   */
  private readonly done = new Set<string>();
  private userMessages = 0;
  private planUpdates = 0;
  /** Text streamed since the last tool or closed piece, to close at a steer. */
  private openText = "";
  private lastError: string | null = null;
  private contextUsed = 0;
  private contextWindow = 0;
  /** The context use when the compaction under way began: Codex reports the smaller one before it ends. */
  private compactingFrom: number | null = null;
  /** The status line says Codex is trying again (an `error` it retries), until the turn's next news. */
  private retrying = false;
  /** The thread's tokens so far, as Codex last said (`total`): what a turn spent is how far they rose in it. */
  private threadTokens: number | null = null;
  /** How far they rose in the running turn's news; null for one whose tokens are not known (`midway`). */
  private turnTokens: number | null = 0;

  constructor(options: StreamOptions) {
    this.cwd = options.cwd;
    this.now = options.now ?? Date.now;
    this.calledAbout = options.calledAbout ?? (() => undefined);
    this.heardLate = options.heardLate ?? (() => undefined);
    const progress = options.progress ?? (() => undefined);
    this.live = new LiveOutput(progress, { now: this.now });
    this.background = options.background ?? (() => undefined);
  }

  get turn(): string | null {
    return this.turnId;
  }

  /** A native user opener, rather than a synthetic compaction turn. */
  get hasUserMessages(): boolean {
    return this.userMessages > 0;
  }

  /** The context use known so far. */
  get usage(): ContextUsage | undefined {
    return this.contextUsed > 0 && this.contextWindow > 0 ? { used: this.contextUsed, max: this.contextWindow } : undefined;
  }

  /**
   * A turn starts: what was open belonged to the last one, and so did what it reported.
   * `midway`: one already under way, whose tokens before now the bridge never heard, so
   * it says none.
   */
  beginTurn(turnId: string, midway = false): void {
    this.turnId = turnId;
    this.tools.clear();
    this.live.clear();
    this.messages.clear();
    this.reasoned.clear();
    this.done.clear();
    this.userMessages = 0;
    this.planUpdates = 0;
    this.openText = "";
    this.lastError = null;
    this.compactingFrom = null;
    this.retrying = false;
    this.turnTokens = midway ? null : 0;
  }

  /**
   * Turns ran that the bridge heard nothing of (while the connection to Codex was down):
   * the thread's total moved without it, so the next news counts from its own request.
   */
  forgetTotal(): void {
    this.threadTokens = null;
  }

  /** The connection to Codex dropped: what streams on after it comes back has a gap in it. */
  connectionLost(): void {
    for (const open of [...this.messages.values(), ...this.reasoned.values()]) open.live = false;
  }

  /**
   * Items of the running turn that the stored history already holds, read when the
   * bridge started following it: their completion is not reported again.
   */
  known(items: readonly Item[]): void {
    for (const item of items) {
      if (item.type === "userMessage") this.userMessages += 1;
      else this.done.add(item.id);
    }
  }

  map(method: string, params: Item): ProviderEvent[] {
    // News of the turn's items, or its end, says Codex went on after trying again.
    if (this.retrying && (method.startsWith("item/") || method.startsWith("turn/"))) {
      this.retrying = false;
      return [{ type: "status", text: this.compactingFrom !== null ? "Compacting the conversation…" : "" }, ...this.mapped(method, params)];
    }
    return this.mapped(method, params);
  }

  private mapped(method: string, params: Item): ProviderEvent[] {
    switch (method) {
      case "item/started":
        return this.started(params.item ?? {});
      case "item/completed":
        return this.completed(params.item ?? {});
      case "item/agentMessage/delta":
        return this.textDelta(params.itemId, params.delta);
      case "item/commandExecution/outputDelta":
        if (typeof params.itemId === "string" && typeof params.delta === "string" && this.tools.has(params.itemId)) this.live.append(params.itemId, params.delta);
        return [];
      case "item/reasoning/summaryPartAdded":
        return this.reasoningPart(params.itemId, params.summaryIndex);
      case "item/reasoning/summaryTextDelta":
        return this.reasoningDelta(params.itemId, params.delta);
      case "turn/plan/updated":
        return this.plan(params);
      case "thread/tokenUsage/updated":
        return this.tokenUsage(params.tokenUsage ?? {}, params.turnId);
      case "thread/name/updated":
        return typeof params.threadName === "string" && params.threadName.trim() !== "" ? [{ type: "title", title: params.threadName.trim() }] : [];
      case "error": {
        const message = typeof params.error?.message === "string" ? params.error.message : "Codex hit an error.";
        if (params.willRetry) {
          // Nothing else takes the line off once it went on: the next news of the turn does (`map`).
          this.retrying = true;
          return [{ type: "status", text: `Codex is trying again: ${message}` }];
        }
        this.lastError = message;
        return [];
      }
      case "model/rerouted":
        return [{ type: "notice", level: "warn", text: `Codex moved this turn from ${params.fromModel} to ${params.toModel}.` }];
      case "turn/completed":
        return this.complete(params.turn ?? {});
      default:
        return [];
    }
  }

  // MARK: Items

  private started(item: Item): ProviderEvent[] {
    if (typeof item.id !== "string" || this.done.has(item.id)) return [];
    switch (item.type) {
      case "userMessage": {
        this.userMessages += 1;
        // The first opened the turn; a later one joined it.
        return this.userMessages > 1 ? this.closeText() : [];
      }
      case "agentMessage":
        this.messages.set(item.id, { streamed: "", live: true });
        return [];
      case "reasoning":
        this.reasoned.set(item.id, { streamed: "", live: true });
        return [];
      case "contextCompaction":
        this.compactingFrom = this.contextUsed;
        return [{ type: "status", text: "Compacting the conversation…" }];
      default:
        return isToolItem(item) ? this.openTool(item) : [];
    }
  }

  private completed(item: Item): ProviderEvent[] {
    if (typeof item.id !== "string" || this.done.has(item.id)) return [];
    this.done.add(item.id);
    switch (item.type) {
      case "userMessage":
        return [];
      case "agentMessage":
        return this.messageDone(item);
      case "reasoning": {
        const summary = Array.isArray(item.summary) ? item.summary.filter((part: unknown) => typeof part === "string" && part !== "") : [];
        const rest = unstreamed(summary.join("\n\n"), this.reasoned.get(item.id));
        this.reasoned.delete(item.id);
        return rest === "" ? [] : [{ type: "reasoning", text: rest }];
      }
      case "contextCompaction": {
        // A turn with no message is one `/compact` started; in any other Codex did it
        // by itself, as the context filled up. Without its start (the bridge was not
        // listening) the context use from before it is not known.
        const compacted: ProviderEvent = { type: "compacted", trigger: this.userMessages === 0 ? "manual" : "auto" };
        if (this.compactingFrom !== null && this.compactingFrom > 0) compacted.tokensBefore = this.compactingFrom;
        this.compactingFrom = null;
        return [{ type: "status", text: "" }, compacted];
      }
      default:
        return isToolItem(item) ? this.closeTool(item) : [];
    }
  }

  private openTool(item: Item): ProviderEvent[] {
    if (this.tools.has(item.id)) return [];
    const tool = gatewayTool(item, this.calledAbout(item));
    if (!tool) return [];
    const command = item.type === "commandExecution" && typeof tool.args.command === "string" ? tool.args.command : undefined;
    const processId = typeof item.processId === "string" ? item.processId : undefined;
    this.tools.set(item.id, { ...tool, startedAt: this.now(), ...(command !== undefined ? { command } : {}), ...(processId ? { processId } : {}) });
    this.openText = "";
    return [withContext({ type: "tool.start", id: item.id, name: tool.name, args: tool.args }, tool.context)];
  }

  private closeTool(item: Item): ProviderEvent[] {
    // One that started before the bridge listened opens here too.
    const events = this.tools.has(item.id) ? [] : this.openTool(item);
    const open = this.tools.get(item.id);
    if (!open) return events;
    this.tools.delete(item.id);
    this.live.end(item.id);
    // The args again, from the whole item: a command's or a change's can grow while it
    // runs, and a wait comes to be about those that ended meanwhile.
    const tool = gatewayTool(item, this.calledAbout(item)) ?? open;
    const duration = typeof item.durationMs === "number" ? item.durationMs / 1000 : (this.now() - open.startedAt) / 1000;
    const end: ProviderEvent = withContext(
      { type: "tool.end", id: item.id, name: tool.name, args: tool.args, result: gatewayResult(item, this.cwd), durationSeconds: Math.max(0, Math.round(duration * 1000) / 1000) },
      tool.context,
    );
    return [...events, end];
  }

  // MARK: Text

  private textDelta(itemId: unknown, delta: unknown): ProviderEvent[] {
    if (typeof itemId !== "string" || typeof delta !== "string" || delta === "" || this.done.has(itemId)) return [];
    // Joined in the middle, or there was a gap: the rest comes when it completes.
    const message = this.messages.get(itemId);
    if (!message?.live) return [];
    message.streamed += delta;
    this.openText += delta;
    return [{ type: "text", text: delta }];
  }

  private messageDone(item: Item): ProviderEvent[] {
    const text = typeof item.text === "string" ? item.text : "";
    const streamed = this.messages.get(item.id)?.streamed ?? "";
    const questions = streamed === "" ? asyncQuestions(item) : [];
    if (questions.length > 0) {
      this.messages.delete(item.id);
      return [...this.closeText(), { type: "questions", id: item.id, questions, text }];
    }
    const rest = unstreamed(text, this.messages.get(item.id));
    this.messages.delete(item.id);
    const events: ProviderEvent[] = [];
    if (rest !== "") {
      this.openText += rest;
      events.push({ type: "text", text: rest });
    }
    if (item.phase === "commentary") events.push(...this.closeText());
    return events;
  }

  /** Closes the text written so far, so what comes next is a new piece. */
  private closeText(): ProviderEvent[] {
    const text = this.openText;
    this.openText = "";
    return text.trim() === "" ? [] : [{ type: "commentary", text, alreadyStreamed: true }];
  }

  private reasoningPart(itemId: unknown, index: unknown): ProviderEvent[] {
    if (typeof itemId !== "string" || this.done.has(itemId)) return [];
    const reasoning = this.reasoned.get(itemId);
    // Parts after the first are separate paragraphs.
    if (!reasoning?.live || typeof index !== "number" || index === 0 || reasoning.streamed === "") return [];
    reasoning.streamed += "\n\n";
    return [{ type: "reasoning", text: "\n\n" }];
  }

  private reasoningDelta(itemId: unknown, delta: unknown): ProviderEvent[] {
    if (typeof itemId !== "string" || typeof delta !== "string" || delta === "" || this.done.has(itemId)) return [];
    const reasoning = this.reasoned.get(itemId);
    if (!reasoning?.live) return [];
    reasoning.streamed += delta;
    return [{ type: "reasoning", text: delta }];
  }

  // MARK: Plans and usage

  /** Each update of Codex's plan is a to-do row, as Claude's TodoWrite is. */
  private plan(params: Item): ProviderEvent[] {
    const steps: Item[] = Array.isArray(params.plan) ? params.plan : [];
    if (steps.length === 0) return [];
    this.planUpdates += 1;
    const id = `plan-${params.turnId ?? this.turnId ?? "turn"}-${this.planUpdates}`;
    const todos = steps.map((step) => ({ content: String(step.step ?? ""), status: step.status === "inProgress" ? "in_progress" : step.status === "completed" ? "completed" : "pending" }));
    const done = todos.filter((todo) => todo.status === "completed").length;
    const context = `${done} of ${todos.length} done`;
    const output = todos.map((todo) => `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "→" : "○"} ${todo.content}`).join("\n");
    const args = { todos };
    return [
      { type: "tool.start", id, name: "todo", args, context },
      { type: "tool.end", id, name: "todo", args, context, result: { output: typeof params.explanation === "string" && params.explanation ? `${params.explanation}\n${output}` : output } },
    ];
  }

  private tokenUsage(usage: Item, turnId: unknown): ProviderEvent[] {
    const last = usage.last ?? {};
    if (typeof last.totalTokens === "number" && last.totalTokens > 0) this.contextUsed = last.totalTokens;
    this.spending(usage, turnId);
    if (typeof usage.modelContextWindow === "number" && usage.modelContextWindow > 0) this.contextWindow = usage.modelContextWindow;
    const known = this.usage;
    return known ? [{ type: "usage", usage: known }] : [];
  }

  /**
   * What the running turn has spent, from the thread's total (each request's input, its
   * cached input in it, and output, as Codex counts them once each): how far it rose in
   * the turn's news. Said again unchanged (as Codex does when the account's limits
   * change), it adds nothing. The first news since the bridge took up the thread, with no
   * total before it to rise from, adds the request it tells of (`last`). News of another
   * turn only moves the total.
   */
  private spending(usage: Item, turnId: unknown): void {
    const total = tokenCount(usage.total);
    if (total === null) return;
    const ofTurn = this.turnId !== null && (turnId === undefined || turnId === this.turnId);
    if (ofTurn && this.turnTokens !== null) {
      const rise = this.threadTokens === null ? (tokenCount(usage.last) ?? 0) : total - this.threadTokens;
      if (rise > 0) this.turnTokens += rise;
    }
    this.threadTokens = total;
  }

  /** What the turn ending spent, when known: its tokens, and the time Codex gives it. */
  private spent(turn: Partial<Turn>): { spent?: { tokens?: number; seconds?: number } } {
    const spent: { tokens?: number; seconds?: number } = {};
    if (this.turnTokens !== null && this.turnTokens > 0) spent.tokens = this.turnTokens;
    if (typeof turn.durationMs === "number" && Number.isFinite(turn.durationMs) && turn.durationMs >= 0) spent.seconds = turn.durationMs / 1000;
    this.turnTokens = 0;
    return spent.tokens === undefined && spent.seconds === undefined ? {} : { spent };
  }

  // MARK: The end of a turn

  /** `turn/completed`: closes what is still open and ends the turn. */
  complete(turn: Partial<Turn>): ProviderEvent[] {
    const events: ProviderEvent[] = [];
    for (const [id, open] of this.tools) {
      // A command Codex ended its turn without waiting for runs on in the background: its
      // row has what it printed so far, and the rest goes to the subagents line.
      if (turn.status === "completed" && open.command !== undefined) {
        const tail = this.live.tail(id);
        const output = tail?.output;
        this.background({
          id, turn: this.turnId, command: open.command, startedAt: open.startedAt, ...(open.processId ? { processId: open.processId } : {}),
          ...(output ? { output, outputTruncated: tail!.truncated } : {}),
        });
        events.push(withContext({ type: "tool.end", id, name: open.name, args: open.args, result: { output: output ? `${output.replace(/\n?$/, "\n")}…still running in the background.` : "Still running in the background." } }, open.context));
        continue;
      }
      // Tools that never reported back (the turn was cut short) close as stopped, with what
      // a command printed live, which its row showed and would lose to that line alone.
      const output = this.live.tail(id)?.output;
      events.push(withContext({ type: "tool.end", id, name: open.name, args: open.args, result: { status: "error", error: "Stopped before it finished.", ...(output ? { output } : {}) } }, open.context));
    }
    this.tools.clear();
    this.live.clear();
    this.messages.clear();
    this.openText = "";
    const spent = this.spent(turn);
    const usage = { ...(this.usage ? { usage: this.usage } : {}), ...spent, ...(spent.spent?.tokens !== undefined && typeof turn.id === "string" ? { agentTurn: turn.id } : {}) };
    switch (turn.status) {
      case "interrupted":
        events.push({ type: "turn.end", status: "interrupted", ...usage });
        break;
      case "failed": {
        const error = turn.error?.message || this.lastError || "Codex stopped with an error.";
        const detail = turn.error?.additionalDetails ? ` ${turn.error.additionalDetails}` : "";
        events.push({ type: "turn.end", status: "error", error: `${error}${detail}`, retryable: true, ...usage });
        break;
      }
      default:
        events.push({ type: "turn.end", status: "complete", ...usage });
    }
    this.turnId = null;
    return events;
  }

  /**
   * What the bridge missed of `turn` while it was not listening (the connection to
   * Codex dropped): every item not reported yet, whole, then the end if it is over.
   */
  reconcile(turn: Turn): ProviderEvent[] {
    const events: ProviderEvent[] = [];
    let users = 0;
    for (const item of turn.items as Item[]) {
      if (item.type === "userMessage") {
        users += 1;
        if (users > this.userMessages) events.push(...this.started(item));
        continue;
      }
      if (this.done.has(item.id)) continue;
      this.heardLate(item);
      events.push(...this.completed(item));
    }
    if (turn.status !== "inProgress") events.push(...this.complete(turn));
    return events;
  }
}

function withContext<T extends ProviderEvent & { context?: string }>(event: T, context: string | undefined): T {
  if (context) event.context = context;
  return event;
}

/** What of an item's whole text was not streamed: all of it when nothing was; nothing when what streamed is not how it begins. */
function unstreamed(full: string, streaming: Streaming | undefined): string {
  const streamed = streaming?.streamed ?? "";
  return full.startsWith(streamed) ? full.slice(streamed.length) : "";
}

// MARK: Rate limits

/** A window's length as people say it. */
export function windowName(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return "";
  if (minutes === 10_080) return "weekly";
  if (minutes === 1440) return "daily";
  if (minutes < 1440) return `${Math.round(minutes / 60)}-hour`;
  return `${Math.round(minutes / 1440)}-day`;
}

function resets(resetsAt: number | null | undefined, timeZone: string | undefined): string {
  if (typeof resetsAt !== "number") return "";
  const when = new Date(resetsAt * 1000);
  return `; it resets ${when.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone })}`;
}

/**
 * Warnings for a usage limit at 80% or more, or reached, each once per window and
 * reset time (`warned` remembers which were given).
 */
export function rateLimitNotices(limits: RateLimitSnapshot, warned: Set<string>, timeZone?: string): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  const named = limits.limitName && limits.limitId !== "codex" ? limits.limitName : "Codex";
  const windows = [limits.primary, limits.secondary].filter((window): window is RateLimitWindow => !!window && typeof window.usedPercent === "number");
  if (limits.rateLimitReachedType) {
    const fullest = [...windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
    const key = `${limits.limitId}:reached:${fullest?.resetsAt ?? ""}`;
    if (!warned.has(key)) {
      warned.add(key);
      events.push({ type: "notice", level: "warn", text: `You have reached your ${named} usage limit${resets(fullest?.resetsAt, timeZone)}.` });
    }
    return events;
  }
  for (const window of windows) {
    const percent = Math.round(window.usedPercent);
    if (percent < 80) continue;
    const key = `${limits.limitId}:${window.windowDurationMins}:${window.resetsAt}`;
    if (warned.has(key)) continue;
    warned.add(key);
    const name = windowName(window.windowDurationMins);
    events.push({ type: "notice", level: "warn", text: `You have used ${percent}% of your ${name ? `${name} ` : ""}${named} limit${resets(window.resetsAt, timeZone)}.` });
  }
  return events;
}

/** Codex's plans by the names OpenAI gives them, where its own id is not one. */
const planNames: Record<string, string> = {
  // The $100 Pro, as the user calls it (2026-11-01: "Codex Pro 100").
  prolite: "Pro 100",
  promax: "Pro Max",
  self_serve_business_prolite: "Business",
  self_serve_business_usage_based: "Business",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
};

/** A balance as Codex gives it ("62500.0000000000") as people write it ("62,500"). */
function amount(balance: string): string {
  const value = Number(balance);
  return Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : balance;
}

/** What `account/rateLimits/read` answers, as far as `/usage` reads it. */
export interface AccountRateLimits {
  rateLimits?: RateLimitSnapshot | null;
  /** Each limit Codex meters by its id (`codex` first), where it says. */
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot | undefined> | null;
}

/** What Codex says turns work away, where no limit it gives shows as used up. */
const reachedNotes: Record<string, string> = {
  workspace_owner_credits_depleted: "The workspace's credits are used up.",
  workspace_member_credits_depleted: "The workspace's credits are used up.",
  workspace_owner_usage_limit_reached: "The workspace's usage limit is reached.",
  workspace_member_usage_limit_reached: "The workspace's usage limit is reached.",
};

/**
 * `/usage` from what Codex says of the account's limits: each metered limit's windows,
 * Codex's own first, those of another limit (a model with its own quota) by its name,
 * and the spending limit a workspace sets; what turns work away is said even where no
 * window shows it.
 */
export function usageReport(account: AccountRateLimits): UsageReport {
  const metered = Object.entries(account.rateLimitsByLimitId ?? {}).flatMap(([id, limits]) => (limits ? [{ id, limits }] : []));
  const all = metered.length > 0 ? metered.sort((a, b) => Number(b.id === "codex") - Number(a.id === "codex")) : account.rateLimits ? [{ id: account.rateLimits.limitId ?? "codex", limits: account.rateLimits }] : [];
  const limits: UsageLimit[] = [];
  const notes: string[] = [];
  for (const { id, limits: snapshot } of all) {
    const named = snapshot.limitName && id !== "codex" ? ` ${snapshot.limitName}` : "";
    const own: UsageLimit[] = [];
    for (const window of [snapshot.primary, snapshot.secondary]) {
      if (!window || typeof window.usedPercent !== "number") continue;
      const name = windowName(window.windowDurationMins);
      own.push({
        name: `${name || "usage"}${named}`,
        percent: window.usedPercent,
        resetsAt: window.resetsAt ?? null,
        ...(window.usedPercent >= 100 ? { reached: true } : {}),
        ...(window.windowDurationMins && window.windowDurationMins > 0 ? { windowSeconds: window.windowDurationMins * 60 } : {}),
      });
    }
    const spending = snapshot.individualLimit;
    if (spending && typeof spending.remainingPercent === "number") {
      const used = Math.min(100, Math.max(0, 100 - spending.remainingPercent));
      own.push({
        name: `spending limit${named}`,
        percent: used,
        resetsAt: spending.resetsAt ?? null,
        ...(used >= 100 || snapshot.spendControlReached === true ? { reached: true } : {}),
      });
    }
    limits.push(...own);
    if (snapshot.rateLimitReachedType && !own.some((limit) => limit.reached)) {
      notes.push(reachedNotes[snapshot.rateLimitReachedType] ?? `The ${named ? named.trim() : "Codex"} usage limit is reached.`);
    }
  }
  const plan = all.find((entry) => entry.limits.planType && entry.limits.planType !== "unknown")?.limits.planType ?? undefined;
  const credits = all.map((entry) => entry.limits.credits).find((entry) => entry?.hasCredits && (entry.unlimited || entry.balance));
  if (credits) notes.push(credits.unlimited ? "Credits: unlimited." : `Credits left: ${amount(credits.balance!)}.`);
  const report: UsageReport = { limits };
  if (plan) report.plan = planNames[plan] ?? plan.replaceAll("_", " ");
  if (notes.length > 0) report.note = notes.join("\n");
  else if (limits.length === 0) report.note = "Codex says no limits apply to this account.";
  return report;
}

/** A count of Codex's tokens (`TokenUsageBreakdown`): input, its cached part in it, and output; null when it says none. */
function tokenCount(breakdown: Item | undefined): number | null {
  if (!breakdown || typeof breakdown !== "object") return null;
  if (typeof breakdown.inputTokens === "number" && typeof breakdown.outputTokens === "number") return breakdown.inputTokens + breakdown.outputTokens;
  return typeof breakdown.totalTokens === "number" ? breakdown.totalTokens : null;
}
