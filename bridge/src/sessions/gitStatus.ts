import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { gitHead } from "../git.ts";
import { findGit, gitSettings } from "./fileSearch.ts";

// What a thread's repository holds that is not committed, for the panel beside the chat
// (feature git_status, `git.status`, `git.diff`; 2026-10-31: its branch, how far
// it is ahead of and behind the branch it follows, and each changed file with the lines
// it adds and removes, as the Codex app shows them. The whole repository's, wherever in it
// the thread's folder is, against HEAD: what is staged and what is not, together.
//
// git itself is run, unlike for the branch alone (src/git.ts): only a git that runs
// without asking to install anything (`findGit`); without one, the branch read from git's
// files is all there is. Run as file search runs it, with no file system monitor, no
// optional locks, the index never written to refresh it, and for a diff no external diff
// tool or text conversion, which a repository's settings could name.
//
// A folder can come with its .git from anywhere (a tarball, a shared drive), and this runs
// with no turn and no approval, so nothing a repository's own settings name runs here: the
// repository is found once and named on every git after that, so a `core.worktree` into
// another one reads no settings of that one's (`openRead`); filter drivers it sets are
// blanked (a user's own, as Git LFS's usually is, keep working); no hook runs; a submodule
// is not looked inside (it has settings of its own); and nothing is fetched for a partial
// clone (that would run `core.sshCommand`).

/** One file that differs from HEAD. */
export interface GitFile {
  /** From the repository's top. */
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted" | "type_changed";
  /** What it was renamed from. */
  from?: string;
  /** All of its change is staged. */
  staged: boolean;
  /** Lines added and removed; null for a binary file, and for one too large to count. */
  added: number | null;
  removed: number | null;
}

interface LineCounts {
  added: number | null;
  removed: number | null;
}

export type GitStatusAnswer =
  /** The thread's folder is in no repository. */
  | { repo: false }
  /** No git to run: the branch from git's own files only. */
  | { repo: true; git: false; branch: string | null; commit: string | null }
  | ({ repo: true; git: true } & GitStatus);

export interface GitStatus {
  /** The repository's top folder. */
  root: string;
  /** The branch checked out; null on a detached HEAD. */
  branch: string | null;
  /** The commit checked out, shortened; null before the first commit. */
  commit: string | null;
  /** The branch it follows (`origin/main`), when it follows one. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** At most `maxFiles` of them, in git's order (by path). */
  files: GitFile[];
  /** How many files differ in all, more than `files` holds when it was cut short. */
  total: number;
  /** Lines added and removed in all of `files`. */
  added: number;
  removed: number;
}

/** The most files an answer lists. */
export const maxFiles = 300;
/** The largest untracked file whose lines are counted. */
const countLimit = 1024 * 1024;
/** The longest diff `git.diff` gives. */
export const maxDiff = 512 * 1024;

export class GitStatusError extends Error {}

/** What is not committed in the repository `folder` is in. `git` as `findGit` finds it; null for none. */
export async function gitStatus(folder: string, git: string | null = findGit()): Promise<GitStatusAnswer> {
  if (!git) {
    const head = await gitHead(folder).catch(() => null);
    return head ? { repo: true, git: false, branch: head.branch, commit: head.commit } : { repo: false };
  }
  const read = await openRead(git, folder).catch(() => null);
  return read ? repositoryStatus(read) : { repo: false };
}

