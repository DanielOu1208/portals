import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { counters } from "../counters.ts";
import { threadRepo } from "../git.ts";
import { HeldElsewhere } from "../fleet/heldElsewhere.ts";
import { log } from "../log.ts";
import { DeskRefused, type AdoptMode, type OngoingThread, type Provider, type SessionSettings } from "../providers/types.ts";
import { providerModeOptions } from "../providers/modes.ts";
import type { DiffStore } from "./keptDiffs.ts";
import { lastPreview } from "./preview.ts";
import type { Peer, SessionListener, ThreadActivity } from "./session.ts";
import { Session } from "./session.ts";
import type { Registry, StartedBy, ThreadChanges, ThreadRecord } from "./registry.ts";
import type { SpentStore } from "./spent.ts";
import type { WaitingStore } from "./waiting.ts";

// The live sessions, and loading the ones the registry knows. A session stays loaded
// for the life of the process once something created or resumed it, until its thread is
// removed (`remove`) or a thread only read is continued. A session loaded again for the
// same thread numbers its events on from where the last one stopped (eventLog.ts).

export interface CreateOptions {
  agent: string;
  cwd: string;
  title: string | null;
  settings: SessionSettings;
  /** Started through the fleet: who by, for the thread's mark. Absent for a person on a device. */
  startedBy?: StartedBy;
}

export interface AdoptOptions {
  agent: string;
  /** The desk session's id. */
  id: string;
  mode: AdoptMode;
  /** Whether a session in this folder may be taken up (`desk.list` offers none in others); any may when absent. */
  allows?: (path: string) => boolean;
}

/**
 * How long closing waits for the sessions before it closes the agents all the same: their
 * own processes (Claude Code's kept warm, Codex's app-server) are not left running for a
 * session that does not close. Claude Code is given five seconds to exit once its input
 * ends, and stopped then; the process gives up on the rest at eight (lifetime.ts).
 */
const sessionsCloseMs = 6000;

export class UnknownThreadError extends Error {}

/** A thread that cannot be taken off the list now (`remove`). The message is for the user. */
export class RemoveRefused extends Error {}

export class SessionManager {
  private readonly registry: Registry;
  private readonly providers: Map<string, Provider>;
  private readonly logCapacity: number | undefined;
  private readonly waiting: WaitingStore | undefined;
  private readonly spent: SpentStore | undefined;
  private readonly diffs: DiffStore | undefined;
  /** Closing with the bridge: nothing waiting is sent any more. */
  private closing = false;
  private readonly listeners: SessionListener[] = [];
  /** What every session is given to tell: each listener in turn, one's failure not costing the others. */
  private readonly listener: SessionListener = {
    requestOpened: (id, request) => this.tell((listener) => listener.requestOpened?.(id, request)),
    turnEnded: (id, status, text) => this.tell((listener) => listener.turnEnded?.(id, status, text)),
    steerSettled: (id) => this.tell((listener) => listener.steerSettled?.(id)),
    activityChanged: (id) => this.tell((listener) => listener.activityChanged?.(id)),
  };
  private readonly live = new Map<string, Session>();
  private readonly loading = new Map<string, Promise<Session>>();
  /** Desk sessions being taken up, by id. */
  private readonly adopting = new Map<string, Promise<Session>>();
  /** By agent: its one ongoing thread being found or made (`ongoing`), or put on the list as the bridge starts (`keepOngoing`). */
  private readonly finding = new Map<string, Promise<Session | null>>();
  /** By thread: the last `seq` a session let go of in this run gave out, which the next one numbers on past, its replay starting afresh. */
  private readonly lastSeq = new Map<string, number>();
  /** By thread: the last id a session let go of in this run gave a message waiting, which the next one numbers on from. */
  private readonly lastQueueID = new Map<string, number>();

  /**
   * `listener` is told about every session's questions and turns (notifications);
   * `waiting` keeps the messages waiting for a running turn while they wait.
   */
  /** Which of this bridge's threads threads on other Macs of the net keep at work (feature held_elsewhere). */
  private readonly held: HeldElsewhere;

  constructor(options: {
    registry: Registry; providers: Map<string, Provider>; logCapacity?: number; listener?: SessionListener; waiting?: WaitingStore; spent?: SpentStore;
    diffs?: DiffStore; heldFor?: number;
  }) {
    this.held = new HeldElsewhere((threads) => {
      for (const id of threads) this.tell((listener) => listener.activityChanged?.(id));
    }, options.heldFor);
    this.registry = options.registry;
    this.providers = options.providers;
    this.logCapacity = options.logCapacity;
    this.waiting = options.waiting;
    this.spent = options.spent;
    this.diffs = options.diffs;
    if (options.listener) this.listeners.push(options.listener);
  }

  /** Also tells `listener` about every session's questions and turns (the fleet's waits). */
  listen(listener: SessionListener): void {
    this.listeners.push(listener);
  }

