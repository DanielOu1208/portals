import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { ThreadMode } from "../providers/types.ts";
import type { From } from "../fleet/line.ts";
import { counters } from "../counters.ts";
import { log } from "../log.ts";
import { readStateFile, writeBytes, writeJSON } from "../store/jsonFile.ts";

// The threads the bridge knows, in `state/threads.json`. A thread's id is its agent's
// own session id, the same as the app's stored id, and `session.resume` finds the
// thread by it for as long as the thread is listed here.
//
// It is also the list every device shows (feature thread_sync, docs/sync-plan.md). The
// file keeps the list's id and its revision, a whole number that goes up by one with
// every change a listing shows, and each record keeps the revision it last changed at:
// a device that holds the list as of one revision asks for what changed since. A bridge
// from before the list keeps the records' keys but drops the list's id and revision when
// it saves; the next start then makes a new list, which every device takes whole.
//
// A thread taken off the list (`thread.delete`) goes to `state/removed.json`, with the
// revision it was removed at, and stays there, for good, until the same thread is taken
// up again. It tells a device which threads to forget, and lets the desk's list offer the
// agent's removed threads again. A file of its own, written only by a removal or a taking
// up: a bridge from before it never rewrites it, and the frequent saves of threads.json
// do not carry it. It is written before threads.json when a thread is removed and after
// it when one is taken up, so an id found in both when loading is still on the list.
//
// Every change is saved at once, as the whole file. What a save costs is kept small by
// keeping each record's part of the file as it was last written (`texts`): a save makes
// text of the records that changed and copies the rest, and the file is the same, byte
// for byte, as one made of all of them anew.
//
// Each save keeps the file it replaces as `<file>.bak` (store/jsonFile.ts): nothing waits
// for a save to be on the disk, so a power cut can leave a file empty. A file that is
// there and cannot be used (it cannot be read, is not JSON, or holds no object) is kept
// aside when the registry starts, as `<file>.corrupt-<time>-<id>`, with an error in the log,
// and the registry goes on with its `.bak` in its place, saved at once. That is a save
// behind, older than what a device may hold already: the list from threads.json.bak is
// a new list, as for a file with no list, so every device takes it whole, where carrying
// on with its id and revision would stamp changes at revisions a device had passed. The
// threads taken off the list from removed.json.bak keep the list: removed.json holds no
// revision of the list's, nothing is stamped again, and what it can lack is the last
// removal, which a new list would not bring back either (a device that missed it would
// keep that thread as its own). The file that cannot be used keeps its name until that
// save has put the new one there, which keeps no `.bak` (it would be that file): a save
// that fails, or a stop before, leaves both as they were, and the next start takes the
// `.bak` again, where a file missing would be a new list, put over the `.bak` by the save
// after. With no `.bak`, or one that cannot be used either (moved aside too), the
// registry goes on without them: for threads.json a new, empty list, which every device
// then takes. A file kept aside is there only so that it is not written over, and can be
// put back by hand with the bridge stopped.

/** Who started a thread through the fleet: in a few words, and that thread's id when it is one of this bridge's. */
export interface StartedBy {
  name: string;
  thread?: string;
  /**
   * For a thread a linked Mac's thread started (feature agent_threads): that Mac's name
   * for itself and its thread's id there, `mbp16/6d3c…`, which only the same thread
   * gives again when it answers this one's questions (`thread.answer`). Never listed.
   */
  origin?: string;
  /**
   * Who started it, as facts (fleet/line.ts, feature `senders`): listed, so that a device
   * can put it under the thread that started it, on this Mac or another (`machine`). A
   * thread started on another Mac is answered only by that Mac's same thread.
   */
  from?: From;
}

