import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  EffortLevel,
  ModelInfo,
  Options,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { counters } from "../../counters.ts";
import { log } from "../../log.ts";
import { machineWord } from "../../platform.ts";
import { imageType, skippedImagesText } from "../images.ts";
import type {
  ModeState,
  ModelChangeResult,
  Prompt,
  ProviderEvent,
  ProviderSession,
  SessionOptions,
  SessionSettings,
  SessionSink,
  StoredMessage,
  ThreadMode,
} from "../types.ts";
import { historyFromSession } from "./history.ts";
import { ClaudeTodos } from "./todos.ts";
import { InputQueue } from "./input.ts";
import { claudeEffort, permissionModeFor, queryOptions, thinkingBudget, threadModeFor } from "./options.ts";
import { permissionRequest, permissionResult } from "./permissions.ts";
import type { CommandAccess } from "../../portals/access.ts";
import type { VersionCheck } from "../program.ts";
import type { Warmable, WarmPool } from "../pool.ts";
import { ClaudeStream, type ContextWindows } from "./stream.ts";
import type { PastSubagent } from "./tasks.ts";

// One Claude Code thread. It has a process ("warm") only while it is in use: the first
// message starts a streaming-input `query()` (with the thread id as its session id, or
// `resume` once Claude has stored it), later messages go to the same process, and the
// pool cools it after a while idle. Background work Claude started (a command, a
// subagent, a workflow) runs in that process, so the thread is not idle while there is
// any. Everything Claude sends goes through a `ClaudeStream` and on to the bridge as
// neutral events; a turn Claude begins by itself when such work ends is shown as a turn.

/** The parts of the SDK's `Query` the bridge uses, so tests can stand in for it. */
export interface QueryLike extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  /** Stops one task (a subagent, a workflow); Claude Code then reports it stopped. */
  stopTask(taskId: string): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void>;
  setMaxThinkingTokens(tokens: number | null, display?: "summarized" | "omitted" | null): Promise<void>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedCommands(): Promise<SlashCommand[]>;
  initializationResult(): Promise<{ models?: ModelInfo[]; commands?: SlashCommand[]; current_permission_mode?: string }>;
  /**
   * The settings in force, `applied.model` being the model the session runs on now
   * (`claude-opus-5-5`). The SDK's query has it but does not declare it, so it may be
   * missing.
   */
  getSettings?(): Promise<{ applied?: { model?: string | null; effort?: string | null } }>;
  /**
   * What Claude Code's `/usage` shows: the plan and how much of each of its windows is
   * used. Experimental in the SDK, so it may be missing or change.
   */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(options?: { skipBehaviors?: boolean }): Promise<PlanUsage>;
  /**
   * How full the context is, and the window it fills (`rawMaxTokens`) for `model`; with
   * `summary`, from the last request's usage and estimates, at no cost. An older Claude
   * Code may refuse it.
   */
  getContextUsage?(options?: { detail?: "summary" | "full" }): Promise<{ model: string; rawMaxTokens: number }>;
  close(): void;
}

/** The part of Claude Code's `/usage` answer the bridge reads (`SDKControlGetUsageResponse`). */
export interface PlanUsage {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: Record<string, unknown> | null;
}

export type QueryFactory = (prompt: AsyncIterable<SDKUserMessage>, options: Options) => QueryLike;

/** A session in Claude's own index, as `listSessions()` and `getSessionInfo()` describe it. */
export interface StoredSession {
  sessionId: string;
  /** Claude's title for it: the custom title, its summary, or the first prompt. */
  summary: string;
  customTitle?: string;
  firstPrompt?: string;
  cwd?: string;
  /** Milliseconds since 1970. */
  lastModified: number;
}

