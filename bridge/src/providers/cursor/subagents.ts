import { gatewayTool, merged, type OwnTools, type ToolCall } from "../acp/tools.ts";
import type { SessionUpdate } from "../acp/protocol.ts";
import type { SubagentInfo, SubagentStatus } from "../types.ts";

// Cursor's subagents, for the subagents line (feature `subagents`).
//
// The bridge says at hello that it takes Cursor's subagent sessions (`_meta.subagents`,
// ./options.ts). Cursor then tells of each subagent its Task tool starts, in the
// session that started it:
//
// - `subagent_spawned`: its own session's id (`subagentSessionId`), its type (`name`,
//   "generalPurpose"), the start of what it was asked (`task`), and in `_meta.cursor` the
//   Task call that started it and its model;
// - then what the subagent says and does, as `session/update`s of that session of its
//   own: pieces of reply, tool calls. Its questions name that session too;
// - `subagent_state_update`: its end, `completed`, `failed`, `cancelled` or
//   `disconnected`.
//
// A subagent the Task left running in the background (its call completes while it is
// still at work) keeps the turn open: Cursor answers the prompt once its subagents have
// ended (recorded with 2026.10.22). A subagent's own subagents are told of in the
// subagent's session. Cursor has no call to stop one subagent: Stop ends the turn, and
// Cursor ends its subagents with it.

/** How much of what a subagent answered is kept on its line. */
const resultLimit = 2000;
/** How much of what it is saying its line shows while it works. */
const summaryLimit = 200;
/**
 * How often what a subagent says as it says it goes out: Cursor sends its reply a few
 * words at a time, and each piece would be news for every device. Its tool calls and
 * its end go out at once, with what it said by then.
 */
const summaryEveryMs = 1000;

interface Known {
  info: SubagentInfo;
  /** The Task call that started it. */
  task?: string;
  /** What it is saying now: its pieces of reply since its last tool call. */
  saying: string;
  /** Its tool calls as far as told, by id. */
  calls: Map<string, ToolCall>;
  /** When its line last went out. */
  sent: number;
}

