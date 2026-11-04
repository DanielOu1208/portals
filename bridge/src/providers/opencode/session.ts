import { log } from "../../log.ts";
import { LiveOutput } from "../liveOutput.ts";
import { notSignedIn } from "../signIn.ts";
import type {
  ApprovalOption,
  ContextUsage,
  ModelChangeResult,
  ModeState,
  Prompt,
  ProviderEvent,
  ProviderSession,
  RequestAnswer,
  SessionOptions,
  SessionSettings,
  SessionSink,
  StoredMessage,
  ThreadMode,
} from "../types.ts";
import type { OpenCodeApi } from "./client.ts";
import { storedMessages } from "./history.ts";
import { OpenCodeForms } from "./forms.ts";
import { OpenCodeInbox } from "./inbox.ts";
import { OpenCodeAgents, type AgentSettings } from "./agents.ts";
import { submit } from "./commands.ts";
import { imageFiles } from "./images.ts";
import { OpenCodeSubagents } from "./subagents.ts";
import { OpenCodeTurn, isTurnEvent } from "./turn.ts";
import { modelKey, nativeModelID } from "./models.ts";
import type { FormInfo, SessionInboxInfo } from "@opencode/client";
import type { Json, Message, ModelRef, OpenCodeEvent, PermissionDecision, PermissionRequest, SessionInfo, StructuredError, TokenUsage, ToolContent } from "./protocol.ts";
import { textPiece, tokenTotal } from "./protocol.ts";
import { approvalCommand, approvalDescription, gatewayResult, gatewayTool, type ToolOutcome } from "./tools.ts";
import { ownedStopReason, ownedStopWarning, type StopNote } from "./stopNotes.ts";
import type { OwnedStopResult } from "./server.ts";

// One OpenCode session as a thread of the bridge. The thread's id is OpenCode's session
// id. A turn is OpenCode's execution: it starts with `session.execution.started` and
// ends with exactly one of `succeeded`, `failed` or `interrupted`, whoever sent the
// message (the phone, or OpenCode's terminal on the same background service).
//
// The event stream keeps nothing for a client that was away, so after it drops the
// session catches up from what OpenCode keeps: the messages of the turn (text and tools
// told only where they were not), whether it still runs, and the permission requests
// still waiting (`resync`).

/** What a session needs of the provider. */
export interface SessionHost {
  api(): Promise<OpenCodeApi>;
  /** Routes the session's events to it from now on. */
  bind(session: OpenCodeSession): void;
  forget(session: OpenCodeSession): void;
  /** The model's context window, when OpenCode listed it. */
  contextOf(model: string, provider: string): number | undefined;
  /** The thinking levels the model takes, as OpenCode lists its variants. */
  levelsOf(model: string, provider: string): string[] | undefined;
  prepareChild?(id: string, thread: string): Promise<void>;
  unknown?(kind: string): void;
}

/** A session as OpenCode had it when it was loaded. */
export interface Loaded {
  info: SessionInfo;
  messages: Message[];
  /** OpenCode was running a turn in it. */
  running: boolean;
  inbox?: SessionInboxInfo[];
  agents?: AgentSettings;
  children?: SessionInfo[];
  active?: ReadonlySet<string>;
  recover?: boolean;
  /** A bridge-only annotation, never included in a native admission. */
  stopNote?: StopNote;
}

interface ToolCall {
  name: string;
  input: Json;
  started: boolean;
  ended: boolean;
}

interface ShellOutput {
  shell: string;
  cursor: number;
  dropped: boolean;
  timer?: NodeJS.Timeout;
}

/** Native metadata and inputs deliberately left to OpenCode. */
const ignoredEvents = new Set([
  "session.created", "session.viewed", "session.archived", "session.unarchived", "session.forked",
  "session.deleted", "session.moved", "session.metadata.updated", "session.permissions",
  "session.inbox.delivery.changed", "session.instructions.updated", "session.synthetic", "session.skill.activated",
  "session.step.started", "session.step.streamed", "session.tool.input.delta", "session.tool.input.ended",
  "session.usage.updated", "session.usage.recorded", "session.message.content.updated",
  "session.shell.started", "session.shell.ended", "session.compaction.delta",
  "session.revert.staged", "session.revert.cleared", "session.revert.committed", "session.status.updated", "session.idle",
]);

/** OpenCode's name for a model's default thinking level. */
const defaultVariant = "default";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

/** The settings a session's own model says, over those given. */
export function settingsOf(given: SessionSettings, model: ModelRef | undefined): SessionSettings {
  if (!model?.id) return { ...given, model: modelKey(nativeModelID(given.model, given.provider), given.provider) };
  return { model: modelKey(model.id, model.providerID), provider: model.providerID, reasoningEffort: model.variant && model.variant !== defaultVariant ? model.variant : "" };
}

