import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { readBackedUp, writeJSON } from "../../store/jsonFile.ts";
import { threadModes, type ContextUsage, type SessionSettings, type StoredMessage, type SubagentInfo, type ThreadMode } from "../types.ts";
import type { DroidPolicy } from "./models.ts";

/** What a turn spent (feature turn_usage), on its last message (its user's at least): Droid's own history does not say it to the bridge. */
const spentSchema = z.object({ seconds: z.number().optional(), tokens: z.number().optional() }).optional();
const messageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), text: z.string(), timestamp: z.number(), turn_usage: spentSchema,
    display_kind: z.string().optional() }),
  z.object({ role: z.literal("assistant"), text: z.string(), timestamp: z.number(), reasoning: z.string().optional(),
    display_kind: z.literal("failed_turn").optional(), display_metadata: z.object({ interrupted: z.boolean().optional() }).optional(), turn_usage: spentSchema }),
  z.object({ role: z.literal("tool"), name: z.string(), args: z.record(z.string(), z.unknown()), tool_call_id: z.string(),
    timestamp: z.number(), content: z.string().optional(), context: z.string().optional(), turn_usage: spentSchema }),
  z.object({ role: z.literal("compaction"), trigger: z.enum(["manual", "auto"]), tokens_before: z.number().optional(), timestamp: z.number(), turn_usage: spentSchema }),
]);
const policySchema = z.object({ autonomyLevel: z.enum(["off", "low", "medium", "high"]), interactionMode: z.enum(["auto", "spec"]) });
const subagentSchema = z.object({
  id: z.string(), kind: z.literal("agent"), goal: z.string(), role: z.string().optional(), parent: z.string().optional(), run: z.string().optional(),
  status: z.enum(["running", "completed", "failed", "stopped"]), startedAt: z.number(), endedAt: z.number().optional(),
  background: z.boolean(), stoppable: z.literal(false), summary: z.string().optional(), tool: z.string().optional(),
  result: z.string().optional(), tokens: z.number().optional(), toolUses: z.number().optional(),
});
const threadSchema = z.object({
  version: z.literal(1), id: z.string(), session: z.string().min(1), cwd: z.string(),
  // A Spec model saved before 2026-10-23 (specModel, specReasoningEffort) is dropped as the
  // thread is read: Spec mode plans with the thread's own model and effort since then.
  settings: z.object({ model: z.string(), provider: z.string(), reasoningEffort: z.string() }),
  defaults: policySchema, defaultModel: z.string(), defaultEffort: z.string(),
  mode: z.enum(threadModes), beforePlan: z.enum(threadModes), open: z.boolean(),
  messages: z.array(messageSchema),
  nativeToolIds: z.record(z.string(), z.string()).optional(),
  subagents: z.array(subagentSchema).optional(),
  sessionTokens: z.number().finite().nonnegative().optional(),
  liveSessionTokens: z.number().finite().nonnegative().optional(),
  sessionCredits: z.number().finite().nonnegative().optional(),
  queueReceipts: z.array(z.string()).optional(),
  previousSession: z.string().optional(),
  formerSessions: z.array(z.string()).optional(),
  contextUsage: z.object({ used: z.number().finite().nonnegative(), max: z.number().finite().positive(), estimated: z.boolean().optional() }).optional(),
  staleCall: z.string().optional(),
  deskSource: z.boolean().optional(),
  deskReadOnly: z.boolean().optional(),
  deskReadCwd: z.string().optional(),
});

export interface DroidThread {
  version: 1;
  id: string;
  session: string;
  cwd: string;
  settings: SessionSettings;
  defaults: DroidPolicy;
  defaultModel: string;
  defaultEffort: string;
  mode: ThreadMode;
  beforePlan: ThreadMode;
  open: boolean;
  messages: StoredMessage[];
  /** Remapped background display id to native tool id, retained across cold forks. */
  nativeToolIds?: Record<string, string>;
  subagents?: SubagentInfo[];
  /** Observed cumulative cost usage, which can include delegated work. */
  sessionTokens?: number;
  /** SDK live cumulative parent-only tokens. Never subtract the cost total from this. */
  liveSessionTokens?: number;
  sessionCredits?: number;
  /** Consumption acknowledgements, saved before the bridge removes a queued message. */
  queueReceipts?: string[];
  previousSession?: string;
  /**
   * Every Droid session the thread went on from before its current one (Spec's planning
   * session, the one before each /compact), oldest first: Droid keeps their files, which
   * are the thread's, not sessions of the desk's (`DroidProvider.deskSessions`).
   */
  formerSessions?: string[];
  contextUsage?: ContextUsage;
  /**
   * The last call Droid had reported (its three figures) when the conversation was
   * compacted, which Droid keeps as the session's last and loads with it: not what the
   * conversation takes now, until Droid's next call (`DroidSession.open`).
   */
  staleCall?: string;
  /** A desk original: check another app has not opened it before a cold resume. */
  deskSource?: boolean;
  /** A file snapshot not yet continued here; refresh it before taking ownership. */
  deskReadOnly?: boolean;
  /** The folder first read, unchanged by file-only refreshes; Continue must not move the registry. */
  deskReadCwd?: string;
}

