import { randomUUID } from "node:crypto";
import { DeskRefused, SettingRefused } from "../providers/types.ts";
import type { McpAuthAction, McpAuthCard } from "../providers/mcpAuth.ts";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  AgentRequest,
  ApprovalChoice,
  ContextUsage,
  EndedSubagent,
  HostNote,
  ImageInput,
  ModelChangeResult,
  MessageCheckpoint,
  ModeState,
  ModeOption,
  Prompt,
  ProviderEvent,
  ProviderSession,
  QueuePlacement,
  RequestAnswer,
  SessionSink,
  StoredMessage,
  SubagentInfo,
  ThreadMode,
  TurnUsage,
} from "../providers/types.ts";
import { machineWord } from "../platform.ts";
import type { DiskSpace } from "../disk.ts";
import { modeFields } from "../providers/modes.ts";
import { counters } from "../counters.ts";
import { gitHead, threadRepo } from "../git.ts";
import { log } from "../log.ts";
import { answerMessage, askedResult, askedRowArgs, askingResult, cardAnswers, cardAnswersKept, openAsk, readCardAnswers, withCardAnswers, type CardAnswer } from "./answers.ts";
import { RequestBroker, type Follower, type OpenRequest } from "./broker.ts";
import { EventLog, type LoggedEvent } from "./eventLog.ts";
import { failedKept, withFailed, type FailedMessage } from "./failed.ts";
import { filesPerMessage, saveAttachment, withFiles } from "./files.ts";
import { withMentions } from "./mentions.ts";
import { FileUndo, FileUndoRefused } from "./fileUndo.ts";
import { withKeptDiffs, type DiffStore } from "./keptDiffs.ts";
import { lastPreview, previewOf } from "./preview.ts";
import { applyChanges, type Registry, type ThreadChanges, type ThreadRecord } from "./registry.ts";
import { withSpent, type KeptSpent, type SpentStore } from "./spent.ts";
import { turnDiff, withTurnDiffs, type TurnDiff } from "./turnDiff.ts";
import { storedUserText, Transcript } from "./transcript.ts";
import { senderOf, type From } from "../fleet/line.ts";
import type { WaitingStore } from "./waiting.ts";

function contextFields(usage: ContextUsage): Record<string, unknown> {
  return { context_used: usage.used, context_max: usage.max, ...(usage.estimated ? { context_estimated: true } : {}) };
}

// One live conversation: what the app's `session.*` calls act on.
//
// The provider reports neutral events (providers/types.ts). Each becomes one of the
// events the app reads (docs/gateway-protocol.md, section 6), gets the next `seq`, goes
// into the replay log and out to every connection that follows the session. The same
// events keep `transcript` current, which `session.resume` returns. A session keeps
// running when its connections drop; a connection follows it again by resuming it.
//
// The subagents and workflows the agent starts are kept for as long as the bridge runs,
// running or ended (feature subagents): each change goes out as `subagent.start`,
// `subagent.progress` or `subagent.complete`, and `subagent.list` gives them all to a
// device that opens the thread later or comes back after a gap. Those that have ended
// leave the line when the next message goes to the agent (feature subagents_clear): the
// `subagent.cleared` event names them, and `subagent.list` leaves them out from then on;
// the thread's record keeps their ids, so a restart of the bridge leaves them off too.
// A message is the user's words handed to the agent, from any device, typed at the desk
// or sent through the fleet, as a turn of its own or steered into the running one; one
// waiting behind the running turn counts once its turn starts. The bridge's own commands
// (`/status`, `/mode`, `/usage`) never reach the agent, and an agent's command sent as a
// message (`/compact`) is no message either: neither clears. A turn the agent began by
// itself (Claude Code reporting a background subagent's end) is no message of the user's.
//
// A turn's start and end are what move the thread in every device's list (feature
// thread_sync). A turn's start takes its message as the thread's preview, its end marks
// the thread unseen, however it ended, until a device shows it, and both take the
// thread out of the archive. Nothing else moves the thread's time. Both read the git
// branch checked out in the thread's folder, which the list shows (feature
// thread_branch): where the work lands.

/** A connection, as a session sees it. */
export interface Peer extends Follower {
  readonly isOpen: boolean;
  readonly sessionResync?: boolean;
  readonly messageReconciliation?: boolean;
  sendEvent(event: LoggedEvent): void;
  /** Reconnects a legacy client so it takes an authoritative snapshot. */
  resync?(): void;
}

/** How a turn ended. */
export type TurnStatus = Extract<ProviderEvent, { type: "turn.end" }>["status"];
type TurnEnd = Extract<ProviderEvent, { type: "turn.end" }>;

/** What a thread at work is doing, as `sessions.activity` lists it. */
export type ThreadActivity = "running" | "waiting";

/**
 * Told what a session does that the user may want to hear about away from the app
 * (push/notifier.ts), and what waits for a thread may be waiting for (the fleet). Called
 * synchronously; it must return at once and not throw. A listener has only the methods
 * it needs.
 */
export interface SessionListener {
  /** A question was put to the app: an `approval` or a `clarify`, as `open_requests` lists it; `again` when it was put again (`Session.askAgain`). */
  requestOpened?(sessionID: string, request: OpenRequest): void;
  /** A turn ended. `text` is the reply of a complete turn and the error of a failed one. */
  turnEnded?(sessionID: string, status: TurnStatus, text: string): void;
  /**
   * The thread may be at rest now: a message handed to a running turn was taken after the
   * turn had ended, or the last message waiting on its list was taken off it.
   */
  steerSettled?(sessionID: string): void;
  /** The thread was taken off the list (`thread.delete`): nobody is to hear about it any more. */
  threadRemoved?(sessionID: string): void;
  /**
   * A thread taken off the list is about to be on it again (taken up from the desk): it
   * comes back with nobody to hear about it, as it was removed, until a device asks.
   */
  threadReturning?(sessionID: string): void;
  /** What `sessions.activity` says of the thread changed (`Session.activity`): a device that asked is told to poll (feature poll_now). */
  activityChanged?(sessionID: string): void;
}

/** How a message reaches the thread. */
export interface SubmitOptions {
  /**
   * Sent through the fleet, not by a person: it takes none of the images a person has
   * attached for their next message, and the turn it opens says what opened it.
   */
  fleet?: boolean;
  /** Sent while a turn runs, it waits for the turn to end even where the agent could take it in now (feature `queue`). */
  queue?: boolean;
  /** The connection that sent it: the message takes the images and files that one attached. */
  by?: Peer;
  /**
   * The id the device gave the message (`prompt.submit` `message_id`, feature
   * `turn_messages`): the turn's start, or the event telling that it joined the running
   * turn, names it, by which that device knows the message as its own.
   */
  messageID?: string;
  /** The files and folders the message mentions, checked to be in the thread's folder (feature file_mentions). */
  mentions?: string[];
}

export interface SessionOptions {
  folderLocked?: () => boolean;
  modeOptions?: ModeOption[];
  /** How many events the replay log keeps. */
  logCapacity?: number;
  listener?: SessionListener;
  /** The last `seq` a session of this thread gave out earlier in this run: events number on past it, and no replay reaches back to it. */
  lastSeq?: number;
  /** Where the messages waiting for a running turn are kept while they wait, so a bridge started again still sends them. */
  waiting?: WaitingStore;
  /** What turns spent, kept for an agent whose history keeps no tokens (src/sessions/spent.ts). */
  spent?: SpentStore;
  /** The diffs of edits, kept for an agent whose history will not give them back as they were (src/sessions/keptDiffs.ts). */
  diffs?: DiffStore;
  /** The last id a session of this thread gave a message waiting earlier in this run: ids number on from it. */
  lastQueueID?: number;
  /** The agent's name as people know it ("Codex"), for what the bridge says of it in the thread; "the agent" without one. */
  agentName?: string;
  /** How much room the host's disk has (src/disk.ts): the thread is told when it runs low, or when a write fails for want of it. */
  disk?: Pick<DiskSpace, "lowSpell" | "hostName" | "outOfSpace">;
}

export interface SubmitOutcome {
  /** What the app is told: `streaming`, `queued` or `steered`. */
  status: string;
  /** A queued message's id on the thread's list of messages waiting (feature `queue`). */
  queueID?: string;
  /** Starts the turn. Called after the reply is sent, so the reply comes first. */
  begin?: () => void;
}

/** A message waiting for the running turn to end, as devices are shown it (feature `queue`). */
export interface QueuedMessage {
  id: string;
  /** As stored (`storedUserText`). */
  text: string;
  /** Sent through the fleet, by another thread or agent. */
  fleet?: boolean;
  /** Who sent it through the fleet (feature `senders`). */
  from?: From;
  placement?: QueuePlacement;
  /** The id `prompt.submit` gave it (features `turn_messages`, `message_ids`). */
  message_id?: string;
  /** The answers given on a card (feature async_questions): their row's id. */
  card_answer?: string;
}

/**
 * Who sent a message, as the events that carry it say (feature `turn_messages`): a
 * person from a device (`prompt.submit`, or a note given with a no), another thread, an
 * agent or a script through the fleet (`portals send`), or someone at the desk, in a
 * terminal that has the session open.
 */
export type Sender = "user" | "portals" | "desk";

/** What opens a turn of the app's, besides its message (`begin`). */
interface Opening {
  /** Steered into a turn that ended before the agent took it: shown there already, the turn opens with nothing. */
  resent?: boolean;
  /** Sent through the fleet: the turn's start says so as it did before the feature `turn_messages` (`opened_by`). */
  fleet?: boolean;
  /** Who sent it: `portals` for a message through the fleet, else `user`. */
  sender?: Sender;
  /** The id it had while it waited, which the turn's start names (feature `queue`). */
  queued?: string;
  /** The id the device gave it (feature `turn_messages`). */
  messageID?: string;
}

const approvalChoices: ApprovalChoice[] = ["once", "session", "always", "deny"];

/** A message waiting for the running turn to end. */
interface Queued {
  id: string;
  prompt: Prompt;
  /** Steered into a turn that ended before the agent took it: it shows there already, so its own turn opens with nothing. */
  resent?: boolean;
  /** For one `resent`: when it was steered in, so that those said again keep the order they were sent in. */
  steered?: number;
  /**
   * For one `resent`: the agent surely never had it (it said no, or the message never went
   * to it), so the agent's own record of the conversation does not have it either.
   */
  refused?: boolean;
  /**
   * For one `resent` read back from disk with `refused`: the conversation read back since
   * has it nowhere, so its turn opens with its words. It keeps its place among those said
   * again all the same.
   */
  unshown?: boolean;
  fleet?: boolean;
  /** The id the device gave it (feature `turn_messages`). */
  messageID?: string;
  /**
   * The turn it opens is about to start: it is listed until then, so a device that
   * resumes meanwhile still has its text, and it can no longer be taken off or steered.
   */
  starting?: boolean;
  /**
   * When it began to wait at rest for the agent's side to catch up (`watchReach`), until
   * that side is back in step: the agent is asked from then whether it cannot be reached.
   */
  since?: number;
  placement?: QueuePlacement;
  requestId?: string;
  failure?: string;
  failedRequestId?: string;
  /**
   * The ids it was handed to Droid under and taken back from it with: Droid answers that
   * deletion as it answers one for a message it had taken already, so its receipt for one
   * may still come. The message is then Droid's, and is never sent again.
   */
  takenBackRequestIds?: string[];
  changing?: boolean;
}

/**
 * What one connection attached for its next message: images, files saved already with
 * the id the device gave each, and how many files are being saved now.
 */
interface Attached {
  images: ImageInput[];
  files: { path: string; id?: string }[];
  saving: number;
  /** The files being saved now that came with an id, by id: the same file sent again meanwhile waits for this save. */
  pending: Map<string, Promise<string>>;
}

/** A file saved for a message given up while it was being saved: nothing more is to be let go of for it. */
export class GivenUp extends Error {
  override name = "GivenUp";
}

/** In the user's place in a turn that a message shown in the turn before opens. */
const hiddenOpener: HostNote = { kind: "hidden", text: "" };

/**
 * The most events a `session.resume` sends in place of the conversation (feature
 * `resume_replay`); a device further behind takes the whole thread. Half a minute of a
 * reply streaming at its fastest (a piece every 30 to 80 ms), or dozens of turns of an
 * agent that sends whole blocks of text: some 65 KB at the 130 bytes a piece of the
 * harness's streamed reply, where the whole answer for its long thread (`resume`: 400
 * messages and a long last turn) is 160 KB, and grows with every turn. Fewer are sent
 * whole all the same when the conversation is the lighter (`Session.replay`).
 */
export const replayLimit = 500;

/**
 * How long a running turn may go without a word from the agent before its status line
 * says so (`watchQuiet`): a turn the agent lost (an end it never sent, a request that
 * never returns) otherwise shows as working for ever, with nothing to say Stop is the
 * way out. A long command that prints nothing is quiet as well, so the line says no more
 * than that it is quiet.
 */
export const quietLimitMs = 5 * 60_000;

/**
 * How long Stop waits for the agent to take it before the turn ends here all the same
 * (`interrupt`): an agent that cannot be reached, or a call that hangs, would otherwise
 * keep the turn running for the app, and the app gives up on Stop after a minute. Longer
 * than the time the providers give an agent to end a turn it took the Stop for (their
 * `interruptGraceMs`, 15 seconds), so theirs end it first where they can.
 */
export const stopWaitMs = 20_000;

export class Session {
  /** A message waits for the agent's side to catch up (`startNext`), which starts it then. */
  private awaitingCatchUp = false;
  /**
   * The first message waiting at rest for the agent's side to catch up, which the agent
   * is asked about (`watchReach`), and how to stop asking.
   */
  private reachWatch: { entry: Queued; stop: AbortController } | null = null;
  readonly record: ThreadRecord;
  readonly requests: RequestBroker;
  readonly sink: SessionSink;
  private readonly registry: Registry;
  private readonly log: EventLog;
  private readonly followers = new Set<Peer>();
  private transcript = new Transcript();
  private provider: ProviderSession | null = null;
  /** What `running` says. */
  private turnRunning = false;
  /** Messages handed to the running turn that the agent has not yet said it took. */
  private steering = 0;
  /** Settings on their way to the agent (`setting`). */
  private settingsOnTheWay = 0;
  /** How many messages have been steered in: each one's place in that order (`Queued.steered`). */
  private steeredIn = 0;
  /** The places of those steered in that the agent has yet to take or turn down. */
  private readonly steersOut = new Set<number>();
  private readonly queue: Queued[] = [];
  /** The next Queue turn, reserved but not yet begun: a provider's own turn may still go first. */
  private queuedStart: { entry: Queued } | null = null;
  /** The last id a queued message was given. */
  private queued = 0;
  /**
   * What each connection attached for its next message, which only its own message
   * takes: two devices sending at once do not take each other's. Without a connection
   * (a caller of the bridge's own), under `undefined`.
   */
  private readonly attached = new Map<Peer | undefined, Attached>();
  private usage: ContextUsage | null = null;
  /** Text streamed since the turn's last tool call: the reply `message.complete` carries. */
  private replyText = "";
  /**
   * What the status line says now (the agent's `status`: compacting, its API being asked
   * again), as a device that opens the running thread whole is told it (`status_line`):
   * one that follows has it from the events. Gone when the agent takes it down, and when
   * a run begins or ends, which take it down on the devices too.
   */
  private statusLine = "";
  /**
   * When the running turn began here (ms since the epoch), to time it (feature
   * `turn_usage`); null for one already under way when the thread was loaded, which the
   * bridge did not see begin.
   */
  private turnBegan: number | null = null;
  /** When the agent last said anything (ms since the epoch), or a card it asked was opened or closed: what `watchQuiet` goes by. */
  private heard = 0;
  /** The one timer that looks whether the running turn has gone quiet (`watchQuiet`). */
  private quietTimer: NodeJS.Timeout | null = null;
  /** The status line says the turn has gone quiet; what it said before, which the agent's next word puts back. */
  private quietOver: { before: string } | null = null;
  /**
   * Stop ended the running turn here, the agent not having taken it in time (`stopWithin`),
   * and the agent may still run it. Its events carry no turn of their own, so until the
   * agent ends it (its `turn.end`), says nothing was running, or begins a turn of its own,
   * what it says of that turn is let go of, and no message goes to it: one sent meanwhile
   * waits on the list (`heldByStop`). Of the agent it was asked of only: one attached since
   * is not held.
   */
  private stoppedHere: { provider: ProviderSession } | null = null;
  /** The reads of the folder's branch begun so far (`noteBranch`). */
  private branchReads = 0;
  /**
   * The subagents and workflows the agent started, by id, in the order they started, with
   * the turn that started each; `cleared` once one that ended has left the line.
   */
  private readonly subagents = new Map<string, SubagentEntry>();
  /** The run that asked each open background question, before its id can be reused. */
  private readonly questionRuns = new Map<string, SubagentRun>();
  /**
   * The runs each subagent's agent named (`SubagentInfo.run`), in the order the bridge
   * first heard of them, the latest few: a run that another has followed is over, and
   * news of it that comes late changes nothing (`subagentNews`).
   */
  private readonly runsOf = new Map<string, string[]>();
  /** How many turns have begun in this session: the number of the one running or last run. */
  private turns = 0;
  private readonly listener: SessionListener | undefined;
  private readonly modeOptions: ModeOption[] | undefined;
  /**
   * A device that keeps a subagent's question after the turn (`subagent_requests`) has
   * followed the thread in this run: the turn's end leaves such questions open, as that
   * device can still answer them, also once it comes back.
   */
  private keepsSubagentQuestions = false;
  /**
   * A device that keeps a question asked without waiting after the turn
   * (`async_questions`) has followed the thread in this run: such questions are put to the
   * devices as a card, which stays open past the turn's end; else they are the reply's text.
   */
  private keepsAsyncQuestions = false;
  /**
   * The answers given on a card that a message carries to the agent (feature
   * async_questions), by the message: their row's id, which its turn's start, its joining
   * the running turn and its stored copy name (`card_answer`), so the app shows their row
   * and no message of its own for it.
   */
  private readonly cardAnswerOf = new WeakMap<Prompt, string>();
  /** The id its device gave each message handed to the running turn, which a Stop may take back from the agent (`steer.withdrawn`). */
  private readonly steeredIDs = new WeakMap<Prompt, string>();
  /**
   * The notes given with a no that go to the agent a step later (`ask`), until they have:
   * a close in between says them at once (to disk, `sayNote` while closing), since the
   * bridge may end before that step.
   */
  private readonly notesDue = new Set<{ note: string }>();
  /**
   * The last questions asked without waiting, which the conversation ended with
   * unanswered as the thread was loaded (`openAsk`): their card did not outlive the
   * bridge's last run. They are put again as their card to the first device that keeps
   * such cards and opens the thread (`askAgain`); a message of the person's to the agent
   * answers them, and a newer question takes their place.
   */
  private askedBefore: Extract<ProviderEvent, { type: "questions" }> | null = null;
  /** A look at whether the agent's conversation went on elsewhere, under way (`takeConversationFromElsewhere`). */
  private lookingElsewhere: Promise<boolean> | null = null;
  /** The agent said its conversation changed again while that look was under way: one more follows it. */
  private lookAgain = false;
  /** Questions are being put again (`askAgain`), not asked anew: nobody is notified of them again. */
  private askingAgain = false;
  /** The questions asked without waiting whose card is open now (`askAhead`), one holder per time they were put. */
  private askedOpen: { event: Extract<ProviderEvent, { type: "questions" }> } | null = null;
  /**
   * The questions asked without waiting that the message opening the running turn
   * answered (`begin`), while the agent has produced nothing in it: should that turn fail
   * before it does, the message never reached the agent as their answer, and they are put
   * again (`putBackAnswered`).
   */
  private answeredByTurn: Extract<ProviderEvent, { type: "questions" }> | null = null;
  /** What `activity` was when the listener was last told of it, or would have been. */
  private toldActivity: ThreadActivity | undefined;
  /** Let go of for good (`retire`): it starts nothing and writes nothing again. */
  private retired = false;
  private checkpointing = false;
  private readonly fileUndo = new FileUndo();
  private readonly folderLocked: (() => boolean) | undefined;
  /** Closing with the bridge: a turn that ends now opens no turn for a message waiting, which waits on disk for the next start. */
  private closing = false;
  private readonly waiting: WaitingStore | undefined;
  private readonly spentStore: SpentStore | undefined;
  private readonly diffStore: DiffStore | undefined;
  private readonly disk: SessionOptions["disk"];
  /** The spell of low space on the host's disk the thread was told of (`tellDiskLow`). */
  private diskToldSpell: number | undefined;
  /** The thread was told that a write failed for want of space, and none of its turns' writes has worked since (`writeFailed`). */
  private toldFull = false;
  /**
   * The thread's latest messages that failed without reaching the agent (`failUnreached`),
   * kept on disk with those waiting, so that it shows them once loaded again.
   */
  private failed: FailedMessage[] = [];
  /** The agent's name, as the status line of a quiet turn says it. */
  private readonly agentName: string;