  /** Every thread the bridge knows, loaded or not. */
  records(): ThreadRecord[] {
    return this.registry.all();
  }

  /** Loaded threads still on the list: their live state is not part of the registry's revision. */
  loadedRecords(): ThreadRecord[] {
    return [...this.live.values()].filter((session) => this.registry.get(session.id) === session.record).map((session) => session.record);
  }

  /** A thread's record, loaded or not. */
  record(id: string): ThreadRecord | undefined {
    return this.registry.get(id);
  }

  /** The list every device shows (feature thread_sync): its id and its revision now. */
  list(): { id: string; revision: number } {
    return { id: this.registry.list, revision: this.registry.revision };
  }

  /** The records changed since `revision` of the list. */
  changedSince(revision: number): ThreadRecord[] {
    return this.registry.changedSince(revision);
  }

  /** The ids taken off the list since `revision` of it; every one for 0. */
  removedSince(revision: number): string[] {
    return this.registry.removedSince(revision);
  }

  /** Changes a thread's marks or preview, which every device shows, leaving its place in the lists. */
  mark(id: string, changes: Pick<ThreadChanges, "pinned" | "archived" | "unseen" | "shared" | "recent" | "preview">): void {
    this.registry.set(id, changes);
  }

  /** A loaded session, or undefined. */
  get(id: string): Session | undefined {
    return this.live.get(id);
  }

  /** How many sessions are loaded. */
  get loaded(): number {
    return this.live.size;
  }

  /**
   * The threads at work now: `waiting` on an answer (an approval or a question is open),
   * else `running` a turn, or a subagent or workflow the agent started (feature
   * subagents). Only threads loaded here can be either: a Claude thread runs only in a
   * process the bridge started, and the bridge follows at startup every Codex thread
   * Codex still runs. Then `running`, besides, each thread of this bridge one of those
   * was started from (`startedBy.thread`, feature agent_threads), and the one that one
   * was started from, and so on up, while it is at rest itself: what it set to work goes
   * on (2026-10-27: "when there is a thread, subagent, or workflow working i
   * think the parent thread should also be working"). A started thread waiting for an
   * answer keeps it running, not waiting: Needs you is for the thread that asks. A
   * command left running in the background keeps neither its own thread at work nor
   * the one that started it ("but if there is only a background task i dont think it
   * should be labelled as working"). Status only: the starting thread's turn is over.
   * Such a thread, listed only for what it started, says `inherited: true`, so that a
   * device knows that no turn of its own ended when it leaves the list, and that its
   * own chat, which knows of no thread it started, does not say all of its state. It may
   * be a thread not loaded here. A thread running with no turn of its own, for its
   * subagents or workflows or for what it started, says `turn: false`: its turn's end was
   * told when it came, and it leaving the list ends no turn (2026-10-27, of the
   * unseen dot such a thread took then on a device without it open: "yes fix that").
   */
  activity(): { session_id: string; state: ThreadActivity; inherited?: true; turn?: false }[] {
    const own = new Map<string, ThreadActivity>();
    const turnless = new Set<string>();
    for (const session of this.live.values()) {
      const state = session.activity;
      if (state) own.set(session.id, state);
      if (state === "running" && !session.isBusy) turnless.add(session.id);
    }
    // Up the line of threads that started each, and no further than a thread an earlier
    // line went through, whose own were gone through then: each thread once. From each
    // thread at work here, and from each one a thread on another Mac keeps at work, itself
    // included (`threads.held`, feature held_elsewhere).
    const inherited = new Set<string>();
    const walked = new Set(own.keys());
    const climb = (from: string | undefined) => {
      for (let thread = from; thread !== undefined && !walked.has(thread); thread = this.startedFrom(thread)) {
        walked.add(thread);
        inherited.add(thread);
      }
    };
    for (const id of own.keys()) climb(this.startedFrom(id));
    for (const id of this.held.threads()) if (this.registry.get(id)) climb(id);
    return [
      ...[...own].map(([session_id, state]) => (turnless.has(session_id) ? { session_id, state, turn: false as const } : { session_id, state })),
      ...[...inherited].map((session_id) => ({ session_id, state: "running" as const, inherited: true as const, turn: false as const })),
    ];
  }

  /**
   * The Mac of the net `mac` says these threads of this bridge have threads started from
   * them at work there now (`threads.held`): what it said before is replaced, and holds for
   * a few minutes unless said again (`HeldElsewhere`). Threads this bridge does not have
   * are left out.
   */
  holdElsewhere(mac: string, threads: string[]): void {
    this.held.hold(mac, threads.filter((id) => this.registry.get(id) !== undefined));
  }

  /** The thread of this bridge `id` was started from, when it still has it. */
  private startedFrom(id: string): string | undefined {
    const parent = this.registry.get(id)?.startedBy?.thread;
    return parent !== undefined && this.registry.get(parent) ? parent : undefined;
  }

