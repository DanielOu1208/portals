import { existsSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.ts";
import { hostOS, type HostOS } from "./platform.ts";
import { fold, scoreAll, skippedFolders, toRanges, type Scored } from "./sessions/fileSearch.ts";

// Every folder under the bridge user's home folder, ranked against a fuzzy query, for
// choosing where a new thread starts (feature folder_search, `folders.search`,
// docs/plans/2026-10-26-folder-search.md). 2026-10-26: "i mean when choosing a new
// folder or path people can do fuzzy search", over "Everything under home".
//
// - Two kinds of query. Fuzzy: FileSearch's scorer over every folder walked, each scored
//   as its path relative to home, words split at spaces and all matching, with a bonus for
//   a git repository's top and a larger one for a folder `folders.list` lists. A path
//   (with a `/`, or starting with `~`): completed as a shell does, a level at a time,
//   each part fuzzy against the folders in the one before, read live.
// - Only what `folders.add` takes: never the home folder, a hidden or temporary folder,
//   the bridge's own or one config.json hides (`Folders.refusing`, `Folders.taking`).
//   The walk goes into none of these, nor the folders FileSearch's walk skips
//   (`skippedFolders`), `~/Library` or packages (`.app`, `.xcodeproj`, …) on a Mac, nor
//   `~/snap` on Linux, and follows no link, so nothing outside the home folder is named.
// - On a Mac, never into a folder macOS guards with a privacy question (`protectedAtTop`:
//   Desktop, Documents, Downloads, and Pictures, Movies and Music), which the bridge's
//   process reading it in the background would put on the Mac's screen with nobody there:
//   neither walked nor watched. A typed path goes into one whose name it starts
//   (`~/Doc/`), as for `~/Library`; a folder in one that `folders.list` lists is offered
//   all the same.
// - Bounded: one listing (the home folder's), at most `maxFolders` folders `maxDepth`
//   deep, let go of with its watchers after `idleMs` with no search.
// - Never in the way: the walk reads 32 folders at a time between turns of the event loop;
//   a search waits at most `firstWaitMs` for a first walk and `changeWaitMs` for changes
//   to be read, answering from what it has meanwhile (`refreshing`); scoring yields every
//   `chunk` folders, stops for a newer search from the same connection (`superseded`) and
//   after `budgetMs` (`truncated`).
// - Fresh: on a Mac, a watcher on the home folder and a recursive one (FSEvents) on each
//   folder at its top that is walked; a change marks the folder it happened in, which the
//   next search reads again (folders gone are taken off with all under them, new ones
//   walked). Where nothing can be watched, and on Linux, the home folder is walked again,
//   in the background, once the listing is `unwatchedMs` old.

/** One folder, as `folders.search` answers it. */
export interface FolderHit {
  /** Its real path: what `folders.add` takes. */
  path: string;
  /** Its last part. */
  name: string;
  /** Its path under the home folder, with `/` between its parts. */
  relative: string;
  /** The parts of `relative` the query matched, as [start, end) in UTF-16 code units. */
  ranges: [number, number][];
  /** Higher is better; only for ordering the hits of one answer. */
  score: number;
  /** The top of a git repository. */
  git?: true;
  /** `folders.list` lists it: when it was used last, in Unix seconds, when known. */
  last_used?: number;
  /** `folders.list` lists it as added. */
  added?: true;
  /** In a git worktree: the folder `folders.add` adds in its place (feature worktrees). */
  repo?: string;
}

export interface FolderSearchAnswer {
  /** The home folder searched, as a real path. */
  home: string;
  folders: FolderHit[];
  /** How many folders were looked at: those walked, or those a path's folders hold. */
  total: number;
  /** How many matched the query. */
  matched: number;
  /** A fuzzy query over every folder walked, or a path completed level by level. */
  mode: "fuzzy" | "path";
  /** Set when not every folder was looked at: the home folder holds more than the walk keeps, or the search ran out of time. */
  truncated?: true;
  /** Set when the walk, or reading what changed, is under way: this answer is from what was there, and asking again shortly may find more. */
  refreshing?: true;
  /** Set when a newer search from the same connection replaced this one: no folders. */
  superseded?: true;
}

/** A folder `folders.list` lists, as folder search reads it. */
export interface ListedFolder {
  path: string;
  last_used?: number;
  added?: true;
}

export interface FolderSearchOptions {
  /** The home folder, as a real path. */
  home: string;
  /** Whether a real path is refused whatever is in it (`Folders.refusing`); set up once a walk. */
  refusing: () => (path: string) => boolean;
  /** What `folders.add` would make of a path (`Folders.taking`); set up once a search. */
  taking: () => (path: string) => { path: string; repo?: string } | null;
  /** The folders `folders.list` lists. */
  listed: () => Promise<ListedFolder[]>;
  maxFolders?: number;
  maxDepth?: number;
  firstWaitMs?: number;
  changeWaitMs?: number;
  budgetMs?: number;
  /** How many folders are scored between two turns of the event loop (8,000: a few ms). */
  chunk?: number;
  idleMs?: number;
  unwatchedMs?: number;
  /** How long `listed` is kept. */
  listedMs?: number;
  /** More changed folders than this, and the home folder is walked again whole. */
  maxChanged?: number;
  /** The most folders a path query reads. */
  maxReads?: number;
  /** Whether to watch (on a Mac; tests of the unwatched path turn it off). */
  watch?: boolean;
  /** Whose rules the walk follows, this system's unless a test says (src/platform.ts). */
  os?: HostOS;
  now?: () => number;
}

export const defaultFolderLimit = 30;
export const folderLimitMax = 100;

/** Folders the Finder shows as files: never walked into or offered. */
const packageExtensions = new Set([
  "app", "appex", "bundle", "framework", "plugin", "kext", "xpc", "systemextension", "prefpane", "saver", "qlgenerator",
  "mdimporter", "component", "vst", "vst3", "driver", "photoslibrary", "photolibrary", "migratedphotolibrary", "aplibrary",
  "musiclibrary", "tvlibrary", "imovielibrary", "theater", "fcpbundle", "logicx", "band", "xcodeproj", "xcworkspace",
  "xcassets", "xcarchive", "xcdatamodeld", "xcdatamodel", "playground", "dsym", "rtfd", "pkg", "mpkg", "sparsebundle",
  "scnassets", "mlmodelc", "docc", "workflow", "nib", "storyboardc", "lproj", "icloud",
]);

/**
 * At the top of the home folder, the folders macOS asks the person before a process may
 * read (TCC, System Settings > Privacy & Security > Files & Folders; Apple's
 * PrivacyPreferencesPolicyControl services SystemPolicyDesktopFolder,
 * SystemPolicyDocumentsFolder, SystemPolicyDownloadsFolder). Pictures, Movies and Music
 * hold the Photos and Music libraries, guarded too (Photos, MediaLibrary), and are left
 * out with them: the person's own files, rarely where code is. The rest Apple guards is
 * never walked anyway: iCloud Drive and other apps' data are in ~/Library, network and
 * removable volumes are outside the home folder, which the walk never leaves.
 */
const protectedAtTop = new Set(["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music"]);

/**
 * At the top of the home folder only: on a Mac, macOS's own (hundreds of thousands of
 * folders), and those it guards. Linux guards none of them, and keeps its own in hidden
 * folders (`.local`, `.cache`); only Snap's folder of its apps' data is left out there.
 */
const skippedAtTop: Record<HostOS, Set<string>> = { macos: new Set(["Library", ...protectedAtTop]), linux: new Set(["snap"]) };

/** Bonuses added to the scorer's for a folder in use. */
const bonusGit = 14;
const bonusListed = 24;
const bonusAdded = 10;

/** A folder the Finder shows as a file. Linux has none: `Tool.app` there is a folder like any other. */
function isPackage(name: string, os: HostOS): boolean {
  if (os !== "macos") return false;
  const dot = name.lastIndexOf(".");
  return dot > 0 && packageExtensions.has(name.slice(dot + 1).toLowerCase());
}

/** Whether the walk goes into a folder of this name, `top` when it is in the home folder itself. */
export function walked(name: string, top: boolean, os: HostOS = hostOS): boolean {
  return !name.startsWith(".") && !skippedFolders.has(name) && !isPackage(name, os) && !(top && skippedAtTop[os].has(name));
}

function parentOf(relative: string): string {
  const slash = relative.lastIndexOf("/");
  return slash === -1 ? "" : relative.slice(0, slash);
}

function depthOf(relative: string): number {
  if (relative === "") return 0;
  let depth = 1;
  for (let at = relative.indexOf("/"); at !== -1; at = relative.indexOf("/", at + 1)) depth += 1;
  return depth;
}

/** What a search scores: the folders as arrays, made again only when the listing changed. */
interface View extends Scored {
  readonly version: number;
  readonly git: Uint8Array;
}

/** The folders walked under the home folder, relative to it. */
class Listing {
  /** Each folder, with whether it is the top of a git repository. */
  readonly folders = new Map<string, boolean>();
  /** Each folder's folders, by name ("" for the home folder). */
  readonly children = new Map<string, Set<string>>();
  truncated = false;
  done = false;
  readonly listedAt: number;
  private version = 0;
  private view?: View;

  constructor(listedAt: number) {
    this.listedAt = listedAt;
  }

  get size(): number {
    return this.folders.size;
  }

  add(relative: string): void {
    if (this.folders.has(relative)) return;
    this.folders.set(relative, false);
    const parent = parentOf(relative);
    let names = this.children.get(parent);
    if (!names) this.children.set(parent, (names = new Set()));
    names.add(relative.slice(parent === "" ? 0 : parent.length + 1));
    this.version += 1;
  }

  setGit(relative: string, git: boolean): void {
    if (relative === "" || this.folders.get(relative) === undefined || this.folders.get(relative) === git) return;
    this.folders.set(relative, git);
    this.version += 1;
  }

  /** Takes a folder off, with every folder under it. */
  remove(relative: string): void {
    if (!this.folders.has(relative)) return;
    const parent = parentOf(relative);
    this.children.get(parent)?.delete(relative.slice(parent === "" ? 0 : parent.length + 1));
    const stack = [relative];
    while (stack.length > 0) {
      const folder = stack.pop()!;
      this.folders.delete(folder);
      for (const name of this.children.get(folder) ?? []) stack.push(`${folder}/${name}`);
      this.children.delete(folder);
    }
    this.version += 1;
  }

  /** The folders as arrays: the same ones while nothing changed, new ones after (a search under way keeps its own). */
  snapshot(): View {
    if (this.view?.version === this.version) return this.view;
    const paths: string[] = [];
    const lower: string[] = [];
    const nameStarts: number[] = [];
    const git = new Uint8Array(this.folders.size);
    for (const [path, isGit] of this.folders) {
      const folded = fold(path);
      if (isGit) git[paths.length] = 1;
      paths.push(path);
      lower.push(folded === path ? path : folded);
      nameStarts.push(path.lastIndexOf("/") + 1);
    }
    this.view = { version: this.version, paths, lower, nameStarts, git };
    return this.view;
  }
}

/** A folder's folders as the walk reads them, and whether it is a git repository's top; null when it cannot be read as itself. */
type ReadFolder = (path: string) => Promise<Dirent[]>;
const readFolder: ReadFolder = (path) => readdir(path, { withFileTypes: true });

export class FolderSearch {
  private readonly home: string;
  private readonly options: FolderSearchOptions;
  private readonly maxFolders: number;
  private readonly maxDepth: number;
  private readonly firstWaitMs: number;
  private readonly changeWaitMs: number;
  private readonly budgetMs: number;
  private readonly chunk: number;
  private readonly idleMs: number;
  private readonly unwatchedMs: number;
  private readonly listedMs: number;
  private readonly maxChanged: number;
  private readonly maxReads: number;
  private readonly os: HostOS;
  private readonly watching: boolean;
  private readonly now: () => number;
  /** The listing searched: the last whole one, or the first while it is walked. */
  private listing?: Listing;
  /** A walk of the whole home folder under way, and the listing it makes. */
  private walking?: { listing: Listing; done: Promise<void> };
  /** Folders a watcher saw change, to read again. */
  private readonly changed = new Set<string>();
  /** Reading them under way. */
  private applying?: Promise<void>;
  /** Set when a change could not be placed (a watcher said nothing of where): the next search walks again. */
  private stale = false;
  private watchers = new Map<string, FSWatcher>();
  private watched = false;
  /** Reads made while newly created native watches may not yet be listening. */
  private watchStart?: {
    tops: Set<string>;
    reads: Set<string>;
    overflow: boolean;
    timer?: NodeJS.Timeout;
  };
  private usedAt = 0;
  private sweeper?: NodeJS.Timeout;
  /** Bumped when everything is let go of: a walk of the time before stops. */
  private epoch = 0;
  private listedCache?: { at: number; folders: Map<string, ListedFolder> };
  /** The latest search of each connection, by a number. */
  private readonly latest = new WeakMap<object, number>();
  private searches = 0;
  /** The terms of the last whole fuzzy search and the folders they matched, in the view it ran on, to narrow from. */
  private last?: { view: View; terms: string[]; matches: Int32Array };
  /** How many walks of the whole home folder were started, for tests and measurements. */
  walks = 0;
  /** How many folders were read again for a change, for tests. */
  reread = 0;
  /** How folders are read; tests give another. */
  read: ReadFolder = readFolder;

  constructor(options: FolderSearchOptions) {
    this.options = options;
    this.home = options.home;
    this.maxFolders = options.maxFolders ?? 200_000;
    this.maxDepth = options.maxDepth ?? 24;
    this.firstWaitMs = options.firstWaitMs ?? 300;
    this.changeWaitMs = options.changeWaitMs ?? 150;
    this.budgetMs = options.budgetMs ?? 250;
    this.chunk = options.chunk ?? 8000;
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.unwatchedMs = options.unwatchedMs ?? 60_000;
    this.listedMs = options.listedMs ?? 5000;
    this.maxChanged = options.maxChanged ?? 256;
    this.maxReads = options.maxReads ?? 64;
    // Not on Linux: Node watches a tree there with one inotify watch per folder, and a
    // home folder can hold more folders than inotify allows (8,192 on older kernels).
    this.os = options.os ?? hostOS;
    this.watching = (options.watch ?? true) && this.os === "macos";
    this.now = options.now ?? Date.now;
  }

  /** How many folders the listing searched holds now, for tests and measurements. */
  get size(): number {
    return this.listing?.size ?? 0;
  }

  /** The folders a search would find now, relative to the home folder, for tests. */
  get folders(): string[] {
    return [...(this.listing?.folders.keys() ?? [])];
  }

  /**
   * The best `limit` folders for `query`. `caller` names the connection asking: a newer
   * search of its own replaces this one (`superseded`).
   */
  async search(query: string, limit = defaultFolderLimit, caller?: object): Promise<FolderSearchAnswer> {
    const number = ++this.searches;
    if (caller) this.latest.set(caller, number);
    const superseded = () => caller !== undefined && this.latest.get(caller) !== number;
    this.used();
    const asked = query.slice(0, 200).trim();
    if (asked.includes("/") || asked.startsWith("~")) return this.searchPath(asked, limit, superseded);
    return this.searchFuzzy(asked, limit, superseded);
  }

  /** Lets go of the listing and closes the watchers. */
  close(): void {
    this.drop();
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  // MARK: Fuzzy

  private async searchFuzzy(query: string, limit: number, superseded: () => boolean): Promise<FolderSearchAnswer> {
    const ready = await this.ready();
    if (!ready) return { home: this.home, folders: [], total: 0, matched: 0, mode: "fuzzy", superseded: true };
    const { listing, refreshing } = ready;
    const listed = await this.listedFolders();
    const view = listing.snapshot();
    // The folders folders.list lists that the walk does not go into (one in Documents, say):
    // scored too, after the walked ones, numbered from -1 down.
    const unwalked = [...listed.keys()].filter((relative) => !listing.folders.has(relative));
    const others = unwalked.length === 0 ? undefined : asScored(unwalked);
    const pathOf = (index: number): string => (index >= 0 ? view.paths[index] : unwalked[-1 - index]);
    const answer = (folders: FolderHit[], matched: number, cut: boolean): FolderSearchAnswer => ({
      home: this.home, folders, total: view.paths.length + unwalked.length, matched, mode: "fuzzy",
      ...(listing.truncated || cut ? { truncated: true as const } : {}), ...(refreshing ? { refreshing: true as const } : {}),
    });
    const terms = fold(query).split(/\s+/).filter((term) => term !== "");
    const listedBonus = (relative: string): number => {
      const folder = listed.get(relative);
      if (!folder) return 0;
      let bonus = bonusListed + (folder.added ? bonusAdded : 0);
      if (folder.last_used !== undefined) {
        const days = (this.now() / 1000 - folder.last_used) / 86_400;
        bonus += days < 1 ? 16 : days < 7 ? 10 : days < 30 ? 5 : 0;
      }
      return bonus;
    };
    // The best, worst last; a few more than asked for, as some may be refused at the end.
    const room = limit + Math.min(limit, 20);
    const best: { index: number; score: number }[] = [];
    let matched = 0;
    let cut = false;
    const started = this.now();
    const keep = (index: number, score: number) => {
      if (best.length === room && !better(pathOf, index, score, best[best.length - 1])) return;
      let place = best.length;
      while (place > 0 && better(pathOf, index, score, best[place - 1])) place -= 1;
      best.splice(place, 0, { index, score });
      if (best.length > room) best.pop();
    };
    // A query that only adds to the last one's terms matches among its matches: as typed.
    const last = this.last;
    const candidates = terms.length > 0 && last !== undefined && last.view === view && extends_(terms, last.terms) ? last.matches : undefined;
    const count = candidates ? candidates.length : view.paths.length;
    const matches = new Int32Array(terms.length > 0 ? count : 0);
    for (let at = 0; at < count; at += 1) {
      const index = candidates ? candidates[at] : at;
      if (at > 0 && at % this.chunk === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        if (superseded()) return { ...answer([], 0, false), superseded: true };
        if (this.now() - started > this.budgetMs) {
          cut = true;
          break;
        }
      }
      let score: number | null;
      if (terms.length === 0) {
        // No query: the folders in use, then the repositories, shallowest first.
        score = listedBonus(view.paths[index]) + (view.git[index] ? bonusGit : 0);
        if (score === 0) continue;
        score -= depthOf(view.paths[index]);
      } else {
        score = scoreAll(view, index, terms, null);
        if (score === null) continue;
        matches[matched] = index;
        score += (view.git[index] ? bonusGit : 0) + listedBonus(view.paths[index]);
      }
      matched += 1;
      keep(index, score);
    }
    if (superseded()) return { ...answer([], 0, false), superseded: true };
    // The walked folders' matches, which the next query narrows from; the listed ones the
    // walk does not go into are scored again each time.
    const walkedMatched = matched;
    for (let at = 0; others && at < unwalked.length; at += 1) {
      let score = terms.length === 0 ? listedBonus(unwalked[at]) - depthOf(unwalked[at]) : scoreAll(others, at, terms, null);
      if (score === null) continue;
      if (terms.length > 0) score += listedBonus(unwalked[at]);
      matched += 1;
      keep(-1 - at, score);
    }
    // Only whole: one cut short would leave out what the next query should find.
    if (terms.length > 0 && !cut) this.last = { view, terms, matches: matches.slice(0, walkedMatched) };
    const take = this.options.taking();
    const hits: FolderHit[] = [];
    for (const { index, score } of best) {
      if (hits.length === limit) break;
      const relative = pathOf(index);
      const positions: number[] = [];
      if (terms.length > 0) scoreAll(index >= 0 ? view : others!, index >= 0 ? index : -1 - index, terms, positions);
      // One the walk does not go into is read only as it is offered: it is on the list.
      const git = index >= 0 ? view.git[index] === 1 : existsSync(join(this.home, relative, ".git"));
      const hit = this.hit(relative, Math.round(score), toRanges(positions), git, listed, take);
      if (hit) hits.push(hit);
    }
    return answer(hits, matched, cut);
  }

  // MARK: Paths

  /**
   * A path typed as in a terminal: `~/cod/por`, `/Users/me/cod/por` or `cod/por`, each part
   * fuzzy against the folders in the one before (a part that names one exactly, then one
   * a name starts with, first), the best `pathBranching` of each level followed on. A
   * trailing `/` lists what the folder holds, the folder itself first.
   */
  private async searchPath(query: string, limit: number, superseded: () => boolean): Promise<FolderSearchAnswer> {
    const empty: FolderSearchAnswer = { home: this.home, folders: [], total: 0, matched: 0, mode: "path" };
    let rest: string;
    if (query.startsWith("~")) {
      rest = query.slice(1);
    } else if (query.startsWith("/")) {
      // Only under the home folder: nothing outside it is offered.
      const prefix = fold(this.home) + "/";
      if (!fold(query).startsWith(prefix)) return empty;
      rest = query.slice(prefix.length);
    } else {
      rest = query;
    }
    const parts = rest.split("/").filter((part, index, all) => part !== "" || index === all.length - 1);
    const last = parts.pop() ?? "";
    const listed = await this.listedFolders();
    const known = this.listing;
    const isGit = (relative: string) => known?.folders.get(relative) === true;
    // A folder folders.add refuses whatever is in it is neither read nor counted: the
    // answer says nothing of what is in a hidden, temporary or the bridge's own folder.
    const refused = this.options.refusing();
    let frontier: Candidate[] = [{ relative: "", score: 0, positions: [] }];
    let reads = 0;
    let total = 0;
    let cut = false;
    for (const part of parts) {
      const next: Candidate[] = [];
      let exact = false;
      for (const folder of frontier) {
        if (reads >= this.maxReads) {
          cut = true;
          break;
        }
        reads += 1;
        const names = (await this.childrenOf(folder.relative)).filter((name) => !refused(join(this.home, folder.relative, name)));
        total += names.length;
        for (const name of names) {
          const match = matchPart(name, part, folder.relative === "", this.os);
          if (!match) continue;
          exact ||= match.exact;
          next.push({ ...extend(folder, name, match), exact: match.exact });
        }
      }
      if (superseded()) return { ...empty, superseded: true };
      next.sort(byScore);
      // A part that names a folder exactly goes on in that one only, as a shell's would.
      frontier = (exact ? next.filter((candidate) => candidate.exact) : next).slice(0, pathBranching);
      if (frontier.length === 0) return { ...empty, total };
    }
    const found: Candidate[] = [];
    for (const folder of frontier) {
      if (last === "" && folder.relative !== "") found.push({ ...folder, score: folder.score + 10_000 });
      if (reads >= this.maxReads) {
        cut = true;
        break;
      }
      reads += 1;
      const names = (await this.childrenOf(folder.relative)).filter((name) => !refused(join(this.home, folder.relative, name)));
      total += names.length;
      for (const name of names) {
        const match = matchPart(name, last, folder.relative === "", this.os);
        if (!match) continue;
        const candidate = extend(folder, name, match);
        // Among a folder's folders listed whole: the ones in use first.
        if (isGit(candidate.relative)) candidate.score += bonusGit;
        if (listed.has(candidate.relative)) candidate.score += bonusListed;
        found.push(candidate);
      }
    }
    if (superseded()) return { ...empty, superseded: true };
    found.sort(byScore);
    const take = this.options.taking();
    const hits: FolderHit[] = [];
    for (const candidate of found) {
      if (hits.length === limit) break;
      const hit = this.hit(candidate.relative, Math.round(candidate.score), toRanges(candidate.positions), isGit(candidate.relative), listed, take);
      if (hit) hits.push(hit);
    }
    return { ...empty, folders: hits, total, matched: found.length, ...(cut ? { truncated: true as const } : {}) };
  }

  /** The folders in a folder under the home folder, by name, but hidden ones; read now. */
  private async childrenOf(relative: string): Promise<string[]> {
    const path = relative === "" ? this.home : join(this.home, relative);
    const entries = await this.read(path).catch(() => [] as Dirent[]);
    if ((await realpath(path).catch(() => undefined)) !== path) return [];
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
  }

  private hit(
    relative: string, score: number, ranges: [number, number][], git: boolean, listed: Map<string, ListedFolder>,
    take: (path: string) => { path: string; repo?: string } | null,
  ): FolderHit | null {
    const taken = take(join(this.home, relative));
    // Its real path is the one walked: one swapped for a link meanwhile is not offered.
    if (!taken || taken.path !== join(this.home, relative)) return null;
    const hit: FolderHit = { path: taken.path, name: relative.slice(relative.lastIndexOf("/") + 1), relative, ranges, score };
    if (git) hit.git = true;
    const folder = listed.get(relative);
    if (folder?.last_used !== undefined) hit.last_used = folder.last_used;
    if (folder?.added) hit.added = true;
    if (taken.repo !== undefined) hit.repo = taken.repo;
    return hit;
  }

  // MARK: The listing

  /** The folders `folders.list` lists under the home folder, by relative path, read at most every `listedMs`. */
  private async listedFolders(): Promise<Map<string, ListedFolder>> {
    const now = this.now();
    if (this.listedCache && now - this.listedCache.at < this.listedMs) return this.listedCache.folders;
    const folders = new Map<string, ListedFolder>();
    for (const folder of await this.options.listed().catch(() => [] as ListedFolder[])) {
      if (folder.path.startsWith(this.home + "/")) folders.set(folder.path.slice(this.home.length + 1), folder);
    }
    this.listedCache = { at: now, folders };
    return folders;
  }

  /**
   * The listing to search, kept up to date: the first walk waited for at most
   * `firstWaitMs`, the folders that changed read again within `changeWaitMs`, else
   * answered from what is there (`refreshing`).
   */
  private async ready(): Promise<{ listing: Listing; refreshing: boolean } | undefined> {
    const epoch = this.epoch;
    this.walkIfDue();
    const walking = this.walking;
    if (walking && walking.listing === this.listing) {
      // The first walk: what it has so far; once done, what changed meanwhile is read below,
      // or the home folder walked again for a change that could not be placed.
      await within(walking.done, this.firstWaitMs);
      // A search that was closed cannot restart its walk or consume a new generation's listing.
      if (this.epoch !== epoch) return undefined;
      if (!walking.listing.done) return { listing: walking.listing, refreshing: true };
      this.walkIfDue();
    }
    if (this.walking) return { listing: this.listing!, refreshing: true };
    if (this.changed.size > 0 || this.applying) {
      this.applying ??= this.applyChanges().finally(() => {
        this.applying = undefined;
      });
      const done = await within(this.applying, this.changeWaitMs);
      if (this.epoch !== epoch) return undefined;
      // Meanwhile another search may have started a walk, or more changed: still refreshing.
      return { listing: this.listing!, refreshing: !done || this.walking !== undefined || this.changed.size > 0 || this.stale };
    }
    return { listing: this.listing!, refreshing: false };
  }

  /** Starts a walk of the whole home folder when there is no listing, it is stale or old, or too much changed. */
  private walkIfDue(): void {
    if (!this.listing || this.stale || (!this.watched && this.listing.done && this.now() - this.listing.listedAt > this.unwatchedMs) || this.changed.size > this.maxChanged) {
      // Kept while a walk is under way: the one after it takes it.
      if (this.walkAll()) this.stale = false;
    }
  }

  /** Walks the whole home folder into a new listing, searched once done (or at once, when there is none); false when a walk is under way already. */
  private walkAll(): boolean {
    if (this.walking) return false;
    this.walks += 1;
    const epoch = this.epoch;
    const listing = new Listing(this.now());
    // Changes seen from now on are read again in the new listing.
    this.changed.clear();
    if (!this.listing) this.listing = listing;
    if (this.watching && !this.watchers.has("")) this.watchHome();
    const done = (async () => {
      await this.walk(listing, [""], epoch, 1);
      // Watchers belong to this walk's generation, which may have closed during the read.
      if (this.epoch !== epoch) return;
      if (this.watching) this.watchTops(listing);
      await this.walk(listing, [...(listing.children.get("") ?? [])], epoch, Infinity);
      listing.done = true;
    })()
      .catch((error: Error) => log.warn("the home folder could not be walked for folders", { error: error.message }))
      .finally(() => {
        if (this.epoch !== epoch) return;
        this.walking = undefined;
        listing.done = true;
        this.listing = listing;
      });
    this.walking = { listing, done };
    return true;
  }

  /**
   * Reads `starts` (relative to the home folder) and every folder under them, a level at a
   * time, `levels` deep at most: each one's folders into `listing`, and whether it is the
   * top of a git repository. 32 folders read at once, between turns of the event loop.
   */
  private async walk(listing: Listing, starts: string[], epoch: number, levels: number): Promise<void> {
    const refused = this.options.refusing();
    let level = starts;
    for (let count = 0; level.length > 0 && count < levels; count += 1) {
      const next: string[] = [];
      for (let at = 0; at < level.length; at += 32) {
        if (this.epoch !== epoch) return;
        const batch = await Promise.all(level.slice(at, at + 32).map(async (relative) => ({ relative, entries: await this.readAsItself(relative) })));
        for (const { relative, entries } of batch) {
          if (entries === null) continue;
          listing.setGit(relative, entries.some((entry) => entry.name === ".git"));
          if (depthOf(relative) >= this.maxDepth) {
            if (entries.some((entry) => entry.isDirectory() && walked(entry.name, false, this.os))) listing.truncated = true;
            continue;
          }
          entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          for (const entry of entries) {
            if (!entry.isDirectory() || !walked(entry.name, relative === "", this.os)) continue;
            const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
            if (refused(join(this.home, child))) continue;
            if (listing.size >= this.maxFolders) {
              listing.truncated = true;
              return;
            }
            listing.add(child);
            next.push(child);
          }
        }
      }
      level = next;
    }
  }

  /** A folder's entries, or null when it cannot be read or is no longer itself (swapped for a link). */
  private async readAsItself(relative: string): Promise<Dirent[] | null> {
    const starting = this.watchStart;
    if (starting?.tops.has(relative.split("/", 1)[0]) && !starting.reads.has(relative)) {
      // Never hold up the first answer. A larger startup snapshot is rebuilt
      // once in the background rather than remembered without a bound.
      if (starting.reads.size >= Math.max(0, Math.min(32, this.maxChanged))) starting.overflow = true;
      else starting.reads.add(relative);
    }
    const path = relative === "" ? this.home : join(this.home, relative);
    const entries = await this.read(path).catch(() => null);
    if (entries === null) return null;
    return (await realpath(path).catch(() => undefined)) === path ? entries : null;
  }

  /** Reads again each folder a watcher saw change: folders gone are taken off with all under them, new ones walked. */
  private async applyChanges(): Promise<void> {
    const epoch = this.epoch;
    // Not once a walk of the whole home folder is under way: what changes then is the new
    // listing's, read again when that walk is done.
    while (this.changed.size > 0 && this.epoch === epoch && !this.walking) {
      const listing = this.listing!;
      const folders = [...this.changed];
      this.changed.clear();
      const added: string[] = [];
      for (const relative of folders) {
        if (relative !== "" && !listing.folders.has(relative)) continue;
        this.reread += 1;
        const entries = await this.readAsItself(relative);
        if (this.epoch !== epoch) return;
        if (entries === null) {
          if (relative !== "") listing.remove(relative);
          continue;
        }
        listing.setGit(relative, entries.some((entry) => entry.name === ".git"));
        if (depthOf(relative) >= this.maxDepth) {
          if (entries.some((entry) => entry.isDirectory() && walked(entry.name, false, this.os))) listing.truncated = true;
          continue;
        }
        const refused = this.options.refusing();
        const now = new Set(
          entries
            .filter((entry) => entry.isDirectory() && walked(entry.name, relative === "", this.os) && !refused(join(this.home, relative === "" ? entry.name : `${relative}/${entry.name}`)))
            .map((entry) => entry.name),
        );
        const before = listing.children.get(relative) ?? new Set<string>();
        for (const name of [...before]) if (!now.has(name)) listing.remove(relative === "" ? name : `${relative}/${name}`);
        for (const name of now) {
          if (before.has(name)) continue;
          if (listing.size >= this.maxFolders) {
            listing.truncated = true;
            break;
          }
          const child = relative === "" ? name : `${relative}/${name}`;
          listing.add(child);
          added.push(child);
        }
        if (relative === "" && this.watching) this.watchTops(listing);
      }
      if (added.length > 0) await this.walk(listing, added, epoch, Infinity);
    }
  }

  // MARK: Watching

  /** The home folder itself, not what is in it: a folder made or taken away at its top. */
  private watchHome(): void {
    try {
      const watcher = watch(this.home, { persistent: false }, (_event, name) => {
        if (name === null) this.stale = true;
        else this.saw(String(name));
      });
      watcher.on("error", () => this.unwatched());
      this.watchers.set("", watcher);
      this.watched = true;
      this.watchStarted("");
    } catch (error) {
      log.debug("the home folder cannot be watched for folders", { error: (error as Error).message });
      this.watched = false;
    }
  }

  /** Each folder at the top of the home folder that is walked, with all in it: one FSEvents stream each. */
  private watchTops(listing: Listing): void {
    if (!this.watched) return;
    const tops = listing.children.get("") ?? new Set<string>();
    for (const [top, watcher] of this.watchers) {
      if (top !== "" && !tops.has(top)) {
        watcher.close();
        this.watchers.delete(top);
      }
    }
    for (const top of tops) {
      if (this.watchers.has(top)) continue;
      try {
        const watcher = watch(join(this.home, top), { recursive: true, persistent: false }, (_event, name) => {
          if (name === null) this.stale = true;
          else this.saw(`${top}/${String(name)}`);
        });
        watcher.on("error", () => this.unwatched());
        this.watchers.set(top, watcher);
        this.watchStarted(top);
      } catch (error) {
        log.debug("a folder in the home folder cannot be watched for folders", { error: (error as Error).message });
        this.unwatched();
        return;
      }
    }
  }

  /** macOS starts its native stream asynchronously; reconcile early reads once. */
  private watchStarted(top: string): void {
    if (!this.watchStart) {
      this.watchStart = { tops: new Set(), reads: new Set(), overflow: false };
    }
    const starting = this.watchStart;
    starting.tops.add(top);
    if (starting.timer) clearTimeout(starting.timer);
    const epoch = this.epoch;
    starting.timer = setTimeout(() => {
      if (this.watchStart !== starting || this.epoch !== epoch) return;
      this.watchStart = undefined;
      if (starting.overflow) this.stale = true;
      else for (const relative of starting.reads) this.changed.add(relative);
      // An unfinished first walk publishes before recovery starts. Existing
      // watches are reused by walkAll, so an overflow cannot retrigger itself.
      void (this.walking?.done ?? Promise.resolve()).then(() => {
        if (this.epoch === epoch && this.watched) return this.ready();
      }).catch((error: Error) => log.warn("folder watch startup could not be reconciled", { error: error.message }));
    }, 200);
    starting.timer.unref();
  }

  private cancelWatchStart(): void {
    const starting = this.watchStart;
    if (!starting) return;
    this.watchStart = undefined;
    if (starting.timer) clearTimeout(starting.timer);
  }

  /** Something changed at `relative`: the folder it is in is read again, when the walk goes there. */
  private saw(relative: string): void {
    const listing = this.walking?.listing ?? this.listing;
    if (!listing) return;
    const parts = relative.split("/");
    for (let index = 0; index < parts.length - 1; index += 1) if (!walked(parts[index], index === 0, this.os)) return;
    const last = parts[parts.length - 1];
    // A hidden one counts only as a `.git`: the folder becomes a repository, or stops being one.
    if (last.startsWith(".") && last !== ".git") return;
    const parent = parts.slice(0, -1).join("/");
    if (parent !== "" && !listing.folders.has(parent)) return;
    this.changed.add(parent);
  }

  /** A watcher failed: no more watching, and the listing is walked again when old. */
  private unwatched(): void {
    this.cancelWatchStart();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.watched = false;
    this.stale = true;
  }

  // MARK: Letting go

  private used(): void {
    this.usedAt = this.now();
    if (!this.sweeper) {
      this.sweeper = setInterval(() => {
        if (this.now() - this.usedAt > this.idleMs) this.close();
      }, Math.min(this.idleMs, 60_000));
      this.sweeper.unref();
    }
  }

  private drop(): void {
    this.epoch += 1;
    this.cancelWatchStart();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.watched = false;
    this.listing = undefined;
    this.walking = undefined;
    this.applying = undefined;
    this.changed.clear();
    this.stale = false;
    this.listedCache = undefined;
    this.last = undefined;
  }
}

/** Whether `promise` settled within `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  return settled;
}

/** Whether `terms` are `previous` with more typed: each earlier term the same or longer, maybe more terms after. */
/** Folders relative to the home folder, as the scorer reads them. */
function asScored(paths: string[]): Scored {
  return { paths, lower: paths.map((path) => fold(path)), nameStarts: paths.map((path) => path.lastIndexOf("/") + 1) };
}

function extends_(terms: string[], previous: string[]): boolean {
  if (terms.length < previous.length) return false;
  return previous.every((term, index) => terms[index].includes(term));
}

/** Whether `index` with `score` ranks above `other`: by score, then the shorter path, then the path. */
function better(pathOf: (index: number) => string, index: number, score: number, other: { index: number; score: number }): boolean {
  if (score !== other.score) return score > other.score;
  const a = pathOf(index);
  const b = pathOf(other.index);
  return a.length !== b.length ? a.length < b.length : a < b;
}

// MARK: Path parts

/** How many folders of each level a typed path follows on. */
const pathBranching = 8;

interface Candidate {
  relative: string;
  score: number;
  /** Matched places in `relative`. */
  positions: number[];
  /** Its last part is the one typed, case ignored. */
  exact?: boolean;
}

function extend(folder: Candidate, name: string, match: { score: number; positions: number[] }): Candidate {
  // (`exact` is the caller's to set: it says of one level.)
  const offset = folder.relative === "" ? 0 : folder.relative.length + 1;
  return {
    relative: folder.relative === "" ? name : `${folder.relative}/${name}`,
    score: folder.score + match.score,
    positions: [...folder.positions, ...match.positions.map((at) => at + offset)],
  };
}

function byScore(a: Candidate, b: Candidate): number {
  return b.score - a.score || a.relative.length - b.relative.length || (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
}

/**
 * One typed part against a folder's name: its name exactly (case ignored), then a name it
 * starts, then fuzzy, as FileSearch scores a name. A folder the walk skips (`node_modules`,
 * `~/Library`) is found by its name's start only, as typed on purpose; a package never.
 * An empty part takes every folder the walk would.
 */
export function matchPart(name: string, part: string, top: boolean, os: HostOS = hostOS): { score: number; positions: number[]; exact: boolean } | null {
  if (name.startsWith(".") || isPackage(name, os)) return null;
  const lower = fold(name);
  const term = fold(part);
  const ordinary = walked(name, top, os);
  if (term === "") return ordinary ? { score: 0, positions: [], exact: false } : null;
  const span = (length: number) => Array.from({ length }, (_, at) => at);
  if (lower === term) return { score: 2000, positions: span(term.length), exact: true };
  if (lower.startsWith(term)) return { score: 1000 + term.length * 10 - name.length / 100, positions: span(term.length), exact: false };
  if (!ordinary) return null;
  const positions: number[] = [];
  const score = scoreAll({ paths: [name], lower: [lower], nameStarts: [0] }, 0, [term], positions);
  return score === null ? null : { score, positions, exact: false };
}
