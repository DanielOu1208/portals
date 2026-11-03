import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { FolderSearch, matchPart, walked, type FolderSearchOptions } from "../src/folderSearch.ts";
import { Folders, type RecentFolder } from "../src/folders.ts";
import { pathsFor } from "../src/config.ts";
import { writeLinks } from "../src/fleet/links.ts";
import { createThread, password, startTestBridge, TestClient, username, type RpcFailure } from "./helpers.ts";

// Every folder under the home folder ranked against a fuzzy query, or a typed path
// completed level by level, for choosing where a new thread starts (feature
// folder_search): only what folders.add takes, kept fresh, bounded, never in the way.

let root: string;
/** The home folder of these tests. */
let home: string;
/** Somewhere outside it. */
let outside: string;

function folder(...parts: string[]): string {
  const path = join(home, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    stdio: "ignore",
  });
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "portals-folder-search-test-")));
  home = join(root, "home");
  outside = join(root, "outside");
  mkdirSync(join(outside, "portals-secret"), { recursive: true });
  // A repository, its sources, a plain folder of the same letters, and what is never offered.
  mkdirSync(join(folder("coding_projects", "Portals"), ".git"));
  folder("coding_projects", "Portals", "bridge", "src");
  folder("coding_projects", "Portals", "node_modules", "portals-dep");
  folder("coding_projects", "Portals", "build", "portals-out");
  folder("coding_projects", "portals-old");
  folder("coding_projects", "aerirc");
  folder("Papers", "notes", "taxes");
  folder("Library", "Application Support", "portals-cache");
  folder(".config", "portals");
  folder("Apps", "Portals.app", "Contents");
  folder("Hidden-by-config", "portals-hidden");
  folder("Portals");
  // A link out of the home folder, and one to a folder in it: never named by the link.
  symlinkSync(outside, join(home, "coding_projects", "linked-out"));
  symlinkSync(join(home, "coding_projects", "aerirc"), join(home, "aerirc-link"));
});

after(() => rmSync(root, { recursive: true, force: true }));

function foldersFor(recent: RecentFolder[] = [], extra: Partial<ConstructorParameters<typeof Folders>[0]> = {}): Folders {
  return new Folders({ general: join(home, "Portals"), hide: [join(home, "Hidden-by-config")], own: [join(root, "bridge-own")], sources: [async () => recent], home, temporary: [], ...extra });
}

function searchFor(folders: Folders, options: Partial<FolderSearchOptions> = {}): FolderSearch {
  return new FolderSearch({
    home: folders.homeFolder(),
    refusing: () => folders.refusing(),
    taking: () => folders.taking(),
    listed: async () => (await folders.list()).folders,
    watch: false,
    // A Mac's rules (~/Library, packages, the folders macOS guards), on Linux too; Linux's are tested on their own.
    os: "macos",
    ...options,
  });
}

test("closing a deferred first walk leaves no listing or watchers until a fresh search", async () => {
  const own = join(root, "close-first-walk");
  mkdirSync(join(own, "project"), { recursive: true });
  const folders = new Folders({ home: own, general: own, hide: [], own: [], temporary: [], sources: [] });
  const search = searchFor(folders, { watch: true, firstWaitMs: 10_000 });
  const state = search as any;
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let first = true;
  search.read = async (path) => {
    if (path === own && first) {
      first = false;
      entered();
      await blocked;
    }
    return readdir(path, { withFileTypes: true });
  };
  try {
    const pending = search.search("project");
    await started;
    const walking = state.walking.done;
    search.close();
    assert.equal(state.watchers.size, 0);
    release();
    await walking;
    await pending;
    await state.walking?.done;
    assert.equal(search.walks, 1);
    assert.equal(search.size, 0);
    assert.equal(state.watchers.size, 0);
    assert.equal(state.listing, undefined);
    const fresh = await search.search("project");
    assert.deepEqual(fresh.folders.map((hit) => hit.relative), ["project"]);
    assert.equal(search.walks, 2);
    assert.deepEqual([...state.watchers.keys()].sort(), ["", "project"]);
  } finally {
    release();
    search.close();
  }
});

