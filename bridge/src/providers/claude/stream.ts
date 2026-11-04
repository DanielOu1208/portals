import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { basename, dirname, isAbsolute } from "node:path";
import { BackgroundCommands } from "../backgroundCommands.ts";
import type { ContextUsage, ProviderEvent, SubagentStatus } from "../types.ts";
import { ended, noteFor, type Ended, type TaskInfo } from "./background.ts";
import { TaskBoard } from "./tasks.ts";
import { ClaudeTodos } from "./todos.ts";
import { gatewayResult, gatewayTool, historyLosesDiff } from "./tools.ts";
import { claudeTokens } from "../spent.ts";
import { windowNames } from "./usage.ts";

// What one live Claude query sends, as the bridge's neutral events (providers/types.ts).
// One of these per query; it sees every SDK message in order and keeps what it needs
// across them: which tools are open, how full the context is, which of the user's
// messages Claude has answered.
//
// - Text and thinking come word by word from the partial messages (`stream_event`).
//   The whole assistant messages that follow repeat them and are only used for tool
//   calls, or for text when nothing streamed.
// - A tool row opens with the tool_use block and closes with its tool_result.
// - Claude ends each of its turns with a `result`. The app's turn ends when every
//   message the user sent has been answered: a message sent mid-turn is either folded
//   into the running turn or answered by a turn of its own right after it, and results
//   name the messages they answered (`user_message_uuids`).
// - Claude also begins turns by itself, when background work it started (a command or
//   subagent run in the background, a workflow) ends. Such a turn opens with a
//   `status: requesting` that names none of the app's messages, and becomes a
//   `turn.begin` that says what ended; its result names nothing. Nor does the empty
//   result a resumed session opens with, after telling Claude what did not finish before
//   its last process ended. Neither answers the app's messages.
// - `background_tasks_changed` says which background work is running: the process has
//   to stay up while there is any, or the work dies with it.
// - Subagents' own messages (with a `parent_tool_use_id`) are left out; their Task call
//   is one row. What the subagents and workflows Claude starts are doing comes from the
//   task messages, as news of each (`subagent`, tasks.ts).
// - A compaction (`/compact`, or Claude Code by itself as the context fills up) ends
//   with a compact boundary, which marks its place in the thread, with the tokens the
//   context held before and after it. The "Compacted" Claude Code prints after it is
//   left out: the mark says as much.
// - A slash command that fails says so in a message of Claude Code's own, not Claude's
//   ("No messages to compact"); the turn ends with it as its error. Asking again would
//   meet the same answer, so it is not offered. A compaction that failed on the way
//   (the API, say) ends the turn of the `/compact` that asked for it, and may work the
//   next time; one Claude Code tried by itself is a warning in a turn that goes on.
//   Either failure, or Claude's own (the API's), on a message with another sent in
//   behind it is said in passing, as the turn goes on to answer that one. Claude Code
//   says the API's in a message of its own as well (`<synthetic>`, with an `error`),
//   which is left out: the result says it once.

export interface StreamOptions {
  /** The thread's folder, for paths in diffs. */
  cwd: string;
  /** Milliseconds; for tool durations. */
  now?: () => number;
  /** For the times in rate-limit warnings; the Mac's own zone when absent. */
  timeZone?: string;
  /** The rows of commands run in the background (`commands`), which change apart from `map`. */
  background?: (event: ProviderEvent) => void;
  /** The session's to-do list as Claude Code's task tools keep it, which outlasts a query. */
  todos?: ClaudeTodos;
  /** The window each model's context fills, as the provider's processes have said, which outlasts a query. */
  windows?: ContextWindows;
}

/**
 * The window each model's context fills, by the model's id, as a process last said (a
 * result's `modelUsage`, or `getContextUsage` when asked): a new process on that model
 * shows the context use from its first request, not only once its first turn has ended.
 */
export class ContextWindows {
  private readonly known = new Map<string, number>();

  of(model: string | null): number {
    return model === null ? 0 : (this.known.get(model) ?? 0);
  }

  learn(model: string, window: number): void {
    if (window > 0) this.known.set(model, window);
  }
}

