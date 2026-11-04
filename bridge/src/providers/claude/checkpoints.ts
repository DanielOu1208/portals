import { isDeepStrictEqual } from "node:util";
import { log } from "../../log.ts";
import { readJSON, writeJSON } from "../../store/jsonFile.ts";
import type { MessageCheckpoint } from "../types.ts";

/** Only UUIDs are kept: native history does not distinguish a bridge opener from a steer. */
interface TurnCheckpoint {
  session: string;
  opener: string;
  sent: string[];
  /** Last native chain UUID seen before the completed result, when the SDK exposed it. */
  after?: string;
}

type Entry = Record<string, any>;

/** A native input that starts work, rather than the answer to a tool or a local command. */
export function checkpointInput(raw: unknown): boolean {
  const entry = raw as Entry;
  if (!entry || entry.type !== "user" || entry.parent_tool_use_id) return false;
  const content = entry.message?.content;
  const blocks: Entry[] = Array.isArray(content) ? content : [];
  if (blocks.some((block) => block?.type === "tool_result")) return false;
  const text = typeof content === "string" ? content : blocks.map((block) => block?.type === "text" ? block.text : "").join("");
  const trimmed = text.trim();
  return !trimmed.startsWith("[Request interrupted by user") && !trimmed.startsWith("<local-command-") && !trimmed.startsWith("Caveat: The messages below were generated");
}

/** Exact bridge turn membership, retained independently of the native transcript. */
export class ClaudeCheckpoints {
  private readonly turns = new Map<string, Map<string, TurnCheckpoint>>();
  private readonly running = new Map<string, TurnCheckpoint>();
  private readonly path: string | undefined;
  constructor(path?: string) {
    this.path = path;
    if (!path) return;
    const data = readJSON<unknown>(path, [], (error) => {
      log.warn("could not read Claude message checkpoints", { error: error.message });
      return [];
    }, () => {
      log.warn("could not read Claude message checkpoints: invalid JSON");
      return [];
    });
    if (!Array.isArray(data)) return;
    for (const turn of data) {
      if (typeof turn?.session !== "string" || typeof turn.opener !== "string" || !Array.isArray(turn.sent) || turn.sent[0] !== turn.opener || !turn.sent.every((id: unknown) => typeof id === "string")) continue;
      this.keep(turn);
    }
  }

  sent(session: string, uuid: string, steering: boolean): void {
    if (!steering) this.running.set(session, { session, opener: uuid, sent: [uuid] });
    else this.running.get(session)?.sent.push(uuid);
  }

  /**
   * A message steered in that a Stop took back unread (`steer.withdrawn`): Claude Code
   * never writes it, so its turn's checkpoint no longer waits to see it. Its receipt may
   * come after the turn ended.
   */
  withdrawn(session: string, uuid: string): void {
    const running = this.running.get(session);
    if (running && running.opener !== uuid && running.sent.includes(uuid)) {
      running.sent = running.sent.filter((id) => id !== uuid);
      return;
    }
    const turn = [...(this.turns.get(session)?.values() ?? [])].find((entry) => entry.opener !== uuid && entry.sent.includes(uuid));
    if (!turn) return;
    turn.sent = turn.sent.filter((id) => id !== uuid);
    try {
      this.save();
    } catch (error) {
      log.warn("could not save Claude message checkpoints", { session, error: (error as Error).message });
    }
  }

  observed(session: string, raw: unknown): void {
    const entry = raw as Entry;
    const turn = this.running.get(session);
    if (turn && entry && !entry.parent_tool_use_id && (entry.type === "assistant" || entry.type === "user") && typeof entry.uuid === "string") turn.after = entry.uuid;
  }

  /** A completed native tool-result tail is not mistaken for an interrupted turn. */
  completedAtEnd(session: string, messages: readonly unknown[]): boolean {
    const last = messages.findLast((raw) => !(raw as Entry)?.parent_tool_use_id) as Entry | undefined;
    if (!last) return false;
    const boundaries = this.boundaries(session, messages);
    for (const turn of this.turns.get(session)?.values() ?? []) if (turn.after === last.uuid && boundaries.get(turn.opener)?.canFork) return true;
    return false;
  }