  constructor(record: ThreadRecord, registry: Registry, options: SessionOptions = {}) {
    this.record = record;
    this.folderLocked = options.folderLocked;
    this.registry = registry;
    this.listener = options.listener;
    this.modeOptions = options.modeOptions;
    this.waiting = options.waiting;
    this.spentStore = options.spent;
    this.diffStore = options.diffs;
    this.agentName = options.agentName ?? "the agent";
    this.disk = options.disk;
    // A device that still holds an id of the session before never meets it again here.
    this.queued = options.lastQueueID ?? 0;
    this.log = new EventLog(record.id, options.logCapacity, options.lastSeq);
    this.requests = new RequestBroker({
      sessionID: record.id,
      followers: () => this.followers,
      // In the log for everyone, but not sent back to the connection that answered: it
      // has closed the card itself, and a seq it skips is fine.
      closed: (id, reason, answeredBy, details) => {
        this.questionRuns.delete(id);
        // Answered, the agent has its turn again: the quiet is counted from now.
        this.heardNow();
        // Which device's answer settled it (feature answer_owner): one that answered too,
        // its answer not taken yet, shows the one that won in its place.
        const owner = answeredBy?.deviceID ? { answered_by: answeredBy.deviceID } : {};
        this.emit("request.cancel", { id, reason, ...details, ...owner }, answeredBy);
        this.noteActivity();
      },
      opened: (request) => {
        const owner = typeof request.params.subagent === "string" ? this.subagents.get(request.params.subagent)?.info : undefined;
        if (owner && this.requests.has(request.id)) this.questionRuns.set(request.id, { id: owner.id, run: owner.run, startedAt: owner.startedAt });
        this.heardNow();
        // Put again (`askAgain`), it was notified when it was asked.
        this.tell((listener) => listener.requestOpened?.(this.id, this.askingAgain ? { ...request, again: true } : request));
        this.noteActivity();
      },
    });
    this.sink = {
      emit: (event) => this.take(event),
      ask: (request, signal) => this.ask(request, signal),
    };
  }

