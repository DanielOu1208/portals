import { randomBytes } from "node:crypto";
import { chmodSync, constants, copyFileSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { counters } from "../counters.ts";
import { log } from "../log.ts";

// Small JSON files in the bridge's state folder. Every file is readable by its owner
// only, and is replaced in one step so a crash never leaves half a file.

/**
 * The parsed file, or `fallback` when it is missing or not JSON. A file that is there
 * and cannot be read is `fallback` too, unless `unreadable` is given: then its answer,
 * for a caller that would otherwise write the fallback over the file. `notJSON` is the
 * same for a file that was read and is not JSON.
 */
export function readJSON<T>(path: string, fallback: T, unreadable?: (error: Error) => T, notJSON?: () => T): T {
  const started = counters.on ? performance.now() : 0;
  // As bytes: their count is what the file weighs, with no pass over the text to find it.
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return unreadable && (error as NodeJS.ErrnoException).code !== "ENOENT" ? unreadable(error as Error) : fallback;
  }
  let value = fallback;
  try {
    value = JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    // Not JSON: the fallback, unless the caller has its own answer.
    if (notJSON) value = notJSON();
  }
  // Read whole, and counted as that, whether or not it could be parsed.
  if (started) counters.read(path, bytes.length, performance.now() - started);
  return value;
}

/**
 * A state file saved with `backup` (the registry's, the net's), as the object it holds;
 * none when it is missing. For one that is there and cannot be used (it cannot be read,
 * is not JSON, or holds no object), its `.bak` is found in its place (`fromBackup`), and
 * the file is left at its name, to be kept `aside` by the save that puts another there;
 * or, when the `.bak` cannot be used either, both are moved aside as
 * `<file>.corrupt-<time>-<id>`, so that nothing writes over them and they can be put back by
 * hand with the bridge stopped. Each with an error in the log. When a file cannot be
 * moved, this throws, and the file is left as it is.
 */
export function readStateFile(path: string): { found: Record<string, unknown>; fromBackup: boolean; aside?: string } {
  const read = readObject(path);
  if (read.why === undefined) return { found: read.found ?? {}, fromBackup: false };
  const name = basename(path);
  const backup = readObject(`${path}.bak`);
  if (backup.found) {
    const aside = asideName(path);
    log.error(`${name} could not be used: it is kept aside, and the bridge goes on with ${name}.bak, the file it replaced`, { file: aside, why: read.why });
    return { found: backup.found, fromBackup: true, aside };
  }
  log.error(`${name} could not be used: it was moved aside, and the bridge goes on without it`, { file: moveAside(path), why: read.why });
  if (backup.why !== undefined) log.error(`${name}.bak, the file it replaced, could not be used either: it was moved aside`, { file: moveAside(`${path}.bak`), why: backup.why });
  return { found: {}, fromBackup: false };
}

/**
 * A file saved with `backup` that holds the only copy of what it keeps (an agent's
 * thread the bridge stores itself), as the object it holds; none when it is missing or
 * neither it nor its `.bak` can be used, and then both are left as they are, for the
 * caller to say so. For one that cannot be used, its `.bak` is found in its place, with
 * an error in the log, and `aside` names where the next save keeps the file (`WriteOptions.aside`),
 * so that it does not become the `.bak` in its turn.
 */
export function readBackedUp(path: string): { found?: Record<string, unknown>; aside?: string } {
  const read = readObject(path);
  if (read.why === undefined) return read.found ? { found: read.found } : {};
  const backup = readObject(`${path}.bak`);
  if (!backup.found) return {};
  const aside = asideName(path);
  log.error(`${basename(path)} could not be used: the bridge goes on with ${basename(path)}.bak, the file it replaced, and keeps it aside at the next save`, { file: aside, why: read.why });
  return { found: backup.found, aside };
}