test("a closed generation's deferred walk cannot replace a fresh generation's watchers", async () => {
  const own = join(root, "close-reopen-walk");
  mkdirSync(join(own, "old"), { recursive: true });
  const folders = new Folders({ home: own, general: own, hide: [], own: [], temporary: [], sources: [] });
  const search = searchFor(folders, { watch: true, firstWaitMs: 10_000 });
  const state = search as any;
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let first = true;
  search.read = async (path) => {
    const entries = await readdir(path, { withFileTypes: true });
    if (path === own && first) {
      first = false;
      entered();
      await blocked;
    }
    return entries;
  };
  try {
    const pending = search.search("old");
    await started;
    const walking = state.walking.done;
    search.close();
    rmSync(join(own, "old"), { recursive: true });
    mkdirSync(join(own, "fresh"));
    await search.search("fresh");
    const watchers = new Map<string, unknown>(state.watchers);
    assert.deepEqual([...watchers.keys()].sort(), ["", "fresh"]);
    release();
    await walking;
    await pending;
    assert.deepEqual([...state.watchers.keys()].sort(), ["", "fresh"]);
    for (const [name, watcher] of watchers) assert.equal(state.watchers.get(name), watcher, name);
    assert.deepEqual(search.folders, ["fresh"]);
    assert.equal(search.walks, 2);
  } finally {
    release();
    search.close();
  }
});

test("Greek partial folder queries narrow and highlight final and ordinary sigma alike", async () => {
  const own = join(root, "greek-folders");
  const names = ["ΟΣ-upper", "ος-lower", "οσ-plain", "İΟΣ-mark"];
  for (const name of names) mkdirSync(join(own, name), { recursive: true });
  const folders = new Folders({ home: own, general: own, hide: [], own: [], temporary: [], sources: [] });
  const search = searchFor(folders);
  try {
    for (const query of ["Ο", "ΟΣ", "ος", "οσ"]) {
      const answer = await search.search(query);
      assert.deepEqual(answer.folders.map((hit) => hit.relative).sort(), [...names].sort(), query);
      for (const hit of answer.folders) {
        const start = hit.relative.startsWith("İ") ? 1 : 0;
        assert.deepEqual(hit.ranges, [[start, start + query.length]], hit.relative);
      }
    }
  } finally {
    search.close();
  }
});

test("a fuzzy query ranks every folder under the home folder, the repository first, and offers none folders.add refuses", async () => {
  const search = searchFor(foldersFor());
  try {
    const answer = await search.search("por");
    assert.equal(answer.mode, "fuzzy");
    assert.equal(answer.home, home);
    assert.equal(answer.refreshing, undefined);
    const relatives = answer.folders.map((hit) => hit.relative);
    // The repository's top first: a match at its name's start, and git.
    assert.equal(relatives[0], "coding_projects/Portals");
    assert.equal(answer.folders[0].git, true);
    assert.equal(answer.folders[0].path, join(home, "coding_projects", "Portals"));
    assert.equal(answer.folders[0].name, "Portals");
    assert.deepEqual(answer.folders[0].ranges, [[16, 19]]);
    assert.ok(relatives.includes("coding_projects/portals-old"));
    assert.ok(relatives.includes("Portals"), "General is offered as any folder");
    // Never: hidden, skipped, ~/Library, packages, hidden by config.json, through a link.
    for (const never of ["portals-dep", "portals-out", "portals-cache", "portals", "Portals.app", "portals-hidden", "portals-secret"]) {
      assert.ok(!answer.folders.some((hit) => hit.name === never && hit.relative !== "Portals"), never);
    }
    assert.ok(answer.folders.every((hit) => hit.path.startsWith(home + "/") && !hit.relative.split("/").some((part) => part.startsWith("."))));
    assert.ok(!search.folders.some((relative) => relative.includes("linked-out") || relative.includes("aerirc-link")));
    assert.ok(!search.folders.includes(""), "the home folder itself is not offered");
    // Several words must each match.
    const both = await search.search("cod old");
    assert.equal(both.folders[0].relative, "coding_projects/portals-old");
    assert.ok(both.folders.every((hit) => hit.relative.startsWith("coding_projects/")));
    assert.deepEqual((await search.search("zzzz")).folders, []);
  } finally {
    search.close();
  }
});