  abandon(session: string): void { this.running.delete(session); }

  finish(session: string): MessageCheckpoint | undefined {
    const turn = this.running.get(session);
    this.running.delete(session);
    if (!turn) return;
    this.keep(turn);
    try {
      this.save();
    } catch (error) {
      this.turns.get(session)?.delete(turn.opener);
      throw error;
    }
    return { id: turn.opener, can_fork: turn.after !== undefined, can_edit: true };
  }

  /** A completed bridge turn, with its exact inclusive native tail resolved from history. */
  boundary(session: string, opener: string, messages: readonly unknown[]): { before: number; after: number; canFork: boolean } | undefined {
    return this.boundaries(session, messages).get(opener);
  }

  forSession(session: string, messages: readonly unknown[]): ReadonlyMap<string, MessageCheckpoint> {
    return new Map([...this.boundaries(session, messages)].map(([id, boundary]) => [id, { id, can_fork: boundary.canFork, can_edit: true }]));
  }

  /** One pass over this session's native chain, including its tool-result tails. */
  private boundaries(session: string, messages: readonly unknown[]): Map<string, { before: number; after: number; canFork: boolean }> {
    const out = new Map<string, { before: number; after: number; canFork: boolean }>();
    const turns = this.turns.get(session);
    if (!turns) return out;
    const bySent = new Map<string, TurnCheckpoint>();
    for (const turn of turns.values()) for (const uuid of turn.sent) bySent.set(uuid, turn);
    let current: { turn: TurnCheckpoint; before: number; after: number; seen: Set<string> } | null = null;
    let previous = -1;
    const close = () => {
      if (current && current.turn.sent.every((uuid) => current!.seen.has(uuid))) out.set(current.turn.opener, { before: current.before, after: current.after, canFork: current.turn.after !== undefined && current.turn.after === (messages[current.after] as Entry)?.uuid });
      current = null;
    };
    messages.forEach((raw, index) => {
      const entry = raw as Entry;
      if (!entry || entry.parent_tool_use_id) return;
      if (checkpointInput(entry)) {
        const turn = bySent.get(entry.uuid);
        if (turn !== current?.turn) {
          close();
          if (turn && turn.opener === entry.uuid) current = { turn, before: previous, after: index, seen: new Set() };
        }
        current?.seen.add(entry.uuid);
      }
      if (typeof entry.uuid === "string") {
        previous = index;
        if (current) current.after = index;
      }
    });
    close();
    return out;
  }

  /** The SDK remaps UUIDs. Transfer membership only after checking the whole copied prefix. */
  copied(session: string, fork: string, prefix: readonly unknown[], copied: readonly unknown[]): void {
    const from = prefix as readonly Entry[];
    const to = copied as readonly Entry[];
    if (from.length !== to.length || !from.every((entry, index) => entry?.type === to[index]?.type && entry.parent_tool_use_id === to[index].parent_tool_use_id && entry.parent_agent_id === to[index].parent_agent_id && isDeepStrictEqual(entry.message, to[index].message) && typeof entry.uuid === "string" && typeof to[index].uuid === "string")) return;
    const ids = new Map(from.map((entry, index) => [entry.uuid, to[index].uuid]));
    if (ids.size !== from.length || new Set(ids.values()).size !== to.length) return;
    for (const turn of [...(this.turns.get(session)?.values() ?? [])]) {
      if (turn.session !== session || !turn.sent.every((uuid) => ids.has(uuid))) continue;
      const mapped = { session: fork, opener: ids.get(turn.opener)!, sent: turn.sent.map((uuid) => ids.get(uuid)!), ...(turn.after && ids.has(turn.after) ? { after: ids.get(turn.after)! } : {}) };
      this.keep(mapped);
    }
    try {
      this.save();
    } catch (error) {
      this.turns.delete(fork);
      throw error;
    }
  }

  private keep(turn: TurnCheckpoint): void {
    let turns = this.turns.get(turn.session);
    if (!turns) this.turns.set(turn.session, turns = new Map());
    turns.set(turn.opener, turn);
  }

  private save(): void {
    if (this.path) writeJSON(this.path, [...this.turns.values()].flatMap((turns) => [...turns.values()]));
  }
}
