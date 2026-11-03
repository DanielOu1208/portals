import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { expandHome } from "./config.ts";
import { worktreeOf } from "./git.ts";
import { hostOS, machineWord } from "./platform.ts";
import { readJSON, writeJSON } from "./store/jsonFile.ts";

// The folders a new thread can run in (`folders.list`, docs/gateway-protocol.md,
// section 11): the General folder from config.json, and the folders the agents worked
// in lately, newest first. The app offers only these; `session.create` refuses any
// other.
//
// Where an agent worked comes from its own history (Claude Code's sessions, Codex's
// threads and its trusted projects) and from the bridge's threads. What is offered is
// cleaned up: only folders that exist, each once (by its real path), none of `/`, the
// home folder, temporary folders, the bridge's own folder, hidden ones or the ones
// config.json hides, and at most `limit`.
//
// A folder no agent has worked in gets on the list by being added (`folders.add`): the
// user chose it in the folder dialog of an app on this Mac. Added folders are kept in
// `state/folders.json`, cleaned up like the rest, and stay on the list, marked `added`,
// however many newer folders there are, until they are taken off it (`folders.remove`).
// An app shows an added folder as a project before any thread has run in it.
//
// A git worktree is never a folder of its own here (feature worktrees): a folder in one
// is listed as the folder of the repository's main checkout it matches (src/git.ts
// `worktreeOf`), and a new thread may start in a folder in a worktree whose repository's
// folder may be started in. Unless that folder is never offered (a main checkout in a
// hidden or temporary folder, or one config.json hides) and the one in the worktree may
// be: that one is a folder of its own, as before the feature (`listedAs`).

/** A folder an agent worked in. */
export interface RecentFolder {
  path: string;
  /** When, in milliseconds since 1970; absent when not known (a trusted project with no thread). */
  lastUsed?: number;
}

/** Reports folders some agent worked in. It must answer quickly: anything slow is cached by its owner. */
export type FolderSource = () => Promise<RecentFolder[]>;

/** One folder as `folders.list` returns it. */
export interface ListedFolder {
  path: string;
  /** Its last path component. */
  name: string;
  /** Unix seconds; left out when not known. */
  last_used?: number;
  /** The user added it (`folders.add`); left out otherwise. */
  added?: true;
}

/**
 * What `folders.add` answers: the folder as listed; for one chosen in a git worktree
 * (feature worktrees), the folder chosen, with `repo`, the folder added and listed in its
 * place. An app from before the feature starts the new thread in `path`, so it starts it
 * where the person chose, as it did, and not in the main checkout.
 */
export type AddedListing = (ListedFolder | FolderList["general"]) & {
  /** For a folder chosen in a git worktree: the folder added in its place, its repository's, as a real path. */
  repo?: string;
};

export interface FolderList {
  general: { path: string; name: "General" };
  folders: ListedFolder[];
}

export interface FolderOptions {
  /** config.json's `generalFolder`; `~` is the home folder. */
  general: string;
  /** config.json's `folders.hide`: never offered, nor anything under them. */
  hide: string[];
  sources: FolderSource[];
  /** The bridge's own folders (its home, where it keeps images), never offered. */
  own: string[];
  /** How many recent folders at most. */
  limit?: number;
  /** The home folder; tests give another. */
  home?: string;
  /** Temporary folders, never offered; tests, whose folders are all temporary, give none. */
  temporary?: string[];
  /** Where the folders the user added are kept (`state/folders.json`). Without it they last until the bridge stops. */
  added?: string;
}

/** A folder the user added, as `state/folders.json` keeps it. */
interface AddedFolder {
  /** Its real path. */
  path: string;
  /** Milliseconds since 1970. */
  addedAt: number;
}

/**
 * Makes the General folder (`~/Portals` unless config.json names another) when it is not
 * there yet, so a thread started from the phone with no folder has a place of its own.
 * Only the last level is made: a folder whose parent is missing is more likely a typo
 * than a wish, and General falls back to the home folder instead. Returns whether it is
 * there now.
 */