export interface ThreadRecord {
  id: string;
  /** The profile name of the agent that runs it. */
  agent: string;
  cwd: string;
  title: string | null;
  model: string;
  provider: string;
  reasoningEffort: string;
  /** Unix seconds. */
  createdAt: number;
  /** When a turn last started or ended: the thread's place in every list. */
  updatedAt: number;
  /** Started from the phone, or adopted from a session started at the desk (`session.adopt`). */
  origin: "phone" | "desk";
  /** Set with `/mode`, for agents that have modes; absent is `default`. */
  mode?: ThreadMode;
  /** The mode the thread had when it last went into plan mode: an approved plan goes back to it. */
  modeBeforePlan?: ThreadMode;
  /**
   * Back in `default` from another mode since the thread's last turn began: the agent may
   * still have that mode's policy for the thread, which its next turn undoes (Codex), also
   * after a restart of the bridge. Absent is false.
   */
  modeReset?: boolean;
  /** A desk session taken up only for reading: nothing is sent to it. Absent is false. */
  readOnly?: boolean;
  /** Its agent's one ongoing conversation (`Provider.ongoingThread`): never removed nor renamed. Absent is false. */
  ongoing?: boolean;
  /** Kept at the top of every device's list. Absent is false. */
  pinned?: boolean;
  /** Put away on every device, until taken back out or a turn starts or ends in it. Absent is false. */
  archived?: boolean;
  /** A turn ended and no device has shown the thread since. Absent is false. */
  unseen?: boolean;
  /** The first line of the last message sent into the thread, for the list (sessions/preview.ts). */
  preview?: string;
  /** For a thread started through the fleet (`thread.start`, the `portals` command): who started it. */
  startedBy?: StartedBy;
  /**
   * A thread an agent started that a person put in the sidebar on every device (feature
   * agent_threads), where the app otherwise lists it only under the thread that started
   * it. Absent is false.
   */
  shared?: boolean;
  /**
   * In Recent on every device (feature recent_threads): a person opened it or wrote in it
   * on some device, and since then no device has dismissed it or let it go past what they
   * keep, and it was not archived. Absent is false.
   */
  recent?: boolean;
  /** The git branch checked out in its folder as a turn last started or ended (feature thread_branch); absent outside a repository. */
  branch?: string;
  /**
   * For a thread whose folder is in a git worktree: the main checkout's folder it is
   * listed under (feature worktrees, src/git.ts `threadRepo`), kept once the worktree is
   * gone. Absent for any other.
   */
  repo?: string;
  /** The list's revision when a key a listing shows last changed. */
  revision?: number;
  /** The list's revision when a turn last started or ended: a seen sent before it does not clear what the turn did. */
  turnRevision?: number;
  /**
   * The list's revision when the thread's latest turn began (or ended, for an end with no
   * start recorded): which turn that is, for a seen that names the turn it is of (`turn`
   * in `thread.mark`), so a seen of an earlier turn never clears a later one.
   */
  turnStarted?: number;
  /** A turn's start was recorded and its end not yet: a turn found running when the thread is loaded again is that one. Absent is false. */
  inTurn?: boolean;
  /**
   * The latest subagents and workflows that left the line as a message went to the agent
   * (feature subagents_clear), each with the run it had come to (`SubagentInfo.run`) where
   * its agent says: off it after a restart too, while it is that run, ended.
   */
  subagentsCleared?: { id: string; run?: string }[];
  /**
   * How the latest questions asked without waiting were settled on their card (feature
   * async_questions, sessions/answers.ts `CardAnswer`), which the agent's history does not
   * say: after a restart too their row shows the answers given and no message of its own
   * for them, and a card skipped or taken back is not put again.
   */
  cardAnswers?: { id: string; answers?: string[]; said?: string }[];
}

/** What `set` and `update` change. A key given as `undefined` or `false` is taken away. */
export type ThreadChanges = Partial<Omit<ThreadRecord, "id" | "revision" | "turnRevision" | "turnStarted">>;

/** The keys a listing shows: changing one moves the list's revision. The model, level, mode and origin are not among them. */
const listedKeys = new Set<string>(["agent", "cwd", "title", "createdAt", "updatedAt", "readOnly", "ongoing", "pinned", "archived", "unseen", "preview", "startedBy", "shared", "recent", "branch", "repo"]);

/** What a stored thread id may look like; push registration uses the same rule. */
export const threadIDPattern = /^[A-Za-z0-9_.:-]{1,200}$/;

/** A thread taken off the list, as removed.json keeps it: its record as it was, and the list's revision when it was removed. */
interface Removed {
  revision: number;
  thread: ThreadRecord;
}

export class Registry {
  private readonly path: string;
  private readonly removedPath: string;
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly removed = new Map<string, Removed>();
  /** The list's id. A device that holds another list's revisions takes this one whole. */
  readonly list: string;
  private current: number;
  /**
   * A record's part of threads.json, as bytes, for as long as the record is what it was
   * when they were made. A record on the list is changed only in `saving`, and one not on
   * it yet is taken by `add`: both let go of its bytes first.
   */
  private readonly texts = new WeakMap<ThreadRecord, Buffer>();
  /**
   * Told after each change that moves the list's revision, once threads.json has it: a
   * device that asked is told to poll (feature poll_now). Never for a change that could
   * not be saved, nor for one no listing shows.
   */
  moved: () => void = () => {};
  /**
   * Told of each thread put on the list (a new one, a fork, one taken up or back), once
   * threads.json has it: the record of the sessions Portals ran (usage/sessions.ts).
   */
  added: (record: ThreadRecord) => void = () => {};

