import { basename } from "node:path";
import { LiveOutput } from "../liveOutput.ts";
import { piTokens } from "../spent.ts";
import type { ContextUsage, ProviderEvent } from "../types.ts";
import type { PiEvent, PiMessage, PiMessageDelta, PiRecord, PiSessionStats, PiUiRequest } from "./protocol.ts";
import { errorText, gatewayResult, gatewayTool, isAbortError, stoppedResult, type GatewayTool, type ToolOutcome } from "./tools.ts";

// What one Pi process prints, as the bridge's neutral events (providers/types.ts). One
// of these per process; the session feeds it every record that is not an answer to a
// command, in order, and it keeps what it needs across them: whether a turn is open,
// which tools run, what of a message has been said.
//
// It knows two things about where it is. A turn is open from `beginTurn()` (the session
// is about to write a `prompt` or a `compact`) until its `turn.end`. A run is under way
// from Pi's `agent_start` to its `agent_settled`.
//
// - A run settles the turn: `agent_settled`, not `agent_end`, which retries, a
//   compaction and queued messages can follow. A turn that ends some other way (Pi
//   handled or refused the prompt, `compact` answered, the process ended) is ended by the
//   session with `finish()`.
// - A run that starts with no turn open is one Pi began by itself (an extension sent it a
//   message): `turn.begin` with no opening line.
// - Text and thinking stream piece by piece (`message_update`); `message_end` has the
//   whole message, and what of it never streamed is said then.
// - Text written before tool calls is closed with a `commentary` event when its message
//   ends, so the reply that follows does not run into it. So is what was written before
//   a message Pi took into the run (a steer), and before a retry.
// - A tool row opens with `tool_execution_start` and closes with `tool_execution_end`.
//   Two calls of one message run at once, and their records interleave. The calls a
//   `codemode` script makes carry `parentToolCallId` and make no rows: the script's does.
// - What an extension's command says (`notify`, or a message of its own) while no run is
//   under way is its turn's reply: such a command has no other output in RPC mode.
// - Outside a turn nothing is said: no text, thinking, tool row or notice.

export interface StreamOptions {
  /** The thread's folder, for paths in diffs. */
  cwd: string;
  /** Called once for each kind of record the stream does not know, for the log. */
  unknown?: (type: string) => void;
  /** A running command's live output (`tool.progress`), from `tool_execution_update`, sent apart from `map`'s answer. */
  progress?: (event: ProviderEvent) => void;
}

interface OpenTool extends GatewayTool {
  /** Pi's own name for the tool, and its arguments as Pi gave them. */
  toolName: string;
  input: Record<string, unknown>;
}

type TurnEnd = Extract<ProviderEvent, { type: "turn.end" }>;

/** Records that make no event: the session reads the ones it needs itself. */
const quiet = new Set([
  "response",
  "agent_end",
  "turn_start",
  "turn_end",
  "queue_update",
  "entry_appended",
  "thinking_level_changed",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "bash_execution_update",
]);

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** What of `whole` was not said yet, when `said` is how it starts. */
function rest(said: string, whole: string): string {
  if (said === "") return whole;
  return whole.startsWith(said) ? whole.slice(said.length) : "";
}

/** A message's text, whether its content is a string or blocks. */
function messageText(message: PiMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((block) => (block?.type === "text" ? (text(block.text) ?? "") : ""))
    .filter((part) => part !== "")
    .join("\n");
}

function withContext<T extends ProviderEvent & { context?: string }>(event: T, context: string | undefined): T {
  if (context) event.context = context;
  return event;
}

export class PiStream {
  private readonly cwd: string;
  private readonly reportUnknown: (type: string) => void;
  private readonly seenUnknown = new Set<string>();
  private turnOpen = false;
  /** What the open turn's requests spent so far (each assistant message's `usage`). */
  private spentTokens = 0;
  private running = false;
  private readonly tools = new Map<string, OpenTool>();
  /** What the commands running print, as Pi tells it (`tool_execution_update`). */
  private readonly live: LiveOutput;
  /** What was said of each block of the assistant message that streams, by its place in the message. */
  private readonly said = new Map<number, string>();
  /** Blank space at the end of the thinking block that streams, held back until more follows. */
  private held = "";
  /** Text said since the last tool or closed piece, to close before what comes next. */
  private openText = "";
  /** Thinking was said since then, so another block of it is a new paragraph. */
  private openThinking = false;
  /** How the run's last assistant message ended. */
  private last: { stopReason: string; error: string } | null = null;
  private contextUsed = 0;
  private contextWindow = 0;

  constructor(options: StreamOptions) {
    this.cwd = options.cwd;
    this.reportUnknown = options.unknown ?? (() => {});
    this.live = new LiveOutput(options.progress ?? (() => {}));
  }