/** `gitStatus` of a repository found. */
async function repositoryStatus(read: GitRead): Promise<{ repo: true; git: true } & GitStatus> {
  const { root } = read;
  const status = await run(read, root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=dirty"]);
  const parsed = parseStatus(status);
  const counts = await lineCounts(read, await diffBase(read, parsed.commit));
  let added = 0;
  let removed = 0;
  let untracked = 0;
  const files = parsed.files.slice(0, maxFiles);
  const listed = new Set(parsed.files.map((file) => file.path));
  for (const file of files) {
    const gone = oldPathGone(file, listed);
    // A file not tracked counts its lines, with what was there before if anything was: a file moved away, this one made in its place.
    const counted =
      file.status === "untracked" && untracked++ < 100
        ? bothCounts((await countLines(join(root, file.path))) ?? undefined, counts.get(file.path))
        : bothCounts(counts.get(file.path), gone === undefined ? undefined : counts.get(gone));
    if (counted) {
      file.added = counted.added;
      file.removed = counted.removed;
      added += counted.added ?? 0;
      removed += counted.removed ?? 0;
    }
  }
  return { repo: true, git: true, root, ...parsed, files, total: parsed.files.length, added, removed };
}

/**
 * The path a file listed as renamed had, while no other file listed has it now. Status goes by
 * the index; a diff against what is in the folder can have given up on the rename (a file
 * moved and staged, then rewritten), and then gives that path a deletion of its own.
 */
function oldPathGone(file: GitFile, listed: Set<string>): string | undefined {
  return file.status === "renamed" && file.from !== undefined && !listed.has(file.from) ? file.from : undefined;
}

/** Counts of a file's change kept under two paths, null for all of it when either part has none. */
function bothCounts(now: LineCounts | undefined, old: LineCounts | undefined): LineCounts | undefined {
  if (!now || !old) return now ?? old;
  return { added: now.added === null || old.added === null ? null : now.added + old.added, removed: now.removed === null || old.removed === null ? null : now.removed + old.removed };
}

/** One file's change against HEAD, for the diff the panel opens (`git.diff`). */
export interface GitFileDiff {
  path: string;
  status: GitFile["status"];
  added: number | null;
  removed: number | null;
  /** Its unified diff; empty when it did not fit in what was left of `maxDiff`, or git could not give it. */
  diff: string;
  /** Its diff was left out: there is a change that `diff` does not show. */
  cut: boolean;
}

/** The most files git not tracking yet whose whole text a diff shows. */
const maxUntrackedDiffs = 50;

/** How long one `git` of a read is given. */
const gitTimeoutMs = 15_000;
/** How long git is given to go when told to, past that. */
const gitKillGraceMs = 1000;

/**
 * Everything not committed in the repository `folder` is in, against HEAD, as one diff of
 * every file `gitStatus` lists (`git.diff`, 2026-11-01: "changes should just be one
 * simple diff"): staged and not together, a file git does not track yet as all added. At
 * most `maxDiff` of diffs in all; a file too large for what is left is listed with its
 * counts only, and those after it that fit still come. Each `git` is given `limitMs`.
 * `total` is how many files differ in all, more than `files` holds when it was cut short.
 */
export async function gitDiffs(folder: string, git: string | null = findGit(), limitMs = gitTimeoutMs): Promise<{ root: string; total: number; files: GitFileDiff[] }> {
  if (!git) throw new GitStatusError("git is not installed on this computer.");
  const read = await openRead(git, folder, limitMs).catch(() => null);
  if (!read) throw new GitStatusError("This thread's folder is not in a git repository.");
  const status = await repositoryStatus(read);
  const listed = new Set(status.files.map((file) => file.path));
  const moved = new Map(status.files.flatMap((file) => {
    const gone = oldPathGone(file, listed);
    return gone === undefined ? [] : [[gone, file.path] as const];
  }));
  const tracked = await trackedDiffs(read, await diffBase(read, status.commit), moved);
  let room = tracked.room;
  let untracked = 0;
  // One limit for all of them: fifty a filter holds to the limit each would outlast the app's wait.
  const untrackedUntil = Date.now() + limitMs;
  const files: GitFileDiff[] = [];
  for (const file of status.files) {
    const part = tracked.files.get(file.path);
    let diff = part?.diff ?? "";
    // No part of a diff that ended means nothing to show (a change staged and put back), but for a file with lines to show.
    let cut = part?.cut ?? (tracked.stopped || file.added !== null || file.removed !== null);
    if (file.status === "untracked") {
      const shown = room > 0 && untracked < maxUntrackedDiffs && Date.now() < untrackedUntil;
      // No more than `room` is read: past it git is stopped, for the text could not stay.
      const text = shown ? await run({ ...read, limitMs: Math.max(1, untrackedUntil - Date.now()) }, status.root, ["diff", ...diffOptions, "--no-index", "--", "/dev/null", file.path], [1], room).then((out) => out.toString("utf8"), () => "") : "";
      const size = Buffer.byteLength(text);
      // What the tracked diff has for it is what was there before: a file moved away, this one made in its place.
      const fits = text !== "" && size <= room && !part?.cut;
      diff = fits ? (part?.diff ?? "") + text : "";
      cut = !fits;
      if (fits) untracked += 1;
      room += fits ? -size : Buffer.byteLength(part?.diff ?? "");
    }
    files.push({ path: file.path, status: file.status, added: file.added, removed: file.removed, diff, cut });
  }
  return { root: status.root, total: status.total, files };
}

/** The start of the line that begins each file's diff but the first. A file's own lines cannot make it: each starts with a mark, and a name with a line feed in it is quoted. */
const nextFile = Buffer.from("\ndiff --git ");
/** How much of a diff too large to keep is held all the same, for the name in its header. */
const headerLimit = 64 * 1024;

/**
 * A diff of several files being read, kept by the path each has now, in at most `room`
 * bytes: one that does not fit is marked cut, its text not held past its header, so the
 * size of the diff is no matter. Split only where a line feed starts `diff --git `: a bare
 * CR or U+2028 in a changed line is that line's text.
 */
export class DiffSplitter {
  readonly files = new Map<string, { diff: string; cut: boolean }>();
  room: number;
  /** git was stopped: a file with no part here may simply not have been reached. */
  stopped = false;
  private held: Buffer[] = [];
  private heldBytes = 0;
  private whole = true;
  private tail: Buffer = Buffer.alloc(0);
  /** Paths whose part is another's: the old path of a file moved, kept as the one file it is. */
  private readonly partOf: ReadonlyMap<string, string>;

  constructor(room: number, partOf: ReadonlyMap<string, string> = new Map()) {
    this.room = room;
    this.partOf = partOf;
  }

  feed(chunk: Buffer): void {
    const bytes = this.tail.length > 0 ? Buffer.concat([this.tail, chunk]) : chunk;
    let from = 0;
    for (let at = bytes.indexOf(nextFile); at >= 0; at = bytes.indexOf(nextFile, from)) {
      this.hold(bytes.subarray(from, at + 1));
      this.close();
      from = at + 1;
    }
    // Its end may be the start of that line, the rest yet to come.
    const safe = Math.max(from, bytes.length - (nextFile.length - 1));
    this.hold(bytes.subarray(from, safe));
    this.tail = bytes.subarray(safe);
  }

  /** The diff has ended; `complete` false when git was stopped, so the last file's text may not be all of it. */
  end(complete = true): void {
    this.hold(this.tail);
    this.tail = Buffer.alloc(0);
    if (!complete) {
      this.stopped = true;
      this.whole = false;
    }
    this.close();
  }

  private hold(bytes: Buffer): void {
    const limit = Math.max(this.room, headerLimit);
    const taken = bytes.subarray(0, Math.max(0, limit - this.heldBytes));
    if (taken.length < bytes.length) this.whole = false;
    if (taken.length > 0) this.held.push(taken);
    this.heldBytes += taken.length;
  }

  private close(): void {
    const text = Buffer.concat(this.held).toString("utf8");
    const size = Buffer.byteLength(text);
    const fits = this.whole && size <= this.room;
    this.held = [];
    this.heldBytes = 0;
    this.whole = true;
    // What comes before the first file (`* Unmerged path …`) is no file's.
    const named = text.startsWith("diff --git ") ? diffPath(text) : null;
    if (!named) return;
    const path = this.partOf.get(named) ?? named;
    // A file git gives in two parts (one whose type changed, one moved and rewritten), both
    // kept or neither, and only what stays in the answer takes room.
    const had = this.files.get(path);
    if (fits && !had?.cut) {
      this.room -= size;
      this.files.set(path, { diff: (had?.diff ?? "") + text, cut: false });
    } else {
      this.room += Buffer.byteLength(had?.diff ?? "");
      this.files.set(path, { diff: "", cut: true });
    }
  }
}

/** The path a file's part of a diff has now, from its header alone, what is before its first hunk. */
function diffPath(part: string): string | null {
  const hunk = part.indexOf("\n@@ ");
  const lines = (hunk < 0 ? part : part.slice(0, hunk)).split("\n");
  let now: string | undefined;
  let was: string | undefined;
  let moved: string | undefined;
  for (const line of lines) {
    if (line.startsWith("+++ ")) now = prefixed(line.slice(4), "b/");
    else if (line.startsWith("--- ")) was = prefixed(line.slice(4), "a/");
    else if (line.startsWith("rename to ")) moved = unquoted(line.slice(10));
  }
  return now ?? moved ?? was ?? firstLinePath(lines[0].slice("diff --git ".length));
}

/** A name from a `+++` or `---` line, git's tab after one with a space in it taken off; undefined for `/dev/null`. */
function prefixed(name: string, prefix: string): string | undefined {
  const path = unquoted(name.endsWith("\t") ? name.slice(0, -1) : name);
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

/** The name in `a/name b/name` for a file with no `+++` line (a binary one, a mode change, an empty one): the two are the same. */
function firstLinePath(names: string): string | null {
  if (names.startsWith('"')) {
    const end = /^"(?:[^"\\]|\\.)*"/s.exec(names)?.[0].length;
    const path = end === undefined ? "" : unquoted(names.slice(end + 1));
    return path.startsWith("b/") ? path.slice(2) : null;
  }
  const length = (names.length - " b/".length - "a/".length) / 2;
  const name = names.slice(2, 2 + length);
  return names === `a/${name} b/${name}` ? name : null;
}