export class OpenCodeSession implements ProviderSession {
  readonly id: string;
  private readonly cwd: string;
  private readonly sink: SessionSink;
  private readonly host: SessionHost;
  private current: SessionSettings;
  private stored: StoredMessage[];
  /** What a turn running when the session was loaded had said, told once the bridge's side is wired up. */
  private runningTail: Message[] = [];
  private runningUser: string | null = null;
  private isAttached = false;
  private readonly turn: OpenCodeTurn;
  private readonly knownTurns = new Set<string>();
  private get turnOpen(): boolean { return this.turn.open; }
  private get turnMessage(): string | null { return this.turn.message; }
  private set turnMessage(id: string | null) { this.turn.message = id; }
  private get closed(): boolean { return this.turn.closed; }
  /** What has been told of each piece of text and reasoning, by `<message>:<kind>:<ordinal>`. */
  private readonly told = new Map<string, string>();
  private readonly calls = new Map<string, ToolCall>();
  private readonly pending = new Map<string, AbortController>();
  /** The user's messages OpenCode has not begun on yet, by inbox id, oldest first. */
  private readonly inbox = new Map<string, string>();
  private lastTokens: TokenUsage | null = null;
  /** One count per native step, replaced by catch-up rather than added twice. */
  private readonly stepTokens = new Map<string, number>();
  private readonly liveOutput: LiveOutput;
  private readonly shells = new Map<string, ShellOutput>();
  private stepError: StructuredError | null = null;
  /** Compactions already told in this turn, so a REST catch-up does not repeat one. */
  private compactions = 0;
  private readonly forms: OpenCodeForms;
  private readonly queue: OpenCodeInbox;
  private readonly agents: OpenCodeAgents;
  private readonly subagents: OpenCodeSubagents;
  private readonly readOnly: boolean;
  private readonly permissionSessions = new Map<string, string>();
  private readonly permissionEpochs = new Map<string, number>();
  private readonly heldChildren: OpenCodeEvent[] = [];
  /** A later read can fail after metadata was applied; retry it without repeating effects. */
  private readonly appliedFrames = new WeakSet<OpenCodeEvent>();
  private readonly recoverOnAttach: boolean;
  private deleted = false;

  constructor(options: SessionOptions, sink: SessionSink, host: SessionHost, loaded: Loaded) {
    this.id = options.id;
    this.turn = new OpenCodeTurn(this.id);
    this.recoverOnAttach = loaded.recover === true;
    this.cwd = loaded.info.location?.directory ?? options.cwd;
    this.sink = sink;
    this.host = host;
    this.liveOutput = new LiveOutput((event) => this.report(event.type === "tool.progress" && this.shells.get(event.id)?.dropped ? { ...event, outputTruncated: true } : event));
    this.readOnly = options.readOnly === true;
    this.forms = new OpenCodeForms(this.id, () => host.api(), sink);
    this.queue = new OpenCodeInbox(this.id, () => host.api(), sink, loaded.messages, loaded.inbox ?? []);
    this.agents = new OpenCodeAgents(loaded.agents ?? { agents: [], defaultAgent: "" }, loaded.info.agent, async (agent) => (await host.api()).switchAgent(this.id, agent));
    this.subagents = new OpenCodeSubagents(this.id, () => host.api(), sink, (request) => { void this.ask(request); }, loaded.messages, loaded.children ?? [], loaded.active ?? new Set(), this.readOnly ? undefined : (id) => host.prepareChild?.(id, this.id) ?? Promise.resolve());
    this.current = settingsOf(options.settings, loaded.info.model);
    const messages = loaded.messages;
    const groups = historyTurns(messages);
    const lastGroup = groups.at(-1);
    // A durable opener with no outcome is unresolved, not a successful old turn.
    // Keep it open until attach's barrier decides whether it is running, queued or lost.
    const unresolved = !this.readOnly && loaded.recover === true && !!lastGroup && !lastGroup.idle;
    const running = loaded.running || unresolved;
    for (const group of groups) if (group.idle || !running) this.knownTurns.add(group.id);
    const last = Math.max(lastUserIndex(messages), lastGroup ? messages.findIndex((message) => message.id === lastGroup.id) : -1);
    if (running && last >= 0) {
      // The history ends with the message that opened the running turn; the rest of it is told as it would have come.
      this.stored = storedMessages(messages.slice(0, last + 1), this.cwd);
      this.runningTail = messages.slice(last + 1);
      this.runningUser = str((messages[last] as { text?: unknown }).text);
      this.openTurn();
      this.turnMessage = lastGroup?.id ?? messages[last].id;
      // Steering may place earlier pieces of this same execution in stored history.
      // A later whole snapshot must append only their unseen suffix.
      for (const message of messages.slice(0, last)) {
        if (message.type !== "assistant") continue;
        const assistant = message as Extract<Message, { type: "assistant" }>;
        let texts = 0, thoughts = 0;
        if (assistant.tokens && lastGroup?.messages.some((item) => item.id === assistant.id)) {
          const total = tokenTotal(assistant.tokens);
          if (total !== undefined) this.stepTokens.set(assistant.id, total);
        }
        for (const part of assistant.content) {
          if (part.type === "text" || part.type === "reasoning") this.told.set(`${message.id}:${part.type}:${part.type === "text" ? texts++ : thoughts++}`, part.text);
          else if (part.type === "tool" && part.state.status !== "streaming") this.calls.set(part.id, { name: part.name, input: record(part.state.input) ?? {}, started: true, ended: part.state.status !== "running" });
        }
      }
    } else {
      this.stored = storedMessages(messages, this.cwd);
    }
    const stopNote = loaded.stopNote;
    if (stopNote) {
      const anchor = messages.findIndex((message) => message.id === stopNote.afterMessageID);
      const after = anchor < 0 ? this.stored.length : Math.min(this.stored.length, storedMessages(messages.slice(0, anchor + 1), this.cwd).length);
      this.stored.splice(after, 0, { role: "assistant", text: stopNote.text, timestamp: stopNote.timestamp });
    }
    if (!this.readOnly) host.bind(this);
  }

  // MARK: ProviderSession

  async history(): Promise<StoredMessage[]> {
    return structuredClone(this.stored);
  }

