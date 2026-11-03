import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Where a folder's work lands in git: the branch checked out in the repository the
// folder is in, read from git's own files (no `git` is run: on a Mac without the
// developer tools that would ask to install them). It works the same for every agent,
// and for a folder that is a worktree of another repository.

export interface GitHead {
  /** The branch checked out; null on a detached HEAD. */
  branch: string | null;
  /** The commit checked out, shortened, when no branch is. */
  commit: string | null;
}

/** The folder's HEAD, or null outside a repository (and for one git keeps in a form not read here). */
export async function gitHead(folder: string): Promise<GitHead | null> {
  for (let dir = resolve(folder); ; dir = dirname(dir)) {
    const found = await stat(join(dir, ".git")).catch(() => null);
    if (found) {
      const gitDir = found.isDirectory() ? join(dir, ".git") : linkedGitDir(dir);
      return gitDir ? readHead(gitDir) : null;
    }
    if (dirname(dir) === dir) return null;
  }
}

/** A worktree's or a submodule's `.git` file names the folder git keeps it in. */
function linkedGitDir(dir: string): string | null {
  const text = readGitText(join(dir, ".git")) ?? "";
  const named = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (!named) return null;
  return isAbsolute(named) ? named : resolve(dir, named);
}

function readHead(gitDir: string): GitHead | null {
  const head = (readGitText(join(gitDir, "HEAD")) ?? "").trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  // `.invalid`: the refs are in a reftable, which is not read here.
  if (ref) return ref === ".invalid" ? null : { branch: ref, commit: null };
  if (/^[0-9a-f]{40,64}$/.test(head)) return { branch: null, commit: head.slice(0, 7) };
  return null;
}

/**
 * Where a folder in a git worktree belongs (feature worktrees): the folder of the main
 * checkout of its repository that a thread in it is listed under, and the worktree's own
 * top folder. As `git rev-parse --git-common-dir` finds the repository, from git's own
 * files: the worktree's `.git` file names the folder git keeps it in, whose `commondir`
 * names the repository's `.git`, the main checkout's.
 */
export interface Worktree {
  /**
   * The main checkout's folder that matches this one, as a real path: its top for the
   * worktree's top, the same folder in it for one inside the worktree, or its top when
   * the main checkout has no such folder (one made on the worktree's branch).
   */
  repo: string;
  /** The main checkout's top folder, as a real path. */
  main: string;
  /** The worktree's top folder, as a real path. */
  top: string;
}

/**
 * The worktree `folder` is in, or null: for a folder in no repository, in a main
 * checkout, in a submodule (its `.git` file names a repository of its own, with no
 * `commondir`), in a worktree of a bare repository or of one whose `.git` is kept apart
 * from its checkout (no main checkout to list it under), whose main checkout is gone,
 * and for a folder that is not there. As git does, the folder git keeps the worktree in
 * must name the worktree back (its `gitdir` file), and be one of the repository's: a
 * `.git` file alone does not make a folder anyone's worktree. Synchronous: a few
 * `stat`s, for lists of folders.
 */
export function worktreeOf(folder: string): Worktree | null {
  const real = realpathOrNull(folder);
  if (!real || !isDirectorySync(real)) return null;
  for (let dir = real; ; dir = dirname(dir)) {
    const found = statOrNull(join(dir, ".git"));
    if (found) {
      // A `.git` folder: a main checkout (or the folder git keeps a bare one in).
      if (!found.isFile()) return null;
      const gitDir = linkedGitDir(dir);
      const common = gitDir ? readGitText(join(gitDir, "commondir"))?.trim() : undefined;
      if (!gitDir || !common) return null;
      const commonDir = realpathOrNull(isAbsolute(common) ? common : resolve(gitDir, common));
      // A bare repository's folder, or a `.git` kept apart, is no checkout's.
      if (!commonDir || basename(commonDir) !== ".git") return null;
      const main = dirname(commonDir);
      const mainGit = statOrNull(commonDir);
      if (!mainGit?.isDirectory() || main === dir) return null;
      // Kept among the repository's worktrees, and naming this one back.
      if (realpathOrNull(dirname(gitDir)) !== join(commonDir, "worktrees")) return null;
      const back = readGitText(join(gitDir, "gitdir"))?.trim();
      if (!back || realpathOrNull(isAbsolute(back) ? back : resolve(gitDir, back)) !== join(dir, ".git")) return null;
      const inside = relative(dir, real);
      // The same folder in the main checkout, when it is there and in it (not a link out).
      const matching = inside === "" ? null : realpathOrNull(join(main, inside));
      const repo = matching !== null && matching.startsWith(main + sep) && isDirectorySync(matching) ? matching : main;
      return { repo, main, top: dir };
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The folder a thread is listed under besides its own, as of now (feature worktrees):
 * its worktree's `repo`, or none for a folder in no worktree. What was `known` stays
 * while the worktree is gone (removed, which takes its folder, or no longer kept by git):
 * its threads are still listed under the repository.
 */
export function threadRepo(cwd: string, known: string | undefined): string | undefined {
  if (!isDirectorySync(cwd)) return known;
  const worktree = worktreeOf(cwd);
  if (worktree) return worktree.repo;
  return known !== undefined && inStaleWorktree(cwd) ? known : undefined;
}

/** Whether the nearest `.git` above `folder` is a worktree's file naming a folder git no longer keeps. */
function inStaleWorktree(folder: string): boolean {
  for (let dir = realpathOrNull(folder) ?? folder; ; dir = dirname(dir)) {
    const found = statOrNull(join(dir, ".git"));
    if (found) {
      const gitDir = found.isFile() ? linkedGitDir(dir) : null;
      return gitDir !== null && !isDirectorySync(gitDir);
    }
    if (dirname(dir) === dir) return false;
  }
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function isDirectorySync(path: string): boolean {
  return statOrNull(path)?.isDirectory() === true;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * A small plain file's text, or null. git's own files that a `.git` file leads to are
 * anyone's to make who can write in a listed folder, and are read on the bridge's one
 * thread: a named pipe there would hold the bridge for good (opening or reading one waits
 * for a writer), a huge file would be read whole. Opened without waiting, and what was
 * opened is looked at, as counters.ts `openPlain` does.
 */
export function readGitText(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const found = fstatSync(fd);
    if (!found.isFile() || found.size > gitFileLimit) return null;
    const bytes = Buffer.alloc(found.size);
    const read = found.size === 0 ? 0 : readSync(fd, bytes, 0, found.size, 0);
    return bytes.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The most of a `.git` file, HEAD, `commondir` or `gitdir` read: each holds one path or ref. */
const gitFileLimit = 64 * 1024;