  async create(options: CreateOptions): Promise<Session> {
    const provider = this.provider(options.agent);
    if (provider.ongoingThread) return this.ongoing(provider, options);
    return this.make(provider, options, (await provider.newThread?.({ cwd: options.cwd, settings: options.settings })) ?? randomUUID());
  }

  /** A new thread `id` (the agent's session id: Codex's own, else the bridge's choice). */
  private async make(provider: Provider, options: CreateOptions, id: string, ongoing?: OngoingThread): Promise<Session> {
    const now = Math.floor(Date.now() / 1000);
    const record: ThreadRecord = {
      id,
      agent: options.agent,
      cwd: options.cwd,
      title: options.title,
      model: options.settings.model,
      provider: options.settings.provider,
      reasoningEffort: options.settings.reasoningEffort,
      createdAt: ongoing?.createdAt ?? now,
      updatedAt: now,
      origin: "phone",
    };
    if (ongoing) record.ongoing = true;
    if (options.startedBy) record.startedBy = options.startedBy;
    const session = this.session(record);
    // The one ongoing thread keeps the agent's own name for it, which is how the agent finds it again.
    const title = ongoing ? null : record.title;
    await session.attach(await provider.startSession({ id: record.id, cwd: record.cwd, settings: options.settings, title, ...(ongoing ? { ongoing: true } : {}) }, session.sink));
    // One found may hold what was said before.
    if (ongoing) record.preview ??= ongoing.preview || lastPreview(session.messages);
    noteRepo(record);
    this.registry.add(record);
    this.live.set(record.id, session);
    return session;
  }

  /**
   * The thread as its agent has it now, before a device is shown it (`session.resume`):
   * one only read is read again (`Session.refresh`), and one continued here and at rest
   * whose agent's copy went on elsewhere since it was read (a Pi at the desk) is let go of,
   * so that it is loaded again as after a restart (2026-10-27, on the backlog's
   * "What was said at the desk without a bridge restart"). Its events are numbered on, and
   * the list's marks of its turns, kept in its record, stay; a device that followed it
   * opens it again to go on hearing it, as after a restart.
   */
  async refresh(session: Session): Promise<void> {
    await session.refresh();
    // An agent's one ongoing conversation another of its apps went on with (Hermes Desktop)
    // is taken again in place, every device that holds it told (feature bot_chat). A
    // failed look leaves the thread as it is.
    if (await session.takeConversationFromElsewhere().catch(() => false)) return;
    if (!(await session.changedElsewhere())) return;
    // Checked again in the step that lets go of it: nothing came in meanwhile.
    if (this.live.get(session.id) !== session || !session.atRest) return;
    log.info("a thread's conversation went on elsewhere, so it is loaded again", { session: session.id });
    await this.unload(session.id);
  }

  /** The agent's one ongoing thread on the list, when it has one there. */
  ongoingRecord(agent: string): ThreadRecord | undefined {
    return this.registry.all().find((record) => record.agent === agent && record.ongoing === true);
  }

  /**
   * A new thread of an agent that keeps one ongoing conversation (feature bot_chat): that
   * one, also when two devices ask at once. The one on the list when there is one, else
   * the agent's own, found or made where the agent keeps it, as a thread of the person's
   * by the agent's name, whoever asked for it.
   */
  private async ongoing(provider: Provider, options: CreateOptions): Promise<Session> {
    for (;;) {
      const kept = this.ongoingRecord(options.agent);
      if (kept) return this.load(kept.id);
      const pending = this.finding.get(options.agent);
      if (pending) {
        const found = await pending;
        if (found) return found;
        continue;
      }
      const finding = (async () => {
        const found = await provider.ongoingThread!(true, { cwd: options.cwd, settings: options.settings });
        if (!found) throw new Error(`${provider.profile.displayName} did not make its conversation.`);
        return this.takeAsOngoing(provider, options.agent, found, options.settings);
      })();
      return (await this.once(options.agent, finding))!;
    }
  }

  /** Runs `work` as the agent's finding of its ongoing thread, which others wait for. */
  private async once(agent: string, work: Promise<Session | null>): Promise<Session | null> {
    this.finding.set(agent, work);
    try {
      return await work;
    } finally {
      if (this.finding.get(agent) === work) this.finding.delete(agent);
    }
  }