  get id(): string {
    return this.record.id;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** A turn is running, or is about to begin (reserved by `submit`). */
  private get running(): boolean {
    return this.turnRunning;
  }

  private set running(value: boolean) {
    // A turn's quiet is counted from its start.
    if (value && !this.turnRunning) this.heard = Date.now();
    this.turnRunning = value;
    this.watchQuiet();
    this.noteActivity();
  }

  /**
   * Keeps the one timer that looks whether the running turn has gone quiet armed while a
   * turn runs, and takes it down, with the line it put up, once none does. Cheap per event:
   * the agent's words only move `heard`, and the timer, when it fires early, arms itself
   * again for what is left.
   */
  private watchQuiet(): void {
    if (!this.running || this.retired || this.closing) {
      if (this.quietTimer) clearTimeout(this.quietTimer);
      this.quietTimer = null;
      // The turn's end takes the line down on the devices too.
      this.quietOver = null;
      return;
    }
    if (this.quietTimer || this.quietOver) return;
    this.armQuiet(this.heard + quietLimitMs - Date.now());
  }

  private armQuiet(delay: number): void {
    this.quietTimer = setTimeout(() => this.lookQuiet(), Math.max(delay, 0));
    this.quietTimer.unref();
  }

  /**
   * The running turn has had no word from the agent in `quietLimitMs`: the status line
   * says so, and that Stop ends it. Nothing is stopped and nothing failed: the agent may
   * still be at work (a command that prints nothing). Not while a card is open, where the
   * agent waits for the person and not the other way round.
   */
  private lookQuiet(): void {
    this.quietTimer = null;
    if (!this.running || this.retired || this.closing) return;
    const now = Date.now();
    if (this.requests.list().length > 0) this.heard = now;
    const left = this.heard + quietLimitMs - now;
    if (left > 0 || !this.transcript.isInTurn) {
      this.armQuiet(left > 0 ? left : quietLimitMs);
      return;
    }
    this.quietOver = { before: this.statusLine };
    this.emit("thinking.delta", { text: `No word from ${this.agentName} for ${quietLimitMs / 60_000} minutes. It may still be working; Stop ends it.` });
  }

  /**
   * The agent said something, or a card it asked opened or closed: the quiet is over,
   * and the status line it had before the quiet's is put back (`putBack`).
   */
  private heardNow(putBack = true): void {
    this.heard = Date.now();
    const over = this.quietOver;
    if (!over) return;
    this.quietOver = null;
    if (putBack) this.emit("thinking.delta", { text: over.before });
    this.watchQuiet();
  }

  /**
   * What `sessions.activity` says of the thread: `waiting` on an answer (an approval or a
   * question is open), else `running` a turn, or a subagent or workflow the agent started
   * (feature subagents); nothing at rest.
   */
  get activity(): ThreadActivity | undefined {
    if (this.requests.list().length > 0) return "waiting";
    return this.running || this.hasRunningSubagents ? "running" : undefined;
  }

  /** Tells the listener when `activity` changed (feature poll_now); not once let go of, when the thread is no longer listed as this session. */
  private noteActivity(): void {
    if (this.retired) return;
    const now = this.activity;
    if (now === this.toldActivity) return;
    this.toldActivity = now;
    this.tell((listener) => listener.activityChanged?.(this.id));
  }

  /** Running, or a message handed to the running turn is not yet taken: it may still start a turn of its own. */
  get isBusy(): boolean {
    return this.running || this.steering > 0;
  }

  /** A desk session taken up only for reading: the agent is sent nothing. */
  get isReadOnly(): boolean {
    return this.record.readOnly === true;
  }

  /** Let go of for good: removed from the list, or loaded again as another session. */
  get isRetired(): boolean {
    return this.retired;
  }

  /** The last `seq` given out. */
  get latestSeq(): number {
    return this.log.latestSeq;
  }

  /**
   * Where the replay of the conversation as it is now begins (feature `resume_replay`): a
   * device sends it back with the last event it applied, and is replayed only while it is
   * this, so one that followed the thread on through a change no event told of, holding
   * events after it with the conversation from before, takes the whole thread (`replay`).
   */
  get replayBase(): number {
    return this.log.base;
  }

  /** The last id given a message waiting (feature `queue`). */
  get latestQueueID(): number {
    return this.queued;
  }

  /** A subagent or workflow the agent started is still at work, whether or not a turn runs. */
  get hasRunningSubagents(): boolean {
    // A command left running in the background (a dev server, for hours) is not the thread
    // at work, as it was not before it had a row: its agent says what keeps it busy.
    return [...this.subagents.values()].some(({ info }) => info.status === "running" && info.kind !== "command");
  }

  /** At work: a turn running or about to, a message handed to it not yet taken, or a question open. */
  get isAtWork(): boolean {
    // Messages waiting count too: restored from disk, they wait a step before their turn.
    return this.isBusy || this.queue.length > 0 || this.requests.list().length > 0;
  }

  /** The conversation so far, oldest first, as `session.resume` returns it. */
  get messages(): readonly StoredMessage[] {
    return this.transcript.messages;
  }

  get historyOperationInProgress(): boolean {
    return this.checkpointing;
  }

  /**
   * For a thread continued here and at rest: whether the agent's copy of the
   * conversation was written elsewhere since it was read (a Pi at the desk), so it is to
   * be loaded again to show what was said there (`SessionManager.refresh`).
   */
  async changedElsewhere(): Promise<boolean> {
    if (this.isReadOnly || this.retired || !this.atRest || !this.provider?.changedElsewhere) return false;
    return await this.provider.changedElsewhere();
  }

  /**
   * For an agent's one ongoing conversation at rest (feature bot_chat): what another of
   * the agent's apps said in it since it was read (Hermes Desktop, a terminal), taken in
   * place (`ProviderSession.changedConversation`). Every device that holds the thread
   * takes it again (`session.invalidated`), and the list shows it moved when it grew. True
   * when it changed. One look at a time: a second asks along with the first, and one more
   * look follows it, since the change it was asked for may be newer than what the first
   * one read.
   */
  takeConversationFromElsewhere(): Promise<boolean> {
    if (this.lookingElsewhere) {
      this.lookAgain = true;
      return this.lookingElsewhere;
    }
    this.lookingElsewhere = (async () => {
      let changed = false;
      do {
        this.lookAgain = false;
        if (await this.lookElsewhere()) changed = true;
      } while (this.lookAgain);
      return changed;
    })().finally(() => {
      this.lookingElsewhere = null;
    });
    return this.lookingElsewhere;
  }

  private async lookElsewhere(): Promise<boolean> {
    const provider = this.provider;
    if (this.isReadOnly || this.retired || !this.atRest || !provider?.changedConversation) return false;
    // A turn that begins (and may end) while the agent is asked makes its answer out of
    // date: the look is given up, and the agent looks again with the next change.
    const turn = this.turns;
    const look = await provider.changedConversation();
    if (!look || this.retired || !this.atRest || this.provider !== provider || this.turns !== turn) return false;
    look.take();
    const messages = look.messages;
    const before = this.transcript.messages.length;
    const settled = readCardAnswers(this.record.cardAnswers);
    const history = withCardAnswers(withKeptDiffs(messages, this.keptDiffs()), settled);
    this.transcript = new Transcript(withFailed(withSpent(history, this.keptSpent(), (id) => provider.turnEnd?.(id)), this.failed, false, (id) => provider.turnEnd?.(id)));
    this.diffTurns(0, this.transcript.messages.length);
    log.info("the agent's conversation went on in another of its apps, so it is taken again", { session: this.id, messages: messages.length });
    if (messages.length > before) {
      const preview = lastPreview(this.transcript.messages);
      this.writeTurn(() => this.write(preview ? { preview } : {}, { turn: true }));
    }
    this.invalidate();
    return true;
  }

  /**
   * Nothing in hand that loading the thread again would lose: no turn, nor a message on
   * its way into one or waiting, no card open nor question found open, no note due, no
   * attachment waiting for a message, and no work going on.
   */
  get atRest(): boolean {
    if (this.checkpointing) return false;
    if (this.isBusy || this.heldByStop || this.transcript.isInTurn || this.activity !== undefined || this.closing || this.settingsOnTheWay > 0) return false;
    if (this.queue.length > 0 || this.awaitingCatchUp || this.notesDue.size > 0 || this.askedBefore !== null || this.askedOpen !== null) return false;
    return [...this.attached.values()].every((attached) => attached.images.length === 0 && attached.files.length === 0 && attached.saving === 0 && attached.pending.size === 0);
  }

  /**
   * For a thread only read: the conversation as the agent has it now, which may have
   * gone on in the terminal that has it open. Called before a snapshot.
   */
  async refresh(): Promise<void> {
    await this.provider?.prepareOpen?.();
    if (!this.isReadOnly || this.running || !this.provider?.reload) return;
    this.transcript = new Transcript(withTurnDiffs(withKeptDiffs(await this.provider.reload(), this.keptDiffs())));
    // Told by no event: a device that held the conversation before takes it whole.
    this.log.rebase();
  }

  /** Connects the provider's side and reads the conversation so far. */
  async attach(provider: ProviderSession): Promise<void> {
    this.provider = provider;
    provider.setFollowed?.(this.followers.size > 0);
    // With the diffs the bridge kept of edits as they were live, where the agent's history
    // would give others (feature turn_diff): its turns' counts are those shown live.
    // And with how its questions asked without waiting were settled on their card (feature
    // async_questions), which the agent's history does not say.
    const settled = readCardAnswers(this.record.cardAnswers);
    const history = withCardAnswers(withKeptDiffs(await provider.history(), this.keptDiffs()), settled);
    // The last ones, still open as the bridge stopped, are put again as their card.
    const open = openAsk(history, settled);
    this.askedBefore = open ? { type: "questions", id: open.id, questions: open.questions, text: "" } : null;
    const keptFailed = this.waiting?.readFailed(this.id) ?? [];
    const failed = keptFailed.filter((message) => !message.requestId || !provider.queuedConsumed?.(message.requestId));
    this.failed = failed;
    // What the stored conversation tells of, before this run of the bridge: its turns are numbered back from 0.
    // Those that had left the line (the record keeps them) stay off it while they have
    // ended, unless what is known of them now is another run than the one that left.
    for (const { subagent, turn } of provider.pastSubagents?.() ?? []) {
      if (subagent.id === "" || this.subagents.has(subagent.id)) continue;
      const cleared = this.leftAsIs(subagent);
      this.subagents.set(subagent.id, cleared ? { info: offTheLine(subagent), turn, cleared } : { info: subagent, turn });
      // Its run comes first in the order of runs (`subagentNews`): news of a later one takes its place, not the other way.
      if (subagent.run !== undefined) this.runsOf.set(subagent.id, [subagent.run]);
    }
    // One found still at work (a Codex sub-agent runs on in Codex) has the thread at work.
    this.noteActivity();
    // A turn already running in the agent (before a restart of the bridge, or from the desk).
    const running = provider.attached?.() ?? null;
    // With the messages that failed without reaching the agent, which its history does not
    // have, before a turn it still runs.
    // With what turns spent where the agent's history does not say and the bridge kept it.
    const spent = withSpent(history, this.keptSpent(), (id) => provider.turnEnd?.(id));
    this.transcript = new Transcript(withFailed(spent, failed, running !== null, (id) => provider.turnEnd?.(id)));
    if (running) {
      this.running = true;
      this.turns += 1;
      this.replyText = "";
      this.turnBegan = null;
      this.transcript.resumeTurn(running.user);
      // One started at the desk while the bridge was off is a turn's start as any other.
      // The one whose start the bridge recorded before it restarted has nothing new to
      // say, unless the thread was archived since.
      const preview = lastPreview(this.transcript.messages);
      if (!this.record.inTurn || preview !== this.record.preview || this.record.archived) this.turnStarted(preview);
      this.emit("message.start");
    } else if (this.record.inTurn) {
      // The turn whose start the bridge recorded ended while it was off (a crash, a
      // restart): its end is told as any turn's end is, the thread unseen on every device
      // and a notification by the same rules (2026-10-26: "Notify + mark unseen").
      // Once: told only when the record kept the turn's end, which clears `inTurn`. Kept as
      // any turn's end is (`writeTurn`), so a threads.json that cannot be written fails no
      // load; the end is then told at the next load.
      // One the agent's own record shows was cut off mid-way (a crash took its process
      // with the bridge) was stopped when the bridge stopped, as a restart stops one
      // (recovery-7), not finished.
      const ended: { status: TurnStatus; text: string } = provider.lastTurnCutOff?.() === true ? { status: "interrupted", text: "" } : endedWhileAway(this.transcript.messages);
      if (this.writeTurn(() => this.write({ archived: undefined, unseen: true, inTurn: false }, { turn: true }))) {
        this.tell((listener) => listener.turnEnded?.(this.id, ended.status, ended.text));
      }
    }
    // What each ended turn changed (feature turn_diff), from the agent's own record of its
    // edits; the running one's once it ends. Only put on the messages: no turn ends here.
    this.diffTurns(0, this.transcript.turnStart ?? this.transcript.messages.length);
    // Messages that were waiting when the bridge stopped, or when this thread's last
    // session was let go of: they wait for the turn running, or the next of them opens one.
    const waiting = this.waiting?.read(this.id) ?? [];
    for (const message of waiting) {
      this.queued = Math.max(this.queued, Number.parseInt(message.id, 10) || 0);
      // Droid's receipt for it was saved: under the id it was waiting on, the one it failed
      // with, or one it was taken back with. Droid has it, so it is neither failed nor sent.
      const ids = [message.requestId, message.failedRequestId, ...message.takenBackRequestIds ?? []];
      if (ids.some((id) => id !== undefined && provider.queuedConsumed?.(id))) continue;
      const prompt: Prompt = { text: message.text, images: message.images, files: message.files, ...(message.mentions ? { mentions: message.mentions } : {}) };
      // The answers given on a card, which its turn and the list still mark as the card's.
      if (message.cardAnswer !== undefined) this.cardAnswerOf.set(prompt, message.cardAnswer);
      // One said again that the agent surely never had: shown, before the restart, only in
      // the turn it was steered into as that run told it, it is in no conversation read
      // back since. One whose delivery is not known stays shown only where it was steered
      // in: the agent's record has it if the agent took it.
      const unshown = message.resent === true && message.refused === true;
      this.queue.push({ id: message.id, prompt, fleet: message.fleet, resent: message.resent, refused: message.refused, unshown, messageID: message.messageID,
        placement: message.placement, requestId: message.requestId,
        failedRequestId: message.failedRequestId, takenBackRequestIds: message.takenBackRequestIds,
        failure: message.failure ?? (message.requestId ? "The bridge restarted before Droid confirmed this steering message. It was not sent again automatically. Review it and try again." : undefined) });
    }
    if (keptFailed.length !== failed.length || waiting.some((message) => message.requestId)) this.keepQueue();
    // A step later, once the agent has said what it had under way when it was attached
    // (Codex tells of a turn begun meanwhile just after): the message waits for that turn.
    if (waiting.length > 0) {
      setImmediate(() => {
        if (!this.running && !this.retired) this.startNext();
      });
    }
  }

  // MARK: Followers

  follow(peer: Peer): void {
    // One that closed while its call was under way would never be removed.
    if (!peer.isOpen) return;
    const first = this.followers.size === 0;
    this.followers.add(peer);
    if (first) this.provider?.setFollowed?.(true);
    if (peer.keepsSubagentRequests === true) this.keepsSubagentQuestions = true;
    if (peer.keepsAsyncQuestions === true) this.keepsAsyncQuestions = true;
  }

  /**
   * Called before the answer a device that opens the thread takes (`session.resume`), in
   * the same step: to one that keeps questions asked without waiting past their turn
   * (feature async_questions), the last ones the conversation ended with unanswered as
   * the thread was loaded (`askedBefore`) are put again as their card, which that answer
   * then lists, their row left out for it. Answered, they go on as a card asked live does.
   */
  askAgain(peer: Follower): void {
    const asked = this.askedBefore;
    if (!asked || peer.keepsAsyncQuestions !== true || this.retired || this.isReadOnly) return;
    this.askedBefore = null;
    void this.askAhead(asked, true);
  }

  unfollow(peer: Peer): void {
    if (this.followers.delete(peer) && this.followers.size === 0) this.provider?.setFollowed?.(false);
    // Gone with its connection: what it attached was for a message it can no longer send.
    this.attached.delete(peer);
  }

  isFollowedBy(peer: Peer): boolean {
    return this.followers.has(peer);
  }

  // MARK: What the app asks

  /**
   * Who a message sent through the fleet is from (feature `senders`), read from its first
   * line (fleet/line.ts), with the agent of a thread of this bridge; undefined for any
   * other message.
   */
  private fromOf(text: string): From | undefined {
    const from = senderOf(text);
    if (from?.thread !== undefined && from.machine === undefined && from.machine_name === undefined) {
      const agent = this.registry.get(from.thread)?.agent;
      if (agent) from.agent = agent;
    }
    return from;
  }

  /** The stored messages with who sent each one through the fleet beside it (`from`); the same list when none was. */
  private withSenders(messages: StoredMessage[]): StoredMessage[] {
    let given: StoredMessage[] | undefined;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role !== "user" || !message.text.startsWith("[Portals: from ")) continue;
      const from = this.fromOf(message.text);
      if (!from) continue;
      given ??= messages.slice();
      given[index] = { ...message, from };
    }
    return given ?? messages;
  }

  /**
   * The `session.resume` answer. Built synchronously: whoever calls this, subscribes
   * and replies in the same step sees every earlier event here and every later one live.
   * `turns` (feature `history_pages`): only the conversation's last turns, that many,
   * with where they start in it (`history_start`) and whether there is more before.
   */
  snapshot(turns?: number): Record<string, unknown> {
    const running = this.running;
    const all = this.transcript.messages;
    const start = turns === undefined ? 0 : pageStart(all, all.length, turns);
    const result: Record<string, unknown> = {
      session_id: this.id,
      running,
      messages: this.withSenders(start === 0 ? all : all.slice(start)),
      open_requests: this.requests.list(),
      info: this.info(),
      // The last event it holds: a device that already follows the thread has the ones up
      // to it in the snapshot, and applies only those after it.
      latest_seq: this.log.latestSeq,
    };
    const inflight = this.transcript.inflight();
    if (running && inflight) {
      // Who sent the message that opened it through the fleet, as for a stored one.
      const from = inflight.user.startsWith("[Portals: from ") ? this.fromOf(inflight.user) : undefined;
      result.inflight = from ? { ...inflight, from } : inflight;
    }
    // The status line of the run going on: the events that put it up are not in the answer.
    if (running && this.statusLine !== "") result.status_line = this.statusLine;
    if (turns !== undefined) Object.assign(result, { history_start: start, has_earlier: start > 0, replay_base: this.log.base });
    this.addQueue(result);
    return result;
  }

  /**
   * The `session.history` answer (feature `history_pages`): the `turns` turns of the
   * conversation before message `before`, for a device that holds it from there on, as
   * the conversation was where its replay began at `base`. Null when that is not the
   * conversation now, which the device then takes again (`session.resume`): a change no
   * event told of (`rebase`) can have moved every message.
   */
  history(before: number, turns: number, base: number): { messages: StoredMessage[]; start: number; has_earlier: boolean } | null {
    const all = this.transcript.messages;
    if (this.isReadOnly || base !== this.log.base || before > all.length) return null;
    const start = pageStart(all, before, turns);
    return { messages: this.withSenders(all.slice(start, before)), start, has_earlier: start > 0 };
  }

  /**
   * The `session.resume` answer for a device that holds the thread up to event `since` of
   * this run, its conversation taken where the replay began at `base` (feature
   * `resume_replay`): the events after it in place of the conversation, with the rest of
   * the snapshot. Built synchronously, as `snapshot` is, so the events here and those that
   * go out live after it meet with nothing missed or sent twice. Undefined when the device
   * must take the whole thread: a thread only read (`refresh` swaps its conversation with
   * no event), a conversation taken before a change no event told of (`base` is not
   * `replayBase`: the device may have followed the events after it), a number the log
   * does not reach back to or never gave out (one of a session before this one, or from
   * before such a change: `EventLog`), or more than `replayLimit` events to send.
   * Undefined too when the events would take more than the conversation they stand in
   * for: a reply streamed is many small events, some 130 bytes each for a few characters
   * the conversation keeps once, so a short thread is sent whole.
   */
  replay(since: number, base: number): Record<string, unknown> | undefined {
    if (this.isReadOnly || base !== this.log.base) return undefined;
    const replay = this.log.since(since);
    if (replay.truncated || replay.events.length > replayLimit || !this.isLighterThanWhole(replay.events)) return undefined;
    const result: Record<string, unknown> = {
      session_id: this.id,
      running: this.running,
      replayed: true,
      events: replay.events,
      open_requests: this.requests.list(),
      info: this.info(),
      latest_seq: replay.latestSeq,
    };
    this.addQueue(result);
    return result;
  }

  /**
   * Whether `events` take no more bytes than what they stand in for in the whole answer:
   * the conversation and the turn under way. The events are measured as they go out; the
   * conversation from its end back, only until it is as long as they are, so a long
   * thread costs no more than a short one. In UTF-8 bytes, as they are sent, not in
   * characters: a character of Chinese is three bytes, and the events say a reply twice
   * (its pieces and its end) where the conversation says it once.
   */
  private isLighterThanWhole(events: LoggedEvent[]): boolean {
    if (events.length === 0) return true;
    const replayed = Buffer.byteLength(JSON.stringify(events));
    const inflight = this.running ? this.transcript.inflight() : null;
    let whole = inflight ? Buffer.byteLength(JSON.stringify(inflight)) : 0;
    const messages = this.transcript.messages;
    for (let index = messages.length - 1; index >= 0 && whole < replayed; index -= 1) {
      whole += Buffer.byteLength(JSON.stringify(messages[index])) + 1;
    }
    return replayed <= whole;
  }

  /** The messages waiting, into a `session.resume` answer; left out while nothing waits: a device takes no list as an empty one. */
  private addQueue(result: Record<string, unknown>): void {
    const queued = this.queuedMessages();
    if (queued.length > 0) {
      result.queued = queued;
      result.can_steer = this.canSteer;
    }
  }

  /** The `session.events.since` answer, from one consistent state. */
  eventsSince(lastSeen: number): { events: LoggedEvent[]; truncated: boolean; latest_seq: number; open_requests: OpenRequest[] } {
    const replay = this.log.since(lastSeen);
    return { events: replay.events, truncated: replay.truncated, latest_seq: replay.latestSeq, open_requests: this.requests.list() };
  }

  info(): Record<string, unknown> {
    const settings = this.provider?.settings();
    const info: Record<string, unknown> = {
      model: settings?.model ?? this.record.model,
      provider: settings?.provider ?? this.record.provider,
      reasoning_effort: settings?.reasoningEffort ?? this.record.reasoningEffort,
      cwd: this.record.cwd,
      running: this.running,
      profile_name: this.record.agent,
    };
    // Left out until there is one: the app would take "" as the title.
    if (this.record.title) info.title = this.record.title;
    // Feature modes: how much the thread asks before acting.
    Object.assign(info, modeFields(this.mode()));
    if (this.usage) info.usage = contextFields(this.usage);
    return info;
  }

  /** What `by` has attached for its next message, made when there is none. */
  private attachedBy(by: Peer | undefined): Attached {
    let attached = this.attached.get(by);
    if (!attached) {
      attached = { images: [], files: [], saving: 0, pending: new Map() };
      this.attached.set(by, attached);
    }
    return attached;
  }

  /** An image for the next message `by` sends. */
  attachImage(image: ImageInput, by?: Peer): void {
    this.attachedBy(by).images.push(image);
  }

  /** Images or files are waiting for the next message `by` sends. */
  hasAttachments(by?: Peer): boolean {
    const attached = this.attached.get(by);
    return attached !== undefined && (attached.images.length > 0 || attached.files.length > 0);
  }

  /**
   * Saves a file in the thread's folder for the next message `by` sends (feature
   * `files`), and returns its path. `id` is the device's own for the file: one attached
   * again with the id of one waiting already is not saved again, and has the path it
   * had, so a send tried again after it failed half way carries each file once. Throws
   * when too many wait already, counting those being saved, or the folder cannot be
   * written.
   */
  async attachFile(name: string, data: Buffer, options: { by?: Peer; id?: string } = {}): Promise<string> {
    const attached = this.attachedBy(options.by);
    const id = options.id;
    const again = id === undefined ? undefined : attached.files.find((file) => file.id === id);
    if (again) return again.path;
    // Sent again while the first is still being saved (its answer never came): that save's.
    const saving = id === undefined ? undefined : attached.pending.get(id);
    if (saving) return saving;
    if (attached.files.length + attached.saving >= filesPerMessage) throw new Error(`At most ${filesPerMessage} files go with one message.`);
    // Never somewhere the bridge happens to be running from.
    if (!isAbsolute(this.record.cwd)) throw new Error(`This thread has no folder on the ${machineWord()} to save files in.`);
    // Counted from now: files sent at once cannot all find room for one more.
    attached.saving += 1;
    // Not for a message given up meanwhile (`dropAttachments`), saved or not: that one is
    // no longer this connection's, and the file is not attached, as its answer says.
    const givenUp = () => this.attached.get(options.by) !== attached;
    const save = saveAttachment(this.record.cwd, this.id, name, data).then(
      (path) => {
        if (givenUp()) throw new GivenUp("another file for this message was turned down meanwhile.");
        attached.files.push(id === undefined ? { path } : { path, id });
        return path;
      },
      (error: Error) => {
        throw givenUp() ? new GivenUp(error.message) : error;
      },
    );
    if (id !== undefined) attached.pending.set(id, save);
    try {
      return await save;
    } finally {
      attached.saving -= 1;
      if (id !== undefined) attached.pending.delete(id);
    }
  }

  /**
   * Lets go of what `by` attached for its next message: a file it was refused fails
   * that message as a whole, and the device attaches everything again when it tries
   * again. The files saved stay in the folder.
   */
  dropAttachments(by?: Peer): void {
    // Files still being saved for it are not attached when their saves end.
    this.attached.delete(by);
  }

  submit(text: string, options: SubmitOptions = {}): SubmitOutcome {
    if (this.retired) throw new Error("This thread is no longer on the bridge's list.");
    if (this.checkpointing || this.folderLocked?.()) throw new DeskRefused("Wait for the current thread action to finish before sending a message.");
    const fleet = options.fleet === true;
    // A message through the fleet takes nothing a device attached.
    const attached = fleet ? undefined : this.attached.get(options.by);
    const files = attached?.files.map((file) => file.path) ?? [];
    const mentions = options.mentions ?? [];
    const prompt: Prompt = { text: withFiles(withMentions(text, mentions), files), images: attached?.images ?? [], files, ...(mentions.length > 0 ? { mentions } : {}) };
    if (attached) {
      attached.images = [];
      attached.files = [];
    }
    // Behind messages restored from disk, which wait a step before their turn, it waits too.
    const messageID = options.messageID;
    // The agent's side catching up on turns it missed: it waits on the list until then.
    const catchingUp = this.running ? undefined : this.provider?.catchingUp?.();
    // Nor while the agent may still run a turn Stop ended here: it waits on the list until the agent is past it.
    if (!this.running && this.queue.length === 0 && !catchingUp && !this.heldByStop) {
      this.running = true;
      return { status: "streaming", begin: () => this.begin(prompt, { fleet, messageID }) };
    }

    // A slash command is a turn of its own: steered into the running one, it would
    // reach the agent as words.
    if (!this.provider?.enqueue && options.queue !== true && this.steerIn(prompt, { sender: fleet ? "portals" : "user", messageID })) return { status: "steered" };
    const id = String(++this.queued);
    const queued: Queued = { id, prompt, fleet, messageID };
    if (this.provider?.enqueue) queued.placement = options.queue || isCommand(prompt) ? "queue" : "steer";
    this.queue.push(queued);
    this.keepQueue();
    this.emitQueue();
    if (queued.placement === "steer") void this.handQueued(queued);
    // At rest, behind the agent's side catching up: its turn begins once it has.
    if (catchingUp) this.startNext();
    return { status: "queued", queueID: id };
  }

  /**
   * Hands `prompt` to the running turn, when the agent can take one in now and it is no
   * slash command (which is a turn of its own: steered in, it would reach the agent as
   * words). False when it cannot. `told`: who sent it, for a message no `queue.changed`
   * names as `steered`: the thread's followers are told it joined the turn with
   * `message.steered` (feature `turn_messages`).
   */
  private steerIn(prompt: Prompt, told?: { sender: Sender; messageID?: string }, messageID = told?.messageID): boolean {
    const provider = this.provider;
    if (!this.running || !provider?.steer || provider.steerable?.() === false || isCommand(prompt)) return false;
    this.recordSteer(prompt, messageID, told);
    this.steering += 1;
    const steered = ++this.steeredIn;
    this.steersOut.add(steered);
    void provider
      .steer(prompt)
      .catch(() => false)
      .then((taken) => {
        this.steering -= 1;
        this.steersOut.delete(steered);
        if (taken !== true) this.resend(prompt, steered, taken === "refused");
        else {
          // One said again that waited for this one to be taken goes now.
          if (!this.running) this.startNext();
          if (!this.isBusy) this.tell((listener) => listener.steerSettled?.(this.id));
        }
      });
    return true;
  }

  private recordSteer(prompt: Prompt, messageID?: string, told?: { sender: Sender; messageID?: string }): void {
    // Handed to the running turn, it answers what the agent asked without waiting, as one opening a turn does (`begin`).
    this.withdrawAsked("replied");
    // The answers given on a card (feature async_questions): their row shows them.
    const cardAnswer = this.cardAnswerOf.get(prompt);
    if (messageID !== undefined) this.steeredIDs.set(prompt, messageID);
    this.transcript.steer(storedUserText(prompt), messageID, cardAnswer);
    if (told) this.emit("message.steered", messageFields(storedUserText(prompt), told.sender, told.messageID, this.fromOf(storedUserText(prompt)), cardAnswer));
    const cleared = this.endedToClear(prompt);
    const preview = previewOf(storedUserText(prompt));
    const kept = preview || cleared.length > 0 ? this.writeTurn(() => this.write({ ...(preview ? { preview } : {}), ...this.clearedChanges(cleared) })) : true;
    if (kept) this.clear(cleared);
  }

  /** Persists the handoff ID before sending. Pending entries never open a second turn. */
  private async handQueued(queued: Queued): Promise<boolean> {
    const provider = this.provider;
    if (!this.running || !provider?.enqueue || queued.requestId || queued.starting || queued.failure || isCommand(queued.prompt)) return false;
    queued.requestId = `portals-${randomUUID()}`;
    if (!this.keepQueue()) { queued.requestId = undefined; return false; }
    try {
      const accepted = await provider.enqueue(queued.prompt, queued.requestId);
      if (!accepted && this.queue.includes(queued)) {
        queued.requestId = undefined;
        queued.placement = "queue";
        this.keepQueue();
        this.emitQueue();
        if (!this.running) this.startNext();
      }
      return accepted && !queued.failure;
    } catch {
      if (this.queue.includes(queued)) {
        this.failQueued(queued, "The agent could not confirm this steering message. It was not sent again automatically. Review it and try again.");
      }
      return false;
    }
  }

  private failQueued(queued: Queued, error: string): void {
    queued.failure = error;
    queued.failedRequestId ??= queued.requestId;
    queued.requestId = undefined;
    queued.placement = "queue";
    this.keepQueue();
    this.emitQueue();
    if (!this.running) this.startNext();
  }

  /** Whether the agent can take a message into a running turn at all (feature `queue`). */
  get canSteer(): boolean {
    return typeof this.provider?.steer === "function" || typeof this.provider?.enqueue === "function";
  }

  /** The messages waiting for the running turn to end, oldest first, as devices are shown them. */
  queuedMessages(): QueuedMessage[] {
    return this.queue
      .filter((queued) => !queued.resent)
      .map((queued) => {
        const text = storedUserText(queued.prompt);
        const from = queued.fleet ? this.fromOf(text) : undefined;
        // The answers given on a card, waiting to go to the agent (feature async_questions).
        const cardAnswer = this.cardAnswerOf.get(queued.prompt);
        return {
          id: queued.id, text, ...(queued.fleet ? { fleet: true } : {}), ...(from ? { from } : {}), ...(queued.placement ? { placement: queued.placement } : {}),
          ...(cardAnswer !== undefined ? { card_answer: cardAnswer } : {}),
          // The id its device gave it (feature `message_ids`): one whose send lost its answer knows it waits.
          ...(queued.messageID !== undefined ? { message_id: queued.messageID } : {}),
        };
      });
  }

  /** Takes a waiting message off the list: it is never sent. False when it is not waiting (any more). */
  removeQueued(id: string): boolean | Promise<boolean> {
    const index = this.queue.findIndex((queued) => queued.id === id && !queued.resent && !queued.starting);
    if (index === -1) return false;
    const queued = this.queue[index];
    if (queued.changing) return false;
    if (queued.requestId) {
      return this.deleteHeld(queued).then((deleted) => {
        if (!deleted) return false;
        // Still held since its deletion (`deleteHeld`): no turn has taken it meanwhile.
        queued.changing = false;
        return this.removeQueued(id) === true;
      });
    }
    this.queue.splice(index, 1);
    this.keepQueue();
    this.emitQueue();
    // A turn may have ended while Droid deleted this message, leaving those behind it waiting.
    if (!this.running) this.startNext();
    // The one the agent was asked about: the next waits its own time.
    this.watchReach();
    // The last thing it had to do (waiting behind the agent's side catching up): at rest now.
    if (!this.isAtWork) this.tell((listener) => listener.steerSettled?.(this.id));
    return true;
  }

  /**
   * Hands a waiting message to the running turn now ("Steer now"). `steered` when it was,
   * `queued` when the agent cannot take it in now and it waits on, `gone` when it is not
   * waiting any more.
   */
  steerQueued(id: string): "steered" | "queued" | "gone" | Promise<"steered" | "queued" | "gone"> {
    const index = this.queue.findIndex((queued) => queued.id === id && !queued.resent && !queued.starting);
    if (index === -1) return "gone";
    if (this.provider?.enqueue) return this.placeQueued(id, "steer").then((status) => status === "moved" ? "steered" : status);
    const [queued] = this.queue.splice(index, 1);
    if (!this.steerIn(queued.prompt, undefined, queued.messageID)) {
      this.queue.splice(index, 0, queued);
      return "queued";
    }
    this.keepQueue();
    this.emitQueue(id);
    return "steered";
  }

  /**
   * Takes a message handed to the agent back from it (Droid's own queue). True when it
   * was: the message is then still held (`changing`), so that no turn ending in the steps
   * before the caller acts on it takes it as the next to send, and the caller lets go of
   * it. False, let go of, when it was not.
   */
  private async deleteHeld(queued: Queued): Promise<boolean> {
    if (!queued.requestId || queued.changing || !this.provider?.deleteQueued) return false;
    queued.changing = true;
    let deleted = false;
    try {
      deleted = await this.provider.deleteQueued(queued.requestId) && this.queue.includes(queued);
      if (!deleted) return false;
      // Kept, should Droid's receipt for it come after all (`queue.taken`).
      queued.takenBackRequestIds = [...queued.takenBackRequestIds ?? [], queued.requestId];
      queued.requestId = undefined;
      queued.failure = undefined;
      return true;
    } catch { return false; }
    finally { if (!deleted) queued.changing = false; }
  }

  async placeQueued(id: string, placement: QueuePlacement): Promise<"moved" | "queued" | "gone"> {
    const queued = this.queue.find((entry) => entry.id === id && !entry.resent && !entry.starting);
    if (!queued) return "gone";
    if (!this.provider?.enqueue || queued.changing || queued.failure) return "queued";
    if (placement === "steer" && isCommand(queued.prompt)) return "queued";
    if (placement === "queue" && queued.requestId) {
      if (!await this.deleteHeld(queued)) return this.queue.includes(queued) ? "queued" : "gone";
      // Held since its deletion (`deleteHeld`), placed now.
      queued.changing = false;
    }
    queued.placement = placement;
    this.keepQueue();
    this.emitQueue();
    if (placement === "queue") {
      if (!this.running) this.startNext();
      return "moved";
    }
    if (queued.requestId || await this.handQueued(queued)) return this.queue.includes(queued) ? "moved" : "gone";
    return this.queue.includes(queued) ? "queued" : "gone";
  }

  /**
   * Writes the messages waiting to disk (`queue`, those of the session when not given),
   * with those kept as failed, in the step that changed them. A disk that cannot be
   * written costs only what a restart would lose: the bridge goes on. False then.
   */
  private keepQueue(queue: readonly Queued[] = this.queue): boolean {
    if (!this.waiting || this.retired) return true;
    try {
      this.waiting.write(
        this.id,
        queue.map((queued) => ({ id: queued.id, text: queued.prompt.text, images: queued.prompt.images, files: queued.prompt.files, mentions: queued.prompt.mentions, fleet: queued.fleet, resent: queued.resent, refused: queued.refused,
          placement: queued.placement, requestId: queued.requestId, failure: queued.failure, failedRequestId: queued.failedRequestId,
          takenBackRequestIds: queued.takenBackRequestIds, messageID: queued.messageID,
          cardAnswer: this.cardAnswerOf.get(queued.prompt) })),
        this.failed,
      );
      return true;
    } catch (error) {
      log.warn("could not keep the messages waiting on disk", { session: this.id, error: (error as Error).message });
      this.writeFailed(error);
      return false;
    }
  }

  /**
   * Tells the thread's followers the messages waiting now (feature `queue`); `steered`,
   * the one that left the list for the running turn, which every device shows there.
   */
  private emitQueue(steered?: string): void {
    const payload: Record<string, unknown> = { queued: this.queuedMessages(), can_steer: this.canSteer };
    if (steered !== undefined) payload.steered = steered;
    this.emit("queue.changed", payload);
  }

  /**
   * True when a running turn was stopped; the turn still ends with `message.complete`.
   * With no turn running, true when questions were open: one an agent put outside any
   * turn keeps the thread at work, and no turn's end would take it back. And true when
   * the agent stops a message handed to a turn that has ended since, which keeps the
   * thread at work too until the agent has taken it or begun a turn of its own for it.
   * `keepBackground`: the subagents and workflows in the background run on (the app
   * stops each by itself, feature subagents); else they are stopped with the turn, as
   * Claude Code stopped them by itself before the bridge told it the app can.
   */
  async interrupt(keepBackground = false): Promise<boolean> {
    if (!this.provider) return false;
    const provider = this.provider;
    const turn = this.turns;
    // Commands left running in the background are not the turn's: Stop leaves them, as it did before they had rows.
    const background = [...this.subagents.values()].map(({ info }) => info).filter((info) => info.status === "running" && info.stoppable && info.kind !== "command");
    const stopping: SubagentInfo[] = [];
    const questions = new Set(this.requests.list().map(({ id }) => id));
    const withdraw = (currentTurn = true) => this.withdrawInterruptedQuestions(keepBackground, questions, currentTurn ? background : stopping, currentTurn);
    if (!this.running) {
      const open = this.requests.list().length;
      // A subagent the Stop leaves running may still be answered, also once the turn is over.
      withdraw();
      const withdrawn = this.requests.list().length < open;
      const pending = this.steering > 0 && (await provider.interrupt());
      // Another turn began while the agent took the Stop: the runs captured before it are
      // still the Stop's to end, the new turn's own are not.
      const stopped = !keepBackground && this.provider === provider && (await this.stopBackground(turn, background, stopping, this.turns !== turn));
      if (this.provider === provider) withdraw(this.turns === turn);
      return withdrawn || pending || stopped;
    }
    const stopped = await this.stopWithin(provider, turn);
    if (this.provider !== provider) return stopped;
    if (this.turns !== turn) {
      // The stopped turn ended and the next began (a message waiting) before the agent
      // answered the Stop. That turn and its questions are left alone; the background runs
      // captured before the wait are still stopped, and their questions withdrawn.
      if (!keepBackground) {
        await this.stopBackground(turn, background, stopping, true);
        if (this.provider === provider) withdraw(false);
      }
      return stopped;
    }
    withdraw();
    if (!keepBackground) await this.stopBackground(turn, background, stopping);
    if (this.provider === provider) withdraw(this.turns === turn);
    return stopped;
  }

  /**
   * Stop as the agent takes it, waited for `stopWaitMs` at most. An agent that has not
   * taken it by then (it cannot be reached, a call to it hangs), or that failed to, has
   * its turn ended here, as stopped: the app can go on, and the agent may still be at it
   * (`stopping`, which keeps such a thread from being removed). What it still says of that
   * turn is let go of (`take`), and a message sent meanwhile waits until the agent is past
   * it (`stoppedHere`).
   */
  private async stopWithin(provider: ProviderSession, turn: number): Promise<boolean> {
    const asked = provider.interrupt();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), stopWaitMs);
      timer.unref();
    });
    let failure: Error | undefined;
    let answeredLate = false;
    try {
      const answer = await Promise.race([asked, late]);
      if (answer !== "late") return answer;
      answeredLate = true;
    } catch (error) {
      failure = error as Error;
    } finally {
      clearTimeout(timer);
    }
    // The turn ended meanwhile, or the next began: there is nothing left to end here.
    if (this.provider !== provider || this.turns !== turn || !this.running || !this.transcript.isInTurn) {
      if (failure) throw failure;
      return true;
    }
    log.warn(failure ? "the agent failed to take a Stop, so its turn ends here" : "the agent did not take a Stop in time, so its turn ends here", { session: this.id, error: failure?.message });
    // Before its end, which would start a message waiting: that waits for the agent to be past this turn.
    const held = (this.stoppedHere = { provider });
    this.end({ type: "turn.end", status: "interrupted" });
    // Its answer, when it comes: true, the agent ends the turn as it does any it stopped;
    // false, nothing was running any more, and no end comes. A failure leaves the turn to
    // end as the agent ends it.
    if (answeredLate) {
      asked.then(
        (stopped) => { if (!stopped) this.letGoOfStop(held); },
        (error: Error) => log.warn("the agent failed to take a Stop after its turn was ended here", { session: this.id, error: error?.message }),
      );
    }
    return true;
  }

  /**
   * Takes back the questions open as a turn ends or is stopped. Those a subagent asked
   * stay open (it may run on, and still be answered) when the background is kept and a
   * device that keeps them has followed the thread; an older app drops its cards at a
   * turn's end and could never answer them.
   */
  private withdrawTurnQuestions(reason: string, keepBackground = true): void {
    if (keepBackground && this.keepsSubagentQuestions) this.requests.withdrawTurn(reason);
    // Those asked without waiting stay: the person's answer opens a turn of its own.
    else for (const request of this.requests.list()) if (request.params.async !== true) this.requests.withdraw(request.id, reason);
  }

  /**
   * Takes back the questions an agent asked without waiting (feature async_questions):
   * `replied` when a message of the person's has gone to the agent, which takes it as the answer.
   */
  private withdrawAsked(reason: "replied" | "withdrawn"): Extract<ProviderEvent, { type: "questions" }> | null {
    // Those whose card is open: what a message answered, should it not reach the agent.
    const open = this.askedOpen;
    this.askedOpen = null;
    for (const request of this.requests.list()) if (request.params.async === true) this.requests.withdraw(request.id, reason);
    // Those found open as the thread was loaded, not put again yet: a message answers them,
    // which their row says as for a card it closes, and a newer question takes their place.
    const before = this.askedBefore;
    this.askedBefore = null;
    if (before && reason === "replied") this.handle({ type: "tool.end", id: before.id, name: "clarify", args: askedRowArgs(before.questions), result: null });
    return open?.event ?? before;
  }

  /**
   * The turn a message of the person's opened failed before the agent produced anything
   * in it (`end`): the message never reached the agent as the answer to the questions it
   * asked without waiting, which it took back (`begin`). They are put again as their card
   * (as `askAgain` puts them), their row asking again; with no device that keeps such
   * cards, they wait as those found open as the thread was loaded do, for the first that
   * opens the thread, their row unanswered. Not when a newer question was asked meanwhile.
   */
  private putBackAnswered(asked: Extract<ProviderEvent, { type: "questions" }>): void {
    if (this.retired || this.isReadOnly || this.askedOpen || this.askedBefore) return;
    if (this.keepsAsyncQuestions) {
      void this.askAhead(asked, true);
      return;
    }
    this.handle({ type: "tool.end", id: asked.id, name: "clarify", args: askedRowArgs(asked.questions), result: { responses: [], unanswered: true } });
    this.askedBefore = asked;
  }

  /**
   * Questions the agent asked without waiting, put to the devices as a card that stays
   * open past the turn's end (feature async_questions). The thread keeps a row of them
   * (a `clarify` tool's, shown as asked and answered), and the answers go to the agent as
   * the person's message: handed to the running turn, else opening one, marked as the
   * card's (`card_answer`), which the row shows in its place. A newer such question takes
   * back the one before, and a message of the person's to the agent answers it in their
   * own words. How the card settled them is kept with the thread (`keepCardAnswer`).
   * `again`: put again (`askAgain`), they have had their row since they were asked.
   */
  private async askAhead(event: Extract<ProviderEvent, { type: "questions" }>, again = false): Promise<void> {
    // Taken off the list: no device follows it, and no card is put or notified for it.
    if (this.retired) return;
    this.withdrawAsked("withdrawn");
    const args = askedRowArgs(event.questions);
    // The row is kept where they were asked at once, as open (no row while its card
    // stands for it), and takes how they ended in place: the turn's end, or a message of
    // the person's opening another, would leave it in a later turn.
    if (!again) this.handle({ type: "tool.start", id: event.id, name: "clarify", args });
    this.handle({ type: "tool.end", id: event.id, name: "clarify", args, result: askingResult });
    // The card is put to the devices in this step (`askAgain` counts on it).
    this.askingAgain = again;
    const open = { event };
    this.askedOpen = open;
    const asking = this.ask({ kind: "clarify", questions: event.questions, async: true });
    this.askingAgain = false;
    const answer = await asking;
    if (this.askedOpen === open) this.askedOpen = null;
    if (this.retired) return;
    // Put again since (`putBackAnswered`): that card has their row now.
    if (this.askedOpen?.event.id === event.id) return;
    const answers = answer.kind === "clarify" ? answer.answers : null;
    const said = answers ? answerMessage(event.questions, answers) : null;
    this.handle({ type: "tool.end", id: event.id, name: "clarify", args, result: askedResult(event.questions, answer) });
    this.keepCardAnswer(event, answer, said);
    if (said) this.sayNote(said, event.id);
  }

  /**
   * Keeps with the thread how the card settled questions asked without waiting (answered,
   * skipped, or taken back with Stop), which the agent's history does not say
   * (sessions/answers.ts): the latest few. Those a message answered, or a newer question
   * took the place of, the history tells as they were. A record that cannot be written
   * costs only that, after a restart.
   */
  private keepCardAnswer(event: Extract<ProviderEvent, { type: "questions" }>, answer: RequestAnswer, said: string | null): void {
    if (answer.kind !== "clarify" && !(answer.kind === "withdrawn" && answer.reason === "interrupted")) return;
    const answers = cardAnswers(event.questions, answer);
    const entry: CardAnswer = { id: event.id, ...(answers ? { answers } : {}), ...(said ? { said } : {}) };
    const kept = [...readCardAnswers(this.record.cardAnswers).filter((other) => other.id !== event.id), entry].slice(-cardAnswersKept);
    try {
      this.write({ cardAnswers: kept });
    } catch (error) {
      log.warn("could not keep how a card settled its questions", { session: this.id, error: (error as Error).message });
      this.writeFailed(error);
    }
  }

  /**
   * After another turn starts, Stop owns only captured questions and those of runs
   * it actually asked to stop, never the new turn's foreground questions.
   */
  private withdrawInterruptedQuestions(keepBackground: boolean, captured: ReadonlySet<string>, targets: readonly SubagentInfo[], includeTurn: boolean): void {
    for (const request of this.requests.list()) {
      const background = typeof request.params.subagent === "string";
      if (background && keepBackground && this.keepsSubagentQuestions) continue;
      const owner = this.questionRuns.get(request.id);
      if ((!background && includeTurn) || captured.has(request.id) || (owner && targets.some((target) => sameSubagentRun(target, owner)))) {
        this.requests.withdraw(request.id, "interrupted");
      }
    }
  }

  /**
   * Stops captured runs still current, recording those actually asked to stop; true when one was.
   * Stops at a turn begun meanwhile, unless `acrossTurns`: the Stop was answered only after the
   * next turn began, and the runs were captured before that.
   */
  private async stopBackground(turn: number, targets: readonly SubagentInfo[], stopping: SubagentInfo[], acrossTurns = false): Promise<boolean> {
    const provider = this.provider;
    let any = false;
    for (const info of targets) {
      if ((!acrossTurns && this.turns !== turn) || this.provider !== provider) break;
      const current = this.subagents.get(info.id)?.info;
      if (!current || current.status !== "running" || !current.stoppable || !sameSubagentRun(current, info)) continue;
      if (!provider?.stopSubagent) continue;
      stopping.push(info);
      try {
        any = (await provider.stopSubagent(info.id)) === true || any;
      } catch (error) {
        log.warn("could not stop a subagent with the turn", { session: this.id, subagent: info.id, error: (error as Error).message });
      }
    }
    return any;
  }

  /** The `subagent.list` answer: every subagent and workflow the agent started, oldest first, but those that have left the line. */
  subagentList(): Record<string, unknown>[] {
    return [...this.subagents.values()].filter(({ cleared }) => !cleared).map(({ info, turn }) => subagentPayload(info, turn, this.canRead(info)));
  }

  /**
   * A message of the user's goes to the agent: the subagents and workflows that have
   * ended leave the line on every device (feature subagents_clear). These are they: the
   * caller keeps them with the thread (`clearedChanges`, in the write the message makes
   * anyway) and only then takes them off (`clear`), which tells every device once the
   * turn has started. Those still at work stay, also once they end, until the next message.
   */
  private endedToClear(prompt: Prompt): string[] {
    if (isCommand(prompt)) return [];
    return [...this.subagents].filter(([, entry]) => !entry.cleared && entry.info.status !== "running").map(([id]) => id);
  }

  /** Takes `ids` off the line (`endedToClear`), and tells every device. */
  private clear(ids: readonly string[]): void {
    for (const id of ids) {
      const entry = this.subagents.get(id);
      if (!entry) continue;
      entry.cleared = true;
      entry.info = offTheLine(entry.info);
    }
    if (ids.length > 0) this.emit("subagent.cleared", { subagent_ids: ids });
  }

  /**
   * The thread's record with `ids` among those that have left the line, each with the run
   * it had come to: kept so that a restart of the bridge leaves them off it. The stored
   * conversation cannot say it: Codex keeps no time for a message steered in, and dates a
   * sub-agent's end by its turn's. The latest ones only: the line shows the last turn's.
   */
  private clearedChanges(ids: readonly string[]): ThreadChanges {
    if (ids.length === 0) return {};
    const kept = this.clearedKept().filter((entry) => !ids.includes(entry.id));
    const added = ids.map((id): ClearedSubagent => {
      const run = this.subagents.get(id)?.info.run;
      return run !== undefined ? { id, run } : { id };
    });
    return { subagentsCleared: [...kept, ...added].slice(-clearedKept) };
  }

  /** The record's `subagentsCleared`, but entries it cannot read. */
  private clearedKept(): ClearedSubagent[] {
    const kept: unknown = this.record.subagentsCleared;
    return Array.isArray(kept) ? kept.filter((entry): entry is ClearedSubagent => typeof entry?.id === "string" && (entry.run === undefined || typeof entry.run === "string")) : [];
  }

  /**
   * Whether `subagent`, as a stored conversation tells of it, is one that left the line,
   * by the record: ended, and no other run than the one that left (where both runs are
   * known; where either is not, it is taken for that one).
   */
  private leftAsIs(subagent: SubagentInfo): boolean {
    const left = this.clearedKept().find((entry) => entry.id === subagent.id);
    return left !== undefined && subagent.status !== "running" && (left.run === undefined || subagent.run === undefined || left.run === subagent.run);
  }

  /**
   * One that had left the line is in another run (a Codex sub-agent given more to do): no
   * longer kept as cleared, so that a restart does not hide this run of it. A record that
   * cannot be written only costs that.
   */
  private unclear(id: string): void {
    const kept = this.clearedKept();
    if (!kept.some((entry) => entry.id === id)) return;
    const left = kept.filter((entry) => entry.id !== id);
    try {
      this.write({ subagentsCleared: left.length > 0 ? left : undefined });
    } catch (error) {
      log.warn("could not write that a subagent is at work again", { session: this.id, error: (error as Error).message });
      this.writeFailed(error);
    }
  }

  /** Whether `subagent.read` gives what `subagent` did (feature subagent_read): an agent, not a workflow or a command, of an agent that keeps it. */
  private canRead(subagent: SubagentInfo): boolean {
    return subagent.kind === "agent" && this.provider?.subagentMessages !== undefined;
  }

  /**
   * A subagent's own conversation (`subagent.read`), as its agent keeps it now: one still at
   * work gives what it has done so far. Null when it is not one that can be read.
   */
  async subagentMessages(id: string): Promise<StoredMessage[] | null> {
    const known = this.subagents.get(id)?.info;
    const provider = this.provider;
    if (!known || !this.canRead(known) || !provider?.subagentMessages) return null;
    return await provider.subagentMessages(id);
  }

  /** Stops one subagent or workflow (`subagent.stop`). False when it is not one still running that can be. */
  async stopSubagent(id: string): Promise<boolean> {
    const known = this.subagents.get(id)?.info;
    if (!known || known.status !== "running" || !known.stoppable || !this.provider?.stopSubagent) return false;
    return await this.provider.stopSubagent(id);
  }

  async mcpAuth(action: McpAuthAction): Promise<{ servers: McpAuthCard[] }> {
    const provider = this.provider;
    if (!provider?.mcpAuth) {
      if (action.action === "list") return { servers: [] };
      throw new SettingRefused("This agent does not offer MCP sign-in.");
    }
    return this.setting(() => provider.mcpAuth!(action));
  }

  async setModel(model: string, provider: string): Promise<ModelChangeResult> {
    return this.setting(async () => {
      const result = await this.requireProvider().setModel(model, provider);
      this.write({ model, provider });
      return result;
    });
  }

  async setReasoning(level: string): Promise<void> {
    await this.setting(async () => {
      await this.requireProvider().setReasoning(level);
      this.write({ reasoningEffort: level });
    });
  }

  /**
   * A setting on its way to the agent (a model, a level, a mode, a title), counted while
   * it is: the thread is not loaded again meanwhile (`atRest`), which would answer it as
   * made and lose it (Codex's review of a6e4bd2c).
   */
  async setting<T>(work: () => Promise<T>): Promise<T> {
    if (this.checkpointing) throw new DeskRefused("Wait for the current thread action to finish before changing it.");
    this.settingsOnTheWay += 1;
    try {
      return await work();
    } finally {
      this.settingsOnTheWay -= 1;
    }
  }

  /** Hold an idle source while its native conversation is copied. */
  async forkAt<T>(checkpointId: string, before: boolean, work: () => Promise<T>): Promise<T> {
    return this.checkpointWork(async () => {
      const checkpoint = this.checkpoint(checkpointId);
      if (!checkpoint || !(before ? checkpoint.can_edit : checkpoint.can_fork)) throw new DeskRefused("This message cannot be forked. Open the thread again to refresh its history.");
      return work();
    });
  }

  async previewFileUndo(owner: Peer, checkpointId: string) {
    return this.checkpointWork(async () => {
      if (!this.checkpoint(checkpointId)?.can_undo_files) throw new FileUndoRefused("This turn has no file checkpoint available.");
      const provider = this.requireProvider();
      if (!provider.rewindFiles) throw new FileUndoRefused("This agent does not support file undo.");
      return this.fileUndo.preview(owner, checkpointId, this.record.cwd, (id, dryRun) => provider.rewindFiles!(id, dryRun));
    });
  }

  async undoFiles(owner: Peer, previewId: string, afterReply: (action: () => void) => void) {
    return this.checkpointWork(async () => {
      const provider = this.requireProvider();
      if (!provider.rewindFiles) throw new FileUndoRefused("This agent does not support file undo.");
      let attempted = false;
      try {
        return await this.fileUndo.undo(owner, previewId, this.record.cwd, (id, dryRun) => {
          if (!attempted && !this.checkpoint(id)?.can_undo_files) throw new FileUndoRefused("This turn's file checkpoint is no longer available.");
          if (!dryRun) attempted = true;
          return provider.rewindFiles!(id, dryRun);
        });
      } catch (error) {
        if (attempted) throw new FileUndoRefused("The restore could not be confirmed complete. Some files may have changed. Review the folder before continuing.");
        throw error;
      } finally {
        if (attempted) {
          for (const message of this.transcript.messages) if (message.role === "user" && message.checkpoint?.can_undo_files) message.checkpoint = { ...message.checkpoint, can_undo_files: false };
          afterReply(() => this.invalidate());
        }
      }
    });
  }

  private checkpoint(id: string): MessageCheckpoint | undefined {
    return this.messages.flatMap((message) => message.role === "user" && message.checkpoint ? [message.checkpoint] : []).find((point) => point.id === id);
  }

  private async checkpointWork<T>(work: () => Promise<T>): Promise<T> {
    if (this.retired || this.isReadOnly) throw new DeskRefused("Continue this thread before using this action.");
    if (!this.atRest || this.provider?.hasBackgroundWork?.()) throw new DeskRefused("Wait until this thread has finished before using this action.");
    this.checkpointing = true;
    try {
      if (await this.provider?.stopping?.()) throw new DeskRefused("Wait until the agent has stopped before using this action.");
      if (this.retired || this.closing || this.isAtWork || this.provider?.hasBackgroundWork?.()) throw new DeskRefused("Wait until this thread has finished before using this action.");
      return await work();
    } finally {
      this.checkpointing = false;
    }
  }

  /** How much the thread asks before acting; null for an agent without modes. */
  mode(): ModeState | null {
    const state = this.provider?.mode?.();
    return state ? { ...state, ...(this.modeOptions ? { options: this.modeOptions } : {}) } : null;
  }

  async setMode(mode: ThreadMode): Promise<void> {
    const provider = this.requireProvider();
    if (!provider.setMode) throw new Error("This agent has no modes.");
    if (mode === "medium" && !this.mode()?.options?.some((option) => option.id === mode)) throw new Error("This agent does not offer Medium autonomy.");
    await this.setting(() => provider.setMode!(mode));
    this.saveMode(mode);
    this.emitMode();
  }

  /**
   * Keeps the thread's mode for the next start; going into plan mode, also the one it
   * left. Back in `default` from another mode, also that the other mode's policy is to be
   * undone (`modeReset`), which a restart of the bridge meanwhile would otherwise forget,
   * until a turn has ended with the agent no longer waiting to undo it. Plan mode keeps
   * it: its turns run with the policy of the mode it left. Another mode sends its own.
   */
  private saveMode(mode: ThreadMode): void {
    const before = this.record.mode ?? "default";
    const changes: ThreadChanges = mode === "plan" && before !== "plan" ? { mode, modeBeforePlan: before } : { mode };
    if (mode === "default" && before !== "default") changes.modeReset = true;
    else if (mode !== "default" && mode !== "plan") changes.modeReset = undefined;
    this.write(changes);
  }

  /** Tells the thread's followers its mode (feature modes). */
  private emitMode(): void {
    const fields = modeFields(this.mode());
    if (Object.keys(fields).length > 0) this.emit("session.mode", fields);
  }

  /** Gives the thread a title of the user's, on the agent's side too when it keeps one. */
  async rename(title: string): Promise<void> {
    await this.setting(async () => this.provider?.rename?.(title));
    this.handle({ type: "title", title });
  }

  /**
   * True while the agent may be running a turn this session does not show as running
   * (`ProviderSession.stopping`: one Codex's grace timer ended, or one begun at the desk
   * not reported yet): the thread is still at work.
   */
  async stopping(): Promise<boolean> {
    // A turn Stop ended here that the agent has not ended yet (`stopWithin`).
    if (this.heldByStop) return true;
    return (await this.provider?.stopping?.()) ?? false;
  }

  /** The agent may still run a turn Stop ended here (`stoppedHere`): nothing goes to it until it is past that turn. */
  private get heldByStop(): boolean {
    return this.stoppedHere !== null && this.stoppedHere.provider === this.provider;
  }

  /** The agent is past the turn Stop ended here (`held`): the message waiting, if one does, goes now. */
  private letGoOfStop(held: { provider: ProviderSession }): void {
    if (this.stoppedHere !== held) return;
    this.stoppedHere = null;
    if (!this.running && !this.retired) this.startNext();
  }

  /**
   * The agent runs work of the thread's on after its turn ended, which closing the session
   * would end (`ProviderSession.hasBackgroundWork`), or a subagent or workflow is still at
   * work, which closing it would lose sight of (a Codex sub-agent runs on in Codex).
   */
  get hasBackgroundWork(): boolean {
    return (this.provider?.hasBackgroundWork?.() ?? false) || this.hasRunningSubagents;
  }

  /**
   * Lets go of the session for good, in the step that takes it out of the live sessions:
   * whatever the agent answers late (a turn, a title, a message turned down) starts
   * nothing and changes no record. `close` then lets go of the agent's side.
   */
  retire(): void {
    this.retired = true;
    if (this.followers.size > 0) this.provider?.setFollowed?.(false);
    this.followers.clear();
    this.queue.length = 0;
    this.watchReach();
    this.watchQuiet();
  }

  /**
   * The bridge is closing: no turn opens for a message waiting from now on, and none fails
   * for an agent that cannot be reached: it waits on disk for the next start. `close` follows.
   */
  closeSoon(): void {
    this.closing = true;
    this.sayNotesDue();
    this.watchReach();
    this.watchQuiet();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.sayNotesDue();
    this.watchReach();
    this.watchQuiet();
    if (this.followers.size > 0) this.provider?.setFollowed?.(false);
    this.followers.clear();
    await this.provider?.close();
  }

  /** The notes due a step later (`notesDue`), now: closing, they wait on disk. */
  private sayNotesDue(): void {
    for (const due of [...this.notesDue]) {
      this.notesDue.delete(due);
      this.sayNote(due.note);
    }
  }

  private requireProvider(): ProviderSession {
    if (!this.provider) throw new Error("The session is still loading.");
    return this.provider;
  }

  // MARK: Turns

  /**
   * The turn's start carries its message, who sent it and the id the device gave it
   * (feature `turn_messages`), so every device following the thread opens the turn with
   * it, and the one that sent it knows it as its own. One through the fleet also says it
   * was `opened_by` Portals, as before that feature: an app without it opens the turn
   * with that message, not with one of its own still waiting. `queued`: the id the
   * message had while it waited, which the turn's start names (feature `queue`).
   */
  private begin(prompt: Prompt, opening: Opening = {}): void {
    if (this.retired) return;
    const { resent = false, fleet = false } = opening;
    this.running = true;
    // A message of the person's goes to the agent now: it is the answer an agent that
    // asked without waiting takes, so its card goes (not for a command such as /compact,
    // which brings the agent no message). One said again too (steered in, then turned
    // down): it closed the cards open as it was steered in, and the agent, which only has it
    // now, takes it as the answer to any it asked since.
    const answered = isCommand(prompt) ? null : this.withdrawAsked("replied");
    // A message waiting for the agent's side to catch up waits for this turn now (one a
    // no's note opens at rest goes ahead of it).
    this.watchReach();
    this.turns += 1;
    this.answeredByTurn = answered;
    this.replyText = "";
    this.turnBegan = Date.now();
    const text = storedUserText(prompt);
    // The answers given on a card (feature async_questions): their row shows them.
    const cardAnswer = this.cardAnswerOf.get(prompt);
    if (resent) this.transcript.startTurn("", hiddenOpener);
    else this.transcript.startTurn(text, undefined, opening.messageID, cardAnswer);
    // One said again (`resent`) cleared the line when it was steered in.
    const cleared = resent ? [] : this.endedToClear(prompt);
    // A message said again keeps the preview it already gave when it was handed over.
    const kept = this.turnStarted(resent ? undefined : previewOf(text), cleared);
    this.emit("message.start", resent ? undefined : startFields(text, { ...opening, fleet }, this.fromOf(text), cardAnswer));
    // After the turn's start, which every device opens the turn with.
    if (kept) this.clear(cleared);
    this.tellDiskLow();
    try {
      this.requireProvider().startTurn(prompt);
    } catch (error) {
      // As if the agent had said it: a failure to take that in is logged, not thrown at whoever began the turn.
      this.take({ type: "turn.end", status: "error", error: `The agent could not start: ${(error as Error).message}` });
    }
  }

  /**
   * A turn the agent began without the app: at the desk, shown as the app's own would
   * be, or by itself, opened by a line that says why (as Hermes announces its own).
   * `clears`: for one told late, the subagents its message may take off the line.
   */
  private beginElsewhere(user: string, host?: HostNote, clears?: readonly EndedSubagent[], command?: boolean): void {
    if (this.retired) return;
    if (this.queuedStart && !this.transcript.isInTurn) {
      // The provider began before the scheduled Queue turn. Keep the message waiting
      // behind it, and cancel only this reservation, never a newer one for the same entry.
      this.queuedStart.entry.starting = false;
      this.queuedStart = null;
      this.running = false;
    }
    if (this.running) {
      log.warn("a provider began a turn while one was running", { session: this.id });
      return;
    }
    this.running = true;
    // Typed at the desk, a message of the person's goes to the agent as one sent from a
    // device does (`begin`): the answer an agent that asked without waiting takes, so its
    // card goes. Not a line the agent opened its own turn with, nor a command: as the agent
    // says (`command`), else by its words, which cannot tell one with a picture attached.
    if (!host && user.trim() !== "" && !(command ?? isCommand({ text: user, images: [] }))) this.withdrawAsked("replied");
    // A message waiting for the agent's side to catch up waits for this turn now.
    this.watchReach();
    // The agent is past a turn Stop ended here: what waits goes once this one ends.
    this.stoppedHere = null;
    this.turns += 1;
    this.answeredByTurn = null;
    this.replyText = "";
    this.turnBegan = Date.now();
    this.transcript.startTurn(user, host);
    // Typed at the desk: a message of the user's. One the agent began by itself is not.
    // One told late takes off only those that had ended when it was heard (`clears`): a
    // subagent whose end the bridge heard after it stays on the line until the next
    // message, as for one typed while the bridge was off.
    const ended = !host && user.trim() !== "" ? this.endedToClear({ text: user, images: [] }) : [];
    const cleared = clears ? ended.filter((id) => clears.some((entry) => entry.id === id && entry.run === this.subagents.get(id)?.info.run)) : ended;
    // A line of the agent's own is not something said to it: the preview stays.
    const kept = this.turnStarted(host ? undefined : previewOf(user), cleared);
    if (host && host.kind !== "hidden") {
      this.emit("status.update", { kind: "process", text: host.text });
      // The line opens the turn; it is not what the agent is doing now.
      this.emit("thinking.delta", { text: "" });
    }
    // Said at the desk: every device opens the turn with it (feature turn_messages).
    this.emit("message.start", !host && user !== "" ? messageFields(user, "desk") : undefined);
    if (kept) this.clear(cleared);
    this.tellDiskLow();
  }

  private end(event: TurnEnd): void {
    if (!this.transcript.isInTurn) {
      log.warn("a provider ended a turn that was not running", { session: this.id });
      return;
    }
    if (event.usage) this.usage = event.usage;
    // A question still open when its turn ends can no longer be answered, unless a
    // subagent that runs on after it asked it.
    this.withdrawTurnQuestions(event.status === "interrupted" ? "interrupted" : "withdrawn");
    // The message that opened it failed to reach the agent as their answer.
    const answered = event.status === "error" ? this.answeredByTurn : null;
    this.answeredByTurn = null;
    if (answered) this.putBackAnswered(answered);
    const ended = this.spentOn(event);
    const began = this.transcript.turnStart;
    this.transcript.apply(ended);
    this.running = false;
    this.keepSpent(ended);
    const changed = began === null ? undefined : this.diffTurns(began);

    const payload = this.completeFields(ended, changed);
    try {
      this.emit("message.complete", payload);
      if (counters.on) counters.turn("ended");
      // In the same step as the event: a device that answers it with a seen comes after.
      const changes: ThreadChanges = { archived: undefined, unseen: true, inTurn: false };
      // The agent has undone another mode's policy (`saveMode`), unless it still waits to.
      if (this.record.modeReset && this.provider?.modeResetPending?.() !== true) changes.modeReset = undefined;
      this.writeTurn(() => this.write(changes, { turn: true }));
      this.noteBranch();
    } finally {
      // Also when the above failed (`take`): the turn has ended, and what waits for that
      // (a wait through the fleet, a notification) is told.
      this.tell((listener) => listener.turnEnded?.(this.id, event.status, typeof payload.text === "string" ? payload.text : ""));
    }

    this.startNext();
  }

  /**
   * The turn's end with what it spent (feature `turn_usage`): the agent's tokens, and its
   * time: the agent's own where it keeps one, else from the turn's start here to now. A
   * turn already under way when the thread was loaded has the agent's time or none.
   */
  private spentOn(event: TurnEnd): TurnEnd {
    const told = event.spent ?? {};
    const spent: TurnUsage = {};
    const seconds = told.seconds ?? (this.turnBegan === null ? undefined : (Date.now() - this.turnBegan) / 1000);
    if (seconds !== undefined && Number.isFinite(seconds) && seconds >= 0) spent.seconds = Math.round(seconds * 10) / 10;
    if (told.tokens !== undefined && Number.isFinite(told.tokens) && told.tokens > 0) spent.tokens = Math.round(told.tokens);
    this.turnBegan = null;
    const { spent: _, ...rest } = event;
    return spent.seconds === undefined && spent.tokens === undefined ? rest : { ...rest, spent };
  }

  /** What the bridge kept of what the thread's turns spent; nothing when it cannot be read. */
  private keptSpent(): KeptSpent[] {
    try {
      return this.spentStore?.read(this.id) ?? [];
    } catch (error) {
      log.warn("could not read what the thread's turns spent", { session: this.id, error: (error as Error).message });
      return [];
    }
  }

  /** The diffs the bridge kept of the thread's edits, by tool call id; none when they cannot be read. */
  private keptDiffs(): Map<string, string> {
    try {
      return this.diffStore?.read(this.id) ?? new Map();
    } catch (error) {
      log.warn("could not read the diffs the thread's edits kept", { session: this.id, error: (error as Error).message });
      return new Map();
    }
  }

  /** Keeps an edit's diff that the agent's history will not give back as it is (`keepDiff`); one that cannot be kept is only not kept. */
  private keepDiff(id: string, result: unknown): void {
    const diff = result && typeof result === "object" ? (result as Record<string, unknown>).diff : undefined;
    if (!this.diffStore || typeof diff !== "string") return;
    try {
      this.diffStore.keep(this.id, id, diff);
    } catch (error) {
      log.warn("could not keep the diff of an edit", { session: this.id, error: (error as Error).message });
      this.writeFailed(error);
    }
  }

  /** Keeps what a turn spent for an agent whose history will not say it (`agentTurn`); one that cannot be written is only not kept. */
  private keepSpent(event: TurnEnd): void {
    if (!this.spentStore || !event.agentTurn || event.spent?.tokens === undefined) return;
    try {
      this.spentStore.keep(this.id, { turn: event.agentTurn, ...event.spent });
    } catch (error) {
      log.warn("could not keep what a turn spent", { session: this.id, error: (error as Error).message });
      this.writeFailed(error);
    }
  }

  /**
   * Puts what each stored turn from `from` (up to `to`) changed on its last message
   * (feature `turn_diff`), and returns what all of them changed: a turn as it ran live,
   * with a message steered into it, is one, where the stored conversation makes two.
   * With `to` (a thread's load, where no turn ends) it returns nothing, and works out no
   * more than each turn's. One that cannot be worked out is only not shown.
   */
  private diffTurns(from: number, to?: number): TurnDiff | undefined {
    try {
      const messages = this.transcript.messages;
      withTurnDiffs(messages, from, to);
      if (to !== undefined) return undefined;
      const opened = messages.slice(from).filter((message) => message.role === "user").length;
      return opened <= 1 ? messages.at(-1)?.turn_diff : turnDiff(messages.slice(from));
    } catch (error) {
      log.warn("could not work out what a turn changed", { session: this.id, error: (error as Error).message });
      return undefined;
    }
  }

  /** What `message.complete` says of a turn that ended so, and what it changed (`changed`). */
  private completeFields(event: TurnEnd, changed?: TurnDiff): Record<string, unknown> {
    const payload: Record<string, unknown> = { status: event.status };
    if (event.status === "complete") payload.text = this.replyText;
    if (event.status === "error") {
      payload.text = event.error ?? "The agent stopped with an error.";
      payload.error_surface = { retryable: event.retryable ?? true };
    }
    if (this.usage) payload.usage = contextFields(this.usage);
    // Feature turn_usage: an app without it reads none of it.
    if (event.spent) payload.turn_usage = { ...event.spent };
    // Feature turn_diff: the same.
    if (changed) payload.turn_diff = changed;
    // Which turn this is, as the list lists it (`turn`, net-20): a device that heard
    // nothing of the turn before it read it names it in its seen. Only for a turn whose
    // start the record kept; one it did not (its start could not be written, or a turn
    // told as the thread was taken up) gets its number only from the write after this.
    if (this.record.inTurn === true && this.record.turnStarted !== undefined) payload.turn = this.record.turnStarted;
    return payload;
  }

  /**
   * Opens a turn for the next message waiting, if one waits, unless the bridge is closing;
   * and, whatever it finds, asks about the first one waiting for the agent's side to catch
   * up (`watchReach`).
   */
  private startNext(): void {
    try {
      const next = this.queue[0];
      if (!next || this.closing || this.folderLocked?.()) return;
      if (next.failure) {
        this.queue.shift();
        this.failed = [...this.failed, { text: storedUserText(next.prompt), error: next.failure, at: Date.now() / 1000, requestId: next.failedRequestId, messageID: next.messageID }].slice(-failedKept);
        this.keepQueue();
        this.failTurn(next, next.failure);
        this.emitQueue();
        setImmediate(() => { if (!this.running && !this.retired) this.startNext(); });
        return;
      }
      if (next.requestId || next.changing) return;
      // The agent may still run a turn Stop ended here: the message waits until it is past it (`letGoOfStop`).
      if (this.heldByStop) return;
      // The agent's side catching up on turns it missed (the connection to it dropped): those
      // are told first, as turns of their own, and the message's turn begins once they are.
      const catchingUp = this.provider?.catchingUp?.();
      if (catchingUp) {
        if (!this.awaitingCatchUp) {
          this.awaitingCatchUp = true;
          void catchingUp.then(() => {
            this.awaitingCatchUp = false;
            // Also while a turn told meanwhile runs: a message waiting behind it waits its
            // own time again, should the connection drop before that turn ends.
            this.watchReach();
            if (!this.running && !this.retired) this.startNext();
          }, (error: Error) => {
            this.awaitingCatchUp = false;
            next.failure = error.message;
            if (!this.running && !this.retired) this.startNext();
          });
        }
        return;
      }
      // One said again waits for those steered in before it that the agent has yet to take
      // or turn down: one turned down goes first. Each, once settled, starts the next.
      if (next.resent && [...this.steersOut].some((out) => out < (next.steered ?? 0))) return;
      // Reserved now, so a message sent meanwhile queues behind this one. It stays on the
      // list until its turn has started.
      this.running = true;
      next.starting = true;
      const reservation = this.queuedStart = { entry: next };
      setImmediate(() => {
        if (this.queuedStart !== reservation) return;
        this.queuedStart = null;
        // Closing meanwhile: it waits on disk for the next start.
        if (this.retired || this.closing) return;
        const index = this.queue.indexOf(next);
        if (index !== -1) this.queue.splice(index, 1);
        // One said again opens with nothing, for it shows where it was steered in, unless that
        // was before a restart and the agent never had it (`unshown`). Never listed, it
        // names no id it waited under.
        const hidden = next.resent === true && next.unshown !== true;
        this.begin(next.prompt, { resent: hidden, fleet: next.fleet, queued: next.resent ? undefined : next.id, messageID: next.messageID });
        // Off the disk once the agent has it: a turn that could not start (its record not
        // written) leaves it there for the next start.
        this.keepQueue();
        // After the turn's start: a device that sees the message leave the list has
        // opened the turn with it already.
        if (!next.resent) this.emitQueue();
      });
    } finally {
      this.watchReach();
    }
  }

  folderAvailable(): void {
    if (!this.running && !this.retired && !this.closing) this.startNext();
  }

  /**
   * Asks the agent whether it cannot be reached (`ProviderSession.unreachable`), for the
   * first message waiting at rest for its side to catch up; one said again (steered in
   * before) is never asked about: it waits for the catch-up, as it did. Once the agent
   * says so (its connection still down about 15 seconds after the message began to wait,
   * or down again after that while the catch-up runs), that message fails, and those
   * behind it with it (`failUnreached`). Called whenever what waits, whether a turn runs,
   * or whether the agent's side catches up may have changed: it asks again only for
   * another first message, and stops asking once there is none.
   */
  private watchReach(): void {
    const provider = this.provider;
    const catchingUp = this.closing || this.retired ? undefined : provider?.catchingUp?.();
    // Back in step, or a turn runs (one missed at the desk, told meanwhile, or the next
    // message's): each message's wait starts afresh, at the next drop or once that turn
    // has ended, as for one that waited behind a running turn.
    if (!catchingUp || this.running) for (const queued of this.queue) queued.since = undefined;
    const first = catchingUp && !this.running ? this.queue.find((queued) => !queued.resent && !queued.starting) : undefined;
    if (this.reachWatch?.entry === first) return;
    this.reachWatch?.stop.abort();
    this.reachWatch = null;
    if (!first || !provider?.unreachable) return;
    const now = Date.now();
    for (const queued of this.queue) if (!queued.resent) queued.since ??= now;
    const stop = new AbortController();
    this.reachWatch = { entry: first, stop };
    provider.unreachable(first.since ?? now, stop.signal).then(
      (reason) => {
        if (this.reachWatch?.entry !== first || stop.signal.aborted) return;
        this.reachWatch = null;
        // Back in step first: its turn begins (`startNext`). A turn runs (a missed one,
        // told meanwhile): it waits for that turn, and is asked about again once it ends.
        if (reason === undefined || this.running || this.closing || this.retired) return;
        this.failUnreached(first, reason);
      },
      (error: Error) => log.warn("could not learn whether the agent can be reached", { session: this.id, error: error.message }),
    );
  }

  /**
   * The agent cannot be reached (`watchReach`): `first`, and every message waiting behind
   * it but one said again, has its turn opened and failed at once, in the order they were
   * sent (`failTurn`). They leave the list on disk and are kept there as failed in one
   * write, so the thread shows them after a restart too, and a bridge stopped at any
   * moment neither sends nor loses them; when that cannot be written, none fails. None is
   * sent later behind the user's back, and none after one sent before it that failed.
   */
  private failUnreached(first: Queued, reason: string): void {
    const at = this.queue.indexOf(first);
    if (at === -1) return;
    log.info("messages waiting for the agent's side to catch up fail: the agent cannot be reached", { session: this.id });
    const error = `${reason} The message was not sent.`;
    const failing = this.queue.slice(at).filter((queued) => !queued.resent && !queued.starting);
    // Off the list on disk and kept as failed, in one write. When that cannot be written,
    // they do not fail, and wait on as they did before, rather than be lost at a restart.
    const before = this.failed;
    const failedAt = Date.now() / 1000;
    // Each goes back where it shows now, right after the agent's turn shown last, by the
    // agent's id for it (`withFailed`).
    const turn = this.provider?.latestTurn?.();
    this.failed = [...before, ...failing.map((queued): FailedMessage => (turn === undefined ? { text: storedUserText(queued.prompt), error, at: failedAt } : { text: storedUserText(queued.prompt), error, at: failedAt, turn }))].slice(-failedKept);
    if (!this.keepQueue(this.queue.filter((queued) => !failing.includes(queued)))) {
      this.failed = before;
      log.warn("the messages that cannot be reached wait on: their failure could not be kept on disk", { session: this.id });
      return;
    }
    for (const queued of failing) {
      this.queue.splice(this.queue.indexOf(queued), 1);
      this.failTurn(queued, error);
      // After its turn, as for one whose turn starts: a device that sees it leave the list
      // has opened the turn with it already.
      this.emitQueue();
    }
    this.watchReach();
  }

  /**
   * A turn for `queued` that fails at once with `error`, without the agent, as a turn the
   * agent could not start does: every device opens it with the message and shows it
   * failed, with Try again, the stored conversation keeps it, and a wait through the fleet
   * answers with `error`. The agent never had the message: it takes nothing off the
   * subagents line, nor counts as a turn of the agent's there (a subagent heard of later
   * is of the turn before it, beside those it started), and takes back no question. A
   * record that cannot be written costs only the list's showing it.
   */
  private failTurn(queued: Queued, error: string): void {
    this.replyText = "";
    const from = this.transcript.messages.length;
    const text = storedUserText(queued.prompt);
    this.transcript.startTurn(text, undefined, queued.messageID);
    this.turnStarted(previewOf(text));
    this.emit("message.start", startFields(text, { fleet: queued.fleet, queued: queued.id, messageID: queued.messageID }, this.fromOf(text)));
    // Without the agent: no time spent, so none said.
    const event: TurnEnd = { type: "turn.end", status: "error", error, retryable: true };
    this.transcript.apply(event);
    if (queued.failedRequestId) {
      const rows = this.transcript.messages.slice(from);
      const ending = rows.at(-1);
      if (ending?.role === "assistant") ending.display_metadata = { failed_request_id: queued.failedRequestId };
    }
    this.emit("message.complete", { ...this.completeFields(event), ...(queued.failedRequestId ? { failed_request_id: queued.failedRequestId } : {}) });
    if (counters.on) counters.turn("ended");
    this.writeTurn(() => this.write({ archived: undefined, unseen: true, inTurn: false }, { turn: true }));
    this.tell((listener) => listener.turnEnded?.(this.id, "error", error));
  }

  /**
   * A turn's change to the thread's record (its start, its end, a message steered into
   * it), which a record that cannot be written only leaves out: the turn opens or ends all
   * the same, on every device, what waits for it (the next message, a wait through the
   * fleet) goes on, and a message steered in, which every device already shows in the
   * turn, still goes to the agent. False when it was left out: the subagents the change
   * took off the line then stay on it, so the next message's record keeps them as gone.
   */
  private writeTurn(change: () => void): boolean {
    try {
      change();
      this.toldFull = false;
      return true;
    } catch (error) {
      log.warn("could not keep a turn's change in the thread's record", { session: this.id, error: (error as Error).message });
      this.writeFailed(error);
      return false;
    }
  }

  /**
   * A write of the thread's (its record, the messages waiting, what its turns kept) failed:
   * for want of space on the host's disk, the thread is told so, once until one of its
   * turns' writes works again. The rest went on
   * without it, as before.
   */
  private writeFailed(error: unknown): void {
    if (!this.disk?.outOfSpace(error) || this.toldFull || this.retired) return;
    this.toldFull = true;
    this.emit("status.update", { kind: "warn", text: `${this.disk.hostName} is out of disk space, so this thread could not be fully saved. Agents may fail until space is freed.` });
  }

  /**
   * The host's disk is low on space: the thread is told, once in each spell of it, as it
   * starts a turn or, at work, as the spell begins (`SessionManager.diskLow`). Not when it
   * was told just now that a write failed for want of it, which says as much.
   */
  tellDiskLow(): void {
    const spell = this.disk?.lowSpell;
    if (spell === undefined || spell === this.diskToldSpell || this.retired) return;
    this.diskToldSpell = spell;
    if (this.toldFull) return;
    this.emit("status.update", { kind: "warn", text: `${this.disk!.hostName} is almost out of disk space. Agents may fail and history may not be saved until space is freed.` });
  }

  /**
   * A turn started: the thread moves up and comes out of the archive, and takes `preview`
   * when it is given one. False when the record could not keep it (`writeTurn`).
   */
  private turnStarted(preview: string | undefined, cleared: readonly string[] = []): boolean {
    if (counters.on) counters.turn("started");
    const changes: ThreadChanges = preview ? { archived: undefined, inTurn: true, preview } : { archived: undefined, inTurn: true };
    const kept = this.writeTurn(() => this.write({ ...changes, ...this.clearedChanges(cleared) }, { turn: true }));
    this.noteBranch();
    return kept;
  }

  /**
   * Reads the branch checked out in the thread's folder, and the repository it is a
   * worktree of (feature worktrees), and keeps them for the list when they changed. Only
   * the latest read counts: a turn's end read before its start's came back is not undone
   * by it.
   */
  private noteBranch(): void {
    const read = ++this.branchReads;
    void gitHead(this.record.cwd)
      .then((head) => {
        if (this.retired || read !== this.branchReads) return;
        const changes: ThreadChanges = {};
        const branch = head?.branch ?? undefined;
        if (branch !== this.record.branch) changes.branch = branch;
        const repo = threadRepo(this.record.cwd, this.record.repo);
        if (repo !== this.record.repo) changes.repo = repo;
        if (Object.keys(changes).length > 0) this.write(changes);
      })
      .catch((error: Error) => log.debug("could not read the folder's branch", { session: this.id, error: error.message }));
  }

  /**
   * Changes the thread's record: with `turn`, as a turn's start or end does, moving its
   * time. The registry's once it has the thread; until then (an agent reporting a turn
   * while its thread is being taken up) the record the registry is about to add.
   */
  private write(changes: ThreadChanges, options: { turn?: boolean } = {}): void {
    // Let go of: the record is no longer this session's (removed, or another session's now).
    if (this.retired) return;
    if (this.registry.has(this.id)) {
      if (options.turn) this.registry.update(this.id, changes);
      else this.registry.set(this.id, changes);
      return;
    }
    applyChanges(this.record, changes);
    if (options.turn) this.record.updatedAt = Math.floor(Date.now() / 1000);
  }

  /**
   * A message steered into a turn that ended before the agent took it. The app shows
   * it in that turn, so it is answered in a turn of its own, next.
   */
  private resend(prompt: Prompt, steered: number, refused: boolean): void {
    if (this.retired) return;
    log.info("a message steered into a turn that ended goes in a turn of its own", { session: this.id });
    // Behind a turn that runs, or behind the agent's side catching up on turns it missed
    // (its connection dropped): those come first. And behind a message steered in before
    // it that the agent has yet to take or turn down (`startNext` waits for it). Once the
    // bridge is closing (closing the agent's side turns down what is still out), it waits
    // on disk with the others, for the next start.
    const catchingUp = this.provider?.catchingUp?.();
    const earlierOut = [...this.steersOut].some((out) => out < steered);
    if (this.running || catchingUp || earlierOut || this.closing || this.heldByStop) {
      // Ahead of the messages waiting, and behind those said again that were sent before
      // it, whichever the agent turned down first: one waiting since before a restart
      // (no `steered`) came before them all.
      let at = 0;
      while (at < this.queue.length && this.queue[at].resent && (this.queue[at].steered ?? 0) < steered) at += 1;
      this.queue.splice(at, 0, { id: String(++this.queued), prompt, resent: true, steered, refused });
      this.keepQueue();
      if (!this.running) this.startNext();
      return;
    }
    this.begin(prompt, { resent: true });
  }

  /**
   * What the user said with a no, for an agent that is not told it with the no (Codex
   * declines and goes on): a message of theirs, put on the list of those waiting and
   * handed at once to the turn that asked, so that every device shows it there (feature
   * `queue`), else waiting for that turn to end where the agent takes none in; once no
   * turn runs, opening a turn of its own, which every device opens with it as it does a
   * message sent through the fleet. The same for the answers given on a card to questions
   * asked without waiting (`askAhead`): `cardAnswer`, their row's id, which the message is
   * marked with wherever it is told (`card_answer`).
   */
  private sayNote(note: string, cardAnswer?: string): void {
    if (this.retired) return;
    const prompt: Prompt = { text: note, images: [] };
    if (cardAnswer !== undefined) this.cardAnswerOf.set(prompt, cardAnswer);
    if (this.closing || this.folderLocked?.()) {
      // The bridge is closing: it is not handed to an agent being let go of, but waits on
      // disk with the others, for the next start (`closeSoon`).
      this.queue.push({ id: String(++this.queued), prompt });
      this.keepQueue();
      return;
    }
    if (!this.running && !this.heldByStop) {
      this.running = true;
      // Opened by Portals for an app without the feature turn_messages, which shows such a turn's message.
      this.begin(prompt, { fleet: true, sender: "user" });
      return;
    }
    const id = String(++this.queued);
    this.queue.push({ id, prompt });
    // On disk as any message waiting is: where the agent takes none mid-turn, it waits there.
    this.keepQueue();
    this.emitQueue();
    this.steerQueued(id);
  }

  // MARK: From the provider

  /**
   * An event from the agent's side (the sink's `emit`). A failure to take it in is the
   * bridge's own: it is logged and the event is lost, and the agent's side never hears
   * of it (Codex, Hermes and Cursor hand events in from their connections' handlers,
   * where a throw would end the bridge). A turn's end still leaves the thread at rest
   * (`endAnyway`).
   */
  private take(event: ProviderEvent): void {
    // What the agent still says of a turn Stop ended here (`stopWithin`) has no turn to
    // show it in; its end is the last of it, and lets a message waiting go.
    if (this.stoppedHere && this.heldByStop && !this.transcript.isInTurn) {
      if (event.type === "turn.end") {
        this.letGoOfStop(this.stoppedHere);
        return;
      }
      if (ofTheTurn(event)) return;
    }
    // Its end takes the line down on the devices by itself.
    this.heardNow(event.type !== "turn.end");
    // The agent produced something in the turn: the message that opened it reached it.
    // From the agent only, not the rows the bridge itself puts (`askAhead`).
    if (this.answeredByTurn && producedIn(event)) this.answeredByTurn = null;
    try {
      this.handle(event);
    } catch (error) {
      // What kind of event, never what it says.
      log.error("could not take in an event from the agent", { session: this.id, event: event.type, error: (error as Error)?.stack ?? String(error) });
      if (event.type === "turn.end") this.endAnyway();
    }
  }

  /**
   * A turn's end the bridge failed to take in (`take`) leaves the thread at rest all the
   * same, not at work until the next restart: a turn the failure left open ends as failed,
   * and once none runs, the next message waiting opens its turn. One that failed after the
   * turn had ended has told what waits for it already (`end`); what else the failure cut
   * short (the event to the devices, the record's write) is lost with it. A failure here
   * too is logged, and nothing more is tried.
   */
  private endAnyway(): void {
    try {
      if (this.running && this.transcript.isInTurn) this.end({ type: "turn.end", status: "error", error: "Portals could not take in the end of this turn.", retryable: false });
      else if (!this.running) this.startNext();
    } catch (error) {
      log.error("could not end the turn after failing to take in its end", { session: this.id, error: (error as Error)?.stack ?? String(error) });
    }
  }

  private handle(event: ProviderEvent): void {
    switch (event.type) {
      case "checkpoint": {
        const from = this.transcript.turnStart;
        const opener = from === null ? undefined : this.transcript.messages[from];
        if (opener?.role !== "user") return;
        const checkpoint: MessageCheckpoint = { ...event.checkpoint };
        opener.checkpoint = checkpoint;
        this.emit("message.checkpoint", { checkpoint });
        return;
      }
      case "mcp.auth":
        this.emit("mcp.auth", {});
        return;
      case "queue.taken": {
        const inTurn = this.running && this.transcript.isInTurn;
        const queued = this.queue.find((entry) => entry.failedRequestId === event.requestId || entry.requestId === event.requestId ||
          entry.takenBackRequestIds?.includes(event.requestId) === true);
        if (queued) {
          this.queue.splice(this.queue.indexOf(queued), 1);
          this.recordSteer(queued.prompt, queued.messageID);
          this.keepQueue();
          this.emitQueue(queued.id);
          if (!inTurn) this.invalidate();
          if (!this.running) this.startNext();
          return;
        }
        const failed = this.failed.find((message) => message.requestId === event.requestId);
        // The transcript can outlive the bounded list of failures kept on disk.
        const removed = this.transcript.removeFailed(event.requestId);
        if (failed) {
          this.failed.splice(this.failed.indexOf(failed), 1);
        }
        if (failed || removed) this.keepQueue();
        const messageID = removed?.messageID ?? failed?.messageID;
        this.recordSteer(event.prompt, messageID);
        // A buffered receipt can outlive its process. Repair closed history without
        // telling any app that another turn is running.
        if (!inTurn) {
          this.invalidate();
          if (!this.running) this.startNext();
          return;
        }
        if (removed) {
          // Rebase before the repair event: live paged followers move their cursor;
          // a disconnected follower takes a snapshot rather than replaying old rows.
          this.log.rebase();
          this.emit("message.taken", {
            request_id: event.requestId, replay_base: this.log.base,
            removed_start: removed.start, removed_count: removed.count,
          });
        }
        this.emit("message.steered", { ...messageFields(storedUserText(event.prompt), "user", messageID), ...(removed ? { reconciled: true } : {}) });
        if (removed) this.notifyInvalidated(true);
        else if (failed) this.invalidate();
        return;
      }
      case "queue.consumed": {
        const index = this.queue.findIndex((entry) => entry.requestId === event.requestId);
        if (index === -1) return;
        const [queued] = this.queue.splice(index, 1);
        this.recordSteer(queued.prompt, queued.messageID);
        this.keepQueue();
        this.emitQueue(queued.id);
        // Taken after the turn had ended (Droid takes a steering message still queued once
        // its loop is idle): the messages waiting behind it go on, as after one that failed.
        if (!this.running) this.startNext();
        return;
      }
      case "steer.withdrawn": {
        // Stopped before the agent read it: it leaves the turn it was shown in, and goes
        // back to the composer of the device that sent it (feature steer_withdrawn). An app
        // without the feature shows the notice, with the whole message, so that it is not
        // lost unseen.
        const text = storedUserText(event.prompt);
        const messageID = this.steeredIDs.get(event.prompt);
        this.transcript.withdraw(text, messageID);
        this.emit("status.update", {
          kind: "warn", text: `Stop took back a message before the agent read it, so it was not sent: “${text}”`,
          withdrawn: { text, ...(messageID !== undefined ? { message_id: messageID } : {}) },
        });
        return;
      }
      case "queue.failed": {
        const queued = this.queue.find((entry) => entry.requestId === event.requestId);
        if (!queued) return;
        this.failQueued(queued, event.error);
        return;
      }
      case "conversation.changed":
        // Only at rest: a turn of the bridge's own is what changed it, or the look waits
        // for the next change, or for a device to open the thread (`SessionManager.refresh`).
        void this.takeConversationFromElsewhere().catch((error: Error) =>
          log.warn("could not read the conversation the agent went on with elsewhere", { session: this.id, error: error.message }));
        return;
      case "assistant.replace":
        this.replyText = event.text;
        this.transcript.apply(event);
        this.invalidate();
        return;
      case "text":
        if (event.text === "") return;
        this.replyText += event.text;
        this.emit("message.delta", { text: event.text });
        break;
      case "commentary":
        this.replyText = "";
        this.emit("message.interim", { text: event.text, already_streamed: event.alreadyStreamed });
        break;
      case "reasoning":
        if (event.text === "") return;
        this.emit("reasoning.delta", { text: event.text });
        break;
      case "status":
        this.emit("thinking.delta", { text: event.text });
        break;
      case "headline":
        // What the agent says it is working on (feature status_headline): a device takes it
        // in place of "Thinking…" until a newer one, or until the agent says something.
        this.emit("status.headline", { text: event.text, tool_ids: event.toolIds });
        break;
      case "working":
        this.emit("status.update", { kind: "working", state: event.state, text: event.text });
        break;
      case "notice":
        this.emit("status.update", { kind: event.level, text: event.text });
        break;
      case "tool.start":
        this.replyText = "";
        this.emit("tool.start", withContext({ tool_id: event.id, name: event.name, args: event.args }, event.context));
        break;
      case "tool.progress":
        this.emit("tool.progress", {
          tool_id: event.id,
          ...(event.output !== undefined ? { output: event.output } : {}),
          ...(event.progress !== undefined ? { progress: event.progress } : {}),
          ...(event.outputTruncated !== undefined ? { output_truncated: event.outputTruncated } : {}),
        });
        break;
      case "turn.usage":
        this.emit("message.usage", { turn_usage: event.usage });
        break;
      case "tool.end": {
        // Name, args and context again: after a reconnect the app may not have seen the start.
        const payload = withContext({ tool_id: event.id, name: event.name, args: event.args, result: event.result }, event.context);
        if (event.durationSeconds !== undefined) payload.duration_s = event.durationSeconds;
        if (event.inlineDiff) payload.inline_diff = event.inlineDiff;
        this.emit("tool.complete", payload);
        // Written a moment later, not in this step (src/sessions/keptDiffs.ts).
        if (event.keepDiff) this.keepDiff(event.id, event.result);
        break;
      }
      case "title":
        // The agent's one ongoing conversation is called by the agent's name.
        if (this.record.ongoing) return;
        this.write({ title: event.title });
        this.emit("session.title", { title: event.title });
        break;
      case "usage":
        this.usage = event.usage;
        this.emit("session.usage", { usage: contextFields(event.usage) });
        break;
      case "compacted": {
        const payload: Record<string, unknown> = { trigger: event.trigger };
        if (event.tokensBefore !== undefined) payload.tokens_before = event.tokensBefore;
        this.emit("session.compacted", payload);
        break;
      }
      case "error":
        this.emit("error", { message: event.message });
        break;
      case "mode":
        // The agent changed it itself (a plan was approved): kept for the next start, and shown.
        this.saveMode(event.mode);
        this.emitMode();
        return;
      case "subagent":
        this.subagentNews(event.subagent);
        return;
      case "turn.begin":
        this.beginElsewhere(event.user, event.host, event.clears, event.command);
        return;
      case "turn.opener":
        // A message of the person's after all, not the command it was first taken for: as
        // one typed at the desk (`beginElsewhere`), the answer an agent that asked without
        // waiting takes, whatever its words ("/compact" with a picture is no command).
        if (event.user.trim() !== "") this.withdrawAsked("replied");
        this.transcript.reopen(event.user);
        // Told by no event: a device that held the turn's opener before takes it whole.
        this.log.rebase();
        return;
      case "turn.end":
        this.end(event);
        return;
      case "questions":
        if (this.keepsAsyncQuestions) void this.askAhead(event);
        else this.handle({ type: "text", text: event.text });
        return;
    }
    this.transcript.apply(event);
  }

  private invalidate(): void {
    this.log.rebase();
    this.notifyInvalidated();
  }

  private notifyInvalidated(reconciled = false): void {
    this.emit("session.invalidated", { replay_base: this.log.base }, undefined, reconciled ? (peer) => peer.messageReconciliation !== true : undefined);
    for (const peer of this.followers) {
      if (reconciled && peer.messageReconciliation === true) continue;
      if (peer.sessionResync === true) continue;
      try {
        peer.resync?.();
      } catch (error) {
        log.warn("could not refresh a legacy session follower", { session: this.id, error: (error as Error).message });
      }
    }
  }

  /**
   * A subagent or workflow started, changed or ended: kept, and shown. One that has left
   * the line stays off it while it has ended in the run it left in (more said of it is
   * only kept), and comes back once it is at work again (a Codex sub-agent given more to
   * do; then the record no longer keeps it). After a restart the record says which left:
   * a closer look at one (a read of a Codex sub-agent's thread, or a sub-agent's own found
   * after the restart) keeps it off while it is that run, ended, and takes off one shown at
   * work that it finds had ended in that run; another run of it is on the line.
   */
  private subagentNews(subagent: SubagentInfo): void {
    const known = this.subagents.get(subagent.id);
    // News of a run older than the one on the line (its agent began another since, and
    // told of it first): that run is over, and its late word must not take the place of
    // the current one, which would end it on every device, or bring the old run back.
    if (subagent.run !== undefined) {
      const runs = this.runsOf.get(subagent.id) ?? [];
      const current = known?.info.run;
      if (current !== undefined && current !== subagent.run && runs.indexOf(subagent.run) !== -1 && runs.indexOf(subagent.run) < runs.indexOf(current)) {
        log.debug("news of an older run of a subagent left out", { session: this.id });
        return;
      }
      if (!runs.includes(subagent.run)) this.runsOf.set(subagent.id, [...runs, subagent.run].slice(-8));
    }
    // Started in the turn running now, or in the last one when none runs.
    const turn = known?.turn ?? this.turns;
    const left = this.clearedKept().find((entry) => entry.id === subagent.id);
    const wasCleared = left !== undefined || known?.cleared === true;
    const ended = subagent.status !== "running";
    // Another run than the one that left the line: one seen at work again here, or one its
    // agent names (at work now, which the one that left was not, or another run than that
    // one). The record lets it go. Without a run named, it is taken for the one that left.
    const leftRun = left !== undefined ? left.run : known?.info.run;
    const named = subagent.run !== undefined && (leftRun === undefined ? !ended : subagent.run !== leftRun);
    const another = wasCleared && ((known?.cleared === true && !ended) || named);
    if (another && left) this.unclear(subagent.id);
    const cleared = wasCleared && !another && ended;
    this.subagents.set(subagent.id, cleared ? { info: offTheLine(subagent), turn, cleared } : { info: subagent, turn });
    this.noteActivity();
    if (cleared) {
      // Shown until now (one a restart brought back at work): ended, then off the line.
      if (known && !known.cleared) {
        this.emit("subagent.complete", subagentPayload(subagent, turn, this.canRead(subagent)));
        this.emit("subagent.cleared", { subagent_ids: [subagent.id] });
      }
      return;
    }
    const type = !known ? "subagent.start" : subagent.status === "running" ? "subagent.progress" : "subagent.complete";
    this.emit(type, subagentPayload(subagent, turn, this.canRead(subagent)));
  }

  private async ask(request: AgentRequest, signal?: AbortSignal): Promise<RequestAnswer> {
    if (request.kind === "approval") {
      const params: Record<string, unknown> = { command: request.command, choices: request.choices };
      if (request.description) params.description = request.description;
      if (request.options) params.options = request.options.map((option) => ({
        id: option.id, label: option.label, description: option.description, effects: option.effects,
        ...(option.requiresConfirmation ? { requires_confirmation: true } : {}),
      }));
      if (request.planContent !== undefined) params.plan_content = request.planContent;
      if (request.details) params.details = request.details.map(({ toolId, violationType, ...detail }) => ({
        tool_id: toolId, ...detail, ...(violationType === undefined ? {} : { violation_type: violationType }),
      }));
      // Feature modes: a plan to approve, and the mode its work starts in.
      if (request.plan) Object.assign(params, { plan: true, starts_in: request.plan.startsIn });
      // Feature subagents: whose it is, so the app keeps the card after the turn.
      if (request.subagent !== undefined) params.subagent = request.subagent;
      const answer = await this.requests.ask("approval", params, signal, request.subagent !== undefined);
      if ("withdrawn" in answer) return { kind: "withdrawn", reason: answer.withdrawn };
      const result = "result" in answer ? (answer.result as { choice?: unknown; option?: unknown; edited_plan?: unknown; note?: unknown } | null) : null;
      const note = typeof result?.note === "string" && result.note.trim() !== "" ? result.note.trim() : undefined;
      if (result && typeof result === "object" && "option" in result) {
        const offered = request.options?.find((option) => option.id === result.option);
        if ("choice" in result || !offered || (offered.id === "proceed_edit" &&
          (typeof result.edited_plan !== "string" || !result.edited_plan.trim()))) return { kind: "approval", choice: "deny" };
        return { kind: "approval.option", option: offered.id,
          ...(typeof result.edited_plan === "string" ? { editedPlan: result.edited_plan } : {}), ...(note ? { note } : {}) };
      }
      // Only a choice that was offered counts; anything else, and any error, is a no.
      const allowed = approvalChoices.find((offered) => offered === result?.choice && request.choices.includes(offered));
      if (!note) return { kind: "approval", choice: allowed ?? "deny" };
      // An agent not told it with the no gets it next, once its provider has sent the no.
      if ((allowed ?? "deny") === "deny" && !request.takesNote) {
        // Closing already (the answer came back after `closeSoon` said the notes due): it
        // waits on disk now, as they did, since the process may end before the next step.
        if (this.closing) {
          this.sayNote(note);
          return { kind: "approval", choice: allowed ?? "deny", note };
        }
        const due = { note };
        this.notesDue.add(due);
        setImmediate(() => { if (this.notesDue.delete(due)) this.sayNote(note); });
      }
      return { kind: "approval", choice: allowed ?? "deny", note };
    }

    // `header` and `descriptions` are the feature question_details: keys the app reads
    // only from a bridge that lists it.
    const questions = request.questions.map((question) => ({
      qid: question.qid,
      question: question.question,
      choices: question.choices,
      multi_select: question.multiSelect,
      ...(question.header ? { header: question.header } : {}),
      ...(question.descriptions ? { descriptions: question.descriptions } : {}),
    }));
    const params: Record<string, unknown> = { questions };
    if (request.requiresAllAnswers) params.requires_all_answers = true;
    if (request.subagent !== undefined) params.subagent = request.subagent;
    // Feature async_questions: the app keeps the card past the turn's end.
    if (request.async) params.async = true;
    const answer = await this.requests.ask("clarify", params, signal, request.subagent !== undefined || request.async === true);
    if ("withdrawn" in answer) return { kind: "withdrawn", reason: answer.withdrawn };
    const given = "result" in answer ? (answer.result as { answers?: unknown } | null)?.answers : undefined;
    if (!given || typeof given !== "object") return { kind: "clarify", answers: null };
    const answers: Record<string, string | null> = {};
    for (const question of request.questions) {
      const value = (given as Record<string, unknown>)[question.qid];
      answers[question.qid] = typeof value === "string" ? value : null;
    }
    return { kind: "clarify", answers };
  }

  /** Tells the listener, if any. Whatever goes wrong there stays there. */
  private tell(message: (listener: SessionListener) => void): void {
    if (!this.listener) return;
    try {
      message(this.listener);
    } catch (error) {
      log.warn("a session listener failed", { session: this.id, error: (error as Error).message });
    }
  }

  private emit(type: string, payload?: Record<string, unknown>, except?: Follower, include?: (peer: Peer) => boolean): void {
    const started = counters.on ? performance.now() : 0;
    if (type === "thinking.delta") this.statusLine = typeof payload?.text === "string" ? payload.text.trim() : "";
    // What the agent is doing (Droid's working states: "Compacting conversation", or
    // none), which the app shows on the same line; not a notice (info, warn, error).
    else if (type === "status.update" && !["info", "warn", "error"].includes(String(payload?.kind))) this.statusLine = typeof payload?.text === "string" ? payload.text.trim() : "";
    else if (type === "message.start" || type === "message.complete") this.statusLine = "";
    // The agent going on takes it down on every device following (ThreadState): a reply, a
    // thought, closed text or a tool call, not a question's (which shows as no tool row).
    // A device that opens the thread whole is not to be shown it again ("trying again"
    // until Pi's auto_retry_end, which may come long after). Closed text of nothing but
    // spaces is nothing to the app.
    else if (type === "message.delta" || type === "reasoning.delta" || (type === "message.interim" && typeof payload?.text === "string" && payload.text.trim() !== "") || (type === "tool.start" && payload?.name !== "clarify")) this.statusLine = "";
    const event = this.log.append(type, payload);
    for (const peer of this.followers) {
      if (peer === except) continue;
      if (include && !include(peer)) continue;
      // One that cannot be sent it costs only itself the event live; the log still has it.
      try {
        peer.sendEvent(event);
      } catch (error) {
        log.error("could not send an event to a device", { session: this.id, event: type, error: (error as Error)?.stack ?? String(error) });
      }
    }
    if (started) counters.emitted(performance.now() - started);
  }
}