test("the folders folders.list lists and the added ones come before others that match about as well", async () => {
  const now = Date.now();
  const folders = foldersFor([{ path: join(home, "coding_projects", "portals-old"), lastUsed: now - 3600_000 }]);
  const search = searchFor(folders);
  try {
    // Both match at their name's start; the one in use first (a whole name still wins: `portals`).
    const before = (await search.search("port")).folders.map((hit) => hit.relative);
    assert.ok(before.indexOf("coding_projects/portals-old") < before.indexOf("coding_projects/Portals"), before.join());
    const hit = (await search.search("portals")).folders.find((each) => each.relative === "coding_projects/portals-old")!;
    assert.equal(hit.last_used, Math.floor((now - 3600_000) / 1000));
    folders.add(join(home, "Papers", "notes"));
    // Read again after `listedMs`; a new search here.
    const fresh = searchFor(folders);
    const notes = (await fresh.search("no")).folders.find((each) => each.relative === "Papers/notes")!;
    assert.equal(notes.added, true);
    // An empty query: the folders in use, then the repositories.
    const empty = await fresh.search("");
    assert.deepEqual(empty.folders.slice(0, 3).map((each) => each.relative), ["Papers/notes", "coding_projects/portals-old", "coding_projects/Portals"]);
    fresh.close();
  } finally {
    search.close();
  }
});

test("a typed path completes a level at a time, each part fuzzy, as in a terminal", async () => {
  const search = searchFor(foldersFor());
  try {
    const typed = await search.search("~/cod/por");
    assert.equal(typed.mode, "path");
    assert.deepEqual(typed.folders.map((hit) => hit.relative).slice(0, 2), ["coding_projects/Portals", "coding_projects/portals-old"]);
    // `cod` at 0..3, `Por` at 16..19.
    assert.deepEqual(typed.folders[0].ranges, [[0, 3], [16, 19]]);
    // Fuzzy within a part: `cdp` is in coding_projects.
    assert.equal((await search.search("~/cdp/aer")).folders[0]?.relative, "coding_projects/aerirc");
    // The whole path, as a real one.
    assert.equal((await search.search(`${home}/cod/por`)).folders[0].relative, "coding_projects/Portals");
    // Without `~`: from the home folder all the same.
    assert.equal((await search.search("cod/por")).folders[0].relative, "coding_projects/Portals");
    // A trailing `/`: the folder itself, then what it holds (not node_modules or build).
    const listed = await search.search("~/coding_projects/Portals/");
    assert.deepEqual(listed.folders.map((hit) => hit.relative), ["coding_projects/Portals", "coding_projects/Portals/bridge"]);
    // `~/` lists the home folder's folders, never itself, ~/Library or a hidden one.
    const top = (await search.search("~/")).folders.map((hit) => hit.relative).sort();
    assert.deepEqual(top, ["Apps", "Papers", "Portals", "coding_projects"]);
    // A folder the walk skips is found by its name's start, typed on purpose.
    assert.deepEqual((await search.search("~/coding_projects/Portals/node")).folders.map((hit) => hit.relative), ["coding_projects/Portals/node_modules"]);
    assert.deepEqual((await search.search("~/Lib/App")).folders.map((hit) => hit.relative), ["Library/Application Support"]);
    // Nothing outside the home folder, through a link or by its path; nothing hidden or refused.
    assert.deepEqual((await search.search(`${outside}/`)).folders, []);
    assert.deepEqual((await search.search("~/coding_projects/linked-out/")).folders, []);
    assert.deepEqual((await search.search("~/.config/")).folders, []);
    assert.deepEqual((await search.search("~/Hidden-by-config/")).folders, []);
    assert.deepEqual((await search.search("~/Apps/Portals.app/")).folders, []);
  } finally {
    search.close();
  }
});

test("matchPart: a name exactly, then its start, then fuzzy; skipped folders only by their start, packages never", () => {
  assert.ok(matchPart("Portals", "portals", false)!.score > matchPart("Portals-old", "portals", false)!.score);
  assert.ok(matchPart("portals-old", "port", false)!.score > matchPart("transport", "port", false)!.score);
  assert.deepEqual(matchPart("coding_projects", "cdp", false)!.positions, [0, 2, 7]);
  assert.equal(matchPart("node_modules", "nm", false), null);
  assert.notEqual(matchPart("node_modules", "node", false), null);
  assert.equal(matchPart("Library", "lib", false, "macos")?.positions.length, 3);
  assert.equal(matchPart("Library", "", true, "macos"), null);
  assert.notEqual(matchPart("Library", "", false, "macos"), null);
  assert.equal(matchPart("Foo.app", "foo", false, "macos"), null);
  assert.equal(matchPart(".git", ".git", false), null);
});

