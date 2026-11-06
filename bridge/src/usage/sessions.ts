import { join } from "node:path";
import { log } from "../log.ts";
import { readBackedUp, writeJSON } from "../store/jsonFile.ts";
import type { ViaResolver } from "./book.ts";
import type { UsageAgent } from "./types.ts";

// The sessions Portals ran (docs/plans/2026-11-06-token-analytics.md, "Through Portals or
// elsewhere"): `state/usage/sessions.json`, every agent session the host has run as
// `"<agent>:<session id>"`, with `since`, the moment from which its requests count as
// Portals'. The agents' own files do not say who ran them (Codex's do, and its
// originator wins: book.ts), so the host keeps its own record.
//
// Seeded once, from the threads the registry has and those it took off the list, each
// from its `createdAt` (for a session taken up from the desk, that is when it was taken
// up, so what was said at the desk before stays the desk's). Then a session is added when
// a thread starts, is forked, comes back, or is taken up, and when a turn starts in one
// not noted yet (a session only read and then continued). Nothing is taken out when a
// thread is deleted: its requests went through Portals all the same.
//
// The book asks `via` for every request it counts, about a quarter of a million on a
// first read of a year of history, so it is one map lookup.

/** The agents whose sessions may be read (types.ts `UsageAgent`), by the kind Portals gives them. */
const usageAgents: ReadonlySet<string> = new Set<UsageAgent>(["claude", "codex", "pi", "droid", "cursor", "hermes", "opencode"]);

/** An agent's kind (`AgentProfile.kind`) as a `UsageAgent`; undefined for one whose usage is never read (the scripted agent). */
export function usageAgent(kind: string | undefined): UsageAgent | undefined {
  return kind !== undefined && usageAgents.has(kind) ? (kind as UsageAgent) : undefined;
}

/** A thread of the registry's, as far as the record of sessions needs it. */
export interface ThreadSeed {
  /** The thread's id: the agent's own session id for all but Droid (`SessionAlias`). */
  id: string;
  agent: UsageAgent;
  /** Unix seconds: when the thread was made, or taken up from the desk. */
  createdAt: number;
  /** A desk session taken up only for reading: Portals sent nothing to it. */
  readOnly?: boolean;
}

/**
 * Agent sessions a thread goes on in that are not its own id: a Droid thread's sessions
 * (its first, the one after each /compact, Spec's planning one), from the host's own
 * record of them (providers/droid/store.ts). They count from the thread's `since`.
 */
export interface SessionAlias {
  agent: UsageAgent;
  thread: string;
  sessions: string[];
}

interface Saved {
  v: 1;
  sessions: Record<string, number>;
}

export interface PortalsSessionsOptions {
  /** `state/usage`. */
  folder: string;
  clock?: () => number;
  /** Where the sessions a thread goes on in under other ids are found (Droid's); read at start and as each turn ends. */
  aliases?: () => SessionAlias[];
}

export class PortalsSessions {
  readonly path: string;
  private readonly clock: () => number;
  private readonly aliases: (() => SessionAlias[]) | undefined;
  private readonly since = new Map<string, number>();
  /** A file that could not be used is kept aside under this name at the next save. */
  private aside: string | undefined;
  /** Whether sessions.json was there to read: seeding happens only when it was not. */
  private found = false;

  constructor(options: PortalsSessionsOptions) {
    this.path = join(options.folder, "sessions.json");
    this.clock = options.clock ?? Date.now;
    this.aliases = options.aliases;
    let read: ReturnType<typeof readBackedUp> = {};
    try {
      read = readBackedUp(this.path);
    } catch (error) {
      log.warn("usage: the record of Portals' sessions could not be read; it is made again from the threads", { why: (error as Error).message });
    }
    this.aside = read.aside;
    const saved = read.found as Partial<Saved> | undefined;
    if (saved && typeof saved.sessions === "object" && saved.sessions !== null) {
      this.found = true;
      for (const [key, value] of Object.entries(saved.sessions)) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) this.since.set(key, value);
      }
    }
  }

  /** How many sessions are recorded. */
  get size(): number {
    return this.since.size;
  }

  /**
   * The first time only (no sessions.json yet): every thread on the list and taken off
   * it, from when each was made or taken up. Answers whether it seeded.
   */
  seed(threads: Iterable<ThreadSeed>): boolean {
    if (this.found) return false;
    for (const thread of threads) this.add(thread.agent, thread.id, thread.createdAt * 1000, thread.readOnly);
    this.found = true;
    this.save();
    return true;
  }

  /** A thread on the list now (it started, was forked, came back or was taken up): its session counts from when it was made or taken up. */
  thread(thread: ThreadSeed): void {
    if (this.add(thread.agent, thread.id, thread.createdAt * 1000, thread.readOnly)) this.save();
  }

  /** A turn starts in a thread: its session counts from now if it was not noted already (one only read until now). */
  turn(agent: UsageAgent, session: string): void {
    if (this.since.has(key(agent, session))) return;
    if (this.add(agent, session, this.clock())) this.save();
  }

  /** `session` counts as Portals' from `since` (ms); an earlier `since` noted before stays. Answers whether it changed. */
  note(agent: UsageAgent, session: string, since: number): boolean {
    const changed = this.add(agent, session, since);
    if (changed) this.save();
    return changed;
  }

  /** The sessions threads go on in under other ids (`aliases`), each from its thread's `since`. Never throws. */
  refresh(): void {
    if (!this.aliases) return;
    let changed = false;
    try {
      for (const alias of this.aliases()) {
        const since = this.since.get(key(alias.agent, alias.thread));
        if (since === undefined) continue;
        for (const session of alias.sessions) if (this.add(alias.agent, session, since)) changed = true;
      }
    } catch (error) {
      log.warn("usage: the sessions of the host's threads could not be read", { why: (error as Error).message });
    }
    if (changed) this.save();
  }

  /** From when `session` counts as Portals'; undefined when Portals never ran it. */
  sinceOf(agent: UsageAgent, session: string): number | undefined {
    return this.since.get(key(agent, session));
  }

  /** For the book: Portals' from the session's `since` on; Codex's Portals originators the book sees to itself. */
  readonly via: ViaResolver = (agent, session, at) => {
    const since = this.since.get(key(agent, session));
    return since !== undefined && at >= since ? "portals" : "elsewhere";
  };

  private add(agent: UsageAgent, session: string, since: number, readOnly?: boolean): boolean {
    if (readOnly || session === "" || !Number.isFinite(since)) return false;
    const name = key(agent, session);
    const was = this.since.get(name);
    if (was !== undefined && was <= since) return false;
    this.since.set(name, Math.max(0, since));
    return true;
  }

  /** Written whole: a few hundred sessions, a write when a thread is added. A save that fails is tried with the next one. */
  private save(): void {
    const saved: Saved = { v: 1, sessions: Object.fromEntries(this.since) };
    try {
      writeJSON(this.path, saved, this.aside === undefined ? { backup: true } : { aside: this.aside });
      this.aside = undefined;
    } catch (error) {
      log.warn("usage: the record of Portals' sessions could not be saved; it is tried again with the next change", { why: (error as Error).message });
    }
  }
}

function key(agent: UsageAgent, session: string): string {
  return `${agent}:${session}`;
}
