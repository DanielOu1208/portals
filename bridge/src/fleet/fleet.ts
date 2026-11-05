import { createHash, randomBytes } from "node:crypto";
import { counters } from "../counters.ts";
import { FolderRefused, type Folders } from "../folders.ts";
import { cutWhole } from "../json.ts";
import { log } from "../log.ts";
import { modelChoice } from "../providers/opencode/models.ts";
import { ErrorCode, invalidParams, RpcError } from "../gateway/errors.ts";
import { machineWord } from "../platform.ts";
import { isThreadMode, thinkingLevels, type ModeState, type ModelCatalog, type Provider, type SessionSettings, type StoredMessage, type ThreadMode } from "../providers/types.ts";
import type { OpenRequest } from "../sessions/broker.ts";
import { RemoveRefused, UnknownThreadError, type SessionManager } from "../sessions/manager.ts";
import { previewOf } from "../sessions/preview.ts";
import type { StartedBy, ThreadChanges, ThreadRecord } from "../sessions/registry.ts";
import type { Session } from "../sessions/session.ts";
import { fromHere, fromLine, fromWords, readFrom, words, type From, type Here } from "./line.ts";
import { thisMachine, type Links } from "./links.ts";
import { RemoteThreads } from "./remoteThreads.ts";
import { fleetOrder } from "./order.ts";
import { FleetPages, type FleetPageParams, type FleetPageReply } from "./pages.ts";

// The bridge's threads as a whole (docs/fleet-plan.md): every thread listed, and one
// read, sent to, waited for, started or stopped, whether or not a connection follows
// it. The gateway's `threads.list` and `thread.*` methods are these six operations
// (docs/gateway-protocol.md, section 11, feature `fleet`); whatever else manages
// threads calls them too, so there is one account of what a thread is doing.
//
// A thread on another Mac this bridge is linked to (links.ts) is named
// `machine/thread`, and what is asked of it is passed on to that Mac's bridge, which
// does it as its own.
//
// The same threads are also the list every device shows (feature thread_sync,
// docs/sync-plan.md): this bridge's own only, with their marks, what changed since a
// revision of the list, and taking one off it.
//
// A thread started through the fleet is answered by the thread that started it, as a
// device answers it (feature agent_threads): never an allow it could not give itself.
//
// Errors are the gateway's, with a sentence for whoever asked.

/** What a thread is doing, in the words of the Program Status Protocol (OSC 7501). */
export const threadStates = ["idle", "working", "blocked", "error"] as const;
export type ThreadState = (typeof threadStates)[number];

export function isThreadState(value: unknown): value is ThreadState {
  return (threadStates as readonly unknown[]).includes(value);
}

/** What a blocked thread waits for: leave to do something, or an answer. */
export type BlockedKind = "permission" | "question";

/** A thread as `threads.list` lists it. */
export interface ThreadSummary {
  id: string;
  /** The profile name of the agent that runs it. */
  agent: string;
  agent_name: string;
  /** Left out until the thread has one. */
  title?: string;
  /** The folder it works in, as a real path. */
  folder: string;
  state: ThreadState;
  /** For a `blocked` thread. */
  kind?: BlockedKind;
  /** Unix seconds. */
  updated: number;
  /** Only read: it takes no message. */
  read_only?: true;
  /** Its agent's one ongoing conversation (feature bot_chat): every new thread of the agent is this one, and it is never removed nor renamed. */
  ongoing?: true;
  /** For a thread on a linked Mac, whose `id` is `machine/thread`: that Mac's name here. */
  machine?: string;
}

/** Opt-in bridge-to-bridge list refresh (feature fleet_delta). State is a complete overlay, not revision-stamped. */
export interface FleetDelta {
  epoch: string;
  list: { id: string; revision: number };
  threads: ThreadSummary[];
  positions?: number[];
  removed: string[];
  active: { id: string; state: ThreadState; kind?: BlockedKind }[];
  order: { count: number; digest: string };
  full?: true;
}

/** A thread as the list every device shows gives it (feature thread_sync): as the fleet describes it, and its marks. */
export interface ListedThread extends ThreadSummary {
  /** Unix seconds. */
  created: number;
  /** The list's revision when the thread last changed. */
  revision: number;
  /** Which turn is the thread's latest: the list's revision when it began. Absent for a thread with none recorded. */
  turn?: number;
  preview?: string;
  pinned?: true;
  archived?: true;
  unseen?: true;
  /**
   * For a thread started through the fleet: who by, the thread when it is one of this
   * bridge's, and who as facts (feature `senders`), with the Mac when that is another.
   */
  started_by?: { name: string; thread?: string; from?: From };
  /** A thread an agent started that a person put in the sidebar on every device (feature agent_threads). */
  shared?: true;
  /** In Recent on every device (feature recent_threads). */
  recent?: true;
  /** The git branch checked out in its folder as a turn last started or ended (feature thread_branch). */
  branch?: string;
  /**
   * For a thread whose folder is in a git worktree: the folder of the repository's main
   * checkout it is listed under, its project, beside its own `folder` (feature worktrees).
   */
  repo?: string;
}

/** `threads.changes`: the list's id and revision, and what changed since the revision asked about, or every thread (`full`). */
export interface ListChanges {
  list: { id: string; revision: number };
  threads: ListedThread[];
  /** The ids taken off the list since then; in a full answer, every id taken off it and not taken up again. */
  removed: string[];
  full?: true;
}

/** What `thread.mark` changes; at least one of the marks or a preview is given. */
export interface Marks {
  pinned?: boolean;
  archived?: boolean;
  unseen?: boolean;
  /** A thread an agent started, in the sidebar on every device or only under that thread (feature agent_threads). */
  shared?: boolean;
  /** In Recent on every device, or out of it (feature recent_threads). */
  recent?: boolean;
  /** With `unseen: false`: the thread's revision as the device last listed it. */
  revision?: number;
  /** With `revision`: the list it is a revision of. */
  list?: string;
  /** With `unseen: false`: the turn the seen is of, as listed (`turn`); one of an earlier turn leaves a later one's mark. */
  turn?: number;
  /** Taken only by a thread with none. */
  preview?: string;
}

/** A linked Mac as `machines.list` lists it. */
export interface Machine {
  name: string;
  url: string;
  reachable: boolean;
  /** Its agents, when it could be reached. */
  agents?: { name: string; display_name: string }[];
  /** Why not, when it could not. */
  error?: string;
}

/** Who a message sent through the fleet is from. */
/** Who waits for a thread, and the signal that calls the wait off (`Fleet.waitingBy`). */
interface Waiting extends Sender {
  signal?: AbortSignal;
}

export interface Sender {
  /** One of this bridge's threads. */
  from?: string;
  /** In words, when another bridge passes a message on: it knows its own threads. */
  sender?: string;
  /**
   * When another bridge passes a start or an answer on: its name for itself and the
   * thread's id there (`mbp16/6d3c…`), which a thread it starts keeps (`StartedBy.origin`)
   * so that only the same thread answers it. As older bridges pass it.
   */
  origin?: string;
  /**
   * When another bridge passes a message, start or answer on: who, as facts (fleet/line.ts,
   * feature `senders`), with that Mac's stable id. A thread it starts keeps them, and an
   * answer is taken from the same Mac's same thread.
   */
  sentBy?: From;
}

/** `thread.answer`: an approval's choice, and a note with a no; a question's answers. */
export interface Answer {
  choice?: string;
  note?: string;
  answers?: Record<string, unknown>;
}

/** Who answers through the fleet: as `Sender`, and the mode their thread works in, as another bridge that passes the answer on says. */
export interface Answerer extends Sender {
  callerMode?: string;
}

/** A mode a thread works in, `default` worked out. */
type WorkingMode = Exclude<ThreadMode, "default">;

/** How much a mode lets a thread do without asking: an agent allows nothing that needs more than its own. */
const modeRank: Record<WorkingMode, number> = { plan: 0, ask: 1, edits: 2, medium: 2.5, full: 3 };