const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** A name as git writes it in a diff: in quotes, C-style, when it holds a tab, a line feed, a quote, a backslash or a control character. */
function unquoted(name: string): string {
  if (!name.startsWith('"') || !name.endsWith('"') || name.length < 2) return name;
  const text = Buffer.from(name.slice(1, -1), "utf8");
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== 92) {
      bytes.push(text[index]);
      continue;
    }
    const escape = String.fromCharCode(text[(index += 1)]);
    if (escape >= "0" && escape <= "7") {
      bytes.push(Number.parseInt(text.subarray(index, index + 3).toString("latin1"), 8) & 0xff);
      index += 2;
    } else {
      bytes.push(escapes[escape] ?? text[index]);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The environment git runs in: nothing asked of the person, no lock taken, nothing fetched
 * for a partial clone, and no repository but the one named, whatever the host was started
 * from (a git hook sets these). GIT_NO_LAZY_FETCH needs git 2.45. With an older one the
 * fetch starts and GIT_ALLOW_PROTOCOL, empty, lets it use no transport; a repository's
 * `protocol.<name>.allow` overrides `-c protocol.allow=never`, but not this.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[name];
  return env;
}

/**
 * On every `git` of a read, with `gitSettings`: the index is not refreshed, for `git diff`
 * would write it to and so run the repository's post-index-change hook, on a folder just
 * extracted with no change in it; no hook runs; and `git status` finds renames as `git
 * diff -M` does whatever the person's settings, up to the same number of files, so a moved
 * file is one entry in both and its old path is not left listed with no diff.
 */
