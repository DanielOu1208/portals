import { log } from "../../log.ts";
import type {
  ApprovalChoice,
  ClarifyQuestion,
  ContextUsage,
  HostNote,
  ModeState,
  ModelChangeResult,
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
import { SettingRefused } from "../types.ts";
import { machineWord } from "../../platform.ts";
import { HermesError, type Frame } from "./client.ts";
import { Unknowns } from "../unknowns.ts";
import { HermesSubagents } from "./subagents.ts";
import { rowsGone } from "./typed.ts";

// One Hermes session as a thread of the bridge.
//
// Hermes speaks the protocol the bridge speaks to the app, so this is mostly a matter
// of passing things on: its events become the bridge's neutral events (which the
// bridge's session turns back into the same events, with its own `seq`), its approvals
// and questions go to the phone through the sink, and its stored conversation is
// already in the shape `session.resume` returns. The thread's id is Hermes's stored
// session id; the runtime id Hermes gives a loaded session stays in here, and changes
// whenever Hermes loads the session again.

/** What a session needs of the provider. */
export interface HermesHost {
  call<T = any>(method: string, params: Frame, timeoutMs?: number): Promise<T>;
  respond(id: string, result: unknown): void;
  respondError(id: string, code: number, message: string): void;
  /** Routes the events and requests for `runtimeID` to `session` from now on. */
  bind(runtimeID: string, session: HermesSession): void;
  forget(session: HermesSession): void;
  /** How long a stopped turn may take to end before the bridge ends it (15 s when not said). */
  readonly interruptGraceMs?: number;
  /**
   * Where a profile's Bot Chat stands in Hermes's store (its latest segment and how many
   * messages it holds), to tell a change made in another app; null when it has none.
   * Throws when Hermes cannot say.
   */
  botChatMark?(profile: string): Promise<string | null>;
  /** `session` hears when Hermes's stored sessions may have changed (`mayHaveChangedElsewhere`), until it closes. */
  watch?(session: HermesSession): void;
  unwatch?(session: HermesSession): void;
  /**
   * Whether `/name` is one of the profile's commands that Hermes makes a message of
   * (`command.dispatch`), which goes as the turn's in place of the line: a skill, `/plan`.
   */
  turnCommand?(profile: string, name: string): Promise<boolean>;
  /** What the user typed for the thread's messages Hermes stored in place of a command (`turnCommand`), by the stored row's id. */
  typedCommands?(thread: string): Map<number, string>;
  /** Keeps what the user typed for the thread's message Hermes stored as row `row`, after a restart too. */
  keepTyped?(thread: string, row: number, text: string): void;
  /** Lets go of what was typed for the thread's stored rows `rows`, which Hermes no longer has. */
  forgetTyped?(thread: string, rows: readonly number[]): void;
  /** Marks the thread's stored rows `rows` as read back: Hermes still has them, so they are kept past the bound for rows never read. */
  confirmTyped?(thread: string, rows: readonly number[]): void;
}

/** Hermes's answer to `session.resume` and `session.create`, as far as it is read here. */
export interface Loaded {
  session_id: string;
  running?: boolean;
  messages?: StoredMessage[];
  inflight?: { user?: string; assistant?: string };
  open_requests?: { id: string; method: string; params: Frame }[];
  info?: Frame;
}

/** Hermes's ask-for-a-secret requests, answered with nothing as the app answers them. */
const secretRequests = new Set(["sudo", "secret", "vault.code", "vault.unlock_prompt", "display.install.sudo"]);
const approvalChoices: ApprovalChoice[] = ["once", "session", "always", "deny"];
/** A runtime id Hermes no longer has loaded. */
const notLoaded = 4001;
/** Hermes is still settling an interrupt; the app waits and asks again. */
const settling = 4009;
/** A message that is `/compress` or `/compact`, with what to keep in focus after it. */
const compressLine = /^\/(?:compress|compact)(?:\s+([\s\S]*))?$/;
/** A message that is a slash command: its name, and what follows it. */
const commandLine = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/;
/**
 * Compressing a long conversation takes a model call of its own, which can take minutes:
 * Hermes gives it up to ten (`compression.context_total_ceiling_seconds`), and its own
 * apps wait a minute more for its answer.
 */
const compressTimeoutMs = 11 * 60_000;
/** What a turn says as it runs: not shown of a stopped turn the bridge ended for the app. */
const abandonedTurnEvents = new Set(["message.delta", "message.interim", "reasoning.delta", "thinking.delta", "status.update", "tool.start", "tool.complete"]);
/**
 * The events Hermes's contract has (tui_gateway/contracts/events.py, at v0.22.5) that are
 * not shown through the bridge (yet), or that its client reads itself.
 */
const quietEvents = new Set([
  "gateway.ready", "skin.changed", "onboarding.ended", "setup.ready", "free_tier.challenge", "notice", "reasoning.available", "reaction",
  "review.summary", "agent.print", "tool.generating", "tool.output_risk", "tool.progress", "todo.updated", "tip.show", "session.resume_progress", "session.reclaimed", "approval.cancelled", "session.control.update",
  "billing.step_up.verification", "background.complete", "btw.complete", "preview.restart.complete", "preview.restart.progress",
  "moa.reference", "moa.aggregating", "moa.progress", "moa.phase", "preview.open", "preview.close", "pane.reveal", "message.reaction",
  "agent.terminal.output", "terminal.close", "browser.progress", "browser.controller.command", "browser.controller.cancel",
  "voice.interrupted", "voice.status", "voice.partial", "voice.transcript", "wake.detected", "pet.changed", "pet.generate.progress",
  "pet.hatch.progress", "cron.changed", "sessions.changed", "platforms.changed", "projects.changed", "pairing.changed", "skills.changed",
  "bot_relay.outbox.pending", "subagent.thinking",
]);

interface Pending {
  controller: AbortController;
  /** Hermes still has it, as far as the bridge knows (false while the connection is down). */
  live: boolean;
}

type Held = { kind: "event"; type: string; seq: number | undefined; payload: Frame } | { kind: "request"; id: string; method: string; params: Frame };

export class HermesSession implements ProviderSession {
  readonly id: string;
  /** The Hermes profile the session belongs to. */
  readonly profile: string;
  private readonly sink: SessionSink;
  private readonly host: HermesHost;
  private runtimeID: string;
  private current: SessionSettings;
  private stored: StoredMessage[] = [];
  /** The last `seq` taken in for the runtime id. */
  private lastSeq = 0;
  private isAttached = false;
  private readonly held: Held[] = [];
  /** A turn runs in Hermes, as far as the bridge has told the app. */
  private turnOpen = false;
  /** Turns opened so far, so a stop's timer is its own turn's. */
  private turns = 0;
  /** Ends a stopped turn Hermes does not end by itself (`interrupt`). */
  private interruptTimer: NodeJS.Timeout | null = null;
  /**
   * A stopped turn the timer ended for the app that Hermes has not said it ended: until
   * its `message.complete` (or the start of another turn), what Hermes says of it is not
   * shown, and the thread is still at work (`stopping`).
   */
  private abandoned = false;
  /** Hermes's `message.start` of the turn open came. */
  private startHeard = true;
  /** The abandoned turn's own `message.start` has not come yet (a replay may bring it late): it opens nothing. */
  private abandonedStartDue = false;
  /** The session's tokens so far, as Hermes last said them at rest or at a turn's end (its usage `total`); null until it says. */
  private sessionTokens: number | null = null;
  /** The user message that opened the turn running when the session was loaded. */
  private runningUser: string | null = null;
  /** What Hermes had written of that turn's reply, then. */
  private runningText = "";
  /** Text streamed since the turn's last tool call, to know whether `message.complete`'s text is news. */
  private streamed = "";
  /** Why Hermes is about to start a turn of its own (`status.update` kind process or loop). */
  private announced: string | null = null;
  private readonly pending = new Map<string, Pending>();
  /** Loaded on the current connection; false after a drop until it is resumed again. */
  private bound = true;
  private resuming: Promise<void> | null = null;
  /** Live frames wait behind replay, so receiving a newer seq cannot skip an older one. */
  private recovering: Held[] | null = null;
  private generation = 0;
  private closed = false;
  /** Which connection has actually bound the runtime, even if its history recovery failed. */
  private runtimeGeneration = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay = 400;
  /** The profile's one ongoing conversation (feature bot_chat): it keeps its name, whatever Hermes titles it. */
  private readonly ongoing: boolean;
  /** Kinds of event the bridge does not know, each said once in the log. */
  private readonly unknowns = new Unknowns((type) => log.info("Hermes sent an event the bridge does not know", { session: this.id, type }), quietEvents);
  /** The mode the bridge kept for the thread, which Hermes's own (`yolo`) may have changed from since. */
  private readonly keptMode: ThreadMode;
  /**
   * A `/compress` Hermes is carrying out, which nothing stops (Hermes's own Stop leaves a
   * compression be). `turn` is the turn that asked for it, until Stop let go of it
   * (`interrupt`); `done` settles once Hermes answers. Hermes takes nothing else for the
   * session meanwhile: a message sent waits for it (`afterCompression`).
   */
  private compression: { turn: number | null; done: Promise<void> } | null = null;
  /** The turn open waits for a compression Stop let go of before it goes to Hermes. */
  private waitsOnCompression = false;
  /** Where Hermes's stored copy of the ongoing conversation stood when last looked at (`botChatMark`). */
  private mark: string | null = null;
  /** When the last turn the bridge ran ended (ms since the epoch): a look at the store across it is out of date. */
  private ownTurnEnded = 0;
  /**
   * The messages the bridge gave Hermes that its stored copy (`stored`) does not hold yet,
   * oldest first: Hermes writing them down is no change made elsewhere (`ownWrites`). One
   * Hermes did not take is let go of (`begin`).
   */
  private unwritten: string[] = [];
  /**
   * Hermes's replay after a reconnect had lost some of what it said (`truncated`): the
   * thread has holes until Hermes's stored copy is taken in its place, which the next look
   * at it does once at rest (`changedConversation`).
   */
  private gap = false;
  /** The children Hermes's `delegate_task` started, as the subagents line shows them. */
  private readonly subagents = new HermesSubagents();
  /** Hermes runs this session's commands without asking for approval (its session-only `yolo`): the thread's `full` mode. */
  private yolo = false;
  /**
   * The profile asks for no approvals at all (its `approvals.mode` is `off`): Hermes's word
   * on the session's `yolo` is then always yes, whatever the session's own is, and `default`
   * comes to `full`.
   */
  private approvalsOff = false;
  /** The text of each of Hermes's notices shown, by its key: one said again unchanged is not shown twice. */
  private readonly notices = new Map<string, string>();
  /** The key of the notice shown on the status line, which Hermes's `notification.clear` takes off. */
  private statusNotice: string | null = null;
  /** The last turn Hermes has (it took the message or began it, or was running it when loaded). */
  private handedOver = 0;
  /** What the user typed for the messages Hermes stored in place of a command, by the stored row's id (`typedCommands`). */
  private readonly typed: Map<number, string>;
  /** Hermes's `message.start`s heard so far, so a resume knows a turn began after its snapshot. */
  private starts = 0;

  /**
   * `mark` is where Hermes's stored copy of the ongoing conversation stood before `loaded`
   * was read; null when it is not known (Hermes could not say, or the conversation was
   * just made), and the first change is then read and looked at in full.
   */
  constructor(options: SessionOptions, profile: string, sink: SessionSink, host: HermesHost, loaded: Loaded, mark?: string | null) {
    this.id = options.id;
    this.profile = profile;
    this.sink = sink;
    this.host = host;
    this.current = { ...options.settings };
    this.ongoing = options.ongoing === true;
    this.keptMode = options.mode ?? "default";
    this.yolo = this.keptMode === "full";
    this.runtimeID = loaded.session_id;
    this.typed = host.typedCommands?.(options.id) ?? new Map();
    this.take(loaded);
    host.bind(this.runtimeID, this);
    if (this.ongoing && host.botChatMark) {
      host.watch?.(this);
      // Where Hermes's copy stood as it was read: a change from there on may be another app's.
      this.mark = mark ?? null;
    }
  }

  /**
   * Hermes's stored copy of the conversation, read back (`storedMessages`). What was typed
   * for a row it no longer has (one compressing summarised away) is let go of, and one it
   * still has is marked read back.
   */
  private readStored(messages: unknown[]): StoredMessage[] {
    const gone = rowsGone(this.typed.keys(), messages);
    if (gone.length > 0) {
      for (const row of gone) this.typed.delete(row);
      this.host.forgetTyped?.(this.id, gone);
    }
    const present = messages
      .map((message) => (message as { row_id?: unknown } | null)?.row_id)
      .filter((row): row is number => typeof row === "number" && this.typed.has(row));
    if (present.length > 0) this.host.confirmTyped?.(this.id, present);
    return storedMessages(messages, this.typed);
  }

  /** What `session.resume` (or `session.create`) said: the conversation, a turn under way, the settings. */
  private take(loaded: Loaded): void {
    this.stored = Array.isArray(loaded.messages) ? this.readStored(loaded.messages) : [];
    const info = loaded.info ?? {};
    if (typeof info.model === "string" && info.model !== "") this.current.model = info.model;
    if (typeof info.provider === "string" && info.provider !== "") this.current.provider = info.provider;
    if (typeof info.reasoning_effort === "string") this.current.reasoningEffort = info.reasoning_effort;
    this.noteApprovals(info);
    if (loaded.running && loaded.inflight) {
      this.openTurn();
      this.handedOver = this.turns;
      this.runningUser = loaded.inflight.user ?? "";
      // The message that opened it, as the stored copy now reads (`storedMessages`): a command, as typed.
      const opened = (Array.isArray(loaded.messages) ? loaded.messages : []).filter((message) => message?.role === "user").at(-1) as Frame | undefined;
      const typed = opened?.text === this.runningUser && Number.isInteger(opened?.row_id) ? this.typed.get(opened.row_id) : undefined;
      if (typed !== undefined) this.runningUser = typed;
      this.unwritten.push(this.runningUser);
      this.runningText = loaded.inflight.assistant ?? "";
      // Questions waiting in the turn are asked once the bridge's side is wired up.
      for (const request of loaded.open_requests ?? []) {
        if (typeof request?.id === "string" && typeof request.method === "string") {
          this.held.push({ kind: "request", id: request.id, method: request.method, params: request.params ?? {} });
        }
      }
    }
  }

  // MARK: ProviderSession

  async history(): Promise<StoredMessage[]> {
    return structuredClone(this.stored);
  }

  attached(): { user: string } | null {
    this.isAttached = true;
    const running = this.turnOpen && this.runningUser !== null ? { user: this.runningUser } : null;
    // After the bridge has taken in the answer: the reply so far, then what Hermes sent meanwhile.
    queueMicrotask(() => {
      if (this.closed) return;
      if (running && this.runningText !== "") this.report({ type: "text", text: this.runningText });
      this.runningText = "";
      // Changed in another Hermes app since the bridge last kept it.
      if (this.mode().mode !== this.keptMode) this.report({ type: "mode", mode: this.mode().mode });
      for (const entry of this.held.splice(0)) {
        if (entry.kind === "event") this.handle(entry.type, entry.seq, entry.payload);
        else this.request(entry.id, entry.method, entry.params);
      }
    });
    return running;
  }

  settings(): SessionSettings {
    return { ...this.current };
  }

  /**
   * Adds a message to the running turn (Hermes's `session.steer`), which Hermes hands its
   * model with the next tool result; one that comes after the turn's last tool call is a
   * turn of its own that Hermes begins once this one ends. Words only: a picture goes in a
   * turn of its own. Refused when Hermes says no, as it does before its agent is ready.
   */
  async steer(prompt: Prompt): Promise<boolean | "refused"> {
    if (!this.turnOpen || prompt.images.length > 0) return "refused";
    let result: { status?: string };
    try {
      result = await this.call<{ status?: string }>("session.steer", { text: prompt.text });
    } catch (error) {
      // An answer that says no is surely no; a connection lost may have taken it with it.
      return error instanceof HermesError ? "refused" : false;
    }
    if (result?.status !== "queued" && result?.status !== "redirected") return "refused";
    // Hermes writes it down, as a message of the person's.
    this.unwritten.push(prompt.text);
    return true;
  }

  /** Not while Hermes compacts the conversation, nor before its agent has begun the turn: it would say no. */
  steerable(): boolean {
    return this.compression === null && !this.waitsOnCompression && this.startHeard && !this.abandoned;
  }

  /** Stops one of the children Hermes's `delegate_task` started (`subagent.interrupt`); the turn and the others go on. */
  async stopSubagent(id: string): Promise<boolean> {
    if (!this.subagents.running(id)) return false;
    const result = await this.call<{ found?: boolean }>("subagent.interrupt", { subagent_id: id });
    return result?.found === true;
  }

  /** `full` while Hermes runs this session's commands without asking (its `yolo`, for this session only), else `default`. */
  mode(): ModeState {
    return { mode: this.yolo ? "full" : "default", ...(this.approvalsOff ? { defaultsTo: "full" as const } : {}) };
  }

  /** Hermes's `yolo` for this session alone: the profile's own approval settings stay as they are. */
  async setMode(mode: ThreadMode): Promise<void> {
    if (mode !== "full" && mode !== "default") throw new SettingRefused("Hermes threads have two modes: full and default.");
    const result = await this.call<{ value?: unknown }>("config.set", { key: "yolo", value: mode === "full" ? "on" : "off", scope: "session" });
    this.yolo = result?.value === undefined ? mode === "full" : result.value === "1" || result.value === true;
  }

  /** What Hermes answers one of its own commands (`slash.exec`), as its text. */
  async slash(line: string): Promise<string> {
    const result = await this.call<{ output?: unknown; warning?: unknown }>("slash.exec", { command: line });
    return [stringOf(result?.output).trim(), stringOf(result?.warning).trim()].filter((part) => part !== "").join("\n\n");
  }

  startTurn(prompt: Prompt): void {
    this.openTurn();
    const focus = compressFocus(prompt);
    // Hermes says `message.start` for a message once it begins, and none for compressing.
    this.startHeard = focus !== null;
    this.streamed = "";
    void (focus !== null ? this.compress(focus) : this.begin(prompt));
  }

  async rename(title: string): Promise<void> {
    await this.call("session.title", { title });
  }

  async interrupt(): Promise<boolean> {
    if (!this.turnOpen) return false;
    // Nothing of it is in Hermes yet: it only waited for a compression to end.
    if (this.waitsOnCompression) {
      this.waitsOnCompression = false;
      this.endTurn({ type: "turn.end", status: "interrupted" });
      return true;
    }
    // Hermes goes on compressing whatever it is asked, and its Stop would only drop what
    // waits behind it: the turn ends for the app, which can go on, and the compression is
    // let go of. What it did is still told once Hermes answers (`compress`).
    if (this.compression?.turn === this.turns) {
      this.compression.turn = null;
      this.report({
        type: "notice",
        level: "info",
        text: "Hermes goes on compacting the conversation: once it has begun it cannot be stopped. A message sent meanwhile goes once it is done.",
      });
      this.endTurn({ type: "turn.end", status: "interrupted" });
      return true;
    }
    const turn = this.turns;
    const result = await this.call<{ status?: string }>("session.interrupt", {});
    const interrupted = result?.status === "interrupted";
    // A Hermes that took the stop but never says the turn ended (no `message.complete`)
    // left it running for the app for good: it is ended here after the grace Codex has,
    // and the thread stays at work until Hermes is done with it (`stopping`). Not armed
    // for a turn that ended, or a next one that began, while the stop was answered.
    if (interrupted && this.turnOpen && this.turns === turn) {
      this.interruptTimer ??= setTimeout(() => {
        this.interruptTimer = null;
        if (!this.turnOpen || this.turns !== turn) return;
        this.abandoned = true;
        this.abandonedStartDue = !this.startHeard;
        this.endTurn({ type: "turn.end", status: "interrupted" });
      }, this.host.interruptGraceMs ?? 15_000);
      this.interruptTimer.unref();
    }
    return interrupted;
  }

  /**
   * True while Hermes may still run a stopped turn the bridge ended for the app: until it
   * says the turn ended, or its list of sessions at work no longer has this one; and while
   * it finishes a compression Stop let go of. Throws
   * when Hermes cannot be asked.
   */
  async stopping(): Promise<boolean> {
    // A compression Stop let go of: Hermes is still at it.
    if (this.compression !== null) return true;
    if (!this.abandoned) return false;
    const listed = await this.host.call<{ sessions?: Frame[] }>("session.active_list", {});
    if (!this.abandoned) return false;
    const busy = new Set(["working", "waiting", "starting"]);
    if ((listed?.sessions ?? []).some((row) => row?.session_key === this.id && busy.has(row?.status))) return true;
    this.abandoned = false;
    this.abandonedStartDue = false;
    return false;
  }

  /**
   * Hermes's stored sessions changed somewhere (its `sessions.changed`): for the profile's
   * ongoing conversation, the bridge's side looks whether another app went on with it.
   */
  mayHaveChangedElsewhere(): void {
    if (this.ongoing && this.isAttached && !this.closed) this.report({ type: "conversation.changed" });
  }

  /**
   * For the profile's ongoing conversation at rest (feature bot_chat): the conversation as
   * Hermes has it now when another app went on with it since the bridge last looked
   * (Hermes Desktop, a terminal: each runs it in a Hermes of its own, so none of it comes
   * to the bridge as it happens), else null. Told by where Hermes's stored copy stands
   * (`botChatMark`), which moves on only once the bridge takes the messages (`take`).
   *
   * When it moved, the store is read: a copy that is the one last read with only the
   * bridge's own messages after it (`ownWrites`) is Hermes writing down a turn of the
   * bridge's own, and the mark moves on; any other is taken. A copy the bridge cannot
   * account for is taken rather than passed over, so a doubt costs a reload, never a
   * message. After a replay with a `gap`, the copy is taken however it stands.
   */
  async changedConversation(): Promise<{ messages: StoredMessage[]; take(): void } | null> {
    if (!this.ongoing || this.closed || this.busyHere || !this.host.botChatMark) return null;
    // A turn of the bridge's own that begins (or a compression Stop let go of that ends)
    // while Hermes is asked makes what it answers out of date: the look is given up, and
    // the next change looks again.
    const turns = this.turns;
    const ended = this.ownTurnEnded;
    const stale = () => this.closed || this.busyHere || this.turns !== turns || this.ownTurnEnded !== ended;
    const mark = await this.host.botChatMark(this.profile);
    if (mark === null || stale() || (mark === this.mark && !this.gap)) return null;
    // The live session again, as Hermes has it in its store: what was said elsewhere, and
    // what compressing it summarised away. A failed look is tried again with the next change.
    const loaded = await this.call<Loaded>("session.resume", { session_id: this.id, inline_images: false }, 120_000);
    if (stale() || loaded?.running === true || loaded?.session_id !== this.runtimeID || !Array.isArray(loaded.messages)) return null;
    const messages = this.readStored(loaded.messages);
    const own = ownWrites(this.stored, messages, this.unwritten);
    const read = () => {
      this.mark = mark;
      this.stored = messages;
      this.unwritten.splice(0, own.written);
      this.gap = false;
    };
    if (own.only && !this.gap) {
      read();
      return null;
    }
    return { messages: structuredClone(messages), take: read };
  }

  /** Anything of the bridge's own in hand: a turn, a compression, a stopped turn Hermes may still run, a question, a resume. */
  private get busyHere(): boolean {
    return this.turnOpen || this.compression !== null || this.abandoned || this.pending.size > 0 || this.resuming !== null;
  }

  private openTurn(): void {
    this.turnOpen = true;
    this.turns += 1;
  }

  async setModel(model: string, provider: string): Promise<ModelChangeResult> {
    // Hermes's own `/model` line, for this session only. Choosing a model in the app is
    // the yes Hermes asks for before an expensive one.
    const value = provider ? `${model} --provider ${provider} --session` : `${model} --session`;
    const result = await this.call<{ deferred?: boolean; warning?: string }>("config.set", { key: "model", value, confirm_expensive_model: true });
    this.current.model = model;
    if (provider) this.current.provider = provider;
    if (typeof result?.warning === "string" && result.warning.trim() !== "") this.report({ type: "notice", level: "warn", text: result.warning.trim() });
    return { deferred: result?.deferred === true };
  }

  async setReasoning(level: string): Promise<void> {
    await this.call("config.set", { key: "reasoning", value: level });
    this.current.reasoningEffort = level;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.host.unwatch?.(this);
    this.generation += 1;
    this.clearRetry();
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    this.recovering = null;
    // The session lives on in Hermes; only the bridge's side goes.
    for (const entry of this.pending.values()) entry.controller.abort("withdrawn");
    this.pending.clear();
    this.host.forget(this);
  }

  // MARK: Turns

  /**
   * Waits for a compression Stop let go of (`interrupt`) to end, Hermes taking nothing
   * else for the session meanwhile. False when the turn ended while it waited (stopped).
   */
  private async afterCompression(turn: number): Promise<boolean> {
    const running = this.compression;
    if (!running) return true;
    this.waitsOnCompression = true;
    this.report({ type: "status", text: "Waiting for Hermes to finish compacting…" });
    await running.done;
    if (this.turns === turn) this.waitsOnCompression = false;
    if (!this.turnOpen || this.turns !== turn) return false;
    this.report({ type: "status", text: "" });
    return true;
  }

  private async begin(prompt: Prompt): Promise<void> {
    const turn = this.turns;
    const mine = () => !this.closed && this.turnOpen && this.turns === turn;
    if (!(await this.afterCompression(turn)) || !mine()) return;
    // A stopped turn Hermes has not said it ended: Hermes is asked whether it still runs
    // it. Its events and this turn's carry no turn of their own, so this turn's start could
    // be taken for that one's (`abandonedStartDue`), hiding this turn and leaving it running
    // for good: while Hermes still runs it (or cannot say), the message is not sent, and
    // fails to be sent again in a moment. A turn stopped while Hermes was asked is not sent.
    if (this.abandoned) {
      const running = await this.stopping().catch(() => true);
      if (!mine()) return;
      if (running) {
        this.endTurn({ type: "turn.end", status: "error", error: "Hermes is still stopping the turn before. Send this again in a moment.", retryable: true });
        return;
      }
    }
    let asked = false;
    let text = prompt.text;
    try {
      // One of Hermes's own commands that it makes a message of: that message goes.
      const command = isCommandOf(prompt);
      if (command && (await this.host.turnCommand?.(this.profile, command.name))) {
        if (!mine()) return;
        const dispatched = await this.call<{ type?: string; message?: unknown }>("command.dispatch", { name: command.name, arg: command.argument });
        if (!mine()) return;
        if ((dispatched?.type !== "send" && dispatched?.type !== "skill") || stringOf(dispatched.message).trim() === "") throw new Error(`Hermes did not run /${command.name}.`);
        text = stringOf(dispatched.message);
      }
      for (const image of prompt.images) {
        const attached = await this.call<{ attached?: boolean; message?: string }>("image.attach_bytes", {
          content_base64: image.data.toString("base64"),
          filename: image.filename,
        });
        if (!mine()) return;
        if (attached?.attached === false) throw new Error(attached.message || `Hermes did not take ${image.filename}.`);
      }
      // Before it is asked: Hermes may write it down before it answers.
      this.unwritten.push(text);
      asked = true;
      const submitted = await this.call<{ user_row_id?: unknown }>("prompt.submit", { text });
      if (mine()) this.handedOver = turn;
      // A command Hermes made a message of: the row Hermes stored it as reads back as typed,
      // and Hermes writing it down is the bridge's own (`ownWrites`). Hermes says the row
      // only once it is stored; without it, the row reads back as Hermes's message.
      const row = submitted?.user_row_id;
      if (text !== prompt.text && typeof row === "number" && Number.isInteger(row)) {
        this.typed.set(row, prompt.text);
        this.host.keepTyped?.(this.id, row, prompt.text);
        const at = this.unwritten.lastIndexOf(text);
        if (at >= 0) this.unwritten[at] = prompt.text;
      }
    } catch (error) {
      // Events can finish this turn and start the next before the submit RPC answers.
      if (!mine()) return;
      // Not a message of the bridge's own in Hermes's store: the same words written there
      // later are another app's (said again in Hermes Desktop), and taken. One Hermes did
      // take after all (an answer lost with the connection) is then taken as a change too.
      const at = asked ? this.unwritten.lastIndexOf(text) : -1;
      if (at >= 0) this.unwritten.splice(at, 1);
      this.endTurn({ type: "turn.end", status: "error", error: `Hermes did not take the message: ${(error as Error).message}`, retryable: true });
    }
  }

  /**
   * `/compress` as a turn of its own: Hermes summarises the conversation in place, saying
   * how it goes as `status.update`s, and answers once done. What it kept is still shown.
   */
  private async compress(focus: string): Promise<void> {
    const turn = this.turns;
    if (!(await this.afterCompression(turn))) return;
    const mine = () => this.turnOpen && this.turns === turn;
    let settle = () => {};
    const compression: { turn: number | null; done: Promise<void> } = { turn, done: new Promise((resolve) => (settle = resolve)) };
    this.compression = compression;
    let result: Frame;
    try {
      result = (await this.call<Frame>("session.compress", focus === "" ? {} : { focus_topic: focus }, compressTimeoutMs)) ?? {};
    } catch (error) {
      const failed = `Hermes could not compress the conversation: ${(error as Error).message}`;
      if (mine()) this.endTurn({ type: "turn.end", status: "error", error: failed, retryable: true });
      else if (!this.closed) this.report({ type: "notice", level: "warn", text: failed });
      return;
    } finally {
      if (this.compression === compression) this.compression = null;
      // One Stop let go of ends after its turn: what it wrote is the bridge's own.
      if (compression.turn === null) this.ownTurnEnded = Date.now();
      settle();
    }
    if (!mine()) {
      // Let go of by Stop: what it did is still said.
      if (!this.closed) this.report(compressionOutcome(result));
      return;
    }
    if (result.lock_held === true) {
      this.endTurn({ type: "turn.end", status: "error", error: stringOf(result.message) || "Hermes is already compressing this conversation.", retryable: true });
      return;
    }
    this.report(compressionOutcome(result));
    const usage = usageOf(result.usage);
    this.endTurn({ type: "turn.end", status: "complete", ...(usage ? { usage } : {}) });
  }

  private endTurn(event: Extract<ProviderEvent, { type: "turn.end" }>): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.ownTurnEnded = Date.now();
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    this.streamed = "";
    this.report(event);
  }

  // MARK: From Hermes

  /** An event for this session's runtime id. */
  event(type: string, seq: number | undefined, payload: Frame): void {
    if (this.closed) return;
    if (this.recovering) {
      this.recovering.push({ kind: "event", type, seq, payload });
      return;
    }
    if (seq !== undefined) {
      // The same event again: replayed after a reconnect, or live while it was replayed.
      if (seq <= this.lastSeq) return;
      this.lastSeq = seq;
    }
    if (!this.isAttached) {
      this.held.push({ kind: "event", type, seq, payload });
      return;
    }
    this.handle(type, seq, payload);
  }

  private handle(type: string, _seq: number | undefined, payload: Frame): void {
    const text = typeof payload.text === "string" ? payload.text : "";
    // What Hermes still says of a stopped turn the bridge ended for the app: its end
    // closes it, its own start (one late, as a replay after a reconnect brings it) opens
    // nothing, and the rest of it has no turn to show it in. Another turn's start ends it.
    if (this.abandoned) {
      if (type === "message.complete") {
        this.abandoned = false;
        return;
      }
      if (type === "message.start" && this.abandonedStartDue) {
        this.abandonedStartDue = false;
        return;
      }
      if (type !== "message.start" && abandonedTurnEvents.has(type)) return;
    }
    switch (type) {
      case "message.start":
        // A turn the bridge did not start: one Hermes began by itself, announced or not.
        // Hermes is past the stopped turn the bridge ended for the app.
        this.abandoned = false;
        this.startHeard = true;
        this.starts += 1;
        if (!this.turnOpen) {
          this.openTurn();
          this.streamed = "";
          const host: HostNote = this.announced ? { kind: "process_complete", text: this.announced } : { kind: "hidden", text: "" };
          this.report({ type: "turn.begin", user: "", host });
        }
        this.announced = null;
        this.handedOver = this.turns;
        return;
      case "message.delta":
        this.streamed += text;
        this.report({ type: "text", text });
        return;
      case "message.interim":
        this.streamed = "";
        if (text !== "") this.report({ type: "commentary", text, alreadyStreamed: payload.already_streamed === true });
        return;
      case "reasoning.delta":
        this.report({ type: "reasoning", text });
        return;
      case "thinking.delta":
        this.report({ type: "status", text });
        return;
      case "status.update": {
        const kind = typeof payload.kind === "string" ? payload.kind : "";
        if (kind === "warn" || kind === "error") this.report({ type: "notice", level: kind, text });
        else if ((kind === "process" || kind === "loop") && !this.turnOpen) this.announced = text;
        else this.report({ type: "status", text });
        return;
      }
      case "tool.start": {
        if (typeof payload.tool_id !== "string" || typeof payload.name !== "string") return;
        this.streamed = "";
        const tool = shownTool(payload.name, objectOf(payload.args));
        this.report({ type: "tool.start", id: payload.tool_id, ...tool, ...context(payload) });
        return;
      }
      case "tool.complete": {
        if (typeof payload.tool_id !== "string" || typeof payload.name !== "string") return;
        this.streamed = "";
        const tool = shownTool(payload.name, objectOf(payload.args));
        // A to-do call's args may only change some items (`merge`): Hermes adds the whole list after it.
        if (tool.name === "todo" && Array.isArray(payload.todos)) tool.args = { ...tool.args, todos: payload.todos };
        this.report({
          type: "tool.end",
          id: payload.tool_id,
          ...tool,
          ...context(payload),
          result: payload.result ?? null,
          ...(typeof payload.duration_s === "number" ? { durationSeconds: payload.duration_s } : {}),
          ...(typeof payload.inline_diff === "string" && payload.inline_diff !== "" ? { inlineDiff: payload.inline_diff } : {}),
        });
        return;
      }
      case "request.cancel": {
        const id = typeof payload.id === "string" ? payload.id : null;
        const entry = id ? this.pending.get(id) : undefined;
        if (!entry || !id) return;
        this.pending.delete(id);
        entry.controller.abort(typeof payload.reason === "string" ? cancelReason(payload.reason) : "withdrawn");
        return;
      }
      case "error":
        if (typeof payload.message === "string" && payload.message !== "") this.report({ type: "error", message: payload.message });
        return;
      case "session.title":
        if (this.ongoing) return;
        if (typeof payload.title === "string" && payload.title.trim() !== "") this.report({ type: "title", title: payload.title.trim() });
        return;
      case "session.usage": {
        const usage = usageOf(payload.usage);
        if (usage) this.report({ type: "usage", usage });
        this.noteRest(payload.usage);
        return;
      }
      case "message.complete":
        this.complete(payload);
        return;
      case "session.info": {
        // Not shown; where the session's tokens stand, said at rest or before any call, is kept (feature turn_usage).
        this.noteRest(payload.usage);
        // Its `yolo` changed in another Hermes app (Hermes Desktop's Shift+Tab).
        const before = this.mode().mode;
        this.noteApprovals(payload);
        if (this.mode().mode !== before) this.report({ type: "mode", mode: this.mode().mode });
        return;
      }
      case "subagent.spawn_requested":
      case "subagent.start":
      case "subagent.progress":
      case "subagent.tool":
      case "subagent.complete": {
        const subagent = this.subagents.news(type, payload);
        if (subagent) this.report({ type: "subagent", subagent });
        return;
      }
      case "notification.show":
        this.notify(payload);
        return;
      case "notification.clear": {
        const key = stringOf(payload.key);
        this.notices.delete(key);
        if (key !== "" && key === this.statusNotice) {
          this.statusNotice = null;
          if (this.turnOpen) this.report({ type: "status", text: "" });
        }
        return;
      }
      default:
        // subagent.thinking, tool.generating and the rest: not shown through the bridge (yet).
        this.unknowns.note(type);
        return;
    }
  }

  /**
   * One of Hermes's notices (`notification.show`): a credit warning, low disk, a model it
   * could not switch to, or that its agent is slow to start. That last one (`kind` agent)
   * is the status line while the turn waits for it; the rest are said in the thread, once
   * for each key while their text stays the same.
   */
  private notify(payload: Frame): void {
    const text = noticeText(stringOf(payload.text));
    if (text === "") return;
    const key = stringOf(payload.key) || stringOf(payload.id) || text;
    if (this.notices.get(key) === text) return;
    this.notices.set(key, text);
    if (payload.kind === "agent" && this.turnOpen) {
      this.statusNotice = key;
      this.report({ type: "status", text });
      return;
    }
    const level = payload.level === "error" ? "error" : payload.level === "warn" ? "warn" : "info";
    this.report({ type: "notice", level, text });
  }

  /**
   * What Hermes says of the session's approvals (`session.info`, or the `info` a resume
   * answers with): whether the profile asks for none, and else the session's own `yolo`.
   * A lazily loaded session's says neither.
   */
  private noteApprovals(info: Frame): void {
    if (typeof info.approval_mode === "string") this.approvalsOff = info.approval_mode === "off";
    if (typeof info.yolo === "boolean" && !this.approvalsOff) this.yolo = info.yolo;
  }

  /**
   * Where the session's tokens stand before a turn (feature turn_usage), from a usage block
   * Hermes sent at rest, or before the agent made any call: Hermes counts from its agent's
   * start, so one said mid-turn is not where the turn began.
   */
  private noteRest(value: unknown): void {
    const total = totalOf(value);
    if (total !== null && (!this.turnOpen || (value as Frame).calls === 0)) this.sessionTokens = total;
  }

  private complete(payload: Frame): void {
    if (!this.turnOpen) return;
    // A turn that says no status ended as before Hermes said one; one that says a status the
    // bridge does not know did not surely finish, and is not told as finished.
    const said = payload.status ?? "complete";
    const status = said === "error" || said === "interrupted" || said === "complete" ? said : null;
    const text = typeof payload.text === "string" ? payload.text : "";
    // The whole reply, when it did not come as deltas (a provider that does not stream).
    if (status !== "error" && status !== "interrupted" && text !== "" && this.streamed === "" && payload.response_previewed !== true) {
      this.report({ type: "text", text });
    }
    const usage = usageOf(payload.usage);
    // What the turn spent (feature turn_usage): how far the session's tokens (Hermes's
    // `total`: prompt, its cache in it, and completion) rose in it, once known where they were.
    const total = totalOf(payload.usage);
    const spent = total !== null && this.sessionTokens !== null && total > this.sessionTokens ? { spent: { tokens: total - this.sessionTokens } } : {};
    if (total !== null) this.sessionTokens = total;
    if (status === "error") {
      const surface = payload.error_surface;
      const retryable = typeof surface?.retryable === "boolean" ? surface.retryable : typeof payload.recoverable === "boolean" ? payload.recoverable : true;
      const error = text || (typeof payload.error === "string" ? payload.error : "") || "The request failed.";
      this.endTurn({ type: "turn.end", status, error, retryable, ...(usage ? { usage } : {}), ...spent });
      return;
    }
    if (status === null) {
      this.endTurn({ type: "turn.end", status: "error", error: `Hermes ended the turn in a way Portals does not know ("${String(said)}").`, ...(usage ? { usage } : {}), ...spent });
      return;
    }
    this.endTurn({ type: "turn.end", status, ...(usage ? { usage } : {}), ...spent });
  }

  /** A request from Hermes for this session. */
  request(id: string, method: string, params: Frame): void {
    if (this.closed) return;
    if (this.recovering) {
      this.recovering.push({ kind: "request", id, method, params });
      return;
    }
    if (!this.isAttached) {
      this.held.push({ kind: "request", id, method, params });
      return;
    }
    if (method === "approval" || method === "clarify") {
      const existing = this.pending.get(id);
      if (existing) {
        // Asked again on a new connection: still the same card.
        existing.live = true;
        return;
      }
      void this.ask(id, method, params);
      return;
    }
    if (secretRequests.has(method)) {
      this.host.respond(id, { value: "" });
      this.report({ type: "notice", level: "warn", text: `Hermes asked for a password or a secret, which Portals does not pass on. Give it in a terminal on the ${machineWord()}.` });
      return;
    }
    this.host.respondError(id, -32601, "Not supported by this client");
  }

  private async ask(id: string, method: string, params: Frame): Promise<void> {
    const controller = new AbortController();
    this.pending.set(id, { controller, live: true });
    let answer: RequestAnswer;
    try {
      answer =
        method === "approval"
          ? await this.sink.ask({ kind: "approval", command: stringOf(params.command), ...description(params), choices: choicesOf(params.choices) }, controller.signal)
          : await this.sink.ask({ kind: "clarify", questions: questionsOf(params.questions) }, controller.signal);
    } catch (error) {
      answer = { kind: "withdrawn", reason: (error as Error).message };
    }
    const entry = this.pending.get(id);
    this.pending.delete(id);
    // Hermes withdrew it (request.cancel), or it was answered while the bridge was away.
    if (!entry || controller.signal.aborted) return;
    if (answer.kind === "approval") this.host.respond(id, { choice: answer.choice });
    else if (answer.kind === "clarify") this.host.respond(id, answer.answers ? { answers: answer.answers } : {});
    // Nobody will answer: no, for an approval; a cancelled question.
    else this.host.respond(id, method === "approval" ? { choice: "deny" } : {});
  }

  // MARK: The connection

  /** The connection dropped: Hermes keeps the session (and its questions) for a while. */
  connectionLost(): void {
    this.bound = false;
    this.generation += 1;
    this.clearRetry();
    this.retryDelay = 400;
    this.resuming = null;
    this.recovering = [];
    for (const entry of this.pending.values()) entry.live = false;
  }

  /**
   * The connection is back. Follows the session again; on the same run of Hermes, takes
   * in what it sent meanwhile; otherwise ends a turn that cannot be running any more.
   * Questions nobody will answer any more close.
   */
  async reconnected(sameRun: boolean): Promise<void> {
    if (this.closed) return;
    // An idle thread is followed again when it is next used; one whose stopped turn Hermes
    // may still run (`abandoned`), or with a child still running after its turn ended, is
    // followed now, to hear that turn's or that child's end.
    if (!this.turnOpen && !this.abandoned && this.pending.size === 0 && !this.subagents.anyRunning()) return;
    try {
      await this.resume(sameRun);
    } catch (error) {
      log.warn("could not follow a Hermes thread again", { session: this.id, error: (error as Error).message });
    }
    // Events lost while away: Hermes's stored copy fills the holes, now if the turn has
    // ended, else once Hermes writes it down (`sessions.changed`).
    if (this.gap) this.mayHaveChangedElsewhere();
  }

  private resume(sameRun: boolean): Promise<void> {
    if (this.resuming) return this.resuming;
    this.clearRetry();
    const generation = this.generation;
    const held = this.recovering ??= [];
    const cursor = this.lastSeq;
    const turn = this.turns;
    const starts = this.starts;
    const current = () => !this.closed && this.generation === generation && this.recovering === held;
    const resume = Promise.resolve().then(async () => {
      try {
        const before = this.runtimeID;
        let loaded: Loaded | null = null;
        for (let attempt = 0; ; attempt += 1) {
          if (!current()) return;
          try {
            loaded = await this.host.call<Loaded>("session.resume", { session_id: this.id, profile: this.profile, inline_images: false }, 120_000);
            if (!current()) return;
            break;
          } catch (error) {
            if (!(error instanceof HermesError && error.code === settling && attempt < 5)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
        }
        if (!loaded || typeof loaded.session_id !== "string") throw new Error("Hermes did not say which session it resumed.");
        const sameRuntime = sameRun && loaded.session_id === before;
        if (!sameRuntime) this.lastSeq = 0;
        this.runtimeID = loaded.session_id;
        this.host.bind(this.runtimeID, this);
        this.runtimeGeneration = generation;
        this.bound = true;
        let replay: Frame[] = [];
        let open = loaded.running ? (loaded.open_requests ?? []) : [];
        if (sameRuntime) {
          const since = await this.host.call<{ events?: Frame[]; truncated?: boolean; open_requests?: Loaded["open_requests"] }>("session.events.since", {
            session_id: this.runtimeID,
            last_seen: cursor,
            profile: this.profile,
          });
          if (!current()) return;
          replay = since.events ?? [];
          open = since.open_requests ?? [];
          // Hermes keeps the latest 512 events or 4 MB of a session: older ones are gone.
          if (since.truncated === true) this.gap = true;
        } else {
          // Another run of Hermes, or the session loaded anew: no replay crosses runs.
          if (this.turnOpen && !loaded.running) {
            this.report({ type: "notice", level: "warn", text: "Hermes restarted before it finished this turn. Send a message to go on." });
            this.endTurn({ type: "turn.end", status: "interrupted" });
          }
          // Nor a stopped turn the bridge ended for the app.
          if (!loaded.running) this.abandoned = false;
          // Nor the children the runtime before ran.
          for (const subagent of this.subagents.stopAll()) this.report({ type: "subagent", subagent });
        }
        this.recovering = null;
        for (const event of replay) {
          if (typeof event?.type === "string") this.event(event.type, Number.isInteger(event.seq) ? event.seq : undefined, event.payload ?? {});
        }
        this.settleRequests(open);
        const cancellations = [...replay, ...held.filter((entry) => entry.kind === "event")];
        const cancelled = new Set(cancellations.flatMap((entry) =>
          entry.type === "request.cancel" && typeof entry.payload?.id === "string" ? [entry.payload.id] : []));
        for (const entry of held) {
          if (entry.kind === "event") this.event(entry.type, entry.seq, entry.payload);
          else if (!cancelled.has(entry.id)) this.request(entry.id, entry.method, entry.params);
        }
        // The turn Hermes was given ended among the events it lost: Hermes is at rest, and the
        // turn ends here too, so its stored copy can fill the holes (`changedConversation`).
        // Not one Hermes has not been given yet (a message waiting on this resume), nor a
        // compression, which ends with its own answer. Nor when a turn began since, in the
        // replay or live meanwhile: Hermes is at work on it, and its own end ends the turn (a
        // start of the turn open would have its end in the replay too, which would close it).
        if (sameRuntime && this.gap && !loaded.running && this.turnOpen && this.turns === turn && this.handedOver === turn && this.starts === starts && this.compression === null) {
          this.endTurn({ type: "turn.end", status: "complete" });
        }
        this.retryDelay = 400;
      } catch (error) {
        if (current()) {
          this.bound = false;
          // An RPC timeout need not drop the socket. Keep live frames behind the
          // unapplied cursor and retry even if nobody makes another session call.
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!current()) return;
            void this.resume(sameRun).catch((error) => {
              log.warn("could not follow a Hermes thread again", { session: this.id, error: (error as Error).message });
            });
          }, this.retryDelay);
          this.retryTimer.unref();
          this.retryDelay = Math.min(this.retryDelay * 2, 5_000);
        }
        throw error;
      } finally {
        if (this.resuming === resume) this.resuming = null;
      }
    });
    this.resuming = resume;
    return resume;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** The questions Hermes still has open: the rest close, as answered elsewhere; new ones are asked. */
  private settleRequests(open: { id: string; method: string; params: Frame }[]): void {
    const ids = new Set(open.map((request) => request.id));
    for (const [id, entry] of [...this.pending]) {
      if (ids.has(id)) {
        entry.live = true;
        continue;
      }
      this.pending.delete(id);
      entry.controller.abort("resolved");
    }
    for (const request of open) {
      if (!this.pending.has(request.id) && typeof request.method === "string") this.request(request.id, request.method, request.params ?? {});
    }
  }

  /**
   * Calls a method for this session, by its runtime id. A session Hermes has unloaded
   * meanwhile (4001), or one not followed since a reconnect, is resumed first.
   */
  private async call<T = any>(method: string, params: Frame, timeoutMs?: number): Promise<T> {
    if (this.closed) throw new Error("The Hermes thread was closed.");
    // A confirmed binding on this connection lets Stop through without waiting
    // for history catch-up; a cached runtime id from a dropped connection does not.
    if (!this.bound && !(method === "session.interrupt" && this.runtimeGeneration === this.generation)) await this.resume(true);
    if (this.closed) throw new Error("The Hermes thread was closed.");
    const send = () => this.host.call<T>(method, { session_id: this.runtimeID, ...params, profile: this.profile }, timeoutMs);
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof HermesError && error.code === notLoaded)) throw error;
      await this.resume(false);
      return send();
    }
  }

  private report(event: ProviderEvent): void {
    try {
      this.sink.emit(event);
    } catch (error) {
      log.warn("a Hermes event could not be passed on", { session: this.id, type: event.type, error: (error as Error).message });
    }
  }
}