/** The mode in words, after "runs in". */
const modeWords: Record<WorkingMode, string> = { plan: "plan mode", ask: "ask mode", edits: "edits mode", medium: "medium autonomy", full: "full access" };

/** `thread.read`: the end of a conversation, and what is going on in it now. */
export interface ThreadReading {
  thread: ThreadSummary;
  /** The last turns, oldest first, as `session.resume` returns messages. */
  messages: StoredMessage[];
  /** The turn in progress, as `session.resume` returns it. */
  inflight?: unknown;
  open_requests: OpenRequest[];
}

/** `thread.wait`: a thread come to rest, or blocked, or still working when the wait ran out. */
export interface ThreadRest {
  state: ThreadState;
  kind?: BlockedKind;
  timed_out: boolean;
  /** What the last turn said so far: its reply, or why it failed. */
  reply: string;
  open_requests: OpenRequest[];
}

/** What a new thread is made from; the keys `session.create` takes. */
export interface StartParams {
  profile?: unknown;
  cwd?: unknown;
  title?: unknown;
  model?: unknown;
  provider?: unknown;
  reasoning_effort?: unknown;
}

/** Why a thread only read takes no message, model or image. */
export const readOnlyText = `This thread is only for reading: its session was open in a terminal on the ${machineWord()} when it was taken up. Fork it to continue it here.`;

/** How long listing a linked Mac's threads or agents may take: it may be asleep. */
const lookMs = 8000;
/** How long a linked Mac may take to search its folders (feature folder_search): a person is typing. */
const folderSearchMs = 10_000;
/** What a call passed on to another Mac is given on top of the time it waits there. */
const passMs = 15_000;
/** How long another Mac may take to start a thread: an agent's first start is slow. */
const startMs = 150_000;
/** The longest mark naming who started a thread. */
const starterLength = 80;

/** How long `thread.wait` waits when not told, and the longest it will. */
export const defaultWaitMs = 60_000;
export const longestWaitMs = 3_600_000;
/**
 * The waits before each new try at a starter's notice that could not be sent (its Mac
 * asleep, out of reach or restarting), then the last of them again, for at most
 * `noticeTriesForMs` after the first.
 */