/** What Claude keeps on disk about its sessions. */
export interface SessionFiles {
  exists(id: string, cwd: string): Promise<boolean>;
  /** The title Claude gave the session, or null. */
  title(id: string, cwd: string): Promise<string | null>;
  messages(id: string, cwd: string): Promise<unknown[]>;
  /** The folder of every session, with when it last changed (milliseconds since 1970). */
  folders(): Promise<{ path: string; lastUsed: number }[]>;
  /** The sessions started at a terminal (not through the SDK), newest first, at most `limit`. */
  desk(limit: number): Promise<StoredSession[]>;
  /** One session, whatever its folder; undefined when Claude has none by that id. */
  info(id: string): Promise<StoredSession | undefined>;
  /** Copies a session into a new one with the same history, and returns the new one's id. */
  fork(id: string, cwd: string): Promise<string>;
  /** Gives a session a title of its own, which `title` then reads. */
  rename(id: string, cwd: string, title: string): Promise<void>;
  /**
   * A workflow's journal (`PastSubagent.journal`) as JSON, or the log of its agents
   * (`PastSubagent.agentLog`, a `.jsonl`) as its records; null when it cannot be read.
   */
  journal?(path: string): Promise<unknown>;
}

/** What a session needs from its provider. */
export interface ClaudeHost {
  readonly claudePath: string;
  readonly env: Record<string, string | undefined>;
  /** The `portals` command, when the bridge offers it to its agents. */
  readonly portals?: CommandAccess;
  readonly query: QueryFactory;
  readonly files: SessionFiles;
  readonly pool: WarmPool;
  /** How long a turn may take to end after Stop before its process is stopped. */
  readonly interruptGraceMs: number;
  /** When to look for a new session's title while its turn runs, in milliseconds after the turn opened. */
  readonly titleWatchMs: readonly number[];
  /** The mode the user's settings give, when known. */
  readonly settingsMode: string | null;
  modelInfo(model: string): ModelInfo | undefined;
  /** Whether a terminal on the Mac has the session open now (`claude agents`). */
  isOpenInTerminal(id: string): Promise<boolean>;
  /** The commands a session's Claude Code says need a terminal (`terminal_slash_commands` in its `system/init`), which the app does not offer. */
  terminalCommands(names: unknown): void;
  /** A query started: the provider can refresh what it knows (models, commands). */
  learn(query: QueryLike, reported: { permissionMode: string | null; effort: string | null }, overridden: boolean): void;
  /** Claude Code said how much of a usage limit is used (`rate_limit_event`), for `/usage`. */
  limitsHeard(info: Record<string, unknown>): void;
  /** Which Claude Code runs, which each process says in its `system/init` (`claude_code_version`). */
  readonly version: VersionCheck;
  /** A session closed: the provider keeps track of it no longer. */
  forget(session: ClaudeSession): void;
  /** The window each model's context fills, as its processes have said. */
  readonly windows: ContextWindows;
}

interface Live {
  query: QueryLike;
  input: InputQueue;
  stream: ClaudeStream;
  /** Controls on this query finish before its next prompt, never another query's. */
  controls: Promise<void>;
  /** Unlike an optional model change, a refused permission change must block prompts. */
  permission: Promise<void>;
  /** The bridge is closing it on purpose: its end is not a crash. */
  closing: boolean;
  reading: Promise<void>;
  /** The mode the first `init` reported, when the query started without one of the bridge's own. */
  settingsMode: string | null;
  overridden: boolean;
  lastMode: string | null;
  /** Claude Code was asked the window its model's context fills. */
  windowAsked: boolean;
}

/** Why a session from the desk is not continued while a terminal has it. */
export const terminalHasIt = `This session is open in a terminal on the ${machineWord()}. Close it there, or fork it, to continue it here.`;
/** When to look for the title Claude gives a new session, in milliseconds after its turn. */
const titleRetries = [0, 2000, 5000, 15_000];
/**
 * And while its turn runs, in milliseconds after the turn opened: Claude writes the
 * title a few seconds after the first message, and the turn may last many minutes.
 */
export const titleWatch = [4000, 10_000, 25_000, 60_000];

export { imageType };

/**
 * A message for Claude: the images first, then the text. Images Claude cannot read are
 * counted in `skipped`. Text that starts with a slash Claude Code runs as its command,
 * also in content blocks; one with images or files is words (`isCommand`), and goes with
 * a space before it, which Claude Code reads as words.
 */