// MARK: Shapes

/**
 * Hermes's stored messages, as the app reads them: they are already in the shape
 * `session.resume` returns (docs/gateway-protocol.md, section 8), richer keys
 * (`display_content`, `display_commentary`, …) included, so they pass as they are.
 * Only roles the app reads are kept, a user message Hermes stored in place of a command
 * reads as the user typed it (`typed`, by the stored row's id), and tool calls go by the names the app knows
 * (`shownTool`), each to-do call with the whole list as it stood after it. A batch of
 * several calls Hermes keeps as one `tool_call` stays as it is, with its result, and each
 * to-do call in it follows it as a `todo` row of its own.
 */
export function storedMessages(messages: unknown[], typed: ReadonlyMap<number, string> = new Map()): StoredMessage[] {
  let todos: unknown[] | null = null;
  return messages
    .filter(
      (message): message is StoredMessage =>
        typeof message === "object" && message !== null && ["user", "assistant", "tool", "compaction"].includes((message as Frame).role),
    )
    .flatMap((message): StoredMessage[] => {
      const row = (message as Frame).row_id;
      if (message.role === "user" && typeof row === "number" && typed.has(row)) return [{ ...message, text: typed.get(row)! }];
      if (message.role !== "tool" || typeof message.name !== "string") return [message];
      const tool = shownTool(message.name, objectOf(message.args));
      if (tool.name === "todo") {
        todos = todoList(tool.args, todos);
        if (todos) tool.args = { ...tool.args, todos };
      }
      if (tool.name === "tool_call") {
        const plans = callsThrough(tool.args).flatMap((call, index): StoredMessage[] => {
          if (!call || (formerToolNames[call.name] ?? call.name) !== "todo") return [];
          todos = todoList(call.args, todos);
          const args = todos ? { ...call.args, todos } : call.args;
          return [{ role: "tool", name: "todo", args, tool_call_id: `${message.tool_call_id}:${index}`, timestamp: message.timestamp }];
        });
        return [message, ...plans];
      }
      return [tool.name === message.name && tool.args === message.args ? message : { ...message, ...tool }];
    });
}

