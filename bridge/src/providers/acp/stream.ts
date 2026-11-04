import { randomUUID } from "node:crypto";
import { LiveOutput } from "../liveOutput.ts";
import type { ContextUsage, ProviderEvent } from "../types.ts";
import { Unknowns } from "../unknowns.ts";
import type { SessionUpdate, ToolCallFields } from "./protocol.ts";
import { blockText, contentText, gatewayResult, gatewayTool, isFinished, merged, planTool, type GatewayTool, type Quirks, type ToolCall, type Unfinished } from "./tools.ts";

// A turn's `session/update` notifications as the bridge's neutral events.
//
// - Text and thinking stream as they come. Agents that number their messages get each
//   closed off when the next begins; the others' text runs on until a tool call.
// - A tool call is first heard of while the model still writes what to give it
//   (`pending`, no input yet), so its row starts when the agent begins to run it, asks
//   about it, or is done with it, whichever comes first. Its name is settled then and
//   kept; its args and result are whatever is known when it ends.
// - A question about something no `tool_call` told of starts no row: nothing would
//   ever end it. Cursor asks before a web search under an id of the question's own,
//   and tells of the search itself under another.
// - A plan is a to-do row each time the agent sends it.
// - A call the agent's provider says gets no row (`OwnTools.hidden`) makes no events.

export interface StreamOptions {
  cwd: string;
  quirks?: Quirks;
  /** Ids for rows the agent gives none (plans). */
  newID?: () => string;
  now?: () => number;
  /** A running command's output as the agent tells it in the call's updates (`tool.progress`), sent apart from `map`'s answer. */
  progress?: (event: ProviderEvent) => void;
  /** Called once for each kind of update the stream does not know, for the log. */
  unknown?: (kind: string) => void;
}

/** The updates the protocol has (`SessionUpdate`) that make no event: the session reads the ones it needs itself. */
const quiet = new Set([
  "user_message_chunk",
  "available_commands_update",
  "config_option_update",
  "current_mode_update",
  "session_info_update",
  "subagent_spawned",
  "subagent_state_update",
]);

interface Row {
  call: ToolCall;
  /** As its row was started; null until it is. */
  shown: GatewayTool | null;
  startedAt: number;
  /** The person on the phone said no to it. */
  denied: boolean;
  /** The agent asked before running it and has no yes yet: it has not run. */
  held: boolean;
  done: boolean;
  /** It gets no row: decided when its row would have started. */
  hidden: boolean;
}

type ToolEvent = Extract<ProviderEvent, { type: "tool.start" | "tool.end" }>;

function withContext<T extends ToolEvent>(event: T, context: string | undefined): T {
  if (context) event.context = context;
  return event;
}

export class AcpStream {
  /** The context window as last reported; null until the agent says. */
  usage: ContextUsage | null = null;
  private readonly cwd: string;
  private readonly quirks: Quirks;
  private readonly newID: () => string;
  private readonly now: () => number;
  private readonly rows = new Map<string, Row>();
  private readonly live: LiveOutput;
  private readonly unknowns: Unknowns;
  /** The message being streamed, for agents that number theirs, and its text so far. */
  private message: string | null = null;
  private text = "";

  constructor(options: StreamOptions) {
    this.cwd = options.cwd;
    this.quirks = options.quirks ?? {};
    this.newID = options.newID ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.live = new LiveOutput(options.progress ?? (() => {}), { now: this.now });
    this.unknowns = new Unknowns(options.unknown ?? (() => {}), quiet);
  }