  /** `removedPath`: the threads taken off the list; `removed.json` beside `path` when not given. */
  constructor(path: string, removedPath = join(dirname(path), "removed.json")) {
    this.path = path;
    this.removedPath = removedPath;
    const threadsFile = readStateFile(path);
    const stored: { list?: unknown; revision?: unknown; threads?: ThreadRecord[] } = threadsFile.found;
    for (const record of Array.isArray(stored.threads) ? stored.threads : []) {
      if (isRecord(record)) this.threads.set(record.id, record);
    }
    const removedFile = readStateFile(removedPath);
    const gone: { threads?: Removed[] } = removedFile.found;
    let unfinished = false;
    for (const entry of Array.isArray(gone.threads) ? gone.threads : []) {
      if (!entry || !isRecord(entry.thread) || stamp(entry.revision) === 0) continue;
      // Still on the list: its removal stopped before threads.json was saved, or it was
      // taken up again and the bridge stopped before removed.json was.
      if (this.threads.has(entry.thread.id)) unfinished = true;
      else this.removed.set(entry.thread.id, entry);
    }
    if (!threadsFile.fromBackup && typeof stored.list === "string" && stored.list !== "" && Number.isSafeInteger(stored.revision) && (stored.revision as number) >= 0) {
      this.list = stored.list;
      this.current = stored.revision as number;
    } else {
      // A new list, saved at once (also for threads.json.bak: see the top of this file). Its
      // revision starts above every stamp in the files, so a record stamped or removed
      // under a list before it never counts as changed in this one.
      this.list = randomBytes(8).toString("hex");
      const highest = Math.max(
        this.all().reduce((most, record) => Math.max(most, stamp(record.revision), stamp(record.turnRevision), stamp(record.turnStarted)), 0),
        [...this.removed.values()].reduce((most, entry) => Math.max(most, entry.revision), 0),
      );
      this.current = highest + 1;
      this.save(threadsFile.aside);
    }
    // One from removed.json.bak too: removed.json is written only at a removal or a taking up.
    if (unfinished || removedFile.fromBackup) this.saveRemoved(removedFile.aside);
  }

  /** The list's revision now. */
  get revision(): number {
    return this.current;
  }

  get(id: string): ThreadRecord | undefined {
    return this.threads.get(id);
  }

  all(): ThreadRecord[] {
    return [...this.threads.values()];
  }

  /** How many threads are on the list, and how many were taken off it. */
  counts(): { threads: number; removed: number } {
    return { threads: this.threads.size, removed: this.removed.size };
  }

  /** The records changed since `revision` of this list. */
  changedSince(revision: number): ThreadRecord[] {
    const changed: ThreadRecord[] = [];
    for (const record of this.threads.values()) {
      if (stamp(record.revision) > revision) changed.push(record);
    }
    return changed;
  }

  /**
   * A thread for the list: a new one, or one taken up again, which leaves removed.json.
   * When threads.json cannot be written, nothing changes and this throws, as for every
   * change to the list.
   */
  add(record: ThreadRecord): void {
    const before = this.current;
    const turnBefore = record.turnRevision;
    const startedBefore = record.turnStarted;
    this.texts.delete(record);
    record.revision = ++this.current;
    // A turn that started or ended while the thread was being taken up counts from here,
    // so a seen from before it leaves what the turn did.
    if (record.inTurn || record.unseen) {
      record.turnRevision = record.revision;
      record.turnStarted = record.revision;
    }
    this.threads.set(record.id, record);
    try {
      this.save();
    } catch (error) {
      this.threads.delete(record.id);
      this.current = before;
      record.turnRevision = turnBefore;
      record.turnStarted = startedBefore;
      throw error;
    }
    if (counters.on) counters.thread("added");
    this.moved();
    try {
      this.added(record);
    } catch (error) {
      log.warn("a thread put on the list could not be noted", { thread: record.id, error: (error as Error).message });
    }
    // After threads.json: a stop in between, or a removed.json that cannot be written,
    // leaves it on the list, as it now is (an id in both is on the list).
    if (!this.removed.delete(record.id)) return;
    try {
      this.saveRemoved();
    } catch (error) {
      log.warn("removed.json could not be written; the thread taken up again is on the list all the same", { thread: record.id, error: (error as Error).message });
    }
  }