interface OpenTool {
  name: string;
  input: Record<string, unknown>;
  startedAt: number;
}

/** What the last `init` or `status` message said about the session. */
export interface Reported {
  model: string | null;
  permissionMode: string | null;
  effort: string | null;
}

type Message = Record<string, any>;


export class ClaudeStream {
  readonly reported: Reported = { model: null, permissionMode: null, effort: null };
  /** Tool calls the phone said no to. */
  readonly denied = new Set<string>();
  private readonly cwd: string;
  private readonly now: () => number;
  private readonly timeZone: string | undefined;
  private readonly tools = new Map<string, OpenTool>();
  private readonly unanswered = new Set<string>();
  /** API messages whose text or thinking streamed, so the whole message is not shown again. */
  private readonly streamedText = new Set<string>();
  private readonly streamedThinking = new Set<string>();
  private readonly warned = new Set<string>();
  private messageID = "";
  /** Text streamed since the last tool call, to close when another of Claude's turns follows in the same app turn. */
  private openText = "";
  private interruptRequested = false;
  private compacting = false;
  /** The status line says Claude's API is being asked again (`api_retry`), until a request goes through or the turn ends. */
  private retrying = false;
  /** Background work running now (commands, subagents, workflows), by task id. */
  private readonly background = new Set<string>();
  /** What each task is, to name it when it ends. */
  private readonly tasks = new Map<string, TaskInfo>();
  /** The subagents and workflows Claude started in this process. */
  readonly board: TaskBoard;
  /** The to-do list Claude keeps with its task tools (TaskCreate, TaskUpdate), as `todo` rows. */
  private readonly todos: ClaudeTodos;
  /** Commands Claude runs in the background (`run_in_background`), as command rows of the subagents line. */
  readonly commands: BackgroundCommands;
  /** Those commands' task ids, by the Bash call that started each. */
  private readonly commandCalls = new Map<string, string>();
  /** Output files named in a Bash call's result before its task was told of, by the call. */
  private readonly commandFiles = new Map<string, string>();
  /** Background work that ended since Claude last called the model: why it begins a turn by itself. */
  private ends: Ended[] = [];
  /** Whose turn Claude is running: for the app's messages, its own, or none. */
  private running: "app" | "own" | null = null;
  /** Why a slash command the turn ran did not work, as Claude Code said; the turn ends with it. */
  private commandFailure: string | null = null;
  /** Why a compaction failed on the way, until the result says whether a command asked for it. */
  private compactFailure: string | null = null;
  /** Tokens in the context at the last request, and the window they fill. */
  private contextTokens = 0;
  private contextWindow = 0;
  private readonly windows: ContextWindows | undefined;
  /**
   * What the app's turn has spent so far, from each of Claude's results in it (one turn
   * of the app's can be several of Claude's, for messages sent meanwhile): each result's
   * `usage`, which is its main loop's, every request of it, without its subagents', and
   * which the session's stored messages add up to as well.
   */
  private spentTokens = 0;
  /**
   * Each request's tokens as they streamed (its start, then its end's count), by its id:
   * what a turn spent when its result says none (Claude Code zeroes the usage of a turn
   * stopped or failed partway; its stored session still has each request's).
   */
  private readonly streamedSpent = new Map<string, number>();

  constructor(options: StreamOptions) {
    this.cwd = options.cwd;
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone;
    this.board = new TaskBoard(this.now);
    this.todos = options.todos ?? new ClaudeTodos();
    this.windows = options.windows;
    this.commands = new BackgroundCommands(options.background ?? (() => {}), { now: this.now });
  }

  /** A message was sent with this uuid; the turn lasts until a result answers it. */
  sent(uuid: string): void {
    this.unanswered.add(uuid);
  }

  /** The user asked to stop: the next result ends the turn as interrupted. */
  interrupting(): void {
    this.interruptRequested = true;
  }

  /** Whether a result is still to answer the message sent with this uuid. */
  awaits(uuid: string): boolean {
    return this.unanswered.has(uuid);
  }