/**
 * Hermes's tools the app knows by the names they had before Hermes 0.22.0 renamed them:
 * its to-do list, shown as a plan, and its background processes, as a terminal's.
 */
const formerToolNames: Record<string, string> = { todo_list: "todo", process_manage: "process" };

/**
 * A tool call as the app shows it (docs/gateway-protocol.md, section 9). One made through
 * Hermes's `tool_call`, how a model calls a tool Hermes loads only when asked (`todo_list`
 * and `process_manage` by default), is the tool it called: Hermes's live events name that
 * one, but its stored copy keeps `tool_call`. A renamed tool goes by its former name.
 */
export function shownTool(name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  const called = name === "tool_call" ? calledThrough(args) : null;
  const tool = called ?? { name, args };
  return { name: formerToolNames[tool.name] ?? tool.name, args: tool.args };
}

/** The one tool a `tool_call` called (`callsThrough`); null for a batch of several, or one it cannot read. */
function calledThrough(args: Record<string, unknown>): { name: string; args: Record<string, unknown> } | null {
  const calls = callsThrough(args);
  return calls.length === 1 ? calls[0] : null;
}

/**
 * The tools a `tool_call` called, read as Hermes reads it: `calls` (a list, or the list as
 * JSON text), or the older `name` and `arguments`. Null for an entry it cannot read.
 */