  attached(): { user: string } | null {
    if (this.readOnly) return null;
    this.isAttached = true;
    this.turn.attach();
    const running = this.turnOpen && this.runningUser !== null ? { user: this.runningUser } : null;
    queueMicrotask(() => {
      if (this.closed) return;
      this.catchUp(this.runningTail);
      this.subagents.attached();
      this.runningTail = [];
      for (const event of this.heldChildren.splice(0)) this.childEvent(event);
    });
    if (this.recoverOnAttach || this.turn.hasHeld) this.reconnected();
    else void this.host.api().then(async (api) => {
      await this.settlePermissions(api);
      await this.forms.reconcile();
    }).catch((error: Error) => log.debug("could not reconcile OpenCode's waiting requests", { error: error.message }));
    return running;
  }

  settings(): SessionSettings {
    return { ...this.current };
  }

  pastSubagents(): ReturnType<OpenCodeSubagents["history"]> {
    return this.subagents.history();
  }

  stopSubagent(id: string): Promise<boolean> {
    return this.subagents.stop(id);
  }

  hasBackgroundWork(): boolean {
    return !this.readOnly && this.subagents.hasRunning();
  }

  async stopping(): Promise<boolean> {
    if (this.deleted) return false;
    if (this.turn.stoppingAdmission) return true;
    const active = await (await this.host.api()).active();
    return active.has(this.id) || [...active].some((id) => this.subagents.owns(id));
  }

  async reload(): Promise<StoredMessage[]> {
    return storedMessages(await (await this.host.api()).messages(this.id), this.cwd);
  }

  startTurn(prompt: Prompt): void {
    if (this.deleted) {
      this.report({ type: "turn.end", status: "error", error: "This session was deleted in OpenCode. Start a new thread.", retryable: false });
      return;
    }
    if (this.turn.stoppingAdmission) {
      this.report({ type: "turn.end", status: "error", error: "OpenCode is still withdrawing the previous message. Try again in a moment.", retryable: true });
      return;
    }
    this.openTurn();
    void this.turn.admit(
      () => this.host.api(),
      (api, id, current) => submit(api, this.id, this.cwd, prompt, imageFiles(prompt), { id, current }),
      (error) => {
        this.endTurn({ type: "turn.end", status: "error", error: `OpenCode did not take the message: ${(error as Error).message}`, retryable: true });
      },
      () => this.reconnected(),
      () => this.endTurn({ type: "turn.end", status: "interrupted" }),
      async (error, api, attempt) => {
        try { if (await this.confirmDeleted(api, error)) return; } catch { /* Keep Stop pending while native state is unavailable. */ }
        if (attempt === 3) this.report({ type: "notice", level: "warn", text: "OpenCode has not confirmed Stop yet. Portals will keep trying before ending this turn." });
      },
    );
  }

  async steer(prompt: Prompt): Promise<boolean> {
    if (!this.turnOpen) return false;
    await (await this.host.api()).prompt(this.id, prompt.text, imageFiles(prompt), { delivery: "steer" });
    return true;
  }

  async enqueue(prompt: Prompt, requestId: string): Promise<boolean> {
    if (!this.turnOpen) return false;
    return this.queue.add(prompt, requestId, imageFiles(prompt));
  }

  deleteQueued(requestId: string): Promise<boolean> {
    return this.queue.delete(requestId);
  }

  queuedConsumed(requestId: string): boolean {
    return this.queue.queuedConsumed(requestId);
  }

  catchingUp(): Promise<void> | undefined {
    return this.turn.catchingUp;
  }

  mode(): ModeState {
    return this.agents.mode();
  }

  async setMode(mode: ThreadMode): Promise<void> {
    await this.agents.setMode(mode);
    this.report({ type: "mode", mode: this.agents.mode().mode });
  }

  async selectAgent(argument: string): Promise<string> {
    const result = await this.agents.command(argument);
    if (argument.trim()) this.report({ type: "mode", mode: this.agents.mode().mode });
    return result;
  }

  async rename(title: string): Promise<void> {
    await (await this.host.api()).rename(this.id, title);
  }

  async interrupt(): Promise<boolean> {
    if (this.deleted) return true;
    if (!this.turnOpen) return false;
    this.turn.stop();
    const api = await this.host.api();
    // OpenCode ends the turn itself (`session.execution.interrupted`).
    try {
      const interrupted = await api.interrupt(this.id);
      if (interrupted || this.turn.admitting) return true;
    } catch (error) {
      if (await this.confirmDeleted(api, error)) return true;
      throw error;
    }
    // Nothing ran: the message waits in OpenCode's inbox still, or the turn's end was missed.
    if (this.turnMessage && !this.turn.admitting) await api.cancelInbox(this.id, this.turnMessage).catch(() => undefined);
    this.endTurn({ type: "turn.end", status: "interrupted" });
    return true;
  }

  async setModel(model: string, provider: string): Promise<ModelChangeResult> {
    const levels = this.host.levelsOf(model, provider);
    const level = this.current.reasoningEffort && levels?.includes(this.current.reasoningEffort) ? this.current.reasoningEffort : "";
    const id = nativeModelID(model, provider);
    await (await this.host.api()).switchModel(this.id, { id, providerID: provider, variant: level || defaultVariant });
    this.current = { model: modelKey(id, provider), provider, reasoningEffort: level };
    return { deferred: this.turnOpen };
  }

  async setReasoning(level: string): Promise<void> {
    const levels = this.host.levelsOf(this.current.model, this.current.provider);
    if (level && levels && !levels.includes(level)) throw new Error(`This OpenCode model does not take the ${level} thinking level. Choose Default${levels.length ? ` or ${levels.join(", ")}` : ""}.`);
    await (await this.host.api()).switchModel(this.id, { id: nativeModelID(this.current.model, this.current.provider), providerID: this.current.provider, variant: level || defaultVariant });
    this.current.reasoningEffort = level;
  }