/** The object a state file holds; neither it nor why when the file is missing, and why when it cannot be used. */
function readObject(path: string): { found?: Record<string, unknown>; why?: string } {
  let why: string | undefined;
  const value = readJSON<unknown>(
    path,
    undefined,
    (error) => {
      why = error.message;
      return undefined;
    },
    () => {
      why = "not JSON";
      return undefined;
    },
  );
  // Missing: JSON never parses to undefined.
  if (value === undefined && why === undefined) return {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return { found: value as Record<string, unknown> };
  return { why: why ?? "no object in it" };
}

/** Atomically moves an unusable input onto an exclusively reserved archive name, without reading it. */
function moveAside(path: string): string {
  const directory = lstatSync(path).isDirectory();
  const aside = withAsideName(path, asideName(path), (name) => {
    if (directory) mkdirSync(name, { mode: 0o700 });
    else writeFileSync(name, "", { flag: "wx", mode: 0o600 });
  });
  const reservation = lstatSync(aside, { bigint: true });
  try {
    renameSync(path, aside);
  } catch (error) {
    try {
      const current = lstatSync(aside, { bigint: true });
      if (current.dev === reservation.dev && current.ino === reservation.ino) {
        if (directory && current.isDirectory()) rmdirSync(aside);
        else if (current.isFile() && current.size === 0n) unlinkSync(aside);
      }
    } catch {
      // Leave a reservation that cannot be cleaned up; preserve the rename's error.
    }
    throw error;
  }
  return aside;
}

/** Time-sorted, with a random suffix so recoveries in the same millisecond stay distinct. */
function asideName(path: string): string {
  return `${path}.corrupt-${new Date().toISOString().replace(/:/g, "-")}-${randomBytes(6).toString("hex")}`;
}

/** How a file is written. */
export interface WriteOptions {
  /**
   * The file it replaces is kept beside it as `<file>.bak`, for a reader that finds the
   * new one cannot be used: nothing waits for a file to be on the disk before it takes
   * the old one's place, so a power cut can leave it empty, and the one before it, written
   * a save earlier, is then more likely there. A second name for the old file, made under
   * a name of its own and renamed over the last one kept, so there is a file at both
   * names throughout: no bytes copied, about 0.4 ms a write on a Mac whatever its size
   * (a second name costs APFS more than a rename does). The first write, with no file
   * before it, keeps none.
   */
  backup?: boolean;
  /**
   * The file it replaces is kept under this name instead, and no `.bak` is made: the
   * registry's, for a file that cannot be used, which keeps its own name until the new
   * one takes its place, so a save that fails leaves it there to be tried again. A second
   * name made once the new file is written, just before the rename, so that only a stop
   * between the two leaves the file a name more for each try (no bytes). On a disk that
   * cannot give a file a second name, it is moved there instead.
   */
  aside?: string;
}

/** Writes `value` to `path` with mode 0600, through a temporary file and a rename. */
export function writeJSON(path: string, value: unknown, options: WriteOptions = {}): void {
  // Made into bytes here, once, where writing the text would do the same unseen: their
  // count is what the file weighs, with no second pass over the text to find it.
  writeBytes(path, () => Buffer.from(JSON.stringify(value, null, 1) + "\n"), options);
}

/**
 * Writes the bytes `made` gives to `path` as `writeJSON` does, for a file whose writer
 * has most of them already (the registry). Making them is in the time counted.
 */
export function writeBytes(path: string, made: () => Buffer, options: WriteOptions = {}): void {
  const started = counters.on ? performance.now() : 0;
  ensureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  const bytes = made();
  writeFileSync(temporary, bytes, { mode: 0o600 });
  // The mode given to writeFileSync only applies when the file is created.
  chmodSync(temporary, 0o600);
  if (options.aside !== undefined) withAsideName(path, options.aside, (aside) => preserveAside(path, aside));
  else if (options.backup) keepAsBackup(path);
  renameSync(temporary, path);
  if (started) counters.wrote(path, bytes.length, performance.now() - started);
}

/** The files whose backup could not be kept, each warned about once. */
const unkept = new Set<string>();

/**
 * The file at `path`, if there is one, is `<path>.bak` too, in place of the one kept
 * before. On a disk that cannot give a file a second name (exFAT, some network shares)
 * there is none, and the file is saved all the same.
 */
function keepAsBackup(path: string): void {
  const link = `${path}.bak.${process.pid}.tmp`;
  try {
    try {
      linkSync(path, link);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // None yet: nothing to keep.
      if (code === "ENOENT") return;
      if (code !== "EEXIST") throw error;
      // Left by a process with this one's id that stopped in between.
      unlinkSync(link);
      linkSync(path, link);
    }
    renameSync(link, `${path}.bak`);
  } catch (error) {
    rmSync(link, { force: true });
    if (unkept.has(path)) return;
    unkept.add(path);
    log.warn(`${basename(path)}.bak could not be kept: the file is saved without one`, { error: (error as NodeJS.ErrnoException).code ?? String(error) });
  }
}

/** What a disk that cannot give a file a second name answers a link with. */
const noSecondNames = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS"]);

/** Reserves or fills an unused archive name, retrying collisions at most five times. */
function withAsideName(path: string, wanted: string, keep: (aside: string) => void): string {
  let aside = wanted;
  for (let attempt = 0; ; attempt += 1) {
    try {
      keep(aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 4) throw error;
      aside = asideName(path);
      continue;
    }
    if (aside !== wanted) log.warn(`${basename(path)} used a fresh recovery name after a collision`, { file: aside });
    return aside;
  }
}

/** Keeps the primary until its replacement is ready. Neither a link nor the fallback copy replaces older evidence. */
function preserveAside(path: string, aside: string): void {
  try {
    linkSync(path, aside);
  } catch (error) {
    if (!noSecondNames.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    copyFileSync(path, aside, constants.COPYFILE_EXCL);
    chmodSync(aside, 0o600);
  }
}

/** Creates a folder (and its parents) that only its owner can open. */
export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