export function userMessage(prompt: Prompt, uuid: string): { message: SDKUserMessage; skipped: number } {
  const images: { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } }[] = [];
  let skipped = 0;
  for (const image of prompt.images) {
    const type = imageType(image.data);
    if (type) images.push({ type: "image", source: { type: "base64", media_type: type, data: image.data.toString("base64") } });
    else skipped += 1;
  }
  const words = prompt.images.length > 0 || (prompt.files?.length ?? 0) > 0;
  const text = words && prompt.text.startsWith("/") ? ` ${prompt.text}` : prompt.text;
  const content = images.length === 0 ? text : [...images, ...(text ? [{ type: "text" as const, text }] : [])];
  return {
    message: { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "", uuid: uuid as SDKUserMessage["uuid"] },
    skipped,
  };
}

export class ClaudeSession implements ProviderSession, Warmable {
  readonly id: string;
  readonly cwd: string;
  private readonly sink: SessionSink;
  private readonly host: ClaudeHost;
  private readonly stored: StoredMessage[];
  /** The to-do list Claude keeps with its task tools, which outlasts each process (todos.ts). */
  private readonly todos: ClaudeTodos;
  /** The subagents and workflows the stored conversation tells of. */
  private readonly past: PastSubagent[];
  /** The stored conversation's last turn was cut off mid-way (`turnCutOff`). */
  private readonly cutOff: boolean;
  /** Started at the desk: a terminal may have it open, and then it is not resumed here. */
  private readonly desk: boolean;
  private current: SessionSettings;
  private threadMode: ThreadMode;
  /** The mode before the thread went into plan mode: an approved plan starts its work in it. */
  private modeBeforePlan: ThreadMode = "default";
  private title: string | null;
  /** Changes whenever a title is taken or renamed, so a delayed read cannot undo it. */
  private titleRevision = 0;
  private live: Live | null = null;
  private starting: Promise<Live> | null = null;
  private closed = false;
  private turnOpen = false;
  /** How many turns have opened, so what was meant for one turn never acts on the next. */
  private turns = 0;
  private asking = 0;
  /** Changes asked for while a turn ran, made when it ends. */
  private modelChanged = false;
  private effortChanged = false;
  private stopTimer: NodeJS.Timeout | null = null;
  private readonly stderr: string[] = [];