  async close(): Promise<void> {
    this.clearShells();
    this.turn.close();
    this.forms.close();
    this.queue.close();
    this.subagents.close();
    // The session lives on in OpenCode; only the bridge's side goes, its questions with it.
    for (const controller of this.pending.values()) controller.abort("withdrawn");
    this.pending.clear();
    this.host.forget(this);
  }

  /** Retained through view close so the generic sink can settle its durable turn record. */
  serverStopped(result: OwnedStopResult): boolean {
    if (this.deleted || !this.isAttached) return false;
    const owns = (id: string) => id === this.id || this.subagents.owns(id);
    const settled = result.settled.some(owns);
    const outcomes = new Map(result.executions?.map((execution) => [execution.sessionID, execution.outcome]));
    const stopped = result.settled.filter((id) => owns(id) && outcomes.get(id) !== "succeeded" && outcomes.get(id) !== "failed");
    const uncertain = !result.complete || result.unsettled.some(owns);
    if (!settled && !uncertain) return false;
    if (result.settled.includes(this.id) && this.turnOpen) {
      this.turn.stop();
      const outcome = outcomes.get(this.id);
      if (outcome === "succeeded") this.endTurn({ type: "turn.end", status: "complete" }, true);
      else if (outcome === "failed") this.endTurn({ type: "turn.end", status: "error", error: sessionError(undefined), retryable: true }, true);
      else this.endTurn({ type: "turn.end", status: "interrupted", error: `This turn ${ownedStopReason}.` }, true);
    }
    if (this.closed) return false; // The ledger supplies the note at the next resume.
    if (!stopped.length && !uncertain) return true;
    const subject = stopped.includes(this.id) ? "This turn" : "OpenCode subagent work";
    this.report({ type: "notice", level: uncertain ? "warn" : "info", text: uncertain ? ownedStopWarning : `${subject} ${ownedStopReason}.` });
    return true;
  }

  // MARK: Turns

  private openTurn(): void {
    this.turn.begin();
    this.told.clear();
    this.calls.clear();
    this.lastTokens = null;
    this.stepTokens.clear();
    this.clearShells();
    this.stepError = null;
    this.compactions = 0;
  }

  private endTurn(event: Extract<ProviderEvent, { type: "turn.end" }>, settled = false): void {
    if (!this.turnOpen || !settled && !this.deleted && (this.turn.stoppingAdmission || this.turn.admittingCommand)) return;
    // A tool the turn's end left running has no end of its own coming.
    for (const [id, call] of this.calls) {
      if (call.started && !call.ended) this.endTool(id, { ok: "stopped" });
    }
    if (this.turnMessage) this.knownTurns.add(this.turnMessage);
    this.turn.end();
    this.forms.withdraw();
    this.permissionEpochs.set(this.id, (this.permissionEpochs.get(this.id) ?? 0) + 1);
    for (const [id, controller] of this.pending) {
      if (this.permissionSessions.get(id) !== this.id) continue;
      controller.abort("resolved");
      this.pending.delete(id);
      this.permissionSessions.delete(id);
    }
    const usage = this.usage();
    const tokens = [...this.stepTokens.values()].reduce((sum, count) => sum + count, 0);
    this.report({ ...event, ...(usage ? { usage } : {}), ...(tokens > 0 ? { spent: { tokens } } : {}) });
  }

  /** How full the model's context is after the turn's last step, where OpenCode said both. */
  private usage(): ContextUsage | null {
    const tokens = this.lastTokens;
    const max = this.host.contextOf(this.current.model, this.current.provider);
    if (!tokens || !max) return null;
    const used = tokenTotal(tokens);
    return used !== undefined && used > 0 ? { used, max } : null;
  }

  // MARK: From OpenCode

  /** An event for this session. */
  event(event: OpenCodeEvent): void {
    if (this.deleted) return;
    // Deletion often follows execution.interrupted, which already ended the
    // turn. Still confirm it independently and leave an explanation in history.
    if (event.type === "session.deleted") this.recover(true);
    this.turn.receive(event, (frame) => this.handle(frame), (boundary) => this.recover(boundary));
  }

  childEvent(event: OpenCodeEvent): void {
    if (this.closed || this.readOnly) return;
    if (!this.isAttached) { this.heldChildren.push(event); return; }
    this.subagents.event(event);
    const id = str(event.data.sessionID);
    if (!this.subagents.owns(id)) return;
    if (event.type === "permission.replied") this.handle(event);
    if (["session.execution.succeeded", "session.execution.interrupted", "session.execution.failed"].includes(event.type)) {
      this.permissionEpochs.set(id, (this.permissionEpochs.get(id) ?? 0) + 1);
      for (const [request, controller] of this.pending) {
        if (this.permissionSessions.get(request) !== id) continue;
        this.pending.delete(request);
        this.permissionSessions.delete(request);
        controller.abort("ended");
      }
    }
  }