  /**
   * `found` as the agent's one ongoing thread on the list. Loaded when `settings` are
   * given (a device asked for the thread); otherwise only listed, to be loaded when a
   * device opens it. One that was on the list as the ongoing thread before goes, as the
   * agent's other threads do.
   */
  private async takeAsOngoing(provider: Provider, agent: string, found: OngoingThread, settings?: SessionSettings): Promise<Session | null> {
    const before = this.ongoingRecord(agent);
    if (before && before.id !== found.id) {
      log.info("the agent keeps its ongoing conversation in another session now; the old one leaves the list", { agent, before: before.id, now: found.id });
      this.registry.set(before.id, { ongoing: undefined });
      await this.remove(before.id).catch((error: Error) => log.warn("could not take the old ongoing thread off the list", { thread: before.id, error: error.message }));
    }
    const title = provider.profile.displayName;
    if (this.registry.has(found.id)) {
      this.registry.set(found.id, { ongoing: true, title, startedBy: undefined });
      return settings ? this.load(found.id) : null;
    }
    if (settings) return this.make(provider, { agent, cwd: found.cwd, title, settings }, found.id, found);
    const now = Math.floor(Date.now() / 1000);
    const record: ThreadRecord = {
      id: found.id,
      agent,
      cwd: found.cwd,
      title,
      model: provider.profile.model,
      provider: provider.profile.provider,
      reasoningEffort: "",
      createdAt: found.createdAt ?? now,
      updatedAt: now,
      origin: "phone",
      ongoing: true,
    };
    if (found.preview) record.preview = found.preview;
    this.registry.add(record);
    return null;
  }

  /**
   * As the bridge starts, for an agent that keeps one ongoing conversation (feature
   * bot_chat): the one the agent has goes on the list, not loaded, and none is made; the
   * agent's other threads leave it, kept by the agent. One at work stays until the next
   * start. Throws when the agent cannot say where it keeps it, leaving the list as it is.
   */
  async keepOngoing(agent: string): Promise<void> {
    const provider = this.provider(agent);
    if (!provider.ongoingThread) return;
    for (;;) {
      const pending = this.finding.get(agent);
      if (!pending) break;
      await pending.catch(() => undefined);
    }
    const listed = this.ongoingRecord(agent);
    const found = await provider.ongoingThread(false, { cwd: "", settings: { model: provider.profile.model, provider: provider.profile.provider, reasoningEffort: "" } });
    if (found) await this.once(agent, this.takeAsOngoing(provider, agent, found));
    else if (listed && this.ongoingRecord(agent)?.id === listed.id) {
      // The agent has none now (removed or renamed where it keeps it): the one on the list
      // would never open, and no other is made while it is there (Codex's review of n14).
      log.info("the agent no longer has its ongoing conversation; the one on the list leaves it, and a new one is made when asked", { agent, thread: listed.id });
      this.registry.set(listed.id, { ongoing: undefined });
      await this.remove(listed.id).catch((error: Error) => log.warn("could not take the old ongoing thread off the list", { thread: listed.id, error: error.message }));
    }
    const others = this.registry.all().filter((record) => record.agent === agent && record.ongoing !== true);
    if (others.length > 0) log.info(`${provider.profile.displayName} keeps one conversation: ${others.length} other thread${others.length === 1 ? "" : "s"} leave the list`);
    for (const record of others) {
      try {
        await this.remove(record.id);
      } catch (error) {
        log.warn("a thread of an agent that keeps one conversation stays on the list for now", { thread: record.id, error: (error as Error).message });
      }
    }
  }

  /**
   * Makes a session started at the desk into a thread (`session.adopt`): continued as
   * it is, forked into a new one, or only read. The provider checks it may be taken up
   * so and throws `DeskRefused` when not, as it is thrown for one in a folder `desk.list`
   * would not offer it from (`allows`). A session that is a thread already is that
   * thread, except that one only read is continued when asked, if it now may be. Two
   * devices taking up the same session at once get the one thread.
   *
   * A thread taken off the list is taken up again the agent's usual way; an agent with
   * no sessions from the desk (Hermes) gets its record back as it was, continued only.
   * Either way it leaves removed.json, except for a fork, which is a thread of its own.
   */
  async adopt(options: AdoptOptions): Promise<Session> {
    const provider = this.provider(options.agent);
    if (options.mode === "fork") {
      if (!provider.adopt) throw new DeskRefused(this.removedOf(options) ? onlyAsItWas(provider) : noDesk(provider));
      return this.takeUp(provider, options);
    }
    const pending = this.adopting.get(options.id);
    if (pending) {
      // Once the other one has taken it up (or failed to), this asks again, and finds the thread.
      await pending.catch(() => undefined);
      return this.adopt(options);
    }
    const taking = this.adoptOnce(provider, options);
    this.adopting.set(options.id, taking);
    try {
      return await taking;
    } finally {
      this.adopting.delete(options.id);
    }
  }