  map(update: SessionUpdate): ProviderEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = update.content?.type === "text" ? blockText(update.content) : "";
        if (text === "" || this.quirks.junkText?.test(text)) return [];
        const events = update.messageId && this.message && update.messageId !== this.message ? this.closeText() : [];
        this.message = update.messageId ?? this.message;
        this.text += text;
        return [...events, { type: "text", text }];
      }
      case "agent_thought_chunk": {
        const text = update.content?.type === "text" ? blockText(update.content) : "";
        return text === "" ? [] : [{ type: "reasoning", text }];
      }
      case "tool_call":
      case "tool_call_update":
        return typeof update.toolCallId === "string" ? this.tool(update) : [];
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        if (entries.length === 0) return [];
        const { tool, result } = planTool(entries);
        const id = `plan-${this.newID()}`;
        this.text = "";
        return [
          withContext({ type: "tool.start", id, name: tool.name, args: tool.args }, tool.context),
          withContext({ type: "tool.end", id, name: tool.name, args: tool.args, result }, tool.context),
        ];
      }
      case "usage_update":
        // Nothing used is what a turn stopped before it reached the model reports (OpenCode), not an empty context.
        if (typeof update.used !== "number" || typeof update.size !== "number" || update.size <= 0 || update.used <= 0) return [];
        this.usage = { used: update.used, max: update.size };
        return [{ type: "usage", usage: this.usage }];
      default:
        this.unknowns.note((update as { sessionUpdate?: unknown }).sessionUpdate);
        return [];
    }
  }

  /**
   * The agent asks before a call: the call as far as it is known, with what the
   * question adds (the change, often only told here), and its row when not started yet.
   * For a call the agent never told of, only what the question says, and no row.
   */
  asked(fields: ToolCallFields): { events: ProviderEvent[]; call: ToolCall; tool: GatewayTool; announced: boolean } {
    const known = this.rows.get(fields.toolCallId);
    if (!known) {
      const call = merged(undefined, fields);
      return { events: [], call, tool: gatewayTool(call, this.quirks.own), announced: false };
    }
    // What the tool was given stays as the call told it: a question may carry something
    // else there (OpenCode's does). So does its kind (Cursor asks about a delete as an edit).
    const given = known.call.rawInput;
    const told = given && typeof given === "object" && Object.keys(given).length > 0;
    const row = this.row({ ...fields, ...(told ? { rawInput: undefined } : {}), ...(known.call.kind ? { kind: undefined } : {}) });
    row.held = true;
    const events = row.shown || row.done || row.hidden ? [] : this.start(row);
    return { events, call: row.call, tool: row.shown ?? gatewayTool(row.call, this.quirks.own), announced: true };
  }

  /** The person said no to a call: its row says so when it ends. */
  denied(toolCallID: string): void {
    const row = this.rows.get(toolCallID);
    if (row) row.denied = true;
  }

  /** The person said yes to a call: from here on it may be running. */
  allowed(toolCallID: string): void {
    const row = this.rows.get(toolCallID);
    if (row) row.held = false;
  }

  /**
   * The turn is over: rows still open close as stopped, and nothing is carried into the
   * next. A call nobody had said yes to yet closes as one that never ran.
   */
  endTurn(): ProviderEvent[] {
    const events = [...this.rows.values()].filter((row) => row.shown && !row.done).map((row) => this.finish(row, row.denied ? "denied" : row.held ? "held" : "stopped"));
    this.rows.clear();
    this.live.clear();
    this.message = null;
    this.text = "";
    return events;
  }

  private row(fields: ToolCallFields): Row {
    const known = this.rows.get(fields.toolCallId);
    if (known) {
      known.call = merged(known.call, fields);
      return known;
    }
    const row: Row = { call: merged(undefined, fields), shown: null, startedAt: 0, denied: false, held: false, done: false, hidden: false };
    this.rows.set(fields.toolCallId, row);
    return row;
  }

  private tool(fields: ToolCallFields): ProviderEvent[] {
    const known = this.rows.get(fields.toolCallId);
    if (known?.done || known?.hidden) return [];
    const row = this.row(fields);
    const events: ProviderEvent[] = [];
    const finished = isFinished(row.call);
    if (!row.shown && (finished || row.call.status === "in_progress")) events.push(...this.start(row));
    if (finished && row.shown) events.push(this.finish(row, row.denied ? "denied" : undefined));
    // A command at work: what it printed so far, where the agent tells it in its updates.
    else if (row.shown?.name === "terminal" && !row.done) {
      const id = row.call.toolCallId;
      // Its row's start, given back here, goes out first; then what the call tells by
      // then, an update told in the same step included, not what it told here.
      if (events.length > 0) queueMicrotask(() => { if (!row.done && this.rows.get(id) === row) this.showOutput(row); });
      else this.showOutput(row);
    }
    return events;
  }

  /** What a command at work printed so far, as its call tells it now: its row's live output. */
  private showOutput(row: Row): void {
    const output = contentText(row.call.content) || (typeof row.call.rawOutput === "string" ? row.call.rawOutput : "");
    if (output !== "") this.live.replace(row.call.toolCallId, output);
  }

  /** The row's start; nothing for a call that gets no row, which is settled here. */
  private start(row: Row): ProviderEvent[] {
    if (this.quirks.own?.hidden?.(row.call)) {
      row.hidden = true;
      return [];
    }
    row.shown = gatewayTool(row.call, this.quirks.own);
    row.startedAt = this.now();
    this.text = "";
    return [withContext({ type: "tool.start", id: row.call.toolCallId, name: row.shown.name, args: row.shown.args }, row.shown.context)];
  }

  private finish(row: Row, unfinished?: Unfinished): ProviderEvent {
    row.done = true;
    // Stopped while it ran: what it printed live stays its output, beside that it was
    // stopped, rather than that line alone in its place.
    const printed = unfinished === "stopped" ? this.live.tail(row.call.toolCallId)?.output : undefined;
    this.live.end(row.call.toolCallId);
    // What is known now, under the name the row started with.
    const tool: GatewayTool = { ...gatewayTool(row.call, this.quirks.own), name: row.shown!.name };
    const seconds = Math.round((this.now() - row.startedAt) / 10) / 100;
    return withContext(
      {
        type: "tool.end",
        id: row.call.toolCallId,
        name: tool.name,
        args: tool.args,
        result: printed ? { ...(gatewayResult(row.call, tool, this.cwd, this.quirks, unfinished) as Record<string, unknown>), output: printed } : gatewayResult(row.call, tool, this.cwd, this.quirks, unfinished),
        ...(seconds > 0 ? { durationSeconds: seconds } : {}),
      },
      tool.context,
    );
  }

  /** Closes the message streamed so far as a piece of its own. */
  private closeText(): ProviderEvent[] {
    const text = this.text;
    this.text = "";
    return text.trim() === "" ? [] : [{ type: "commentary", text, alreadyStreamed: true }];
  }
}