  /** A turn is open: one the session began, or one Pi began by itself. */
  get inTurn(): boolean {
    return this.turnOpen;
  }

  /** Pi is in a run: it has said `agent_start` and not yet `agent_settled`. */
  get inRun(): boolean {
    return this.running;
  }

  /** The context use known so far. */
  get usage(): ContextUsage | undefined {
    return this.contextUsed > 0 && this.contextWindow > 0 ? { used: this.contextUsed, max: this.contextWindow } : undefined;
  }

  /** The session starts a turn. One that joins a turn Pi began by itself changes nothing. */
  beginTurn(): void {
    if (this.turnOpen) return;
    this.turnOpen = true;
    this.spentTokens = 0;
    this.tools.clear();
    this.live.clear();
    this.said.clear();
    this.held = "";
    this.openText = "";
    this.openThinking = false;
    this.last = null;
  }

  map(line: PiRecord): ProviderEvent[] {
    const event = line as PiEvent;
    const type = text(event?.type);
    switch (type) {
      case "agent_start":
        this.running = true;
        this.last = null;
        if (this.turnOpen) return [];
        this.beginTurn();
        return [{ type: "turn.begin", user: "", host: { kind: "hidden", text: "" } }];
      case "agent_settled":
        return this.settled(event.aborted === true);
      case "message_start":
        return this.messageStart(event.message ?? {});
      case "message_update":
        return this.delta(event.assistantMessageEvent ?? {});
      case "message_end":
        return this.messageEnd(event.message ?? {});
      case "tool_execution_start":
        return this.toolStart(event);
      case "tool_execution_end":
        return this.toolEnd(event);
      case "tool_execution_update":
        this.toolUpdate(event);
        return [];
      case "compaction_start":
        return [{ type: "status", text: "Compacting the conversation…" }];
      case "compaction_end":
        return this.compactionEnd(event);
      case "auto_retry_start": {
        const count = typeof event.attempt === "number" && typeof event.maxAttempts === "number" ? ` (${event.attempt} of ${event.maxAttempts})` : "";
        const why = text(event.errorMessage) ? `: ${errorText(event.errorMessage!)}` : "";
        // What the failed attempt wrote is not the start of the next one's reply.
        return [...this.closeText(), { type: "status", text: `Pi is trying again${count}${why}` }];
      }
      case "auto_retry_end":
        return [{ type: "status", text: "" }];
      case "session_info_changed": {
        const name = text(event.name)?.trim();
        return name ? [{ type: "title", title: name }] : [];
      }
      case "extension_error": {
        if (!this.turnOpen) return [];
        const file = text(event.extensionPath) ? ` (${basename(event.extensionPath!)})` : "";
        return [{ type: "notice", level: "warn", text: `A Pi extension failed${file}: ${text(event.error) ?? "it gave no reason"}` }];
      }
      case "extension_ui_request":
        return this.shown(line as PiUiRequest);
      default:
        if (type !== undefined && !quiet.has(type) && !this.seenUnknown.has(type)) {
          this.seenUnknown.add(type);
          this.reportUnknown(type);
        }
        return [];
    }
  }

  // MARK: Messages

  private messageStart(message: PiMessage): ProviderEvent[] {
    if (message.role === "assistant") {
      this.said.clear();
      this.held = "";
      return [];
    }
    // The message that opened the run has nothing before it. One Pi took into the run (a
    // steer, a follow-up) ends what was being said. System and tool-result messages are
    // messages too, and say nothing here.
    return message.role === "user" ? this.closeText() : [];
  }

  private delta(change: PiMessageDelta): ProviderEvent[] {
    const index = typeof change.contentIndex === "number" ? change.contentIndex : 0;
    switch (change.type) {
      case "text_delta":
        return this.sayText(index, text(change.delta) ?? "");
      case "text_end":
        return this.sayText(index, rest(this.said.get(index) ?? "", text(change.content) ?? ""));
      case "thinking_start":
        this.held = "";
        return [];
      case "thinking_delta":
        return this.sayThinking(index, text(change.delta) ?? "");
      case "thinking_end": {
        const events = this.sayThinking(index, rest(this.said.get(index) ?? "", (text(change.content) ?? "").trimEnd()));
        this.held = "";
        return events;
      }
      default:
        // A tool call's pieces: its row opens when the tool starts, with its whole arguments.
        return [];
    }
  }

  private sayText(index: number, piece: string): ProviderEvent[] {
    if (!this.turnOpen || piece === "") return [];
    this.said.set(index, (this.said.get(index) ?? "") + piece);
    this.openText += piece;
    return [{ type: "text", text: piece }];
  }