test("on Linux the walk goes into the folders only macOS guards or shows as files, and leaves out ~/snap", () => {
  for (const name of ["Library", "Documents", "Desktop", "Downloads", "Pictures", "Music"]) {
    assert.equal(walked(name, true, "linux"), true, name);
    assert.equal(walked(name, true, "macos"), false, name);
  }
  assert.equal(walked("Tool.app", false, "linux"), true);
  assert.equal(walked("Tool.app", false, "macos"), false);
  assert.notEqual(matchPart("Tool.app", "tool", false, "linux"), null);
  assert.equal(walked("snap", true, "linux"), false);
  assert.equal(walked("snap", false, "linux"), true);
  assert.equal(walked("snap", true, "macos"), true);
  // What every system leaves out: hidden folders and the ones no one picks.
  assert.equal(walked(".cache", true, "linux"), false);
  assert.equal(walked("node_modules", false, "linux"), false);
});

test("a folder in a git worktree is offered with the folder folders.add adds in its place", async () => {
  const main = join(home, "work", "repo");
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q");
  writeFileSync(join(main, "README.md"), "hello\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "first");
  git(main, "worktree", "add", "-q", "-b", "feature", join(home, "work", "repo-feature"));
  const folders = foldersFor([{ path: main, lastUsed: Date.now() }]);
  const search = searchFor(folders);
  try {
    const hit = (await search.search("repo-feat")).folders[0];
    assert.equal(hit.relative, "work/repo-feature");
    assert.equal(hit.repo, main);
    assert.equal((await search.search("work/repo")).folders.find((each) => each.relative === "work/repo")?.repo, undefined);
  } finally {
    search.close();
    rmSync(join(home, "work"), { recursive: true, force: true });
  }
});

test("the walk is bounded, and a search runs out of time rather than holding the event loop", async () => {
  const bounded = searchFor(foldersFor(), { maxFolders: 5 });
  try {
    const answer = await bounded.search("o");
    assert.equal(answer.truncated, true);
    assert.equal(bounded.size, 5);
  } finally {
    bounded.close();
  }
  let clock = 0;
  const slow = searchFor(foldersFor(), { chunk: 2, budgetMs: 10, now: () => (clock += 4) });
  try {
    const answer = await slow.search("o");
    assert.equal(answer.truncated, true);
    assert.ok(answer.matched < slow.size);
  } finally {
    slow.close();
  }
});

test("a newer search from the same connection replaces an older one", async () => {
  const search = searchFor(foldersFor(), { chunk: 1 });
  const caller = {};
  try {
    await search.search("x", 30, caller);
    const older = search.search("p", 30, caller);
    const newer = search.search("po", 30, caller);
    assert.deepEqual([(await older).superseded, (await older).folders], [true, []]);
    assert.equal((await newer).superseded, undefined);
    assert.ok((await newer).folders.length > 0);
    // Another connection's search is its own.
    const other = search.search("p", 30, {});
    const mine = search.search("po", 30, caller);
    assert.equal((await other).superseded, undefined);
    assert.equal((await mine).superseded, undefined);
  } finally {
    search.close();
  }
});

test("the first search waits a moment for the walk, then answers from what it has, refreshing", async () => {
  const search = searchFor(foldersFor(), { firstWaitMs: 20 });
  let release!: () => void;
  let entered!: () => void;
  const childRead = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  search.read = async (path) => {
    if (path !== home) {
      entered();
      await gate;
    }
    return readdir(path, { withFileTypes: true });
  };
  try {
    const first = search.search("coding");
    await childRead;
    assert.equal((await first).refreshing, true);
    const early = await search.search("coding");
    assert.equal(early.refreshing, true);
    assert.deepEqual(early.folders.map((hit) => hit.relative), ["coding_projects"]);
    release();
    let late = await search.search("por");
    for (let tries = 0; late.refreshing && tries < 100; tries += 1) late = await search.search("por");
    assert.equal(late.refreshing, undefined);
    assert.equal(late.folders[0].relative, "coding_projects/Portals");
    assert.equal(search.walks, 1);
  } finally {
    release();
    search.close();
  }
});

test("where nothing is watched, the home folder is walked again once the listing is old, the old one answering meanwhile", async () => {
  let clock = 1_000_000;
  const search = searchFor(foldersFor(), { unwatchedMs: 1000, now: () => clock });
  try {
    await search.search("x");
    folder("Papers", "brand-new");
    assert.deepEqual((await search.search("brand")).folders, []);
    clock += 2000;
    const meanwhile = await search.search("brand");
    assert.equal(search.walks, 2);
    let found = meanwhile;
    for (let tries = 0; found.folders.length === 0 && tries < 100; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      found = await search.search("brand");
    }
    assert.equal(found.folders[0].relative, "Papers/brand-new");
  } finally {
    search.close();
    rmSync(join(home, "Papers", "brand-new"), { recursive: true, force: true });
  }
});

test("on a Mac, folders made, moved and taken away are found and let go of without walking the home folder again", { skip: process.platform !== "darwin" }, async () => {
  const search = searchFor(foldersFor(), { watch: true });
  // Each change is waited for itself: FSEvents tells of it, and the folder is read again.
  // The deadline bounds native delivery; a silent watch-start gap is recovered by
  // the one-time startup reconcile, covered with a deterministic stand-in too.
  const changeMs = 20_000;
  const until = async (query: string, done: (relatives: string[]) => boolean) => {
    for (const deadline = Date.now() + changeMs; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 25))) {
      const relatives = (await search.search(query)).folders.map((hit) => hit.relative);
      if (done(relatives)) return relatives;
    }
    throw new Error(`${query} never changed as expected`);
  };
  try {
    await search.search("x");
    folder("coding_projects", "freshly-made", "deeper-inside");
    await until("freshly", (relatives) => relatives.includes("coding_projects/freshly-made"));
    await until("deeper", (relatives) => relatives.includes("coding_projects/freshly-made/deeper-inside"));
    renameSync(join(home, "coding_projects", "freshly-made"), join(home, "coding_projects", "renamed-now"));
    await until("deeper", (relatives) => relatives.includes("coding_projects/renamed-now/deeper-inside") && !relatives.some((relative) => relative.startsWith("coding_projects/freshly-made")));
    rmSync(join(home, "coding_projects", "renamed-now"), { recursive: true });
    await until("deeper", (relatives) => relatives.length === 0);
    // A new folder at the top of the home folder, and a repository made in a folder.
    folder("TopNew", "inner-top");
    await until("inner-top", (relatives) => relatives.includes("TopNew/inner-top"));
    mkdirSync(join(home, "TopNew", "inner-top", ".git"));
    for (const deadline = Date.now() + changeMs; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 25))) {
      if ((await search.search("inner-top")).folders[0]?.git) break;
    }
    assert.equal((await search.search("inner-top")).folders[0].git, true);
    assert.equal(search.walks, 1);
    assert.ok(search.reread > 0);
  } finally {
    search.close();
    rmSync(join(home, "TopNew"), { recursive: true, force: true });
  }
});