function callsThrough(args: Record<string, unknown>): ({ name: string; args: Record<string, unknown> } | null)[] {
  let calls: unknown = args.calls ?? (typeof args.name === "string" ? [{ name: args.name, arguments: args.arguments }] : null);
  if (typeof calls === "string") calls = parsed(calls);
  return (Array.isArray(calls) ? calls : [calls]).map((entry) => {
    const call = objectOf(entry);
    const name = typeof call.name === "string" ? call.name.trim() : "";
    if (name === "") return null;
    return { name, args: objectOf(typeof call.arguments === "string" ? parsed(call.arguments) : call.arguments) };
  });
}

/**
 * The whole to-do list after a `todo` call, as Hermes keeps it: the list given; with
 * `merge`, the list `before` with the items given changed or added by their `id`; the
 * list `before` for a call that gives none, which only reads it. `before` is null when
 * no call before said.
 */
function todoList(args: Record<string, unknown>, before: unknown[] | null): unknown[] | null {
  if (!Array.isArray(args.todos)) return before;
  if (args.merge !== true || !before) return args.todos;
  const list = before.map((item) => ({ ...objectOf(item) }));
  for (const item of args.todos.map(objectOf)) {
    if (typeof item.id !== "string" || item.id === "") continue;
    const known = list.find((entry) => entry.id === item.id);
    if (!known) list.push(item);
    // Only what the item gives changes, as in Hermes.
    else for (const [key, value] of Object.entries(item)) if (value !== undefined && value !== "") known[key] = value;
  }
  return list;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Whether Hermes's stored copy `now` is the copy last read (`before`) with only messages
 * of the bridge's own after it: its user messages each one the bridge gave Hermes since
 * (`unwritten`, in order, some perhaps never written), the first new message among them,
 * and the rest what those turns said. `written` is how many of `unwritten` it holds.
 */
function ownWrites(before: readonly StoredMessage[], now: readonly StoredMessage[], unwritten: readonly string[]): { only: boolean; written: number } {
  let written = 0;
  let only = now.length >= before.length && before.every((message, index) => sameMessage(message, now[index]));
  for (const [index, message] of now.slice(before.length).entries()) {
    if (message.role !== "user") {
      // A reply, a tool call or a compaction with none of the bridge's messages before it is another app's.
      if (index === 0) only = false;
      continue;
    }
    const at = unwritten.findIndex((text, place) => place >= written && text.trim() === message.text.trim());
    if (at < 0) only = false;
    else written = at + 1;
  }
  return { only, written };
}

/** Whether two stored messages are the same one, as far as the store's copy says. */
function sameMessage(a: StoredMessage, b: StoredMessage | undefined): boolean {
  if (!b || a.role !== b.role) return false;
  if ((a.role === "user" || a.role === "assistant") && (b.role === "user" || b.role === "assistant")) return a.text === b.text;
  if (a.role === "tool" && b.role === "tool") return a.tool_call_id === b.tool_call_id;
  return a.timestamp === b.timestamp;
}

/** What Hermes's answer to `session.compress` comes to: the conversation compacted, or what Hermes said of leaving it as it was. */
function compressionOutcome(result: Frame): ProviderEvent {
  const summary = objectOf(result.summary);
  if (result.status === "compressed" && summary.noop !== true) {
    const before = result.before_tokens;
    return { type: "compacted", trigger: "manual", ...(Number.isInteger(before) && (before as number) > 0 ? { tokensBefore: before as number } : {}) };
  }
  if (result.lock_held === true) return { type: "notice", level: "info", text: stringOf(result.message) || "Hermes is already compressing this conversation." };
  const said = [summary.headline, summary.token_line, summary.note].filter((line): line is string => typeof line === "string" && line.trim() !== "");
  const fallback = result.status === "pending" ? "Hermes is compressing the conversation." : "Hermes left the conversation as it was.";
  return { type: "notice", level: "info", text: said.length > 0 ? said.join("\n") : fallback };
}

/** The command a message is and what follows it, for a message that is one; null for any other. One with images or files is words, as for the session (`isCommand`). */
function isCommandOf(prompt: Prompt): { name: string; argument: string } | null {
  if (prompt.images.length > 0 || (prompt.files?.length ?? 0) > 0) return null;
  const match = commandLine.exec(prompt.text.trim());
  return match ? { name: match[1].toLowerCase(), argument: (match[2] ?? "").trim() } : null;
}

/** What to keep in focus, for a message that is `/compress` (or `/compact`); null for any other. One with images or files is words, as for the session (`isCommand`). */
function compressFocus(prompt: Prompt): string | null {
  if (prompt.images.length > 0 || (prompt.files?.length ?? 0) > 0) return null;
  const match = compressLine.exec(prompt.text.trim());
  return match ? (match[1] ?? "").trim() : null;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A notice of Hermes's in the app's words: without the mark in front of it (its level
 * says as much), and without the parts after a `·` that name a command to type in
 * Hermes's own apps ("· run /topup to top up"), which Portals does not offer.
 */
export function noticeText(text: string): string {
  const parts = text.replace(/^[\s\u2190-\u2BFF\uFE0F]+/u, "").split(" · ");
  return parts.filter((part, index) => index === 0 || !/(^|\s)\/[a-z]/i.test(part)).join(" · ").trim();
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function context(payload: Frame): { context?: string } {
  return typeof payload.context === "string" && payload.context !== "" ? { context: payload.context } : {};
}

function description(params: Frame): { description?: string } {
  return typeof params.description === "string" && params.description.trim() !== "" ? { description: params.description } : {};
}

function choicesOf(value: unknown): ApprovalChoice[] {
  const given = Array.isArray(value) ? value.filter((choice): choice is ApprovalChoice => approvalChoices.includes(choice as ApprovalChoice)) : [];
  return given.length > 0 ? given : ["once", "deny"];
}

function questionsOf(value: unknown): ClarifyQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ClarifyQuestion[] => {
    if (typeof entry?.qid !== "string" || typeof entry.question !== "string") return [];
    const choices = Array.isArray(entry.choices) ? entry.choices.filter((choice: unknown): choice is string => typeof choice === "string") : [];
    return [{ qid: entry.qid, question: entry.question, choices, multiSelect: entry.multi_select === true }];
  });
}

/** The session's tokens so far in a Hermes usage block (`total`), or null. */
function totalOf(value: unknown): number | null {
  const total = (value as Frame | undefined)?.total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null;
}

function usageOf(value: unknown): ContextUsage | null {
  const used = (value as Frame | undefined)?.context_used;
  const max = (value as Frame | undefined)?.context_max;
  return Number.isInteger(used) && Number.isInteger(max) && used > 0 && max > 0 ? { used, max } : null;
}

/** Hermes's reason for withdrawing a question, as the bridge passes it to the app. */
function cancelReason(reason: string): string {
  return ["resolved", "timeout", "interrupted", "interrupt"].includes(reason) ? (reason === "interrupt" ? "interrupted" : reason) : "withdrawn";
}