  /** `adopt` continuing or reading a session, one call at a time for each. */
  private async adoptOnce(provider: Provider, options: AdoptOptions): Promise<Session> {
    const known = this.registry.get(options.id);
    // An agent with no sessions of the desk's, or whose are only forked (Cursor), adopts only
    // to fork: a thread of its taken off the list comes back as it was, from its record,
    // which still has its folder.
    if (!known && provider.adopt && ((provider.deskSessions && !provider.deskForksOnly) || !this.removedOf(options))) return this.takeUp(provider, options);
    if (!known) {
      const removed = this.removedOf(options);
      if (!removed) throw new DeskRefused(noDesk(provider));
      if (options.mode !== "continue") throw new DeskRefused(onlyAsItWas(provider));
      checkFolder(options, removed.cwd);
      return this.restore(provider, removed);
    }
    if (known.agent !== options.agent) throw new DeskRefused(`That session belongs to another agent.`);
    if (!(known.readOnly && options.mode === "continue" && provider.adopt)) return this.loadOnce(known.id);
    // Continued, it is taken up anew: not in a folder the list no longer offers it from.
    checkFolder(options, known.cwd);
    await provider.adopt!(known.id, "continue", true);
    // Loaded again, as a thread that is continued: a session only read was never joined.
    // One loading only to be read (a device opening it, or the bridge following it at its
    // start) is let go of too, once loaded; loads asked for from now on wait for this.
    await this.loading.get(known.id)?.catch(() => undefined);
    await this.unload(known.id);
    this.registry.set(known.id, { readOnly: undefined });
    return this.loadOnce(known.id);
  }

  /** A desk session, not a thread yet, made into one by its agent, which `adopt` checked takes them up. */
  private async takeUp(provider: Provider, options: AdoptOptions): Promise<Session> {
    // A fork is made as it is asked for: its folder is checked first, as the session has it.
    if (options.mode === "fork" && options.allows) checkFolder(options, (await provider.adopt!(options.id, "read")).cwd);
    const adoption = await provider.adopt!(options.id, options.mode);
    const existing = this.registry.get(adoption.id);
    if (existing) return this.loadOnce(existing.id);
    checkFolder(options, adoption.cwd);
    // A thread taken off the list comes back as it was: with the title it had, as the
    // desk's list offered it, and its model, level and mode (one set to ask first must not
    // come back running on the agent's own settings, which may allow everything).
    const removed = this.registry.removedRecord(adoption.id);
    // A fork keeps its source's approval restriction, not the agent's potentially more
    // permissive default: also the source's that was taken off the list.
    const source = options.mode === "fork" ? (this.registry.get(options.id) ?? this.registry.removedRecord(options.id)) : undefined;
    const policy = removed ?? (source?.agent === options.agent ? source : undefined);
    const settings = policy ?? adoption.settings;
    const now = Math.floor(Date.now() / 1000);
    const record: ThreadRecord = {
      id: adoption.id,
      agent: options.agent,
      cwd: adoption.cwd,
      title: removed?.title ?? adoption.title,
      model: settings.model,
      provider: settings.provider,
      reasoningEffort: settings.reasoningEffort,
      createdAt: now,
      updatedAt: now,
      origin: "desk",
    };
    if (policy?.mode) record.mode = policy.mode;
    if (policy?.modeBeforePlan) record.modeBeforePlan = policy.modeBeforePlan;
    if (policy?.modeReset) record.modeReset = true;
    // And the subagents that had left its line stay off it (feature subagents_clear).
    if (removed?.subagentsCleared) record.subagentsCleared = removed.subagentsCleared;
    // And its questions settled on their card stay so (feature async_questions).
    if (removed?.cardAnswers) record.cardAnswers = removed.cardAnswers;
    if (options.mode === "read") record.readOnly = true;
    // A fork's history is the agent's copy of the one it came from, which lost the same
    // diffs: it has the ones that one kept (feature turn_diff).
    const copied = options.mode === "fork" && adoption.id !== options.id;
    if (copied) this.diffs?.copy(options.id, adoption.id);
    const session = this.session(record);
    try {
      await session.attach(await provider.resumeSession(this.sessionOptions(record), session.sink));
    } catch (error) {
      // No thread: nothing would ever let go of its copy.
      if (copied) this.diffs?.forget(adoption.id);
      throw error;
    }
    record.preview ??= lastPreview(session.messages);
    if (removed) this.tell((listener) => listener.threadReturning?.(record.id));
    noteRepo(record);
    this.registry.add(record);
    this.live.set(record.id, session);
    return session;
  }

  /** A thread taken off the list, of an agent with no sessions from the desk, put back on it as it was. */
  private async restore(provider: Provider, record: ThreadRecord): Promise<Session> {
    // It is continued, which is what it comes back for: one only read before is no longer.
    delete record.readOnly;
    const session = this.session(record);
    await session.attach(await provider.resumeSession(this.sessionOptions(record), session.sink));
    record.preview ??= lastPreview(session.messages);
    this.tell((listener) => listener.threadReturning?.(record.id));
    noteRepo(record);
    this.registry.add(record);
    this.live.set(record.id, session);
    return session;
  }

  /** The thread taken off the list that `adopt` names, when it is that agent's. */
  private removedOf(options: AdoptOptions): ThreadRecord | undefined {
    const record = this.registry.removedRecord(options.id);
    return record?.agent === options.agent ? record : undefined;
  }

