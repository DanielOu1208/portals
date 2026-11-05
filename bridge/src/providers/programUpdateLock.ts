import { linkSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groupAlive, processOf, type ProcessIdentity } from "./child.ts";

// The lock on updating an agent's program. Each job has a file of its own under
// state/program-updates, `<program>.<id>.json`, whose id is one more than the last job's:
//
// - One owner. Only the job's own process writes its file, and a file is whole from the first.
//   It cannot touch a successor's, which has another name. Whoever else reads only.
// - A job takes the lock by creating its file, which only one can do for that id, and only
//   once the last job holds nothing. Nothing is renamed or overwritten to do it.
// - A job holds the lock until it says it ended, or both its process and its updater's group
//   are gone, by who they are (`ProcessIdentity`), not by their numbers alone. Time alone frees
//   nothing, and a record that cannot be read holds too: it may be of a job still at work. A
//   person who is sure it is not removes the file.

export interface UpdateRecord {
  id: number;
  startedAt: number;
  /** The updater's time limit, in milliseconds since 1970. */
  deadlineAt: number;
  from: string | null;
  /** The job's own process. */
  supervisor: ProcessIdentity;
  /** The updater, which heads its process group. Named before it can start: nothing else of the job can be running without it. */
  updater?: ProcessIdentity;
  ended?: { at: number; code: number | null; timedOut: boolean };
}

/** What an update's own process is given to do (src/providers/programUpdateRun.ts). */
export interface UpdateJob {
  /** The program's id, and the folder its records are in. */
  id: string;
  folder: string;
  program: string;
  args: readonly string[];
  cwd: string;
  /** Where what the updater prints goes. */
  log: string;
  startedAt: number;
  deadlineMs: number;
  from: string | null;
  /** Its host has given up on it past this: held up so long, it starts nothing. */
  startBy: number;
}

export function fileOf(folder: string, program: string, id: number): string {
  return join(folder, `${program}.${id}.json`);
}

/** A number a job can have, with one after it. A name that says anything else is no job's. */
function isJobId(id: number): boolean {
  return id > 0 && Number.isSafeInteger(id + 1);
}

function isIdentity(value: Partial<ProcessIdentity> | undefined): boolean {
  return Number.isSafeInteger(value?.pid) && value!.pid! > 0 && Number.isSafeInteger(value?.group) && value!.group! > 0 && typeof value?.start === "string" && value.start !== "";
}

function jobIds(folder: string, program: string): number[] {
  const named = new RegExp(`^${program}\\.(\\d+)\\.json$`);
  try {
    return readdirSync(folder).flatMap((name) => {
      const id = named.exec(name)?.[1];
      return id !== undefined && String(Number(id)) === id && isJobId(Number(id)) ? [Number(id)] : [];
    });
  } catch {
    return [];
  }
}

/** The id of the latest job of a program; 0 before any. */
export function latestJob(folder: string, program: string): number {
  return Math.max(0, ...jobIds(folder, program));
}

/** A job's record: null for one that is not there, "unreadable" for one that cannot be read or makes no sense. */
export function readJob(folder: string, program: string, id: number): UpdateRecord | "unreadable" | null {
  if (!isJobId(id)) return null;
  try {
    const record = JSON.parse(readFileSync(fileOf(folder, program, id), "utf8")) as UpdateRecord;
    const makesSense = record?.id === id && typeof record.deadlineAt === "number" && typeof record.startedAt === "number" && isIdentity(record.supervisor)
      && (record.updater === undefined || isIdentity(record.updater));
    return makesSense ? record : "unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
}

/** Whether that process is still there. A process that cannot be read counts as there. */
function stillThere(process_: ProcessIdentity): boolean {
  try {
    process.kill(process_.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const now = processOf(process_.pid);
  return now === null || now.start === process_.start;
}

/**
 * Whether the group that process headed has anyone left. Its number is not another's while the
 * group lasts: another process of that number means it has gone. With none of that number, the
 * group is taken for its own: the safe way, as that only holds the lock.
 */
function groupRemains(leader: ProcessIdentity): boolean {
  if (!groupAlive(leader.pid)) return false;
  const now = processOf(leader.pid);
  return now === null || now.start === leader.start;
}

/**
 * Where a job stands: it said it ended; it is at work; its own process has gone but the updater's
 * group has not, so nothing holds it to its time ("unattended"); or nothing of it is left.
 */
export function standing(record: UpdateRecord): "ended" | "running" | "unattended" | "gone" {
  if (record.ended) return "ended";
  if (stillThere(record.supervisor)) return "running";
  return record.updater && groupRemains(record.updater) ? "unattended" : "gone";
}

/** Whether a job holds the lock: time alone never frees it. */
export function holdsLock(record: UpdateRecord): boolean {
  const now = standing(record);
  return now === "running" || now === "unattended";
}

/** Whether what a host may signal is provably that updater: its number and start time both, as they are now. */
export function provedSame(updater: ProcessIdentity): boolean {
  const now = processOf(updater.pid);
  return now !== null && now.start === updater.start && now.group === updater.pid;
}

/** Writes the record over itself, whole. Only its own job calls this; it cannot reach any other's. */
export function saveJob(folder: string, program: string, record: UpdateRecord): void {
  const file = fileOf(folder, program, record.id);
  const whole = `${file}.${process.pid}`;
  writeFileSync(whole, JSON.stringify(record), { mode: 0o600 });
  renameSync(whole, file);
}

/** Takes the lock for a new job: its record, or null when another holds the lock or got there first. */
export function claim(folder: string, program: string, make: (id: number) => UpdateRecord): UpdateRecord | null {
  const last = latestJob(folder, program);
  const held = readJob(folder, program, last);
  if (held === "unreadable" || (held && holdsLock(held))) return null;
  const record = make(last + 1);
  const file = fileOf(folder, program, record.id);
  const whole = `${file}.${process.pid}`;
  writeFileSync(whole, JSON.stringify(record), { mode: 0o600 });
  try {
    linkSync(whole, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  } finally {
    rmSync(whole, { force: true });
  }
  // Held up since it looked, it may have come after files since cleared away: the latest is what counts.
  if (latestJob(folder, program) !== record.id) {
    rmSync(file, { force: true });
    return null;
  }
  // What came before holds nothing now, whatever it was.
  for (const id of jobIds(folder, program)) if (id < record.id) rmSync(fileOf(folder, program, id), { force: true });
  return record;
}
