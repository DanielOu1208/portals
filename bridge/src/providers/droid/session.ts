import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  AutonomyLevel, ContextStatsAccuracy, convertNotificationToStreamMessage, DroidInteractionMode, DroidWorkingState, ReasoningEffort, StreamStateTracker,
  ToolConfirmationOutcome, type CreateSessionOptions, type DroidStreamEvent, type ModelInfo, type RequestPermissionRequestParams,
} from "@factory/droid-sdk/node";
import { log } from "../../log.ts";
import { noteFor, type Ended } from "../claude/background.ts";
import { imageType, skippedImagesText } from "../images.ts";
import type { WarmPool } from "../pool.ts";
import { titleFrom } from "../titles.ts";
import {
  SettingRefused, type CompactionTrigger, type ModeState, type ModelChangeResult, type Prompt, type ProviderEvent,
  type ProviderSession, type SessionOptions, type SessionSettings, type SessionSink, type StoredMessage, type ThreadMode,
} from "../types.ts";
import { appEffort, modeFor, policyFor, sdkEffort, type DroidPolicy } from "./models.ts";
import { askUser, pickOptions } from "./requests.ts";
import { DroidPermissions } from "./permissions.ts";
import { DroidHandoff } from "./handoff.ts";
import type { DroidHandle, DroidSdk } from "./sdk.ts";
import { sessionsSoFar, type DroidStore, type DroidThread } from "./store.ts";
import { DroidStream } from "./stream.ts";
import { tokenTotal } from "./activity.ts";
import { DroidQueue } from "./queue.ts";
import { DroidWork } from "./work.ts";
import { backgroundProcesses, DroidBackground } from "./background.ts";
import { DroidControls } from "./controls.ts";
import { DroidMcpAuth } from "./auth.ts";
import type { McpAuthAction, McpAuthCard } from "../mcpAuth.ts";

export interface DroidHost {
  sdk: DroidSdk;
  store: DroidStore;
  pool: WarmPool;
  note: string | null;
  /** The bridge offers the `portals` command: each thread's process is told which thread it is (`PORTALS_THREAD`). */
  tellsThread: boolean;
  interruptGraceMs: number;
  backgroundHoldMs: number;
  now: () => number;
  model(id: string): ModelInfo | undefined;
  learn(handle: DroidHandle): void;
  forget(session: DroidSession): void;
  canContinue?(session: string, cwd: string): Promise<void>;
  readDesk?(session: string, id: string, cwd: string): Promise<DroidThread | null>;
  /** A short name for a thread whose first message is `message`, on the thread's model `model`, made off the turn's path; null for none. */
  name(message: string, model: string): Promise<string | null>;
}

interface Turn {
  abort: AbortController;
  interrupted: boolean;
  ended: boolean;
  stream: DroidStream;
  streaming?: boolean;
  handoff: DroidHandoff;
  policyBeforeHandoff?: { mode: ThreadMode; defaults: DroidPolicy };
  policyChanged?: boolean;
  timer?: NodeJS.Timeout;
  /** A turn Droid began by itself (`follow`): what makes it, as the SDK's stream makes a turn it follows. */
  own?: Own;
  /** The app's turn: Droid's own turn for its message is over, so what Droid says next is a turn of its own (`follow`). */
  droidDone?: boolean;
  /** Being ended here (`end`): what comes meanwhile is no longer held for after it (`later`). */
  ending?: boolean;
  /** `run` took up the new session Droid handed a plan to; else `end` leaves it to the next turn (`deferredHandoff`). */
  handedOn?: boolean;
}

/**
 * A turn Droid began by itself, which no stream of the SDK's follows: to answer background
 * work that ended between turns, or a steering message it took after the turn it was sent
 * in had ended (recent-16). Its events are made from Droid's notifications, as the SDK's
 * stream makes them (`follow`).
 */
interface Own {
  tracker: StreamStateTracker;
  /**
   * The ids its end may name (`agent_turn_completed`'s `turnId`, the id of the message that
   * began it): the completions it answers and the steering messages it took (their
   * request's and message's). The end of another turn of Droid's own is not its end.
   */
  ids: Set<string>;
  /** The completions heard while it runs, which it does not answer: Droid answers each in a turn of its own, whose end is not this one's. */
  others: Set<string>;
  /** Droid was heard at work in it: an idle after that ends it, should its end not come. */
  working: boolean;
}

/** Whether `notification` is something Droid says in a turn: the first thing in one it began by itself opens it (`follow`). */
function says(notification: Record<string, unknown>): boolean {
  if (notification.type === "create_message") {
    const message = notification.message;
    return !!message && typeof message === "object" && (message as Record<string, unknown>).role === "assistant";
  }
  return notification.type === "assistant_text_delta" || notification.type === "thinking_text_delta" || notification.type === "tool_call";
}

/**
 * The turns Droid begins to answer a background command's, Task's or Script's completion
 * (`DroidWork`; a Script, Droid's way of calling its tools since 0.247, run in the
 * background): their ids are their completion message's, `script-completion-batch:…` for
 * Scripts that ended together (CLI 0.250).
 */
const completionTurn = /^(execute|task|script)-completion(-batch)?:/;

/**
 * How long after Droid answered the thread's /compact its `session_compacted` is taken for
 * that compaction: Droid says it compacted some milliseconds after its answer (CLI 1.0 and
 * 1.3), and that word is not a compaction of its own.
 */
const compactionNoticeMs = 10_000;

/**
 * What Droid's last call to the model took, as its context meter weighs it: what was sent
 * (`inputTokens`, which counts the cache written), what was read from the cache and what
 * came back (`lastCallTokenUsage`). Undefined when it says none.
 */
function lastCallUsed(usage: unknown): number | undefined {
  const parts = lastCallParts(usage);
  const used = parts?.reduce((sum, part) => sum + part, 0);
  return used ? used : undefined;
}

/** `lastCallTokenUsage`'s three figures, as one call's: Droid says them again, unchanged, whenever the session's totals change. */
function lastCallParts(usage: unknown): number[] | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const { inputTokens, cacheReadTokens, outputTokens } = usage as Record<string, unknown>;
  const parts = [inputTokens, cacheReadTokens, outputTokens ?? 0];
  return parts.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0) ? parts as number[] : undefined;
}

/** Droid's answer that it is at work on a turn, which it ends before it compacts: the process is fine and stays. */
class DroidBusy extends Error {}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export class DroidSession implements ProviderSession {
  readonly id: string;
  private readonly options: SessionOptions;
  private readonly sink: SessionSink;
  private readonly host: DroidHost;
  private state: DroidThread | null;
  private handle: DroidHandle | null = null;
  /** Settings RPCs all carry permission policy, including model-only changes. */
  private applyingSettings: Promise<void> = Promise.resolve();
  /** A refused mode change blocks prompts until another explicit mode request succeeds. */
  private permission: Promise<void> = Promise.resolve();
  private readonly controls = new DroidControls();
  private controlling = false;
  private readonly auth: DroidMcpAuth;
  private authOperations = 0;
  private opening: Promise<DroidHandle> | null = null;
  private lifetime: AbortController | null = null;
  private unlisten: (() => void) | null = null;
  private turn: Turn | null = null;
  private compacting = false;
  /** Droid said it compacted while the thread's /compact ran (`compact`). */
  private compactionHeard = false;
  /** When the thread's /compact was taken with Droid's word of it still to come (`compactionNoticeMs`). */
  private compactedAt: number | undefined;
  /** A compaction under way, also one a Stop left running (`compact`): the next turn waits for it. */
  private compaction: Promise<void> | null = null;
  private readonly compactionIds = new Set<string>();
  private readonly queue: DroidQueue;
  private readonly permissions: DroidPermissions;
  private readonly work: DroidWork;
  /** The commands Droid runs in the background, as its footer lists them: rows of their own, each with a Stop. */
  private readonly background: DroidBackground;
  private autonomousWorking = false;
  private autonomousAt = 0;
  /** Background work of the thread's own that ended between turns: the next turn Droid begins by itself answers it (`beginOwn`). */
  private ends: Ended[] = [];
  /** The ids of the completions that told of `ends`: the turn that answers them ends under one of them (`Own.ids`). */
  private endIds: string[] = [];
  /** What Droid said after its turn for the app's message, while the app's turn was still closing here: told once it has (`end`). */
  private early: { notification: Record<string, unknown>; end?: Ended }[] = [];
  /** While `early` is told, a message sent at rest waits for it (`catchingUp`). */
  private replay: Promise<void> | null = null;
  /** `early` is being told (`end`): a turn of Droid's own that ends meanwhile does not let go of the process (`checkHandoff`). */
  private telling = false;
  private deferredHandoff = false;
  /** The message id of the steering message whose receipt is being taken in (`carry`). */
  private receiptMessage: string | undefined;
  /** The ids of steering messages Droid took (their request's and message's), the latest few: the turn it runs for one is not the bridge's (`otherTurn`). */
  private readonly lateTurns = new Set<string>();
  private handoffTimer: NodeJS.Timeout | undefined;
  private savedAt = 0;
  /**
   * What the session's conversation takes of the context, as Droid's last call to the model
   * found it (`observeContext`): unknown until Droid reports a call, and again once the
   * thread goes on in another session (a compaction's, a plan's).
   */
  private contextUsed: number | undefined;
  /**
   * Droid is at work on a turn of the thread's session, as it says (a working state other
   * than idle, until its turn's end): a call it reports then is the conversation's, one it
   * reports otherwise a side call's (`conversing`).
   */
  private droidAtWork = false;
  /** The last call Droid reported (its three figures), taken or not: the same again is no new call (`observeContext`). */
  private lastCall: string | undefined;
  /** How long the last save took: a mid-turn save waits the longer for a long thread (`saveSoon`). */
  private saveMs = 0;
  private closed = false;
  private ending: Promise<void> = Promise.resolve();
  /** The thread's title as far as this session knows: the one it was opened with, its first message's first line, Droid's name for it, or the user's. */
  private title: string | null;
  /** The title when it is one nobody chose (its first message's first line, or Droid's own name), which Droid's name may replace; null once the user named the thread. */
  private autoTitle: string | null = null;
  /** While the bridge's name for the thread is being made (`nameAfter`): Droid's own name meanwhile, kept for when none comes. */
  private naming: { droids: string | null } | null = null;