const noticeRetries = [10_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
const noticeTriesForMs = 6 * 3_600_000;
/** How long a notice taken here is known by its id (`Fleet.sendOnce`): longer than its sender tries it. */
const noticeKeptMs = noticeTriesForMs + 3_600_000;

export class Fleet {
  private readonly sessions: SessionManager;
  private readonly providers: Map<string, Provider>;
  private readonly folders: Folders;
  private readonly links: Links;
  private readonly remote: RemoteThreads;
  private readonly pages: FleetPages;
  private readonly epoch = randomBytes(8).toString("hex");
  /** This Mac: its stable id and its name for itself, which what it passes on to another Mac says. */
  private readonly here: Here;
  /** By thread: what to call when it comes to rest or is blocked. */
  private readonly waiting = new Map<string, Set<(timedOut: boolean) => void>>();
  /**
   * By thread: who waits for it now (`wait`'s `by`, with the wait's signal): a starter waiting
   * for it hears it there, and is not told too, unless its wait was called off.
   */
  private readonly waitingBy = new Map<string, Waiting[]>();
  /** Whether a thread started from another tells that one when it comes to rest, fails or asks something (`fleet.tellStarters`). */
  private readonly tellsStarters: boolean;
  /** By thread: the rest or questions its starter was last told of, so that each is told once. */
  private readonly told = new Map<string, string>();
  /**
   * Threads that reported to the thread that started them while they worked (`report`): they
   * told it themselves, and the bridge sends no notice of the rest that work comes to,
   * unless the starter sent them more since (`send`).
   */
  private readonly reported = new Set<string>();
  /** By thread: how many messages its starter has sent into it (`send`), so that a report its starter answered before it was done going marks nothing (`report`). */
  private readonly fromStarter = new Map<string, number>();
  /** Notices taken here, by thread and notice id, oldest first: when, and what sending it came to (`sendOnce`). */
  private readonly noticesTaken = new Map<string, { at: number; sent: Promise<{ status: string }> }>();
  /** By thread: the next try at a notice its starter could not be sent (`sendNotice`). */
  private readonly noticesDue = new Map<string, NodeJS.Timeout>();
  private readonly noticeRetries: readonly number[];
  private closed = false;

  constructor(options: { sessions: SessionManager; providers: Map<string, Provider>; folders: Folders; links: Links; here: Here; tellStarters?: boolean; noticeRetries?: readonly number[] }) {
    this.tellsStarters = options.tellStarters ?? false;
    this.noticeRetries = options.noticeRetries ?? noticeRetries;
    this.sessions = options.sessions;
    this.providers = options.providers;
    this.folders = options.folders;
    this.links = options.links;
    this.remote = new RemoteThreads(options.links);
    this.pages = new FleetPages(() => ({ epoch: this.deltaEpoch(), list: this.sessions.list() }), (cursor) => this.delta(cursor?.epoch, cursor?.list, cursor?.since));
    this.here = options.here;
    this.sessions.listen({
      requestOpened: (id) => {
        this.changed(id);
        this.tellStarter(id);
      },
      turnEnded: (id) => {
        this.changed(id);
        this.tellStarter(id);
      },
      // A turn that ended while a steered message waited for the agent to take it was still
      // at work then: it comes to rest here, and is told now (Codex's review of the branch).
      steerSettled: (id) => {
        this.changed(id);
        this.tellStarter(id);
      },
    });
  }

  /** The agent of that profile name; the first when none is named. */
  agent(profile: unknown): Provider {
    if (profile === undefined || profile === null || profile === "") {
      const first = this.providers.values().next().value;
      if (!first) throw new RpcError(ErrorCode.internal, "This bridge has no agents set up.");
      return first;
    }
    const found = this.providers.get(String(profile));
    if (!found) throw invalidParams(`There is no agent called ${String(profile)} on this bridge.`);
    return found;
  }

  /** The agents this bridge runs, as `profiles.list` names them. */
  agents(): { name: string; display_name: string; description: string }[] {
    return [...this.providers.values()].map((agent) => ({ name: agent.profile.name, display_name: agent.profile.displayName, description: agent.profile.description }));
  }

  // MARK: The six operations

  /** Every thread this bridge knows, newest first. Loads none. */
  threads(only: { state?: ThreadState; agent?: string } = {}): ThreadSummary[] {
    return this.sessions
      .records()
      .map((record) => this.summary(record))
      .filter((thread) => (!only.state || thread.state === only.state) && (!only.agent || thread.agent === only.agent))
      .sort((a, b) => b.updated - a.updated);
  }

  /**
   * This bridge's threads and those of every linked Mac, newest first, and which of
   * those Macs answered. A Mac that did not is left out of the threads, not an error.
   */
  async everyThread(only: { state?: ThreadState; agent?: string } = {}): Promise<{ threads: ThreadSummary[]; machines?: Machine[] }> {
    const links = this.links.all();
    this.remote.retain(links);
    if (links.length === 0) return { threads: this.threads(only) };
    // Each Mac lists its own: asked for more, two Macs linked to each other would ask for ever.
    // A filtered full reply can be much smaller than a cold unfiltered delta.
    // Keep every non-empty query on its exact existing RPC path.
    const filtered = Object.values(only).some((value) => value !== undefined);
    const params = { local: true, ...(only.state ? { state: only.state } : {}), ...(only.agent ? { profile: only.agent } : {}) };
    const threads = this.threads(only);
    const machines = await Promise.all(
      links.map(async (link): Promise<Machine> => {
        try {
          const listed = filtered
            ? ((await this.links.call(link.name, "threads.list", params, lookMs, { glance: true })) as { threads: ThreadSummary[] }).threads
            : await this.remote.list(link);
          // Convert the whole reply before adding it: a malformed row excludes this Mac.
          const remote = listed.map((thread) => there(link.name, thread));
          for (const thread of remote) threads.push(thread);
          return { name: link.name, url: link.url, reachable: true };
        } catch (error) {
          return { name: link.name, url: link.url, reachable: false, error: (error as Error).message };
        }
      }),
    );
    return { threads: threads.sort((a, b) => b.updated - a.updated), machines };
  }

  /** Whether a look at the linked Mac `name` would be turned away now, unasked, for failing a moment ago. */
  resting(name: string): boolean {
    return this.links.isResting(name);
  }

  /** The linked Macs' names and addresses, asking none of them. */
  linked(): { name: string; url: string }[] {
    return this.links.all().map((link) => ({ name: link.name, url: link.url }));
  }

  /**
   * One look passed to the linked Mac `name` (feature thread_search): a Mac that failed
   * a moment ago is not asked again yet, and the call ends with `signal`.
   */
  askLinked(name: string, method: string, params: Record<string, unknown>, timeoutMs = lookMs, signal?: AbortSignal): Promise<unknown> {
    return this.links.call(name, method, params, timeoutMs, { glance: true, signal });
  }

  /** The linked Macs, with the agents of those that answer. */
  machines(): Promise<Machine[]> {
    return Promise.all(
      this.links.all().map(async (link): Promise<Machine> => {
        try {
          const listed = (await this.links.call(link.name, "profiles.list", {}, lookMs, { glance: true })) as { profiles: { name: string; display_name: string }[] };
          return { name: link.name, url: link.url, reachable: true, agents: listed.profiles.map((agent) => ({ name: agent.name, display_name: agent.display_name })) };
        } catch (error) {
          return { name: link.name, url: link.url, reachable: false, error: (error as Error).message };
        }
      }),
    );
  }

  /** The folders a new thread can run in on a linked Mac, as its `folders.list` answers. */
  foldersOn(machine: string, profile: unknown): Promise<unknown> {
    return this.links.call(machine, "folders.list", typeof profile === "string" && profile !== "" ? { profile } : {});
  }

  /**
   * `folders.search` on a linked Mac (feature folder_search): a person types into it, so a
   * Mac that does not answer within 10 seconds is said to be out of reach.
   */
  searchFoldersOn(machine: string, params: { query: string; limit: number; profile: unknown }): Promise<unknown> {
    const { query, limit, profile } = params;
    return this.links.call(machine, "folders.search", { query, limit, ...(typeof profile === "string" && profile !== "" ? { profile } : {}) }, folderSearchMs);
  }

  /** The last `turns` turns of a thread and what is going on in it, without following it. */
  async read(id: string, turns = 1): Promise<ThreadReading> {
    const far = this.far(id);
    if (far) {
      const reading = (await this.links.call(far.machine, "thread.read", { thread: far.id, last: turns })) as ThreadReading;
      return { ...reading, thread: there(far.machine, reading.thread) };
    }
    const session = await this.load(id);
    // A thread only read shows what the terminal has done meanwhile.
    await session.refresh();
    const reading: ThreadReading = {
      thread: this.summary(session.record),
      messages: lastTurns(session.messages, turns),
      open_requests: session.requests.list(),
    };
    const inflight = session.snapshot().inflight as Record<string, unknown> | undefined;
    if (inflight) {
      // Without the reasoning not yet stored: it can run long, and only a device taking the
      // thread whole (`session.resume`) shows it. Whoever reads through the fleet (an agent,
      // `portals read`) takes in the reply and what the turn did.
      const { reasoning: _reasoning, ...rest } = inflight;
      reading.inflight = rest;
    }
    return reading;
  }

  /**
   * A message into a thread: `streaming` (a turn started for it), `steered` or `queued`.
   * It is not the user's, so it opens with a line saying it came through Portals, and
   * from which thread when `from` names one of the bridge's (fleet/line.ts). `notice` is a
   * starter's notice's own id, the same each time it is tried (`sendOnce`).
   */
  async send(id: string, text: string, by: Sender = {}, notice?: string): Promise<{ status: string }> {
    const far = this.far(id);
    if (far) {
      // The other bridge does not know this one's threads: it is told who as facts, with
      // this Mac's id, and in words for a bridge from before them. The text goes well formed,
      // as below, for a bridge from before that takes it as it comes, which ignores `notice`.
      const passed = { thread: far.id, text: text.toWellFormed(), ...this.passedOn(by), ...(notice ? { notice } : {}) };
      return (await this.links.call(far.machine, "thread.send", passed)) as { status: string };
    }
    if (notice) return this.sendOnce(id, text, by, notice);
    const session = this.current(await this.load(id));
    if (session.isReadOnly) throw invalidParams(readOnlyText);
    if (text.trim() === "") throw invalidParams("The message is empty.");
    if (by.from === id) throw invalidParams("A thread cannot send a message to itself.");
    const line = by.sentBy || !by.sender ? fromLine(by.sentBy ?? this.fromThread(by.from), text, this.here.id) : fromWords(by.sender, text);
    // Half of a surrogate pair (a text cut in the middle of an emoji, here or by another
    // bridge) would stay in the thread's history, and an agent's API may refuse every
    // later turn for it: it goes as U+FFFD, as frames to the app do (json.ts).
    const outcome = session.submit(line.toWellFormed(), { fleet: true });
    // A report covers the work up to it: what the starter asks after it, queued or steered
    // into the turn that reported, is told once done (bug hunt round 4, BC1). A message
    // from anyone else leaves the report as it was.
    const record = this.sessions.record(id);
    if (record && this.isStarterOf(record, by)) {
      this.fromStarter.set(id, (this.fromStarter.get(id) ?? 0) + 1);
      this.reported.delete(id);
    }
    outcome.begin?.();
    return { status: outcome.status };
  }

  /**
   * `send` of a starter's notice by its id: one taken here already, tried again because the
   * answer to it was lost on the way (the other Mac's connection closed after it was sent),
   * is answered as it was and not sent again. One that was not sent may be tried again.
   */
  private sendOnce(id: string, text: string, by: Sender, notice: string): Promise<{ status: string }> {
    const key = `${id} ${notice}`;
    const now = Date.now();
    for (const [old, { at }] of this.noticesTaken) {
      if (now - at < noticeKeptMs) break;
      this.noticesTaken.delete(old);
    }
    const taken = this.noticesTaken.get(key);
    if (taken) return taken.sent;
    const sent = this.send(id, text, by);
    this.noticesTaken.set(key, { at: now, sent });
    sent.catch(() => {
      if (this.noticesTaken.get(key)?.sent === sent) this.noticesTaken.delete(key);
    });
    return sent;
  }

  /**
   * `send`, then `wait` for the thread, by `by`: for a thread on another Mac in one call to
   * it, which sends and begins to wait in one step there, so that no rest falls between the
   * two and is told to its starter as well as to this wait (Codex's review of the branch).
   */
  async sendAndWait(id: string, text: string, timeoutMs = defaultWaitMs, signal?: AbortSignal, by: Sender = {}): Promise<Record<string, unknown>> {
    const far = this.far(id);
    if (far) {
      const waitMs = waitWithin(timeoutMs);
      const passed: Record<string, unknown> = { thread: far.id, text, ...this.passedOn(by), wait: true, timeout_ms: waitMs };
      if (by.from && this.sessions.record(by.from)) passed.origin = `${thisMachine()}/${by.from}`;
      return (await this.links.call(far.machine, "thread.send", passed, waitMs + passMs, { signal })) as Record<string, unknown>;
    }
    // Waiting from before the message goes: a turn that ends as it begins (the agent failed
    // to start) is told to this wait alone (Codex's second look at the branch).
    const stopWaiting = this.waitsFor(id, by, signal);
    try {
      const sent = await this.send(id, text, by);
      return { ...sent, ...(await this.wait(id, timeoutMs, signal, by)) };
    } finally {
      stopWaiting();
    }
  }

  /**
   * `by` waits for thread `id` (`waitingBy`) until the function this gives back is called, or
   * `signal` calls the wait off: a caller gone hears nothing, so the starter is told as if
   * nobody waited (Codex's third look at the branch). Nothing for a wait called off already.
   */
  private waitsFor(id: string, by: Sender, signal?: AbortSignal): () => void {
    if (signal?.aborted) return () => {};
    const entry: Waiting = { ...by, signal };
    this.waitingBy.set(id, [...(this.waitingBy.get(id) ?? []), entry]);
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", stop);
      const left = (this.waitingBy.get(id) ?? []).filter((waiting) => waiting !== entry);
      if (left.length === 0) this.waitingBy.delete(id);
      else this.waitingBy.set(id, left);
    };
    signal?.addEventListener("abort", stop, { once: true });
    return stop;
  }

  /**
   * Resolves when the thread is at rest (`idle` or `error`, with nothing queued) or
   * `blocked`: at once when it is already. After `timeoutMs` it resolves as it is,
   * `timed_out`. `signal` calls the wait off (the caller hung up): it
   * rejects with the signal's reason. `by` is the thread waiting, when one is: the thread
   * that started this one, waiting for it, is not told of its rest as well (`tellStarter`).
   */
  async wait(id: string, timeoutMs = defaultWaitMs, signal?: AbortSignal, by: Sender = {}): Promise<ThreadRest> {
    signal?.throwIfAborted();
    const waitMs = waitWithin(timeoutMs);
    const far = this.far(id);
    if (far) {
      // Who waits goes too, so that the thread there does not also tell its starter here of
      // the rest this wait is told of (Codex's review of the branch). An older bridge ignores it.
      const who: Record<string, unknown> = by.from || by.sentBy || by.sender ? { ...this.passedOn(by) } : {};
      if (by.from && this.sessions.record(by.from)) who.origin = `${thisMachine()}/${by.from}`;
      return (await this.links.call(far.machine, "thread.wait", { thread: far.id, timeout_ms: waitMs, ...who }, waitMs + passMs, { signal })) as ThreadRest;
    }
    const session = await this.load(id);
    signal?.throwIfAborted();
    const already = this.rest(session);
    if (already.state !== "working") return already;
    return new Promise((resolve, reject) => {
      const waiters = this.waiting.get(id) ?? new Set();
      this.waiting.set(id, waiters);
      const stopWaiting = this.waitsFor(id, by, signal);
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abandon);
        waiters.delete(settle);
        if (waiters.size === 0) this.waiting.delete(id);
        stopWaiting();
      };
      const settle = (timedOut: boolean) => {
        done();
        // The thread's session as it is now: it may have been loaded again as another
        // (a thread only read, continued) since the wait began, and that one has the turn.
        resolve({ ...this.rest(this.sessions.get(id) ?? session), timed_out: timedOut });
      };
      const abandon = () => {
        done();
        reject(signal?.reason);
      };
      const timer = setTimeout(() => settle(true), waitMs);
      timer.unref();
      waiters.add(settle);
      signal?.addEventListener("abort", abandon, { once: true });
    });
  }

  /**
   * A new thread, as `session.create` makes one: the agent, folder, model and level
   * checked. `by` is who starts it through the fleet (`thread.start`, the `portals`
   * command), which its mark says; a person starting it on a device gives none.
   */
  async start(params: StartParams, by?: Sender): Promise<Session> {
    const agent = this.agent(params.profile);
    const cwd = await this.workingDirectory(params.cwd);
    const catalog = await agent.models();
    const chosen = chooseModel(agent, catalog, (params.model as string | undefined) || catalog.model, (params.provider as string | undefined) || undefined);
    // None chosen: the level the model runs at by itself (Claude Code's differs by
    // model), as the app shows it, else the agent's own.
    const reasoningEffort = (params.reasoning_effort as string | undefined) ?? catalog.defaultLevels?.[chosen.model] ?? catalog.reasoning;
    checkLevel(reasoningEffort);
    const settings: SessionSettings = { ...chosen, reasoningEffort };
    const title = typeof params.title === "string" && params.title.trim() !== "" ? params.title : null;
    return this.sessions.create({ agent: agent.profile.name, cwd, title, settings, startedBy: by ? this.starter(by) : undefined });
  }

  /**
   * `thread.start` on a linked Mac, passed on whole (the first message and the wait
   * with it), and answered as that Mac answers, with the thread named from here.
   */
  async startOn(machine: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const { machine: _here, from, sender, origin: _origin, sent_by: sentBy, ...rest } = params;
    const by: Sender = { from: typeof from === "string" && from !== "" ? from : undefined, sender: typeof sender === "string" && sender !== "" ? sender : undefined, sentBy: readFrom(sentBy) };
    const passed: Record<string, unknown> = { ...rest, ...this.passedOn(by) };
    // Started from one of this bridge's threads: that thread, and only it, answers the new one's questions.
    if (typeof from === "string" && this.sessions.record(from)) passed.origin = `${thisMachine()}/${from}`;
    const waits = params.wait === true ? waitWithin(typeof params.timeout_ms === "number" ? params.timeout_ms : defaultWaitMs) : 0;
    const started = (await this.links.call(machine, "thread.start", passed, startMs + waits, { signal })) as { thread: ThreadSummary };
    return { ...started, thread: there(machine, started.thread) };
  }

  /** Stops the running turn. False when nothing was running. */
  async stop(id: string): Promise<boolean> {
    const far = this.far(id);
    if (far) return ((await this.links.call(far.machine, "thread.stop", { thread: far.id })) as { stopped: boolean }).stopped;
    const session = this.sessions.get(id);
    if (!session) {
      // Not loaded, so not running here; but a thread the bridge does not know is an error.
      this.known(id);
      return false;
    }
    return session.interrupt();
  }

  // MARK: Answers (feature agent_threads)

  /**
   * Answers question `request` open in thread `id`, for the thread that started it
   * through the fleet, as a device answers it: every device's card closes, told by whom
   * and how. Anyone else is refused. An approval is answered once, for the session or
   * no, never always (that changes the agent's settings for good), and allowed only by a
   * thread that has the access the allow gives (`allowRefused`). A thread on a linked Mac
   * is answered there, told the caller's mode, which only this bridge knows.
   */
  async answer(id: string, request: string, given: Answer, by: Answerer = {}): Promise<{ answered: true }> {
    const far = this.far(id);
    if (far) {
      // The other Mac knows the thread that started it only by this name for it.
      if (!by.from || !this.sessions.record(by.from)) throw invalidParams(onlyStarter(id));
      const mode = workingMode(this.sessions.get(by.from)?.mode());
      const passed: Record<string, unknown> = { thread: far.id, request, ...given, ...this.passedOn({ from: by.from }), origin: `${thisMachine()}/${by.from}` };
      if (mode) passed.caller_mode = mode;
      await this.links.call(far.machine, "thread.answer", passed);
      return { answered: true };
    }
    const record = this.known(id);
    const starter = record.startedBy;
    const passedOn = by.origin !== undefined || by.sentBy !== undefined;
    if (!starter || !this.isStarterOf(record, by)) throw invalidParams(onlyStarter(id));
    const session = this.sessions.get(id);
    const open = session?.requests.list().find((entry) => entry.id === request);
    if (!session || !open) throw new RpcError(ErrorCode.notFound, notOpen(id, request));
    // Another bridge says what mode its thread works in; this bridge's own is asked.
    const callerMode = passedOn ? by.callerMode : workingMode(by.from ? this.sessions.get(by.from)?.mode() : undefined);
    // A plan's `default` is what the asking thread's settings come to: not the mode it is
    // in now, which is plan mode while its plan waits. A mode the thread was moved to while
    // its plan waited is the one the work goes on in (Codex keeps it), so that is needed too.
    const childMode = session.mode();
    const result = open.method === "approval"
      ? approvalAnswer(open, given, callerMode, childMode?.defaultsTo, movedFromPlan(childMode))
      : questionAnswer(open, given);
    // A note goes to the thread after the no as the answering agent's message, as `send`
    // puts one, and not with the no: an agent is told a note given with a no, and every
    // device shows it, as the user's own words.
    const note = "note" in result ? result.note : undefined;
    const told = note !== undefined ? { choice: "deny" } : result;
    if (!session.requests.answerFor(request, { result: told }, { by: starter.name, answer: result })) throw new RpcError(ErrorCode.notFound, notOpen(id, request));
    if (note !== undefined) await this.send(id, note, by);
    return { answered: true };
  }

  // MARK: The list every device shows (feature thread_sync)

  /** Frozen local-only bootstrap pages; no historical overlay is published. */
  page(params: FleetPageParams): FleetPageReply {
    return this.pages.page(params);
  }

  /** Only asked explicitly by a bridge that keeps a fleet cache. Legacy methods keep their shapes. */
  delta(epoch: string | undefined, list: string | undefined, since: number | undefined): FleetDelta {
    const now = this.sessions.list();
    const current = this.deltaEpoch();
    const incremental = epoch === current && list === now.id && since !== undefined && since >= 0 && since <= now.revision;
    const ordered = this.sessions.records();
    const records = incremental ? this.sessions.changedSince(since) : ordered;
    let positions: number[] | undefined;
    if (incremental) {
      const slots = new Map(ordered.map((record, index) => [record.id, index]));
      positions = records.map((record) => slots.get(record.id)!);
    }
    const active = this.sessions.loadedRecords().flatMap((record) => {
      const state = this.state(this.sessions.get(record.id));
      return state.state === "idle" ? [] : [{ id: record.id, ...state }];
    });
    return {
      epoch: current, list: now, threads: records.map((record) => this.summary(record)), ...(positions ? { positions } : {}),
      removed: incremental ? this.sessions.removedSince(since) : [], active,
      order: fleetOrder(ordered.map((record) => record.id)),
      ...(!incremental ? { full: true as const } : {}),
    };
  }

  /**
   * This run's epoch and the agents' names: a row's agent_name comes from its provider, not
   * the registry, so a name that changes (Hermes describing a profile anew, an agent that
   * appears) makes the next delta whole rather than leave the old name on a linked Mac.
   */
  private deltaEpoch(): string {
    const names = [...this.providers].map(([name, agent]) => `${name}\u0000${agent.profile.displayName}`).sort();
    return `${this.epoch}.${createHash("sha256").update(names.join("\u0001")).digest("hex").slice(0, 16)}`;
  }

  /**
   * The threads changed since revision `since` of list `list`, and the ids removed since
   * then. Every thread, `full`, when the list is another (a device that held another
   * bridge home's, or one from before an older bridge saved the file) or `since` is not
   * a revision of it; its `removed` then names every thread taken off the list, so a
   * device can tell a thread removed from one this bridge never had. A thread removed and
   * taken up again since is listed, not removed.
   */
  changes(list: string | undefined, since: number | undefined): ListChanges {
    const now = this.sessions.list();
    const delta = list === now.id && since !== undefined && since >= 0 && since <= now.revision;
    const records = delta ? this.sessions.changedSince(since) : this.sessions.records();
    const threads = records.map((record) => this.listed(record)).sort((a, b) => b.updated - a.updated);
    const removed = this.sessions.removedSince(delta ? since : 0);
    if (counters.on) counters.changes(!delta ? "full" : threads.length + removed.length === 0 ? "empty" : "delta", threads.length);
    return delta ? { list: now, threads, removed } : { list: now, threads, removed, full: true };
  }

  /**
   * Takes one of this bridge's threads off the list every device shows; the agent keeps
   * its session, which the desk's list offers again. -32602 with a sentence for a
   * thread at work: it is stopped first.
   */
  async remove(id: string): Promise<void> {
    try {
      await this.sessions.remove(id);
    } catch (error) {
      if (error instanceof UnknownThreadError) throw new RpcError(ErrorCode.notFound, error.message);
      if (error instanceof RemoveRefused) throw invalidParams(error.message);
      throw error;
    }
  }

  /**
   * Pins, archives, marks unseen or seen, shares a thread an agent started (it is in the
   * sidebar, not only under the thread that started it), or gives a preview, for every
   * device: the last
   * write wins, and the thread keeps its place in the lists. Archiving unpins, unless the
   * same call pins: a device sends an archive and a pin made after it, in the archive, as
   * one change. It takes the thread out of Recent the same way (2026-11-02), which
   * something new in the thread does not undo: only opening or using it again does. A seen from a device that listed the thread before its last turn started
   * or ended leaves the mark that turn made, and so does one from another list (a bridge
   * home before this one), whose revisions are not this list's: named as such, or with a
   * revision ahead of the list's. So does one that names the turn it is of (`turn`, a device
   * that read a turn before its list had the turn's end) when a later turn has begun. A preview is taken only by a thread with none (a
   * device's own, for a thread from before previews).
   */
  mark(id: string, marks: Marks): ListedThread {
    const record = this.known(id);
    const changes: ThreadChanges = {};
    if (marks.archived !== undefined) changes.archived = marks.archived;
    if (marks.archived === true) {
      changes.pinned = false;
      changes.recent = false;
    }
    if (marks.pinned !== undefined) changes.pinned = marks.pinned;
    if (marks.shared !== undefined) changes.shared = marks.shared;
    if (marks.recent !== undefined) changes.recent = marks.recent;
    if (marks.unseen === true) changes.unseen = true;
    const list = this.sessions.list();
    const another = (marks.list !== undefined && marks.list !== list.id) || (marks.revision !== undefined && marks.revision > list.revision);
    const stale = another || (marks.revision !== undefined && (record.turnRevision ?? 0) > marks.revision) || (marks.turn !== undefined && record.turnStarted !== marks.turn);
    if (marks.unseen === false && !stale) changes.unseen = false;
    const preview = marks.preview === undefined || record.preview ? undefined : previewOf(marks.preview);
    if (preview) changes.preview = preview;
    this.sessions.mark(id, changes);
    return this.listed(record);
  }

  /** A thread as the list every device shows gives it. */
  listed(record: ThreadRecord): ListedThread {
    const thread: ListedThread = { ...this.summary(record), created: record.createdAt, revision: record.revision ?? 0 };
    if (record.turnStarted !== undefined) thread.turn = record.turnStarted;
    if (record.preview) thread.preview = record.preview;
    if (record.pinned) thread.pinned = true;
    if (record.archived) thread.archived = true;
    if (record.unseen) thread.unseen = true;
    // Its origin is this bridge's to check, and no device's to see.
    const starter = record.startedBy;
    if (starter) thread.started_by = { name: starter.name, ...(starter.thread ? { thread: starter.thread } : {}), ...(starter.from ? { from: starter.from } : {}) };
    if (record.shared) thread.shared = true;
    if (record.recent) thread.recent = true;
    if (record.branch) thread.branch = record.branch;
    if (record.repo) thread.repo = record.repo;
    return thread;
  }

  /** How many waits for a thread are pending. */
  get waiters(): number {
    let count = 0;
    for (const waiters of this.waiting.values()) count += waiters.size;
    return count;
  }

  /** Lets go of everyone waiting, for shutting down. */
  close(): void {
    this.closed = true;
    this.remote.close();
    this.pages.close();
    for (const timer of this.noticesDue.values()) clearTimeout(timer);
    this.noticesDue.clear();
    for (const waiters of [...this.waiting.values()]) {
      for (const settle of [...waiters]) settle(true);
    }
  }

  // MARK: Helpers

  summary(record: ThreadRecord): ThreadSummary {
    const thread: ThreadSummary = {
      id: record.id,
      agent: record.agent,
      agent_name: this.providers.get(record.agent)?.profile.displayName ?? record.agent,
      folder: record.cwd,
      ...this.state(this.sessions.get(record.id)),
      updated: record.updatedAt,
    };
    if (record.title) thread.title = record.title;
    if (record.readOnly) thread.read_only = true;
    if (record.ongoing) thread.ongoing = true;
    return thread;
  }

  /** Only a loaded thread can be anything but idle: it runs in the bridge, or the bridge follows it. */
  private state(session: Session | undefined): { state: ThreadState; kind?: BlockedKind } {
    if (!session) return { state: "idle" };
    const open = session.requests.list();
    if (open.length > 0) return { state: "blocked", kind: open[0].method === "clarify" ? "question" : "permission" };
    // A message handed to the running turn that the agent has not taken yet may still
    // start a turn of its own; one waiting on the list (behind the agent's side catching
    // up after its connection dropped, or restored from disk) has a turn still to come.
    if (session.isAtWork) return { state: "working" };
    const last = session.messages.at(-1);
    return { state: last?.role === "assistant" && last.display_kind === "failed_turn" ? "error" : "idle" };
  }

  /**
   * The bridge's thread a command says it runs in (`from`): the same id, or the thread
   * whose agent knows it now by another (`Provider.threadKnownAs`: a Cursor thread whose
   * conversation was started afresh). The id as it came when none does.
   */
  threadOf(id: string): string {
    if (this.sessions.record(id)) return id;
    for (const provider of this.providers.values()) {
      const thread = provider.threadKnownAs?.(id);
      if (thread && this.sessions.record(thread)) return thread;
    }
    return id;
  }

  /**
   * Who a message sent through the fleet is from, as facts (fleet/line.ts): one of this
   * bridge's threads, its agent and title, or nobody known (the command line: a person
   * or a script in a terminal).
   */
  private fromThread(from: string | undefined): From {
    const record = from ? this.sessions.record(from) : undefined;
    if (!record) return {};
    const agent = this.providers.get(record.agent)?.profile.displayName ?? record.agent;
    return readFrom({ agent: record.agent, agent_name: agent, thread: record.id, title: record.title ?? undefined }) ?? {};
  }

  /**
   * Who, for another Mac's bridge that a message, start or answer is passed on to: the
   * facts, with this Mac's id and name (`sent_by`), and in words for a bridge from before
   * them (`sender`). What another bridge passed on to this one goes on as it came.
   */
  private passedOn(by: Sender): { sender: string; sent_by?: From } {
    if (by.sender && !by.sentBy) return { sender: by.sender };
    const from = fromHere(by.sentBy ?? this.fromThread(by.from), this.here);
    return { sender: by.sender ?? words(from), sent_by: from };
  }

  /**
   * Who is starting a thread through the fleet, as its mark names them and keeps them:
   * another Mac's thread by its agent and that Mac (`Claude Code on mini`), with the facts
   * another bridge passed on, or its words for whoever asked there (a bridge from before
   * them); one of this bridge's threads by its agent; or the `portals` command when
   * nobody is named (the person at the Mac, or an agent that cannot name its thread).
   */
  private starter(by: Sender): StartedBy {
    if (by.sentBy) {
      const name = shortSender(`${by.sentBy.agent_name ?? (by.sentBy.thread ? "an agent" : "the portals command")} on ${by.sentBy.machine_name ?? by.sentBy.machine ?? "another Mac"}`);
      return { name, ...(by.origin ? { origin: by.origin } : {}), from: by.sentBy };
    }
    const sender = by.sender ? shortSender(by.sender) : "";
    if (sender) return by.origin ? { name: sender, origin: by.origin } : { name: sender };
    const record = by.from ? this.sessions.record(by.from) : undefined;
    if (record) {
      const from = this.fromThread(record.id);
      return { name: from.agent_name ?? record.agent, thread: record.id, from: { agent: record.agent, agent_name: from.agent_name, thread: record.id } };
    }
    return { name: "the portals command" };
  }

  /**
   * `portals report`: the thread `by.from` tells the thread that started it, on this Mac or
   * another, as its report of the work it is doing, and the bridge sends no notice of the
   * rest that work comes to (`tellStarter`). For an update while it works, or a question,
   * `send` is the way: the notice still follows that.
   */
  async report(text: string, by: Sender): Promise<{ status: string; thread: string }> {
    const record = by.from ? this.sessions.record(by.from) : undefined;
    if (!record) throw invalidParams("Only a thread reports: run portals report in a thread another thread started.");
    const starter = this.starterOf(record);
    if (!starter) {
      throw invalidParams(record.startedBy?.from?.machine || record.startedBy?.origin
        ? "The thread that started this one is on a Mac this one cannot reach now: nothing was sent."
        : "No thread started this one, so there is no one to report to: nothing was sent.");
    }
    // The starter may answer the report with more work before the report's own send comes
    // back (an answer from another Mac on the way): that work is not covered by it.
    const answered = this.fromStarter.get(record.id) ?? 0;
    const sent = await this.send(starter, text, { from: record.id });
    if (this.state(this.sessions.get(record.id)).state === "working" && (this.fromStarter.get(record.id) ?? 0) === answered) this.reported.add(record.id);
    return { ...sent, thread: starter };
  }

  /** Whether `by` is the thread that started `record`: this bridge's own by its id, another Mac's by what that Mac passed on. */
  private isStarterOf(record: ThreadRecord, by: Sender): boolean {
    const starter = record.startedBy;
    if (!starter) return false;
    const passedOn = by.origin !== undefined || by.sentBy !== undefined;
    return passedOn ? startedBySame(starter, by) : by.from !== undefined && starter.thread === by.from;
  }

  /**
   * Where the thread that started `record` is, to send to: its id here, or `name/id` on the
   * linked Mac of the net it is on. Undefined when no thread started it (a person, the
   * `portals` command in a shell), or its Mac is not linked now.
   */
  private starterOf(record: ThreadRecord): string | undefined {
    const starter = record.startedBy;
    if (starter?.thread) return starter.thread;
    const from = starter?.from;
    if (!from?.thread || !from.machine || from.machine === this.here.id) return undefined;
    const name = this.links.nameOfMachine(from.machine);
    return name ? `${name}/${from.thread}` : undefined;
  }

  /**
   * A thread that another thread started came to rest, failed or asks something: the bridge
   * tells that thread itself, with a message from this one (`notice`), on this Mac or the
   * one it is on, so that it needs neither to poll nor to be told by the agent (2026-10-28: "we should add a deterministic mechanism that notifies the parent thread
   * when the child is finished"). Not while more is queued for it, not twice for the same
   * rest or questions, and not when the starter waits for it (`wait`), which tells it. Not of
   * a rest either when the thread reported to its starter while it worked (`report`): that
   * was its report. A message sent with `send` is no report (an update while it works, a
   * question): the notice follows it. What it asks is told whatever it sent, with the
   * request's id, which the starter needs to answer it.
   */
  private tellStarter(id: string): void {
    if (!this.tellsStarters) return;
    const record = this.sessions.record(id);
    const starter = record ? this.starterOf(record) : undefined;
    if (!record || !starter) return;
    // Looked at now: a wait is settled, and gone, in the step after this one (`changed`).
    const waited = (this.waitingBy.get(id) ?? []).some((by) => !by.signal?.aborted && this.isStarterOf(record, by));
    queueMicrotask(() => void this.noticeNow(id, starter, waited));
  }

  /** `tellStarter`'s look at the thread once its step is over: what it is now, and the notice of it. */
  private async noticeNow(id: string, starter: string, waited: boolean): Promise<void> {
    // A turn that ended while the bridge was down is told as the thread is loaded again,
    // before the load is done (Session.attach): it is looked at once it is.
    const session = this.sessions.get(id) ?? (await this.sessions.whileLoading(id)?.catch(() => undefined));
    if (!session || !this.sessions.record(id)) return;
    const { state } = this.state(session);
    if (state === "working") return;
    const reported = state !== "blocked" && this.reported.delete(id);
    const open = session.requests.list();
    const seen = `${state} ${session.messages.length} ${open.map((request) => request.id).join(",")}`;
    if (this.told.get(id) === seen) return;
    this.told.set(id, seen);
    // A notice still due of an earlier rest or questions is out of date: this one is told instead.
    clearTimeout(this.noticesDue.get(id));
    this.noticesDue.delete(id);
    if (waited || reported) return;
    // Its own id, the same at each try, so that the starter's bridge takes it once (`sendOnce`).
    await this.sendNotice(id, starter, seen, notice(state, lastReply(session.messages), open), randomBytes(8).toString("hex"), Date.now(), 0);
  }

  /**
   * Sends thread `id`'s starter its notice of the rest or questions `seen`. One that could
   * not be sent (the starter's Mac asleep, out of reach or restarting, its bridge closing)
   * is tried again later (`noticeRetries`), since the starter was told it need not poll.
   * Given up when the thread has come to another rest or asks something else since, which
   * is told instead; when it was taken off the list; when the starter turned it down (the
   * thread is gone there, or only read); and after `noticeTriesForMs`.
   */
  private async sendNotice(id: string, starter: string, seen: string, text: string, noticeID: string, since: number, tries: number): Promise<void> {
    if (this.closed || this.told.get(id) !== seen || !this.sessions.record(id)) return;
    // Looked at before every try, the one a timer brings late among them (the Mac asleep):
    // past it, the starter's bridge may have let go of the notice's id, and would take it again.
    if (Date.now() - since > noticeTriesForMs) {
      log.info("the thread that started a thread was not told of it: its time to be tried ran out", { thread: id, starter });
      return;
    }
    try {
      await this.send(starter, text, { from: id }, noticeID);
      return;
    } catch (error) {
      const refused = error instanceof RpcError && (error.code === ErrorCode.notFound || error.code === ErrorCode.invalidParams);
      const wait = this.noticeRetries[Math.min(tries, this.noticeRetries.length - 1)];
      const again = !refused && !this.closed && this.told.get(id) === seen && Date.now() + wait - since <= noticeTriesForMs;
      log.info(again ? "the thread that started a thread could not be told of it yet: tried again later" : "the thread that started a thread was not told of it", {
        thread: id, starter, error: (error as Error).message,
      });
      if (!again) return;
      const timer = setTimeout(() => {
        if (this.noticesDue.get(id) !== timer) return;
        this.noticesDue.delete(id);
        // Where the starter is now: its Mac may be back under another name in the net.
        const record = this.sessions.record(id);
        const now = record ? this.starterOf(record) : undefined;
        void this.sendNotice(id, now ?? starter, seen, text, noticeID, since, tries + 1);
      }, wait);
      timer.unref();
      this.noticesDue.set(id, timer);
    }
  }

  /** Whether `record`'s starter will be told of its rests and questions (`tellStarter`): the answer to `thread.start` says so (`tells_starter`). */
  tellsStarterOf(record: ThreadRecord): boolean {
    return this.tellsStarters && this.starterOf(record) !== undefined;
  }

  /** For `machine/thread`: the linked Mac and the thread's id there. Undefined for a thread of this bridge. */
  private far(id: string): { machine: string; id: string } | undefined {
    const slash = id.indexOf("/");
    return slash > 0 ? { machine: id.slice(0, slash), id: id.slice(slash + 1) } : undefined;
  }

  private rest(session: Session): ThreadRest {
    const state = this.state(session);
    // Still working: what it is saying now, which is stored only once a tool call or
    // the turn's end closes it.
    const inflight = state.state === "working" ? (session.snapshot().inflight as { assistant?: unknown } | undefined) : undefined;
    const saying = typeof inflight?.assistant === "string" && inflight.assistant.trim() !== "" ? inflight.assistant : "";
    return { ...state, timed_out: false, reply: saying || lastReply(session.messages), open_requests: session.requests.list() };
  }

  /** A session said a turn ended or a question opened: whoever waits for it may be done. */
  private changed(id: string): void {
    if (!this.waiting.has(id)) return;
    // Once the session has finished the step that said so: by then a message that was
    // queued has its turn reserved, and the thread is not at rest.
    queueMicrotask(() => {
      const session = this.sessions.get(id);
      if (!session || this.state(session).state === "working") return;
      for (const settle of [...(this.waiting.get(id) ?? [])]) settle(false);
    });
  }

  private async load(id: string): Promise<Session> {
    try {
      return await this.sessions.load(id);
    } catch (error) {
      if (error instanceof UnknownThreadError) throw new RpcError(ErrorCode.notFound, error.message);
      throw error;
    }
  }

  /** The thread's live session now, in the step that uses it: 4007 when it was taken off the list while it was loaded. */
  private current(session: Session): Session {
    try {
      return this.sessions.current(session);
    } catch (error) {
      if (error instanceof UnknownThreadError) throw new RpcError(ErrorCode.notFound, error.message);
      throw error;
    }
  }

  private known(id: string): ThreadRecord {
    const record = this.sessions.record(id);
    if (!record) throw new RpcError(ErrorCode.notFound, `There is no thread ${id} on this bridge.`);
    return record;
  }

  /**
   * The folder a new thread runs in, as its real path (Claude Code files a session under
   * `/private/tmp/x` for `/tmp/x`, and later lookups must match): General when none is
   * named, else one from `folders.list`.
   */
  private async workingDirectory(cwd: unknown): Promise<string> {
    try {
      return await this.folders.resolve(typeof cwd === "string" ? cwd : undefined);
    } catch (error) {
      if (error instanceof FolderRefused) throw invalidParams(error.message);
      throw error;
    }
  }
}