  private handle(event: OpenCodeEvent): void {
    const data = event.data;
    const piece = textPiece(event);
    if (piece) {
      if (this.turnOpen && piece.phase === "delta") this.piece(piece.kind, piece.key, piece.text);
      else if (this.turnOpen && piece.phase === "ended") {
        this.whole(piece.kind, piece.key, piece.text);
        this.turn.endedPiece(piece.key);
      }
      return;
    }
    switch (event.type) {
      case "session.inbox.enqueued": {
        const item = record(data.item);
        const said = record(item?.payload)?.text;
        if (item?.type === "user" && typeof said === "string" && typeof data.inboxID === "string") this.inbox.set(data.inboxID, said);
        return;
      }
      case "session.inbox.delivered":
      case "session.inbox.cancelled": {
        const id = str(data.inboxID);
        if (event.type === "session.inbox.delivered" && this.turnOpen && this.turnMessage === null && id) this.turnMessage = id;
        if (event.type === "session.inbox.delivered") this.queue.delivered(id);
        else this.queue.cancelled(id);
        this.inbox.delete(id);
        return;
      }
      case "session.execution.started":
        this.stepError = null;
        if (!this.turnOpen) {
          // A turn the bridge did not start: one sent from OpenCode's terminal on the same service.
          const [first] = this.inbox;
          this.openTurn();
          this.turnMessage = first?.[0] ?? null;
          const owned = first && this.queue.owns(first[0]);
          this.report({ type: "turn.begin", user: owned ? "" : first?.[1] ?? "", ...(owned ? { host: { kind: "hidden", text: "" } as const } : {}) });
        }
        return;
      case "session.tool.input.started": {
        const id = str(data.id);
        if (this.turnOpen && id && !this.calls.has(id)) this.calls.set(id, { name: str(data.name) || "tool", input: {}, started: false, ended: false });
        return;
      }
      case "session.tool.called": {
        const id = str(data.id);
        if (!this.turnOpen || !id) return;
        const call = this.calls.get(id) ?? { name: "tool", input: {}, started: false, ended: false };
        call.input = record(data.input) ?? {};
        this.calls.set(id, call);
        this.startTool(id, call);
        return;
      }
      case "session.tool.success":
        if (this.turnOpen) this.endTool(str(data.id), { ok: true, content: (data.content as ToolContent[]) ?? [], metadata: record(data.metadata) });
        return;
      case "session.tool.progress": {
        const id = str(data.id);
        const call = this.calls.get(id);
        if (call) {
          const metadata = record(data.metadata);
          this.subagents.tool(id, call.name, call.input, metadata);
          this.followShell(id, call, metadata);
        }
        return;
      }
      case "session.tool.failed":
        if (this.turnOpen) {
          const error = (record(data.error) as StructuredError | undefined) ?? { type: "unknown", message: "" };
          this.endTool(str(data.id), { ok: false, error, content: data.content as ToolContent[] | undefined, metadata: record(data.metadata) });
        }
        return;
      case "permission.asked":
        void this.ask(data as unknown as PermissionRequest);
        return;
      case "form.created":
        if (record(data.form)) void this.forms.ask(data.form as unknown as FormInfo);
        return;
      case "form.replied":
      case "form.cancelled":
        this.forms.resolved(str(data.id));
        return;
      case "permission.replied": {
        // Answered elsewhere (OpenCode's terminal), or the bridge's own answer coming back.
        const id = str(data.requestID);
        const controller = this.pending.get(id);
        this.pending.delete(id);
        this.permissionSessions.delete(id);
        controller?.abort("resolved");
        return;
      }
      case "session.step.ended":
        if (this.turnOpen) this.observeTokens(str(data.assistantMessageID), data.tokens);
        return;
      case "session.step.failed": {
        if (this.turnOpen) this.observeTokens(str(data.assistantMessageID), data.tokens);
        const error = record(data.error) as StructuredError | undefined;
        if (error && error.type !== "aborted") this.stepError = error;
        return;
      }
      case "session.retry.scheduled": {
        const error = record(data.error) as StructuredError | undefined;
        this.report({ type: "status", text: `Retrying${typeof data.attempt === "number" ? ` (attempt ${data.attempt})` : ""}${error?.message ? `: ${error.message}` : "…"}` });
        return;
      }
      case "session.renamed":
        if (str(data.title).trim() !== "") this.report({ type: "title", title: str(data.title).trim() });
        return;
      case "session.model.selected":
        this.current = settingsOf(this.current, record(data.model) as ModelRef | undefined);
        return;
      case "session.agent.selected":
        this.agents.selectedElsewhere(str(data.agent));
        this.report({ type: "mode", mode: this.agents.mode().mode });
        return;
      case "session.compaction.started":
        this.report({ type: "status", text: "Compacting conversation…" });
        return;
      case "session.compaction.ended":
        this.report({ type: "status", text: "" });
        this.compactions += 1;
        this.report({ type: "compacted", trigger: data.reason === "manual" ? "manual" : "auto" });
        return;
      case "session.compaction.failed":
        this.report({ type: "status", text: "" });
        this.report({ type: "notice", level: "warn", text: `OpenCode could not compact this conversation: ${str(record(data.error)?.message) || "unknown error"}` });
        return;
      case "session.execution.succeeded":
        this.endTurn({ type: "turn.end", status: "complete" });
        return;
      case "session.execution.failed": {
        const error = (record(data.error) as StructuredError | undefined) ?? this.stepError;
        this.endTurn({ type: "turn.end", status: "error", error: sessionError(error), retryable: true });
        return;
      }
      case "session.execution.interrupted":
        this.endTurn({ type: "turn.end", status: "interrupted" });
        return;
      default:
        if (!ignoredEvents.has(event.type)) this.host.unknown?.(event.type);
        return;
    }
  }

  private piece(kind: "text" | "reasoning", key: string, delta: string): void {
    if (delta === "") return;
    this.told.set(key, (this.told.get(key) ?? "") + delta);
    this.report({ type: kind, text: delta });
  }

  /** The whole of a piece: what of it was not told yet (a reply that did not stream, or deltas lost while away). */
  private whole(kind: "text" | "reasoning", key: string, full: string): void {
    this.turn.snapshotPiece(key);
    const had = this.told.get(key) ?? "";
    if (!full.startsWith(had)) return;
    if (full.length > had.length) this.report({ type: kind, text: full.slice(had.length) });
    this.told.set(key, full);
  }

