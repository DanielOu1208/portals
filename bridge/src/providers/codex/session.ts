import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../../log.ts";
import { BackgroundCommands } from "../backgroundCommands.ts";
import { imageType, skippedImagesText } from "../images.ts";
import { titleFrom } from "../titles.ts";
import type {
  AgentRequest,
  EndedSubagent,
  ModeState,
  ModelChangeResult,
  Prompt,
  ProviderEvent,
  ProviderSession,
  SessionOptions,
  SessionSettings,
  SessionSink,
  StoredMessage,
  SubagentInfo,
  ThreadMode,
  TurnUsage,
} from "../types.ts";
import { CodexError } from "./client.ts";
import { noTurnsYet, readThread, type ReadOptions } from "./read.ts";
import { compactCommand, historyFromThread, subagentsCalledIn, userInputText } from "./history.ts";
import { codexEffort, collaborationMode, policyFor, settledDefaults, threadModeFor, type DesktopDefaults, type WorkMode } from "./options.ts";
import {
  approvalRequest,
  clarifyRequest,
  commandApproval,
  elicitation,
  fileChangeApproval,
  idKey,
  isToolApproval,
  clarifyResult,
  clarifyRow,
  implementPlanText,
  planRequest,
  requestKey,
  responseFor,
  userInput,
} from "./requests.ts";
import { betweenStates, CodexAgents, nicknameOf } from "./agents.ts";
import { CodexStream, rateLimitNotices } from "./stream.ts";
import { gatewayResult, gatewayTool } from "./tools.ts";
import type { AskForApproval, FileUpdateChange, RateLimitSnapshot, RequestId, SandboxPolicy, Thread, Turn, UserInput } from "./types/index.ts";

// One Codex thread. The thread id is Codex's own, from `thread/start`. The bridge's
// one connection to Codex is shared by every thread; the provider hands each session
// the notifications and requests of its own thread.
//
// - A thread the bridge started is followed from the start. One loaded later (after a
//   restart of the bridge) is read with `thread/read`, and followed (`thread/resume`)
//   only when Codex has it loaded, or at its next message: resuming a thread starts
//   its MCP servers, which reading it does not.
// - Model, thinking level and `/mode` go with the next `turn/start`, as overrides Codex
//   keeps for the thread. A message sent mid-turn goes in with `turn/steer`.
// - Codex's requests to the person become the app's cards. They outlive the bridge's
//   connection: after a reconnect Codex asks again (perhaps with another id) and the
//   card already open answers it.
// - `/compact` comes as a message (`command.dispatch` sends it so) and is carried out
//   with `thread/compact/start`: Codex summarises the thread in a turn of its own, which
//   has no message in it, gets its id from `turn/started`, and takes no message sent
//   meanwhile (they wait for it to end).
// - `/mode plan` is Codex's own plan mode (`collaborationMode`), in which Codex may ask
//   questions and ends its turn with a plan. The plan is put to the person as a plan
//   card while the app's turn goes on: Start carries it out in a turn of Codex's default
//   mode, told "Implement the plan." as Codex's own app tells it; Keep planning with a
//   note sends the note in plan mode; without one the turn ends there.

/** The thread's settings in Codex, as last reported. */
export interface Applied {
  model: string | null;
  effort: string | null;
  approvalPolicy: AskForApproval | null;
  sandboxPolicy: SandboxPolicy | null;
  summary: string | null;
  /** Codex's plan mode or its default one; null when not reported. */
  collaborationMode?: "plan" | "default" | null;
}

/** What the connection to Codex gives a session. */
export interface CodexCalls {
  call<T = any>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  /** Waits until connected, for a while; throws when Codex stays away. */
  whenReady(): Promise<void>;
  respond(id: RequestId, result: unknown): void;
  respondError(id: RequestId, code: number, message: string): void;
}

/** What a session needs from its provider. */
export interface CodexHost {
  readonly client: CodexCalls;
  /** What config.toml sets, when known. */
  defaults(): DesktopDefaults | null;
  /** What config.toml sets for a thread in `cwd`, the folder's own config.toml included; throws when Codex cannot say. */
  defaultsFor(cwd: string): Promise<DesktopDefaults>;
  /** The thinking levels a model takes; [] when not known. */
  efforts(model: string): string[];
  /** Where images from the phone are written for Codex to read. */
  readonly imagesDir: string;
  /** How long a stopped turn may take to end before the bridge ends it for Codex. */
  readonly interruptGraceMs: number;
  /**
   * How long a call waits for Codex to be reachable (15 seconds): a message waiting for a
   * thread to catch up after a drop fails if Codex is still away that long after it was sent.
   */
  readonly readyMs: number;
  /** For the times in rate-limit warnings; the Mac's own zone when absent. */
  readonly timeZone?: string;
  /** Names the thread after its first message, `message`, as Codex's own apps name theirs. */
  nameThread(thread: string, message: string): void;
  forget(session: CodexSession): void;
}

interface Pending {
  /** Its own key in `pending`. */
  key: string;
  /** What it is asked again by (`requestKey`). */
  match: string;
  /** The id to answer by; after a reconnect, the one Codex asked again with. */
  codexID: RequestId;
  method: string;
  controller: AbortController;
  /** `codexID` belongs to the current connection. */
  live: boolean;
  /** Given while Codex was away; sent when it asks again. */
  answer?: unknown;
}

type Params = Record<string, any>;
type TurnEnd = Extract<ProviderEvent, { type: "turn.end" }>;

/** Two turns' figures as one: the tokens added up, the time added up when both say one (else the bridge times the whole). */
function addSpent(a: TurnUsage | null | undefined, b: TurnUsage | null | undefined): TurnUsage | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const sum: TurnUsage = {};
  if (a.tokens !== undefined || b.tokens !== undefined) sum.tokens = (a.tokens ?? 0) + (b.tokens ?? 0);
  if (a.seconds !== undefined && b.seconds !== undefined) sum.seconds = a.seconds + b.seconds;
  return sum;
}
/** `away`: the connection to Codex dropped while the card was open. */
type PlanCard = { controller: AbortController; end: TurnEnd; turn: string | null; away: boolean };
type Held =
  | { kind: "notification"; method: string; params: Params }
  | { kind: "subAgent"; method: string; params: Params }
  | { kind: "request"; id: RequestId; method: string; params: Params };

/**
 * A message that is `/compact`, with whatever follows it: Codex compacts without
 * instructions. One with images or files is words, as for the session (`isCommand`).
 */
function isCompact(prompt: Prompt): boolean {
  return prompt.images.length === 0 && (prompt.files?.length ?? 0) === 0 && new RegExp(`^/${compactCommand}(\\s|$)`).test(prompt.text.trim());
}

/** Why a message waiting for the bridge to catch up with a thread fails (`unreachable`). */
const unreachableText = "Codex is not reachable right now.";
/** How long after following a thread again Codex has to ask its open questions again. */
const redeliveryGraceMs = 2000;
/** Sub-agents that ended this long ago or less are read again on attach and reconnect. */
const settleWithinMs = 30 * 60_000;
/** At most this many sub-agents' threads are read at once when settling. */
const settleReads = 4;
/** A sub-agent caught between two states is looked at again this many times, this much later each time. */
const agentLooks = 3;
/** The most sub-agents' threads read for their nicknames when a stored thread is read back: the latest. */
const nicknameReads = 24;
const agentLookMs = 500;

/** Two settings values compared regardless of key order. */
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Params)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * A notification held while a reconnect reads the thread (`reading`). The first that tells
 * of a turn (its start, or its message) carries the sub-agents that had ended when it
 * came, in the runs they had ended in: what that turn's message may take off the subagents
 * line once it is told (feature subagents_clear), from the read or from what was held.
 */
interface HeldNotification {
  method: string;
  params: Params;
  clears?: EndedSubagent[];
}

/** The turn a notification is about, where it opens one: its start, or its message. */
function openedTurn(method: string, params: Params): string | undefined {
  const turn = method === "turn/started" ? params.turn?.id : params.item?.type === "userMessage" ? params.turnId : undefined;
  return typeof turn === "string" ? turn : undefined;
}

/** What `turn`, heard while held in `held`, may clear (`HeldNotification`); undefined when it was not heard there. */
function heardClears(held: readonly HeldNotification[] | null, turn: string | null): EndedSubagent[] | undefined {
  if (!held || turn === null) return undefined;
  return held.find((entry) => entry.clears !== undefined && openedTurn(entry.method, entry.params) === turn)?.clears;
}