  /**
   * Claude Code took back messages sent with these uuids at a Stop, before it read them
   * (`interrupt` with `cancelQueued`): no result answers them. Stopped between two of
   * Claude's turns, the one to come was for them, so the app's turn ends here.
   */
  withdraw(uuids: readonly string[]): ProviderEvent[] {
    for (const uuid of uuids) this.unanswered.delete(uuid);
    if (!this.interruptRequested || this.running !== null || this.unanswered.size > 0) return [];
    this.interruptRequested = false;
    this.openText = "";
    return [{ type: "turn.end", status: "interrupted", usage: this.usage, ...this.spentSoFar() }];
  }

  get isInterrupting(): boolean {
    return this.interruptRequested;
  }

  /** Claude has background work running, which stops if its process does. */
  get hasBackgroundWork(): boolean {
    return this.background.size > 0;
  }

  /** The context use known so far, when there is a window to measure it against. */
  get usage(): ContextUsage | undefined {
    return this.contextTokens > 0 && this.contextWindow > 0 ? { used: this.contextTokens, max: this.contextWindow } : undefined;
  }

  /** Whether the window the context fills is known. */
  get knowsWindow(): boolean {
    return this.contextWindow > 0;
  }

  /**
   * The window Claude Code said `model`'s context fills, when asked (`getContextUsage`):
   * the context use from now on, and at once when a request has said the tokens already.
   * Nothing when the process runs another model, or the window is known.
   */
  window(model: string, window: number): ProviderEvent[] {
    if (this.contextWindow > 0 || !(window > 0) || model !== this.reported.model) return [];
    this.contextWindow = window;
    this.windows?.learn(model, window);
    const known = this.usage;
    return known ? [{ type: "usage", usage: known }] : [];
  }

  map(message: SDKMessage): ProviderEvent[] {
    const m = message as Message;
    // A subagent's own work; its Task call is the row.
    if (m.parent_tool_use_id) return [];
    switch (m.type) {
      case "stream_event":
        return [...this.retried(), ...this.streamEvent(m.event ?? {})];
      case "assistant":
        return [...this.retried(), ...this.assistant(m)];
      case "user":
        return this.user(m);
      case "system":
        return this.system(m);
      case "rate_limit_event":
        return this.rateLimit(m.rate_limit_info ?? {});
      case "tool_use_summary":
        return this.toolSummary(m);
      case "result":
        return [...this.retried(), ...this.result(m)];
      default:
        return [];
    }
  }

  /**
   * The line that said Claude's API was being asked again, taken off once a request went
   * through (its reply streams or arrives whole) or the turn ended: nothing else clears
   * it, and it would stay through the rest of the turn, and on every device that catches
   * up on it. Back to the compaction the retry was within, when there was one.
   */
  private retried(): ProviderEvent[] {
    if (!this.retrying) return [];
    this.retrying = false;
    return [{ type: "status", text: this.compacting ? "Compacting the conversation…" : "" }];
  }

  /**
   * What a run of tool calls on the main thread did, in Claude Code's words ("Read a.txt
   * and b.txt"), with `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` set (`childEnvironment`): the
   * app's headline for the work under way (feature status_headline). It is made by a model
   * call of its own after the run, so it often comes once the next call has started, and
   * now and then after Claude has said something; the calls it names tell the app which.
   */
  private toolSummary(m: Message): ProviderEvent[] {
    const text = typeof m.summary === "string" ? m.summary.replace(/\s+/g, " ").trim() : "";
    if (text === "") return [];
    const toolIds = Array.isArray(m.preceding_tool_use_ids) ? m.preceding_tool_use_ids.filter((id: unknown): id is string => typeof id === "string") : [];
    return [{ type: "headline", text, toolIds }];
  }

  // MARK: Streaming