/**
 * Whether an answer another bridge passed on (`by`) is from the thread that started the
 * thread asking (`starter`): the same Mac's same thread by the facts, when both have them
 * (that Mac's id stays the same whatever network it is on); else by the origin, as older
 * bridges passed it.
 */
function startedBySame(starter: StartedBy | undefined, by: Sender): boolean {
  if (!starter) return false;
  const kept = starter.from;
  const given = by.sentBy;
  if (kept?.machine !== undefined && given?.machine !== undefined) return kept.thread !== undefined && kept.machine === given.machine && kept.thread === given.thread;
  return starter.origin !== undefined && starter.origin === by.origin;
}

/**
 * A passed-on `sender` as a thread's mark: its words without the quoted title and the
 * thread id they carry (`Claude Code · "Fix the login" (thread 6d3c…) on mini` is
 * "Claude Code on mini"), on one line, at most 80 characters.
 */
/** How much of a reply a starter's notice carries; the rest is a `portals read` away. */
export const noticeReplyChars = 2_000;

/**
 * What the thread that started a thread is told when that one comes to rest, fails or asks
 * something (`Fleet.tellStarter`), under the line saying which thread it is from.
 */
export function notice(state: ThreadState, reply: string, open: readonly OpenRequest[]): string {
  if (state === "blocked") {
    const asks = open.map((request) => `- ${askedIn(request)}`).join("\n");
    return `Notice from the bridge: this thread is waiting for an answer, and asks the person in the app:\n${asks}\nTell the person, or answer it with \`portals answer\` only as they would.`;
  }
  const said = reply.length > noticeReplyChars ? `${cutWhole(reply, noticeReplyChars).trimEnd()}…\n(Cut short: \`portals read\` has all of it.)` : reply;
  const head = state === "error" ? "Notice from the bridge: this thread's turn ended with an error." : "Notice from the bridge: this thread finished its turn.";
  return said.trim() === "" ? head : `${head} ${state === "error" ? "Why" : "Its last reply"}:\n\n${said}`;
}