export class CodexSession implements ProviderSession {
  readonly id: string;
  readonly cwd: string;
  private readonly sink: SessionSink;
  private readonly host: CodexHost;
  private readonly stream: CodexStream;
  /** The sub-agents this thread spawned, each a thread of its own. */
  private readonly agents = new CodexAgents();
  /** Commands Codex left running in the background (its background terminals), as rows of the subagents line. */
  private readonly terminals: BackgroundCommands;
  /** The process Codex runs each of those in, for Stop, and the turn it began in, by its item's id. */
  private readonly terminalProcesses = new Map<string, { process?: string; turn: string | null }>();
  /** What Codex calls the sub-agents the stored thread's calls name, read from their own threads; "" for one that said nothing. */
  private readonly nicknames = new Map<string, string>();
  /** Only the latest requested read of a child may update its row. */
  private readonly agentReads = new Map<string, object>();
  /** How many more looks a sub-agent caught between two states has had, by thread. */
  private readonly agentLooked = new Map<string, number>();
  /** The looks waiting to be taken, cleared when the session closes. */
  private readonly lookTimers = new Set<NodeJS.Timeout>();
  /** The sub-agents the stored thread tells of, read with it. */
  private past: { subagent: SubagentInfo; turn: number }[] = [];
  private stored: StoredMessage[] = [];
  /** Only read (`session.adopt` mode `read`): never followed, and what Codex says of it is not taken in. */
  private readonly readOnly: boolean;
  private current: SessionSettings;
  private threadMode: ThreadMode;
  /** The mode the thread had when it went into plan mode, which an approved plan is carried out in. */
  private modeBeforePlan: ThreadMode;
  /**
   * The thread is back in `default` from another mode, whose policy Codex still has for
   * it: the next turn sends what `default` comes to, once, and only that turn's start
   * takes back this request (a mode chosen again meanwhile is a new one). A thread in
   * `default` all along keeps what Codex has (its folder may have settings of its own).
   */
  private pendingReset: object | null = null;
  private title: string | null;
  /** The thread had no name when a message came: the provider names it once a turn has started. */
  private toName = false;
  private applied: Applied | null;
  /** This connection gets the thread's notifications and requests. */
  private subscribed: boolean;
  /** The bridge has followed it in this run, so it follows it again after a reconnect while Codex still has it loaded. */
  private following: boolean;
  private subscribing: Promise<void> | null = null;
  /** The bridge's side is wired up; until then what Codex sends is held. */
  private isAttached = false;
  private readonly held: Held[] = [];
  /** A turn is running, as the app sees it. */
  private turnOpen = false;
  /** Codex's id for it, once known. */
  private turnID: string | null = null;
  /** The bridge's own `turn/start` is on its way and its id not known yet. */
  private starting = false;
  /** The pending start/compact call: notifications may end its turn before its reply. */
  private beginning: object | null = null;
  private closed = false;
  /** The running turn is a `/compact`, which Codex takes no message into (`turn/steer`). */
  private compacting = false;
  /** A turn Codex began without the bridge (at the desk), until its user message arrives. */
  private external: string | null = null;
  private runningUser: string | null = null;
  private idWaiters: ((id: string | null) => void)[] = [];
  private interruptTimer: NodeJS.Timeout | null = null;
  /** A turn the grace timer ended that Codex has not said it ended: Codex may still be running it. */
  private abandoned: string | null = null;
  /**
   * What config.toml comes to in the thread's folder (with the folder's and its project's
   * own `.codex/config.toml`), as Codex last said: what `default` means here. Null until
   * Codex has said; the general settings stand in.
   */
  private folderDefaults: DesktopDefaults | null = null;
  /** The last turn Codex said has ended, whosever it was: one read as running before that word came has ended since. */
  private lastEnded: string | null = null;
  /** The thread's latest turn the bridge has heard of (read with the thread, or begun since): those after it were missed. */
  private lastKnownTurn: string | null = null;
  /** For the conversation `history` gives: where each of the thread's turns ends in it, by id. */
  private turnEnds = new Map<string, number>();
  /**
   * The thread's latest turn the bridge has shown (`latestTurn`): read with the thread, or
   * shown since, as it began or once told. Unlike `lastKnownTurn`, never one a reconnect
   * is still about to tell (it may yet fail to).
   */
  private lastShownTurn: string | null = null;
  /**
   * From a drop of the connection to Codex until a reconnect has told the turns it
   * missed (`joinMissed`): the turn last heard of before the drop, and the turns shown
   * since (live, or told), which telling what was missed leaves out. A turn shown since
   * does not make those before it heard of; but they are told only in order, so one
   * missed before a turn that has shown already is not told (a read of the thread that
   * failed while a turn began at the desk): it shows when the thread is loaded again.
   */
  private gap: { after: string | null; shown: Set<string> } | null = null;
  /**
   * From a drop of the connection to Codex until the bridge is back in step with the
   * thread (the turns it missed told): a message sent meanwhile waits for it on the
   * thread's list (`catchingUp`), so its turn comes after them.
   */
  private recovery: { done: Promise<void>; resolve: () => void } | null = null;
  /** The last reconnect's following the thread again: the next waits for it. */
  private reconnecting: Promise<void> = Promise.resolve();
  /** From a drop of the connection to Codex until it is back (`reconnected`): Codex cannot be reached. */
  private down = false;
  /**
   * What `unreachable` waits on while the connection is up again and the thread is read:
   * told why at the next drop, or nothing once the bridge is back in step.
   */
  private readonly reachWaiters = new Set<(reason: string | undefined) => void>();
  /**
   * What Codex sends about the thread while a reconnect reads it for the turns it missed
   * (`joinMissed`): held until those are told, so a turn begun meanwhile comes after them.
   */
  private reading: HeldNotification[] | null = null;
  /** The running turn of Codex's was started in plan mode. */
  private planning = false;
  /** The plan it has proposed, once complete (its `plan` item). */
  private proposed: string | null = null;
  /**
   * The plan card is open: Codex's turn (`turn`) is over and the app's waits for the
   * answer, to end as `end` says if it ends there.
   */
  private planCard: PlanCard | null = null;
  /** What the turns of Codex's before the running one spent, in the same turn of the app's (a plan's, `carry`). */
  private carried: TurnUsage | null = null;
  /** The Codex turn the carried figures came from last: kept under it when no turn of Codex's follows (`turn/start` failed). */
  private carriedTurn: string | null = null;
  /** Stop was given in the app's running turn: a plan it ends with is not put to the person. */
  private stopAsked = false;
  private readonly pending = new Map<string, Pending>();
  /** Requests asked so far, which keeps each one's key in `pending` its own. */
  private asked = 0;
  /** How many times the connection to Codex has dropped: a reconnect's cleanup is of its own connection. */
  private drops = 0;
  /** Each message to steer in, waiting for the answers given while Codex was away to go (`answersSent`). */
  private answerWaiters: (() => void)[] = [];
  /** The changes of file-change items, for their approval cards. */
  private readonly changes = new Map<string, FileUpdateChange[]>();
  private readonly warned = new Set<string>();
  private imageDirs: string[] = [];