const readOnly = [...gitSettings, "-c", "diff.autoRefreshIndex=false", "-c", "core.hooksPath=/dev/null", "-c", "status.renames=true", "-c", "diff.renameLimit=1000", "-c", "status.renameLimit=1000"];

/** One read of one repository: the git to run, what every run of it is given, and the repository's top folder. */
interface GitRead {
  git: string;
  settings: string[];
  root: string;
  limitMs: number;
}

/**
 * Finds the repository `folder` is in, and what every later `git` of this read runs with;
 * rejects outside one. Its git directory and work tree are found once and then named, so
 * that all of it reads one repository's settings, the ones whose filters are blanked here:
 * from the top of a `core.worktree` pointing into another repository, git left to find its
 * repository would find that one. A linked worktree's and a submodule's own are named the same way.
 *
 * Each filter driver a repository's own config (or a file it includes) sets is blanked. A
 * filter is a command git runs on a file's content as `git status` and `git diff` read it.
 * One named in the person's own config (Git LFS's, as `git lfs install` writes it) is left
 * to work, unless the repository sets that name too.
 *
 * git's `-c` cuts its argument at the first `=`, so a name holding one cannot be blanked,
 * nor can a name that is not UTF-8, for which no argument would be the same bytes; no filter
 * anyone uses has one, and such a repository is not read at all.
 */
