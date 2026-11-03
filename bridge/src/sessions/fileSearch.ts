import { execFile } from "node:child_process";
import { existsSync, realpathSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { log } from "../log.ts";
import { hostOS } from "../platform.ts";

// The files and folders of a folder, ranked against a fuzzy query as an editor's quick-open
// does (feature file_search, `files.search`), for the menu a device shows when the person
// types `@` to mention a file (docs/plans/2026-10-26-file-mentions.md).
//
// - Which files: in a git repository, git's own listing, `git ls-files --cached --others
//   --exclude-standard` (the index and the untracked files no ignore rule leaves out),
//   less what `--deleted` lists. Elsewhere, or without git (on a Mac without the developer
//   tools `/usr/bin/git` would ask to install them, so it is never run then), a walk of the
//   folder that follows no link and skips the folders no one mentions a file in
//   (`skippedFolders`). The folders are those the files are in. Every path is relative to
//   the folder and inside it: git lists nothing outside the folder it runs in, and the
//   walk follows no link, so nothing outside is ever named.
// - Bounded: at most `maxEntries` paths a folder (the rest left out, `truncated`), at most
//   `maxFolders` folders and `maxTotalEntries` paths held at once, least recently searched
//   let go of first, and a folder not searched for `idleMs` let go of too.
// - Fresh: on a Mac, one recursive watcher a folder (FSEvents) marks its listing stale when
//   anything in it changes but in the folders skipped and inside `.git` (where only the
//   index, which `git add` and a checkout change, counts). A stale listing is listed again
//   on the next search, one listing at a time a folder. A folder that cannot be watched,
//   and every folder on Linux, is listed again when its listing is older than
//   `unwatchedMs`.
// - Ranked by our own scorer (`score` below, fzf-like), the same for every agent.

/** One hit, as `files.search` answers it. */
export interface FileHit {
  /** Relative to the folder searched, with `/` between its parts; a folder's has no `/` at its end. */
  path: string;
  /** Its last part. */
  name: string;
  kind: "file" | "folder";
  /** Higher is better; only for ordering the hits of one answer. */
  score: number;
  /** The characters of `path` the query matched, as [start, end) in UTF-16 code units, in order, not overlapping. */
  ranges: [number, number][];
  /** A file's size in bytes, added by `files.search` (sessions/mentions.ts `withSizes`); absent for a folder or a link. */
  size?: number;
}

export interface FileSearchAnswer {
  /** The folder searched, as a real path. */
  folder: string;
  files: FileHit[];
  /** How many files and folders the listing holds. */
  total: number;
  /** How many matched the query (all of them for an empty query). */
  matched: number;
  /** Where the listing came from. */
  source: "git" | "walk";
  /** Set when the folder holds more than the listing keeps: what was left out is never found. */
  truncated?: true;
  /** Set when the folder changed and is being listed again: this answer is from the listing before, and asking again shortly gives the new one. */
  refreshing?: true;
}

export interface FileSearchOptions {
  /** The most paths kept of one folder. */
  maxEntries?: number;
  /** The most folders kept at once. */
  maxFolders?: number;
  /** The most paths kept of all folders together. */
  maxTotalEntries?: number;
  /** A folder not searched this long is let go of, its watcher closed. */
  idleMs?: number;
  /** A folder that cannot be watched is listed again when its listing is older than this. */
  unwatchedMs?: number;
  /** How long a search waits for a folder that changed to be listed again before answering from the listing it had. */
  refreshWaitMs?: number;
  /** How long a folder a device named stays checked (`checkedFolder`). */
  folderCheckMs?: number;
  /**
   * How old a git listing may grow, after a change in a skipped folder git lists nothing
   * in (a build writing into an ignored dist, where a file not ignored would be listed),
   * before a search lists the folder again.
   */
  doubtfulMs?: number;
  /** How old a git listing that reads files outside the folder (a subfolder of a repository, a linked worktree: ignore rules above it) may grow before a search lists the folder again. */
  externalMs?: number;
  /** The git to run; null for none (the walk always). Found on the PATH or with the developer tools otherwise. */
  git?: string | null;
  /** Whether to watch the folders: on a Mac unless a test of the unwatched path turns it off. */
  watch?: boolean;
  now?: () => number;
}

/** Folders no one mentions a file in: never walked into, and changes in them do not make a listing stale. */
export const skippedFolders = new Set([
  ".git", ".hg", ".svn", "node_modules", "DerivedData", ".build", "build", "Pods", ".swiftpm", "Carthage",
  ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".tox", ".next", ".nuxt", ".turbo", ".cache",
  ".gradle", "target", "dist", ".parcel-cache", ".Trash", ".portals",
]);

/** Files never listed by the walk. */
const skippedFiles = new Set([".DS_Store"]);

export const defaultSearchLimit = 50;
export const searchLimitMax = 200;

/** An entry's kind, as a number: a listing holds a hundred thousand. */
type Kind = 0 | 1;
const Kind = { File: 0, Folder: 1 } as const;

/**
 * `text` in small letters, as long as it is: the ranges are places in a path found in its
 * folded copy, so the two must line up. A character whose small form is longer keeps
 * its base letter (`İ`, whose small form is `i` and a dot above, is `i`) or, failing
 * that, its case. Paths and queries are folded alike.
 */
export function fold(text: string): string {
  // Final and ordinary sigma name the same letter, regardless of casing context.
  const lower = text.toLowerCase().replace(/ς/g, "σ");
  if (lower.length === text.length) return lower;
  let folded = "";
  for (const char of text) {
    const small = char.toLowerCase().replace(/ς/g, "σ");
    if (small.length === char.length) folded += small;
    else if (char.length === 1 && /^\p{L}\p{M}+$/u.test(small) && small.charCodeAt(0) < 0xd800) folded += small[0];
    else folded += char;
  }
  return folded;
}

/** One folder's listing. */
class Listing {
  readonly paths: string[] = [];
  /** `paths` lowercased; the same string where it has no capital. */
  readonly lower: string[] = [];
  readonly kinds: Kind[] = [];
  /** Where each path's last part starts. */
  readonly nameStarts: number[] = [];
  truncated = false;
  /** The entries an empty query lists, worked out once. */
  shallow?: number[];
  /** Of git's listing: the folders it lists with a skipped folder's name (a tracked `dist`), where a change counts all the same (`matters`). */
  readonly skippedListed = new Set<string>();
  /** Of git's listing: the repository's git folder, when it is not the folder's own `.git` (a subfolder, a linked worktree), watched for its index besides. */
  gitDir?: string;
  readonly source: "git" | "walk";
  readonly listedAt: number;

  constructor(source: "git" | "walk", listedAt: number) {
    this.source = source;
    this.listedAt = listedAt;
  }

  add(path: string, kind: Kind): void {
    const lower = fold(path);
    this.paths.push(path);
    this.lower.push(lower === path ? path : lower);
    this.kinds.push(kind);
    this.nameStarts.push(path.lastIndexOf("/") + 1);
    if (kind === Kind.Folder && skippedFolders.has(path.slice(path.lastIndexOf("/") + 1))) this.skippedListed.add(path);
  }

  get size(): number {
    return this.paths.length;
  }
}

/** A folder kept: its listing, the watcher keeping it fresh, and the last query's matches to narrow from. */
interface Held {
  listing?: Listing;
  listing$?: Promise<Listing>;
  stale: boolean;
  watcher?: FSWatcher;
  watched: boolean;
  /** The repository's git folder outside the folder, watched for its index (`Listing.gitDir`). */
  gitWatcher?: { dir: string; watcher?: FSWatcher };
  /** Set when that folder cannot be watched (any more): the listing is then fresh only as long as an unwatched one. */
  gitUnwatched?: boolean;
  /** Set on a change in a skipped folder git listed nothing in: the listing is fresh only for `doubtfulMs`. */
  doubtful?: boolean;
  usedAt: number;
  /** The terms of the last query and the indices of everything they matched, in the listing it ran on. */
  last?: { listing: Listing; terms: string[]; matches: Int32Array };
}

export class FileSearch {
  private readonly held = new Map<string, Held>();
  private readonly maxEntries: number;
  private readonly maxFolders: number;
  private readonly maxTotalEntries: number;
  private readonly idleMs: number;
  private readonly unwatchedMs: number;
  private readonly refreshWaitMs: number;
  private readonly git: string | null;
  private readonly watching: boolean;
  private readonly now: () => number;
  private sweeper?: NodeJS.Timeout;
  /** Folders a device named, as checked, and when (`checkedFolder`). */
  private readonly checked = new Map<string, { folder: string; at: number }>();
  private readonly folderCheckMs: number;
  private readonly doubtfulMs: number;
  private readonly externalMs: number;
  /** How many listings were made, for tests and measurements. */
  listings = 0;

  constructor(options: FileSearchOptions = {}) {
    this.maxEntries = options.maxEntries ?? 200_000;
    this.maxFolders = options.maxFolders ?? 4;
    this.maxTotalEntries = options.maxTotalEntries ?? 400_000;
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.unwatchedMs = options.unwatchedMs ?? 2000;
    this.refreshWaitMs = options.refreshWaitMs ?? 150;
    this.folderCheckMs = options.folderCheckMs ?? 5000;
    this.doubtfulMs = options.doubtfulMs ?? 10_000;
    this.externalMs = options.externalMs ?? 30_000;
    this.git = options.git === undefined ? findGit() : options.git;
    // Not on Linux: Node watches a tree there with one inotify watch per folder, a
    // project's node_modules included, which is slow and can run out of watches.
    this.watching = options.watch ?? hostOS === "macos";
    this.now = options.now ?? Date.now;
  }

  /** Ranks the files and folders of `folder` (a real path the caller checked) against `query`. */
  async search(folder: string, query: string, limit = defaultSearchLimit): Promise<FileSearchAnswer> {
    const held = this.hold(folder);
    const { listing, refreshing } = await this.listingOf(folder, held);
    const terms = fold(query).split(/\s+/).filter((term) => term !== "");
    const answer = (files: FileHit[], matched: number): FileSearchAnswer => ({
      folder, files, total: listing.size, matched, source: listing.source,
      ...(listing.truncated ? { truncated: true as const } : {}), ...(refreshing ? { refreshing: true as const } : {}),
    });
    if (terms.length === 0) return answer(shallowest(listing, limit), listing.size);

    // A query that only adds to the last one's terms matches among its matches.
    const last = held.last;
    const narrows = last !== undefined && last.listing === listing && extends_(terms, last.terms);
    const candidates = narrows ? last.matches : undefined;
    const count = candidates ? candidates.length : listing.size;
    const matches = new Int32Array(count);
    let matched = 0;
    // The best `limit`, worst last, kept as hits are scored.
    const best: Ranked[] = [];
    const ranksAbove: RanksAbove = (index, score, other) => better(listing, index, score, other);
    for (let at = 0; at < count; at += 1) {
      const index = candidates ? candidates[at] : at;
      const score = scoreAll(listing, index, terms, null);
      if (score === null) continue;
      matches[matched++] = index;
      if (best.length === limit && !better(listing, index, score, best[best.length - 1])) continue;
      insertBest(best, index, score, limit, ranksAbove);
    }
    // Kept only for the listing held now: one made again while this search ran replaced it.
    if (held.listing === listing) held.last = { listing, terms, matches: matches.slice(0, matched) };
    return answer(
      best.map(({ index, score }) => {
        const positions: number[] = [];
        scoreAll(listing, index, terms, positions);
        return hit(listing, index, Math.round(score), toRanges(positions));
      }),
      matched,
    );
  }

  /**
   * The folder a device named (`files.search`'s `folder`), checked by `check` at most
   * every `folderCheckMs`: a person types a query a keystroke at a time, and the check
   * (`Folders.resolve`) reads the list of folders. A folder taken off the list is still
   * searched for that long.
   */
  async checkedFolder(asked: string, check: () => Promise<string>): Promise<string> {
    const now = this.now();
    const known = this.checked.get(asked);
    if (known && now - known.at < this.folderCheckMs) return known.folder;
    const folder = await check();
    this.checked.delete(asked);
    this.checked.set(asked, { folder, at: now });
    if (this.checked.size > 32) this.checked.delete(this.checked.keys().next().value!);
    return folder;
  }

  /** Lets go of every folder and closes the watchers. */
  close(): void {
    for (const folder of [...this.held.keys()]) this.drop(folder);
    this.checked.clear();
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  /** The folders held now, for tests. */
  get folders(): string[] {
    return [...this.held.keys()];
  }

  /** How many paths the listings held now keep, those the last queries matched in included, for tests. */
  get entriesHeld(): number {
    const listings = new Set<Listing>();
    for (const held of this.held.values()) {
      if (held.listing) listings.add(held.listing);
      if (held.last) listings.add(held.last.listing);
    }
    let total = 0;
    for (const listing of listings) total += listing.size;
    return total;
  }

  private hold(folder: string): Held {
    let held = this.held.get(folder);
    if (held) {
      // Most recently searched last.
      this.held.delete(folder);
      this.held.set(folder, held);
    } else {
      held = { stale: true, watched: false, usedAt: 0 };
      this.held.set(folder, held);
      if (this.watching) this.watch(folder, held);
      while (this.held.size > this.maxFolders) this.drop(this.held.keys().next().value!);
    }
    held.usedAt = this.now();
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweep(), Math.min(this.idleMs, 60_000));
      this.sweeper.unref();
    }
    return held;
  }

  /**
   * The folder's listing: the one held while fresh, else a new one. A folder listed
   * before waits at most `refreshWaitMs` for the new one, and is answered from the one
   * it had meanwhile (`refreshing`): a folder of 100,000 files takes about half a second
   * to list again, which no keystroke should wait for.
   */
  private async listingOf(folder: string, held: Held): Promise<{ listing: Listing; refreshing: boolean }> {
    const old = held.listing;
    // A listing under way that this search did not start: the one held meanwhile, at once,
    // said to be refreshing until the new one is in (the search that started it waited).
    if (old !== undefined && held.listing$) return { listing: old, refreshing: true };
    const fresh = old !== undefined && !held.stale && this.freshFor(held, old) > this.now() - old.listedAt;
    if (fresh) return { listing: old, refreshing: false };
    if (!held.listing$) {
      held.stale = false;
      held.doubtful = false;
      held.listing$ = this.list(folder).finally(() => {
        held.listing$ = undefined;
      });
      held.listing$.then(
        (listing) => {
          if (this.held.get(folder) !== held) return;
          held.listing = listing;
          // The last query's matches are places in the listing before: let go of it too.
          if (held.last && held.last.listing !== listing) held.last = undefined;
          if (this.watching) this.watchGitDir(folder, held, listing.gitDir);
          this.fit(folder);
        },
        () => {
          held.stale = true;
        },
      );
    }
    const listing$ = held.listing$;
    if (old === undefined) return { listing: await listing$, refreshing: false };
    let timer: NodeJS.Timeout | undefined;
    const waited = await Promise.race([
      listing$.then((listing) => listing, () => old),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), this.refreshWaitMs);
      }),
    ]);
    clearTimeout(timer);
    return waited === undefined ? { listing: old, refreshing: true } : { listing: waited, refreshing: false };
  }

  /** How long `listing` stays fresh without a change seen: for ever where everything it reads is watched. */
  private freshFor(held: Held, listing: Listing): number {
    if (!held.watched || held.gitUnwatched) return this.unwatchedMs;
    let ms = Infinity;
    if (held.doubtful) ms = Math.min(ms, this.doubtfulMs);
    if (listing.gitDir !== undefined) ms = Math.min(ms, this.externalMs);
    return ms;
  }

  /** Lets go of the least recently searched folders until the paths held fit. */
  private fit(keep: string): void {
    let total = 0;
    for (const held of this.held.values()) total += held.listing?.size ?? 0;
    for (const [folder, held] of this.held) {
      if (total <= this.maxTotalEntries) break;
      if (folder === keep) continue;
      total -= held.listing?.size ?? 0;
      this.drop(folder);
    }
  }

  private sweep(): void {
    const now = this.now();
    for (const [folder, held] of this.held) if (now - held.usedAt > this.idleMs) this.drop(folder);
    if (this.held.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  private drop(folder: string): void {
    const held = this.held.get(folder);
    if (!held) return;
    held.watcher?.close();
    held.gitWatcher?.watcher?.close();
    this.held.delete(folder);
  }

  /**
   * Watches the repository's git folder where it is outside the folder searched (a
   * subfolder of a repository, a linked worktree): `git add`, `git rm --cached` and a
   * checkout change the index there and nothing in the folder. Its own folder only, not
   * what is in it.
   */
  private watchGitDir(folder: string, held: Held, dir: string | undefined): void {
    if (held.gitWatcher?.dir === dir) return;
    held.gitWatcher?.watcher?.close();
    held.gitWatcher = undefined;
    held.gitUnwatched = false;
    if (dir === undefined) return;
    try {
      const watcher = watch(dir, { persistent: false }, (_event, name) => {
        if (name === null || name === "index" || name === "HEAD") held.stale = true;
      });
      watcher.on("error", () => {
        watcher.close();
        if (held.gitWatcher?.watcher !== watcher) return;
        // Kept as the folder watched, so that it is not tried again at each listing.
        held.gitUnwatched = true;
        held.stale = true;
      });
      held.gitWatcher = { dir, watcher };
    } catch (error) {
      log.debug("a repository's git folder cannot be watched", { folder, error: (error as Error).message });
      held.gitWatcher = { dir, watcher: undefined };
      held.gitUnwatched = true;
    }
  }

  private watch(folder: string, held: Held): void {
    try {
      const watcher = watch(folder, { recursive: true, persistent: false }, (_event, name) => {
        if (name === null) {
          held.stale = true;
          return;
        }
        const change = matters(String(name), held.listing?.skippedListed);
        if (change === true) held.stale = true;
        else if (change === "doubtful" && held.listing?.source === "git") held.doubtful = true;
      });
      watcher.on("error", (error) => {
        log.debug("a folder searched for files can no longer be watched", { folder, error: error.message });
        watcher.close();
        held.watched = false;
        held.stale = true;
      });
      held.watcher = watcher;
      held.watched = true;
    } catch (error) {
      log.debug("a folder searched for files cannot be watched", { folder, error: (error as Error).message });
      held.watched = false;
    }
  }

  /**
   * A new listing of `folder`, the real path the caller checked. Nothing is kept when the
   * folder is no longer itself after (swapped for a link to elsewhere): git and the walk
   * would have listed what the link points at.
   */
  private async list(folder: string): Promise<Listing> {
    this.listings += 1;
    const now = this.now();
    let listing: Listing | null = null;
    if (this.git) listing = await gitListing(this.git, folder, now, this.maxEntries).catch(() => null);
    listing ??= await walk(folder, now, this.maxEntries);
    if ((await realpath(folder).catch(() => undefined)) !== folder) return new Listing("walk", now);
    return listing;
  }
}

// MARK: Listing

/** A git that runs without asking to install anything: one on the PATH other than macOS's stub, or the stub when the developer tools are there. */
export function findGit(path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter)) {
    // macOS's stub however the PATH spells it (/usr/bin/, /usr//bin, a link to it).
    if (dir === "" || resolve(dir) === "/usr/bin") continue;
    const git = join(dir, "git");
    if (!existsSync(git)) continue;
    const real = (() => {
      try {
        return realpathSync(git);
      } catch {
        return git;
      }
    })();
    if (real === "/usr/bin/git") continue;
    return git;
  }
  if (process.platform !== "darwin") return existsSync("/usr/bin/git") ? "/usr/bin/git" : null;
  const tools = ["/Library/Developer/CommandLineTools/usr/bin/git", "/Applications/Xcode.app/Contents/Developer/usr/bin/git"];
  return tools.find((git) => existsSync(git)) ?? null;
}