/** An open request in a line: an approval's command and why, a question's words. */
function askedIn(request: OpenRequest): string {
  const params = request.params;
  const text = (value: unknown): string => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");
  const questions = Array.isArray(params.questions)
    ? params.questions.map((question) => text((question as Record<string, unknown> | null)?.question)).filter((question) => question !== "")
    : [];
  const what = [text(params.question), ...questions, text(params.description), text(params.command)].filter((part) => part !== "");
  const kind = request.method === "approval" ? "an approval" : request.method === "clarify" ? "a question" : request.method;
  return `${kind} (request ${request.id})${what.length > 0 ? `: ${cutWhole(what.join(" · "), 300)}` : ""}`;
}

export function shortSender(sender: string): string {
  const line = sender
    .replace(/ · ".*" \(thread [^)]*\)/s, "")
    .replace(/ \(thread [^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > starterLength ? `${line.slice(0, starterLength - 1).trimEnd()}…` : line;
}

/**
 * How long a wait is, for the time asked for: none for less than none, and the longest
 * at most, on this Mac and on a linked one alike. A timer set for more milliseconds
 * than it holds (about 25 days) would fire at once, and the call to a linked Mac with it.
 */
export function waitWithin(timeoutMs: number): number {
  return Math.min(Math.max(timeoutMs, 0), longestWaitMs);
}

/** A thread of the linked Mac `machine`, as it is named and listed here. */
function there(machine: string, thread: ThreadSummary): ThreadSummary {
  return { ...thread, id: `${machine}/${thread.id}`, machine };
}

/** The messages of the last `count` turns. Every user message opens a turn, as the app reads them. */
export function lastTurns(messages: readonly StoredMessage[], count: number): StoredMessage[] {
  let left = Math.max(count, 1);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user" && --left === 0) return messages.slice(index);
  }
  return [...messages];
}

/** What the last turn has said: its last piece of text, which for a failed turn is why. */
export function lastReply(messages: readonly StoredMessage[]): string {
  const message = messages[lastReplyAt(messages)];
  return message?.role === "assistant" ? message.text : "";
}

/** Where in `messages` the last turn's reply is (`lastReply`); -1 when it has said nothing. */
export function lastReplyAt(messages: readonly StoredMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role === "assistant" && message.text.trim() !== "") return index;
  }
  return -1;
}