  private sayThinking(index: number, piece: string): ProviderEvent[] {
    if (!this.turnOpen) return [];
    // OpenAI's summaries end each part with a blank line, which the finished block does
    // not have: blank space is said only once something follows it.
    const all = this.held + piece;
    const now = all.trimEnd();
    this.held = all.slice(now.length);
    if (now === "") return [];
    const before = this.said.get(index) ?? "";
    this.said.set(index, before + now);
    // A second block is a new paragraph.
    const lead = before === "" && this.openThinking ? "\n\n" : "";
    this.openThinking = true;
    return [{ type: "reasoning", text: lead + now }];
  }

  private messageEnd(message: PiMessage): ProviderEvent[] {
    if (message.role === "custom") {
      // An extension's command answering with a message of its own.
      const reply = message.display === true && this.turnOpen && !this.running ? messageText(message).trim() : "";
      return reply === "" ? [] : this.sayLine(reply);
    }
    if (message.role !== "assistant") return [];
    // What the request spent, for the turn's footer (feature turn_usage).
    if (this.turnOpen) this.spentTokens += piTokens(message.usage);
    const events: ProviderEvent[] = [];
    // The whole message: what of it never streamed is said now.
    const blocks = Array.isArray(message.content) ? message.content : [];
    blocks.forEach((block, index) => {
      const said = this.said.get(index) ?? "";
      if (block?.type === "text") events.push(...this.sayText(index, rest(said, text(block.text) ?? "")));
      else if (block?.type === "thinking") {
        this.held = "";
        events.push(...this.sayThinking(index, rest(said, (text(block.thinking) ?? "").trimEnd())));
      }
    });
    this.held = "";
    const stopReason = text(message.stopReason) ?? "";
    this.last = { stopReason, error: text(message.errorMessage) ?? "" };
    if (!this.turnOpen) return events;
    if (stopReason === "toolUse") events.push(...this.closeText());
    if (stopReason === "length") events.push({ type: "notice", level: "warn", text: "The reply was cut short: the model reached its output limit." });
    return events;
  }

  /** Closes the text said so far, so what comes next is a new piece. */
  private closeText(): ProviderEvent[] {
    const said = this.openText;
    this.openText = "";
    if (said.trim() === "") return [];
    // The thinking before it is stored with it.
    this.openThinking = false;
    return [{ type: "commentary", text: said, alreadyStreamed: true }];
  }

  /** A line of the reply from something other than the model. */
  private sayLine(line: string): ProviderEvent[] {
    const piece = this.openText === "" ? line : `\n${line}`;
    this.openText += piece;
    return [{ type: "text", text: piece }];
  }

  /** What an extension shows. Its dialogs are the session's to ask; only `notify` says something here. */
  private shown(request: PiUiRequest): ProviderEvent[] {
    if (request.method !== "notify" || !this.turnOpen) return [];
    const said = text(request.message)?.trim() ?? "";
    if (said === "") return [];
    if (!this.running) return this.sayLine(said);
    if (request.notifyType === "warning") return [{ type: "notice", level: "warn", text: said }];
    if (request.notifyType === "error") return [{ type: "notice", level: "error", text: said }];
    return [];
  }

  // MARK: Tools

  private toolStart(event: PiEvent): ProviderEvent[] {
    const id = text(event.toolCallId);
    const toolName = text(event.toolName);
    if (!this.turnOpen || !id || !toolName || text(event.parentToolCallId) || this.tools.has(id)) return [];
    const input = record(event.args) ?? {};
    const tool = gatewayTool(toolName, input);
    this.tools.set(id, { ...tool, toolName, input });
    this.openText = "";
    this.openThinking = false;
    return [withContext({ type: "tool.start", id, name: tool.name, args: tool.args }, tool.context)];
  }

  /** A command's output so far (`partialResult`, the whole of it each time): its row's live output. */
  private toolUpdate(event: PiEvent): void {
    const id = text(event.toolCallId);
    const open = id ? this.tools.get(id) : undefined;
    if (!id || !open || open.name !== "terminal") return;
    const partial = record((event as { partialResult?: unknown }).partialResult);
    const content = Array.isArray(partial?.content) ? partial.content : [];
    const output = content.map((block) => (record(block)?.type === "text" ? (text(record(block)?.text) ?? "") : "")).join("");
    if (output !== "") this.live.replace(id, output);
  }