  constructor(options: SessionOptions, sink: SessionSink, host: DroidHost, state: DroidThread | null) {
    this.id = options.id;
    this.options = options;
    this.sink = sink;
    this.host = host;
    this.state = state;
    this.title = options.title ?? null;
    this.background = new DroidBackground((event) => this.sink.emit(event), { now: host.now, atWork: () => this.droidAtWork || !!this.turn });
    this.work = new DroidWork(() => this.state?.session, (event) => {
      if (this.state) {
        this.state.subagents = this.work.snapshot();
        if (event.type === "tool.end") {
          const row = this.state.messages.findLast((message) => message.role === "tool" && message.tool_call_id === event.id);
          if (row?.role === "tool") row.content = JSON.stringify(event.result);
        }
        if (this.turn || (event.type === "subagent" && event.subagent.status === "running")) this.saveSoon(); else this.save();
      }
      this.host.pool.touch(this);
      this.sink.emit(event);
      queueMicrotask(() => this.checkHandoff());
    }, state?.subagents, { holdMs: host.backgroundHoldMs, now: host.now, commandEnded: (id, status) => this.background.finished(id, status) });
    if (state?.subagents?.some((child) => child.status === "running")) {
      state.subagents = this.work.snapshot();
      this.save();
    }
    this.auth = new DroidMcpAuth(() => this.sink.emit({ type: "mcp.auth" }));
    this.permissions = new DroidPermissions(sink, (params, outcome) => this.permissionSelected(params, outcome));
    this.queue = new DroidQueue((event) => this.sink.emit(event), (requestId, prompt) => {
      if (!this.state) return;
      // Before the queue tells of it: the turn Droid runs it in is open when it joins it, and
      // a line that opens that turn comes before it.
      this.carry(requestId);
      this.state.messages.push({ role: "user", text: prompt.text, display_kind: "steer", timestamp: Date.now() });
      this.state.queueReceipts = [...(this.state.queueReceipts ?? []), requestId].slice(-512);
      // When writable, receipt precedes the bridge's dequeue. If not, known acceptance
      // still reaches the bridge, with a storage warning, and the next save retries it.
      this.saveNotified("this steering message's receipt");
    });
    if (state?.open) {
      state.messages.push({ role: "assistant", text: "The bridge stopped during this turn. Send another message to continue the saved Droid conversation.",
        timestamp: Date.now(), display_kind: "failed_turn", display_metadata: { interrupted: true } });
      state.open = false;
      this.save();
    }
  }

  private forking = false;
  get busy(): boolean { return this.forking || this.controlling || this.authOperations > 0 || this.auth.busy || !!this.turn || !!this.opening || this.compacting || this.hasBackgroundWork(); }
  /** A warm fork does not replace the source handle, so its next turn stays on its source. */
  async fork(title: string, cold?: (thread: DroidThread | null) => Promise<string>): Promise<{ id: string; thread: DroidThread | null; warm: boolean } | null> {
    if (this.busy) throw new Error("Wait for this Droid thread and its background work to finish before forking.");
    const handle = this.handle?.connected() ? this.handle : null;
    if (handle && !handle.fork) throw new Error("This Droid connection cannot fork sessions.");
    const copy = handle?.fork ? handle.fork.bind(handle, title) : cold;
    if (!copy) return null;
    this.forking = true;
    try {
      const thread = structuredClone(this.state);
      const id = await copy(thread);
      return { id, thread, warm: !!handle };
    } finally { this.forking = false; }
  }
  hasBackgroundWork(): boolean {
    if (this.autonomousWorking && this.host.now() - this.autonomousAt >= this.host.backgroundHoldMs) {
      this.autonomousWorking = false;
      this.sink.emit({ type: "notice", level: "info", text: "Background tracking ended after an hour without activity. No terminal outcome was reported; this process may now cool." });
    }
    const busy = !!this.handle && (this.work.busy || this.autonomousWorking);
    if (!busy && this.deferredHandoff) queueMicrotask(() => this.checkHandoff());
    return busy;
  }

  /** A source SDK handle cannot stream to the target, but its process may still own live jobs. */
  private checkHandoff(): void {
    // Not while what Droid said as the app's turn closed is told (`end`): its process carries all of it.
    if (!this.deferredHandoff || this.turn || this.closed || this.telling) return;
    if (this.hasBackgroundWork()) {
      this.handoffTimer ??= setTimeout(() => {
        this.handoffTimer = undefined;
        this.checkHandoff();
      }, this.host.backgroundHoldMs);
      this.handoffTimer.unref();
      return;
    }
    this.deferredHandoff = false;
    void this.release().then(() => this.warm()).catch(() => {
      if (!this.closed) this.sink.emit({ type: "notice", level: "warn", text: "The implementation session is saved, but could not be reopened. Send another message to retry." });
    });
  }
  /**
   * The conversation as the bridge kept it, its times in seconds as the protocol's are:
   * kept in milliseconds, they made every Droid turn read back a thousand times as long
   * (the app times a turn without figures from its messages).
   */
  history(): Promise<StoredMessage[]> {
    return Promise.resolve(structuredClone(this.state?.messages ?? []).map((message) => (message.timestamp > 1e12 ? { ...message, timestamp: message.timestamp / 1000 } : message)));
  }
  async reload(): Promise<StoredMessage[]> {
    if (this.options.readOnly && this.state?.deskSource) {
      const state = await this.host.readDesk?.(this.state.session, this.id, this.options.cwd);
      if (state) this.state = state;
    }
    return this.history();
  }
  settings(): SessionSettings {
    return { ...(this.state?.settings ?? this.options.settings) };
  }
  attached(): null {
    if (this.state?.contextUsage) this.sink.emit({ type: "usage", usage: this.state.contextUsage });
    for (const subagent of this.work.snapshot()) this.sink.emit({ type: "subagent", subagent });
    return null;
  }
  mode(): ModeState {
    return { mode: this.state?.mode ?? this.options.mode ?? "default", ...(this.state ? { defaultsTo: modeFor(this.state.defaults) } : {}) };
  }

  /** New sessions are saved before the bridge can send their first message. */
  async initialize(): Promise<void> { await this.warm(); }

  private save(): void {
    if (!this.state) return;
    const started = this.host.now();
    this.host.store.write(this.state);
    this.savedAt = this.host.now();
    this.saveMs = this.savedAt - started;
  }

  /** Droid already acted: a failed write must not swallow its receipt or turn's start. */
  private saveNotified(what: string): void {
    try { this.save(); } catch (error) {
      log.warn("could not save Droid's notification", { session: this.id, error: (error as Error).message });
      this.sink.emit({ type: "notice", level: "error", text: `Droid is continuing, but Portals could not save ${what}. Do not resend messages Droid already took. Check disk space and file permissions.` });
    }
  }

  /**
   * Mid-turn: the whole conversation is written at most every two seconds, and at the
   * turn's end. A long thread's takes longer to write (17 ms for 12 MB, a thousand turns
   * with tools), so it waits 400 times as long as its last save took, which keeps saving
   * under a quarter of a percent of the bridge's time; the turn's end is saved at once.
   */
  private saveSoon(): void { if (this.host.now() - this.savedAt >= Math.max(2000, this.saveMs * 400)) this.save(); }