/**
 * A subagent as the `subagent.*` events and `subagent.list` give it (feature subagents):
 * Hermes's keys (`subagent_id`, `goal`, `status`, `tool_name`), which any app reads, and
 * the bridge's own, which an app reads from a bridge that lists the feature. Times are
 * Unix seconds; `turn` numbers the thread's turns since the bridge started, and is the
 * one that started it. `canRead`: `subagent.read` gives what it did.
 */
export function subagentPayload(subagent: SubagentInfo, turn: number, canRead = false): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    subagent_id: subagent.id,
    kind: subagent.kind,
    goal: subagent.goal,
    status: subagent.status,
    turn,
    started_at: subagent.startedAt / 1000,
    background: subagent.background,
    can_stop: subagent.status === "running" && subagent.stoppable,
  };
  if (subagent.name) payload.name = subagent.name;
  // Feature subagent_read: `subagent.read` gives what it did.
  if (canRead) payload.can_read = true;
  // Feature subagent_names.
  if (subagent.nickname) payload.nickname = subagent.nickname;
  if (subagent.role) payload.role = subagent.role;
  if (subagent.parent) payload.parent_id = subagent.parent;
  if (subagent.endedAt !== undefined) payload.ended_at = subagent.endedAt / 1000;
  if (subagent.summary) payload.summary = subagent.summary;
  if (subagent.tool) payload.tool_name = subagent.tool;
  if (subagent.result) payload.result = subagent.result;
  // Feature background_commands: a command's output so far, its end only.
  if (subagent.output !== undefined) payload.output = subagent.output;
  if (subagent.outputTruncated) payload.output_truncated = true;
  if (subagent.model) payload.model = subagent.model;
  if (subagent.tokens !== undefined) payload.tokens = subagent.tokens;
  if (subagent.toolUses !== undefined) payload.tool_uses = subagent.toolUses;
  if (subagent.phases) payload.phases = subagent.phases.map((phase) => ({ index: phase.index, title: phase.title }));
  if (subagent.agents) {
    payload.agents = subagent.agents.map((agent) => {
      const entry: Record<string, unknown> = { id: agent.id, label: agent.label, status: agent.status };
      if (agent.phase) entry.phase = agent.phase;
      if (agent.model) entry.model = agent.model;
      if (agent.tokens !== undefined) entry.tokens = agent.tokens;
      if (agent.toolUses !== undefined) entry.tool_uses = agent.toolUses;
      if (agent.durationMs !== undefined) entry.duration_s = agent.durationMs / 1000;
      if (agent.result) entry.result = agent.result;
      return entry;
    });
  }
  return payload;
}