test("a search not used for a while lets go of the listing", async () => {
  let clock = 0;
  const search = searchFor(foldersFor(), { idleMs: 20, now: () => clock });
  try {
    await search.search("por");
    assert.ok(search.size > 0);
    clock = 1000;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(search.size, 0);
    // And walks again when asked.
    assert.equal((await search.search("por")).folders[0].relative, "coding_projects/Portals");
    assert.equal(search.walks, 2);
  } finally {
    search.close();
  }
});

// MARK: On the wire

test("folders.search on the wire: listed in gateway.ready, a hit added and a thread started there, a linked Mac's through the fleet", async () => {
  const bridge = await startTestBridge({ temporaryFolders: [], userHome: home, config: { generalFolder: join(home, "Portals") } });
  const near = await startTestBridge({ temporaryFolders: [], userHome: outside, config: { generalFolder: outside } });
  try {
    const client = await TestClient.open(bridge);
    assert.ok(client.readyPayload.bridge.features.includes("folder_search"));
    const answer = await client.call("folders.search", { query: "cod por", limit: 5, profile: "fake" });
    assert.equal(answer.home, home);
    assert.equal(answer.folders[0].relative, "coding_projects/Portals");
    assert.equal(answer.folders.length <= 5, true);
    // Not on the list until added; then a thread starts there.
    const chosen = answer.folders[0].path;
    await assert.rejects(createThread(client, { cwd: chosen }), (error: RpcFailure) => error.code === -32602);
    const added = await client.call("folders.add", { path: chosen });
    assert.equal(added.path, chosen);
    const thread = await createThread(client, { cwd: chosen });
    assert.ok(thread);
    // A typed path.
    assert.equal((await client.call("folders.search", { query: "~/pap/not" })).folders[0].relative, "Papers/notes");
    await assert.rejects(client.call("folders.search", { query: "a", limit: "ten" }), (error: RpcFailure) => error.code === -32602);
    await assert.rejects(client.call("folders.search", { query: "a", profile: "nobody" }), (error: RpcFailure) => error.code === -32602);

    // A linked Mac's folders, through the fleet.
    writeLinks(pathsFor(near.home).links, [{ name: "there", url: bridge.url, user: username, password }]);
    const viaNear = await TestClient.open(near);
    const far = await viaNear.call("folders.search", { query: "aer", machine: "there" });
    assert.equal(far.folders[0].relative, "coding_projects/aerirc");
    assert.equal(far.home, home);
    await assert.rejects(viaNear.call("folders.search", { query: "aer", machine: "nowhere" }), (error: RpcFailure) => error.code === 4007 || /no linked Mac/.test(error.message));
    await viaNear.close();
    await client.close();
  } finally {
    await near.dispose();
    await bridge.dispose();
  }
});