  constructor(options: SessionOptions, sink: SessionSink, host: ClaudeHost, history: StoredMessage[] = [], past: PastSubagent[] = [], cutOff = false) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.sink = sink;
    this.host = host;
    this.stored = history;
    this.todos = ClaudeTodos.from(history);
    this.past = past;
    this.cutOff = cutOff;
    this.desk = options.desk ?? false;
    this.current = { ...options.settings, reasoningEffort: claudeEffort(options.settings.reasoningEffort) ?? "" };
    this.threadMode = options.mode ?? "default";
    // A thread saved in plan mode before the bridge kept what came before: asking is the
    // safe guess, never more access than it may have had.
    this.modeBeforePlan = options.modeBeforePlan ?? (this.threadMode === "plan" ? "ask" : "default");
    this.title = options.title ?? null;
  }

  get busy(): boolean {
    return this.turnOpen || this.asking > 0 || this.starting !== null || this.hasBackgroundWork();
  }

  /** Background commands, subagents or workflows still run in Claude's process: they stop if it does. */
  hasBackgroundWork(): boolean {
    return this.live?.stream.hasBackgroundWork ?? false;
  }

  get isWarm(): boolean {
    return this.live !== null;
  }

  /** The thread's running Claude Code, when it has one, to ask what only a running one can say. */
  get liveQuery(): QueryLike | null {
    return this.live?.query ?? null;
  }

  async history(): Promise<StoredMessage[]> {
    return structuredClone(this.stored);
  }

  pastSubagents(): PastSubagent[] {
    return structuredClone(this.past);
  }

  lastTurnCutOff(): boolean {
    return this.cutOff;
  }

  settings(): SessionSettings {
    return { ...this.current };
  }

  async reload(): Promise<StoredMessage[]> {
    return historyFromSession(await this.host.files.messages(this.id, this.cwd), this.cwd);
  }

  // MARK: Turns

  startTurn(prompt: Prompt): void {
    if (this.closed) return;
    this.turnOpen = true;
    this.turns += 1;
    void this.send(prompt);
    void this.watchTitle(this.turns);
  }

  /** Claude takes a message whenever it comes: into the running turn, or one of its own after it. */
  async steer(prompt: Prompt): Promise<boolean | "refused"> {
    if (this.closed) return "refused";
    return this.send(prompt, true);
  }

  private async send(prompt: Prompt, steering = false): Promise<true | "refused"> {
    let live: Live;
    try {
      live = await this.warm();
      for (;;) {
        const controls = live.controls;
        const permission = live.permission;
        await controls;
        await permission;
        if (controls === live.controls && permission === live.permission) break;
      }
      if (this.closed || this.live !== live || live.closing) return "refused";
    } catch (error) {
      // The original native turn still runs when a steer was never sent. Keep it
      // open; the session will retain this input for a turn of its own.
      if (this.closed || steering) return "refused";
      const message = (error as Error).message;
      this.endTurn({ type: "turn.end", status: "error", error: message === terminalHasIt ? message : `Claude Code could not start: ${message}` });
      return "refused";
    }
    const uuid = randomUUID();
    const { message, skipped } = userMessage(prompt, uuid);
    if (skipped > 0) {
      this.emit({ type: "notice", level: "warn", text: skippedImagesText(skipped, "Claude") });
    }
    live.stream.sent(uuid);
    try {
      live.input.push(message);
    } catch (error) {
      if (!steering) this.endTurn({ type: "turn.end", status: "error", error: (error as Error).message });
      return "refused";
    }
    this.host.pool.touch(this);
    return true;
  }

  async interrupt(): Promise<boolean> {
    if (!this.turnOpen) return false;
    const turn = this.turns;
    const live = this.live ?? (this.starting ? await this.starting.catch(() => null) : null);
    if (!live || !this.turnOpen || this.turns !== turn) return false;
    live.stream.interrupting();
    // A turn that does not end by itself is ended by stopping the process. Set before
    // Claude answers, which may be after the turn has ended (Stop as it finished): set
    // then, it was cleared by no turn and stopped the next one.
    this.stopTimer ??= setTimeout(() => {
      this.stopTimer = null;
      if (this.turnOpen && this.turns === turn && this.live === live) live.query.close();
    }, this.host.interruptGraceMs);
    this.stopTimer.unref();
    try {
      await live.query.interrupt();
    } catch (error) {
      log.warn("Claude did not take the interrupt", { session: this.id, error: (error as Error).message });
    }
    return true;
  }

  /** Stops one subagent or workflow Claude runs; the turn, if any, goes on. */
  async stopSubagent(id: string): Promise<boolean> {
    const live = this.live;
    if (!live || !(live.stream.board.isStoppable(id) || live.stream.commands.running(id))) return false;
    await live.query.stopTask(id);
    return true;
  }

  // MARK: Settings

  async setModel(model: string, provider: string): Promise<ModelChangeResult> {
    this.current = { ...this.current, model, provider };
    if (!this.live) return { deferred: false };
    if (this.turnOpen) {
      this.modelChanged = true;
      return { deferred: true };
    }
    const live = this.live;
    await this.control(live, async () => { if (this.live === live) await this.applyModel(live); });
    return { deferred: false };
  }

  async setReasoning(level: string): Promise<void> {
    this.current = { ...this.current, reasoningEffort: claudeEffort(level) ?? "" };
    if (!this.live) return;
    if (this.turnOpen) {
      this.effortChanged = true;
      return;
    }
    const live = this.live;
    await this.control(live, async () => { if (this.live === live) await this.applyEffort(live); });
  }

  mode(): ModeState {
    const defaults = threadModeFor(this.live?.settingsMode ?? this.host.settingsMode);
    return defaults ? { mode: this.threadMode, defaultsTo: defaults } : { mode: this.threadMode };
  }

  async setMode(mode: ThreadMode): Promise<void> {
    if (mode === "plan" && this.threadMode !== "plan") this.modeBeforePlan = this.threadMode;
    this.threadMode = mode;
    const live = this.live;
    if (!live) return;
    const target = this.effectiveMode(live);
    if (target) {
      live.permission = this.control(live, async () => {
        if (this.live !== live || live.closing) return;
        await live.query.setPermissionMode(target);
        live.lastMode = target;
      });
      await live.permission;
    }
  }

  private effectiveMode(live: Live | null): PermissionMode | null {
    return permissionModeFor(this.threadMode) ?? ((live?.settingsMode ?? this.host.settingsMode) as PermissionMode | null);
  }

  private async applyModel(live: Live): Promise<void> {
    await live.query.setModel(this.current.model && this.current.model !== "default" ? this.current.model : undefined);
    if (this.live === live && !live.closing) await this.applyThinking(live);
  }

  private async applyEffort(live: Live): Promise<void> {
    await live.query.applyFlagSettings({ effortLevel: claudeEffort(this.current.reasoningEffort) });
    if (this.live === live && !live.closing) await this.applyThinking(live);
  }

  private control(live: Live, apply: () => Promise<void>): Promise<void> {
    const result = live.controls.then(apply);
    // A refused idle setting is returned to its caller without poisoning later sends.
    live.controls = result.catch(() => {});
    return result;
  }

  /** The model decides how much to think. A model Claude Code lists without saying so (Haiku 4.5) does not; one it does not list is assumed to. */
  private adaptiveThinking(): boolean {
    const info = this.host.modelInfo(this.current.model);
    return info ? info.supportsAdaptiveThinking === true : true;
  }

  /** Thinking text streams only with the summarized display; models without adaptive thinking need a budget for it. */
  private async applyThinking(live: Live): Promise<void> {
    const adaptive = this.adaptiveThinking();
    await live.query.setMaxThinkingTokens(adaptive ? null : thinkingBudget(claudeEffort(this.current.reasoningEffort)), "summarized");
  }

  // MARK: The process

  private warm(): Promise<Live> {
    // While it starts, everything waits for it, so messages keep their order.
    if (this.starting) return this.starting;
    if (this.live && !this.live.input.isEnded) return Promise.resolve(this.live);
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<Live> {
    // Resuming a session a terminal has open writes to it behind the terminal's back
    // (docs/bridge-spikes.md, S2).
    if (this.desk && (await this.host.isOpenInTerminal(this.id))) {
      throw new Error(terminalHasIt);
    }
    if (this.closed) throw new Error("Claude session closed before it started.");
    const exists = await this.host.files.exists(this.id, this.cwd);
    if (this.closed) throw new Error("Claude session closed before it started.");
    const effort = claudeEffort(this.current.reasoningEffort);
    const adaptive = this.adaptiveThinking();
    const permissionMode = this.effectiveMode(null);
    const overridden = permissionModeFor(this.threadMode) !== null;
    this.stderr.length = 0;
    const input = new InputQueue();
    const options = queryOptions({
      claudePath: this.host.claudePath,
      cwd: this.cwd,
      // The thread says who it is when it uses the `portals` command.
      env: this.host.portals ? { ...this.host.env, PORTALS_THREAD: this.id } : this.host.env,
      append: this.host.portals?.instructions ?? undefined,
      // Never a session the bridge did not start: the registry holds only the bridge's own.
      ...(exists ? { resume: this.id } : { sessionId: this.id, title: this.title ?? undefined }),
      model: this.current.model,
      permissionMode: overridden ? permissionMode : null,
      effort,
      adaptiveThinking: adaptive,
      canUseTool: this.canUseTool,
      stderr: (data) => {
        this.stderr.push(data);
        if (this.stderr.length > 20) this.stderr.shift();
      },
    });
    if (counters.on) counters.spawned("claude");
    const query = this.host.query(input, options);
    const live: Live = {
      query,
      input,
      stream: new ClaudeStream({ cwd: this.cwd, background: (event) => this.sink.emit(event), todos: this.todos, windows: this.host.windows }),
      controls: Promise.resolve(),
      permission: Promise.resolve(),
      closing: false,
      reading: Promise.resolve(),
      settingsMode: null,
      overridden,
      lastMode: null,
      windowAsked: false,
    };
    live.reading = this.read(live);
    this.live = live;
    this.host.pool.warmed(this);
    log.info("Claude session started", { session: this.id, resumed: exists });
    if (!adaptive) {
      await query.setMaxThinkingTokens(thinkingBudget(effort), "summarized").catch((error: Error) => log.warn("could not turn on thinking text", { error: error.message }));
    }
    return live;
  }

  private async read(live: Live): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const message of live.query) this.receive(live, message);
    } catch (error) {
      // After an interrupt the SDK throws the last error result once the process exits.
      if (!live.closing) failure = (error as Error).message;
    }
    if (this.live === live) this.live = null;
    // A process cooled while a message was on its way may exit after the next one has
    // started: that one is still warm.
    if (this.live === null) this.host.pool.cooled(this);
    // Subagents and workflows run in the process, and ended with it.
    for (const subagent of live.stream.board.stopAll()) this.sink.emit({ type: "subagent", subagent });
    // So did the commands it ran in the background.
    live.stream.commands.close("Claude Code's process ended, and the command with it.");
    if (live.closing) return;

    const detail = failure ?? this.stderr.join("").trim().split("\n").at(-1) ?? "";
    log.warn("Claude session ended by itself", { session: this.id, detail });
    if (!this.turnOpen) return;
    if (live.stream.isInterrupting) {
      this.endTurn({ type: "turn.end", status: "interrupted", usage: live.stream.usage, ...live.stream.spentSoFar() });
      return;
    }
    const message = `Claude Code stopped unexpectedly${detail ? `: ${detail}` : "."}`;
    this.emit({ type: "error", message });
    this.endTurn({ type: "turn.end", status: "error", error: message, retryable: true, ...live.stream.spentSoFar() });
  }

  private receive(live: Live, message: SDKMessage): void {
    if (this.live !== live) return;
    if (message.type === "rate_limit_event") this.host.limitsHeard(message.rate_limit_info as Record<string, unknown>);
    if (message.type === "system" && message.subtype === "init") this.host.version.runningIs(message.claude_code_version);
    // Claude Code also sends `api_retry` after a turn's result, as a heartbeat while a
    // background agent waits out a usage limit: at rest there is no turn to show it in,
    // and a line held from it would stand over the next run (2026-10-26: "Drop
    // them at rest"). Dropped before the stream sees it, so nothing waits to be cleared.
    if (!this.turnOpen && message.type === "system" && (message as { subtype?: unknown }).subtype === "api_retry") {
      log.debug("dropped Claude's API retry between turns", { session: this.id });
      return;
    }
    for (const event of live.stream.map(message)) {
      if (event.type === "turn.end") this.endTurn(event);
      else if (event.type === "turn.begin") this.beginOwn(event);
      else this.emit(event);
    }
    this.observeMode(live);
    if (message.type === "system" && (message as { subtype?: unknown }).subtype === "init") {
      this.host.terminalCommands((message as { terminal_slash_commands?: unknown }).terminal_slash_commands);
      this.askWindow(live);
    }
  }

  /**
   * The window the context fills, asked of Claude Code once the process has said its
   * model, when no process on that model has said it yet: a result is the only other
   * place it comes from, so a long first turn showed no context use until it ended
   * (2026-10-27: "in this session i cant see ur context usage").
   */
  private askWindow(live: Live): void {
    if (live.windowAsked || live.stream.knowsWindow || !live.query.getContextUsage) return;
    live.windowAsked = true;
    live.query
      .getContextUsage({ detail: "summary" })
      .then((answer) => {
        if (this.live !== live) return;
        for (const event of live.stream.window(answer.model, answer.rawMaxTokens)) this.emit(event);
      })
      .catch((error: Error) => log.debug("Claude Code did not say its context window", { session: this.id, error: error.message }));
  }

  /** The mode Claude reports, against the thread's. */
  private observeMode(live: Live): void {
    const reported = live.stream.reported.permissionMode;
    if (!reported || reported === live.lastMode) return;
    const first = live.lastMode === null;
    live.lastMode = reported;
    if (first) {
      if (!live.overridden) live.settingsMode = reported;
      this.host.learn(live.query, live.stream.reported, live.overridden);
      return;
    }
    // Claude changed it itself: a plan was approved, or a rule granted for the session.
    if (this.threadMode === "default" && reported === (live.settingsMode ?? this.host.settingsMode)) return;
    const mode = threadModeFor(reported);
    if (mode && mode !== this.threadMode) {
      if (mode === "plan") this.modeBeforePlan = this.threadMode;
      this.threadMode = mode;
      this.sink.emit({ type: "mode", mode });
    }
  }

  /** Claude began a turn by itself. While the app's turn is open, it is part of that one. */
  private beginOwn(event: Extract<ProviderEvent, { type: "turn.begin" }>): void {
    if (this.turnOpen) return;
    this.turnOpen = true;
    this.turns += 1;
    this.sink.emit(event);
    this.host.pool.touch(this);
  }

  private emit(event: ProviderEvent): void {
    // Anything else Claude does between turns has no turn to show it in.
    const inTurnOnly = event.type === "text" || event.type === "reasoning" || event.type === "commentary" || event.type === "tool.start" || event.type === "tool.end";
    if (inTurnOnly && !this.turnOpen) {
      log.debug("dropped Claude output between turns", { session: this.id, type: event.type });
      return;
    }
    this.sink.emit(event);
  }

  private endTurn(event: Extract<ProviderEvent, { type: "turn.end" }>): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    const live = this.live;
    if (live) void this.control(live, () => this.afterTurn(live));
    this.sink.emit(event);
    this.host.pool.touch(this);
    void this.readTitle();
  }

  private async afterTurn(live: Live): Promise<void> {
    while (this.live === live && !live.closing && (this.modelChanged || this.effortChanged)) {
      const changes: (() => Promise<void>)[] = [];
      if (this.modelChanged) changes.push(() => this.applyModel(live));
      if (this.effortChanged) changes.push(() => this.applyEffort(live));
      // A change arriving during a control's reply remains pending for the next pass.
      this.modelChanged = false;
      this.effortChanged = false;
      for (const apply of changes) {
        if (this.live !== live || live.closing) break;
        try {
          await apply();
        } catch (error) {
          log.warn("could not change the model or thinking level", { session: this.id, error: (error as Error).message });
        }
      }
    }
  }

  /**
   * Claude names a session by itself, a little after its first message, and `/rename`
   * renames it. Read after every turn; while the thread has no name, a few more times.
   */
  private async readTitle(): Promise<void> {
    const untitled = this.title === null;
    for (const wait of untitled ? titleRetries : [0]) {
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait).unref());
      if (await this.takeTitle()) return;
      if (this.turnOpen) return;
    }
  }

  /**
   * A thread with no name is not left without one for as long as its turn runs: the
   * name is looked for a few times while turn `turn` is open, until there is one. The
   * end of the turn reads it in any case.
   */
  private async watchTitle(turn: number): Promise<void> {
    let waited = 0;
    for (const at of this.host.titleWatchMs) {
      if (this.title !== null) return;
      await new Promise((resolve) => setTimeout(resolve, at - waited).unref());
      waited = at;
      if (this.title !== null || !this.turnOpen || this.turns !== turn) return;
      if (await this.takeTitle(turn)) return;
    }
  }

  /** Reads the title Claude has for the session now, and says so when it is a new one. */
  private async takeTitle(turn?: number): Promise<boolean> {
    const revision = this.titleRevision;
    const readingTurn = this.turns;
    try {
      const title = await this.host.files.title(this.id, this.cwd);
      if (revision !== this.titleRevision || readingTurn !== this.turns || (turn !== undefined && (!this.turnOpen || this.turns !== turn))) return false;
      if (title && title !== this.title) {
        this.titleRevision += 1;
        this.title = title;
        this.sink.emit({ type: "title", title });
        return true;
      }
    } catch (error) {
      log.debug("could not read the session's title", { session: this.id, error: (error as Error).message });
    }
    return false;
  }

  /**
   * A session Claude has stored takes the title as its own (`/rename` at the desk shows
   * it); one with no message yet is given it when its process starts.
   */
  async rename(title: string): Promise<void> {
    if (await this.host.files.exists(this.id, this.cwd)) await this.host.files.rename(this.id, this.cwd, title);
    this.titleRevision += 1;
    this.title = title;
  }

  // MARK: Questions

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const request = permissionRequest(toolName, input, options.suggestions, this.cwd);
    if (request.kind === "clarify" && request.questions.length === 0) {
      return { behavior: "deny", message: "The question had nothing to ask." };
    }
    // An approved plan starts its work in the mode the thread had before planning; left
    // to itself Claude would go back to asking before every edit and command.
    const planning = toolName === "ExitPlanMode" && request.kind === "approval";
    const startsIn = this.modeBeforePlan === "plan" ? "default" : this.modeBeforePlan;
    if (planning) request.plan = { startsIn };
    // A subagent's question is its own: one in the background may ask after the turn ended.
    if (options.agentID) request.subagent = options.agentID;
    this.asking += 1;
    try {
      const answer = await this.sink.ask(request, options.signal);
      const planMode = planning ? (permissionModeFor(startsIn) ?? ((this.live?.settingsMode ?? this.host.settingsMode) as PermissionMode | null)) : null;
      const result = permissionResult(toolName, input, options.suggestions, answer, planMode && planMode !== "plan" ? planMode : null);
      if (planning && result.behavior === "allow") {
        // Claude reports the mode it moves to; the thread is in it from here.
        this.threadMode = startsIn;
        this.sink.emit({ type: "mode", mode: startsIn });
      }
      if (result.behavior === "deny" && toolName !== "AskUserQuestion") this.live?.stream.denied.add(options.toolUseID);
      return result;
    } finally {
      this.asking -= 1;
      this.host.pool.touch(this);
    }
  };

  // MARK: Cooling and closing

  async cool(): Promise<void> {
    const live = this.live;
    if (!live || this.busy) return;
    log.info("Claude session went cold", { session: this.id });
    await this.stop(live);
  }

  async close(): Promise<void> {
    this.closed = true;
    const live = this.live ?? (this.starting ? await this.starting.catch(() => null) : null);
    if (live) await this.stop(live);
    this.host.pool.cooled(this);
    // The thread lives on in Claude Code's files; the bridge's side of it goes.
    this.host.forget(this);
  }

  /**
   * Ends the input so Claude finishes and exits; stops it outright if it lingers. A turn
   * still running (the bridge is stopping) is stopped first, as Stop stops one: with its
   * input ended Claude went on with the turn, unseen, until it was killed five seconds
   * later, and wrote no mark of the stop, so after the restart the turn showed what it
   * had said as a turn that had ended. Stopped, Claude writes `[Request interrupted by
   * user]` in its history, which shows the turn stopped (history.ts). Its answer is
   * waited for a second at most, within the six seconds closing gives the sessions.
   */
  private async stop(live: Live): Promise<void> {
    live.closing = true;
    if (this.live === live) this.live = null;
    this.host.pool.cooled(this);
    if (this.turnOpen) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        live.query.interrupt().catch(() => undefined),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, 1000))),
      ]);
      clearTimeout(timer);
    }
    live.input.end();
    await Promise.race([live.reading, new Promise<void>((resolve) => setTimeout(resolve, 5000).unref())]);
    // Kills it if it is still there, and frees what the SDK holds either way.
    live.query.close();
  }
}