/** A subagent or workflow the session keeps (`Session.subagents`). */
interface SubagentEntry {
  info: SubagentInfo;
  turn: number;
  cleared?: boolean;
}

/**
 * Something the agent produced in the turn running: what it said, thought, began to run or
 * asked. Not a tool's progress or end, which may be of a command an earlier turn left
 * running in the background (Codex's terminals); a tool of this turn began first.
 */
function producedIn(event: ProviderEvent): boolean {
  switch (event.type) {
    case "text":
    case "reasoning":
      return event.text !== "";
    case "commentary":
    case "assistant.replace":
    case "tool.start":
    case "questions":
      return true;
    default:
      return false;
  }
}

/**
 * Part of a running turn, which shows only in one: its words, thoughts, status lines,
 * tools begun and what it spent. Not what outlives a turn (a tool's progress or end, which
 * may be of a command left running in the background; a subagent's news, a title, the
 * context's size, a notice).
 */
function ofTheTurn(event: ProviderEvent): boolean {
  switch (event.type) {
    case "text":
    case "commentary":
    case "reasoning":
    case "assistant.replace":
    case "status":
    case "headline":
    case "working":
    case "tool.start":
    case "turn.usage":
    case "turn.opener":
    case "questions":
      return true;
    default:
      return false;
  }
}