// MARK: From Codex's review

test("a typed path neither reads nor counts what is in a folder folders.add refuses", async () => {
  const search = searchFor(foldersFor());
  const read: string[] = [];
  search.read = async (path) => {
    read.push(path);
    return readdir(path, { withFileTypes: true });
  };
  try {
    const answer = await search.search("~/Hidden-by-config/");
    assert.deepEqual([answer.folders, answer.matched], [[], 0]);
    const inside = await search.search("~/Hidden-by-config/port");
    assert.deepEqual([inside.folders, inside.matched, inside.total], [[], 0, (await search.search("~/")).total]);
    assert.ok(!read.some((path) => path.includes("Hidden-by-config")), read.join());
  } finally {
    search.close();
  }
});

test("a change seen while the home folder is walked is not lost: a stale mark waits for the walk, and a first walk done reads what changed", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const search = searchFor(foldersFor(), { firstWaitMs: 20 });
  search.read = async (path) => {
    if (path.startsWith(join(home, "coding_projects"))) await gate;
    return readdir(path, { withFileTypes: true });
  };
  const inner = search as unknown as { stale: boolean; changed: Set<string> };
  try {
    assert.equal((await search.search("doc")).refreshing, true);
    // Read already by the walk, then changed.
    folder("Papers", "late-arrival");
    inner.changed.add("Papers");
    // A watcher said something it could not place: the walk under way does not take it.
    inner.stale = true;
    assert.equal((await search.search("doc")).refreshing, true);
    assert.equal(search.walks, 1);
    release();
    let answer = await search.search("late-arrival");
    for (let tries = 0; answer.refreshing && tries < 200; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      answer = await search.search("late-arrival");
    }
    assert.equal(answer.folders[0]?.relative, "Papers/late-arrival");
    // The stale mark is still there once the first walk is done, and walks again.
    await search.search("late-arrival");
    assert.equal(search.walks, 2, "the stale mark started a walk once the first was done");
  } finally {
    search.close();
    rmSync(join(home, "Papers", "late-arrival"), { recursive: true, force: true });
  }
});

test("a first walk done answers with what changed while it ran, not refreshing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const search = searchFor(foldersFor(), { firstWaitMs: 5000 });
  search.read = async (path) => {
    if (path.startsWith(join(home, "coding_projects"))) await gate;
    return readdir(path, { withFileTypes: true });
  };
  const inner = search as unknown as { changed: Set<string> };
  try {
    const first = search.search("late-second");
    await new Promise((resolve) => setTimeout(resolve, 50));
    folder("Papers", "late-second");
    inner.changed.add("Papers");
    release();
    const answer = await first;
    assert.equal(answer.refreshing, undefined);
    assert.equal(answer.folders[0]?.relative, "Papers/late-second");
  } finally {
    search.close();
    rmSync(join(home, "Papers", "late-second"), { recursive: true, force: true });
  }
});

test("folders past the depth limit make the answer truncated", async () => {
  const search = searchFor(foldersFor(), { maxDepth: 1 });
  try {
    const answer = await search.search("o");
    assert.equal(answer.truncated, true);
    assert.ok(search.folders.every((relative) => !relative.includes("/")));
  } finally {
    search.close();
  }
});