  private startTool(id: string, call: ToolCall): void {
    if (call.started) return;
    call.started = true;
    const tool = gatewayTool(call.name, call.input);
    this.report({ type: "tool.start", id, name: tool.name, args: tool.args, ...(tool.context ? { context: tool.context } : {}) });
  }

  private endTool(id: string, outcome: ToolOutcome): void {
    const call = this.calls.get(id);
    if (!call || call.ended) return;
    if (!call.started) this.startTool(id, call);
    call.ended = true;
    this.endShell(id);
    this.subagents.tool(id, call.name, call.input, outcome.ok === "stopped" ? undefined : outcome.metadata, outcome);
    const tool = gatewayTool(call.name, call.input);
    this.report({
      type: "tool.end",
      id,
      name: tool.name,
      args: tool.args,
      ...(tool.context ? { context: tool.context } : {}),
      result: gatewayResult(call.name, call.input, tool, outcome, this.cwd),
    });
  }

  // MARK: Permissions

  private async ask(request: PermissionRequest): Promise<void> {
    if (this.closed || (request.sessionID !== this.id && !this.subagents.owns(request.sessionID)) || this.pending.has(request.id)) return;
    const controller = new AbortController();
    this.pending.set(request.id, controller);
    this.permissionSessions.set(request.id, request.sessionID);
    let answer: RequestAnswer;
    try {
      answer = await this.sink.ask(
        {
          kind: "approval",
          command: approvalCommand(request),
          description: approvalDescription(request),
          choices: ["once", "deny"],
          options: approvalOptions(request),
          // OpenCode tells the model what is said with a no.
          takesNote: true,
          ...(request.sessionID !== this.id ? { subagent: request.sessionID } : {}),
        },
        controller.signal,
      );
    } catch (error) {
      answer = { kind: "withdrawn", reason: (error as Error).message };
    }
    if (this.pending.get(request.id) !== controller) return;
    if (controller.signal.aborted || answer.kind === "withdrawn" || answer.kind === "clarify") {
      this.pending.delete(request.id);
      this.permissionSessions.delete(request.id);
      return;
    }
    const decision = decisionOf(answer);
    const note = decision === "reject" && answer.note ? answer.note : undefined;
    try {
      const api = await this.host.api();
      if (controller.signal.aborted || this.closed) return;
      await api.replyPermission(request.sessionID, request.id, decision, note);
    } catch (error) {
      if (controller.signal.aborted || this.closed) return;
      if ((error as Error).name === "PermissionNotFoundError") {
        const waiting = await (await this.host.api()).pendingPermissions(request.sessionID).catch(() => null);
        if (waiting && !waiting.some((pending) => pending.id === request.id)) return;
      }
      this.report({ type: "notice", level: "warn", text: `OpenCode did not take the answer: ${(error as Error).message}` });
    } finally {
      if (this.pending.get(request.id) === controller) {
        this.pending.delete(request.id);
        this.permissionSessions.delete(request.id);
      }
    }
  }

  /** The requests OpenCode still waits on: the rest close, as answered elsewhere; new ones are asked. */
  private async settlePermissions(api: OpenCodeApi, sessionID = this.id): Promise<void> {
    const epoch = this.permissionEpochs.get(sessionID);
    const waiting = await api.pendingPermissions(sessionID);
    if (this.closed || epoch !== this.permissionEpochs.get(sessionID)) return;
    const ids = new Set(waiting.map((request) => request.id));
    for (const [id, controller] of [...this.pending]) {
      if (ids.has(id) || this.permissionSessions.get(id) !== sessionID) continue;
      this.pending.delete(id);
      this.permissionSessions.delete(id);
      controller.abort("resolved");
    }
    for (const request of waiting) void this.ask(request);
  }

  private async settleChildren(api: OpenCodeApi): Promise<void> {
    const ids = new Set([...this.subagents.runningIDs(), ...this.permissionSessions.values()]);
    ids.delete(this.id);
    for (const id of ids) await this.settlePermissions(api, id);
  }

  // MARK: The connection

  /** The stream is back after a drop: what was missed is read from OpenCode's own record. */
  reconnected(): void {
    this.recover(true);
  }

  private recover(boundary: boolean): void {
    if (this.closed || !this.isAttached) return;
    this.turn.recover((frames, current, boundary) => this.resync(frames, current, boundary), (error, attempt) => {
      log.warn("could not catch up with an OpenCode thread", { session: this.id, error: (error as Error).message });
      if (attempt === 3) this.report({ type: "notice", level: "warn", text: "OpenCode could not restore this thread yet. Retrying with a pause between attempts; reconnect or Stop if it remains unavailable." });
    }, boundary);
  }

  private async resync(frames: OpenCodeEvent[], current: () => boolean, boundary: boolean): Promise<void> {
    const api = await this.host.api();
    try {
      if (frames.some((frame) => frame.type === "session.deleted")) await api.session(this.id);
      await this.readSnapshot(api, frames, current, boundary);
    } catch (error) {
      if (!current() || await this.confirmDeleted(api, error)) return;
      throw error;
    }
  }

  /** Confirm an apparent deletion independently: a restart may briefly return 404. */
  private async confirmDeleted(api: OpenCodeApi, error: unknown): Promise<boolean> {
    if ((error as Error).name !== "SessionNotFoundError") return false;
    try {
      await api.session(this.id);
      return false;
    } catch (confirmation) {
      if ((confirmation as Error).name !== "SessionNotFoundError") throw confirmation;
    }
    if (this.closed) return true;
    this.deleted = true;
    this.turn.stop();
    const explanation = "This session was deleted in OpenCode. Start a new thread.";
    if (this.turnOpen) this.endTurn({ type: "turn.end", status: "error", error: explanation, retryable: false });
    else this.report({ type: "notice", level: "warn", text: explanation });
    this.turn.close();
    this.forms.close();
    this.queue.close();
    this.subagents.deleted();
    for (const controller of this.pending.values()) controller.abort("resolved");
    this.pending.clear();
    this.permissionSessions.clear();
    this.host.forget(this);
    return true;
  }