export function checkLevel(level: string): void {
  if (level !== "" && !(thinkingLevels as readonly string[]).includes(level)) {
    throw invalidParams(`${level} is not a thinking level. Use one of: ${thinkingLevels.join(", ")}.`);
  }
}

/** The model and provider to use, checked against what the agent offers. */
export function chooseModel(agent: Provider, catalog: ModelCatalog, model: string, providerSlug: string | undefined, currentProvider?: string): { model: string; provider: string } {
  if (agent.profile.kind === "opencode") {
    try { ({ model, providerSlug } = modelChoice(catalog, model, providerSlug, currentProvider)); }
    catch (error) { throw invalidParams((error as Error).message); }
  }
  const offering = providerSlug
    ? catalog.providers.find((entry) => entry.slug === providerSlug)
    : (catalog.providers.find((entry) => entry.models.includes(model)) ?? catalog.providers.find((entry) => entry.slug === catalog.provider));
  if (!offering) throw invalidParams(`The ${agent.profile.displayName} has no provider called ${providerSlug}.`);
  // A model the agent names but leaves off the list (Claude Code's `opus`, listed as its `default`) still runs.
  if (!offering.models.includes(model) && catalog.names?.[model] === undefined) {
    throw invalidParams(`The ${agent.profile.displayName} cannot run the model ${model}.`);
  }
  return { model, provider: offering.slug };
}