test("changes seen during a walk of the whole home folder are left for the new listing, not read into the old one", async () => {
  const search = searchFor(foldersFor(), { changeWaitMs: 10, firstWaitMs: 10 });
  const inner = search as unknown as { stale: boolean; changed: Set<string> };
  let holdDocuments: (() => void) | undefined;
  let holdCoding: (() => void) | undefined;
  let rebuilding = false;
  let holdNextDocuments = false;
  search.read = async (path) => {
    if (path === join(home, "Papers") && holdNextDocuments) {
      holdNextDocuments = false;
      await new Promise<void>((resolve) => {
        holdDocuments = resolve;
      });
    }
    if (rebuilding && path === join(home, "coding_projects")) {
      await new Promise<void>((resolve) => {
        holdCoding = resolve;
      });
    }
    return readdir(path, { withFileTypes: true });
  };
  try {
    let first = await search.search("x");
    for (let tries = 0; first.refreshing && tries < 100; tries += 1) first = await search.search("x");
    // A change being read in, held there.
    holdNextDocuments = true;
    inner.changed.add("Papers");
    assert.equal((await search.search("x")).refreshing, true);
    // A walk of the whole folder starts, and reads Papers (coding_projects held).
    rebuilding = true;
    inner.stale = true;
    assert.equal((await search.search("x")).refreshing, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Then Papers changes: the new listing's to read again.
    folder("Papers", "during-rebuild");
    inner.changed.add("Papers");
    holdDocuments!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    rebuilding = false;
    holdCoding!();
    let answer = await search.search("during-rebuild");
    for (let tries = 0; (answer.refreshing || answer.folders.length === 0) && tries < 100; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      answer = await search.search("during-rebuild");
    }
    assert.equal(answer.folders[0]?.relative, "Papers/during-rebuild");
    assert.equal(search.walks, 2);
  } finally {
    search.close();
    rmSync(join(home, "Papers", "during-rebuild"), { recursive: true, force: true });
  }
});

test("a first walk done with a stale mark left answers refreshing while it walks again", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const search = searchFor(foldersFor(), { firstWaitMs: 5000 });
  search.read = async (path) => {
    if (path.startsWith(join(home, "coding_projects"))) await gate;
    return readdir(path, { withFileTypes: true });
  };
  const inner = search as unknown as { stale: boolean };
  try {
    const first = search.search("after-read");
    await new Promise((resolve) => setTimeout(resolve, 50));
    folder("Papers", "after-read");
    inner.stale = true;
    release();
    assert.equal((await first).refreshing, true);
    let answer = await search.search("after-read");
    for (let tries = 0; answer.refreshing && tries < 200; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      answer = await search.search("after-read");
    }
    assert.equal(answer.folders[0]?.relative, "Papers/after-read");
    assert.equal(search.walks, 2);
  } finally {
    search.close();
    rmSync(join(home, "Papers", "after-read"), { recursive: true, force: true });
  }
});

