import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "../../log.ts";
import { threadIDPattern } from "../../sessions/registry.ts";
import { storedUserText, Transcript } from "../../sessions/transcript.ts";
import { AcpError, AgentStopped, type AcpClient } from "../acp/client.ts";
import { agentsChoice, currentValue } from "../acp/models.ts";
import { promptTokens } from "../acp/protocol.ts";
import {
  authRequiredCode,
  type ConfigOption,
  type ContentBlock,
  type InitializeResult,
  type PermissionRequest,
  type PromptResult,
  type RpcId,
  type SessionState,
  type SessionUpdate,
} from "../acp/protocol.ts";
import { AcpStream } from "../acp/stream.ts";
import { gatewayTool, merged, type OwnTools } from "../acp/tools.ts";
import { imageType, skippedImagesText } from "../images.ts";
import { titleFrom } from "../titles.ts";
import {
  SettingRefused,
  type ModelChangeResult,
  type ModeState,
  type Prompt,
  type ProviderEvent,
  type ProviderSession,
  type SessionOptions,
  type SessionSettings,
  type SessionSink,
  type StoredMessage,
  type SubagentInfo,
  type ThreadMode,
} from "../types.ts";
import { cursorID, levelAt, levelSetting, levelsOf, modelAt, type CursorModel } from "./models.ts";
import { cursorMode, cursorName, cursorQuirks, goAheadText, leftFullAccessText, levelLeftToCursorText, noSuchModeText, notSignedInText, portalsNote, runsEverything, signInReply, turnFailure } from "./options.ts";
import { askQuestion, createPlan, mergedTodos, permissionCard, permissionOutcome, planCard, planOutcome, questionCard, questionOutcome, todoRow, unplacedAnswer, updateTodos, type Todo } from "./requests.ts";
import { CursorSubagents } from "./subagents.ts";
import { cursorTools } from "./tools.ts";

// One thread of Cursor's. Its id is the id of the Cursor session it was made with
// (`session/new`); the session it talks to now is `sessionID`, which differs only once
// Cursor no longer had the first.
//
// - The conversation as the app shows it is the bridge's, in a file of the thread's
//   own: opening an old thread starts nothing. Cursor can send a session's conversation
//   again, but what it sends differs from what it said the first time, so it is never
//   read back; the file is written when a turn starts, after each tool row and when the
//   turn ends, and a bridge killed mid-turn keeps the message and the rows up to then.
//   The file says while a turn is open; the bridge that next reads it so ends that turn
//   as interrupted (Cursor's process it has ended by then: ./leftovers.ts).
// - Cursor's process may have stopped since the thread last ran (it stops when idle,
//   and with the bridge). The thread's next message starts it and has it take the
//   session up (`session/load`, whose replay of the conversation is let pass). A session
//   Cursor does not have gets a new one in its place.
// - A turn is one `session/prompt`, answered when the turn is over; what happens in it
//   comes as `session/update` notifications (../acp/stream.ts). Before it go the
//   thread's mode and, for a thread that chose one, its model and thinking level: all in
//   the process's one queue, since the model is the process's and not the session's.
// - A message sent meanwhile waits for the turn to end, in the bridge: Cursor has no way
//   to add one to a running turn, and a second prompt would cancel the first.
// - Cursor's questions become cards (./requests.ts).
// - Its subagents are on the subagents line (./subagents.ts): their updates come under
//   sessions of their own, which the provider brings here (`subagentUpdate`).
// - Cursor is told of the `portals` command once, in a note beside the thread's first
//   message (./options.ts): its ACP has no place for a client's instructions.

/** One run of Cursor, which the threads of a folder share: those in Full access one of their own, run with `--force`. */
export interface CursorProcess {
  readonly client: AcpClient;
  /** Run with `--force`, Cursor's Run Everything, for threads in Full access. */
  readonly forced: boolean;
  readonly info: InitializeResult;
  /** Cursor's sessions this run has: made in it, or loaded. */
  readonly loaded: Set<string>;
  /**
   * The model Cursor is on and that model's settings, as it last said. They are the
   * process's and not a session's: any thread in the folder may have changed them.
   */
  readonly current: ConfigOption[] | null;
  /** Takes what Cursor said a session can be set to (`configOptions`). */
  learn(options: unknown): void;
  /**
   * Runs one thing at a time of what touches Cursor's shared state: a new session, a
   * load, and "set this thread's model, then send its prompt". Cursor's first calls
   * must not overlap, and a turn must start on the model set for it.
   */
  exclusive<T>(task: () => Promise<T>): Promise<T>;
  /** It was used just now. */
  touch(): void;
}

/** What is kept of a thread, in a file of its own. */
export interface KeptThread {
  /** The conversation as the app shows it. */
  messages: StoredMessage[];
  /** The thread's Cursor session, when that is not its id. */
  session?: string;
  /** Cursor got the note on the `portals` command for this thread. */
  told?: boolean;
  /** The thread's to-do list as Cursor last had it, when it has one: Cursor sends only the items that change. */
  todos?: Todo[];
  /** A turn is open. A bridge that reads the file so was not the one that wrote it: that one was killed in the turn. */
  open?: boolean;
  /** The thread's folder, for a fork of it or its return to the list when Cursor keeps no session of it. */
  cwd?: string;
}