// MARK: Answers

/** Why a thread cannot answer another's question: it did not start it. */
function onlyStarter(id: string): string {
  return `Only the thread that started thread ${id} can answer its questions. Tell the user it is blocked, and on what (its open_requests).`;
}

function notOpen(id: string, request: string): string {
  return `Thread ${id} has no open question ${request}: it was answered or withdrawn already. Read the thread again.`;
}

/** The mode a thread works in now: its own, or what `default` comes to under the agent's settings; undefined when not known. */
export function workingMode(state: ModeState | null | undefined): WorkingMode | undefined {
  if (!state) return undefined;
  return state.mode === "default" ? state.defaultsTo : state.mode;
}

/**
 * The mode a thread asking with a plan works in now, when it is no longer in plan mode
 * (moved while its plan waited): its own, or what `default` comes to, full access when
 * that is not known. Undefined in plan mode, or for an agent without modes.
 */
export function movedFromPlan(state: ModeState | null | undefined): WorkingMode | undefined {
  if (!state || state.mode === "plan") return undefined;
  return workingMode(state) ?? "full";
}

/**
 * Why a thread working in `callerMode` cannot allow `request`, or undefined when it can:
 * a command or an edit asked for needs full access, the most a thread runs with; a plan
 * needs the mode its work starts in (`starts_in`), `default` being what the asking
 * thread's agent settings come to (`childDefault`), and full access when that is not
 * known; and, when the asking thread was moved out of plan mode while its plan waited,
 * at least the mode it works in now (`childNow`), which the work goes on in. A caller
 * whose mode is not known can allow nothing.
 */