/**
 * A row that has left the line, as the session keeps it for the rest of its run: only to
 * know it again (its id, its run, how it ended), never listed or shown again. What it
 * showed goes: a background command's output alone is up to 8 KB, and a thread that runs
 * a few each turn for days held all of them.
 */
function offTheLine(info: SubagentInfo): SubagentInfo {
  const { output: _output, outputTruncated: _truncated, result: _result, summary: _summary, agents: _agents, phases: _phases, ...kept } = info;
  return kept;
}

type SubagentRun = Pick<SubagentInfo, "id" | "run" | "startedAt">;

function sameSubagentRun(left: SubagentRun, right: SubagentRun): boolean {
  return left.id === right.id && left.run === right.run && left.startedAt === right.startedAt;
}

/** One that left the line, as a thread's record keeps it: with the run it had come to, where its agent says. */
export interface ClearedSubagent {
  id: string;
  run?: string;
}

/** How many of those that left the line a thread's record keeps (`subagentsCleared`). */
const clearedKept = 64;

/**
 * A message as `message.start` and `message.steered` carry it (feature `turn_messages`): as
 * stored, with who sent it and the id the device gave it; for the answers given on a card,
 * their row's id (`card_answer`, feature async_questions).
 */
function messageFields(text: string, sender: Sender, messageID?: string, from?: From, cardAnswer?: string): Record<string, unknown> {
  const fields: Record<string, unknown> = { text, sender };
  if (messageID !== undefined) fields.message_id = messageID;
  if (from) fields.from = from;
  if (cardAnswer !== undefined) fields.card_answer = cardAnswer;
  return fields;
}