/** What a session needs from its provider. */
export interface CursorHost {
  /** How long Cursor has to end a turn it was asked to stop, before the turn is ended for the app. */
  readonly interruptGraceMs: number;
  /** What a thread's first message tells Cursor of the `portals` command; null when agents are not told. */
  readonly note: string | null;
  /** Cursor's process for threads in `cwd` (`forced`: for those in Full access), started when none runs. */
  process(cwd: string, forced?: boolean): Promise<CursorProcess>;
  /** One of Cursor's models, as it last listed them. */
  model(id: string): CursorModel | undefined;
  /** Cursor has listed its models at some time. */
  modelsKnown(): boolean;
  /** Keeps a thread: its conversation, its Cursor session when that is not the thread's id, whether Cursor was told of `portals`, and its to-do list. */
  save(id: string, kept: KeptThread): void;
  /** The thread talks to another Cursor session from now on. */
  rerouted(session: CursorSession, from: string, to: string): void;
  /**
   * `process` is of no more use to `session`: Cursor does not answer a prompt it was
   * asked to stop, or says it is not signed in. Stopped now when no other thread is at
   * work on it, so that the next message starts another.
   */
  release(process: CursorProcess, session: CursorSession | null, why: string): void;
  /** `session` moved to its folder's other process: the one it left is stopped when no other thread is on it. */
  left(process: CursorProcess, session: CursorSession): void;
  forget(session: CursorSession): void;
}

export interface SessionStart {
  /** The run of Cursor that has the session, when one does. */
  process: CursorProcess | null;
  /** The conversation so far, as kept. */
  stored: StoredMessage[];
  /** Cursor's session for the thread. */
  session: string;
  /** Cursor's session got the note on the `portals` command. */
  told: boolean;
  /** The thread's to-do list, as kept. */
  todos: Todo[];
  /** The conversation was kept with a turn open: the bridge was killed in it. */
  cut: boolean;
}

/** Cursor is not signed in (-32000). */
export class NotSignedIn extends Error {
  constructor() {
    super(notSignedInText);
  }
}

const newSessionTimeoutMs = 120_000;
const loadTimeoutMs = 180_000;
/** Cursor has no such session, or was given a value it has not. */
const invalidParamsCode = -32602;
const cancelled = { outcome: { outcome: "cancelled" } } as const;

type TurnEnd = Extract<ProviderEvent, { type: "turn.end" }>;

/** What Cursor's error says, with what it added: often the reason is only there. */
export function errorText(error: unknown): string {
  if (!(error instanceof AcpError)) return (error as Error)?.message || "Something went wrong.";
  const data = error.data as { details?: unknown; message?: unknown } | string | null | undefined;
  const detail = typeof data === "string" ? data : typeof data?.details === "string" ? data.details : typeof data?.message === "string" ? data.message : "";
  return detail && detail !== error.message ? `${error.message} (${detail})` : error.message;
}

/** Asks Cursor for a new session in `cwd`, and returns it with its id checked. */
export async function newSession(process: CursorProcess, cwd: string): Promise<SessionState & { sessionId: string }> {
  let state: SessionState | null;
  try {
    state = await process.client.call<SessionState | null>("session/new", { cwd, mcpServers: [] }, newSessionTimeoutMs);
  } catch (error) {
    if (error instanceof AcpError && error.code === authRequiredCode) throw new NotSignedIn();
    if (error instanceof AgentStopped) throw error;
    throw new Error(`${cursorName} could not start a session: ${errorText(error)}`);
  }
  const id = state?.sessionId;
  if (typeof id !== "string" || !threadIDPattern.test(id)) throw new Error(`${cursorName} gave the session an id Portals cannot keep.`);
  process.loaded.add(id);
  process.learn(state?.configOptions);
  return { ...state, sessionId: id };
}

export class CursorSession implements ProviderSession {
  readonly id: string;
  readonly cwd: string;
  private readonly sink: SessionSink;
  private readonly host: CursorHost;
  private readonly stream: AcpStream;
  private readonly transcript: Transcript;
  /** Cursor's session for the thread: the thread's id, until Cursor had it no more. */
  private sessionID: string;
  /** What the app chose for the thread: `default` leaves the model to Cursor. */
  private current: SessionSettings;
  /** The thread's mode, which is the bridge's: sent before every turn, and never read back. */
  private threadMode: ThreadMode;
  /** The run of Cursor the thread last ran on; a stopped one counts for nothing. */
  private process: CursorProcess | null;
  /**
   * Cursor has had the thread's session on a run with `--force`, and so keeps Run
   * Everything in it (`leftFullAccessText`): in this run of the bridge, or, for a thread
   * that comes up in Full access with a conversation, most likely in an earlier one.
   */
  private ranEverything: boolean;
  private loading: Promise<CursorProcess> | null = null;
  /** Cursor is sending the conversation again (`session/load`): it is already kept. */
  private replaying = false;
  private title: string | null;
  /** The title is the user's, or was settled in an earlier run: Cursor's later ones are not taken. */
  private titleFixed: boolean;
  private turnOpen = false;
  /** Counts turns, so what a turn's end finds is that turn. */
  private turn = 0;
  /** A `session/prompt` is out for the open turn. */
  private prompted = false;
  /** Prompts Cursor has not answered yet, also those of a turn that was ended for the app. */
  private unanswered = 0;
  private interruptRequested = false;
  private interruptTimer: NodeJS.Timeout | null = null;
  /** A plan was accepted in the open turn: when Cursor ends its turn there, it is told to go ahead. */
  private goAhead = false;
  /** The last piece of reply in the open turn. */
  private lastPiece = "";
  /**
   * A piece of reply that reads as Cursor telling of a turn it could not finish
   * (`turnFailure`), held back: the turn ends failed with it when nothing comes after it,
   * and it is shown as reply after all when something does.
   */
  private held: SessionUpdate | null = null;
  /** The cards open. */
  private readonly asking = new Set<AbortController>();
  /** The subagent each of the open cards is of, when it is one's: withdrawn when it ends. */
  private readonly askedBy = new Map<AbortController, string>();
  /** The thread's to-do list, which Cursor sends whole once and then as the items that changed. Kept with the thread. */
  private todos: Todo[];
  /** What the user answered each question with, by the question's tool call. */
  private readonly answers = new Map<string, string[]>();
  /** Cursor's session for the thread got the note on the `portals` command. */
  private told: boolean;
  /** The subagents Cursor has told of in this run of the thread. */
  private readonly subagents: CursorSubagents;
  /** What is Cursor's own of its tools (./tools.ts). */
  private readonly own: OwnTools;

