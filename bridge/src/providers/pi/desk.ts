import { execFile } from "node:child_process";
import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { firstLine, type RecentFolder } from "../../folders.ts";
import { hostOS, machineWord, type HostOS } from "../../platform.ts";
import { threadIDPattern } from "../../sessions/registry.ts";
import { titleFrom } from "../titles.ts";
import { sessionFileId, sessionFolderName, sessionFolders, userText } from "./history.ts";
import { appLevel, isForkId } from "./options.ts";
import type { PiEntry } from "./protocol.ts";

// Pi's sessions as the desk's list offers them (`desk.list`, docs/gateway-protocol.md,
// section 11), and which folders a Pi in a terminal is running in.
//
// Pi has no command that lists its sessions, so they are read where it keeps them: one
// file per session, in a folder per working folder (history.ts, "Where the file is").
// The files are only read. A file is read whole once, for the few lines a listing needs,
// and again only when it has changed.
//
// Pi does not say which session a running Pi has open either: it keeps no lock and no
// list of what is open, writes its session file a line at a time without holding it,
// and gives its process the name `pi` in place of the arguments it was started with. What
// can be seen from outside is that a Pi runs in a terminal, and in which folder. So a
// session counts as open while a Pi runs in a terminal in the session's own folder: that
// Pi may have it. Not seen: a Pi started in another folder that then opened the session
// through the picker's list of all sessions, and a Pi some other program runs with no
// terminal (another bridge's).

/** One of Pi's sessions, as far as a listing needs it. */
export interface StoredPiSession {
  /** Pi's own id for it, which a thread that takes it up has too. */
  id: string;
  /** The folder it runs in, as its header says. */
  cwd: string;
  /** The session file. */
  path: string;
  /** What to call it: the name it was given (`/name`, or a thread's title), else the first line of how it began; "" when neither says. */
  title: string;
  /** The model it was last seen on, when the file says. */
  model: { provider: string; id: string } | null;
  /** The thinking level it was last put on, as the app names it; "" when the file does not say. */
  level: string;
  /** When the file last changed, in milliseconds since 1970. */
  updated: number;
}

/** What a session file says of its session. */
export interface SessionSummary {
  id: string;
  /** The folder it runs in, as its header says. */
  cwd: string;
  /** The name it was last given, if it has one. */
  name: string | null;
  /** The first message of the user's, as the bridge stores one. */
  first: string;
  model: StoredPiSession["model"];
  level: string;
}

/** What to call a session: its name, else the first line of how it began; "" when neither says (a first message that is an image alone). */
export function sessionTitle(summary: Pick<SessionSummary, "name" | "first">): string {
  return summary.name || titleFrom(summary.first) || "";
}

/**
 * What a listing needs of a session file's text; null when it is not a session with a
 * message of the user's in it. The lines are Pi's own, one compact JSON value each, so a
 * line is parsed only when it holds one of the few records wanted.
 *
 * The name, the level and the model are the last the file has, read from its end: the
 * model it was last put on, or the one that wrote its last answer, whichever came
 * later. That is what a thread shows until Pi has opened the session. Pi's own rule for
 * what a session comes back on is finer (the branch it was left on, a router it was put
 * on), so a thread takes Pi's word once Pi has spoken (`PiSession.comeBack`).
 */