/**
 * What `message.start` says of a turn a message of the app's opens (`Opening`), but one
 * said again, whose turn opens with nothing: the message, who sent it, the id the device
 * gave it, and the id it had while it waited; `opened_by` for one through the fleet;
 * `card_answer` for the answers given on a card.
 */
function startFields(text: string, opening: Opening, from?: From, cardAnswer?: string): Record<string, unknown> {
  const fleet = opening.fleet === true;
  const start: Record<string, unknown> = fleet ? { opened_by: "portals" } : {};
  Object.assign(start, messageFields(text, opening.sender ?? (fleet ? "portals" : "user"), opening.messageID, from, cardAnswer));
  if (opening.queued !== undefined) start.queue_id = opening.queued;
  return start;
}

function withContext(payload: Record<string, unknown>, context: string | undefined): Record<string, unknown> {
  if (context) payload.context = context;
  return payload;
}

/**
 * Where the last `turns` turns before message `end` begin: at a message of the person's,
 * a steer kept in its turn being no turn's start. 0 when there are no more turns before.
 */
function pageStart(messages: readonly StoredMessage[], end: number, turns: number): number {
  let seen = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    const message = messages[index] as StoredMessage & { display_kind?: string };
    if (message.role !== "user" || message.display_kind === "steer") continue;
    seen += 1;
    if (seen >= turns) return index;
  }
  return 0;
}