  /**
   * The session for a stored id, loading it when needed. Throws `UnknownThreadError` when
   * there is none. A thread being taken up (a thread only read, being continued) is
   * loaded once that is done, never in between as it was; one let go of while it loaded
   * gives way to the one that replaced it. `adopt` itself loads with `loadOnce`.
   */
  /** The load of `id` under way, if one is: none starts here. */
  whileLoading(id: string): Promise<Session> | undefined {
    return this.loading.get(id);
  }

  async load(id: string): Promise<Session> {
    for (;;) {
      const adopting = this.adopting.get(id);
      if (adopting) {
        await adopting.catch(() => undefined);
        continue;
      }
      const session = await this.loadOnce(id);
      if (!session.isRetired) return session;
    }
  }

  /**
   * The live session of `session`'s thread now, for a call that loaded it and is about
   * to use it: `session`, or the one that replaced it. `UnknownThreadError` when the
   * thread was taken off the list meanwhile; an error to try again when it is between
   * two sessions.
   */
  current(session: Session): Session {
    if (!session.isRetired) return session;
    const now = this.live.get(session.id);
    if (now) return now;
    if (this.registry.has(session.id)) throw new Error("This thread is being opened again. Try once more.");
    throw new UnknownThreadError(`There is no thread ${session.id} on this bridge.`);
  }

  private async loadOnce(id: string): Promise<Session> {
    const live = this.live.get(id);
    if (live) return live;
    const pending = this.loading.get(id);
    if (pending) return pending;

    const record = this.registry.get(id);
    if (!record) throw new UnknownThreadError(`There is no thread ${id} on this bridge.`);
    const loading = (async () => {
      const started = counters.on ? performance.now() : 0;
      const session = this.session(record);
      const provider = this.provider(record.agent);
      await session.attach(await provider.resumeSession(this.sessionOptions(record), session.sink));
      // Loaded as the bridge closes: its messages waiting stay on disk for the next start.
      if (this.closing) session.closeSoon();
      if (started) counters.loaded(provider, performance.now() - started);
      // A thread from before previews takes one the first time it is loaded; nothing is loaded only to find one.
      // Not kept when threads.json cannot be written, which fails no load: the next load finds it again.
      const preview = record.preview ? undefined : lastPreview(session.messages);
      if (preview) {
        try {
          this.registry.set(id, { preview });
        } catch (error) {
          log.warn("could not keep a thread's first preview", { thread: id, error: (error as Error).message });
        }
      }
      this.live.set(id, session);
      return session;
    })();
    this.loading.set(id, loading);
    try {
      return await loading;
    } finally {
      this.loading.delete(id);
    }
  }

  /** What a provider is told of a thread it loads. */
  private sessionOptions(record: ThreadRecord) {
    const settings: SessionSettings = { model: record.model, provider: record.provider, reasoningEffort: record.reasoningEffort };
    return {
      id: record.id,
      cwd: record.cwd,
      settings,
      title: record.title,
      mode: record.mode ?? "default",
      modeBeforePlan: record.modeBeforePlan,
      modeReset: record.modeReset === true,
      desk: record.origin === "desk",
      readOnly: record.readOnly === true,
      ongoing: record.ongoing === true,
    } as const;
  }

  /** A session for `record`, numbering its events on past the last one of this thread in this run. */
  private session(record: ThreadRecord): Session {
    return new Session(record, this.registry, { modeOptions: providerModeOptions(this.provider(record.agent)), logCapacity: this.logCapacity, listener: this.listener, lastSeq: this.lastSeq.get(record.id), waiting: this.waiting, spent: this.spent, diffs: this.diffs, lastQueueID: this.lastQueueID.get(record.id) });
  }

  /** Lets go of a loaded session; it is loaded again from the registry when next asked for. */
  private async unload(id: string): Promise<void> {
    const session = this.letGo(id);
    if (session) await session.close();
  }

  /** Takes a loaded session out of the live ones for good, in one step: it starts nothing again. */
  private letGo(id: string): Session | undefined {
    const session = this.live.get(id);
    if (!session) return undefined;
    this.live.delete(id);
    this.lastSeq.set(id, session.latestSeq);
    this.lastQueueID.set(id, session.latestQueueID);
    session.retire();
    // One at work is no longer listed as at work.
    if (session.activity) this.tell((listener) => listener.activityChanged?.(id));
    return session;
  }