export function allowRefused(request: OpenRequest, callerMode: string | undefined, childDefault: WorkingMode | undefined, childNow?: WorkingMode): string | undefined {
  const caller = isThreadMode(callerMode) && callerMode !== "default" ? callerMode : undefined;
  const plan = request.params.plan === true;
  const startsIn = request.params.starts_in;
  const asked: WorkingMode = isThreadMode(startsIn) && startsIn !== "default" ? startsIn : (childDefault ?? "full");
  const needs: WorkingMode = !plan ? "full" : childNow !== undefined && modeRank[childNow] > modeRank[asked] ? childNow : asked;
  if (caller !== undefined && modeRank[caller] >= modeRank[needs]) return undefined;
  const yours = caller ? `yours runs in ${modeWords[caller]}` : "the mode yours runs in is not known";
  if (!plan) return `Allowing this needs your own thread to run in full access, and ${yours}. Answer with deny, or leave it to the user.`;
  return `Approving this plan lets the thread work in ${modeWords[needs]}, which needs your own thread to run in that or more, and ${yours}. Ask it to keep planning (deny, with a note), or leave it to the user.`;
}

/** The answer to approval `open` that `given` stands for, as a device would send it; a sentence for the agent when it is not one it may give. */
function approvalAnswer(open: OpenRequest, given: Answer, callerMode: string | undefined, childDefault: WorkingMode | undefined, childNow: WorkingMode | undefined): { choice: string; note?: string } {
  if (given.answers !== undefined) throw invalidParams("This is an approval: answer it with a choice, not answers.");
  const choice = given.choice;
  if (choice === "always") throw invalidParams("An agent cannot allow always: it would change the agent's settings for good. Allow once or for the session, or leave it to the user.");
  if (choice !== "once" && choice !== "session" && choice !== "deny") throw invalidParams("Answer an approval with a choice: once, session or deny.");
  const listed = Array.isArray(open.params.choices) ? open.params.choices.filter((offered): offered is string => typeof offered === "string") : [];
  // As the app shows an approval that lists none.
  const offered = listed.length > 0 ? listed : ["once", "deny"];
  // A no is always one: the agent asking takes any answer it was not offered as one.
  if (choice !== "deny" && !offered.includes(choice)) throw invalidParams(`This approval does not offer ${choice}: it offers ${offered.join(", ")}.`);
  const note = given.note?.trim() ?? "";
  if (note !== "" && choice !== "deny") throw invalidParams("A note goes only with deny: it tells the agent what to do instead.");
  if (choice !== "deny") {
    const refused = allowRefused(open, callerMode, childDefault, childNow);
    if (refused) throw invalidParams(refused);
  }
  return note !== "" ? { choice, note } : { choice };
}

/** The answers to question `open` that `given` stands for: every question's qid, null for one not answered. */
function questionAnswer(open: OpenRequest, given: Answer): { answers: Record<string, string | null> } {
  if (open.method !== "clarify") throw invalidParams("This question cannot be answered through Portals. Leave it to the user.");
  if (given.choice !== undefined || given.note !== undefined) throw invalidParams("This is a question: answer it with answers, not a choice.");
  if (given.answers === undefined) throw invalidParams("Answer a question with answers: each question's qid and what to say.");
  const questions = Array.isArray(open.params.questions) ? (open.params.questions as { qid?: unknown }[]) : [];
  const answers: Record<string, string | null> = {};
  for (const question of questions) {
    if (typeof question?.qid !== "string") continue;
    const value = given.answers[question.qid] ?? null;
    if (value !== null && typeof value !== "string") throw invalidParams("Each answer is text, or null to skip its question.");
    answers[question.qid] = value !== null && value.trim() !== "" ? value : null;
  }
  if (Object.values(answers).every((answer) => answer === null)) throw invalidParams("Give at least one answer, under the qid its question has in open_requests.");
  return { answers };
}