export function makeGeneral(configured: string): boolean {
  const path = expandHome(configured);
  if (isDirectory(path)) return true;
  if (!isAbsolute(path) || !isDirectory(dirname(path))) return false;
  try {
    mkdirSync(path);
    return true;
  } catch {
    return isDirectory(path);
  }
}

/** A folder the app named that is not one a thread may run in. The message is for the user. */
export class FolderRefused extends Error {}

/** Temporary folders, never offered: an agent's scratch work is no project. */
export const temporaryRoots = hostOS === "macos" ? ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"] : ["/tmp", "/var/tmp"];

export class Folders {
  private readonly options: FolderOptions;
  private readonly limit: number;
  /** The folders the user added, by real path, with when. */
  private readonly added = new Map<string, number>();

  constructor(options: FolderOptions) {
    this.options = options;
    this.limit = options.limit ?? 30;
    if (options.added) {
      for (const folder of readJSON<{ folders?: AddedFolder[] }>(options.added, {}).folders ?? []) {
        if (folder && typeof folder.path === "string" && typeof folder.addedAt === "number") this.added.set(folder.path, folder.addedAt);
      }
    }
  }

  /** The General folder's real path: config.json's, or the home folder when that one does not exist. */
  general(): string {
    const configured = expandHome(this.options.general);
    return realpath(isDirectory(configured) ? configured : this.home());
  }

  /** What `folders.list` answers. */
  async list(): Promise<FolderList> {
    const general = this.general();
    const reported = (await Promise.all(this.options.sources.map((source) => source().catch(() => [] as RecentFolder[])))).flat();
    // Adding a folder is a use of it: it leads the list until an agent works elsewhere.
    for (const [path, addedAt] of this.added) reported.push({ path, lastUsed: addedAt });

    // The newest use of each path as reported, before touching the disk for it.
    const byPath = new Map<string, number | undefined>();
    for (const folder of reported) {
      if (typeof folder.path !== "string" || !isAbsolute(folder.path)) continue;
      byPath.set(folder.path, newest(byPath.get(folder.path), folder.lastUsed));
    }

    const excluded = this.excluded();
    const never = this.never();
    const byRealPath = new Map<string, number | undefined>();
    for (const [path, lastUsed] of byPath) {
      if (!isDirectory(path)) continue;
      // A folder in a worktree is listed as its repository's; not one in a folder never
      // offered (config.json's hidden ones, the bridge's own), whatever its repository.
      const picked = realpath(path);
      if (never(picked)) continue;
      const real = listedAs(picked, excluded);
      if (real === general || excluded(real)) continue;
      byRealPath.set(real, newest(byRealPath.get(real), lastUsed));
    }

    // The added ones are listed past the limit too: they are there until taken off. One
    // added in a worktree before the bridge knew of them is its repository's folder.
    const added = new Set([...this.added.keys()].map((path) => (isDirectory(path) ? listedAs(realpath(path), excluded) : path)));
    const folders = [...byRealPath]
      .sort(([pathA, usedA], [pathB, usedB]) => (usedB ?? -1) - (usedA ?? -1) || pathA.localeCompare(pathB))
      .filter(([path], index) => index < this.limit || added.has(path))
      .map(([path, lastUsed]): ListedFolder => {
        const folder: ListedFolder = { path, name: basename(path) };
        if (lastUsed !== undefined) folder.last_used = Math.floor(lastUsed / 1000);
        if (added.has(path)) folder.added = true;
        return folder;
      });
    return { general: { path: general, name: "General" }, folders };
  }