export function sessionSummary(text: string): SessionSummary | null {
  const [top, ...lines] = text.split("\n");
  const header = parsed(top);
  if (header?.type !== "session" || typeof header.id !== "string" || !threadIDPattern.test(header.id) || typeof header.cwd !== "string" || header.cwd === "") return null;
  let first: string | null = null;
  for (const line of lines) {
    if (!line.includes('"role":"user"')) continue;
    const entry = parsed(line);
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    first = userText(entry.message.content);
    break;
  }
  if (first === null) return null;

  // Each undefined until the file's last word on it is found.
  let name: string | null | undefined;
  let level: string | undefined;
  let model: StoredPiSession["model"] | undefined;
  for (let at = lines.length - 1; at >= 0 && (name === undefined || level === undefined || model === undefined); at -= 1) {
    const line = lines[at];
    // A line that may be one of the records wanted. What it is goes by the record itself: a message can hold the same words.
    const wanted =
      (name === undefined && line.includes('"type":"session_info"')) ||
      (level === undefined && line.includes('"type":"thinking_level_change"')) ||
      (model === undefined && (line.includes('"type":"model_change"') || line.includes('"role":"assistant"')));
    const entry = wanted ? parsed(line) : null;
    if (!entry) continue;
    const answer = entry.type === "message" && entry.message?.role === "assistant" ? entry.message : null;
    if (name === undefined && entry.type === "session_info") {
      // The latest wins, also one that takes the name away.
      name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : null;
    } else if (level === undefined && entry.type === "thinking_level_change") {
      // A word that is none of Pi's levels says nothing.
      if (appLevel(entry.thinkingLevel) !== "") level = appLevel(entry.thinkingLevel);
    } else if (model === undefined && entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      model = { provider: entry.provider, id: entry.modelId };
    } else if (model === undefined && answer && typeof answer.provider === "string" && typeof answer.model === "string") {
      model = { provider: answer.provider, id: answer.model };
    }
  }
  return { id: header.id, cwd: header.cwd, name: name ?? null, first, model: model ?? null, level: level ?? "" };
}

function parsed(line: string | undefined): PiEntry | null {
  try {
    const value = JSON.parse(line ?? "") as PiEntry;
    return value && typeof value === "object" ? value : null;
  } catch {
    // A line cut off mid-write, or not Pi's.
    return null;
  }
}

interface SessionFile {
  path: string;
  size: number;
  /** When it last changed, in milliseconds since 1970. */
  changed: number;
}

/** Pi's session files, read for listing. One per provider: it keeps what it read of a file until the file changes. */
export class PiSessionFiles {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  /** What each file held when last read, by path, with the size and time it had then. */
  private readonly read = new Map<string, { size: number; changed: number; session: StoredPiSession | null }>();
  /** Every session file there was at the last look, and when that was. */
  private sweep: { files: SessionFile[]; at: number } | null = null;
  /** The folder each file's header names, by path, as last read; null for a file that is no session. */
  private readonly heads = new Map<string, { size: number; changed: number; cwd: string | null }>();

  constructor(env: NodeJS.ProcessEnv, now: () => number = Date.now) {
    this.env = env;
    this.now = now;
  }

  /**
   * The newest sessions, newest first: at least `wanted`, as far as there are that many.
   * A copy the bridge had Pi make is not among them. It is the bridge's own: a thread,
   * one taken off the list (which the bridge offers again by itself), or what a copy
   * that failed left behind. Nor are the files in `skip`, which need not be read: those
   * of the bridge's own threads at work, which change with every line Pi writes.
   */
  async newest(wanted: number, skip: ReadonlySet<string> = new Set()): Promise<StoredPiSession[]> {
    const files = (await this.files()).filter((file) => !skip.has(file.path)).sort((a, b) => b.changed - a.changed);
    const sessions: StoredPiSession[] = [];
    // A few at a time (a file is read whole, and one with images in it is large): most calls find the newest already read.
    for (let at = 0; at < files.length && sessions.length < wanted; at += 4) {
      const batch = await Promise.all(files.slice(at, at + 4).map((file) => this.session(file)));
      sessions.push(...batch.filter((session): session is StoredPiSession => session !== null && !isForkId(session.id)));
    }
    // The look is as old as its end: reading the files may have taken a while.
    if (this.sweep) this.sweep.at = this.now();
    // What is no longer there is forgotten.
    const there = new Set((this.sweep?.files ?? []).map((file) => file.path));
    for (const path of this.read.keys()) {
      if (!there.has(path)) this.read.delete(path);
    }
    return sessions;
  }