  constructor(options: SessionOptions, sink: SessionSink, host: CursorHost, start: SessionStart) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.sink = sink;
    this.host = host;
    this.own = cursorTools(this.answers);
    this.stream = new AcpStream({ cwd: options.cwd, quirks: { ...cursorQuirks, own: this.own }, progress: (event) => this.sink.emit(event) });
    this.subagents = new CursorSubagents(this.own);
    this.transcript = new Transcript(start.stored);
    this.sessionID = start.session;
    this.current = { ...options.settings };
    // A mode Cursor has none for cannot have been kept; a thread from before is in its own.
    this.threadMode = options.mode && cursorMode(options.mode) ? options.mode : "default";
    this.process = start.process;
    this.ranEverything = start.process?.forced === true || (this.threadMode === "full" && start.stored.length > 0);
    this.title = options.title ?? null;
    this.titleFixed = this.title !== null;
    this.told = start.told;
    this.todos = start.todos;
    // The turn a killed bridge left open is over, and nobody ended it: what was said is kept, marked as interrupted.
    if (start.cut) {
      this.transcript.apply({ type: "turn.end", status: "interrupted" });
      this.save();
    }
  }

  /** A turn runs, a card is open, or the session is being loaded: its process is not to be stopped. */
  get busy(): boolean {
    return this.turnOpen || this.asking.size > 0 || this.loading !== null;
  }

  /** A request of Cursor's can be shown in the thread now. */
  get takesRequests(): boolean {
    return this.turnOpen && !this.replaying;
  }

  /**
   * Whether a subagent told of now, by the thread (`from` null) or by one of its
   * subagents, goes on the line: only in a turn, whose end ends any that Cursor says no
   * end of, and not one of a subagent that has ended.
   */
  takesSpawn(from: string | null): boolean {
    return this.turnOpen && !this.replaying && (from === null || this.subagents.running(from));
  }

  /** Cursor is sending the thread's conversation again. */
  get isReplaying(): boolean {
    return this.replaying;
  }

  /** Cursor owes the answer to a prompt of a turn that is over for the app. */
  get isStuck(): boolean {
    return this.unanswered > 0 && !this.turnOpen;
  }

  /** The thread runs on Cursor's process with `--force` (Full access): from its next turn, once its mode is changed. */
  get runsForced(): boolean {
    return runsEverything(this.threadMode);
  }

  /** Whether `process` is the run of Cursor this thread is on. */
  isOn(process: CursorProcess): boolean {
    return this.process === process;
  }

  // MARK: ProviderSession

  async history(): Promise<StoredMessage[]> {
    // A copy: the bridge keeps its own from here on.
    return structuredClone(this.transcript.messages);
  }

  settings(): SessionSettings {
    const model = this.host.model(this.current.model);
    const chosen = levelSetting(model, this.current.reasoningEffort)?.level;
    if (chosen) return { ...this.current, reasoningEffort: chosen };
    // None chosen, or none this model takes: the level Cursor is at, when its process is on the thread's model.
    const options = this.process?.client.isRunning ? this.process.current : null;
    const at = this.current.model !== agentsChoice && modelAt(options) === this.current.model ? levelAt(model, options) : "";
    return { ...this.current, reasoningEffort: at };
  }

  startTurn(prompt: Prompt): void {
    if (this.turnOpen) throw new Error(`${cursorName} is already running a turn.`);
    this.turnOpen = true;
    this.prompted = false;
    this.goAhead = false;
    this.interruptRequested = false;
    this.lastPiece = "";
    this.held = null;
    const turn = ++this.turn;
    const before = this.transcript.messages.length;
    this.transcript.startTurn(storedUserText(prompt));
    this.save();
    // `run` ends the turn whatever happens; this is for what went wrong while it did.
    this.run(prompt, turn, before > 0).catch((error: Error) => log.error(`a ${cursorName} turn did not end cleanly`, { thread: this.id, error: error.stack ?? String(error) }));
  }

  async interrupt(): Promise<boolean> {
    if (!this.turnOpen) return false;
    const turn = this.turn;
    this.interruptRequested = true;
    // The cards close first; each then answers Cursor `cancelled`, as the protocol asks
    // (those answers go out after the cancel below; Cursor takes them in either order).
    for (const controller of this.asking) controller.abort("interrupted");
    // Cursor's process is still starting, or the session loading: nothing was sent, so nothing has to be stopped.
    if (!this.prompted) {
      this.end({ type: "turn.end", status: "interrupted" }, turn);
      return true;
    }
    const process = this.process;
    if (process?.client.isRunning) process.client.notify("session/cancel", { sessionId: this.sessionID });
    // Cursor answers a cancel within milliseconds. A turn it has not ended after the
    // grace time is ended here, for the app; Cursor still owes the prompt's answer
    // (`stopping`), and a process nothing else is at work on is stopped.
    this.interruptTimer ??= setTimeout(() => {
      this.interruptTimer = null;
      if (!this.isTurn(turn)) return;
      this.end({ type: "turn.end", status: "interrupted" }, turn);
      if (process) this.host.release(process, this, "did not end a turn it was asked to stop");
    }, this.host.interruptGraceMs);
    this.interruptTimer.unref();
    return true;
  }

  /** True while Cursor has not answered the prompt of a turn the grace timer ended: it may still be at it. */
  async stopping(): Promise<boolean> {
    return this.unanswered > 0;
  }

  async setModel(model: string, provider: string): Promise<ModelChangeResult> {
    this.current = { ...this.current, model, provider };
    // Cursor is set to it before the thread's next turn.
    return { deferred: this.turnOpen };
  }

  /**
   * Kept, and set before the thread's next turn as the nearest level its model has. A
   * level that could never be set is refused with why, since the app offers every level
   * for a model that lists none: for a thread on `default`, and for a model with no levels.
   */
  async setReasoning(level: string): Promise<void> {
    if (level !== "") {
      if (this.current.model === agentsChoice) throw new SettingRefused(levelLeftToCursorText);
      const model = this.host.model(this.current.model);
      if (model && !model.unknown && levelsOf(model).length === 0) throw new SettingRefused(`${cursorName} has no thinking levels for ${model.name}.`);
    }
    this.current = { ...this.current, reasoningEffort: level };
  }

  mode(): ModeState {
    return { mode: this.threadMode };
  }

  /** Cursor reads the mode as it takes a prompt, so it is only kept here, and goes with the thread's next message. */
  async setMode(mode: ThreadMode): Promise<void> {
    if (cursorMode(mode) === null) throw new SettingRefused(noSuchModeText);
    if (this.threadMode === "full" && mode !== "full" && this.ranEverything) this.sink.emit({ type: "notice", level: "warn", text: leftFullAccessText });
    this.threadMode = mode;
  }

  /** Cursor has no call to name a session: the title is the bridge's, and stays the user's. */
  async rename(title: string): Promise<void> {
    this.title = title;
    this.titleFixed = true;
  }

  async close(): Promise<void> {
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    for (const controller of this.asking) controller.abort("withdrawn");
    if (this.turnOpen) {
      // The bridge is stopping mid-turn. What was said so far is kept, marked as
      // interrupted; nobody is told, since the thread's own session is going too.
      if (this.prompted && this.process?.client.isRunning) this.process.client.notify("session/cancel", { sessionId: this.sessionID });
      this.turnOpen = false;
      for (const closing of this.stream.endTurn()) this.transcript.apply(closing);
      this.transcript.apply({ type: "turn.end", status: "interrupted" });
    }
    this.save();
    this.host.forget(this);
  }

  // MARK: Turns

  private isTurn(turn: number): boolean {
    return this.turnOpen && this.turn === turn;
  }

  private async run(prompt: Prompt, turn: number, hadConversation: boolean): Promise<void> {
    if (this.title === null) this.titled(titleFrom(prompt.text), true);
    try {
      const process = await this.ready(hadConversation);
      // Cursor is told of the `portals` command once for a thread, beside its first message.
      let noted = false;
      let result = await this.prompt(
        process,
        () => {
          const blocks = this.content(prompt, process);
          noted = !this.told && this.host.note !== null;
          return noted ? [...blocks, portalsNote(this.host.note!)] : blocks;
        },
        turn,
      );
      // Kept once Cursor has answered that prompt, so a bridge restart does not send the
      // note again, and a first turn that failed does.
      if (result && noted && !(this.isTurn(turn) && this.signInGone())) {
        this.told = true;
        this.save();
      }
      // Start on a plan card: Cursor ends its turn once a plan is accepted, and waits
      // for a message. The go-ahead is that message, sent in the same turn.
      // What the turn spent, where Cursor says (feature turn_usage): every prompt of it.
      let tokens = promptTokens(result);
      while (result && this.isTurn(turn) && this.goAhead && !this.interruptRequested && result.stopReason !== "cancelled") {
        this.goAhead = false;
        result = await this.prompt(process, () => [{ type: "text", text: goAheadText }], turn);
        tokens += promptTokens(result);
      }
      // Not sent: the turn ended first (a stop while Cursor was starting). Answered late:
      // the turn was ended for the app meanwhile, and this answer ends nothing.
      if (result && this.isTurn(turn)) {
        const ending = this.ending(result.stopReason, process);
        this.end(tokens > 0 ? { ...ending, spent: { tokens } } : ending, turn);
      }
    } catch (error) {
      // A process that is not signed in stays so: the next message starts another, which sees a sign-in made meanwhile.
      if (error instanceof NotSignedIn && this.process) this.host.release(this.process, this, "is not signed in");
      if (this.interruptRequested && !(error instanceof AgentStopped)) {
        this.end({ type: "turn.end", status: "interrupted" }, turn);
        return;
      }
      this.end({ type: "turn.end", status: "error", error: this.failure(error), retryable: true }, turn);
    }
  }

  /**
   * Sends one prompt and waits for Cursor's answer to it. The thread's mode, model and
   * level are set first, and nothing else that touches Cursor's shared state comes
   * between them and the prompt. Null when the turn ended before the prompt went.
   */
  private async prompt(process: CursorProcess, blocks: () => ContentBlock[], turn: number): Promise<PromptResult | null> {
    const sent = await process.exclusive(async () => {
      if (!this.isTurn(turn)) return null;
      await this.sendMode(process);
      await this.apply(process);
      if (!this.isTurn(turn)) return null;
      if (process.forced !== this.runsForced) {
        throw new Error("Cursor's access mode changed while the turn was starting, so the message was not sent. Send it again.");
      }
      const prompt = blocks();
      this.prompted = true;
      this.unanswered += 1;
      process.touch();
      // Not waited for here: the turn's answer comes when the turn is over.
      const answer = process.client.call<PromptResult | null>("session/prompt", { sessionId: this.sessionID, prompt }, 0).finally(() => {
        this.unanswered -= 1;
      });
      return { answer };
    });
    if (!sent) return null;
    const result = await sent.answer;
    if (this.isTurn(turn)) this.prompted = false;
    process.touch();
    return result ?? {};
  }

  /** Why a turn failed, as a sentence for the thread. */
  private failure(error: unknown): string {
    if (error instanceof NotSignedIn) return error.message;
    // The thread's next message starts Cursor again; nothing has to be done first.
    if (error instanceof AgentStopped) return `${error.message}. Send the message again to start it.`;
    if (error instanceof AcpError) return `${cursorName} stopped the turn: ${errorText(error)}`;
    return (error as Error)?.message || `${cursorName} stopped the turn.`;
  }

  /**
   * How the turn ended, from why Cursor says it stopped. It only ever says `end_turn`
   * or `cancelled`: a turn it could not finish ends complete, with what went wrong as
   * text. The one such text acted on is that it is not signed in.
   */
  private ending(stopReason: string | undefined, process: CursorProcess): TurnEnd {
    const usage = this.stream.usage ? { usage: this.stream.usage } : {};
    if (this.interruptRequested || stopReason === "cancelled") return { type: "turn.end", status: "interrupted", ...usage };
    if (this.signInGone()) {
      // A process that lost its sign-in does not get it back: the next message starts another.
      this.held = null;
      this.host.release(process, this, "is not signed in");
      return { type: "turn.end", status: "error", error: notSignedInText, retryable: true };
    }
    const failure = this.failedAs();
    if (failure !== null) {
      this.held = null;
      return { type: "turn.end", status: "error", error: failure, retryable: true, ...usage };
    }
    return { type: "turn.end", status: "complete", ...usage };
  }

  /** The open turn's reply ended with Cursor saying its sign-in has gone: the model never ran. */
  private signInGone(): boolean {
    const held = this.heldText();
    return (held ?? this.lastPiece).trim() === signInReply;
  }

  /** Why the open turn failed, as Cursor said it as the turn's last piece of reply; null when it did not. */
  private failedAs(): string | null {
    const held = this.heldText();
    const said = held === null ? null : turnFailure(held);
    if (said === null) return null;
    return said.endsWith("to continue") ? `${cursorName}: ${said}.` : `${cursorName} stopped the turn: ${said}`;
  }

  private heldText(): string | null {
    const content = this.held?.sessionUpdate === "agent_message_chunk" ? this.held.content : undefined;
    return content?.type === "text" && typeof content.text === "string" ? content.text : null;
  }

  /** Shows a held piece of reply as reply: something came after it, or the turn ended otherwise. */
  private release(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    for (const event of this.stream.map(held)) this.emit(event);
  }

  private end(event: TurnEnd, turn: number): void {
    if (!this.isTurn(turn)) return;
    this.turnOpen = false;
    this.prompted = false;
    this.goAhead = false;
    this.interruptRequested = false;
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    for (const controller of this.asking) controller.abort(event.status === "interrupted" ? "interrupted" : "withdrawn");
    // A piece held back that the turn's end did not take as its failure is reply after all.
    this.release();
    // Cursor says nothing more of a call that was running when the turn stopped.
    for (const closing of this.stream.endTurn()) this.emit(closing, false);
    // Cursor answers a prompt once its subagents have ended; one it said no end of is over with the turn.
    for (const subagent of this.subagents.stopAll()) this.news(subagent);
    this.emit(event);
  }

  /** Reports an event and keeps it. The file is written after each tool row and at the turn's end. */
  private emit(event: ProviderEvent, keep = true): void {
    this.transcript.apply(event);
    this.sink.emit(event);
    if (keep && (event.type === "tool.end" || event.type === "turn.end")) this.save();
  }

  private save(): void {
    this.host.save(this.id, {
      messages: this.transcript.messages,
      cwd: this.cwd,
      ...(this.sessionID === this.id ? {} : { session: this.sessionID }),
      ...(this.told ? { told: true } : {}),
      ...(this.todos.length > 0 ? { todos: this.todos } : {}),
      ...(this.turnOpen ? { open: true } : {}),
    });
  }

  /** The message as Cursor takes it: the text, then each image it can read. */
  private content(prompt: Prompt, process: CursorProcess): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    if (prompt.text !== "") blocks.push({ type: "text", text: prompt.text });
    // The files mentioned (feature file_mentions), as ACP points at a file: a link to it,
    // which every ACP agent takes, never its contents.
    for (const mention of prompt.mentions ?? []) {
      blocks.push({ type: "resource_link", uri: pathToFileURL(join(this.cwd, mention)).href, name: basename(mention) });
    }
    if (prompt.images.length > 0 && process.info.agentCapabilities?.promptCapabilities?.image !== true) {
      this.emit({ type: "notice", level: "warn", text: `${prompt.images.length === 1 ? "The image was" : "The images were"} left out: this ${cursorName} takes no images.` });
    } else {
      let skipped = 0;
      for (const image of prompt.images) {
        const mimeType = imageType(image.data);
        if (mimeType) blocks.push({ type: "image", mimeType, data: image.data.toString("base64") });
        else skipped += 1;
      }
      if (skipped > 0) this.emit({ type: "notice", level: "warn", text: skippedImagesText(skipped, cursorName) });
    }
    if (blocks.length === 0) blocks.push({ type: "text", text: "" });
    return blocks;
  }

  // MARK: Cursor's process

  /** The run of Cursor with this thread's session in it, starting Cursor and loading the session as needed. */
  private ready(hadConversation: boolean): Promise<CursorProcess> {
    this.loading ??= this.load(hadConversation).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(hadConversation: boolean): Promise<CursorProcess> {
    const process = await this.host.process(this.cwd, this.runsForced);
    if (process.forced !== this.runsForced) {
      throw new Error("Cursor's access mode changed while the turn was starting, so the message was not sent. Send it again.");
    }
    const before = this.process;
    this.process = process;
    if (process.forced) this.ranEverything = true;
    // Moved to the other of the folder's processes (its mode went to or from Full access):
    // the one it leaves holds what it had of the conversation, which this turn will make
    // old, so it is loaded afresh should the thread come back while that one still runs.
    // It is stopped now when no other thread is on it.
    if (before && before !== process && before.client.isRunning) {
      before.loaded.delete(this.sessionID);
      this.host.left(before, this);
    }
    // Made in this run, or loaded in it before the thread was taken off the list and
    // on it again: a second load would open the session's store beside the first.
    if (process.loaded.has(this.sessionID)) return process;
    await process.exclusive(async () => {
      if (process.loaded.has(this.sessionID)) return;
      this.replaying = true;
      try {
        const state = await process.client.call<SessionState | null>("session/load", { sessionId: this.sessionID, cwd: this.cwd, mcpServers: [] }, loadTimeoutMs);
        process.loaded.add(this.sessionID);
        process.learn(state?.configOptions);
        log.info(`${cursorName} session loaded`, { session: this.sessionID });
      } catch (error) {
        if (error instanceof AgentStopped) throw error;
        if (error instanceof AcpError && error.code === authRequiredCode) throw new NotSignedIn();
        // Any other failure is of this try alone: the next message tries again.
        if (!(error instanceof AcpError) || error.code !== invalidParamsCode) throw new Error(`${cursorName} could not take this conversation up again: ${errorText(error)}`);
        await this.startAfresh(process, hadConversation);
      } finally {
        this.replaying = false;
      }
    });
    return process;
  }

  /**
   * Cursor has no session of this id: it keeps nothing of one that never got a
   * message, or whose first turn failed. The thread gets a new session and keeps its id.
   */
  private async startAfresh(process: CursorProcess, hadConversation: boolean): Promise<void> {
    const state = await newSession(process, this.cwd);
    const before = this.sessionID;
    this.sessionID = state.sessionId;
    // The new session knows nothing of the note the old one got, nor of its to-do list.
    this.told = false;
    this.todos = [];
    this.host.rerouted(this, before, this.sessionID);
    this.save();
    log.info(`${cursorName} had no such session; the thread has a new one`, { thread: this.id, session: this.sessionID });
    if (hadConversation) {
      this.emit({ type: "notice", level: "warn", text: `${cursorName} no longer has this conversation, so it starts afresh from here. What was said before is still shown above.` });
    }
  }

  /** Cursor's process is gone: nobody will hear an answer to its questions. */
  connectionLost(): void {
    for (const controller of this.asking) controller.abort("withdrawn");
  }

  /**
   * Sets the session to the thread's mode. Sent before every turn: the model can switch
   * it by itself, of which Cursor tells nothing. A mode Cursor does not take fails the
   * turn, and the message is not sent: it would run in whatever mode the session was
   * left in, which may edit where the thread says it only reads. The thread keeps its
   * mode, and its next message tries again.
   */
  private async sendMode(process: CursorProcess): Promise<void> {
    const modeId = cursorMode(this.threadMode) ?? "agent";
    try {
      await process.client.call("session/set_mode", { sessionId: this.sessionID, modeId });
    } catch (error) {
      if (error instanceof AgentStopped) throw error;
      throw new Error(`${cursorName} did not take the mode ${modeId}, so the message was not sent: ${errorText(error)}`);
    }
  }

  /**
   * Selects the thread's model in Cursor, and sets its thinking level, where they differ
   * from what Cursor is on. A thread on `default` sets nothing: it runs on whatever
   * Cursor is set to.
   */
  private async apply(process: CursorProcess): Promise<void> {
    const chosen = this.current.model;
    if (chosen === agentsChoice) return;
    const model = this.host.model(chosen);
    if (!model && this.host.modelsKnown()) {
      this.emit({ type: "notice", level: "warn", text: `${cursorName} no longer offers the model ${chosen}, so this turn runs on the one ${cursorName} is set to.` });
      return;
    }
    if (modelAt(process.current) !== chosen && !(await this.set(process, "model", cursorID(chosen), "the model"))) return;
    // Selecting it may have said its levels, for a Cursor that does not list its models.
    const level = levelSetting(this.host.model(chosen) ?? model, this.current.reasoningEffort);
    if (!level) return;
    const at = currentValue((process.current ?? []).find((option) => option?.id === level.option));
    if (at !== level.value) await this.set(process, level.option, level.value, "the thinking level");
  }

  private async set(process: CursorProcess, option: string, value: string, what: string): Promise<boolean> {
    try {
      const state = await process.client.call<SessionState | null>("session/set_config_option", { sessionId: this.sessionID, configId: option, value });
      process.learn(state?.configOptions);
      return true;
    } catch (error) {
      if (error instanceof AgentStopped) throw error;
      this.emit({ type: "notice", level: "warn", text: `${cursorName} did not change ${what} to ${value}: ${errorText(error)}` });
      return false;
    }
  }

  // MARK: From Cursor

  /** A `session/update` about this thread's session. */
  update(update: SessionUpdate): void {
    if (this.replaying) return;
    if (update.sessionUpdate === "session_info_update") {
      this.titled(update.title, false);
      return;
    }
    if (update.sessionUpdate === "subagent_spawned" || update.sessionUpdate === "subagent_state_update") {
      this.subagentUpdate(null, update);
      return;
    }
    if (this.turnOpen) this.news(this.subagents.parentCall(update));
    // Outside a turn nothing is shown: what Cursor still sends of a turn that was ended
    // for the app is dropped. Only the context's size would count, which agents send once
    // the turn's answer is out (Cursor 2026.10.01 reports none).
    if (!this.turnOpen) {
      if (update.sessionUpdate === "usage_update") for (const event of this.stream.map(update)) this.emit(event);
      return;
    }
    const piece = update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string" ? update.content.text : null;
    const junk = piece !== null && cursorQuirks.junkText?.test(piece) === true;
    // A turn's failure is its last piece of reply: one that reads as one waits for what
    // comes next, and is reply after all when more of the turn does.
    if (!junk && turnShows.has(update.sessionUpdate)) this.release();
    if (piece !== null) {
      if (turnFailure(piece) !== null || piece.trim() === signInReply) {
        this.held = update;
        return;
      }
      if (piece.trim() !== "" && !junk) this.lastPiece = piece;
    }
    for (const event of this.stream.map(update)) this.emit(event);
    // Only for a Cursor that left the subagent untold of: the line shows the others.
    if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && leftInBackground(update.rawOutput) && !this.subagents.started(update.toolCallId)) {
      this.emit({
        type: "notice",
        level: "warn",
        text: `${cursorName} left a subagent working in the background, which Portals cannot follow: the thread shows at rest while it works, and it ends when ${cursorName}'s process is stopped.`,
      });
    }
  }

  /**
   * What one of the thread's subagents (`from`; null for the thread's own session) told:
   * a subagent of its own started or ended, a piece of its reply, a tool call of its.
   * None of it is the thread's reply.
   */
  subagentUpdate(from: string | null, update: SessionUpdate): void {
    if (this.replaying) return;
    switch (update.sessionUpdate) {
      case "subagent_spawned":
        if (this.takesSpawn(from)) this.news(this.subagents.spawned(update, from ?? this.sessionID));
        return;
      case "subagent_state_update":
        this.news(this.subagents.state(update));
        return;
      default:
        if (from === null) return;
        this.news(this.subagents.update(from, update));
        // A subagent's own Task: its subagent's goal, and whether it left it in the background.
        this.news(this.subagents.parentCall(update));
    }
  }

  private news(subagent: SubagentInfo | null): void {
    if (!subagent) return;
    // Its cards go with it: nobody would hear their answer.
    if (subagent.status !== "running") this.withdrawCardsOf(subagent.id);
    this.sink.emit({ type: "subagent", subagent });
  }

  private withdrawCardsOf(subagent: string): void {
    for (const [controller, owner] of this.askedBy) if (owner === subagent) controller.abort("withdrawn");
  }

  /** A title: the bridge's own first (`provisional`, from the first message), then Cursor's, until the user gives one. */
  private titled(title: string | null | undefined, provisional: boolean): void {
    const wanted = title?.trim();
    if (!wanted || wanted === this.title || this.titleFixed) return;
    if (provisional && this.title !== null) return;
    this.title = wanted;
    this.sink.emit({ type: "title", title: wanted });
  }

  /** Cursor asks before a tool call (`session/request_permission`). */
  async permission(process: CursorProcess, id: RpcId, params: PermissionRequest, subagent?: string): Promise<void> {
    const options = Array.isArray(params?.options) ? params.options : [];
    // One of a subagent that has ended is of nobody's now.
    if (!this.takesRequests || typeof params?.toolCall?.toolCallId !== "string" || (subagent && !this.subagents.running(subagent))) {
      process.client.respond(id, cancelled);
      return;
    }
    // What a request says in words is Cursor's reason for asking, not what the tool
    // returned: only a change it shows is kept with the call.
    const told = Array.isArray(params.toolCall.content) ? params.toolCall.content : [];
    const change = told.filter((block) => block?.type === "diff");
    // The call's row first, when Cursor told of the call; a request under an id of its own has the card alone.
    const fields = { ...params.toolCall, content: change.length > 0 ? change : undefined };
    // A subagent's call is no row of the thread's: the card is made from what the subagent told of it.
    const known = subagent ? this.subagents.call(subagent, params.toolCall.toolCallId) : undefined;
    const { events, call, tool, announced } = known
      ? { events: [], call: merged(known, fields), tool: gatewayTool(merged(known, fields), this.own), announced: true }
      : this.stream.asked(fields);
    for (const event of events) this.emit(event);
    const card = permissionCard(params.toolCall, options, call, tool, announced, this.cwd, cursorQuirks);
    const answer = await this.ask(subagent ? { ...card, subagent } : card);
    // Cursor runs the call only once it has a yes: one still waiting when the turn ends never ran.
    if (answer.kind === "approval") {
      if (answer.choice === "deny") this.stream.denied(call.toolCallId);
      else this.stream.allowed(call.toolCallId);
    }
    process.client.respond(id, permissionOutcome(options, answer));
  }

  /** One of Cursor's own requests, placed in this thread by its provider (./requests.ts). */
  async request(process: CursorProcess, id: RpcId, method: string, params: Record<string, any>, subagent?: string): Promise<void> {
    const toolCall = typeof params?.toolCallId === "string" ? params.toolCallId : null;
    // A subagent that has ended asks nobody.
    if (subagent && !this.subagents.running(subagent)) {
      process.client.respond(id, unplacedAnswer(method));
      return;
    }
    // A subagent's plan and to-do list are its own, not the thread's.
    if (subagent && (method === createPlan || method === updateTodos)) {
      process.client.respond(id, method === createPlan ? { outcome: { outcome: "cancelled" } } : {});
      return;
    }
    switch (method) {
      case askQuestion: {
        const card = questionCard(params);
        if (!card) {
          process.client.respond(id, { outcome: { outcome: "skipped", reason: "The question had nothing to ask." } });
          return;
        }
        const { response, said } = questionOutcome(params, await this.ask(subagent ? { ...card, subagent } : card));
        // The question's own row, which ends after this, says what was answered.
        if (toolCall) this.answers.set(toolCall, said);
        process.client.respond(id, response);
        return;
      }
      case createPlan: {
        const { response, accepted } = planOutcome(await this.ask(planCard(params)));
        if (accepted && this.turnOpen) {
          this.goAhead = true;
          // The work starts in the agent's own mode, which the go-ahead is sent in.
          if (this.threadMode !== "default") {
            this.threadMode = "default";
            this.sink.emit({ type: "mode", mode: "default" });
          }
        }
        process.client.respond(id, response);
        return;
      }
      case updateTodos: {
        this.todos = mergedTodos(this.todos, params);
        process.client.respond(id, {});
        if (this.todos.length === 0) return;
        const { tool, result } = todoRow(this.todos);
        const row = { id: toolCall ?? `todos-${randomUUID()}`, name: tool.name, args: tool.args, ...(tool.context ? { context: tool.context } : {}) };
        this.emit({ type: "tool.start", ...row });
        this.emit({ type: "tool.end", ...row, result });
        return;
      }
      default:
        // Told of a subagent or an image its tool call already showed.
        process.client.respond(id, {});
    }
  }

  /** Puts a card to the phones and waits for its answer; a stop or the turn's end withdraws it. */
  private async ask(request: Parameters<SessionSink["ask"]>[0]): ReturnType<SessionSink["ask"]> {
    const controller = new AbortController();
    this.asking.add(controller);
    if (request.subagent) this.askedBy.set(controller, request.subagent);
    try {
      return await this.sink.ask(request, controller.signal);
    } finally {
      this.asking.delete(controller);
      this.askedBy.delete(controller);
    }
  }
}

/** What Cursor sends of a turn that is more of it: a piece of reply held back before such a one was not the turn's end. */
const turnShows = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

/** A Task that ended with its subagent still at work: the one sign of background work Cursor gives a client like this one. */
function leftInBackground(output: unknown): boolean {
  return !!output && typeof output === "object" && (output as { isBackground?: unknown }).isBackground === true;
}