  /**
   * The folder a new thread runs in, as its real path: agents file their sessions under
   * it, and later lookups must match. No folder named is the General one. Throws
   * `FolderRefused` for one that does not exist, or that is neither General nor on the
   * list.
   */
  async resolve(cwd: string | undefined): Promise<string> {
    const general = this.general();
    if (cwd === undefined || cwd === "") return general;
    const path = expandHome(cwd);
    if (!isAbsolute(path) || !isDirectory(path)) throw new FolderRefused(`The folder ${cwd} does not exist on this ${machineWord()}.`);
    const real = realpath(path);
    if (real === general) return real;
    const excluded = this.excluded();
    // An added folder is good past the end of the list, for as long as it may be offered.
    if (this.added.has(real) && !excluded(real)) return real;
    // A folder in a worktree (feature worktrees), where its repository's matching folder
    // or main checkout may be started in: it is listed as that one. Not `/` or the home
    // folder, nor one in the bridge's own folders or those config.json hides; a hidden or
    // temporary worktree is fine (Claude Code keeps its own under `.claude/worktrees`).
    // One whose repository's folder is never offered is a folder of its own (`listedAs`).
    const worktree = worktreeOf(real);
    if (worktree && !standsAlone(worktree.repo, real, excluded) && !this.never()(real)) {
      const repo = [worktree.repo, worktree.main];
      if (repo.includes(general) || repo.some((folder) => this.added.has(folder) && !excluded(folder))) return real;
      if ((await this.list()).folders.some((folder) => repo.includes(folder.path))) return real;
      throw new FolderRefused(`New threads can only start in a worktree of a folder from the list, and the repository of ${cwd} is not on it.`);
    }
    if ((await this.list()).folders.some((folder) => folder.path === real)) return real;
    throw new FolderRefused(`New threads can only start in General or a folder from the list, and ${cwd} is not on it.`);
  }

  /**
   * Puts a folder the user chose on the list (`folders.add`), and answers with it as
   * listed. Adding General, or a folder already added, changes nothing but when. Throws
   * `FolderRefused` for a folder that does not exist, or that is never offered.
   */
  add(path: string, now = Date.now()): AddedListing {
    const chosen = expandHome(path);
    if (!isAbsolute(chosen) || !isDirectory(chosen)) throw new FolderRefused(`The folder ${path} does not exist on this ${machineWord()}.`);
    const picked = realpath(chosen);
    // A folder in a worktree adds its repository's (feature worktrees), and answers with
    // the one chosen and `repo`; not one in a folder never offered, whatever its repository.
    if (picked !== this.general() && this.never()(picked)) {
      throw new FolderRefused(`Threads cannot run in ${path}: it is the home folder, or in one this ${machineWord()} keeps off the list.`);
    }
    const excluded = this.excluded();
    const real = listedAs(picked, excluded);
    const inWorktree = (listed: ListedFolder): AddedListing => (real === picked ? listed : { ...listed, path: picked, name: basename(picked), repo: real });
    if (real === this.general()) return real === picked ? { path: real, name: "General" } : inWorktree({ path: real, name: "General" });
    if (excluded(real)) {
      throw new FolderRefused(`Threads cannot run in ${path}: it is the home folder, a hidden or temporary folder, or one this ${machineWord()} keeps off the list.`);
    }
    this.added.set(real, now);
    this.saveAdded();
    return inWorktree({ path: real, name: basename(real), last_used: Math.floor(now / 1000), added: true });
  }

  /**
   * Takes a folder the user added off the list again (`folders.remove`). It is still
   * listed while it is among the folders the agents worked in lately; one that was never
   * added is left as it is.
   */
  remove(path: string): void {
    const chosen = expandHome(path);
    const real = realpath(chosen);
    const removed = [chosen, real].map((candidate) => this.added.delete(candidate));
    // And a folder in a worktree of it, added before the bridge knew of worktrees, which
    // is listed as this one (feature worktrees).
    const excluded = this.excluded();
    for (const path of [...this.added.keys()]) {
      if (isDirectory(path) && listedAs(realpath(path), excluded) === real) removed.push(this.added.delete(path));
    }
    if (removed.includes(true)) this.saveAdded();
  }