  private async warm(): Promise<DroidHandle> {
    // Each await lets another caller in (a prompt and a rename at once): everything is
    // checked again after it, so a thread never opens a second process beside the first.
    for (;;) {
      if (this.closed) throw new Error("This Droid session is closed.");
      if (this.opening) return this.opening;
      await this.ending;
      if (this.closed) throw new Error("This Droid session is closed.");
      if (this.opening) return this.opening;
      if (this.deferredHandoff) {
        const tracking = this.hasBackgroundWork();
        this.deferredHandoff = false;
        if (tracking) this.sink.emit({ type: "notice", level: "info", text: "Portals stopped tracking background work from the plan; it may already have finished." });
        await this.release(tracking ? "Live tracking ended for background work from the plan; it may already have finished." : undefined);
        continue;
      }
      if (this.handle?.connected()) return this.handle;
      if (this.handle) { await this.release(); continue; }
      const lifetime = new AbortController();
      this.lifetime = lifetime;
      const timeout = setTimeout(() => lifetime.abort("Droid took too long to start."), 30_000);
      timeout.unref();
      this.opening = this.open(lifetime).finally(() => { clearTimeout(timeout); this.opening = null; });
      return this.opening;
    }
  }

  private async open(lifetime: AbortController): Promise<DroidHandle> {
    if (this.options.readOnly) throw new Error("This Droid thread is view only. Fork it to continue.");
    if (this.state?.deskSource) await this.host.canContinue?.(this.state.session, this.state.cwd);
    const options: CreateSessionOptions = {
      cwd: this.state?.cwd ?? this.options.cwd, abortSignal: lifetime.signal,
      permissionHandler: (params) => {
        // A background Task's child asks for itself, also once the turn it was begun in has
        // ended (fixtures/droid/task-background.jsonl): on its own card, which that turn's end
        // does not take back, for as long as the process runs. It was refused at rest.
        const child = this.work.backgroundChild(params.associatedSessionIds);
        if (child) return this.permissions.ask(params, lifetime.signal, this.state?.beforePlan ?? "ask", this.state?.cwd ?? this.options.cwd, child.id);
        const turn = this.turn;
        if (!turn || turn.ended) return "cancel";
        return this.permissions.ask(params, turn.abort.signal, this.state?.beforePlan ?? "ask", this.state?.cwd ?? this.options.cwd);
      },
      askUserHandler: (params) => this.turn && !this.turn.ended
        ? askUser(params, this.sink, this.turn.abort.signal) : { cancelled: true, answers: [] },
      ...(this.host.note ? { systemPrompt: { type: "preset", preset: "droid", append: this.host.note } } : {}),
    };
    // Resolve the user's configured defaults first; thread overrides are session-only.
    // One process per thread: its commands can say which thread they run in.
    const handle = await this.host.sdk.open(options, this.state?.session, this.host.tellsThread ? { PORTALS_THREAD: this.id } : undefined);
    let fresh = false;
    try {
      if (this.closed || lifetime.signal.aborted) throw new Error("Droid startup was cancelled.");
      if (canonical(handle.cwd ?? options.cwd!) !== canonical(options.cwd!)) throw new Error("Droid resumed in a different folder. This conversation was not continued.");
      if (!this.state) {
        this.host.learn(handle);
        const interactionMode = handle.settings.interactionMode ?? DroidInteractionMode.Auto;
        if (![DroidInteractionMode.Auto, DroidInteractionMode.Spec].includes(interactionMode)) {
          throw new Error("Droid Mission mode is not supported in Portals. Choose normal mode in Droid first.");
        }
        const model = this.options.settings.model === "default" ? handle.settings.modelId : this.options.settings.model;
        const effort = this.options.settings.reasoningEffort || appEffort(this.options.settings.model === "default"
          ? handle.settings.reasoningEffort : this.host.model(model)?.defaultReasoningEffort ?? handle.settings.reasoningEffort);
        this.state = {
          version: 1, id: this.id, session: handle.id, cwd: canonical(handle.cwd ?? options.cwd!),
          defaults: { autonomyLevel: handle.settings.autonomyLevel ?? AutonomyLevel.Off, interactionMode },
          defaultModel: handle.settings.modelId, defaultEffort: handle.settings.reasoningEffort,
          settings: {
            model, provider: "droid", reasoningEffort: effort,
          },
          mode: this.options.mode ?? "default", beforePlan: this.options.modeBeforePlan ?? "default", open: false, messages: [],
        };
        fresh = true;
      }
      // A desk file may have lost its optional settings sidecar. Its loaded session,
      // not the word "default" as a model id, supplies what that file could not say.
      if (!this.state.defaultModel) this.state.defaultModel = handle.settings.modelId;
      if (!this.state.defaultEffort) this.state.defaultEffort = handle.settings.reasoningEffort;
      await this.applySettings(handle);
      if (!handle.connected()) throw new Error("The Droid process stopped while it was starting.");
      if (fresh) this.save();
      // A desk session continued here has loaded: it is Portals' own thread from now on, so
      // a later cold open is checked as any other is. Continue's refusals (an open Factory
      // app, unfinished tool calls, a moved folder) guard taking it over, not using it:
      // kept, an unfinished call of Portals' own turn would refuse every later open.
      if (this.state.deskSource) {
        this.state.deskSource = false;
        delete this.state.deskReadOnly;
        delete this.state.deskReadCwd;
        try { this.save(); } catch (error) {
          // Not saved: the next cold open runs Continue's checks once more, and nothing else.
          log.warn("could not save a continued Droid desk thread as Portals' own", { session: this.id, error: (error as Error).message });
        }
      }
      this.use(handle);
      void this.auth.discover(handle).catch(() => undefined);
      this.host.pool.warmed(this);
      // A session resumed: what its last call took, as Droid loaded it, or as the meter last read it.
      if (!fresh) {
        const kept = this.state.contextUsage;
        const loaded = handle.loadedUsage?.();
        this.lastCall = lastCallParts(loaded)?.join("/");
        // The call it loads may be from before a compaction with no call since, as may the
        // meter kept, should it not have been read again then: what is left is read (`refreshContext`).
        const current = this.lastCall !== undefined && this.lastCall !== this.state.staleCall;
        const keptCall = kept && !kept.estimated && this.state.staleCall === undefined ? kept.used : undefined;
        this.contextUsed = (current ? lastCallUsed(loaded) : undefined) ?? keptCall;
      }
      await this.refreshContext();
      return handle;
    } catch (error) {
      // A new thread that could not start leaves nothing saved, so it can be started again.
      if (fresh) this.state = null;
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private permissionSelected(params: RequestPermissionRequestParams, outcome: ToolConfirmationOutcome): void {
    const turn = this.turn;
    const state = this.state;
    if (!turn || turn.ended || turn.interrupted || !state) return;
    const plan = params.toolUses.some(({ details }) => details.type === "exit_spec_mode");
    const changesPolicy = /^proceed_(auto_run|new_session)(?:_|$)/.test(outcome);
    if (outcome.startsWith("proceed_new_session")) {
      turn.policyBeforeHandoff ??= { mode: state.mode, defaults: { ...state.defaults } };
      turn.handoff.expect(params);
    }
    if (!plan && !changesPolicy) return;
    state.defaults.interactionMode = DroidInteractionMode.Auto;
    const level = changesPolicy ? outcome.split("_").at(-1) : undefined;
    const levels: Record<string, ThreadMode> = { low: "edits", medium: "medium", high: "full" };
    const mode = level ? levels[level] : undefined;
    state.mode = mode ?? (plan ? state.beforePlan : state.mode);
    turn.policyChanged = changesPolicy;
    this.sink.emit({ type: "mode", mode: state.mode });
    this.save();
  }

  /** Replacement handles share a process: detach the source, never close it here. */
  private use(handle: DroidHandle): void {
    this.unlisten?.();
    this.handle = handle;
    // Droid's pick lists, as its questions: on the turn's card, while one runs.
    handle.onPickOptions?.((params) => this.turn && !this.turn.ended
      ? pickOptions(params, this.sink, this.turn.abort.signal) : Promise.resolve({ cancelled: true, selectedIds: [] }));
    handle.onBackgroundProcesses?.((session, processes) => {
      const listed = backgroundProcesses(processes);
      if (this.handle === handle && session === this.state?.session && listed) this.background.list(listed);
    });
    const offNotifications = handle.onNotification((raw) => {
      if (this.handle !== handle) return;
      const params = raw.params;
      if (!params || typeof params !== "object" || !("notification" in params)
        || !params.notification || typeof params.notification !== "object" || Array.isArray(params.notification)) return;
      const notification = params.notification as Record<string, unknown>;
      const completion = this.work.notification(params as Record<string, unknown>);
      const own = !(params as Record<string, unknown>).sessionId || (params as Record<string, unknown>).sessionId === this.state?.session;
      if (own) this.auth.notification(notification, handle);
      if (own && notification.type === "session_title_updated" && typeof notification.title === "string") {
        this.droidNamed(notification.title.trim(), notification.updateType);
      }
      if (own) {
        if (completion && !this.turn) this.autonomousWorking = true;
        if (notification.type === "droid_working_state_changed") this.autonomousWorking = this.droidAtWork = notification.newState !== DroidWorkingState.Idle;
        if (notification.type === "agent_turn_completed") this.autonomousWorking = this.droidAtWork = false;
        if (this.autonomousWorking) this.autonomousAt = this.host.now();
      }
      // A subagent's queue is its own: only a receipt for one of this thread's own steering
      // messages (matched by its unique request ID) may come with another session's ID.
      // Droid's own, while what it says is held for after the app's turn (`later`): taken in
      // then, so that a steering message it took joins the turn it runs it in.
      if (own ? !this.later() : notification.type === "create_message") this.receive(notification);
      this.permissions.notification(notification);
      const turn = this.turn;
      if (turn && !turn.ended) {
        const target = turn.handoff.observe(params as Record<string, unknown>);
        if (target && this.state) {
          const candidate = { ...this.state, session: target, previousSession: this.state.session, formerSessions: sessionsSoFar(this.state),
            sessionTokens: undefined, liveSessionTokens: undefined, sessionCredits: undefined, contextUsage: undefined };
          try {
            // Durable before opening a handle: a restart resumes the target, never replays the plan.
            this.host.store.write(candidate);
            this.state = candidate;
            this.contextUsed = undefined;
          } catch {
            turn.handoff.failure = "Could not save Droid's replacement session. The saved thread still points to its planning session.";
            void handle.interrupt().catch(() => undefined);
          }
        }
        if (turn.policyChanged && notification.type === "settings_updated" && notification.settings && typeof notification.settings === "object") {
          const settings = notification.settings as Record<string, unknown>;
          const mode = modeFor({ interactionMode: settings.interactionMode as DroidInteractionMode, autonomyLevel: settings.autonomyLevel as AutonomyLevel });
          if (mode && mode !== "plan" && this.state && mode !== this.state.mode) {
            this.state.mode = mode;
            this.sink.emit({ type: "mode", mode });
            this.saveSoon();
          }
        }
      }
      if (notification.type === "session_token_usage_changed" || notification.type === "agent_turn_completed") {
        // agent_turn_completed.tokenUsage is per-turn, not a session baseline.
        const usage = notification.type === "agent_turn_completed" ? notification.cumulativeTokenUsage : notification.tokenUsage;
        // Droid says a usage change's session inside the notification, and none on its envelope.
        const sessionId = (params as Record<string, unknown>).sessionId ?? notification.sessionId;
        if (this.state && usage && (!sessionId || sessionId === this.state.session)) {
          // A side call's spend is the session's too: only the meter passes it over (`conversing`).
          this.observeUsage(usage);
          if (notification.type === "session_token_usage_changed") this.observeContext(notification.lastCallTokenUsage);
          if (this.turn) this.saveSoon(); else this.save();
        }
      }
      // A subagent compacting its own conversation did not compact this thread's.
      if (own && notification.type === "session_compacted") {
        const id = typeof notification.summaryId === "string" ? notification.summaryId : undefined;
        if (id && this.compactionIds.has(id)) return;
        if (id) this.compactionIds.add(id);
        // The word of a /compact the thread asked for, which came after Droid's answer to it: its marker is kept already.
        const asked = this.compactedAt !== undefined && this.host.now() - this.compactedAt < compactionNoticeMs;
        this.compactedAt = undefined;
        if (this.compacting) this.compactionHeard = true;
        else if (!asked) {
          // What Droid's last call took was before it: the meter reads what is left until the next (`refreshContext`).
          this.forgetCall();
          this.recordCompaction("auto", this.state?.contextUsage?.used);
          void this.refreshContext();
        }
      }
      // What ended, told by a completion of the thread's own: taken where it comes in Droid's turns (`follow`).
      if (own) this.follow(notification, completion ? this.work.takeEnd() : undefined);
      if (this.turn && !this.turn.ended) this.turn.stream.notification(notification);
      queueMicrotask(() => this.checkHandoff());
    });
    const offExit = handle.onExit((error) => {
      if (this.handle !== handle) return;
      const turn = this.turn;
      void this.release();
      if (turn) this.end(turn, turn.interrupted ? { type: "turn.end", status: "interrupted" }
        : { type: "turn.end", status: "error", error: error.message, retryable: true });
      else this.sink.emit({ type: "error", message: error.message });
    });
    this.unlisten = () => { offNotifications(); offExit(); };
  }

  /**
   * The meter, from Droid's figure for its last call to the model (`lastCallTokenUsage`,
   * what Droid's own meter and its compaction weigh), as it reports one after each call and
   * as it loads a session. Droid's `get_context_stats` counts, when it estimates, every
   * message the session ever had, also those its compactions took out (0.247): a long
   * thread read 868k of 872k where its last call took 139k (2026-10-27: "the
   * context usage thing is broken"). Its count is kept for the limit, and for the use only
   * when it says it is exact or Droid has made no call since the conversation began or was
   * compacted (`refreshContext`). Only a call of the conversation's counts (`conversing`),
   * and only a new one: Droid says its last call's figures again, unchanged, whenever the
   * session's totals change, also the compaction's own call after it compacted.
   */
  private observeContext(lastCall: unknown): void {
    const parts = lastCallParts(lastCall);
    const used = lastCallUsed(lastCall);
    if (!parts || used === undefined || !this.state) return;
    const call = parts.join("/");
    if (call === this.lastCall) return;
    this.lastCall = call;
    if (!this.conversing()) return;
    this.contextUsed = used;
    delete this.state.staleCall;
    const max = this.state.contextUsage?.max;
    if (max === undefined) return;
    const usage = { used, max };
    this.state.contextUsage = usage;
    this.sink.emit({ type: "usage", usage });
  }

  /**
   * Whether a call Droid reports now is one of the conversation's: Droid is at work on a
   * turn, as it says or as the bridge follows one. Droid's figure for its last call is also
   * set by its side calls (CLI 0.250: the session's naming, Droid Shield's check of a
   * command, Auto's routing), and the naming one often lands after a new thread's first
   * turn has ended (fixtures/droid/compact.jsonl: 355 tokens, where the turn's own call took
   * 19,164); Droid reports a turn's own calls before it says the turn ended.
   */
  private conversing(): boolean {
    const turn = this.turn;
    return this.droidAtWork || (!!turn && !turn.ended && !turn.droidDone);
  }

  private async refreshContext(): Promise<void> {
    const handle = this.handle;
    if (!handle || !this.state) return;
    try {
      const [stats, breakdown] = await Promise.all([handle.getContextStats(), this.breakdownOf(handle)]);
      if (this.closed || this.handle !== handle || !Number.isFinite(stats.used) || stats.used < 0
        || !Number.isFinite(stats.limit) || stats.limit <= 0) return;
      const exact = stats.accuracy !== ContextStatsAccuracy.Estimated;
      // No call since a compaction: Droid's count here keeps what it took out, so the meter
      // reads what is left, as Droid's /context counts it (`get_context_breakdown`, from the
      // conversation since its latest compaction summary).
      const left = exact || this.contextUsed !== undefined || !this.compacted() ? undefined : breakdown?.used;
      // What Droid's own meter weighs against, its compaction's limit (`contextBudget`): Droid's
      // limit here is larger, and a thread whose last call took 20,037 read 2% of 872,000 where
      // Droid's /context read 10% of 200,000 (CLI 1.3.0, claude-haiku-5-5).
      const max = breakdown?.budget ?? stats.limit;
      const usage = exact || this.contextUsed === undefined
        ? { used: exact ? stats.used : left ?? stats.used, max, ...(exact ? {} : { estimated: true }) }
        : { used: this.contextUsed, max };
      this.state.contextUsage = usage;
      this.sink.emit({ type: "usage", usage });
      if (this.turn) this.saveSoon(); else this.save();
    } catch {
      // The meter is optional; a failed read must not fail an otherwise successful turn.
      log.debug("could not refresh Droid's context meter");
    }
  }

  /**
   * The conversation was compacted: what Droid's last call took was before it, and that call,
   * which Droid keeps as the session's last, is not taken for what it takes now, also as the
   * session is loaded again (`staleCall`), until Droid's next call.
   */
  private forgetCall(): void {
    this.contextUsed = undefined;
    if (this.state && this.lastCall !== undefined) this.state.staleCall = this.lastCall;
  }

  /** The thread's conversation was compacted, here or by Droid (its marker is kept). */
  private compacted(): boolean { return this.state?.messages.some((message) => message.role === "compaction") === true; }

  /**
   * What Droid's /context says: what is left of the conversation since its latest compaction,
   * as it estimates it, and the budget its meter weighs that against; each undefined when it
   * cannot say.
   */
  private async breakdownOf(handle: DroidHandle): Promise<{ used?: number; budget?: number } | undefined> {
    try {
      const { usedTokens, contextBudget } = await handle.getContextBreakdown();
      return { ...(Number.isFinite(usedTokens) && usedTokens >= 0 ? { used: usedTokens } : {}),
        ...(Number.isFinite(contextBudget) && contextBudget > 0 ? { budget: contextBudget } : {}) };
    } catch {
      return undefined;
    }
  }

  private recordCompaction(trigger: CompactionTrigger, tokensBefore?: number): void {
    const before = tokensBefore === undefined ? {} : { tokensBefore };
    this.sink.emit({ type: "compacted", trigger, ...before });
    this.state?.messages.push({ role: "compaction", trigger, timestamp: Date.now(),
      ...(tokensBefore === undefined ? {} : { tokens_before: tokensBefore }) });
    if (this.turn) this.saveSoon(); else this.save();
  }

  private async compactOnce(turn: Turn, handle: DroidHandle, instructions: string): Promise<void> {
    const compaction = this.compact(turn, handle, instructions);
    this.compaction = compaction.catch(() => undefined).finally(() => {
      if (this.compaction === settled) this.compaction = null;
    });
    const settled = this.compaction;
    await compaction;
  }

  private async compact(turn: Turn, handle: DroidHandle, instructions: string): Promise<void> {
    const before = this.state?.contextUsage?.used;
    this.compacting = true;
    this.compactionHeard = false;
    turn.stream.accept({ type: "working_state_changed", state: DroidWorkingState.CompactingConversation });
    try {
      let result: Awaited<ReturnType<DroidHandle["compact"]>>;
      try {
        result = await handle.compact(instructions ? { customInstructions: instructions } : {});
      } catch (error) {
        // Stopped: Droid gave up compacting, and its session is as it was. Not the process's failure.
        if (turn.interrupted && !this.closed) return;
        // At work on a turn the app may not show: one it began by itself, to answer background
        // work that ended, as it does when it picks up a conversation whose work a stopped
        // process left unfinished. Letting go of the process for it, as for a failure, stopped
        // that turn, and the next message's new process began it again (2026-10-27:
        // after the host restarted, /compact twice said "Wait for the current turn to finish").
        if (error instanceof Error && /wait for the current turn to finish/i.test(error.message)) {
          throw new DroidBusy("Droid is still at work on a turn of its own, which it began after background work ended. Compact once it has finished.");
        }
        throw error;
      }
      const next = result.session;
      // The thread is closing, and its process with it.
      if (this.closed) { await next.close(); return; }
      if (!next.connected() || canonical(next.cwd ?? this.state!.cwd) !== this.state!.cwd) {
        await next.close();
        throw new Error("Droid's compacted conversation is not available in this folder.");
      }
      const previous = this.state!;
      const marker: StoredMessage = { role: "compaction", trigger: "manual", timestamp: Date.now(),
        ...(before === undefined ? {} : { tokens_before: before }) };
      const candidate: DroidThread = { ...previous, session: next.id,
        messages: [...previous.messages, marker], ...(this.lastCall === undefined ? {} : { staleCall: this.lastCall }),
        ...(next.id !== previous.session ? { previousSession: previous.session, formerSessions: sessionsSoFar(previous),
          sessionTokens: undefined, liveSessionTokens: undefined, sessionCredits: undefined } : {}) };
      try {
        // A crash sees either the complete source mapping or the complete successor.
        this.host.store.write(candidate);
      } catch (error) {
        await next.close().catch(() => undefined);
        throw error;
      }
      // The same list as before, the marker added: a turn that waited for this compaction
      // (after a Stop) keeps what it says in it.
      previous.messages.push(marker);
      candidate.messages = previous.messages;
      this.state = candidate;
      // Droid's last call was before it: the meter reads what is left until the next (`forgetCall`).
      this.forgetCall();
      // Also after a Stop that came too late to stop it: the SDK's session is now the
      // compacted one, which the process runs.
      this.use(next);
      if (!this.compactionHeard) this.compactedAt = this.host.now();
      this.sink.emit({ type: "compacted", trigger: "manual", ...(before === undefined ? {} : { tokensBefore: before }) });
      // The meter too: the turn that asked for it reads it as it ends (`run`), unless a Stop ended it first.
      if (turn.ended) void this.refreshContext();
    } finally { this.compacting = false; }
  }

  private answerCommand(turn: Turn, text: string): void {
    if (turn.ended || turn.interrupted) return;
    this.sink.emit({ type: "text", text });
    this.state?.messages.push({ role: "assistant", text, timestamp: Date.now() });
  }

  private async context(turn: Turn, handle: DroidHandle): Promise<void> {
    const breakdown = await handle.getContextBreakdown();
    this.answerCommand(turn, [
      `${breakdown.modelDisplayName} context (estimated)`,
      `${breakdown.usedTokens} / ${breakdown.contextBudget} tokens used, ${breakdown.freeTokens} free.`,
      ...breakdown.categories.map((category) => `${category.name}: ${category.tokens} tokens`),
    ].join("\n"));
  }

  private applySettings(handle: DroidHandle): Promise<void> {
    const applied = this.applyingSettings.then(() => this.updateSettings(handle));
    this.applyingSettings = applied.catch(() => {});
    return applied;
  }

  private async updateSettings(handle: DroidHandle): Promise<void> {
    const state = this.state!;
    const modelId = state.settings.model === "default" ? state.defaultModel : state.settings.model;
    const model = this.host.model(modelId);
    const policy = policyFor(state.mode, state.defaults, state.beforePlan);
    let level = state.settings.reasoningEffort;
    if (!model && modelId === state.defaultModel && level === appEffort(state.defaultEffort)) {
      level = state.defaultEffort;
    }
    const reasoningEffort = level ? sdkEffort(level, model) : undefined;
    // Spec mode plans with the thread's own model and effort, as picked in the model picker
    // (2026-10-22: "if users go into spec mode they can just use the normal model
    // picker"); its own Spec model menu went on 2026-10-23. Set on the session every time,
    // so Droid's global Spec model is never inherited.
    const specReasoningEffort = reasoningEffort ?? sdkEffort(model?.defaultReasoningEffort || state.defaultEffort, model);
    await handle.updateSettings({
      modelId, ...policy,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      specModeModelId: modelId, specModeReasoningEffort: specReasoningEffort,
    });
  }

  startTurn(prompt: Prompt): void {
    if (this.forking) throw new Error("Wait for this Droid thread's fork to finish before sending a message.");
    // A turn of Droid's own opened as this message's was being begun, which the thread did
    // not take (it had this one under way): this one takes it in, as one sent while Droid
    // runs another does, and that one is let go of without a word (an end told now would
    // end this message's turn on every device).
    if (this.turn?.own) this.letGo(this.turn);
    if (this.turn) throw new Error("A Droid turn is already running.");
    this.ends = [];
    this.endIds = [];
    if (this.title === null) {
      // Titled at once by its first line, as other agents' threads are, until Droid names it.
      const title = titleFrom(prompt.text);
      if (title) {
        this.title = this.autoTitle = title;
        this.sink.emit({ type: "title", title });
        this.nameAfter(title, prompt.text);
      }
    }
    const turn = this.newTurn();
    void this.run(turn, prompt);
  }

  private newTurn(own?: Own): Turn {
    const turn: Turn = {
      abort: new AbortController(), interrupted: false, ended: false,
      handoff: new DroidHandoff(this.state?.session ?? ""),
      stream: new DroidStream(this.state?.messages ?? [], (event) => { if (!turn.ended) this.sink.emit(event); },
        this.state?.cwd ?? this.options.cwd, this.state?.liveSessionTokens ?? (this.state?.messages.length === 0 ? 0 : null),
        (droidId, id) => {
          this.work.named(droidId, id);
          if (this.state && id !== droidId) (this.state.nativeToolIds ??= {})[id] = droidId;
        }),
      ...(own ? { own } : {}),
    };
    this.turn = turn;
    this.work.turnBegan();
    return turn;
  }

  // MARK: Turns Droid begins by itself

  /** Droid's receipt for a steering message, and its other queue news (`DroidQueue`): `carry` learns the receipt's message id. */
  private receive(notification: Record<string, unknown>): void {
    const message = notification.type === "create_message" ? notification.message as { id?: unknown } | undefined : undefined;
    this.receiptMessage = typeof message?.id === "string" ? message.id : undefined;
    try { this.queue.notification(notification); } finally { this.receiptMessage = undefined; }
  }

  /**
   * Whether what Droid says now is held for after the app's turn (`early`): Droid ended its
   * turn for the app's message, which is still closing here (its context read), or what it
   * said meanwhile is being told.
   */
  private later(): boolean {
    const turn = this.turn;
    return !!this.replay || (!!turn && !turn.own && !!turn.droidDone && !turn.ending && !turn.ended);
  }

  /**
   * Droid begins turns by itself, which no stream of the SDK's follows: when background
   * work it started (a Task, a command run in the background) ends between turns, it is
   * told, and answers in a turn of its own; and a steering message it takes after the turn
   * it was sent in had ended, it runs as a turn of its own (recent-16, `carry`). That
   * turn's notifications are made into the SDK's events here, as its stream makes them, in
   * a turn the app did not start (`turn.begin`), opened by the first thing Droid says or by
   * the steering message, and ended with Droid's end of it, a Stop, or the process's end.
   * What comes after Droid's turn for the app's message, while the app's turn is still
   * closing here, waits for that turn's end (`early`), a steering message's receipt too:
   * each of Droid's turns is told as one, with its own end.
   */
  private follow(notification: Record<string, unknown>, end?: Ended): void {
    let turn = this.turn;
    if (this.later()) { this.early.push({ notification, ...(end ? { end } : {}) }); return; }
    // A completion of background work: between turns, the next turn of Droid's own answers
    // it; in one, Droid answers it in a turn of its own after, whose end is not that one's.
    const message = notification.type === "create_message" ? notification.message as { id?: unknown } | undefined : undefined;
    const completionId = typeof message?.id === "string" && (end || completionTurn.test(message.id)) ? message.id : undefined;
    if (turn?.own) {
      if (completionId && !turn.own.ids.has(completionId)) turn.own.others.add(completionId);
    } else if (end && (!turn || turn.droidDone)) {
      this.ends.push(end);
      if (completionId) this.endIds.push(completionId);
    }
    if (turn && !turn.own) {
      // The end of a turn Droid ran by itself (a completion's, a late steering message's) is
      // not this one's, nor is one heard before this one's stream runs. A Spec handoff ends
      // the planning session's turn, and the stream goes on in the new one.
      if (notification.type === "agent_turn_completed" && turn.streaming && !this.otherTurn(notification.turnId) && !turn.handoff.expected) turn.droidDone = true;
      return;
    }
    if (!turn) {
      if (!says(notification)) return;
      turn = this.beginOwn();
    }
    const own = turn.own!;
    const completed = notification.type === "agent_turn_completed";
    const idle = notification.type === "droid_working_state_changed" && notification.newState === DroidWorkingState.Idle;
    // The end of another turn of Droid's own (a completion's or a late steering message's
    // it did not answer here) is not this one's, nor is the idle that follows it: this one
    // counts as at work again only once it is heard at work. One that knows of nothing it
    // answers (opened by Droid's words alone) takes as its own any end but a completion's
    // heard while it ran.
    const turnId = typeof notification.turnId === "string" ? notification.turnId : undefined;
    if (completed && turnId !== undefined && !own.ids.has(turnId) && (own.others.has(turnId) || (own.ids.size > 0 && this.otherTurn(turnId)))) {
      own.working = false;
      return;
    }
    // A Spec handoff, approved, ends the planning session's turn, and this one goes on in the
    // new one once it is seen. One that failed (or an end that says so) ends it.
    if (turn.handoff.pending && (idle || (completed && (notification.reason === "completed" || notification.reason === "spec_handoff")))) return;
    // An idle with no end before it (not seen: Droid ends a turn, then goes idle) ends it as finished.
    if (completed || (idle && own.working)) {
      this.endOwn(turn, completed ? notification : { type: "agent_turn_completed", reason: "completed" });
      return;
    }
    const converted = convertNotificationToStreamMessage(notification);
    for (const message of converted === null ? [] : Array.isArray(converted) ? converted : [converted]) {
      const { message: first, additional } = own.tracker.processMessage(message);
      for (const event of [first, ...additional]) {
        // As the SDK's stream leaves them out (its `isInternalMessage`).
        if (!event || event.type === "create_message" || event.type === "tool_use" || event.type === "structured_output") continue;
        // An idle as it took a message is the turn before's.
        if (!(event.type === "working_state_changed" && event.state === DroidWorkingState.Idle)) own.working = true;
        this.take(turn, event as DroidStreamEvent);
      }
    }
  }

  /**
   * Droid began a turn by itself: the app is told what ended that it answers, as for
   * Claude's own turns. One a steering message began (`steer`, its ids) opens with no line
   * of its own when nothing ended: the message, shown already, joins it (`carry`).
   */
  private beginOwn(steer?: readonly string[]): Turn {
    const note = noteFor(this.ends.splice(0));
    const turn = this.newTurn({ tracker: new StreamStateTracker({ sessionId: this.state?.session, startedAt: Date.now() }),
      ids: new Set([...this.endIds.splice(0), ...(steer ?? [])]), others: new Set(), working: false });
    if (this.state) {
      if (!steer || note.kind !== "hidden") this.state.messages.push({ role: "user", text: note.text, timestamp: Date.now(), display_kind: note.kind,
        ...(note.kind === "hidden" ? {} : { display_metadata: { display_text: note.text } }) });
      this.state.open = true;
      this.saveNotified("the start of Droid's own turn");
    }
    this.sink.emit({ type: "turn.begin", user: note.text, host: note });
    this.host.pool.touch(this);
    return turn;
  }

  /**
   * Droid took a steering message (its receipt). One it took after the turn it was sent in
   * had ended at Droid's (recent-16), it runs as a turn of its own: at rest, that turn is
   * opened for it here, with the message as its opener (steered into it, or failed before
   * Droid took it, as the queue shows it). One taken while a message's turn runs at Droid's
   * is steered into it as before, and one taken in a turn of Droid's own joins that one.
   * One taken while the app's turn closes after Droid's end of it comes here once that turn
   * has ended (`later`). Every one's ids are kept: Droid's end of a turn it ran for one is
   * not the end of the bridge's turn, nor of another (`otherTurn`).
   */
  private carry(requestId: string): void {
    const ids = [requestId, ...(this.receiptMessage ? [this.receiptMessage] : [])];
    for (const id of ids) this.lateTurns.add(id);
    while (this.lateTurns.size > 64) this.lateTurns.delete(this.lateTurns.values().next().value!);
    // Taken while what Droid says is held for after the app's turn (a receipt under another
    // session's id, which is not held): the turn told after it ends under its ids too.
    if (this.later()) { this.endIds.push(...ids); return; }
    const turn = this.turn && !this.turn.ended ? this.turn : null;
    if (turn?.own) { for (const id of ids) turn.own.ids.add(id); return; }
    if (turn || this.closed || !this.handle?.connected()) return;
    this.beginOwn(ids);
  }

  /** A turn's end that names a turn not the bridge's: a background command's or Task's completion, or a late steering message's (`carry`). */
  private otherTurn(turnId: unknown): boolean {
    return typeof turnId === "string" && (completionTurn.test(turnId) || this.lateTurns.has(turnId));
  }

  /** One event of the turn's, from the SDK's stream or a turn of Droid's own (`follow`). */
  private take(turn: Turn, event: DroidStreamEvent): void {
    turn.stream.accept(event);
    this.work.accept(event);
    if (event.type === "token_usage_update") {
      // Replacement streams have no session IDs on these SDK events. Raw envelopes do.
      if (this.state && !turn.handoff.target) {
        this.state.liveSessionTokens = tokenTotal(event);
        this.observeUsage(event);
        this.saveSoon();
      }
    }
    if (event.type === "assistant" || event.type === "tool_call" || event.type === "tool_result") this.saveSoon();
  }

  /** Droid's own turn is over (`agent_turn_completed`): its result, made as the SDK's stream makes one. */
  private endOwn(turn: Turn, completed: Record<string, unknown>): void {
    const result = turn.own!.tracker.completeTurn(completed as Parameters<StreamStateTracker["completeTurn"]>[0]);
    turn.stream.accept(result);
    const interrupted = turn.interrupted || result.interrupted;
    const failure = result.success || interrupted ? undefined : result.error?.message ?? "Droid could not complete this turn.";
    const spent = this.spentBy(result);
    this.end(turn, { type: "turn.end", status: interrupted ? "interrupted" : failure ? "error" : "complete",
      ...(failure ? { error: failure } : {}), ...(spent ? { spent } : {}) });
    void this.refreshContext();
  }

  /**
   * A turn of Droid's own, opened while the thread began a message's turn, which the thread
   * did not take: ended here with no word to the thread. What Droid says of it from now on
   * comes in the stream of that message's turn, as for any Droid runs as it is sent one;
   * what it said before is kept.
   */
  private letGo(turn: Turn): void {
    // A plan it handed to a new session, now the thread's: the message's turn opens that one (`warm`).
    if (turn.handoff.target && turn.handoff.target === this.state?.session) this.deferredHandoff = true;
    turn.ended = true;
    turn.abort.abort("Another turn began.");
    turn.stream.finish();
    if (this.turn === turn) this.turn = null;
  }

  /** What Droid said while the app's turn was closing is told first, as a turn of its own: a message sent at rest meanwhile waits for it. */
  catchingUp(): Promise<void> | undefined { return this.replay ?? undefined; }

  private async run(turn: Turn, prompt: Prompt): Promise<void> {
    let failure: string | undefined;
    try {
      // What was asked is kept before anything can fail, so a failure has it before it.
      if (this.state) {
        this.state.messages.push({ role: "user", text: prompt.text, timestamp: Date.now() });
        this.state.open = true;
        this.save();
      }
      // A compaction a Stop left running ends first: until then the SDK takes nothing else.
      await this.compaction;
      await this.permission;
      const handle = await this.warm();
      if (turn.ended || turn.interrupted) return;
      for (;;) {
        const permission = this.permission;
        await permission;
        if (turn.ended || turn.interrupted) return;
        await this.applySettings(handle);
        if (permission === this.permission) break;
      }
      // A Stop while the settings were applied: the prompt is not sent at all.
      if (turn.ended || turn.interrupted) return;
      if (prompt.images.length === 0 && (prompt.files?.length ?? 0) === 0) {
        const command = /^\/(context|compact)(?:\s+([\s\S]*))?$/.exec(prompt.text.trim());
        if (command) {
          if (command[1] === "compact") await this.compactOnce(turn, handle, command[2]?.trim() ?? "");
          else await this.context(turn, handle);
          if (!turn.ended) await this.refreshContext();
          return;
        }
      }
      const images: NonNullable<Parameters<DroidHandle["stream"]>[1]>["images"] = [];
      let skipped = 0;
      for (const image of prompt.images) {
        const type = imageType(image.data);
        if (type) images.push({ type: "base64", mediaType: type, data: image.data.toString("base64") });
        else skipped++;
      }
      if (skipped) this.sink.emit({ type: "notice", level: "warn", text: skippedImagesText(skipped, "Droid") });
      turn.streaming = true;
      try {
        for await (const event of handle.stream(prompt.text, { includePartialMessages: true, images })) {
          if (turn.ended) break;
          this.take(turn, event);
        }
      } finally {
        turn.streaming = false;
        // Droid ended its turn for the message: what it says from now on is not this turn's (`follow`).
        if (turn.stream.result) turn.droidDone = true;
      }
      if (turn.handoff.expected && !turn.ended) {
        if (turn.handoff.failure) throw new Error(turn.handoff.failure);
        if (!turn.handoff.target) {
          this.sink.emit({ type: "notice", level: "warn", text: "Droid did not confirm a replacement conversation. This thread still points to its planning session." });
          throw new Error("The Spec replacement session was not confirmed. The saved planning session was kept.");
        }
        turn.handedOn = true;
        if (this.hasBackgroundWork()) {
          this.deferredHandoff = true;
          this.sink.emit({ type: "notice", level: "info", text: "Background work continues in the new session. Portals can't see when it finishes until you send another message." });
        } else {
          await this.release();
          if (!turn.interrupted && !turn.ended && !this.closed) await this.warm();
        }
      }
      if (!turn.stream.result) failure = "Droid stopped without reporting the end of the turn.";
      else if (!turn.stream.result.success && !turn.stream.result.interrupted) {
        failure = turn.stream.result.error?.message ?? turn.stream.error ?? "Droid could not complete this turn.";
      }
      if (!turn.ended) await this.refreshContext();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      // A setting Droid cannot take says so; the process is fine and stays.
      if (error instanceof SettingRefused) failure = `${failure} Choose another model or reasoning level for this thread.`;
      else if (!(error instanceof DroidBusy) && !turn.ended) await this.release();
    } finally {
      turn.streaming = false;
      const interrupted = turn.interrupted || turn.stream.result?.interrupted === true;
      const spent = this.spentBy(turn.stream.result);
      this.end(turn, { type: "turn.end", status: interrupted ? "interrupted" : failure ? "error" : "complete",
        ...(failure && !interrupted ? { error: failure, retryable: true } : {}), ...(spent ? { spent } : {}) });
    }
  }

  /**
   * SDK results report this turn's usage, unlike live session-cumulative updates.
   */
  private spentBy(result: { durationMs?: number; tokenUsage?: Record<string, unknown> | null } | undefined): { seconds?: number; tokens?: number } | undefined {
    if (!result) return undefined;
    const spent: { seconds?: number; tokens?: number } = {};
    if (typeof result.durationMs === "number" && Number.isFinite(result.durationMs) && result.durationMs >= 0) spent.seconds = result.durationMs / 1000;
    const total = tokenTotal(result.tokenUsage);
    if (total !== undefined) spent.tokens = total;
    return spent.seconds === undefined && spent.tokens === undefined ? undefined : spent;
  }

  private end(turn: Turn, event: Extract<ProviderEvent, { type: "turn.end" }>): void {
    if (turn.ended) return;
    // What comes from now on (Droid's receipt for a steering message taken back below) is
    // not held for after this turn: it is told as it comes (`later`).
    turn.ending = true;
    // What Droid said once its turn for the app's message was over is a turn of its own,
    // told once this one has ended (`follow`): a message sent meanwhile waits for it.
    let caughtUp: (() => void) | undefined;
    if (!turn.own && this.early.length > 0) this.replay = new Promise<void>((done) => { caughtUp = done; });
    if (turn.policyBeforeHandoff && this.state && this.state.session !== turn.handoff.target) {
      // Approval was for a replacement, not permission to implement in an unconfirmed source.
      Object.assign(this.state, turn.policyBeforeHandoff);
      this.sink.emit({ type: "mode", mode: this.state.mode });
    }
    // Droid takes steering messages still queued once its loop is idle: each is taken back
    // from it first, and fails only once Droid no longer has it (`DroidQueue.settle`).
    void this.queue.settle(this.handle ?? undefined);
    turn.abort.abort("The Droid turn ended.");
    if (turn.timer) clearTimeout(turn.timer);
    // A call a Script runs in the background may end after it: its later result goes to its row.
    turn.stream.finish(event.status === "complete" ? (calls) => this.work.leftOpen(calls, this.state?.cwd ?? this.options.cwd) : undefined);
    this.work.turnEnded(event.status === "interrupted");
    turn.ended = true;
    if (this.turn === turn) this.turn = null;
    if (this.state) {
      this.state.open = false;
      // A stop is marked as every agent's is (sessions/transcript.ts): an interrupted reply,
      // which the app reads back as stopped. A failed turn's line it reads first, as a
      // failure with Try again, which a stop read back as before.
      if (event.status === "interrupted") this.state.messages.push({ role: "assistant", text: "", timestamp: Date.now(), display_metadata: { interrupted: true } });
      else if (event.status === "error") this.state.messages.push({ role: "assistant", text: event.error ?? "Droid could not complete this turn.", timestamp: Date.now(), display_kind: "failed_turn" });
      // Kept with the turn's last message (its user's at least, stored as it began), so a
      // restart of the bridge still shows it.
      const last = this.state.messages.at(-1);
      if (event.spent && last) last.turn_usage = { ...event.spent };
    }
    try { this.save(); } catch (error) {
      event = { type: "turn.end", status: "error", error: `Could not save Droid's display history: ${error instanceof Error ? error.message : String(error)}` };
    }
    // Droid handed a plan to a new session that this turn did not take up (one of its own, or
    // one whose plan was handed on as it closed): the next turn opens that session, once
    // background work from the plan is over (`checkHandoff`, `warm`).
    if (turn.handoff.target && turn.handoff.target === this.state?.session && !turn.handedOn) this.deferredHandoff = true;
    this.host.pool.touch(this);
    this.sink.emit(event);
    if (caughtUp) {
      const early = this.early.splice(0);
      this.replay = null;
      // As each came: a steering message's receipt first to the queue (`carry`), then the
      // turn. With the process gone, the queue still learns that Droid took a message, which
      // is then kept as taken (`DroidQueue.settled`), so Try again does not send it twice.
      const following = this.handle?.connected() && !this.closed;
      this.telling = true;
      try {
        for (const { notification, end } of early) {
          this.receive(notification);
          if (following) this.follow(notification, end);
        }
      } finally { this.telling = false; }
      caughtUp();
    }
    // After what was held is told: the planning session's process carries it.
    this.checkHandoff();
  }

  async interrupt(): Promise<boolean> {
    const turn = this.turn;
    if (!turn) return false;
    turn.interrupted = true;
    // What Droid has not settled yet is left for the turn's end (`DroidWork.turnEnded`).
    this.work.turnEnded(true, true);
    turn.abort.abort("Stopped from Portals.");
    turn.timer ??= setTimeout(() => {
      if (turn.ended) return;
      void this.release();
      this.end(turn, { type: "turn.end", status: "interrupted" });
    }, this.host.interruptGraceMs);
    turn.timer.unref();
    if (this.opening) this.lifetime?.abort("Stopped from Portals.");
    if (this.compacting && this.handle) {
      // The SDK refuses to interrupt a session it is compacting, and the process that does it
      // is the thread's: Droid is asked to stop compacting, and the turn ends now. A
      // compaction that finishes all the same is taken (`compact`).
      void this.handle.interruptAny().catch(() => undefined);
      this.end(turn, { type: "turn.end", status: "interrupted" });
      return true;
    }
    if (this.handle) void this.handle.interrupt().catch(() => {
      if (turn.ended) return;
      void this.release();
      this.end(turn, { type: "turn.end", status: "interrupted" });
    });
    return true;
  }

  /** Stops one command Droid runs in the background (`DroidBackground`), as its footer's Stop does; the turn, if any, goes on. */
  async stopSubagent(id: string): Promise<boolean> {
    const target = this.background.target(id);
    const handle = this.handle;
    if (!target || !handle?.killBackgroundProcess || !handle.connected()) return false;
    const killed = await handle.killBackgroundProcess(target);
    if (killed && this.handle === handle) this.background.stopping(id);
    return killed;
  }

  async enqueue(prompt: Prompt, requestId: string): Promise<boolean> {
    if (!this.turn?.streaming || this.turn.ended || this.turn.interrupted || !this.handle?.connected()) return false;
    const turn = this.turn, handle = this.handle;
    try {
      for (;;) {
        const permission = this.permission, applying = this.applyingSettings;
        await permission;
        await applying;
        if (permission === this.permission && applying === this.applyingSettings) break;
      }
    } catch (error) {
      this.sink.emit({ type: "queue.failed", requestId, error: error instanceof Error ? error.message : String(error) });
      return true;
    }
    if (this.turn !== turn || !turn.streaming || turn.ended || turn.interrupted || this.handle !== handle || !handle.connected()) return false;
    const state = this.state!;
    const policy = policyFor(state.mode, state.defaults, state.beforePlan);
    // A busy turn defers mode changes. Keep the message on the bridge's queue until
    // a new turn can apply that policy, rather than letting the old native loop take it.
    if (policy.autonomyLevel !== handle.settings.autonomyLevel || policy.interactionMode !== handle.settings.interactionMode) return false;
    return this.queue.add(handle, prompt, requestId);
  }

  async deleteQueued(requestId: string): Promise<boolean> {
    if (!this.handle?.connected()) return false;
    return this.queue.delete(this.handle, requestId);
  }

  queuedConsumed(requestId: string): boolean { return this.state?.queueReceipts?.includes(requestId) === true; }

  async setModel(model: string, provider: string): Promise<ModelChangeResult> {
    if (provider && provider !== "droid") throw new SettingRefused("Choose a model from Droid's catalog.");
    const info = this.host.model(model);
    if (model !== "default" && !info) throw new SettingRefused(`Droid does not offer model "${model}".`);
    const state = this.state!;
    const old = { ...state.settings };
    state.settings.model = model;
    state.settings.reasoningEffort = model === "default" ? appEffort(state.defaultEffort) : appEffort(info!.defaultReasoningEffort);
    try {
      if (!this.busy && this.handle) await this.applySettings(this.handle);
      this.save();
    } catch (error) { state.settings = old; throw error; }
    return { deferred: this.busy };
  }

  async setReasoning(level: string): Promise<void> {
    const state = this.state!;
    sdkEffort(level, this.host.model(state.settings.model === "default" ? state.defaultModel : state.settings.model));
    const old = { ...state.settings };
    state.settings.reasoningEffort = level;
    try {
      if (!this.busy && this.handle) await this.applySettings(this.handle);
      this.save();
    } catch (error) { state.settings = old; throw error; }
  }

  async setMode(mode: ThreadMode): Promise<void> {
    const changed = this.permission.catch(() => {}).then(async () => {
      const state = this.state!;
      const old = { mode: state.mode, beforePlan: state.beforePlan };
      if (mode === "plan" && state.mode !== "plan") state.beforePlan = state.mode;
      state.mode = mode;
      try {
        if (!this.busy && this.handle) await this.applySettings(this.handle);
        this.save();
      } catch (error) { Object.assign(state, old); throw error; }
    });
    this.permission = changed;
    await changed;
  }

  async rename(title: string): Promise<void> {
    const before = { title: this.title, autoTitle: this.autoTitle };
    // At once, so that a name Droid makes meanwhile does not replace it.
    this.title = title;
    this.autoTitle = null;
    this.naming = null;
    try {
      await (await this.warm()).rename({ title });
    } catch (error) {
      if (this.title === title) Object.assign(this, before);
      throw error;
    }
  }

  /**
   * Droid named its session (`session_title_updated`, during a turn or, as it mostly
   * does, a moment after it): the thread takes the name unless the user named it. The
   * name Droid gives at once from the first message is passed over for the bridge's own
   * first line, which leaves out who sent a message and the files it lists. A rename made
   * in Droid itself is the user's.
   */
  private droidNamed(title: string, kind: unknown): void {
    if (title === "" || title === this.title) return;
    if (kind === "manual_rename") {
      this.autoTitle = null;
      this.naming = null;
    } else {
      if (this.title !== null && this.title !== this.autoTitle) return;
      if (kind === "first_user_message" && this.title !== null) return;
      // The bridge's own name is on its way, and wins: Droid's is kept for when none comes.
      if (this.naming) { this.naming.droids = title; return; }
      this.autoTitle = title;
    }
    this.title = title;
    this.sink.emit({ type: "title", title });
  }

  /**
   * Names the thread, titled `first` from its first message `text`, with a short name made
   * as Codex threads are named (`DroidHost.name`), once it comes; Droid's own name stands
   * in when none does. A thread renamed meanwhile (in the app, or in Droid) keeps its name,
   * as does one closed. The name goes to Droid's session too while its process runs.
   */
  private nameAfter(first: string, text: string): void {
    const settings = this.state?.settings;
    if (!settings) return;
    const naming = { droids: null as string | null };
    this.naming = naming;
    void this.host.name(text, settings.model === "default" ? this.state!.defaultModel : settings.model)
      .catch(() => null)
      .then((made) => {
        if (this.naming !== naming) return;
        this.naming = null;
        const name = made ?? naming.droids;
        if (!name || this.closed || this.title !== first || this.autoTitle !== first) return;
        // Droid's own, which may still come, does not replace the bridge's: also when the
        // bridge's is the first line itself ("Fix login"), which then stays.
        this.autoTitle = made ? null : name;
        if (name === first) return;
        this.title = name;
        this.sink.emit({ type: "title", title: name });
        if (made && this.handle?.connected()) {
          void this.handle.rename({ title: name }).catch((error: Error) => log.debug("could not pass a Droid thread's name to Droid", { error: error.message }));
        }
      });
  }

  renamed(title: string): void { this.sink.emit({ type: "title", title }); }
  get cwd(): string { return this.state?.cwd ?? this.options.cwd; }
  async listCommandsIfWarm(): Promise<Awaited<ReturnType<DroidHandle["listCommands"]>> | null> {
    return this.handle?.connected() ? this.handle.listCommands() : null;
  }

  private observeUsage(usage: unknown): void {
    if (!this.state || !usage || typeof usage !== "object") return;
    const total = tokenTotal(usage);
    // Raw cumulative cost can include children that SDK parent-only updates omit.
    if (total !== undefined) this.state.sessionTokens = Math.max(this.state.sessionTokens ?? 0, total);
    const credits = (usage as Record<string, unknown>).factoryCredits;
    if (typeof credits === "number" && Number.isFinite(credits) && credits >= 0) this.state.sessionCredits = credits;
  }

  cost(): string {
    return ["Droid session usage (last observed)",
      `Tokens: ${this.state?.sessionTokens ?? "unknown"}`,
      `Factory credits: ${this.state?.sessionCredits ?? "unknown"}`,
      "This is session spend, not account balance or subscription limits."].join("\n");
  }

  async controlsCommand(kind: "skills" | "mcp", argument: string): Promise<string> {
    if (this.busy) throw new Error("Wait for this Droid thread's work to finish before changing or listing its skills and MCP settings.");
    this.controlling = true;
    try { return await this.controls.run(kind, argument, await this.warm(), this.host.now()); }
    catch (error) {
      // SDK errors may contain an OAuth URL, state or code. Only our own validation
      // errors may reach command transcripts and Connection.describe's logs.
      if (error instanceof SettingRefused) throw error;
      throw new Error("Droid could not read or change its skills and MCP settings. Check it in Droid itself.");
    }
    finally { this.controlling = false; }
  }

  async mcpAuth(action: McpAuthAction): Promise<{ servers: McpAuthCard[] }> {
    if (action.action === "list" && !this.handle?.connected()) return this.auth.list();
    this.authOperations++;
    try { return await this.auth.run(action, await this.warm()); }
    finally { this.authOperations--; }
  }

  private release(trackingEnded?: string): Promise<void> {
    this.auth.close();
    this.deferredHandoff = false;
    if (this.handoffTimer) clearTimeout(this.handoffTimer);
    this.handoffTimer = undefined;
    const handle = this.handle;
    const lifetime = this.lifetime;
    this.handle = null;
    this.unlisten?.(); this.unlisten = null;
    this.lifetime = null;
    this.autonomousWorking = this.droidAtWork = false;
    this.work.stopped(trackingEnded);
    this.background.close();
    this.host.pool.cooled(this);
    this.ending = this.ending.then(async () => {
      await handle?.close().catch((error: Error) => log.warn("could not close Droid", { error: error.message }));
      lifetime?.abort("Droid process closed.");
    });
    return this.ending;
  }

  async cool(): Promise<void> { if (!this.busy) await this.release(); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.opening) this.lifetime?.abort("Session closed.");
    if (this.turn) this.end(this.turn, { type: "turn.end", status: "interrupted" });
    await this.opening?.catch(() => undefined);
    await this.release();
    this.host.forget(this);
  }
}