  /**
   * Takes a thread off the list, into removed.json with the revision it was removed at,
   * and returns its record. Nothing the agent keeps of it is touched.
   */
  remove(id: string): ThreadRecord | undefined {
    const record = this.threads.get(id);
    if (!record) return undefined;
    const before = this.current;
    const earlier = this.removed.get(id);
    const undo = () => {
      this.threads.set(id, record);
      if (earlier) this.removed.set(id, earlier);
      else this.removed.delete(id);
      this.current = before;
    };
    // A copy: whatever still holds the record (a session closing) changes nothing here.
    this.removed.set(id, { revision: ++this.current, thread: structuredClone(record) });
    // Before threads.json: a stop in between leaves it on the list, as if never removed.
    // When either file cannot be written, the thread stays on the list and this throws.
    try {
      this.saveRemoved();
    } catch (error) {
      undo();
      throw error;
    }
    this.threads.delete(id);
    try {
      this.save();
    } catch (error) {
      undo();
      try {
        this.saveRemoved();
      } catch {
        // An id in both files is on the list when the bridge next starts.
      }
      throw error;
    }
    if (counters.on) counters.thread("removed");
    this.moved();
    return record;
  }

  /** A thread taken off the list, as it was then. */
  removedRecord(id: string): ThreadRecord | undefined {
    const entry = this.removed.get(id);
    return entry ? structuredClone(entry.thread) : undefined;
  }

  /** Every thread taken off the list and not taken up again, as each was then. */
  allRemoved(): ThreadRecord[] {
    return [...this.removed.values()].map((entry) => structuredClone(entry.thread));
  }

  /** The ids of the threads taken off the list since `revision` of this list (all of them for 0). */
  removedSince(revision: number): string[] {
    return [...this.removed.values()].filter((entry) => entry.revision > revision).map((entry) => entry.thread.id);
  }

  has(id: string): boolean {
    return this.threads.has(id);
  }

  /**
   * A turn started or ended: `changes`, and the thread moves up every list. The only
   * write that moves `updatedAt`, so pinning, renaming or changing the model of a
   * thread leaves it where it is.
   */
  update(id: string, changes: ThreadChanges): void {
    const record = this.threads.get(id);
    if (!record) return;
    this.saving(record, () => {
      // A turn begins, or one ends that was never seen to begin (one run while the bridge
      // was down, told as it loads): another turn from here on.
      const another = changes.inTurn === true || (changes.inTurn === false && record.inTurn !== true);
      applyChanges(record, changes);
      record.updatedAt = Math.floor(Date.now() / 1000);
      record.revision = ++this.current;
      record.turnRevision = record.revision;
      if (another) record.turnStarted = record.revision;
    });
  }

  /** Changes only what is given. The list's revision moves when a listing shows any of it. */
  set(id: string, changes: ThreadChanges): void {
    const record = this.threads.get(id);
    if (!record) return;
    this.saving(record, () => {
      const changed = applyChanges(record, changes);
      if (changed.some((key) => listedKeys.has(key))) record.revision = ++this.current;
      return changed.length > 0;
    });
  }

  /**
   * `set` for several threads, saved once: threads.json is written whole at each save, so
   * a change to many threads at once (the repositories of their worktrees found as the
   * bridge starts) is one write, not one for each. All or none, as `set`.
   */
  setMany(changes: readonly (readonly [string, ThreadChanges])[]): void {
    const records = changes.flatMap(([id, change]) => {
      const record = this.threads.get(id);
      return record ? [[record, change] as const] : [];
    });
    if (records.length === 0) return;
    const before = records.map(([record]) => [record, structuredClone(record)] as const);
    const current = this.current;
    for (const [record] of records) this.texts.delete(record);
    let changedAny = false;
    for (const [record, change] of records) {
      const changed = applyChanges(record, change);
      if (changed.some((key) => listedKeys.has(key))) record.revision = ++this.current;
      if (changed.length > 0) changedAny = true;
    }
    if (!changedAny) return;
    try {
      this.save();
    } catch (error) {
      // In place, last first: a thread named twice is back as it was before the first.
      for (const [record, was] of before.toReversed()) {
        for (const key of Object.keys(record)) delete (record as unknown as Record<string, unknown>)[key];
        Object.assign(record, structuredClone(was));
        this.texts.delete(record);
      }
      this.current = current;
      throw error;
    }
    if (this.current !== current) this.moved();
  }

