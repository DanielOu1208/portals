import { rmSync } from "node:fs";
import { join } from "node:path";
import type { StoredMessage, TurnUsage } from "../providers/types.ts";
import { readJSON, writeJSON } from "../store/jsonFile.ts";

// What each turn spent (feature `turn_usage`), kept by the bridge for an agent that keeps
// no tokens with its turns and has ids for them (Codex: its history has each turn's time,
// not its tokens): `state/spent/<thread>.json`, the latest `spentKept` turns, by the
// agent's own id for each (`latestTurn`). A thread loaded again, after a restart of the
// bridge too, shows them in their place (`turnEnd`). Agents whose own history has the
// tokens (Claude Code, Pi) need none of it.

/** One turn's, as kept. */
export interface KeptSpent extends TurnUsage {
  /** The agent's own id for the turn. */
  turn: string;
}

/** How many turns a thread keeps: the latest. */
export const spentKept = 200;

export class SpentStore {
  private readonly folder: string;

  /** `folder`: `state/spent`. */
  constructor(folder: string) {
    this.folder = folder;
  }

  /** What a thread keeps, oldest first; an entry that cannot be read costs only itself. */
  read(thread: string): KeptSpent[] {
    const stored = readJSON<unknown>(this.file(thread), []);
    if (!Array.isArray(stored)) return [];
    const kept: KeptSpent[] = [];
    for (const entry of stored as Partial<KeptSpent>[]) {
      if (typeof entry?.turn !== "string") continue;
      const one: KeptSpent = { turn: entry.turn };
      if (typeof entry.seconds === "number" && Number.isFinite(entry.seconds) && entry.seconds >= 0) one.seconds = entry.seconds;
      if (typeof entry.tokens === "number" && Number.isFinite(entry.tokens) && entry.tokens > 0) one.tokens = entry.tokens;
      if (one.seconds !== undefined || one.tokens !== undefined) kept.push(one);
    }
    return kept;
  }

  /** Keeps what turn `entry.turn` spent, in place of what was kept for it, as the latest. */
  keep(thread: string, entry: KeptSpent): void {
    const kept = [...this.read(thread).filter((one) => one.turn !== entry.turn), entry].slice(-spentKept);
    writeJSON(this.file(thread), kept);
  }

  /** Lets go of what a thread kept: it was removed. */
  forget(thread: string): void {
    rmSync(this.file(thread), { force: true });
  }

  private file(thread: string): string {
    return join(this.folder, `${encodeURIComponent(thread)}.json`);
  }
}

/**
 * The stored conversation with what each kept turn spent on its last message, where the
 * agent's history has the turn (`turnEnd`: how many of `history`'s messages come up to
 * its end). What the history says already stays; what it lacks is filled in.
 */
export function withSpent(history: StoredMessage[], kept: readonly KeptSpent[], turnEnd?: (id: string) => number | undefined): StoredMessage[] {
  if (kept.length === 0 || !turnEnd) return history;
  for (const { turn, ...spent } of kept) {
    const end = turnEnd(turn);
    if (end === undefined || end < 1 || end > history.length) continue;
    const last = history[end - 1];
    last.turn_usage = { ...spent, ...last.turn_usage };
  }
  return history;
}