  constructor(options: SessionOptions, sink: SessionSink, host: CodexHost, start: { applied: Applied | null; subscribed: boolean }) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.sink = sink;
    this.host = host;
    this.stream = new CodexStream({
      cwd: options.cwd,
      calledAbout: (item) => this.agents.calledAbout(item, this.nicknames),
      // A sub-agent's start or end, or a call about them, missed while the connection was down.
      heardLate: (item) => {
        if (item.type === "subAgentActivity" || item.type === "collabAgentToolCall") this.noteAgents("item/completed", item);
      },
      progress: (event) => this.sink.emit(event),
      background: (command) => {
        this.terminalProcesses.set(command.id, { ...(command.processId ? { process: command.processId } : {}), turn: command.turn });
        this.terminals.start(command.id, {
          goal: command.command, startedAt: command.startedAt, stoppable: command.processId !== undefined, output: command.output, outputTruncated: command.outputTruncated,
        });
      },
    });
    this.terminals = new BackgroundCommands((event) => this.sink.emit(event));
    this.current = { ...options.settings };
    this.current.reasoningEffort = this.level(this.current.reasoningEffort);
    this.threadMode = options.mode ?? "default";
    this.modeBeforePlan = options.modeBeforePlan ?? "default";
    // Put back in default before a restart of the bridge, with no turn since: Codex may
    // still have the other mode's policy for the thread.
    if (options.modeReset && this.workMode() === "default") this.pendingReset = {};
    this.title = options.title ?? null;
    this.applied = start.applied;
    this.readOnly = options.readOnly ?? false;
    this.subscribed = start.subscribed;
    this.following = start.subscribed;
  }

  // MARK: Loading

  /** Reads the thread's history, following it first when Codex has it loaded (it may be running). */
  async load(): Promise<void> {
    let thread = await this.read();
    if (this.readOnly) {
      // Its turns as they are, a running one included; nothing that follows it.
      await this.learnNicknames(thread);
      this.stored = historyFromThread(thread, this.cwd, false, this.nicknames).messages;
      if (typeof thread.name === "string" && thread.name.trim() !== "") this.title = thread.name.trim();
      return;
    }
    if (thread.status?.type !== "notLoaded") {
      await this.subscribe();
      thread = await this.read();
    }
    // What default comes to in this folder, for `/mode` and the mode chip.
    await this.noteFolderDefaults();
    const active = thread.status?.type === "active";
    await this.learnNicknames(thread);
    const history = historyFromThread(thread, this.cwd, active, this.nicknames);
    // One the stored thread leaves at work may have ended since: its own thread says,
    // read once the session has taken these in (`attached`).
    this.past = this.agents.remember((thread.turns ?? []) as Turn[]);
    this.lastKnownTurn = ((thread.turns ?? []) as Turn[]).at(-1)?.id ?? null;
    this.lastShownTurn = this.lastKnownTurn;
    log.info("Codex thread loaded", { session: this.id, following: this.subscribed, running: history.running !== null });
    this.stored = history.messages;
    this.turnEnds = history.ends;
    if (history.running) {
      this.turnOpen = true;
      this.turnID = history.running.turnId;
      this.runningUser = history.running.user;
      // A turn with no message is a `/compact`, which takes none in; or a turn whose
      // message has not come yet (Codex runs hooks first), which its message shows.
      this.compacting = !history.running.items.some((item) => item.type === "userMessage");
      this.stream.beginTurn(history.running.turnId, true);
      this.stream.known(history.running.items);
      for (const item of history.running.items) {
        if (item.type === "fileChange" && Array.isArray(item.changes)) this.changes.set(item.id, item.changes);
      }
      // A turn of plan mode still running from before a restart of the bridge ends with
      // its plan card all the same. Codex says which mode the turn runs in (the thread's
      // mode may have changed since, for the next turn); the thread's mode stands in when
      // it does not.
      const reported = this.applied?.collaborationMode;
      this.planning = reported ? reported === "plan" : this.threadMode === "plan";
      const plan = this.planning ? history.running.items.findLast((item) => item.type === "plan" && typeof item.text === "string") : undefined;
      if (plan) this.proposed = plan.text;
    }
    if (typeof thread.name === "string" && thread.name.trim() !== "" && thread.name.trim() !== this.title) {
      this.held.push({ kind: "notification", method: "thread/name/updated", params: { threadId: this.id, threadName: thread.name } });
    }
  }

  /** Asks Codex what its settings come to in the thread's folder; when it cannot say, what was known stands. */
  async noteFolderDefaults(): Promise<void> {
    try {
      this.folderDefaults = await this.host.defaultsFor(this.cwd);
    } catch (error) {
      log.debug("Codex did not say what its settings come to in the thread's folder", { session: this.id, error: (error as Error).message });
    }
  }

  /**
   * Reads what Codex calls the sub-agents the stored thread's calls about them name (a
   * wait, a close), which only their own threads say, so that its rows read back name them
   * as they did live (feature `subagent_calls`). Only those not read yet, at most
   * `nicknameReads` of the latest, a few at a time; one that cannot be read is named by
   * what it was asked to do.
   */
  private async learnNicknames(thread: Thread): Promise<void> {
    const ids = subagentsCalledIn(thread)
      .filter((id) => !this.nicknames.has(id) && !this.agents.hasNickname(id))
      .slice(-nicknameReads);
    let next = 0;
    const reader = async () => {
      while (next < ids.length) {
        const id = ids[next++]!;
        try {
          this.nicknames.set(id, nicknameOf((await this.host.client.call("thread/read", { threadId: id, includeTurns: false })).thread));
        } catch (error) {
          this.nicknames.set(id, "");
          log.debug("could not read a sub-agent's thread for its nickname", { session: this.id, thread: id, error: (error as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(settleReads, ids.length) }, reader));
  }

  private async read(options: ReadOptions = {}): Promise<Thread> {
    try {
      return await readThread(this.host.client, this.id, options);
    } catch (error) {
      throw new Error(`Codex could not read this thread: ${(error as Error).message}`);
    }
  }

  /**
   * Follows the thread on the current connection (`thread/resume`); Codex then asks its
   * open questions again. Persisted history is read separately; a pending file-change
   * approval whose changes were missed reads its live item in `changesOf`.
   */
  private subscribe(): Promise<void> {
    if (this.subscribed) return Promise.resolve();
    this.subscribing ??= (async () => {
      try {
        const result = await this.host.client.call("thread/resume", { threadId: this.id, excludeTurns: true });
        this.learn({ model: result.model, effort: result.reasoningEffort, approvalPolicy: result.approvalPolicy, sandboxPolicy: result.sandbox, collaborationMode: result.collaborationMode?.mode });
        this.subscribed = true;
        this.following = true;
      } catch (error) {
        // A thread with no turn yet has nothing stored to resume; Codex still has it, and
        // the next turn/start follows it.
        if (!/rollout/i.test((error as Error).message) && !noTurnsYet(error)) throw error;
        log.debug("Codex has nothing to resume for a thread without turns", { session: this.id });
        this.following = true;
      } finally {
        this.subscribing = null;
      }
    })();
    return this.subscribing;
  }

  private learn(settings: Partial<Applied>): void {
    const applied: Applied = this.applied ?? { model: null, effort: null, approvalPolicy: null, sandboxPolicy: null, summary: null };
    for (const [key, value] of Object.entries(settings) as [keyof Applied, never][]) {
      if (value !== undefined) applied[key] = value;
    }
    this.applied = applied;
  }

  // MARK: ProviderSession

  async history(): Promise<StoredMessage[]> {
    return structuredClone(this.stored);
  }

  attached(): { user: string } | null {
    this.isAttached = true;
    this.settleAgents();
    // After the bridge has taken in the answer: what Codex sent meanwhile comes next.
    queueMicrotask(() => {
      for (const entry of this.held.splice(0)) {
        if (entry.kind === "notification") this.handle(entry.method, entry.params);
        else if (entry.kind === "subAgent") this.subAgentNotification(entry.method, entry.params);
        else this.request(entry.id, entry.method, entry.params);
      }
    });
    return this.turnOpen && this.runningUser !== null ? { user: this.runningUser } : null;
  }

  settings(): SessionSettings {
    return { ...this.current };
  }

  /** Codex's id for the thread's latest turn the bridge has shown (read with the thread, begun since, or told once missed). */
  latestTurn(): string | null {
    return this.lastShownTurn;
  }

  turnEnd(id: string): number | undefined {
    return this.turnEnds.get(id);
  }

  async reload(): Promise<StoredMessage[]> {
    const thread = await this.read();
    await this.learnNicknames(thread);
    return historyFromThread(thread, this.cwd, false, this.nicknames).messages;
  }

  startTurn(prompt: Prompt): void {
    this.turnOpen = true;
    this.turnID = null;
    this.starting = true;
    this.compacting = isCompact(prompt);
    void (this.compacting ? this.compact() : this.begin(prompt));
  }

  steer(prompt: Prompt): Promise<boolean | "refused"> {
    return this.steerIn(prompt);
  }

  steerable(): boolean {
    return !this.compacting && this.planCard === null && !this.policyPending();
  }

  /** A steer cannot change the running turn's policy; only the next turn/start can. */
  private policyPending(): boolean {
    if (this.pendingReset) return true;
    if ((this.threadMode === "plan") !== (this.applied?.collaborationMode === "plan")) return true;
    const work = this.workMode();
    if (work === "default") return false;
    const policy = policyFor(work, this.folderDefaults ?? this.host.defaults(), this.cwd);
    return policy !== null && !(same(policy.approvalPolicy, this.applied?.approvalPolicy) && same(policy.sandboxPolicy, this.applied?.sandboxPolicy));
  }

  /** Codex keeps it as the thread's name, which a terminal shows too. */
  async rename(title: string): Promise<void> {
    await this.host.client.call("thread/name/set", { threadId: this.id, name: title });
    this.title = title;
  }

  async interrupt(): Promise<boolean> {
    if (!this.turnOpen) return false;
    this.stopAsked = true;
    // Nothing runs in Codex while its plan waits for an answer (or while an answer to it
    // is checked): the card goes, and the turn ends.
    const card = this.planCard;
    if (card) {
      this.planCard = null;
      card.controller.abort("interrupted");
      this.endTurn({ ...card.end, status: "interrupted" });
      return true;
    }
    const turnID = await this.turnReady();
    if (!turnID) return false;
    try {
      await this.host.client.call("turn/interrupt", { threadId: this.id, turnId: turnID });
    } catch (error) {
      log.warn("Codex did not take the interrupt", { session: this.id, error: (error as Error).message });
    }
    // Answered after that turn ended (Stop as it finished), and maybe after the next began:
    // a timer armed now would be that next turn's, and its own Stop would find it set and
    // arm none, so a turn Codex does not end after its Stop would never end for the app.
    if (!this.turnOpen || this.turnID !== turnID) return true;
    // A turn Codex does not end by itself is ended here, for the app; Codex may still be
    // running it until it says it completed (`stopping`).
    this.interruptTimer ??= setTimeout(() => {
      this.interruptTimer = null;
      if (!this.turnOpen || this.turnID !== turnID) return;
      this.abandoned = turnID;
      this.endTurn({ type: "turn.end", status: "interrupted", ...(this.stream.usage ? { usage: this.stream.usage } : {}) });
    }, this.host.interruptGraceMs);
    this.interruptTimer.unref();
    return true;
  }

  /**
   * Codex runs a turn the app is not shown as running: one the grace timer ended, until
   * Codex says it completed, one begun at the desk whose message has not come yet (a
   * compaction there never brings one), or one the bridge never heard of: begun while
   * the connection to Codex was down, or at the desk in a thread loaded only to be shown
   * (after a restart), which the bridge does not follow. So Codex is asked about every
   * thread but one only read (a terminal's, which removing leaves running there): one it
   * may have ended without the bridge hearing (a restart of its own, a connection that
   * dropped) is over unless Codex still runs a turn in the thread. Throws when Codex
   * cannot be asked.
   */
  async stopping(): Promise<boolean> {
    if (this.readOnly) return false;
    const abandoned = this.abandoned;
    const external = this.external;
    let thread: Thread;
    try {
      // Its status only: whether Codex runs a turn in it now, whichever turn that is.
      thread = (await this.host.client.call("thread/read", { threadId: this.id, includeTurns: false })).thread;
    } catch (error) {
      throw new Error(`Codex could not read this thread: ${(error as Error).message}`);
    }
    // A turn Codex began meanwhile is one this answer may not know of.
    if ((this.abandoned !== null && this.abandoned !== abandoned) || (this.external !== null && this.external !== external)) return true;
    if (thread.status?.type === "active") return true;
    // Over in Codex: nothing is left to wait for.
    if (this.abandoned === abandoned) this.abandoned = null;
    if (this.external === external) this.external = null;
    return false;
  }

  async setModel(model: string, provider: string): Promise<ModelChangeResult> {
    this.current = { ...this.current, model, provider };
    this.current.reasoningEffort = this.level(this.current.reasoningEffort);
    // Codex takes it with the next turn/start.
    return { deferred: this.turnOpen };
  }

  async setReasoning(level: string): Promise<void> {
    this.current = { ...this.current, reasoningEffort: this.level(level) };
  }

  /** A level the app sends as one the thread's model has. */
  private level(level: string): string {
    return codexEffort(level, this.host.efforts(this.current.model)) ?? level;
  }

  mode(): ModeState {
    const defaults = this.folderDefaults ?? this.host.defaults();
    const settled = defaults ? settledDefaults(defaults, this.cwd) : null;
    const defaultsTo = settled ? threadModeFor(settled.approvalPolicy, settled.sandbox) : null;
    return defaultsTo ? { mode: this.threadMode, defaultsTo } : { mode: this.threadMode };
  }

  modeResetPending(): boolean {
    return this.pendingReset !== null;
  }

  async setMode(mode: ThreadMode): Promise<void> {
    // Codex takes it with the next turn/start.
    const before = this.workMode();
    if (mode === "plan" && this.threadMode !== "plan") this.modeBeforePlan = this.threadMode;
    this.threadMode = mode;
    const after = this.workMode();
    if (after !== before) this.pendingReset = after === "default" ? {} : null;
  }

  /** The mode turns run with: in plan mode, the one its plan is to be carried out in. */
  private workMode(): WorkMode {
    if (this.threadMode !== "plan") return this.threadMode;
    return this.modeBeforePlan === "plan" ? "default" : this.modeBeforePlan;
  }

  async close(): Promise<void> {
    // The thread lives on in Codex; only the bridge's side goes.
    this.closed = true;
    this.beginning = null;
    this.starting = false;
    this.terminals.close();
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    for (const timer of this.lookTimers) clearTimeout(timer);
    this.lookTimers.clear();
    this.closePlanCard();
    for (const entry of this.pending.values()) entry.controller.abort("withdrawn");
    this.pending.clear();
    this.answersGone();
    for (const settle of [...this.reachWaiters]) settle(undefined);
    await this.removeImages();
    this.host.forget(this);
  }

  // MARK: Turns

  private async begin(prompt: Prompt): Promise<void> {
    if (this.closed) return;
    const beginning = this.beginning = {};
    const mine = () => this.beginning === beginning;
    // A thread with no name yet is titled by the first line of its first message, until
    // the name the provider has made for it comes (`thread/name/updated`).
    const unnamed = this.title === null ? titleFrom(prompt.text) : null;
    if (unnamed) {
      this.title = unnamed;
      this.toName = true;
      this.sink.emit({ type: "title", title: unnamed });
    }
    try {
      await this.subscribe();
      if (!mine()) return;
      const input = await this.input(prompt);
      if (!mine()) return;
      // Back to default: what it comes to in this folder, as Codex reads its settings for
      // it. When Codex cannot say, the turn does not start: the other mode's policy is not
      // to run on as if it were default's.
      const folder = this.pendingReset && this.workMode() === "default" ? await this.host.defaultsFor(this.cwd) : null;
      if (!mine()) return;
      if (folder) this.folderDefaults = folder;
      else void this.noteFolderDefaults();
      // Unless the mode changed meanwhile.
      const reset = folder && this.workMode() === "default" ? this.pendingReset : null;
      const overrides = this.overrides(reset ? folder : this.host.defaults(), reset !== null);
      this.planning = this.threadMode === "plan";
      this.proposed = null;
      const result = await this.host.client.call("turn/start", { threadId: this.id, input, clientUserMessageId: randomUUID(), ...overrides });
      if (this.closed) return;
      // Named once a turn is under way, so that Codex starts it first; when this one did
      // not start, by the message of the next that does.
      if (this.toName) {
        this.toName = false;
        this.host.nameThread(this.id, prompt.text);
      }
      if (!mine()) return;
      if (reset && this.pendingReset === reset) this.pendingReset = null;
      const { collaborationMode: collaboration, ...settings } = overrides as Partial<Applied> & { collaborationMode?: { mode: "plan" | "default" } };
      this.learn({ ...settings, ...(collaboration ? { collaborationMode: collaboration.mode } : {}) });
      if (this.turnOpen && this.turnID === null && this.starting) this.adopt(result.turn.id);
    } catch (error) {
      if (!mine()) return;
      this.starting = false;
      this.endTurn({ type: "turn.end", status: "error", error: `Codex could not start the turn: ${(error as Error).message}`, retryable: true });
    } finally {
      if (mine()) {
        this.beginning = null;
        this.starting = false;
      }
    }
  }

  /**
   * `/compact`. Codex answers at once and starts the turn that compacts the thread;
   * until `turn/started` names it, it is the turn being started.
   */
  private async compact(): Promise<void> {
    if (this.closed) return;
    const beginning = this.beginning = {};
    try {
      await this.subscribe();
      if (this.beginning !== beginning) return;
      await this.host.client.call("thread/compact/start", { threadId: this.id });
    } catch (error) {
      if (this.beginning !== beginning) return;
      this.starting = false;
      this.endTurn({ type: "turn.end", status: "error", error: `Codex could not compact the conversation: ${(error as Error).message}`, retryable: true });
    }
  }

  /**
   * What the thread's next turn is to run with, where Codex has it otherwise. `reset`:
   * the thread is back in `default` from another mode, whose policy is undone.
   */
  private overrides(defaults: DesktopDefaults | null, reset: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const applied = this.applied;
    const model = this.current.model;
    if (model && model !== "default" && model !== applied?.model) out.model = model;
    const effort = codexEffort(this.current.reasoningEffort, this.host.efforts(model));
    if (effort && effort !== applied?.effort) out.effort = effort;
    const work = this.workMode();
    const policy = work !== "default" || reset ? policyFor(work, defaults, this.cwd) : null;
    if (policy && !(same(policy.approvalPolicy, applied?.approvalPolicy) && same(policy.sandboxPolicy, applied?.sandboxPolicy))) {
      out.approvalPolicy = policy.approvalPolicy;
      out.sandboxPolicy = policy.sandboxPolicy;
    }
    // Plan mode with every turn of it, as a collaboration mode takes the place of the
    // model and level; Codex's default mode once, to leave it.
    const planning = this.threadMode === "plan";
    if (planning || applied?.collaborationMode === "plan") {
      const runsWith = model && model !== "default" ? model : applied?.model;
      if (runsWith) out.collaborationMode = collaborationMode(planning ? "plan" : "default", runsWith, effort ?? applied?.effort ?? null);
      else log.warn("Codex's plan mode needs a model, and this thread's is not known", { session: this.id });
    }
    // Reasoning text for the app's reasoning row, unless config.toml says otherwise.
    if (defaults && defaults.summary === null && applied?.summary !== "auto") out.summary = "auto";
    return out;
  }

  /** The message as Codex takes it: the text, then each image as a file in the bridge's folder. */
  private async input(prompt: Prompt): Promise<UserInput[]> {
    const input: UserInput[] = [];
    if (prompt.text !== "") input.push({ type: "text", text: prompt.text, text_elements: [] });
    let skipped = 0;
    for (const image of prompt.images) {
      if (!imageType(image.data)) {
        skipped += 1;
        continue;
      }
      // A folder of its own, so the file keeps the name the phone gave it.
      const folder = join(this.host.imagesDir, randomUUID());
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, image.filename);
      await writeFile(path, image.data, { mode: 0o600 });
      this.imageDirs.push(folder);
      input.push({ type: "localImage", path });
    }
    if (skipped > 0) this.sink.emit({ type: "notice", level: "warn", text: skippedImagesText(skipped, "Codex") });
    if (input.length === 0) input.push({ type: "text", text: "", text_elements: [] });
    return input;
  }

  /**
   * False when the turn ended before Codex took the message: it ended as the message
   * came, or before Codex named it. `refused` when Codex surely never had it: it said
   * no, or the message never went to it.
   */
  private async steerIn(prompt: Prompt): Promise<boolean | "refused"> {
    const turnID = await this.turnReady();
    if (!turnID) return "refused";
    try {
      await this.answersSent();
      const input = await this.input(prompt);
      if (!this.steerable()) return "refused";
      await this.host.client.call("turn/steer", { threadId: this.id, input, expectedTurnId: turnID, clientUserMessageId: randomUUID() });
      return true;
    } catch (error) {
      // Codex refuses a message for a turn that is no longer running (`expectedTurnId`),
      // and may say so before the bridge has heard that the turn ended. A message it
      // refused for any other reason, or that never went to it (Codex stayed away), it
      // has not taken either: it goes in a turn of its own after this one, as a no's note
      // must reach Codex (feature approval_notes). One whose answer was lost as the turn
      // ended Codex may have taken (false); one it said no to, or that never went, it has
      // not (`refused`).
      const notTaken = error instanceof CodexError && error.notTaken;
      if (await this.turnOver(turnID)) return notTaken ? "refused" : false;
      if (notTaken) return "refused";
      this.sink.emit({ type: "notice", level: "warn", text: `Codex did not take that message into the running turn: ${(error as Error).message}` });
      return true;
    }
  }

  /** The turn has ended, as the bridge has heard or else as Codex has it now. */
  private async turnOver(turnID: string): Promise<boolean> {
    if (!this.turnOpen || this.turnID !== turnID) return true;
    try {
      const turn = ((await this.read()).turns as Turn[] | undefined)?.find((entry) => entry.id === turnID);
      return turn !== undefined && turn.status !== "inProgress";
    } catch {
      return false;
    }
  }

  /** The running turn's id, once Codex has given it; null when no turn runs. */
  private turnReady(): Promise<string | null> {
    if (this.turnID) return Promise.resolve(this.turnID);
    if (!this.turnOpen) return Promise.resolve(null);
    return new Promise((resolve) => this.idWaiters.push(resolve));
  }

  /** A turn shows now (begun here, or elsewhere): the latest heard of, and one a reconnect is not to tell again. */
  private heard(turnID: string): void {
    this.lastKnownTurn = turnID;
    this.lastShownTurn = turnID;
    this.gap?.shown.add(turnID);
  }

  /**
   * The turn being started is `turnID`. It may be one begun at the desk a moment before,
   * which Codex took the message into: then it is the app's turn from now on, and its end
   * ends it.
   */
  private adopt(turnID: string): void {
    if (this.external === turnID) this.external = null;
    this.heard(turnID);
    this.turnID = turnID;
    this.starting = false;
    this.stream.beginTurn(turnID);
    for (const wake of this.idWaiters.splice(0)) wake(turnID);
  }

  private endTurn(event: Extract<ProviderEvent, { type: "turn.end" }>): void {
    if (!this.turnOpen) return;
    this.beginning = null;
    this.starting = false;
    // A turn of Codex's that said none adds nothing, and its time is not known: the bridge
    // times the whole. Kept under the last turn's id, also when that one said no tokens.
    if (this.carried) {
      const spent = addSpent(this.carried, event.spent ?? {}) ?? undefined;
      const agentTurn = event.agentTurn ?? this.turnID ?? this.carriedTurn;
      event = { ...event, spent, ...(agentTurn ? { agentTurn } : {}) };
    }
    this.carried = null;
    this.carriedTurn = null;
    this.turnOpen = false;
    this.turnID = null;
    this.runningUser = null;
    this.compacting = false;
    this.planning = false;
    this.proposed = null;
    this.stopAsked = false;
    this.closePlanCard();
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    for (const wake of this.idWaiters.splice(0)) wake(null);
    this.sink.emit(event);
    void this.removeImages();
  }

  // MARK: Plans

  /**
   * The plan a plan-mode turn ended with, put to the person while the app's turn goes
   * on. Start carries it out in the mode the thread had before planning, Keep planning
   * with a note sends the note in plan mode, and either way the next turn of Codex's is
   * part of this one; without a note, or when stopped, the turn ends.
   */
  private async offerPlan(plan: string, end: TurnEnd): Promise<void> {
    const card: PlanCard = { controller: new AbortController(), end, turn: this.turnID, away: false };
    this.turnID = null;
    this.planning = false;
    this.proposed = null;
    this.planCard = card;
    const startsIn = this.workMode();
    const answer = await this.sink.ask(planRequest(plan, startsIn), card.controller.signal);
    // Before Codex goes on with it, when the connection to Codex dropped meanwhile: a turn
    // begun at the desk then may have left the plan behind. The card stays the turn's
    // until this is known, so Stop or a turn begun at the desk now still close it.
    const goesOn = answer.kind === "approval" && (answer.choice !== "deny" || Boolean(answer.note));
    let current: boolean | Error = true;
    if (goesOn && card.away && this.planCard === card && !this.stopAsked) current = await this.planCurrent(card).catch((error: Error) => error);
    // Closed meanwhile (the thread, Stop, a turn begun at the desk, or the turn for another reason).
    if (this.planCard !== card) return;
    this.planCard = null;
    // Stopped after the answer came, before it was acted on.
    if (this.stopAsked) {
      this.endTurn({ ...end, status: "interrupted" });
      return;
    }
    if (current instanceof Error) {
      this.endTurn({ type: "turn.end", status: "error", error: `Codex could not say whether the thread has gone on without the plan, so it was not carried out: ${current.message}`, retryable: false });
      return;
    }
    if (!current) {
      this.endTurn(end);
      return;
    }
    if (answer.kind === "approval" && answer.choice !== "deny") {
      // Unless the mode was changed while the card was open.
      if (this.threadMode === "plan") {
        this.threadMode = startsIn;
        this.sink.emit({ type: "mode", mode: startsIn });
      }
      this.carry(end);
      this.goOn(implementPlanText);
    } else if (answer.kind === "approval" && answer.note) {
      this.carry(end);
      this.goOn(answer.note);
    } else {
      this.endTurn(answer.kind === "withdrawn" && answer.reason === "interrupted" ? { ...end, status: "interrupted" } : end);
    }
  }

  /**
   * What a turn of Codex's spent that the app's running turn goes on after (its plan's),
   * added to what the next spends at the app's turn's end (feature turn_usage).
   */
  private carry(end: TurnEnd): void {
    this.carried = addSpent(this.carried, end.spent ?? {});
    this.carriedTurn = end.agentTurn ?? this.carriedTurn;
  }

  /** A turn of Codex's that the app's running turn goes on with. */
  private goOn(text: string): void {
    this.starting = true;
    void this.begin({ text, images: [] });
  }

  private closePlanCard(): void {
    const card = this.planCard;
    this.planCard = null;
    card?.controller.abort("withdrawn");
  }

  private async removeImages(): Promise<void> {
    const folders = this.imageDirs.splice(0);
    await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true }).catch(() => undefined)));
  }

  // MARK: From Codex

  /** A notification about this thread. */
  notification(method: string, params: Params): void {
    if (this.readOnly) return;
    if (!this.isAttached) {
      this.held.push({ kind: "notification", method, params });
      return;
    }
    if (this.reading) {
      const turn = openedTurn(method, params);
      const first = turn !== undefined && heardClears(this.reading, turn) === undefined;
      this.reading.push(first ? { method, params, clears: this.agents.ended() } : { method, params });
      return;
    }
    this.handle(method, params);
  }

  /**
   * A notification about a sub-agent working for this thread, whose questions are this
   * thread's cards: what they need, the changes they are about and whether someone
   * answered them elsewhere. Held with their questions until the bridge's side is wired
   * up, so an answer given meanwhile closes the card it answers.
   */
  subAgentNotification(method: string, params: Params): void {
    if (this.readOnly) return;
    if (!this.isAttached) {
      this.held.push({ kind: "subAgent", method, params });
      return;
    }
    if (method === "serverRequest/resolved") {
      this.resolved(params.requestId);
      return;
    }
    const item = params.item ?? {};
    if ((method === "item/started" || method === "item/completed") && item.type === "fileChange" && Array.isArray(item.changes)) this.changes.set(item.id, item.changes);
  }

  /** `heard`: for one held while the thread was read, what its turn's message may clear (`HeldNotification`). */
  private handle(method: string, params: Params, heard?: EndedSubagent[]): void {
    if (this.backgroundTerminal(method, params)) return;
    switch (method) {
      case "turn/started": {
        const id = params.turn?.id;
        if (typeof id !== "string") return;
        // One begun elsewhere counts as heard of once it shows (its message, or its
        // compaction): until then, a reconnect still looks for it (`joinMissed`).
        if (this.turnOpen) {
          // The answer to turn/start may come after the turn's first notifications.
          if (this.turnID === null && this.starting) this.adopt(id);
          else if (this.planCard && this.turnID === null) {
            // Begun at the desk while the plan card waits: the thread has gone on without
            // it, so the card closes and the app's turn ends; the desk's turn shows as its own.
            this.endTurn(this.planCard.end);
            this.external = id;
            this.stream.beginTurn(id);
          }
          return;
        }
        // Begun elsewhere: shown once its message arrives.
        this.external = id;
        this.stream.beginTurn(id);
        return;
      }
      case "turn/completed": {
        const id = params.turn?.id;
        if (typeof id === "string") this.lastEnded = id;
        // The turn the grace timer ended has now ended in Codex too.
        if (id === this.abandoned) this.abandoned = null;
        if (id === this.external) {
          this.external = null;
          return;
        }
        if (!this.turnOpen) return;
        if (this.turnID === null && this.starting) this.adopt(id);
        if (id !== this.turnID) return;
        this.reportEnd(this.stream.map(method, params), params.turn?.status);
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = params.item ?? {};
        // A `/compact` begun at the desk: it has no message, and its compaction opens it.
        if (item.type === "contextCompaction" && !this.turnOpen && this.external !== null && params.turnId === this.external) {
          this.turnOpen = true;
          this.turnID = this.external;
          this.heard(this.external);
          this.external = null;
          this.compacting = true;
          this.runningUser = `/${compactCommand}`;
          this.sink.emit({ type: "turn.begin", user: this.runningUser, command: true });
          if (!this.subscribed) {
            this.subscribe().catch((error: Error) => log.warn("could not follow a Codex thread a turn began in", { session: this.id, error: error.message }));
          }
        }
        if (item.type === "userMessage" && !this.turnOpen && this.external !== null && params.turnId === this.external) {
          this.turnOpen = true;
          this.turnID = this.external;
          this.heard(this.external);
          this.external = null;
          // Held as the bridge caught up: it clears what had ended when it came.
          this.sink.emit(heard ? { type: "turn.begin", user: userInputText(item.content), clears: heard, command: false } : { type: "turn.begin", user: userInputText(item.content), command: false });
          // Shown as running, it is followed, so its questions come here too: Codex tells of a
          // thread the bridge let go of (after a reconnect, say), but asks only who follows it.
          if (!this.subscribed) {
            this.subscribe().catch((error: Error) => log.warn("could not follow a Codex thread a turn began in", { session: this.id, error: error.message }));
          }
        }
        // Taken for a `/compact` when it was loaded with nothing in it: a turn with a message
        // is one like any other, which takes more, and was opened by that message.
        if (item.type === "userMessage" && this.compacting && this.turnOpen && params.turnId === this.turnID) {
          this.compacting = false;
          if (this.runningUser === `/${compactCommand}`) {
            this.runningUser = userInputText(item.content);
            this.sink.emit({ type: "turn.opener", user: this.runningUser });
          }
        }
        if (method === "item/completed" && item.type === "plan" && typeof item.text === "string" && this.planning && params.turnId === this.turnID) this.proposed = item.text;
        if (item.type === "fileChange" && Array.isArray(item.changes)) this.changes.set(item.id, item.changes);
        this.noteAgents(method, item);
        break;
      }
      case "serverRequest/resolved":
        this.resolved(params.requestId);
        return;
      case "thread/settings/updated": {
        const settings = params.threadSettings ?? {};
        this.learn({
          model: settings.model,
          effort: settings.effort,
          approvalPolicy: settings.approvalPolicy,
          sandboxPolicy: settings.sandboxPolicy,
          summary: settings.summary,
          collaborationMode: settings.collaborationMode?.mode,
        });
        return;
      }
      case "thread/status/changed":
        if (params.status?.type === "notLoaded") this.subscribed = false;
        return;
      case "thread/closed":
        this.subscribed = false;
        return;
      case "warning":
        // the config.toml makes one at every thread start; nothing for the phone.
        log.info("Codex warning", { session: this.id, message: params.message });
        return;
      case "thread/tokenUsage/updated":
      case "thread/name/updated":
        this.report(this.stream.map(method, params));
        return;
      default:
        break;
    }
    // The rest belongs to the running turn.
    if (typeof params.turnId === "string" && params.turnId !== this.turnID) {
      if (this.turnOpen && this.turnID === null && this.starting) this.adopt(params.turnId);
      else return;
    }
    this.report(this.stream.map(method, params));
  }

  // MARK: Sub-agents

  /**
   * The sub-agents an item says the thread spawned or waits on, whose rows go on after
   * the turn. A `subAgentActivity` item completes as it starts, saying the same.
   */
  private noteAgents(method: string, item: Params): void {
    if (method === "item/completed" || item.type !== "subAgentActivity") {
      for (const subagent of this.agents.item(item)) this.sink.emit({ type: "subagent", subagent });
    }
    // What one answered, and the turn it runs, are in its own thread.
    if (method === "item/completed" && item.type === "subAgentActivity" && typeof item.agentThreadId === "string") void this.describeAgent(item.agentThreadId);
  }

  /** Whether `thread` is a sub-agent this thread spawned. */
  ownsAgent(thread: string): boolean {
    return this.agents.has(thread);
  }

  /**
   * Codex started a thread with this one as its parent, or with one of its sub-agents as
   * its parent: a sub-agent, shown on the line with the others. `started`: the thread as
   * Codex gave it, with the sub-agent's nickname and role.
   */
  agentStarted(thread: string, started?: Params): void {
    if (this.readOnly || !this.isAttached) return;
    const subagent = this.agents.adopt(thread, started);
    if (subagent) this.sink.emit({ type: "subagent", subagent });
  }

  /** A notification of a sub-agent's own thread. */
  agentNotification(thread: string, method: string, params: Params): void {
    if (this.readOnly || !this.isAttached) return;
    this.nestedAgents(thread, method, params);
    const subagent = this.agents.child(thread, method, params);
    if (subagent) this.sink.emit({ type: "subagent", subagent });
    if (method === "thread/status/changed" || (method === "turn/completed" && !subagent)) void this.describeAgent(thread);
  }

  /**
   * The sub-agents one of this thread's sub-agents spawns, from its items: Codex does not
   * tell this thread's follower of their own threads, so their names and answers are read
   * from their threads as they start and end.
   */
  private nestedAgents(thread: string, method: string, params: Params): void {
    const item = params.item ?? {};
    if ((method !== "item/started" && method !== "item/completed") || (item.type !== "subAgentActivity" && item.type !== "collabAgentToolCall")) return;
    for (const subagent of this.agents.item(item, thread)) {
      this.sink.emit({ type: "subagent", subagent });
      // Its nickname as it starts, its answer once it has ended.
      if (method === "item/completed" && item.type === "subAgentActivity") void this.describeAgent(subagent.id);
    }
  }

  pastSubagents(): { subagent: SubagentInfo; turn: number }[] {
    return structuredClone(this.past);
  }

  /**
   * Catches up the sub-agents that may have changed while the bridge could not hear:
   * those at work, and those that ended lately, which may have been given more to do
   * (`toSettle`). A few reads at a time: a reconnect does this for every open thread.
   */
  private settleAgents(): void {
    if (this.readOnly) return;
    this.readAgents(this.agents.toSettle(settleWithinMs));
  }

  /** Reads these sub-agents' threads (`describeAgent`), a few at a time. */
  private readAgents(ids: readonly string[]): void {
    let next = 0;
    const reader = async () => {
      while (next < ids.length) await this.describeAgent(ids[next++]!);
    };
    for (let count = 0; count < Math.min(settleReads, ids.length); count += 1) void reader();
  }

  /** Reconciles a sub-agent's state and answer against its current thread. */
  private async describeAgent(thread: string): Promise<Thread | null> {
    // Live news while the read is on its way takes precedence over its snapshot.
    const since = this.agents.revision(thread);
    const reading = {};
    this.agentReads.set(thread, reading);
    try {
      const read = await readThread(this.host.client, thread);
      if (this.agentReads.get(thread) !== reading) return read;
      // Caught between two states (given more to do, or just finished): looked at again
      // a little later, a few times, before the read is taken for what it says.
      const looked = this.agentLooked.get(thread) ?? 0;
      const again = looked < agentLooks && betweenStates(read);
      const subagent = this.agents.described(thread, read, since, !again);
      if (subagent) this.sink.emit({ type: "subagent", subagent });
      // Its own sub-agents the bridge had not heard of (spawned before a restart): on the
      // line, under it, and read for their state, names and own sub-agents in turn.
      const nested = this.agents.nestedIn(thread, read);
      for (const found of nested) this.sink.emit({ type: "subagent", subagent: found });
      this.readAgents(nested.map((found) => found.id));
      if (again) this.lookAgain(thread, looked + 1);
      else this.agentLooked.delete(thread);
      return read;
    } catch (error) {
      log.debug("could not read a sub-agent's thread", { session: this.id, thread, error: (error as Error).message });
      return null;
    } finally {
      if (this.agentReads.get(thread) === reading) this.agentReads.delete(thread);
    }
  }

  /** Reads a sub-agent's thread again, `looked` looks after the one that caught it between two states. */
  private lookAgain(thread: string, looked: number): void {
    this.agentLooked.set(thread, looked);
    const timer = setTimeout(() => {
      this.lookTimers.delete(timer);
      if (this.isAttached) void this.describeAgent(thread);
    }, agentLookMs * looked);
    timer.unref();
    this.lookTimers.add(timer);
  }

  /**
   * What a command left running in the background says after its turn: more output, or
   * its end (with the whole of its output and its exit code), which its row on the
   * subagents line and its tool row both take. True when it was about one of those.
   */
  private backgroundTerminal(method: string, params: Params): boolean {
    // Only the turn it began in: an id Codex gave again in another turn is another item.
    const ours = (id: unknown): id is string => typeof id === "string" && this.terminals.running(id)
      && (typeof params.turnId !== "string" || (this.terminalProcesses.get(id)?.turn ?? params.turnId) === params.turnId);
    if (method === "item/commandExecution/outputDelta") {
      if (!ours(params.itemId)) return false;
      if (typeof params.delta === "string") this.terminals.append(params.itemId, params.delta);
      return true;
    }
    const item = params.item ?? {};
    if (method !== "item/completed" || item.type !== "commandExecution" || !ours(item.id)) return false;
    const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined;
    const failed = item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
    const code = typeof item.exitCode === "number" ? `Exited with code ${item.exitCode}.` : undefined;
    this.terminals.end(item.id, failed ? "failed" : "completed", { ...(output !== undefined ? { output } : {}), ...(failed && code ? { result: code } : {}) });
    this.terminalProcesses.delete(item.id);
    // Its tool row, closed when the turn ended, takes its whole result in its place.
    const tool = gatewayTool(item);
    if (tool) this.sink.emit({ type: "tool.end", id: item.id, name: tool.name, args: tool.args, result: gatewayResult(item, this.cwd), ...(typeof item.durationMs === "number" ? { durationSeconds: item.durationMs / 1000 } : {}) });
    return true;
  }

  /** Stops one sub-agent's running turn, or a command left running in the background; this thread's turn, and the others, go on. */
  async stopSubagent(id: string): Promise<boolean> {
    if (this.terminals.running(id)) {
      const processId = this.terminalProcesses.get(id)?.process;
      if (!processId) return false;
      const answer = await this.host.client.call<{ terminated?: boolean }>("thread/backgroundTerminals/terminate", { threadId: this.id, processId });
      return answer?.terminated === true;
    }
    if (!this.agents.has(id)) return false;
    // Its own thread says which turn it runs, when its notifications did not: the
    // read's own answer, also when newer news (a change of its status meanwhile) keeps
    // the read out of the row.
    let turnID = this.agents.runningTurn(id);
    if (!turnID) {
      const read = await this.describeAgent(id);
      turnID = this.agents.runningTurn(id) ?? this.agents.turnIn(id, read);
    }
    if (!turnID) return false;
    await this.host.client.call("turn/interrupt", { threadId: id, turnId: turnID });
    return true;
  }

  private report(events: ProviderEvent[]): void {
    for (const event of events) {
      if (event.type === "turn.end") {
        this.endTurn(event);
        continue;
      }
      const inTurnOnly =
        event.type === "text" ||
        event.type === "reasoning" ||
        event.type === "commentary" ||
        event.type === "tool.start" ||
        event.type === "tool.end" ||
        event.type === "compacted" ||
        event.type === "questions";
      if (inTurnOnly && !this.turnOpen) continue;
      this.sink.emit(event);
    }
  }

  /**
   * What ends a turn of Codex's: the app's turn ends with it, unless the turn was one of
   * plan mode that completed with a plan, which is put to the person first. Not after
   * Stop: Codex may have completed the turn as Stop came (or while the bridge was away),
   * and the turn ends as Codex ended it.
   */
  private reportEnd(events: ProviderEvent[], status: string | undefined): void {
    const end = events.find((event): event is TurnEnd => event.type === "turn.end");
    const plan = this.proposed;
    if (!end || !this.planning || this.stopAsked || !plan?.trim() || status !== "completed") {
      this.report(events);
      return;
    }
    this.report(events.filter((event) => event !== end));
    void this.offerPlan(plan, end);
  }

  /** The account's usage limits changed: warns a thread at work once a limit is near. */
  rateLimits(limits: RateLimitSnapshot): void {
    if (!this.isAttached || !this.turnOpen) return;
    for (const event of rateLimitNotices(limits, this.warned, this.host.timeZone)) this.sink.emit(event);
  }

  // MARK: Requests

  /** A request from Codex about this thread. */
  request(id: RequestId, method: string, params: Params): void {
    // Left to whoever follows the thread (a terminal).
    if (this.readOnly) return;
    if (!this.isAttached) {
      this.held.push({ kind: "request", id, method, params });
      return;
    }
    switch (method) {
      case commandApproval:
      case fileChangeApproval:
      case userInput:
        void this.ask(id, method, params);
        return;
      case "item/permissions/requestApproval":
        // Nothing granted: Codex goes on without the extra access.
        this.host.client.respond(id, { permissions: {}, scope: "turn" });
        this.sink.emit({ type: "notice", level: "warn", text: `Codex asked for more access${params.reason ? ` (${params.reason})` : ""}. Portals cannot grant that, so it goes on without it.` });
        return;
      case elicitation:
        // Whether an MCP tool may run: a card like a command's.
        if (isToolApproval(method, params)) {
          void this.ask(id, method, params);
          return;
        }
        this.host.client.respond(id, { action: "decline", content: null, _meta: null });
        this.sink.emit({ type: "notice", level: "warn", text: `${params.serverName ? `The ${params.serverName} tool` : "A tool"} asked for input Portals cannot give, so it was declined.` });
        return;
      case "currentTime/read":
        this.host.client.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
        return;
      default:
        this.host.client.respondError(id, -32601, `Portals does not handle ${method}.`);
    }
  }

  private async ask(id: RequestId, method: string, params: Params): Promise<void> {
    const match = requestKey(method, params);
    // A tool approval has no id of its own: two calls of one tool with the same arguments
    // ask alike, so one asked while the other is open on this connection is another
    // request, and only a card from before a drop (or one asked with this very id) stands
    // for it. Any other request names its item, and is the same one however it comes.
    const named = method !== elicitation;
    const known = [...this.pending.values()].find((entry) => entry.match === match && (named || !entry.live || idKey(entry.codexID) === idKey(id)));
    if (known) {
      // Asked again (after a reconnect): the card that is open already stands for it.
      known.codexID = id;
      known.live = true;
      if (known.answer !== undefined) {
        this.pending.delete(known.key);
        this.host.client.respond(id, known.answer);
        this.answersGone();
      }
      return;
    }
    const key = `${match}#${++this.asked}`;
    // Registered at once, so an answer from elsewhere meanwhile is noticed.
    const entry: Pending = { key, match, codexID: id, method, controller: new AbortController(), live: true };
    this.pending.set(key, entry);
    let request: AgentRequest;
    if (method === userInput) {
      request = clarifyRequest(params);
      if (request.kind === "clarify" && request.questions.length === 0) {
        this.pending.delete(key);
        this.host.client.respond(id, { answers: {} });
        return;
      }
    } else {
      request = approvalRequest(method, params, this.cwd, method === fileChangeApproval ? await this.changesOf(params.itemId, params.threadId) : undefined);
    }
    // Asked by a sub-agent of this thread, however deep (the provider hands a question about
    // another thread here only when this one is the thread it works for), which may work on
    // after this thread's turn: its card may outlive the turn too (feature subagents), and
    // what the user says with a no is said to the sub-agent, not to this thread.
    const subAgent = typeof params.threadId === "string" && params.threadId !== this.id ? params.threadId : undefined;
    if (subAgent !== undefined) {
      request.subagent = subAgent;
      if (request.kind === "approval") request.takesNote = true;
    }
    if (this.pending.get(key) !== entry) return;
    // A question keeps a row of its own in the thread, shown as asked and answered (Codex's
    // history keeps none of it), as Claude's do.
    const row = request.kind === "clarify" ? clarifyRow(params, request) : null;
    if (row) this.sink.emit({ type: "tool.start", ...row });
    const answer = await this.sink.ask(request, entry.controller.signal);
    if (row) this.sink.emit({ type: "tool.end", ...row, result: clarifyResult(params, answer) });
    if (this.pending.get(key) !== entry) return;
    const response = responseFor(method, params, answer, subAgent !== undefined);
    if (response === null) {
      this.pending.delete(key);
      return;
    }
    if (entry.live) {
      this.pending.delete(key);
      this.host.client.respond(entry.codexID, response);
    } else {
      entry.answer = response;
    }
    if (subAgent !== undefined && answer.kind === "approval" && answer.choice === "deny" && answer.note) {
      void this.tellSubAgent(subAgent, params.turnId, answer.note);
    }
  }

  /**
   * What the user said with a no to a sub-agent's question, steered into the sub-agent's
   * turn once the no has gone (`answersSent`), as a note to this thread's own question is
   * (feature approval_notes). A sub-agent whose turn is over is not started again for it.
   */
  private async tellSubAgent(threadID: string, turnID: unknown, note: string): Promise<void> {
    try {
      if (typeof turnID !== "string") throw new Error("the sub-agent's turn is not known");
      await this.answersSent();
      const input = [{ type: "text", text: note, text_elements: [] }];
      await this.host.client.call("turn/steer", { threadId: threadID, input, expectedTurnId: turnID, clientUserMessageId: randomUUID() });
    } catch (error) {
      log.debug("could not tell a sub-agent what was said with a no", { session: this.id, subAgent: threadID, error: (error as Error).message });
      this.sink.emit({ type: "notice", level: "warn", text: "What you said with the no could not be given to the sub-agent." });
    }
  }

  /**
   * The changes a file-change approval is about: from its item, else from the running
   * turn as `thread/resume` reports it (`thread/read` leaves out items in progress), of
   * this thread or of the sub-agent asking (`threadID`).
   */
  private async changesOf(itemID: unknown, threadID: unknown): Promise<FileUpdateChange[] | undefined> {
    if (typeof itemID !== "string") return undefined;
    const known = this.changes.get(itemID);
    if (known) return known;
    try {
      const result = await this.host.client.call("thread/resume", { threadId: typeof threadID === "string" ? threadID : this.id });
      const item = ((result.thread?.turns?.at(-1)?.items ?? []) as Params[]).find((entry) => entry.id === itemID);
      if (item?.type === "fileChange" && Array.isArray(item.changes)) return item.changes;
    } catch (error) {
      log.debug("could not find the change an approval is about", { session: this.id, error: (error as Error).message });
    }
    return undefined;
  }

  /** Someone answered (a terminal on the same thread), or Codex took the request back. */
  private resolved(requestID: RequestId): void {
    if (requestID === undefined || requestID === null) return;
    const wanted = idKey(requestID);
    for (const entry of this.pending.values()) {
      if (entry.live && idKey(entry.codexID) === wanted) {
        this.pending.delete(entry.key);
        entry.controller.abort("resolved");
        return;
      }
    }
  }

  // MARK: The connection

  /** The connection to Codex dropped: nothing is followed until it is back. */
  connectionLost(): void {
    this.down = true;
    for (const settle of [...this.reachWaiters]) settle(unreachableText);
    this.subscribed = false;
    this.gap ??= { after: this.lastKnownTurn, shown: new Set() };
    if (!this.recovery) {
      let resolve: () => void = () => {};
      const done = new Promise<void>((settle) => (resolve = settle));
      this.recovery = { done, resolve };
    }
    this.stream.connectionLost();
    this.drops += 1;
    if (this.planCard) this.planCard.away = true;
    for (const entry of this.pending.values()) entry.live = false;
  }

  /** While the bridge is not back in step with the thread after a drop of the connection to Codex: resolves once it is. */
  catchingUp(): Promise<void> | undefined {
    return this.recovery?.done;
  }

  /** Back in step with the thread (or given up on that): a message waiting for it goes on. */
  private caughtUp(): void {
    const recovery = this.recovery;
    this.recovery = null;
    recovery?.resolve();
    for (const settle of [...this.reachWaiters]) settle(undefined);
  }

  /**
   * For a message that began to wait for `catchingUp` at `since`: once a call to Codex
   * would have given up on it (`readyMs` after `since`), why Codex cannot be reached when
   * the connection is down then, or when it next drops while the bridge, back on it, still
   * reads the thread; undefined once the bridge is back in step first, or `signal` stops it.
   */
  unreachable(since: number, signal: AbortSignal): Promise<string | undefined> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const settle = (reason: string | undefined) => {
        if (timer) clearTimeout(timer);
        timer = null;
        this.reachWaiters.delete(settle);
        signal.removeEventListener("abort", stopped);
        resolve(reason);
      };
      const stopped = () => settle(undefined);
      if (signal.aborted) return settle(undefined);
      signal.addEventListener("abort", stopped, { once: true });
      timer = setTimeout(() => {
        timer = null;
        if (!this.recovery) settle(undefined);
        else if (this.down) settle(unreachableText);
        // Back on the connection, reading the thread: Codex answers, and the message goes
        // once the read is done, unless the connection drops first.
        else this.reachWaiters.add(settle);
      }, Math.max(0, since + this.host.readyMs - Date.now()));
      timer.unref();
    });
  }

  /**
   * The connection is back: follows the thread again (Codex asks its open questions
   * again), catches up on a turn that ran meanwhile, and closes cards nobody will
   * answer any more. A thread with neither, which Codex no longer has loaded (`loaded`,
   * null when Codex could not say; it restarted, say), is followed again at its next
   * message, as after a restart of the bridge: following it now would load it, starting
   * its MCP servers for nothing. Whether it has neither is asked once Codex has answered:
   * a turn may have begun meanwhile (at the desk, or a message sent).
   */
  reconnected(loaded: Promise<Set<string> | null>): Promise<void> {
    this.down = false;
    // One after another: a reconnect whose connection dropped again ends (what it asked
    // fails at once) before the next reads the thread, which then tells what was missed.
    const run = this.reconnecting.then(() => this.followAgain(loaded));
    this.reconnecting = run.catch(() => undefined);
    return run;
  }

  /** `reconnected`, once the reconnect before it is over. */
  private async followAgain(loaded: Promise<Set<string> | null>): Promise<void> {
    // A sub-agent may have ended while Codex could not say so.
    if (this.isAttached) this.settleAgents();
    // Not followed again: what it missed shows when it is opened again, as before.
    if (!this.following && this.pending.size === 0 && !this.turnOpen) {
      this.gap = null;
      this.caughtUp();
      return;
    }
    const drops = this.drops;
    // What Codex says of the thread from when it is followed again waits until the turns
    // it missed are told: a turn begun at the desk meanwhile comes after them.
    const held: HeldNotification[] | null = !this.turnOpen && !this.reading ? [] : null;
    if (held) this.reading = held;
    try {
      const live = await loaded;
      if (!this.subscribed && this.pending.size === 0 && !this.turnOpen && live?.has(this.id) === false) {
        this.following = false;
        this.gap = null;
        return;
      }
      await this.subscribe();
      if (this.turnOpen && this.turnID) await this.catchUp(this.turnID);
      else if (this.planCard) await this.planOvertaken(this.planCard);
      // Turns begun at the desk meanwhile, whose starts and messages were missed.
      if (!this.turnOpen) await this.joinMissed(held ?? undefined);
    } catch (error) {
      log.warn("could not follow a Codex thread again", { session: this.id, error: (error as Error).message });
    } finally {
      // Not taken by joinMissed (it did not get that far): what it held goes on now.
      if (held && this.reading === held) {
        this.reading = null;
        this.release(held, new Set());
      }
      // Dropped again meanwhile: the next reconnect brings it back in step.
      if (this.drops === drops) this.caughtUp();
    }
    setTimeout(() => {
      // Dropped again since: what was not asked again belongs to the next reconnect, and an
      // answer given meanwhile waits for it.
      if (this.drops !== drops) return;
      for (const entry of [...this.pending.values()]) {
        if (entry.live) continue;
        // Answered elsewhere while the bridge was away.
        this.pending.delete(entry.key);
        entry.controller.abort("resolved");
      }
      this.answersGone();
    }, redeliveryGraceMs).unref();
  }

  /**
   * Resolves once no answer given while Codex was away waits for Codex to ask again (it
   * is sent then, or let go when Codex does not ask), so that what is steered in reaches
   * Codex after it: the note said with a no comes after the no (feature approval_notes).
   * Throws when Codex does not come back in time.
   */
  private async answersSent(): Promise<void> {
    if (!this.holdsAnswers) return;
    await this.host.client.whenReady();
    if (this.holdsAnswers) await new Promise<void>((resolve) => this.answerWaiters.push(resolve));
  }

  private get holdsAnswers(): boolean {
    return [...this.pending.values()].some((entry) => entry.answer !== undefined);
  }

  /** An answer held while Codex was away has gone: what waited for the last one goes on. */
  private answersGone(): void {
    if (this.holdsAnswers) return;
    for (const resolve of this.answerWaiters.splice(0)) resolve();
  }

  /**
   * The plan card waited while the connection to Codex was down: a turn begun at the
   * desk meanwhile has left the plan behind, so the card closes and the app's turn ends.
   */
  private async planOvertaken(card: PlanCard): Promise<void> {
    // When Codex cannot say, the card stays: an answer to it is checked again.
    const current = await this.planCurrent(card).catch(() => true);
    if (!current && this.planCard === card) this.endTurn(card.end);
  }

  /** No turn has begun in the thread since the plan's. Throws when Codex cannot say. */
  private async planCurrent(card: PlanCard): Promise<boolean> {
    const last = ((await this.read({ latest: true })).turns as Turn[] | undefined)?.at(-1);
    return !last || last.id === card.turn;
  }

  /**
   * The thread's turns that began while the connection was down (at the desk), whose
   * starts were missed: each shows as a turn of its own from its message, as one whose
   * start came would. One that has ended is told whole, from what Codex kept of it; one
   * Codex runs now is followed from here. When the turn last heard of is not among the
   * thread's turns any more, nothing is told.
   */
  private async joinMissed(given?: HeldNotification[]): Promise<void> {
    // Another reconnect's reading tells it.
    if (this.reading && this.reading !== given) return;
    const held = given ?? [];
    this.reading = held;
    // Turns known already, or told whole from the read: what Codex sent of them meanwhile is told.
    const told = new Set<string>();
    try {
      const after = this.gap ? this.gap.after : this.lastKnownTurn;
      const through = [after, this.external].filter((id): id is string => id !== null);
      const thread = await this.read({ through: this.withBackgroundTurns(through) });
      this.terminalsEnded(thread);
      // A wait among what was missed names the sub-agents it waited for as live: their
      // nicknames, which only their own threads say, as their starts were missed too.
      await this.learnNicknames(thread);
      await this.tellMissed(thread, told);
    } finally {
      if (this.reading === held) this.reading = null;
      this.release(held, told);
    }
  }

  /** Commands left running in the background that the thread, as Codex read it, has ended (while the connection was down). */
  private terminalsEnded(thread: Thread): void {
    for (const turn of (thread.turns ?? []) as Turn[]) {
      for (const item of (turn.items ?? []) as Params[]) {
        if (item.type === "commandExecution" && item.status !== "inProgress") this.backgroundTerminal("item/completed", { turnId: turn.id, item });
      }
    }
  }

  /** What Codex sent while the thread was read, after what it missed, as it came; but not again what `told` turns said. */
  private release(held: HeldNotification[], told: Set<string>): void {
    for (const { method, params } of held) {
      // A command left running in the background goes on after its turn, told or not: what it says is its row's.
      if (this.backgroundTerminal(method, params)) continue;
      const turn = params.turnId ?? params.turn?.id;
      if (typeof turn === "string" && told.has(turn)) {
        // The turn the grace timer ended has ended in Codex too.
        if (method === "turn/completed" && turn === this.abandoned) this.abandoned = null;
        // What the read cannot say: the sub-agents it spawned, which may still be at work.
        if (method === "item/started" || method === "item/completed") this.noteAgents(method, params.item ?? {});
        continue;
      }
      this.handle(method, params, heardClears(held, typeof turn === "string" ? turn : null));
    }
  }

  /**
   * `joinMissed` with the thread as Codex read it; `told` takes the turns it has told, or
   * knew of already. Once every turn after the one last heard of before the drop is told
   * or shown, the gap is closed; one left (a turn running meanwhile) is told when it ends.
   */
  private async tellMissed(thread: Thread, told: Set<string>): Promise<void> {
    if (this.turnOpen) return;
    const turns = (thread.turns ?? []) as Turn[];
    const cursor = this.gap ? this.gap.after : this.lastKnownTurn;
    let known = cursor === null ? -1 : turns.findIndex((turn) => turn.id === cursor);
    if (this.external !== null) {
      // Begun at the desk just before the connection dropped, its message missed with it:
      // told from it, once it has one (until then, its message is still to come).
      const begun = turns.findIndex((turn) => turn.id === this.external);
      const turn = turns[begun];
      const shows = (turn?.items as Params[] | undefined)?.some((item) => item.type === "userMessage" || item.type === "contextCompaction");
      if (!turn || (turn.status === "inProgress" && !shows)) return;
      this.external = null;
      // Not past turns missed before it (in an earlier drop, whose reading failed).
      known = cursor === null || known !== -1 ? Math.min(known, begun - 1) : begun - 1;
    } else if (cursor !== null && known === -1) {
      // The turn last heard of is gone from the thread: nothing to tell from.
      this.gap = null;
      return;
    }
    for (const turn of turns.slice(0, known + 1)) told.add(turn.id);
    // Turns since the one last heard of spent tokens the bridge never heard of: the
    // thread's total it knows is behind, and would put them on the next turn.
    if (turns.length > known + 1) this.stream.forgetTotal();
    const order = new Map(turns.map((turn, index) => [turn.id, index]));
    // The last turn shown since the drop: one missed before it can no longer be told in order.
    const lastShown = turns.reduce((last, turn, index) => (this.gap?.shown.has(turn.id) ? index : last), -1);
    for (const [index, turn] of turns.entries()) {
      if (index <= known) continue;
      if (this.turnOpen || this.external !== null) return;
      // Shown already, since the drop: it stays where it showed, and what Codex said of it
      // meanwhile is not said again (unless it runs now).
      if (this.gap?.shown.has(turn.id)) {
        if (turn.id !== this.turnID) told.add(turn.id);
        continue;
      }
      if (index < lastShown) {
        // Told now, it would come after a later turn, as the thread's latest: left as before.
        log.info("a Codex turn missed while the connection was down is not told: a later one has shown", { session: this.id, turn: turn.id });
        told.add(turn.id);
        continue;
      }
      const before = this.lastKnownTurn;
      // The latest heard of never goes back to an earlier one told now.
      if ((order.get(before ?? "") ?? -1) < index) this.lastKnownTurn = turn.id;
      this.gap?.shown.add(turn.id);
      if (turn.id === this.abandoned) continue;
      if (turn.status !== "inProgress") {
        this.tellWhole(turn);
        told.add(turn.id);
        continue;
      }
      // Only the last one can still be running.
      if (turn !== turns.at(-1)) continue;
      if (turn.id === this.lastEnded) {
        // It ended while it was being read: told whole, as Codex has it now. When Codex
        // cannot say, it is still to be told, at the next reconnect.
        let ended: Turn | undefined;
        try {
          ended = ((await this.read({ through: [turn.id] })).turns as Turn[] | undefined)?.find((entry) => entry.id === turn.id);
        } catch (error) {
          if (this.lastKnownTurn === turn.id) this.lastKnownTurn = before;
          this.gap?.shown.delete(turn.id);
          throw error;
        }
        if (!this.turnOpen && this.external === null && ended && ended.status !== "inProgress") {
          this.tellWhole(ended);
          told.add(ended.id);
        }
      } else if (thread.status?.type === "active") {
        this.joinRunning(turn);
      }
    }
    if (!this.turnOpen || this.turnID === turns.at(-1)?.id) this.gap = null;
  }

  /**
   * What the message of a turn told from the read takes off the subagents line: the
   * sub-agents that had ended when it was heard, if it came while held; none when it was
   * missed (never heard), since it came before what the bridge heard meanwhile.
   */
  private clearsFor(turn: string): EndedSubagent[] {
    return heardClears(this.reading, turn) ?? [];
  }

  /** A turn that ended while the connection was down: told whole, opened by its message, or as a `/compact`. */
  private tellWhole(turn: Turn): void {
    const opener = (turn.items as Params[]).find((item) => item.type === "userMessage");
    // Neither said anything nor compacted: nothing to tell.
    if (!opener && !(turn.items as Params[]).some((item) => item.type === "contextCompaction")) return;
    this.turnOpen = true;
    this.turnID = turn.id;
    this.stream.beginTurn(turn.id);
    // Its message opens it; any after it were steered in.
    if (opener) this.stream.known([opener]);
    this.sink.emit({ type: "turn.begin", user: opener ? userInputText(opener.content) : `/${compactCommand}`, clears: this.clearsFor(turn.id), command: !opener });
    // Told in the thread's order, after any shown since the drop: the latest shown now.
    this.lastShownTurn = turn.id;
    this.reportEnd(this.stream.reconcile(turn), turn.status);
  }

  /**
   * A turn Codex runs now that began while the connection was down: shown as a turn of
   * its own from its message, with what it did before the connection was back, and
   * followed from here. One with no message yet (Codex runs hooks first) opens once its
   * message comes, as one whose start came would.
   */
  private joinRunning(turn: Turn): void {
    const items = turn.items as Params[];
    const opener = items.find((item) => item.type === "userMessage");
    const compaction = !opener && items.some((item) => item.type === "contextCompaction");
    this.stream.beginTurn(turn.id, true);
    if (!opener && !compaction) {
      this.external = turn.id;
      return;
    }
    this.turnOpen = true;
    this.turnID = turn.id;
    this.runningUser = opener ? userInputText(opener.content) : `/${compactCommand}`;
    this.compacting = compaction;
    if (opener) this.stream.known([opener]);
    for (const item of items) {
      if (item.type === "fileChange" && Array.isArray(item.changes)) this.changes.set(item.id, item.changes);
    }
    this.sink.emit({ type: "turn.begin", user: this.runningUser, clears: this.clearsFor(turn.id), command: !opener });
    this.lastShownTurn = turn.id;
    // What it did before the connection was back, as Codex kept it (its finished items).
    this.report(this.stream.reconcile(turn));
  }

  /** Turns needed to settle commands that outlived the turn they started in. */
  private withBackgroundTurns(turns: string[]): string[] {
    for (const command of this.terminalProcesses.values()) {
      if (command.turn === null) return []; // Its turn is unknown: read the whole thread.
      turns.push(command.turn);
    }
    return turns;
  }

  private async catchUp(turnID: string): Promise<void> {
    const thread = await this.read({ through: this.withBackgroundTurns([turnID]) });
    // Begun in an earlier turn, it may have ended while the connection was down too.
    this.terminalsEnded(thread);
    // Its waits among what was missed name the sub-agents as live (`joinMissed`).
    await this.learnNicknames(thread);
    const turn = ((thread.turns ?? []) as Turn[]).find((entry) => entry.id === turnID);
    if (!turn) {
      if (thread.status?.type !== "active") this.endTurn({ type: "turn.end", status: "error", error: "Codex lost track of this turn while Portals was away.", retryable: true });
      return;
    }
    if (this.turnOpen && this.turnID === turnID) {
      // A plan proposed while the bridge was away is put to the person all the same,
      // unless a turn begun at the desk since has left it behind.
      const overtaken = (thread.turns as Turn[]).at(-1)?.id !== turnID;
      const plan = this.planning && !overtaken ? (turn.items as Params[]).findLast((item) => item.type === "plan" && typeof item.text === "string") : undefined;
      if (plan) this.proposed = plan.text;
      if (overtaken) this.proposed = null;
      this.reportEnd(this.stream.reconcile(turn), turn.status);
    }
    // Codex restarted while the turn ran (it does to update itself): the turn is kept as
    // it was, in progress, in a thread that runs nothing, and nothing will end it.
    if (turn.status === "inProgress" && thread.status?.type !== "active" && this.turnOpen && this.turnID === turnID) {
      this.sink.emit({ type: "notice", level: "warn", text: "Codex stopped before it finished this turn, as it does when it restarts to update. Send a message to go on." });
      this.endTurn({ type: "turn.end", status: "interrupted", ...(this.stream.usage ? { usage: this.stream.usage } : {}) });
    }
  }
}