  private toolEnd(event: PiEvent): ProviderEvent[] {
    const id = text(event.toolCallId);
    if (!id || text(event.parentToolCallId)) return [];
    // One whose start was missed opens here too.
    const events = this.tools.has(id) ? [] : this.toolStart(event);
    const open = this.tools.get(id);
    if (!open) return events;
    this.tools.delete(id);
    // What it printed live, for an end that says only that Stop ended it.
    const printed = this.live.tail(id)?.output;
    this.live.end(id);
    const result = record(event.result) ?? {};
    const outcome: ToolOutcome = {
      content: result.content,
      isError: event.isError === true || result.isError === true,
      ran: typeof event.durationMs === "number",
      details: result.details,
      structured: result.structuredContent,
    };
    const given = gatewayResult(open.toolName, open.input, outcome, this.cwd);
    // Stopped, with nothing of what it printed in its end ("Command aborted" alone): what
    // it showed live stays its output, as for one the turn's end closes (`finish`).
    const shown = given === stoppedResult && printed ? { ...stoppedResult, output: printed } : given;
    const end: ProviderEvent = withContext({ type: "tool.end", id, name: open.name, args: open.args, result: shown }, open.context);
    if (typeof event.durationMs === "number") end.durationSeconds = Math.max(0, event.durationMs / 1000);
    return [...events, end];
  }

  // MARK: Compaction and usage

  private compactionEnd(event: PiEvent): ProviderEvent[] {
    const events: ProviderEvent[] = [{ type: "status", text: "" }];
    const result = record(event.result);
    if (!result) {
      // One the user asked for fails its turn, with what `compact` answered. One Pi began
      // itself has nowhere else to say so. An aborted one was stopped on purpose.
      const why = text(event.errorMessage)?.replace(/^Compaction failed:\s*/, "");
      if (why && event.reason !== "manual" && event.aborted !== true) events.push({ type: "notice", level: "warn", text: `Pi could not compact the conversation: ${why}` });
      return events;
    }
    const compacted: ProviderEvent = { type: "compacted", trigger: event.reason === "manual" ? "manual" : "auto" };
    const before = typeof result.tokensBefore === "number" && result.tokensBefore > 0 ? result.tokensBefore : 0;
    if (before > 0) compacted.tokensBefore = before;
    this.openThinking = false;
    events.push(compacted);
    // Pi does not know the context's size again until the next reply; its own estimate
    // stands in, unless it is larger than what was there (it is, on a very small session).
    const after = result.estimatedTokensAfter;
    if (typeof after === "number" && after > 0 && after < (before || this.contextUsed) && this.contextWindow > 0) {
      this.contextUsed = after;
      events.push({ type: "usage", usage: { used: after, max: this.contextWindow } });
    }
    return events;
  }

  /**
   * An answer to `get_session_stats`: how full the context is, when Pi knows, against
   * the window of the model Pi runs on now. While Pi does not know (null right after a
   * compaction, 0 before the first reply) the use last known stands, and is said again
   * only when the window is another: the model was changed.
   */
  stats(data: PiSessionStats | undefined): ProviderEvent[] {
    const context = data?.contextUsage;
    const window = this.contextWindow;
    if (typeof context?.contextWindow === "number" && context.contextWindow > 0) this.contextWindow = context.contextWindow;
    if (typeof context?.tokens === "number" && context.tokens > 0) this.contextUsed = context.tokens;
    else if (this.contextWindow === window) return [];
    const known = this.usage;
    return known ? [{ type: "usage", usage: known }] : [];
  }

  // MARK: The end of a turn

  private settled(aborted: boolean): ProviderEvent[] {
    this.running = false;
    const last = this.last;
    // A Pi before 1.1.0 does not say `aborted`; its last message does, in one of two ways.
    if (aborted || last?.stopReason === "aborted" || (last?.stopReason === "error" && isAbortError(last.error))) return this.finish("interrupted");
    if (last?.stopReason === "error") return this.finish("error", errorText(last.error) || undefined);
    return this.finish("complete");
  }

  /**
   * Ends the open turn: the tools that never reported back close as stopped, then the
   * one `turn.end`. Nothing when no turn is open. The session calls it for a turn that
   * does not end with Pi settling.
   */
  finish(status: TurnEnd["status"], error?: string): ProviderEvent[] {
    if (!this.turnOpen) return [];
    const events: ProviderEvent[] = [];
    for (const [id, open] of this.tools) {
      // What a command printed live stays its output, beside that it was stopped.
      const output = this.live.tail(id)?.output;
      events.push(withContext({ type: "tool.end", id, name: open.name, args: open.args, result: output ? { ...stoppedResult, output } : stoppedResult }, open.context));
    }
    this.tools.clear();
    this.live.clear();
    this.said.clear();
    this.held = "";
    this.openText = "";
    this.openThinking = false;
    this.last = null;
    this.turnOpen = false;
    const usage = { ...(this.usage ? { usage: this.usage } : {}), ...(this.spentTokens > 0 ? { spent: { tokens: this.spentTokens } } : {}) };
    this.spentTokens = 0;
    if (status === "error") events.push({ type: "turn.end", status, error: error ?? "Pi stopped with an error.", retryable: true, ...usage });
    else events.push({ type: "turn.end", status, ...usage });
    return events;
  }
}