async function openRead(git: string, folder: string, limitMs = gitTimeoutMs): Promise<GitRead> {
  const found: GitRead = { git, settings: readOnly, root: folder, limitMs };
  // One name at a time, only the line feed git ends it with coming off: a folder's name can end in a space, or hold a line feed.
  const name = (flag: string) => run(found, folder, ["rev-parse", flag]).then((out) => out.toString("utf8").replace(/\n$/, ""));
  const gitDirectory = await name("--absolute-git-dir");
  const root = await name("--show-toplevel");
  if (!gitDirectory || !root) throw new GitStatusError("This thread's folder is not in a git repository.");
  const settings = [`--git-dir=${gitDirectory}`, `--work-tree=${root}`, ...readOnly];
  // All of them, not those a pattern matches: in a UTF-8 locale git leaves out of those a name that is not UTF-8.
  const listed = await run({ ...found, settings }, root, ["config", "--show-scope", "--name-only", "-z", "--list"]);
  // As bytes, one character each: taken as UTF-8 here, a name that is not would become another name.
  const fields = listed.toString("latin1").split("\0");
  const names = new Set<string>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const named = /^filter\.(.*)\.[^.]+$/s.exec(fields[index + 1])?.[1];
    if (named === undefined || (fields[index] !== "local" && fields[index] !== "worktree")) continue;
    const text = Buffer.from(named, "latin1").toString("utf8");
    if (text.includes("=") || Buffer.from(text, "utf8").toString("latin1") !== named) throw new GitStatusError("This repository's settings cannot be read safely.");
    names.add(text);
  }
  return { git, root, limitMs, settings: [...settings, ...[...names].flatMap((blanked) => ["clean=", "smudge=", "process=", "required=false"].flatMap((setting) => ["-c", `filter.${blanked}.${setting}`]))] };
}

/** What every `git diff` here runs with, whatever the repository's or the person's settings say (`diff.noprefix`, `diff.mnemonicPrefix`, `diff.submodule`, `diff.external`). */
const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color", "-M", "--src-prefix=a/", "--dst-prefix=b/", "--submodule=short", "--ignore-submodules=dirty"];

/** What a diff compares with: HEAD, and before the first commit nothing at all (the empty tree), so what is staged and what is not count as one. */
async function diffBase(read: GitRead, commit: string | null): Promise<string> {
  if (commit !== null) return "HEAD";
  return (await run(read, read.root, ["hash-object", "-t", "tree", "/dev/null"])).toString("utf8").trim();
}

/**
 * The tracked files' diffs against `base`, read as they come so no size of diff can fail
 * the answer: past the time allowed, what came is what there is. That time holds whatever
 * is still running: a child of git (a person's own filter, hanging) keeps git's pipes open
 * after git has gone, so those are let go of and only git's own end is waited for, and not
 * for long.
 */