test("a search waiting for changes to be read says refreshing when another search started a walk meanwhile", async () => {
  const search = searchFor(foldersFor(), { changeWaitMs: 5000, firstWaitMs: 10 });
  const inner = search as unknown as { stale: boolean; changed: Set<string> };
  let holdDocuments: (() => void) | undefined;
  let holdCoding: (() => void) | undefined;
  let holdNextDocuments = false;
  let rebuilding = false;
  search.read = async (path) => {
    if (path === join(home, "Papers") && holdNextDocuments) {
      holdNextDocuments = false;
      await new Promise<void>((resolve) => {
        holdDocuments = resolve;
      });
    }
    if (rebuilding && path === join(home, "coding_projects")) {
      await new Promise<void>((resolve) => {
        holdCoding = resolve;
      });
    }
    return readdir(path, { withFileTypes: true });
  };
  try {
    let first = await search.search("x");
    for (let tries = 0; first.refreshing && tries < 200; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      first = await search.search("x");
    }
    holdNextDocuments = true;
    inner.changed.add("Papers");
    const waiting = search.search("x", 30, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    rebuilding = true;
    inner.stale = true;
    assert.equal((await search.search("x", 30, {})).refreshing, true);
    holdDocuments!();
    assert.equal((await waiting).refreshing, true);
    rebuilding = false;
    holdCoding?.();
  } finally {
    search.close();
  }
});

test("the folders macOS asks about (Desktop, Documents, Downloads, Pictures, Movies, Music) are neither walked nor watched; a typed path goes in, and a listed folder in one is offered", async () => {
  // A home of its own, under the temporary folder: none of its folders is one macOS guards.
  const guarded = realpathSync(mkdtempSync(join(tmpdir(), "portals-folder-search-tcc-")));
  try {
    const make = (...parts: string[]) => mkdirSync(join(guarded, ...parts), { recursive: true });
    make("code", "proj-code", ".git");
    make("Desktop", "proj-desk");
    make("Documents", "notes", "proj-doc");
    make("Documents", "listed-proj", ".git");
    for (const top of ["Downloads", "Pictures", "Movies", "Music"]) make(top, `proj-${top.toLowerCase()}`);
    make("Docs-of-mine", "proj-mine");
    const folders = new Folders({ general: join(guarded, "code"), hide: [], own: [], sources: [async () => []], home: guarded, temporary: [] });
    const search = new FolderSearch({
      home: guarded,
      refusing: () => folders.refusing(),
      taking: () => folders.taking(),
      listed: async () => (await folders.list()).folders,
      listedMs: 0,
      watch: process.platform === "darwin",
      os: "macos",
    });
    const reads: string[] = [];
    search.read = (path) => {
      reads.push(path);
      return readdir(path, { withFileTypes: true });
    };
    const guardedTops = ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music"];
    const inGuarded = () => reads.filter((path) => guardedTops.some((top) => path === join(guarded, top) || path.startsWith(join(guarded, top) + "/")));
    try {
      const found = (await search.search("proj")).folders.map((hit) => hit.relative).sort();
      assert.deepEqual(found, ["Docs-of-mine/proj-mine", "code/proj-code"]);
      assert.deepEqual(inGuarded(), [], "nothing in a guarded folder is read in the background");
      assert.ok(!search.folders.some((relative) => guardedTops.includes(relative.split("/")[0])));
      if (process.platform === "darwin") {
        const watched = [...(search as unknown as { watchers: Map<string, unknown> }).watchers.keys()].sort();
        assert.deepEqual(watched, ["", "Docs-of-mine", "code"]);
      }
      // `~/` lists none of them either.
      assert.deepEqual((await search.search("~/")).folders.map((hit) => hit.relative).sort(), ["Docs-of-mine", "code"]);
      assert.deepEqual(inGuarded(), []);

      // A folder in one that folders.list lists is offered, and read only as it is.
      folders.add(join(guarded, "Documents", "listed-proj"));
      const listed = await search.search("listed");
      assert.deepEqual(listed.folders.map((hit) => [hit.relative, hit.git, hit.added]), [["Documents/listed-proj", true, true]]);
      assert.deepEqual(listed.folders[0].ranges, [[10, 16]]);
      assert.ok((await search.search("")).folders.some((hit) => hit.relative === "Documents/listed-proj"));
      assert.deepEqual(inGuarded(), []);

      // A path typed into one goes in: the person asked for it.
      const typed = await search.search("~/Doc/no");
      assert.deepEqual(typed.folders.map((hit) => hit.relative), ["Documents/notes"]);
      assert.deepEqual(inGuarded(), [join(guarded, "Documents")]);
      assert.deepEqual((await search.search("~/Downloads/")).folders.map((hit) => hit.relative), ["Downloads", "Downloads/proj-downloads"]);
      // Typed in part, fuzzy, it does not: `~/dcmnts` is not the start of Documents.
      reads.length = 0;
      assert.deepEqual((await search.search("~/dcmnts/")).folders, []);
      assert.deepEqual(inGuarded(), []);
    } finally {
      search.close();
    }
  } finally {
    rmSync(guarded, { recursive: true, force: true });
  }
});

test("a listed folder the walk does not go into, matched by a query, leaves the next query's narrowing to the walked folders' matches", async () => {
  const own = realpathSync(mkdtempSync(join(tmpdir(), "portals-folder-search-narrow-")));
  try {
    for (const parts of [["alpha"], ["zulu"], ["Documents", "alpha"]]) mkdirSync(join(own, ...parts), { recursive: true });
    const folders = new Folders({ general: join(own, "zulu"), hide: [], own: [], sources: [async () => []], home: own, temporary: [] });
    folders.add(join(own, "Documents", "alpha"));
    const search = new FolderSearch({ home: own, refusing: () => folders.refusing(), taking: () => folders.taking(), listed: async () => (await folders.list()).folders, watch: false });
    try {
      assert.deepEqual((await search.search("a")).folders.map((hit) => hit.relative).sort(), ["Documents/alpha", "alpha"]);
      const narrowed = await search.search("al");
      assert.deepEqual(narrowed.folders.map((hit) => hit.relative), ["Documents/alpha", "alpha"]);
      assert.equal(narrowed.matched, 2);
    } finally {
      search.close();
    }
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
});