/**
 * A slash command sent as a message (`command.dispatch` answers `send` for an agent's
 * own command): a slash, a name with no second slash, then a space or the end, the
 * rule the app reads commands by.
 */
export function isCommand(prompt: Prompt): boolean {
  return prompt.images.length === 0 && (prompt.files?.length ?? 0) === 0 && /^\/[^\s/]+(\s|$)/.test(prompt.text);
}

/**
 * How the last turn of a stored conversation ended, for one that ended while the bridge
 * was off, from what the agent kept of it: failed (a failed turn's line), stopped (the
 * interrupted mark, or a record that ends where the turn was cut off), or else finished,
 * with its last reply as a turn's end is told.
 */
function endedWhileAway(messages: readonly StoredMessage[]): { status: TurnStatus; text: string } {
  let reply = "";
  let last = true;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as StoredMessage & { display_kind?: string; display_metadata?: { interrupted?: boolean }; text?: unknown };
    // A steering message kept behind the turn's end (one Droid took after it) is not what
    // ended it. One before a reply is a boundary, as any user row: Pi keeps a failed try,
    // a steer and the reply that ended the turn well.
    if (last && message.role === "user" && message.display_kind === "steer") continue;
    // A crash that took the agent's process with the bridge leaves a record that ends
    // where the turn was cut off, with no mark of it (Pi's file: the message, and the row
    // of a command it ran): the turn was stopped when the bridge stopped, as a restart
    // stops one (recovery-7), not finished. Claude Code's says so itself (`lastTurnCutOff`).
    if (last && cutOffAt(message)) return { status: "interrupted", text: "" };
    if (message.role === "user") break;
    const text = typeof message.text === "string" ? message.text : "";
    if (message.display_kind === "failed_turn") return { status: "error", text };
    if (last && message.display_metadata?.interrupted === true) return { status: "interrupted", text: "" };
    last = false;
    if (reply === "" && message.role === "assistant" && text.trim() !== "") reply = text;
  }
  return { status: "complete", text: reply };
}

/**
 * Whether a stored conversation that ends on `message` ends mid-turn: on the person's
 * message, which nothing answered, or on a tool's row with no reply after it. Not on a
 * command, which may end its turn with no answer (a `/compact` that failed), nor on a plan
 * or questions, which can be how a turn ends (Codex's plan mode, its questions asked
 * without waiting).
 */
function cutOffAt(message: StoredMessage): boolean {
  if (message.role === "user") return !isCommand({ text: message.text, images: [] });
  return message.role === "tool" && message.name !== "plan" && message.name !== "clarify";
}