  /**
   * The session `id`, whatever folder it ran in; null when Pi has none by that id. The
   * one that changed last, if two folders have one. With `maxAgeMs`, from the last look
   * through the folders when that is no older (a listing asks about one removed thread
   * after another); without, the folders are read now, and only the files named for
   * the id are looked at.
   */
  async find(id: string, maxAgeMs = 0): Promise<StoredPiSession | null> {
    const named = (path: string) => sessionFileId(basename(path)) === id;
    const fresh = this.sweep !== null && this.now() - this.sweep.at < maxAgeMs;
    const files = fresh ? this.sweep!.files.filter((file) => named(file.path)) : await this.files(named);
    for (const file of files.sort((a, b) => b.changed - a.changed)) {
      const session = await this.session(file);
      if (session?.id === id) return session;
    }
    return null;
  }

  /**
   * Where Pi's sessions ran, each with when its file last changed (`recentFolders`): the
   * desk's and the bridge's own. Only a file's header is read, and again only once the
   * file has changed.
   */
  async folders(): Promise<RecentFolder[]> {
    // Every file: a look that is no listing's, so it is not kept as the last one.
    const files = await this.files(() => true);
    const folders: RecentFolder[] = [];
    for (const file of files) {
      const known = this.heads.get(file.path);
      let cwd = known && known.size === file.size && known.changed === file.changed ? known.cwd : undefined;
      if (cwd === undefined) {
        const line = await firstLine(file.path);
        // Not read this time: nothing is remembered of it, and the next look reads it.
        if (line === null) continue;
        const header = parsed(line);
        cwd = header?.type === "session" && typeof header.cwd === "string" && isAbsolute(header.cwd) ? header.cwd : null;
        this.heads.set(file.path, { size: file.size, changed: file.changed, cwd });
      }
      if (cwd !== null) folders.push({ path: cwd, lastUsed: file.changed });
    }
    const there = new Set(files.map((file) => file.path));
    for (const path of this.heads.keys()) {
      if (!there.has(path)) this.heads.delete(path);
    }
    return folders;
  }

  /** Every session file there is, or those `wanted` picks by path, each with its size and when it last changed. A look at all of them is kept as the last one. */
  private async files(wanted?: (path: string) => boolean): Promise<SessionFile[]> {
    const folders = await sessionFolders(this.env);
    const listed = await Promise.all(
      folders.map(async (folder) => {
        const names = await readdir(folder).catch(() => [] as string[]);
        return Promise.all(
          names
            .filter((name) => name.endsWith(".jsonl") && (wanted?.(join(folder, name)) ?? true))
            .map(async (name): Promise<SessionFile[]> => {
              const path = join(folder, name);
              const stats = await stat(path).catch(() => null);
              return stats?.isFile() ? [{ path, size: stats.size, changed: stats.mtimeMs }] : [];
            }),
        );
      }),
    );
    const files = listed.flat(2);
    if (!wanted) this.sweep = { files, at: this.now() };
    return files;
  }

  /**
   * One file as a session; null when it is none, or not one a thread could take up: a
   * thread's process opens its session by id in the session's own folder
   * (`--session-id`), where Pi looks in the folder it names after that folder, for a
   * file Pi named itself.
   */
  private async session(file: SessionFile): Promise<StoredPiSession | null> {
    const known = this.read.get(file.path);
    if (known && known.size === file.size && known.changed === file.changed) return known.session;
    const text = await readFile(file.path, "utf8").catch(() => null);
    // Not read this time (too many files open, say): nothing is remembered of it, and the next look reads it.
    if (text === null) return null;
    const summary = sessionSummary(text);
    let session: StoredPiSession | null = null;
    if (summary && sessionFileId(basename(file.path)) === summary.id) {
      const folder = basename(dirname(file.path));
      // With the sessions moved to one folder, Pi goes by the header alone.
      const where = this.env.PI_CODING_AGENT_SESSION_DIR ? folder : sessionFolderName(summary.cwd);
      if (folder === where) session = { id: summary.id, cwd: summary.cwd, path: file.path, title: sessionTitle(summary), model: summary.model, level: summary.level, updated: file.changed };
    }
    this.read.set(file.path, { size: file.size, changed: file.changed, session });
    return session;
  }
}