/**
 * The sessions a thread has gone on in so far, its current one last: the former sessions
 * of the one it goes on in next (`DroidThread.formerSessions`). The latest 256.
 */
export function sessionsSoFar(thread: DroidThread): string[] {
  // A thread saved before it kept the list has its previous session only.
  const sessions = [...thread.formerSessions ?? [], ...thread.previousSession ? [thread.previousSession] : [], thread.session];
  return sessions.filter((id, index) => sessions.lastIndexOf(id) === index).slice(-256);
}

/** Which Droid sessions a thread has (`DroidStore.mappings`). */
export type DroidMapping = Pick<DroidThread, "id" | "session" | "previousSession" | "formerSessions">;

function mappingOf(thread: DroidThread): DroidMapping {
  return { id: thread.id, session: thread.session, previousSession: thread.previousSession, formerSessions: thread.formerSessions };
}

// A thread's file is the only copy of what the thread showed and of which Droid session
// it goes on in, rewritten at each save, mid-turn too. Each save keeps the file it
// replaces as `<file>.bak` (store/jsonFile.ts): nothing waits for a save to be on the
// disk, so a power cut can leave the file empty, and the thread then comes back from the
// save before, as threads.json does. The file that could not be used keeps its name
// until the next save puts it aside (`<file>.corrupt-<time>-<id>`), rather than making
// it the backup; with neither usable, both stay as they are and the thread cannot be read.
export class DroidStore {
  private readonly directory: string;
  /** For a thread read from its backup: where its next save keeps the file that could not be used. */
  private readonly asides = new Map<string, string>();
  /**
   * What `mappings` found in each thread file, by its name, while the file has the size and
   * time it had then: a thread's file holds its whole conversation, which is not read again
   * for each desk list. A save puts what it saved here.
   */
  private readonly mapped = new Map<string, { size: number; changed: number; mapping: DroidMapping | null }>();
  constructor(directory: string) { this.directory = directory; }

  private path(id: string): string {
    return join(this.directory, "threads", `${createHash("sha256").update(id).digest("hex")}.json`);
  }

  exists(id: string): boolean { return existsSync(this.path(id)); }

  /** Native ids belonging to Portals threads must not reappear as separate desk sessions. */
  mappings(): DroidMapping[] {
    let names: string[];
    try { names = readdirSync(join(this.directory, "threads")); } catch { return []; }
    const there = new Set(names);
    for (const name of this.mapped.keys()) if (!there.has(name)) this.mapped.delete(name);
    return names.filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).flatMap((file) => {
      const path = join(this.directory, "threads", file);
      let size: number, changed: number;
      try { ({ size, mtimeMs: changed } = statSync(path)); } catch { return []; }
      const known = this.mapped.get(file);
      if (known?.size === size && known.changed === changed) return known.mapping ? [known.mapping] : [];
      let mapping: DroidMapping | null = null;
      try {
        const parsed = threadSchema.safeParse(readBackedUp(path).found ?? null);
        if (parsed.success) mapping = mappingOf(parsed.data as DroidThread);
      } catch { /* Not a thread, as before: read again once it changes. */ }
      this.mapped.set(file, { size, changed, mapping });
      return mapping ? [mapping] : [];
    });
  }

  /** The thread's file, for search (feature thread_search); null when there is none. */
  file(id: string): string | null { return existsSync(this.path(id)) ? this.path(id) : null; }

  read(id: string): DroidThread {
    const read = readBackedUp(this.path(id));
    if (read.aside) this.asides.set(id, read.aside);
    const parsed = threadSchema.safeParse(read.found ?? null);
    if (!parsed.success || parsed.data.id !== id) {
      throw new Error("Droid's stored conversation mapping is missing or unreadable. It was not replaced with a new session.");
    }
    return parsed.data as DroidThread;
  }

  write(thread: DroidThread): void {
    const aside = this.asides.get(thread.id);
    const path = this.path(thread.id);
    writeJSON(path, thread, aside === undefined ? { backup: true } : { aside });
    this.asides.delete(thread.id);
    try {
      const { size, mtimeMs } = statSync(path);
      this.mapped.set(basename(path), { size, changed: mtimeMs, mapping: mappingOf(thread) });
    } catch { this.mapped.delete(basename(path)); }
  }
}