  /**
   * Takes a thread off the list every device shows (`thread.delete`). It never stops
   * anything: a thread at work (a turn running, a
   * message handed to it not yet taken, a question open, a turn the bridge ended for
   * the agent that the agent has not ended itself, or work the agent runs on in the
   * background after its turn) are refused with `RemoveRefused`.
   *
   * A thread not loaded runs nothing here, except in an agent that runs threads without
   * the bridge (Codex, Hermes): one it still has open is loaded first, so a turn it runs
   * is seen, also in the moments after a restart before the bridge follows it again. A
   * thread being loaded or taken up is waited for. Then, in one step, the session leaves
   * the live sessions for good, the record leaves the registry for removed.json, and the
   * listeners hear `threadRemoved`; after that the agent's side closes (Claude Code's
   * process ends; Codex and Hermes keep the thread as their own). Nothing the agent
   * stores is erased, and the thread can be taken up again from the desk.
   */
  async remove(id: string): Promise<void> {
    for (;;) {
      const record = this.registry.get(id);
      if (!record) throw new UnknownThreadError(`There is no thread ${id} on this bridge.`);
      const provider = this.providers.get(record.agent);
      const name = provider?.profile.displayName ?? record.agent;
      if (record.ongoing) throw new RemoveRefused(`${name}'s conversation is always there: it cannot be removed.`);
      const atWork = () => new RemoveRefused(`${name} is still working in this thread. Stop it, then remove it.`);
      // Stop does not end it, and closing the session would.
      const inBackground = () => new RemoveRefused(`${name} still has work running in the background in this thread. Remove it once that work is done.`);
      const pending = this.adopting.get(id) ?? this.loading.get(id);
      if (pending) {
        await pending.catch(() => undefined);
        continue;
      }
      const session = this.live.get(id);
      if (!session && provider?.liveThreads && (await this.stillOpen(provider, id))) {
        await this.load(id);
        continue;
      }
      if (session && (session.isAtWork || (await this.stopping(name, session)))) throw atWork();
      if (session?.hasBackgroundWork) throw inBackground();
      // The agent was asked meanwhile: the step is taken only on what holds now.
      if (this.registry.get(id) !== record || this.live.get(id) !== session || this.loading.has(id) || this.adopting.has(id)) continue;
      if (session?.isAtWork) throw atWork();
      if (session?.hasBackgroundWork) throw inBackground();
      // The record first: when its files cannot be written, nothing else changes.
      this.registry.remove(id);
      this.letGo(id);
      // Nothing waits in a thread at work, which is refused above; nor in one gone.
      this.forgetWaiting(id);
      try {
        this.spent?.forget(id);
      } catch (error) {
        log.warn("could not let go of what a removed thread's turns spent", { thread: id, error: (error as Error).message });
      }
      try {
        this.diffs?.forget(id);
      } catch (error) {
        log.warn("could not let go of the diffs a removed thread's edits kept", { thread: id, error: (error as Error).message });
      }
      this.tell((listener) => listener.threadRemoved?.(id));
      await session?.close().catch((error: Error) => log.warn("a removed thread's session did not close cleanly", { thread: id, error: error.message }));
      return;
    }
  }

  /**
   * After a restart: the threads that had messages waiting for a running turn are
   * loaded, so each message has its turn once the turn it waited for is over, or at once
   * when that turn ended with the bridge. One taken off the list meanwhile has its
   * messages let go of; one that cannot be loaded keeps them for when it is. `agent`:
   * only that agent's threads. False when one could not be loaded, which is logged, as a
   * debug line when `quiet` (one tried again).
   */
  async sendWaiting(agent?: string, quiet = false): Promise<boolean> {
    let all = true;
    for (const id of this.waiting?.threads() ?? []) {
      if (this.closing) return true;
      const record = this.registry.get(id);
      if (!record) {
        this.forgetWaiting(id);
        continue;
      }
      if (agent !== undefined && record.agent !== agent) continue;
      try {
        await this.load(id);
      } catch (error) {
        all = false;
        if (quiet) log.debug("could not load a thread with messages waiting yet", { thread: id, error: (error as Error).message });
        else log.warn("could not load a thread with messages waiting", { thread: id, error: (error as Error).message });
      }
    }
    return all;
  }

  private forgetWaiting(id: string): void {
    try {
      this.waiting?.write(id, []);
    } catch (error) {
      log.warn("could not let go of the messages a thread had waiting", { thread: id, error: (error as Error).message });
    }
  }

  /** Whether an agent that runs threads without the bridge has this one open now. */
  private async stillOpen(provider: Provider, id: string): Promise<boolean> {
    try {
      return (await provider.liveThreads!([id])).includes(id);
    } catch (error) {
      throw notAsked(provider.profile.displayName, error as Error);
    }
  }

  /** Whether the agent may be running a turn the session does not show as running (`Session.stopping`). */
  private async stopping(name: string, session: Session): Promise<boolean> {
    try {
      return await session.stopping();
    } catch (error) {
      throw notAsked(name, error as Error);
    }
  }

  /** The loaded session that has an open question with this id. */
  withRequest(requestID: string): Session | undefined {
    for (const session of this.live.values()) {
      if (session.requests.has(requestID)) return session;
    }
    return undefined;
  }