// MARK: Pi in a terminal

/** Why a session from the desk is not continued while a Pi runs in a terminal in its folder. */
export const terminalMayHaveIt = `Pi is running in a terminal in this session's folder on the ${machineWord()} and may have it open. Quit Pi there, or fork the session, to continue it here.`;

/**
 * The processes of `ps -axo pid=,tty=,comm=` that are a Pi in a terminal: Pi names its
 * process `pi`, and one started from a terminal has that terminal, where one a program
 * started for itself (the bridge's own, each in a session of its own) has none.
 */
export function terminalPis(listing: string): number[] {
  return listing.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(line);
    if (!match) return [];
    const [, pid, terminal, name] = match;
    const none = terminal === "??" || terminal === "?" || terminal === "-";
    return !none && (name === "pi" || name.endsWith("/pi")) ? [Number(pid)] : [];
  });
}

/** What the Mac says of the Pis in its terminals. */
export interface TerminalPis {
  /** The folders, as real paths, in which one runs. */
  folders: string[];
  /** The processes it would not say the folder of, though they are there (a Pi run with `sudo`): each may be in any folder. */
  unread: number[];
}

/** What follows a backslash in a name `lsof` prints, and the byte it stands for. */
const lsofEscapes = new Map([["\\", 0x5c], ["t", 0x09], ["n", 0x0a], ["r", 0x0d], ["b", 0x08], ["f", 0x0c]]);

/**
 * A name as it is, from the way `lsof` prints one: it writes a backslash as two, a tab
 * and its like as `\t`, and a byte it takes for unprintable as `\x..` (every letter
 * outside ASCII when it has no locale, a joiner inside an emoji even when it has one).
 */
export function lsofName(printed: string): string {
  const bytes: number[] = [];
  for (let at = 0; at < printed.length; at += 1) {
    const escaped = printed[at] === "\\" ? printed[at + 1] : undefined;
    const hex = escaped === "x" ? /^[0-9a-fA-F]{2}/.exec(printed.slice(at + 2))?.[0] : undefined;
    const plain = escaped === undefined ? undefined : lsofEscapes.get(escaped);
    if (hex !== undefined) {
      bytes.push(Number.parseInt(hex, 16));
      at += 3;
    } else if (plain !== undefined) {
      bytes.push(plain);
      at += 1;
    } else {
      // A whole character, also one of two units.
      const character = String.fromCodePoint(printed.codePointAt(at)!);
      bytes.push(...Buffer.from(character));
      at += character.length - 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The folder each process runs in, as `lsof -a -d cwd -Fpn` says it: a `p` line names a process, the `n` line after it its folder. */
export function workingFolders(listing: string): Map<number, string> {
  const folders = new Map<number, string>();
  let pid: number | null = null;
  for (const line of listing.split("\n")) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith("n/") && pid !== null) folders.set(pid, lsofName(line.slice(1)));
  }
  return folders;
}

/**
 * What a program prints. It is given a locale, so that `lsof` prints a letter outside
 * ASCII as it is and not as `\x..` (a bridge started by launchd has none; `lsofName`
 * reads either). `alsoWith` names the codes the program may leave with and still have
 * said what it knows: `lsof` leaves with 1 when one of the processes it was asked about
 * has gone, and still names the rest.
 */
function output(program: string, args: string[], alsoWith: number[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "en_US.UTF-8" } }, (error, stdout) => {
      if (error && !(typeof error.code === "number" && alsoWith.includes(error.code))) reject(new Error(`${basename(program)} could not be run: ${error.message.split("\n")[0]}`));
      else resolve(stdout);
    });
  });
}

/** Whether a process is there. One that is another user's (a Pi run with `sudo`) is. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The folders the processes `pids` run in, each once, from what `lsof` said of them, and
 * the ones it did not name that are still there (`isAlive`). One that has gone since it
 * was listed runs nowhere.
 */