  private async readSnapshot(api: OpenCodeApi, frames: OpenCodeEvent[], current: () => boolean, boundary: boolean): Promise<void> {
    if (!current()) return;
    // A batch is read only after its buffered frames arrived. Never append their
    // deltas: some or all can already be in this snapshot, and SSE has no offset.
    const messages = await api.messages(this.id);
    if (!current()) return;
    if (!boundary) {
      // Updating an ambiguous old piece must not pause or snapshot newer live pieces.
      this.catchUp(messages, true);
      return;
    }
    const [active, waiting] = await Promise.all([api.active(), api.inbox(this.id)]);
    if (!current()) return;
    const lastExecution = frames.findLast((frame) => frame.type.startsWith("session.execution."));
    const terminal = lastExecution && lastExecution.type !== "session.execution.started" ? lastExecution : undefined;
    this.recoverTurns(messages, active.has(this.id), terminal);
    const pending = waiting.some((item) => item.id === this.turnMessage) || this.turn.immediate && waiting.length > 0;
    if (this.turnOpen && !active.has(this.id) && !this.turn.admitting && !pending && !this.turn.hasHeld) {
      if (terminal) this.handle(terminal);
      else if (this.turn.immediate) this.endTurn({ type: "turn.end", status: "complete" });
      else this.endTurn({ type: "turn.end", status: "error", error: "OpenCode stopped before recording this turn's outcome. Its server may have crashed or restarted. Send a message to continue.", retryable: true });
    }
    for (const frame of frames) {
      if (isTurnEvent(frame) || frame.type.startsWith("permission.") || frame.type.startsWith("form.")) continue;
      if (this.appliedFrames.has(frame)) continue;
      this.appliedFrames.add(frame);
      if (frame.type === "session.inbox.delivered") {
        // The snapshot already told its turn. A delayed receipt still settles
        // steering, but cannot reopen an execution which the snapshot ended.
        const id = str(frame.data.inboxID);
        this.queue.delivered(id);
        this.inbox.delete(id);
        continue;
      }
      this.handle(frame);
    }
    // A stale/broken child must never prevent the parent's native cards from
    // being restored, including when recovery runs before any phone connects.
    await Promise.all([this.settlePermissions(api), this.forms.reconcile()]);
    await this.queue.reconcile();
    await this.subagents.reconcile();
    await this.settleChildren(api);
  }

  /** Replay every unseen execution, including desk turns completed entirely offline. */
  private recoverTurns(messages: Message[], running: boolean, terminal?: OpenCodeEvent): void {
    const groups = historyTurns(messages);
    for (const group of groups) {
      if (this.knownTurns.has(group.id) || this.turn.abandoned(group.id)) continue;
      if (!this.turnOpen) {
        this.openTurn();
        this.turnMessage = group.id;
        this.report({ type: "turn.begin", user: group.user });
      } else if (!group.messages.some((message) => message.id === this.turnMessage)) {
        // The admission acknowledgement can arrive after execution started.
        if (this.turn.admitting) continue;
        this.turnMessage = group.id;
      }
      this.catchUp(group.messages);
      if (group.idle) {
        const idle = group.idle;
        if (idle.outcome === "succeeded") this.endTurn({ type: "turn.end", status: "complete" });
        else if (idle.outcome === "interrupted") this.endTurn({ type: "turn.end", status: "interrupted" });
        else this.endTurn({ type: "turn.end", status: "error", error: sessionError(idle.error), retryable: true });
        this.knownTurns.add(group.id);
      } else if (!running && terminal) this.handle(terminal);
    }
  }

  /** Tells what these messages of the open turn hold that was not told yet. */
  private catchUp(messages: Message[], piecesOnly = false): void {
    if (!this.turnOpen) return;
    let compactions = 0;
    for (const message of messages) {
      if (!piecesOnly && message.type === "compaction") {
        const compacted = message as Extract<Message, { type: "compaction" }>;
        if (compacted.status === "completed" && ++compactions > this.compactions) {
          this.compactions = compactions;
          this.report({ type: "compacted", trigger: compacted.reason === "manual" ? "manual" : "auto" });
        }
      }
      if (message.type !== "assistant") continue;
      const assistant = message as Extract<Message, { type: "assistant" }>;
      let texts = 0;
      let thoughts = 0;
      for (const part of assistant.content ?? []) {
        if (part.type === "text" || part.type === "reasoning") {
          const key = `${assistant.id}:${part.type}:${part.type === "text" ? texts++ : thoughts++}`;
          if (!piecesOnly || this.turn.covers(key)) this.whole(part.type, key, part.text);
        } else if (!piecesOnly && part.type === "tool") {
          if (part.state.status === "streaming") continue;
          const call = this.calls.get(part.id) ?? { name: part.name, input: {}, started: false, ended: false };
          call.name = part.name;
          call.input = record(part.state.input) ?? call.input;
          this.calls.set(part.id, call);
          this.startTool(part.id, call);
          this.subagents.tool(part.id, part.name, call.input, part.state.metadata);
          if (part.state.status === "running") this.followShell(part.id, call, part.state.metadata);
          if (part.state.status === "completed") this.endTool(part.id, { ok: true, content: part.state.content, metadata: part.state.metadata });
          else if (part.state.status === "error") this.endTool(part.id, { ok: false, error: part.state.error, content: part.state.content, metadata: part.state.metadata });
        }
      }
      if (!piecesOnly) this.observeTokens(assistant.id, assistant.tokens);
    }
  }