  /**
   * Makes `change` to `record` and saves it. When threads.json cannot be written, the
   * record and the list's revision are as they were and this throws: a change kept only
   * in memory would show on every device until a restart took it back, and the same
   * change asked for again would find nothing to save. `change` answers false when it
   * changed nothing, and then nothing is saved.
   */
  private saving(record: ThreadRecord, change: () => boolean | void): void {
    const before = structuredClone(record);
    const current = this.current;
    // Before the change, so a change that fails half way leaves no bytes of what the record was.
    this.texts.delete(record);
    if (change() === false) return;
    try {
      this.save();
    } catch (error) {
      // In place: a session holds the same record.
      for (const key of Object.keys(record)) delete (record as unknown as Record<string, unknown>)[key];
      Object.assign(record, before);
      // The save may have made bytes of the record as changed.
      this.texts.delete(record);
      this.current = current;
      throw error;
    }
    if (this.current !== current) this.moved();
  }

  /** `aside`: where the threads.json it replaces is kept, one that could not be used (`readStateFile`), in place of its `.bak`. */
  private save(aside?: string): void {
    writeBytes(this.path, () => this.bytes(), { backup: true, aside });
  }

  /**
   * threads.json as it is now: exactly what `JSON.stringify` of the list's id, its
   * revision and every record makes with an indent of one, and a line end. Text is made
   * only of the records that have no bytes kept.
   */
  private bytes(): Buffer {
    const head = { list: this.list, revision: this.current };
    if (this.threads.size === 0) return Buffer.from(JSON.stringify({ ...head, threads: [] }, null, 1) + "\n");
    // The head as it is with something after it: without its closing brace, and a comma.
    const parts: Buffer[] = [Buffer.from(`${JSON.stringify(head, null, 1).slice(0, -2)},\n "threads": [\n`)];
    for (const record of this.threads.values()) {
      let text = this.texts.get(record);
      if (!text) {
        // Two levels in: each of its lines starts two spaces further in. (A line end inside a value is written `\n`.)
        text = ownBytes(`  ${JSON.stringify(record, null, 1).replace(/\n/g, "\n  ")}`);
        this.texts.set(record, text);
      }
      if (parts.length > 1) parts.push(betweenRecords);
      parts.push(text);
    }
    parts.push(afterRecords);
    return Buffer.concat(parts);
  }

  /** `aside`: as for `save`. */
  private saveRemoved(aside?: string): void {
    writeJSON(this.removedPath, { threads: [...this.removed.values()] }, { backup: true, aside });
  }
}

/** What threads.json has between two records, and after the last. */
const betweenRecords = Buffer.from(",\n");
const afterRecords = Buffer.from("\n ]\n}\n");

/**
 * `text` as bytes in a block of their own. `Buffer.from` would cut a small text's bytes
 * from a block it shares with whatever else is made at that moment, and bytes kept for
 * as long as a record's are would keep that whole block: in time, one for each thread.
 */
function ownBytes(text: string): Buffer {
  const bytes = Buffer.allocUnsafeSlow(Buffer.byteLength(text));
  bytes.write(text);
  return bytes;
}

/** A stored record the registry can use: one with an id and an agent. */
function isRecord(value: unknown): value is ThreadRecord {
  const record = value as Partial<ThreadRecord> | null;
  return typeof record === "object" && record !== null && typeof record.id === "string" && typeof record.agent === "string";
}

/**
 * Writes `changes` into `record` and returns the keys whose value changed. Absent,
 * `undefined` and `false` are the same. For a record not added yet, the changes stay in
 * it and `add` stamps them.
 */
export function applyChanges(record: ThreadRecord, changes: ThreadChanges): string[] {
  const fields = record as unknown as Record<string, unknown>;
  const changed: string[] = [];
  for (const [key, given] of Object.entries(changes)) {
    const value = given === false ? undefined : given;
    if (JSON.stringify(fields[key] ?? null) === JSON.stringify(value ?? null)) continue;
    if (value === undefined) delete fields[key];
    else fields[key] = value;
    changed.push(key);
  }
  return changed;
}

/** A revision stamp, 0 when there is none (a record from before the list). */
function stamp(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0;
}