/** What Cursor calls a kind of subagent, as words: "generalPurpose" is "General purpose". */
function role(name: unknown): string | undefined {
  if (typeof name !== "string" || name.trim() === "" || name === "unspecified") return undefined;
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipped(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > resultLimit ? `${trimmed.slice(0, resultLimit)}…` : trimmed;
}

const ends: Record<string, SubagentStatus> = { completed: "completed", failed: "failed", cancelled: "stopped", disconnected: "stopped" };

export class CursorSubagents {
  private readonly known = new Map<string, Known>();
  /** What each Task call was given to do, by the call's id: the line's goal. */
  private readonly goals = new Map<string, string>();
  private readonly own: OwnTools | undefined;
  private readonly now: () => number;

  constructor(own?: OwnTools, now: () => number = Date.now) {
    this.own = own;
    this.now = now;
  }

  /** Whether `id` is a subagent's session. */
  has(id: string): boolean {
    return this.known.has(id);
  }

  /** Whether the subagent `id` is at work, as far as Cursor has said. */
  running(id: string): boolean {
    return this.known.get(id)?.info.status === "running";
  }

  /** A tool call of the subagent `id`, as far as it told of it. */
  call(id: string, toolCallId: string): ToolCall | undefined {
    return this.known.get(id)?.calls.get(toolCallId);
  }

  /** Whether a subagent was started by the Task call `toolCallId`. */
  started(toolCallId: string): boolean {
    for (const known of this.known.values()) if (known.task === toolCallId) return true;
    return false;
  }

  /**
   * A tool call of the thread's own (or a subagent's): a Task's description is its
   * subagent's goal, and a Task that completes while its subagent is at work left it in
   * the background.
   */
  parentCall(update: SessionUpdate): SubagentInfo | null {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return null;
    const id = typeof update.toolCallId === "string" ? update.toolCallId : null;
    if (!id) return null;
    const input = update.rawInput as { _toolName?: unknown; description?: unknown } | undefined;
    if (input?._toolName === "task" && typeof input.description === "string" && input.description.trim() !== "") {
      this.goals.set(id, oneLine(input.description));
      const known = this.byTask(id);
      if (known && known.info.goal !== this.goals.get(id)) {
        known.info.goal = this.goals.get(id)!;
        return this.sent(known);
      }
    }
    if (update.status === "completed" || update.status === "failed") {
      const known = this.byTask(id);
      if (known && known.info.status === "running" && !known.info.background) {
        known.info.background = true;
        return this.sent(known);
      }
    }
    return null;
  }

  /** `subagent_spawned`, told in `from`: the thread's own session, or a subagent's when it is that one's own. */
  spawned(update: Extract<SessionUpdate, { sessionUpdate: "subagent_spawned" }>, from: string): SubagentInfo | null {
    const id = typeof update.subagentSessionId === "string" ? update.subagentSessionId : null;
    if (!id) return null;
    const meta = (update._meta as { cursor?: { toolCallId?: unknown; model?: unknown } } | undefined)?.cursor;
    const task = typeof meta?.toolCallId === "string" ? meta.toolCallId : undefined;
    const model = typeof meta?.model === "string" && meta.model !== "" && meta.model !== "default" ? meta.model : undefined;
    const told = typeof update.task === "string" ? oneLine(update.task) : "";
    const before = this.known.get(id);
    const info: SubagentInfo = {
      id,
      kind: "agent",
      goal: (task && this.goals.get(task)) || told || "Subagent",
      ...(role(update.name) ? { role: role(update.name) } : {}),
      ...(this.known.has(from) ? { parent: from } : {}),
      ...(model ? { model } : {}),
      status: "running",
      startedAt: before?.info.startedAt ?? this.now(),
      background: false,
      stoppable: false,
      toolUses: 0,
    };
    const known: Known = { info, task, saying: "", calls: new Map(), sent: 0 };
    this.known.set(id, known);
    return this.sent(known);
  }

  /** What a subagent says or does, in its own session. */
  update(id: string, update: SessionUpdate): SubagentInfo | null {
    const known = this.known.get(id);
    if (!known || known.info.status !== "running") return null;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = update.content?.type === "text" && typeof update.content.text === "string" ? update.content.text : "";
        if (text === "") return null;
        // No more is kept than its line shows: its summary and result are the start of what it says.
        if (known.saying.length > resultLimit) return null;
        known.saying += text.slice(0, resultLimit + 1 - known.saying.length);
        const summary = oneLine(known.saying.slice(0, summaryLimit * 2));
        if (summary === "" || summary === known.info.summary) return null;
        known.info.summary = summary.length > summaryLimit ? `${summary.slice(0, summaryLimit)}…` : summary;
        return this.now() - known.sent >= summaryEveryMs ? this.sent(known) : null;
      }
      case "tool_call":
      case "tool_call_update": {
        if (typeof update.toolCallId !== "string") return null;
        const fresh = !known.calls.has(update.toolCallId);
        const call = merged(known.calls.get(update.toolCallId), update);
        known.calls.set(update.toolCallId, call);
        const tool = gatewayTool(call, this.own).name;
        if (!fresh && tool === known.info.tool) return null;
        if (fresh) {
          known.info.toolUses = (known.info.toolUses ?? 0) + 1;
          // What it said before the call was about the call: the next words are new.
          known.saying = "";
        }
        known.info.tool = tool;
        return this.sent(known);
      }
      default:
        return null;
    }
  }

  /** `subagent_state_update`: a subagent's end. */
  state(update: Extract<SessionUpdate, { sessionUpdate: "subagent_state_update" }>): SubagentInfo | null {
    const id = typeof update.subagentSessionId === "string" ? update.subagentSessionId : null;
    const known = id ? this.known.get(id) : undefined;
    const status = typeof update.state === "string" ? ends[update.state] : undefined;
    if (!known || !status || known.info.status !== "running") return null;
    this.end(known, status);
    return this.sent(known);
  }

  /** Every subagent still at work, ended as stopped: the turn is over, or Cursor's process gone. */
  stopAll(): SubagentInfo[] {
    const stopped: SubagentInfo[] = [];
    for (const known of this.known.values()) {
      if (known.info.status !== "running") continue;
      this.end(known, "stopped");
      stopped.push(this.sent(known));
    }
    return stopped;
  }

  /** Its line as it goes out now. */
  private sent(known: Known): SubagentInfo {
    known.sent = this.now();
    return { ...known.info };
  }

  private end(known: Known, status: SubagentStatus): void {
    known.info.status = status;
    known.info.endedAt = this.now();
    delete known.info.summary;
    const said = known.saying.trim();
    if (status === "completed" && said !== "") known.info.result = clipped(said);
    // Only its line is kept: its calls and words, with whatever its tools returned, are let go of.
    known.saying = "";
    known.calls.clear();
  }

  private byTask(toolCallId: string): Known | undefined {
    for (const known of this.known.values()) if (known.task === toolCallId) return known;
    return undefined;
  }
}