  private observeTokens(id: string, value: unknown): void {
    const tokens = record(value) as unknown as TokenUsage | undefined;
    const total = tokenTotal(tokens);
    if (!tokens || total === undefined) return;
    if (id && this.stepTokens.get(id) === total) return;
    const changed = tokenTotal(this.lastTokens) !== total;
    this.lastTokens = tokens;
    if (id) this.stepTokens.set(id, total);
    const usage = this.usage();
    if (changed && usage) this.report({ type: "usage", usage });
  }

  /** A native shell is followed only after a tool of this turn explicitly names it. */
  private followShell(id: string, call: ToolCall, metadata: Json | undefined): void {
    const shell = str(metadata?.shellID);
    if (!shell || call.ended || !this.turnOpen || (call.name !== "shell" && call.name !== "bash")) return;
    if (this.shells.get(id)?.shell === shell) return;
    this.endShell(id);
    const output: ShellOutput = { shell, cursor: 0, dropped: false };
    this.shells.set(id, output);
    void this.readShell(id, output);
  }

  private async readShell(id: string, output: ShellOutput): Promise<void> {
    const current = () => !this.closed && this.turnOpen && this.shells.get(id) === output && !this.calls.get(id)?.ended;
    try {
      const api = await this.host.api();
      if (!current()) return;
      let read = await api.shellOutput(this.cwd, output.shell, output.cursor);
      if (!current()) return;
      if (Number.isFinite(read.size) && read.size - read.cursor > 8192) {
        // Jump over a large backlog: the app displays a tail, never an ever-growing
        // queue of pages. A second bounded read reaches that tail in this poll.
        output.cursor = read.size - 8192;
        output.dropped = true;
        read = await api.shellOutput(this.cwd, output.shell, output.cursor);
        if (!current()) return;
      }
      // The cursor is OpenCode's byte offset, never a JS string length. A repeated
      // response is harmless, including after a reconnect or a tool snapshot.
      if (Number.isFinite(read.cursor) && read.cursor > output.cursor) {
        output.cursor = read.cursor;
        output.dropped ||= read.truncated;
        this.liveOutput.append(id, read.output);
      }
    } catch {
      // A dropped connection or a shell already removed must not fail its tool.
      // Retry only while this exact tool is still live; its result ends the poll.
    }
    if (!current()) return;
    output.timer = setTimeout(() => { output.timer = undefined; void this.readShell(id, output); }, 250);
    output.timer.unref();
  }

  private endShell(id: string): void {
    const output = this.shells.get(id);
    if (output?.timer) clearTimeout(output.timer);
    this.liveOutput.end(id);
    this.shells.delete(id);
  }

  private clearShells(): void {
    for (const id of this.shells.keys()) this.endShell(id);
    this.liveOutput.clear();
  }

  private report(event: ProviderEvent): void {
    try {
      this.sink.emit(event);
    } catch (error) {
      log.warn("an OpenCode event could not be passed on", { session: this.id, type: event.type, error: (error as Error).message });
    }
  }
}

interface HistoryTurn {
  id: string;
  user: string;
  messages: Message[];
  idle?: Extract<Message, { type: "idle" }>;
}

/** Steering users belong to the same execution; only native idle separates turns. */
function historyTurns(messages: Message[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  let current: HistoryTurn | undefined;
  for (const message of messages) {
    if (!current && (message.type === "user" || message.type === "compaction" && (message as Extract<Message, { type: "compaction" }>).reason === "manual")) {
      current = { id: message.id, user: str((message as { text?: unknown }).text), messages: [] };
      turns.push(current);
    }
    current?.messages.push(message);
    if (message.type === "idle") {
      if (current) current.idle = message as Extract<Message, { type: "idle" }>;
      current = undefined;
    }
  }
  return turns;
}

function lastUserIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index].type === "user") return index;
  return -1;
}

/**
 * What the card offers. "Always" is OpenCode's: a rule saved for the project that
 * allows what the request proposes (`save`) from then on, in every session; there is no
 * grant for this thread only.
 */
export function approvalOptions(request: PermissionRequest): ApprovalOption[] {
  const save = request.save ?? [];
  const rule = `${request.action} ${save.join(", ")}`;
  return [
    { id: "once", label: "Allow once", description: "Allow this request only.", effects: [{ scope: "once", text: "This request only." }] },
    ...(save.length > 0
      ? [
          {
            id: "always",
            label: "Always allow in this project",
            description: `Saves an OpenCode rule for this project that allows ${rule}. It stays after this thread, for every session in the project, until it is removed in OpenCode.`,
            effects: [{ scope: "settings" as const, text: `Saved in OpenCode for this project: allow ${rule}.` }],
            requiresConfirmation: true,
          },
        ]
      : []),
    { id: "reject", label: "Deny", description: "Do not allow this. OpenCode also turns down its other waiting requests in this thread.", effects: [] },
  ];
}

function decisionOf(answer: Extract<RequestAnswer, { kind: "approval" | "approval.option" }>): PermissionDecision {
  if (answer.kind === "approval.option") return answer.option === "once" || answer.option === "always" ? answer.option : "reject";
  return answer.choice === "once" || answer.choice === "session" ? "once" : answer.choice === "always" ? "always" : "reject";
}

/** Native authentication failures are actionable; other provider errors retain their own explanation. */
export function sessionError(error: StructuredError | null | undefined): string {
  return error?.type === "provider.authentication" || error?.status === 401 ? notSignedIn("opencode") : error?.message || "OpenCode stopped with an error.";
}