function runGit(git: string, folder: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      git,
      args,
      { cwd: folder, encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: 15_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * Run with every `git`: paths as they are, and no file system monitor. A repository's own
 * `core.fsmonitor` names a command that `git ls-files` runs (tried with git 2.54 on
 * 2026-10-26); the bridge runs git on its own, as the person types, so it runs none.
 */
export const gitSettings = ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false"];

/**
 * git's listing of `folder`, or null when it is in no repository (or git fails), and when
 * git lists nothing there: a folder git ignores whole (one in a repository's `build/`)
 * is walked instead.
 */
async function gitListing(git: string, folder: string, now: number, maxEntries: number): Promise<Listing | null> {
  const [listed, deleted, gitDir] = await Promise.all([
    runGit(git, folder, [...gitSettings, "ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
    runGit(git, folder, [...gitSettings, "ls-files", "--deleted", "-z"]),
    runGit(git, folder, [...gitSettings, "rev-parse", "--absolute-git-dir"]).then((output) => output.toString("utf8").trim(), () => ""),
  ]);
  const gone = new Set(split(deleted));
  const listing = new Listing("git", now);
  const folders = new Set<string>();
  let previous = "";
  for (const entry of split(listed)) {
    // The index lists a file once a stage while it is being merged.
    if (entry === previous || gone.has(entry) || entry.startsWith("../")) continue;
    previous = entry;
    // A repository of its own inside, not tracked, is listed as its folder with a `/` at
    // its end (git does not look inside it): a folder, once.
    const isFolder = entry.endsWith("/");
    const path = isFolder ? entry.replace(/\/+$/, "") : entry;
    if (path === "") continue;
    if (listing.size >= maxEntries) {
      listing.truncated = true;
      break;
    }
    // Its folders first, each once.
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      const parent = path.slice(0, slash);
      if (folders.has(parent)) continue;
      folders.add(parent);
      listing.add(parent, Kind.Folder);
    }
    if (!isFolder) listing.add(path, Kind.File);
    else if (!folders.has(path)) {
      folders.add(path);
      listing.add(path, Kind.Folder);
    }
  }
  if (gitDir !== "" && gitDir !== join(folder, ".git")) listing.gitDir = gitDir;
  return listing.size === 0 ? null : listing;
}

function split(output: Buffer): string[] {
  const text = output.toString("utf8");
  return text === "" ? [] : text.split("\0").filter((path) => path !== "");
}

type ReadFolder = (path: string) => Promise<Dirent[]>;

const readFolder: ReadFolder = (path) => readdir(path, { withFileTypes: true });

/**
 * A walk of `folder` (a real path), breadth first, following no link. A folder is read by its path,
 * and a folder swapped for a link to elsewhere between being seen and being read would
 * be read through the link: what is read is kept only when the folder is still itself
 * after (its real path the one expected), which leaves the swap a window of one read.
 */
export async function walk(folder: string, now: number, maxEntries: number, read: ReadFolder = readFolder): Promise<Listing> {
  const listing = new Listing("walk", now);
  let level = [""];
  for (let depth = 0; level.length > 0 && depth < 64; depth += 1) {
    const next: string[] = [];
    // A few folders at a time: the event loop keeps turning.
    for (let at = 0; at < level.length; at += 32) {
      const batch = await Promise.all(
        level.slice(at, at + 32).map(async (relative) => {
          const entries = await read(relative === "" ? folder : join(folder, relative)).catch(() => []);
          const still = await realpath(relative === "" ? folder : join(folder, relative)).catch(() => undefined);
          return { relative, entries: still === (relative === "" ? folder : join(folder, relative)) ? entries : [] };
        }),
      );
      for (const { relative, entries } of batch) {
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
          const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
          if (entry.isDirectory()) {
            if (skippedFolders.has(entry.name)) continue;
            if (listing.size >= maxEntries) return truncated(listing);
            listing.add(path, Kind.Folder);
            next.push(path);
          } else if (!skippedFiles.has(entry.name)) {
            if (listing.size >= maxEntries) return truncated(listing);
            listing.add(path, Kind.File);
          }
        }
      }
    }
    level = next;
  }
  return listing;
}

function truncated(listing: Listing): Listing {
  listing.truncated = true;
  return listing;
}

/**
 * Whether a change at `name` (relative to the folder watched) can change its listing: in
 * `.git` its index, HEAD and info/exclude; elsewhere anything but in the folders skipped,
 * and in those too where git listed one of them (`listedSkipped`: a tracked `dist`, where
 * git lists a new file that is not ignored). One in a skipped folder git listed nothing
 * in is `"doubtful"`: most likely a build's output, ignored, but a file there that is not
 * ignored would be listed (a git listing is made again within `doubtfulMs` of one).
 */
export function matters(name: string, listedSkipped?: ReadonlySet<string>): boolean | "doubtful" {
  const parts = name.split("/");
  if (parts[0] === ".git") {
    if (parts.length === 2) return parts[1] === "index" || parts[1] === "HEAD";
    return parts.length === 3 && parts[1] === "info" && parts[2] === "exclude";
  }
  const skipped = parts.slice(0, -1).findIndex((part) => skippedFolders.has(part));
  if (skipped === -1) return true;
  if (listedSkipped !== undefined && listedSkipped.has(parts.slice(0, skipped + 1).join("/"))) return true;
  return parts.slice(skipped).includes(".git") ? false : "doubtful";
}

// MARK: Ranking

/** For an empty query: the shallowest entries, folders first, by name. */
function shallowest(listing: Listing, limit: number): FileHit[] {
  listing.shallow ??= shallowOrder(listing);
  return listing.shallow.slice(0, limit).map((index) => hit(listing, index, 0, []));
}

/** The top empty-query entries only, in the same stable order as a full sort. */
export function shallowOrder(listing: Pick<Listing, "paths" | "lower" | "kinds" | "size">): number[] {
  const best: Ranked[] = [];
  const ranksAbove: RanksAbove = (index, score, other) => {
    if (score !== other.score) return score > other.score;
    return listing.kinds[index] !== listing.kinds[other.index]
      ? listing.kinds[index] > listing.kinds[other.index]
      : compare(listing.lower[index], listing.lower[other.index]) < 0;
  };
  for (let index = 0; index < listing.size; index += 1) {
    let depth = 0;
    for (const char of listing.paths[index]) if (char === "/") depth += 1;
    if (best.length === searchLimitMax && !ranksAbove(index, -depth, best[best.length - 1])) continue;
    insertBest(best, index, -depth, searchLimitMax, ranksAbove);
  }
  return best.map(({ index }) => index);
}

type Ranked = { index: number; score: number };
type RanksAbove = (index: number, score: number, other: Ranked) => boolean;

/** Insert a hit already checked against the worst. Equal ranks retain their original order. */
function insertBest(best: Ranked[], index: number, score: number, limit: number, ranksAbove: RanksAbove): void {
  let place = 0;
  let end = best.length;
  // A new best goes first; otherwise find the place after every equal rank.
  if (best.length > 0 && !ranksAbove(index, score, best[0])) {
    while (place < end) {
      const middle = (place + end) >>> 1;
      if (ranksAbove(index, score, best[middle])) end = middle;
      else place = middle + 1;
    }
  }
  best.splice(place, 0, { index, score });
  if (best.length > limit) best.pop();
}

function hit(listing: Listing, index: number, score: number, ranges: [number, number][]): FileHit {
  const path = listing.paths[index];
  return { path, name: path.slice(listing.nameStarts[index]), kind: listing.kinds[index] === Kind.Folder ? "folder" : "file", score, ranges };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether `index` with `score` ranks above `other`: by score, then the shorter path, then the path. */
function better(listing: Listing, index: number, score: number, other: Ranked): boolean {
  if (score !== other.score) return score > other.score;
  const a = listing.paths[index];
  const b = listing.paths[other.index];
  return a.length !== b.length ? a.length < b.length : a < b;
}

/** Whether `terms` are `previous` with more typed: each earlier term the same or longer, maybe more terms after. */
function extends_(terms: string[], previous: string[]): boolean {
  if (terms.length < previous.length) return false;
  return previous.every((term, index) => terms[index].includes(term));
}

/**
 * What the scorer reads of a listing: paths, their folded copies and where each one's last
 * part starts. Folder search (`folders.search`, src/folderSearch.ts) ranks with it too.
 */
export interface Scored {
  readonly paths: readonly string[];
  readonly lower: readonly string[];
  readonly nameStarts: readonly number[];
}

/** The score of every term against one entry, summed; null when one does not match. */
export function scoreAll(listing: Scored, index: number, terms: string[], positions: number[] | null): number | null {
  let total = 0;
  for (const term of terms) {
    const score = scoreEntry(listing, index, term, positions);
    if (score === null) return null;
    total += score;
  }
  return total;
}

const scoreMatch = 16;
const bonusPart = 10;
const bonusWord = 8;
const bonusCamel = 7;
const bonusRun = 6;
const penaltyGapStart = -3;
const penaltyGap = -1;
const bonusInName = 24;
const bonusWholeName = 40;
const bonusNameStart = 12;

/**
 * One term against one entry: the best of matching it within the entry's name (worth
 * more) and within its whole path. Positions, when asked for, are added for the better.
 */
function scoreEntry(listing: Scored, index: number, term: string, positions: number[] | null): number | null {
  const lower = listing.lower[index];
  // Quickly out: the term's characters in order anywhere in the path.
  let at = 0;
  for (let k = 0; k < term.length; k += 1) {
    at = lower.indexOf(term[k], at);
    if (at === -1) return null;
    at += 1;
  }
  const path = listing.paths[index];
  const nameStart = listing.nameStarts[index];
  const inPath: number[] | null = positions ? [] : null;
  const whole = scoreWindow(path, lower, term, 0, inPath);
  let best = whole ?? -Infinity;
  let bestPositions = inPath;
  if (!term.includes("/") && nameStart > 0) {
    const inName: number[] | null = positions ? [] : null;
    const name = scoreWindow(path, lower, term, nameStart, inName);
    if (name !== null) {
      let score = name + bonusInName;
      if (lower.length - nameStart === term.length) score += bonusWholeName;
      if (score > best) {
        best = score;
        bestPositions = inName;
      }
    }
  } else if (nameStart === 0 && whole !== null) {
    best += bonusInName + (lower.length === term.length ? bonusWholeName : 0);
  }
  if (best === -Infinity) return null;
  if (positions && bestPositions) positions.push(...bestPositions);
  return best;
}

/** The bonus for matching at `at`: the start of a path part, a word, or a capital after a small letter. */
function bonusAt(path: string, lower: string, at: number, nameStart: number): number {
  if (at === 0) return bonusPart;
  const before = path.charCodeAt(at - 1);
  if (before === 47 /* / */) return at === nameStart ? bonusPart + bonusNameStart : bonusPart;
  if (before === 45 || before === 95 || before === 46 || before === 32) return bonusWord; // - _ . space
  const char = path.charCodeAt(at);
  // A capital after a small letter (camelCase), or a digit after a letter.
  if (char !== lower.charCodeAt(at) && before === lower.charCodeAt(at - 1) && before >= 97 && before <= 122) return bonusCamel;
  return 0;
}

/** Whether a UTF-16 code unit is the second half of a character past U+FFFF (an emoji). */
function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Where `term` matches `lower` in order from `from` to `to` (inclusive), each as early as
 * it can, written into `out` when given: the place of its last character, or -1. The two
 * halves of a character past U+FFFF match only together: the second right after the
 * first, or the first is looked for again (🚀 is not in 😁🪀, though each of its halves is).
 */
function matchForward(lower: string, term: string, from: number, to: number, out: Int32Array | null): number {
  let k = 0;
  let last = -1;
  for (let at = from; at <= to && k < term.length; at += 1) {
    const unit = term.charCodeAt(k);
    if (k > 0 && isLowSurrogate(unit)) {
      // `at` is right after the first half matched.
      if (lower.charCodeAt(at) === unit) {
        if (out) out[k] = at;
        last = at;
        k += 1;
      } else {
        k -= 1;
      }
      continue;
    }
    if (lower.charCodeAt(at) === unit) {
      if (out) out[k] = at;
      last = at;
      k += 1;
    }
  }
  return k === term.length ? last : -1;
}

/** Room for the places a term matched, reused from one entry to the next. */
let matchedScratch = new Int32Array(256);

/** The latest place `term` can start and still end by `end`, matched from its end back; -1 for none. */
function latestStart(lower: string, term: string, from: number, end: number): number {
  let k = term.length - 1;
  for (let at = end; at >= from; at -= 1) {
    const unit = term.charCodeAt(k);
    if (k < term.length - 1 && isLowSurrogate(term.charCodeAt(k + 1))) {
      // `at` is right before the second half matched: the first half must be here.
      if (lower.charCodeAt(at) === unit) {
        k -= 1;
        if (k < 0) return at;
      } else {
        k += 1;
      }
      continue;
    }
    if (lower.charCodeAt(at) === unit) {
      k -= 1;
      if (k < 0) return at;
    }
  }
  return -1;
}

/**
 * fzf's first algorithm, from `from` on: the first place the term ends, the latest start
 * that still holds it all before that end (the tightest window), and the score of the
 * term matched in it from the start.
 */
function scoreWindow(path: string, lower: string, term: string, from: number, positions: number[] | null): number | null {
  const end = matchForward(lower, term, from, lower.length - 1, null);
  if (end === -1) return null;
  const start = latestStart(lower, term, from, end);
  if (start === -1) return null;
  if (matchedScratch.length < term.length) matchedScratch = new Int32Array(term.length);
  const matched = matchedScratch;
  if (matchForward(lower, term, start, end, matched) === -1) return null;
  const nameStart = path.lastIndexOf("/") + 1;
  let score = 0;
  let previous = -2;
  let runBonus = 0;
  for (let index = 0; index < term.length; index += 1) {
    const at = matched[index];
    // The characters between two matched are a gap: its first costs more.
    if (previous >= 0 && at > previous + 1) score += penaltyGapStart + (at - previous - 2) * penaltyGap;
    let bonus = bonusAt(path, lower, at, nameStart);
    if (previous === at - 1) {
      // A run keeps the bonus of its start.
      bonus = Math.max(bonus, runBonus, bonusRun);
    } else {
      runBonus = bonus;
    }
    score += scoreMatch + (index === 0 ? bonus * 2 : bonus);
    positions?.push(at);
    previous = at;
  }
  // The shorter path ranks first among equals.
  return score - path.length / 100;
}

/** Positions, sorted, as [start, end) ranges. */
export function toRanges(positions: number[]): [number, number][] {
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const at of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === at) last[1] = at + 1;
    else ranges.push([at, at + 1]);
  }
  return ranges;
}