  /**
   * What `folders.add` would make of a folder, without adding it (feature folder_search):
   * a function giving, for a path, null when it would refuse it, else the folder's real
   * path and, for one in a git worktree, `repo`, the folder it would add in its place.
   * The checks are set up once, for a search's hits.
   */
  taking(): (path: string) => { path: string; repo?: string } | null {
    const general = this.general();
    const never = this.never();
    const excluded = this.excluded();
    return (path) => {
      if (!isAbsolute(path) || !isDirectory(path)) return null;
      const picked = realpath(path);
      if (picked !== general && never(picked)) return null;
      const real = listedAs(picked, excluded);
      if (real !== general && excluded(real)) return null;
      return real === picked ? { path: picked } : { path: picked, repo: real };
    };
  }

  /**
   * Whether a real path is one `folders.add` refuses whatever is in it (`/`, the home
   * folder, a hidden or temporary folder, the bridge's own, one config.json hides, and
   * anything under the last four), checked on strings alone: for a walk of the home
   * folder, which goes into none of them (feature folder_search).
   */
  refusing(): (path: string) => boolean {
    const never = this.never();
    const excluded = this.excluded();
    return (path) => never(path) || excluded(path);
  }

  /** The home folder, as a real path. */
  homeFolder(): string {
    return realpath(this.home());
  }

  private saveAdded(): void {
    if (!this.options.added) return;
    writeJSON(this.options.added, { folders: [...this.added].map(([path, addedAt]): AddedFolder => ({ path, addedAt })) });
  }

  private home(): string {
    return this.options.home ?? homedir();
  }

  /** Whether a real path is `/`, the home folder, the bridge's own or one config.json hides, or under one of the last two. */
  private never(): (path: string) => boolean {
    const home = realpath(this.home());
    const roots = [...this.options.own, ...this.options.hide.map(expandHome)].flatMap((root) => {
      const real = isDirectory(root) ? realpath(root) : root;
      return real === root ? [root] : [root, real];
    });
    return (path) => path === sep || path === home || roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));
  }

  /** Whether a real path is never offered. */
  private excluded(): (path: string) => boolean {
    const home = realpath(this.home());
    const temporary = this.options.temporary ?? [...temporaryRoots, tmpdir()];
    const roots = [...temporary, ...this.options.own, ...this.options.hide.map(expandHome)].flatMap((root) => {
      const real = isDirectory(root) ? realpath(root) : root;
      return real === root ? [root] : [root, real];
    });
    return (path) => {
      if (path === sep || path === home) return true;
      if (path.split(sep).some((part) => part.startsWith("."))) return true;
      return roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));
    };
  }
}

/**
 * The folder a real path is listed as: its repository's for one in a git worktree (feature
 * worktrees), itself otherwise, and itself too when it `standsAlone`.
 */
function listedAs(real: string, excluded: (path: string) => boolean): string {
  const repo = worktreeOf(real)?.repo;
  return repo === undefined || standsAlone(repo, real, excluded) ? real : repo;
}

/**
 * Whether a folder in a worktree is a folder of its own, as before the feature, and not
 * listed as its repository's `repo`: when that one is never offered (a main checkout in a
 * hidden or temporary folder, `~/.config/nvim`, or in one config.json hides) and it may be.
 */
function standsAlone(repo: string, real: string, excluded: (path: string) => boolean): boolean {
  return excluded(repo) && !excluded(real);
}

function newest(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The folders `~/.codex/config.toml` trusts, from its `[projects."<path>"]` table
 * headers. Only those headers are read; the rest of the file is not parsed.
 */
export function codexProjects(configPath = join(homedir(), ".codex", "config.toml")): RecentFolder[] {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  const folders: RecentFolder[] = [];
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\s*projects\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*(?:#.*)?$/.exec(line);
    if (!header) continue;
    const key = header[1];
    const path = key.startsWith("'") ? key.slice(1, -1) : unescapeBasic(key.slice(1, -1));
    if (path !== null) folders.push({ path });
  }
  return folders;
}

/** A TOML basic string's escapes; null for one this does not know. */
function unescapeBasic(text: string): string | null {
  let failed = false;
  const result = text.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_, escape: string) => {
    switch (escape[0]) {
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "t":
        return "\t";
      case "u":
      case "U":
        return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
      default:
        failed = true;
        return "";
    }
  });
  return failed ? null : result;
}