  /** A connection went away: it follows nothing any more. Its sessions run on. */
  disconnected(peer: Peer): void {
    for (const session of this.live.values()) session.unfollow(peer);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.held.close();
    // Every session loaded closes now, so none opens a turn for a message waiting; a
    // thread being loaded is closed once loaded, before its messages waiting can start.
    const closed = new Set(this.live.values());
    const closing = [...closed].map((session) => this.closeSession(session));
    const sessions = (async () => {
      await Promise.allSettled([...this.loading.values()]);
      closing.push(...[...this.live.values()].filter((session) => !closed.has(session)).map((session) => this.closeSession(session)));
      // One that fails to close keeps neither the others nor the agents from closing.
      await Promise.allSettled(closing);
      return true;
    })();
    // Nor does one that never closes, after a while.
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), sessionsCloseMs)));
    if (!(await Promise.race([sessions, late]))) log.warn(`the sessions had not closed after ${sessionsCloseMs / 1000} seconds; the agents close all the same`);
    clearTimeout(timer);
    this.live.clear();
    // The diffs of the latest edits, which wait a moment to be written: now, before the bridge stops.
    this.diffs?.flush();
    await Promise.allSettled(
      [...this.providers.entries()].map(async ([agent, provider]) => {
        try {
          await provider.close?.();
        } catch (error) {
          log.warn("an agent did not close cleanly", { agent, error: (error as Error).message });
        }
      }),
    );
  }

  /** Closes a session as the bridge closes; one that fails says so in the log. */
  private async closeSession(session: Session): Promise<void> {
    try {
      await session.close();
    } catch (error) {
      log.warn("a session did not close cleanly", { session: session.id, error: (error as Error).message });
    }
  }

  private provider(agent: string): Provider {
    const provider = this.providers.get(agent);
    if (!provider) throw new Error(`The agent ${agent} is not available on this bridge.`);
    return provider;
  }

  private tell(message: (listener: SessionListener) => void): void {
    for (const listener of this.listeners) {
      try {
        message(listener);
      } catch (error) {
        log.warn("a session listener failed", { error: (error as Error).message });
      }
    }
  }
}

/** Why a thread is not removed when its agent cannot say whether it is at work. */
function notAsked(name: string, error: Error): Error {
  return new Error(`Portals could not ask ${name} whether this thread is at work (${error.message}). Try again in a moment.`);
}

/** Why an agent with no sessions from the desk takes nothing up but a thread taken off the list. */
function noDesk(provider: Provider): string {
  return `${provider.profile.displayName} has no sessions from the desk to take up.`;
}

/** Why a thread taken off the list is taken up again only as it was, by an agent with no sessions from the desk. */
function onlyAsItWas(provider: Provider): string {
  return `${provider.profile.displayName} can only continue a thread taken off the list, not fork it or only read it.`;
}

/** Refuses a session in a folder `desk.list` does not offer sessions from. */
function checkFolder(options: AdoptOptions, path: string): void {
  if (options.allows && !options.allows(path)) {
    throw new DeskRefused("That session is in a folder Portals does not list (one that is gone, temporary, hidden in its settings or the bridge's own), so it cannot be taken up.");
  }
}

/**
 * A thread about to be listed, new or back on the list, is listed under the repository
 * its folder is a worktree of, where it is one (feature worktrees): from its first
 * listing, not only after its first turn.
 */
function noteRepo(record: ThreadRecord): void {
  const repo = threadRepo(record.cwd, record.repo);
  if (repo) record.repo = repo;
  else delete record.repo;
}

/**
 * Each thread on the list, as the bridge starts, is listed under the repository its
 * folder is a worktree of (feature worktrees): threads from before the bridge knew of
 * worktrees, and ones whose worktree was made or taken away while it was not running. In
 * the background, a thread at a time; a thread whose folder is gone keeps what it had.
 */
export async function noteRepos(registry: Registry, batch = 100): Promise<void> {
  // One thread a tick (git's files are read synchronously), saved a batch at a time:
  // threads.json is written whole at each save, so one save for each of many threads
  // from before the feature would write it over and over.
  let found: [string, ThreadChanges, string | undefined][] = [];
  const save = () => {
    // Not over a repository a turn found meanwhile.
    const changes = found.filter(([id, , was]) => registry.get(id)?.repo === was).map(([id, change]) => [id, change] as const);
    found = [];
    try {
      registry.setMany(changes);
    } catch (error) {
      log.warn("could not keep the repository threads' worktrees are of", { threads: changes.length, error: (error as Error).message });
    }
  };
  for (const record of registry.all()) {
    await new Promise((resolve) => setImmediate(resolve));
    const now = registry.get(record.id);
    if (!now) continue;
    const repo = threadRepo(now.cwd, now.repo);
    if (repo === now.repo) continue;
    found.push([record.id, { repo }, now.repo]);
    if (found.length >= batch) save();
  }
  save();
}