export function foldersOf(pids: number[], listing: string, isAlive: (pid: number) => boolean = alive): TerminalPis {
  return named(pids, workingFolders(listing), isAlive);
}

function named(pids: number[], folders: Map<number, string>, isAlive: (pid: number) => boolean): TerminalPis {
  return { folders: [...new Set(pids.flatMap((pid) => folders.get(pid) ?? []))], unread: pids.filter((pid) => !folders.has(pid) && isAlive(pid)) };
}

/**
 * Whether a process's /proc/<pid>/stat says it is a Pi in a terminal: its name (in
 * brackets, which may hold spaces and brackets of its own) is `pi`, and its terminal
 * (`tty_nr`, the fifth field after the name) is not 0, which is none.
 */
export function procIsTerminalPi(stat: string): boolean {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return false;
  const terminal = stat.slice(close + 1).trim().split(/\s+/)[4];
  return stat.slice(open + 1, close) === "pi" && terminal !== undefined && terminal !== "0";
}

/** How many /proc files `procTerminalPis` reads at once. */
export const procReadsAtOnce = 32;

/** How /proc is read: its entries, and a file in it. Tests give another. */
export interface ProcReader {
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
}

/**
 * The Pis in a terminal on Linux, from /proc and not `ps` and `lsof`, which a Linux
 * machine may not have (`lsof` is seldom there): each process's name and terminal from
 * its `stat`, its folder from its `cwd` link, which the kernel lets only its own user
 * (or root) read, as `lsof` would.
 */
export async function procTerminalPis(proc: ProcReader = { list: () => readdir("/proc"), read: (path) => readFile(path, "utf8") }): Promise<TerminalPis> {
  const all = (await proc.list()).filter((name) => /^\d+$/.test(name));
  const pids: number[] = [];
  // A few at a time, well under any limit of open files: a read that failed for want of
  // one could hide a Pi.
  for (let at = 0; at < all.length; at += procReadsAtOnce) {
    await Promise.all(all.slice(at, at + procReadsAtOnce).map(async (name) => {
      let stat: string;
      try {
        stat = await proc.read(`/proc/${name}/stat`);
      } catch (error) {
        // Gone since it was listed, or another user's that the kernel shows only to them
        // (`hidepid`): as for one it does not list at all. Anything else, and the check fails.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM") return;
        throw new Error(`/proc/${name}/stat could not be read (${(error as Error).message})`);
      }
      if (procIsTerminalPi(stat)) pids.push(Number(name));
    }));
  }
  const folders = new Map<number, string>();
  await Promise.all(pids.map(async (pid) => {
    const folder = await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
    if (folder !== undefined) folders.set(pid, folder);
  }));
  return named(pids.sort((a, b) => a - b), folders, alive);
}

/**
 * The Pis that run in a terminal on this machine now, by folder: from `ps` and `lsof` on
 * a Mac, from /proc on Linux. Throws when the Mac cannot be asked: also when `lsof`
 * named the folder of none of them, though they are there (it leaves with 1 for a
 * process that has gone and for a failure of its own alike).
 */
export async function terminalPisNow(os: HostOS = hostOS): Promise<TerminalPis> {
  const pis = os === "linux" ? await procTerminalPis() : await lsofTerminalPis();
  // None placed, though some are there (a Pi run with sudo, whose folder is not ours to
  // read): the turn is not sent, rather than sent to a session one of them may have open.
  if (pis.folders.length === 0 && pis.unread.length > 0) throw new Error(os === "linux" ? "/proc did not say where the Pis in this Linux computer's terminals run" : "lsof did not say where the Pis in the Mac's terminals run");
  return pis;
}

async function lsofTerminalPis(): Promise<TerminalPis> {
  const pids = terminalPis(await output("/bin/ps", ["-axo", "pid=,tty=,comm="]));
  if (pids.length === 0) return { folders: [], unread: [] };
  return foldersOf(pids, await output("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], [1]));
}

/** A folder as its real path, which is how a process's own folder is named. */
export function realFolder(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}