function trackedDiffs({ git, settings, root, limitMs }: GitRead, base: string, moved: ReadonlyMap<string, string>): Promise<DiffSplitter> {
  return new Promise((resolve, reject) => {
    const child = spawn(git, [...settings, "diff", ...diffOptions, base], { cwd: root, env: gitEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const split = new DiffSplitter(maxDiff, moved);
    let said = "";
    let late = false;
    let settled = false;
    let killer: NodeJS.Timeout | undefined;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      if (code !== 0 && !late) return reject(gitFailure(said));
      split.end(!late);
      resolve(split);
    };
    const timer = setTimeout(() => {
      late = true;
      child.stdout.destroy();
      child.stderr.destroy();
      // Gone already, its pipes held by a child of its.
      if (child.exitCode !== null || child.signalCode !== null) return settle(child.exitCode);
      child.kill();
      killer = setTimeout(() => {
        child.kill("SIGKILL");
        settle(null);
      }, gitKillGraceMs);
    }, limitMs);
    child.stdout.on("data", (chunk: Buffer) => split.feed(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (said.length < 4096) said += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      reject(new GitStatusError(`git could not run: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (late) settle(code);
    });
    child.on("close", settle);
  });
}

/** What git said when it failed, as a sentence for the person; never the command line. */
function gitFailure(said: string, late = false): GitStatusError {
  if (late) return new GitStatusError("git took too long to read this repository.");
  // A partial clone's blob, not fetched (GIT_NO_LAZY_FETCH). git names it several ways.
  if (/promisor|missing blob|unable to read [0-9a-f]{7}|could not read [0-9a-f]{7}|lazy fetch/i.test(said)) return new GitStatusError("Part of this repository is not on this computer yet, so its changes cannot be read here.");
  const reason = /^(?:fatal|error): (.+)$/m.exec(said)?.[1];
  return new GitStatusError(reason ? `git could not read this repository: ${reason}` : "git could not read this repository.");
}

/** git's output; a failure, an exit code not in `ok` besides 0, or more than `maxBytes` of output rejects with a sentence (`GitStatusError`). */
function run({ git, settings, limitMs }: GitRead, cwd: string, args: string[], ok: number[] = [], maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(git, [...settings, ...args], { cwd, encoding: "buffer", maxBuffer: maxBytes, timeout: limitMs, env: gitEnvironment() }, (error, stdout, stderr) => {
      if (!error || (typeof error.code === "number" && ok.includes(error.code))) resolve(stdout);
      else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(new GitStatusError("Too much has changed in this repository to read it here."));
      else reject(gitFailure(stderr.toString("utf8"), error.killed));
    });
  });
}

/** `git status --porcelain=v2 --branch -z`, read. */
export function parseStatus(output: Buffer): Omit<GitStatus, "root" | "files" | "total" | "added" | "removed"> & { files: GitFile[] } {
  const fields = output.toString("utf8").split("\0");
  let branch: string | null = null;
  let commit: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFile[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === "") continue;
    if (field.startsWith("# ")) {
      const [, key, ...rest] = field.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") commit = value === "(initial)" ? null : value.slice(0, 7);
      else if (key === "branch.head") branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") upstream = value;
      else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) [ahead, behind] = [Number(match[1]), Number(match[2])];
      }
      continue;
    }
    const kind = field[0];
    if (kind === "?") {
      files.push({ path: field.slice(2), status: "untracked", staged: false, added: null, removed: null });
    } else if (kind === "1" || kind === "2") {
      // `1 XY sub mH mI mW hH hI path`, `2 XY sub mH mI mW hH hI Xscore path`, its origin next.
      const parts = field.split(" ");
      const xy = parts[1];
      const path = parts.slice(kind === "1" ? 8 : 9).join(" ");
      const from = kind === "2" ? fields[++index] : undefined;
      files.push({ path, status: statusOf(xy, kind === "2"), ...(from ? { from } : {}), staged: xy[1] === ".", added: null, removed: null });
    } else if (kind === "u") {
      // `u XY sub m1 m2 m3 mW h1 h2 h3 path`
      files.push({ path: field.split(" ").slice(10).join(" "), status: "conflicted", staged: false, added: null, removed: null });
    }
  }
  return { branch, commit, upstream, ahead, behind, files };
}

/** A change's two letters (staged, then not): what it is as one. */
function statusOf(xy: string, moved: boolean): GitFile["status"] {
  if (moved) return "renamed";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("A")) return "added";
  if (xy.includes("T")) return "type_changed";
  return "modified";
}

/** Lines added and removed of each tracked file that differs from `base`. */
async function lineCounts(read: GitRead, base: string): Promise<Map<string, LineCounts>> {
  // Renames found as status finds them, so a file renamed counts its changes, not its whole.
  const output = await run(read, read.root, ["diff", "--numstat", "-z", ...diffOptions, base]).catch(() => Buffer.alloc(0));
  const counts = new Map<string, LineCounts>();
  const fields = output.toString("utf8").split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[index]);
    if (!match) continue;
    // A rename's path is left empty, and its old and new paths follow.
    const path = match[3] !== "" ? match[3] : ((index += 2), fields[index]);
    if (!path) continue;
    counts.set(path, { added: match[1] === "-" ? null : Number(match[1]), removed: match[2] === "-" ? null : Number(match[2]) });
  }
  return counts;
}

/** An untracked file's lines, all added; a link is the one line git shows of it; null for a binary one, one too large, or not a plain file. */
async function countLines(path: string): Promise<{ added: number | null; removed: number | null } | null> {
  if ((await lstat(path).catch(() => null))?.isSymbolicLink()) return { added: 1, removed: 0 };
  // Without waiting: a named pipe in the folder would hold the bridge (src/git.ts `readGitText`).
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!file) return null;
  try {
    const stats = await file.stat();
    if (!stats.isFile()) return null;
    if (stats.size > countLimit) return { added: null, removed: 0 };
    const bytes = await file.readFile();
    if (bytes.subarray(0, 8000).includes(0)) return { added: null, removed: 0 };
    let lines = 0;
    for (let at = bytes.indexOf(10); at >= 0; at = bytes.indexOf(10, at + 1)) lines += 1;
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) lines += 1;
    return { added: lines, removed: 0 };
  } finally {
    await file.close();
  }
}
