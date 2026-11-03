// Threads on two Macs of a net, one started from the other: the Mac where the starting
// thread is lists it as running while the thread it started on the other Mac is at work,
// as it does for one started on this Mac (docs/fleet-plan.md, "A thread on another Mac
// keeping its starter working"; feature held_elsewhere). The Mac where the started thread
// works says so to the starter's (`TellStarters`), which takes its word for a while
// (`HeldElsewhere`).

/** How long a Mac's word on which threads here its threads keep at work holds, unless said again. */
export const heldForMs = 3 * 60_000;
/** How often a Mac says it again while it is not empty. */
export const tellEveryMs = 60_000;
/** How long a Mac whose bridge does not take `threads.held` is not asked again. */
const olderForMs = 10 * 60_000;

/**
 * Which of this bridge's threads threads on other Macs of the net keep at work, as each of
 * those Macs last said (`threads.held`): the whole set each time, replacing what it said
 * before, and good for `heldForMs`, so that a Mac gone from the net, asleep or out of reach
 * keeps nothing working here for long.
 */
export class HeldElsewhere {
  private readonly byMac = new Map<string, { threads: Set<string>; until: number }>();
  private readonly changed: (threads: Set<string>) => void;
  private readonly heldFor: number;
  private timer: NodeJS.Timeout | undefined;

  /** `changed` is told the threads that came or went, as a Mac speaks or its word runs out. */
  constructor(changed: (threads: Set<string>) => void, heldFor = heldForMs) {
    this.changed = changed;
    this.heldFor = heldFor;
  }

  /** The Mac `mac` says these threads here have threads started from them at work there now. */
  hold(mac: string, threads: Iterable<string>): void {
    const before = this.threads(true);
    const set = new Set(threads);
    if (set.size === 0) this.byMac.delete(mac);
    else this.byMac.set(mac, { threads: set, until: Date.now() + this.heldFor });
    this.expireLater();
    this.report(before);
  }

  /** The threads held now; with `expired`, also those whose word has run out but not yet gone. */
  threads(expired = false): Set<string> {
    const now = Date.now();
    const all = new Set<string>();
    for (const { threads, until } of this.byMac.values()) {
      if (expired || until > now) for (const thread of threads) all.add(thread);
    }
    return all;
  }

  close(): void {
    clearTimeout(this.timer);
  }

  /** Lets go of the words that have run out when the next one does, and says what went. */
  private expireLater(): void {
    clearTimeout(this.timer);
    const next = Math.min(...[...this.byMac.values()].map(({ until }) => until));
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => {
      const before = this.threads(true);
      const now = Date.now();
      for (const [mac, { until }] of this.byMac) if (until <= now) this.byMac.delete(mac);
      this.expireLater();
      this.report(before);
    }, Math.max(next - Date.now(), 0) + 5);
    this.timer.unref();
  }

  private report(before: Set<string>): void {
    const after = this.threads();
    const moved = new Set([...before].filter((thread) => !after.has(thread)));
    for (const thread of after) if (!before.has(thread)) moved.add(thread);
    if (moved.size > 0) this.changed(moved);
  }
}

/** What a thread here was started from on another Mac: that Mac's stable id and the thread's id there. */
export interface StartedElsewhere {
  machine: string;
  thread: string;
}

/** How a Mac took being told: it holds them, its bridge is from before (`threads.held` unknown), or it is not a Mac of the net. */
export type Told = "told" | "older" | "gone";

/**
 * Tells each Mac of the net which of its threads threads here keep at work (`threads.held`):
 * the threads here at work, waiting, or kept at work by threads they started
 * (`SessionManager.activity`), each one's starter on that Mac. Said when the set changes,
 * and again every `tellEveryMs` while it is not empty, so that it holds there. A Mac not
 * reached is asked again at the next change or renewal; one whose set is empty now is told
 * once, its word there running out by itself if that does not reach it. A Mac whose
 * bridge is from before is not asked for `olderForMs`.
 */
export class TellStarters {
  private readonly options: {
    activity: () => { session_id: string }[];
    startedFrom: (thread: string) => StartedElsewhere | undefined;
    tell: (machine: string, threads: string[]) => Promise<Told>;
  };
  /** What each Mac was last told and took, as sorted ids. */
  private readonly told = new Map<string, string>();
  private readonly sending = new Set<string>();
  private readonly again = new Set<string>();
  private readonly older = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;
  private scheduled = false;
  private closed = false;

  constructor(options: {
    activity: () => { session_id: string }[];
    startedFrom: (thread: string) => StartedElsewhere | undefined;
    tell: (machine: string, threads: string[]) => Promise<Told>;
    every?: number;
  }) {
    this.options = options;
    this.timer = setInterval(() => this.send(true), options.every ?? tellEveryMs);
    this.timer.unref();
  }

  /** Something here moved: each Mac whose set changed is told, once what moved together has. */
  update(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.send(false);
    }, 0).unref();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  /** By Mac, the threads there that threads here keep at work now. */
  private sets(): Map<string, string[]> {
    const sets = new Map<string, Set<string>>();
    for (const { session_id } of this.options.activity()) {
      const from = this.options.startedFrom(session_id);
      if (!from) continue;
      const set = sets.get(from.machine) ?? new Set<string>();
      set.add(from.thread);
      sets.set(from.machine, set);
    }
    return new Map([...sets].map(([machine, set]) => [machine, [...set].sort()]));
  }

  private send(renew: boolean): void {
    if (this.closed) return;
    const now = this.sets();
    for (const machine of new Set([...now.keys(), ...this.told.keys(), ...this.sending])) {
      // A call to it on its way: looked at again once it is answered, against what it then
      // took (Codex's review of 01c6a8cc: a set emptied meanwhile was never told).
      if (this.sending.has(machine)) {
        this.again.add(machine);
        continue;
      }
      const threads = now.get(machine) ?? [];
      const key = JSON.stringify(threads);
      const last = this.told.get(machine);
      if (threads.length === 0 ? last === undefined : key === last && !renew) continue;
      void this.tell(machine, threads, key);
    }
  }

  private async tell(machine: string, threads: string[], key: string): Promise<void> {
    if ((this.older.get(machine) ?? 0) > Date.now()) return;
    if (this.sending.has(machine)) {
      this.again.add(machine);
      return;
    }
    this.sending.add(machine);
    try {
      const answer = await this.options.tell(machine, threads);
      if (answer === "older") this.older.set(machine, Date.now() + olderForMs);
      if (answer !== "told" || threads.length === 0) this.told.delete(machine);
      else this.told.set(machine, key);
    } catch {
      // Not reached: a set is asked again at the next change or renewal (what was told
      // last is kept); an empty one is not, its word there running out by itself.
      if (threads.length === 0) this.told.delete(machine);
    } finally {
      this.sending.delete(machine);
      if (this.again.delete(machine)) this.update();
    }
  }
}