  private streamEvent(event: Message): ProviderEvent[] {
    switch (event.type) {
      case "message_start": {
        this.messageID = event.message?.id ?? "";
        const usage = event.message?.usage;
        if (!usage) return [];
        this.contextTokens = tokens(usage);
        this.streamedSpent.set(this.messageID, tokens(usage));
        const known = this.usage;
        return known ? [{ type: "usage", usage: known }] : [];
      }
      case "message_delta":
        if (event.usage) {
          this.contextTokens = tokens(event.usage);
          this.streamedSpent.set(this.messageID, Math.max(this.streamedSpent.get(this.messageID) ?? 0, tokens(event.usage)));
        }
        return [];
      case "content_block_delta": {
        const delta = event.delta ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
          this.streamedText.add(this.messageID);
          this.openText += delta.text;
          return [{ type: "text", text: delta.text }];
        }
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking !== "") {
          this.streamedThinking.add(this.messageID);
          return [{ type: "reasoning", text: delta.thinking }];
        }
        return [];
      }
      default:
        return [];
    }
  }

  private assistant(m: Message): ProviderEvent[] {
    const id: string = m.message?.id ?? "";
    const failed = commandFailure(m);
    if (failed !== null) {
      // Not Claude speaking: Claude Code saying a command failed ("No messages to compact").
      this.commandFailure ??= failed;
      return [];
    }
    // Not Claude speaking either: Claude Code saying the API failed on the message (a model
    // it has no access to, say), as the result that follows says too.
    if (typeof m.error === "string" && m.message?.model === "<synthetic>") return [];
    const events: ProviderEvent[] = [];
    for (const block of Array.isArray(m.message?.content) ? m.message.content : []) {
      if (block.type === "text" && typeof block.text === "string" && block.text !== "" && !this.streamedText.has(id)) {
        this.openText += block.text;
        events.push({ type: "text", text: block.text });
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking !== "" && !this.streamedThinking.has(id)) {
        events.push({ type: "reasoning", text: block.thinking });
      } else if (block.type === "tool_use" && typeof block.id === "string" && !this.tools.has(block.id)) {
        const input = (block.input ?? {}) as Record<string, unknown>;
        this.tools.set(block.id, { name: block.name, input, startedAt: this.now() });
        this.openText = "";
        // A task tool's call is a to-do row with the whole list, as TodoWrite's is.
        const tool = this.todos.started(block.name, input) ?? gatewayTool(block.name, input);
        events.push(withContext({ type: "tool.start", id: block.id, name: tool.name, args: tool.args }, tool.context));
      }
    }
    return events;
  }

  private user(m: Message): ProviderEvent[] {
    const content = Array.isArray(m.message?.content) ? m.message.content : [];
    const results = content.filter((block: Message) => block?.type === "tool_result");
    const events: ProviderEvent[] = [];
    for (const block of results) {
      // A command left running: Claude Code says where it writes its output.
      const said = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((part: Message) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "";
      const path = this.tools.get(block.tool_use_id)?.name === "Bash" ? /Output is being written to: (\S+\.output)/.exec(said)?.[1] : undefined;
      if (path) {
        const task = this.commandCalls.get(block.tool_use_id);
        if (task !== undefined) {
          this.commandCalls.delete(block.tool_use_id);
          this.followCommand(task, path);
        } else {
          // Its task is told of after: kept for it.
          this.commandFiles.set(block.tool_use_id, path);
          if (this.commandFiles.size > 64) this.commandFiles.delete(this.commandFiles.keys().next().value!);
        }
      }
      const open = this.tools.get(block.tool_use_id);
      if (!open) continue;
      this.tools.delete(block.tool_use_id);
      const outcome = {
        content: block.content,
        isError: block.is_error === true,
        // Claude's structured result belongs to the message; only safe with one result in it.
        structured: results.length === 1 ? m.tool_use_result : undefined,
        denied: this.denied.has(block.tool_use_id),
      };
      const todo = this.todos.finished(open.name, open.input, outcome);
      const tool = todo?.tool ?? gatewayTool(open.name, open.input);
      const result = todo?.result ?? gatewayResult(open.name, open.input, outcome, this.cwd);
      // An edit's exact diff, which Claude's history will not have: the bridge keeps it.
      const kept = historyLosesDiff(open.name, open.input, outcome, result, this.cwd) ? { keepDiff: true as const } : {};
      events.push(
        withContext(
          { type: "tool.end", id: block.tool_use_id, name: tool.name, args: tool.args, result, durationSeconds: seconds(this.now() - open.startedAt), ...kept },
          tool.context,
        ),
      );
    }
    return events;
  }

  private system(m: Message): ProviderEvent[] {
    switch (m.subtype) {
      case "init":
        this.reported.model = m.model ?? this.reported.model;
        this.reported.permissionMode = m.permissionMode ?? this.reported.permissionMode;
        this.reported.effort = m.effort ?? this.reported.effort;
        // A model another process ran: its window is known before this one's first result.
        if (this.contextWindow === 0) this.contextWindow = this.windows?.of(this.reported.model) ?? 0;
        return [];
      case "status": {
        if (typeof m.permissionMode === "string") this.reported.permissionMode = m.permissionMode;
        const begun = m.status === "requesting" ? this.requesting(m) : [];
        if (m.status === "compacting") {
          this.compacting = true;
          return [...begun, { type: "status", text: "Compacting the conversation…" }];
        }
        if (m.compact_result === "failed") {
          const error = typeof m.compact_error === "string" ? m.compact_error.trim().replace(/[.!?]?$/, ".") : "";
          this.compactFailure ??= error ? `The conversation was not compacted: ${error}` : "The conversation was not compacted.";
        }
        if (this.compacting) {
          this.compacting = false;
          return [...begun, { type: "status", text: "" }];
        }
        return begun;
      }
      case "task_started":
        // A run of a task before its latest one (it was resumed) says nothing that holds now.
        if (this.board.isLate(m)) return [];
        if (typeof m.task_id === "string") this.tasks.set(m.task_id, { type: m.task_type ?? "", description: m.description ?? "" });
        this.commandStarted(m);
        return this.news(m);
      case "task_progress":
        return this.news(m);
      case "task_updated":
        // A command's end is taken from its `task_notification`, which follows with how it
        // ended and where its output is.
        return this.news(m);
      case "background_tasks_changed":
        // The whole set each time.
        this.background.clear();
        for (const task of Array.isArray(m.tasks) ? (m.tasks as Message[]) : []) {
          if (typeof task?.task_id !== "string") continue;
          if (!this.tasks.has(task.task_id)) this.tasks.set(task.task_id, { type: task.task_type ?? "", description: task.description ?? "" });
          // Watchers and the like are not work anyone waits for.
          if (task.ambient !== true) this.background.add(task.task_id);
        }
        return [];
      case "task_notification":
        if (this.board.isLate(m)) return [];
        this.ends.push(ended(this.tasks.get(m.task_id), typeof m.status === "string" ? m.status : "", typeof m.summary === "string" ? m.summary : ""));
        if (typeof m.task_id === "string" && this.commands.running(m.task_id)) {
          if (typeof m.output_file === "string") this.followCommand(m.task_id, m.output_file);
          this.commands.end(m.task_id, commandEnd(m.status) ?? "completed", m.status === "failed" && typeof m.summary === "string" ? { result: m.summary } : undefined);
        }
        return this.news(m);
      case "compact_boundary": {
        // `/compact`, or Claude Code by itself as the context filled up. The context
        // holds the summary now, until the next request says more.
        const metadata = m.compact_metadata ?? {};
        const event: ProviderEvent = { type: "compacted", trigger: metadata.trigger === "auto" ? "auto" : "manual" };
        if (typeof metadata.pre_tokens === "number" && metadata.pre_tokens > 0) event.tokensBefore = metadata.pre_tokens;
        const events: ProviderEvent[] = [event];
        if (typeof metadata.post_tokens === "number" && metadata.post_tokens > 0) {
          this.contextTokens = metadata.post_tokens;
          const known = this.usage;
          if (known) events.push({ type: "usage", usage: known });
        }
        return events;
      }
      case "api_retry": {
        const attempt = typeof m.attempt === "number" ? ` (attempt ${m.attempt} of ${m.max_retries})` : "";
        this.retrying = true;
        return [{ type: "status", text: `Claude's API did not answer; trying again${attempt}…` }];
      }
      case "local_command_output":
        // The answer to a command such as /context sent as a message.
        return typeof m.content === "string" && m.content !== "" ? [{ type: "text", text: m.content }] : [];
      case "informational":
        // A line Claude Code shows in the terminal: a hook's feedback (a Stop hook that
        // kept the turn going, a message a hook turned down), at its level. The warnings
        // only: the others are tips, or lines its terminal shows only when asked.
        return m.level === "warning" && typeof m.content === "string" && m.content.trim() !== "" ? [{ type: "notice", level: "warn", text: m.content.trim() }] : [];
      default:
        return [];
    }
  }

  /** News of a subagent or workflow, when `m` is about one. */
  /** A Bash call run in the background: a command row, at work, which Stop can stop. */
  private commandStarted(m: Message): void {
    if (m.task_type !== "local_bash" || m.is_backgrounded !== true || m.ambient === true || typeof m.task_id !== "string") return;
    const call = typeof m.tool_use_id === "string" ? this.tools.get(m.tool_use_id) : undefined;
    const command = typeof call?.input.command === "string" ? call.input.command : "";
    this.commands.start(m.task_id, { goal: (typeof m.description === "string" && m.description.trim()) || command || "A command", stoppable: true });
    if (typeof m.tool_use_id === "string") {
      const told = this.commandFiles.get(m.tool_use_id);
      this.commandFiles.delete(m.tool_use_id);
      if (told) this.followCommand(m.task_id, told);
      else {
        this.commandCalls.set(m.tool_use_id, m.task_id);
        if (this.commandCalls.size > 64) this.commandCalls.delete(this.commandCalls.keys().next().value!);
      }
    }
  }

  /**
   * Reads a background command's output from the file Claude Code named for it: only one
   * in a `tasks` folder, named for the task (`…/tasks/<task id>.output`).
   */
  private followCommand(task: string, path: string): void {
    if (!isAbsolute(path) || basename(path) !== `${task}.output` || basename(dirname(path)) !== "tasks" || path.split("/").includes("..")) return;
    this.commands.follow(task, path);
  }

  private news(m: Message): ProviderEvent[] {
    const subagent = this.board.take(m);
    return subagent ? [{ type: "subagent", subagent }] : [];
  }

  // MARK: Usage limits

  private rateLimit(info: Message): ProviderEvent[] {
    const events: ProviderEvent[] = [];
    if (info.status === "rejected") {
      const name = windowNames[info.rateLimitType] ?? "";
      const key = `rejected:${info.rateLimitType}:${info.resetsAt}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        events.push({ type: "notice", level: "warn", text: `You have reached your ${name ? name + " " : ""}Claude usage limit${this.resets(info.resetsAt)}.` });
      }
      return events;
    }
    const windows: [string, Message][] = info.unifiedWindows
      ? Object.entries(info.unifiedWindows as Record<string, Message>)
      : info.rateLimitType && typeof info.utilization === "number"
        ? [[info.rateLimitType, { utilization: info.utilization, resetsAt: info.resetsAt }]]
        : [];
    for (const [window, state] of windows) {
      const utilization = typeof state?.utilization === "number" ? state.utilization : 0;
      // A fraction; some reports give a percentage.
      const percent = Math.round(utilization > 1 ? utilization : utilization * 100);
      if (percent < 80) continue;
      const key = `${window}:${state.resetsAt}`;
      if (this.warned.has(key)) continue;
      this.warned.add(key);
      events.push({ type: "notice", level: "warn", text: `You have used ${percent}% of your ${windowNames[window] ?? window} Claude limit${this.resets(state.resetsAt)}.` });
    }
    return events;
  }

  private resets(resetsAt: unknown): string {
    if (typeof resetsAt !== "number") return "";
    const when = new Date(resetsAt * 1000);
    const options: Intl.DateTimeFormatOptions = { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: this.timeZone };
    return `; it resets ${when.toLocaleString("en-US", options)}`;
  }

  // MARK: Turns Claude begins by itself

  /**
   * Claude is about to call the model: for the app's messages when it names one, or
   * between turns for a turn of its own, which begins here.
   */
  private requesting(m: Message): ProviderEvent[] {
    // Whatever ended before now goes to the model with this request.
    const ends = this.ends;
    this.ends = [];
    if (stamped(m).some((uuid) => this.unanswered.has(uuid))) {
      this.running = "app";
      return [];
    }
    if (this.running !== null) return [];
    // A message of the app's is waiting and nothing ended that Claude would begin a turn
    // for: this is the message's turn, from a Claude Code that does not name it.
    if (this.unanswered.size > 0 && ends.length === 0) {
      this.running = "app";
      return [];
    }
    this.running = "own";
    const host = noteFor(ends);
    return [{ type: "turn.begin", user: host.text, host }];
  }

  // MARK: The end of a turn

  /**
   * What the turn spent so far, for an end the bridge gives it itself (Claude Code's
   * process stopped or exited before its result): the results' tokens and those of the
   * requests streamed since, each once. Taken, so the next turn starts from none.
   */
  spentSoFar(): { spent: { tokens: number } } | Record<string, never> {
    const tokens = this.spentTokens + [...this.streamedSpent.values()].reduce((sum, count) => sum + count, 0);
    this.spentTokens = 0;
    this.streamedSpent.clear();
    return tokens > 0 ? { spent: { tokens } } : {};
  }

  private result(m: Message): ProviderEvent[] {
    const answered = stamped(m);
    const own = this.running === "own";
    this.running = null;
    // A compaction is within one of Claude's turns: one cut short ends with it, and a
    // retry in a later turn does not put it back on the line (`retried`).
    const wasCompacting = this.compacting;
    this.compacting = false;
    // The empty result a resumed session opens with, after telling Claude what did not
    // finish before its last process ended: no turn ran, so none ends.
    if (answered.length === 0 && !own && this.ends.length > 0 && m.subtype === "success" && m.num_turns === 0) return [];
    for (const uuid of answered) this.unanswered.delete(uuid);
    // Any other result that names nothing and is not Claude's own (an error, an older
    // Claude Code) answers everything sent.
    if ((answered.length === 0 && !own) || this.interruptRequested) this.unanswered.clear();
    this.learnWindow(m.modelUsage);
    const told = claudeTokens(m.usage);
    this.spentTokens += told > 0 ? told : [...this.streamedSpent.values()].reduce((sum, count) => sum + count, 0);
    this.streamedSpent.clear();
    // These ids suppress the whole messages before this result, not any later turn's.
    this.streamedText.clear();
    this.streamedThinking.clear();

    const { failure, notices } = this.failures(m);
    if (this.unanswered.size > 0) {
      // Another of Claude's turns follows for a message sent meanwhile: what it said so
      // far stays above what comes next.
      const text = this.openText;
      this.openText = "";
      const events: ProviderEvent[] = text.trim() === "" ? [] : [{ type: "commentary", text, alreadyStreamed: true }];
      // The turn goes on: the line no longer says it is compacting.
      if (wasCompacting) events.push({ type: "status", text: "" });
      // A command that did not work, or Claude failing on the message (the API, say), is
      // not the end of the turn: it is said in passing.
      if (failure) events.push({ type: "notice", level: "warn", text: failure.error });
      else if (m.subtype !== "success" || m.is_error === true) events.push({ type: "notice", level: "error", text: failureText(m) });
      return [...events, ...notices];
    }

    const events: ProviderEvent[] = [...notices];
    // Tools that never reported back (the turn was cut short) close as stopped.
    for (const [id, open] of this.tools) {
      const tool = gatewayTool(open.name, open.input);
      events.push(withContext({ type: "tool.end", id, name: tool.name, args: tool.args, result: { status: "error", error: "Stopped before it finished." } }, tool.context));
    }
    this.tools.clear();
    this.openText = "";

    const usage = this.usage;
    const spent = this.spentTokens > 0 ? { spent: { tokens: this.spentTokens } } : {};
    this.spentTokens = 0;
    if (this.interruptRequested) {
      this.interruptRequested = false;
      events.push({ type: "turn.end", status: "interrupted", usage, ...spent });
    } else if (failure !== null) {
      // Claude Code calls it a success: the command was run, and said it did not work.
      events.push({ type: "turn.end", status: "error", error: failure.error, retryable: failure.retryable, usage, ...spent });
    } else if (m.subtype === "success" && m.is_error !== true) {
      events.push({ type: "turn.end", status: "complete", usage, ...spent });
    } else {
      events.push({ type: "turn.end", status: "error", error: failureText(m), retryable: true, usage, ...spent });
    }
    return events;
  }

  /**
   * What went wrong with a command in the part of the turn the result `m` ends: the
   * failure the turn ends with, and lines to say in passing. A compaction that failed
   * ends the turn of the `/compact` that asked for it (the result names the command it
   * answered, `local_command`); one Claude Code tried by itself is only a warning.
   */
  private failures(m: Message): { failure: { error: string; retryable: boolean } | null; notices: ProviderEvent[] } {
    const asked = typeof m.local_command === "string" && m.local_command !== "";
    const failure =
      this.commandFailure !== null
        ? { error: this.commandFailure, retryable: false }
        : this.compactFailure !== null && asked
          ? { error: this.compactFailure, retryable: true }
          : null;
    const notices: ProviderEvent[] = this.compactFailure !== null && failure === null ? [{ type: "notice", level: "warn", text: this.compactFailure }] : [];
    this.commandFailure = null;
    this.compactFailure = null;
    return { failure, notices };
  }

  private learnWindow(modelUsage: unknown): void {
    if (!modelUsage || typeof modelUsage !== "object") return;
    const entries = Object.entries(modelUsage as Record<string, Message>);
    const [model, entry] = entries.find(([model]) => model === this.reported.model) ?? entries[0] ?? [];
    if (typeof entry?.contextWindow !== "number" || entry.contextWindow <= 0) return;
    this.contextWindow = entry.contextWindow;
    if (model) this.windows?.learn(model, entry.contextWindow);
  }
}

/** The app's messages a frame says Claude is answering. */
function stamped(m: Message): string[] {
  return Array.isArray(m.user_message_uuids) ? m.user_message_uuids : typeof m.user_message_uuid === "string" ? [m.user_message_uuid] : [];
}

/** Tokens in the context for one request: everything it read, plus what it wrote. */
function tokens(usage: Message): number {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

function seconds(milliseconds: number): number {
  return Math.max(0, Math.round(milliseconds) / 1000);
}

function failureText(m: Message): string {
  if (typeof m.result === "string" && m.result.trim() !== "") return m.result.trim();
  switch (m.subtype) {
    case "error_max_turns":
      return "Claude stopped after reaching its limit of turns.";
    case "error_max_budget_usd":
      return "Claude stopped after reaching its spending limit.";
    default: {
      const errors = Array.isArray(m.errors) ? m.errors.filter((error: unknown) => typeof error === "string" && !error.startsWith("[ede_diagnostic]")) : [];
      return errors.length > 0 ? `Claude Code stopped with an error: ${errors.join("; ")}` : "Claude Code stopped with an error.";
    }
  }
}

/**
 * Why a slash command Claude Code ran did not work, as a sentence; null for a message
 * that is not about that. Claude Code says it in an assistant message of its own that
 * names the command and how it went (`local_command_outcome`), with what the command
 * wrote to stderr as its text ("Error: No messages to compact").
 */
function commandFailure(m: Message): string | null {
  const source = typeof m.local_command_source === "string" ? m.local_command_source : "";
  if (m.local_command_outcome?.kind !== "failed" && !source.startsWith("<local-command-stderr>")) return null;
  const blocks: Message[] = Array.isArray(m.message?.content) ? m.message.content : [];
  const text = blocks.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("").trim();
  const reason = text.replace(/^Error:\s*/i, "");
  if (reason === "") return typeof m.local_command_run?.command === "string" ? `/${m.local_command_run.command} did not work.` : "The command did not work.";
  const capitalised = reason[0].toUpperCase() + reason.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

function withContext<T extends ProviderEvent & { context?: string }>(event: T, context: string | undefined): T {
  if (context) event.context = context;
  return event;
}

/** How a background command ended, by Claude Code's word for it; undefined while it runs. */
function commandEnd(status: unknown): Exclude<SubagentStatus, "running"> | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
      return "stopped";
    default:
      return undefined;
  }
}
