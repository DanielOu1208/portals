import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { readdir, rename } from "node:fs/promises";
import { FileSearch, findGit, fold, matters, searchLimitMax, shallowOrder, walk } from "../src/sessions/fileSearch.ts";
import { createThread, startTestBridge, TestClient } from "./helpers.ts";

// The files of a folder ranked against a fuzzy query, for an @-mention (feature
// file_search): git's listing or a walk, only what is inside, kept fresh, bounded.

let root: string;
/** A git repository. */
let repo: string;
/** A folder in no repository. */
let plain: string;
/** Somewhere neither may name. */
let outside: string;
const git = findGit();

function write(path: string, text = "x\n"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function run(folder: string, ...args: string[]): void {
  execFileSync(git!, args, { cwd: folder, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "file-search-")));
  repo = join(root, "repo");
  plain = join(root, "plain");
  outside = join(root, "outside");
  write(join(outside, "secret-outside.txt"));
  write(join(repo, "src", "gateway", "methods.ts"));
  write(join(repo, "src", "sessions", "fileRead.ts"));
  write(join(repo, "README.md"));
  write(join(repo, ".gitignore"), "build/\n*.log\nnode_modules/\n");
  write(join(repo, "build", "out.js"));
  write(join(repo, "debug.log"));
  write(join(repo, "gone.txt"));
  write(join(repo, "node_modules", "dep", "index.js"));
  write(join(repo, "Packages", "PortalsKit", "Sources", "HermesBackend", "HermesWire.swift"));
  symlinkSync(outside, join(repo, "linked-out"));
  if (git) {
    run(repo, "init", "-q");
    run(repo, "add", "-A");
    run(repo, "commit", "-q", "-m", "first");
    unlinkSync(join(repo, "gone.txt"));
  }
  write(join(repo, "untracked-notes.md"));
  write(join(plain, "docs", "plan.md"));
  write(join(plain, "src", "main.swift"));
  write(join(plain, "node_modules", "dep", "index.js"));
  write(join(plain, ".git", "HEAD"), "ref: refs/heads/main\n");
  write(join(plain, "DerivedData", "Build", "x.o"));
  write(join(plain, ".DS_Store"));
  symlinkSync(outside, join(plain, "linked-out"));
});

after(() => rmSync(root, { recursive: true, force: true }));

async function all(search: FileSearch, folder: string): Promise<string[]> {
  // Every entry: a query each path matches ("" lists the shallowest only).
  const answer = await search.search(folder, "", 200);
  return answer.files.map((hit) => `${hit.kind === "folder" ? "d" : "f"} ${hit.path}`).sort();
}

test("empty-query selection matches a stable full sort, including ties and short listings, without sorting the whole listing", () => {
  type Entry = { path: string; kind: 0 | 1 };
  let largestSort = 0;
  function check(entries: Entry[]): void {
    const listing = {
      paths: entries.map(({ path }) => path),
      lower: entries.map(({ path }) => fold(path)),
      kinds: entries.map(({ kind }) => kind),
      size: entries.length,
    };
    const depths = listing.paths.map((path) => path.split("/").length - 1);
    const expected = entries.map((_, index) => index).sort((a, b) => {
      const rank = depths[a] - depths[b] || listing.kinds[b] - listing.kinds[a];
      if (rank !== 0) return rank;
      if (listing.lower[a] < listing.lower[b]) return -1;
      return listing.lower[a] > listing.lower[b] ? 1 : 0;
    }).slice(0, searchLimitMax);
    const sort = Array.prototype.sort;
    let actual: number[];
    try {
      Array.prototype.sort = function (compare) {
        largestSort = Math.max(largestSort, this.length);
        return sort.call(this, compare);
      };
      actual = shallowOrder(listing);
    } finally {
      Array.prototype.sort = sort;
    }
    assert.deepEqual(actual, expected);
  }

  // Every later entry wins; none does; and the cutoff splits case-folded ties.
  const descending: Entry[] = Array.from({ length: 900 }, (_, index) => ({
    path: `${"nested/".repeat(8 - Math.floor(index / 100))}${String(900 - index).padStart(3, "0")}`,
    kind: index % 2 ? 0 : 1,
  }));
  check(descending);
  check([...descending].reverse());
  check(Array.from({ length: 500 }, (_, index) => ({ path: ["same", "Same", "SAME"][index % 3], kind: 1 })));
  check(Array.from({ length: 500 }, (_, index) => ({ path: "same", kind: index % 2 ? 0 : 1 })));

  let seed = 12345;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const names = ["a", "A", "z", "é", "É", "Σ", "ς", "İ", "😀", "file.ts"];
  const counts = [0, 1, 2, 17, 199, 200, 201, 500, 2000];
  for (let trial = 0; trial < 90; trial += 1) {
    check(Array.from({ length: counts[trial % counts.length] }, () => ({
      path: Array.from({ length: 1 + Math.floor(random() * 8) }, () => names[Math.floor(random() * names.length)]).join("/"),
      kind: random() < 0.5 ? 0 : 1,
    })));
  }
  assert.ok(largestSort <= searchLimitMax, `sorted ${largestSort} entries to retain ${searchLimitMax}`);
});

test("in a repository: git's files, tracked and untracked not ignored, less the deleted, with their folders; nothing ignored or outside", { skip: git === null && "no git on this Mac" }, async () => {
  const search = new FileSearch({ watch: false });
  try {
    const answer = await search.search(repo, "", 200);
    assert.equal(answer.source, "git");
    const listed = await all(search, repo);
    assert.deepEqual(listed, [
      "d Packages", "d Packages/PortalsKit", "d Packages/PortalsKit/Sources", "d Packages/PortalsKit/Sources/HermesBackend", "d src", "d src/gateway", "d src/sessions",
      "f .gitignore", "f Packages/PortalsKit/Sources/HermesBackend/HermesWire.swift", "f README.md", "f linked-out", "f src/gateway/methods.ts", "f src/sessions/fileRead.ts", "f untracked-notes.md",
    ]);
    // The link is named, never what it leads to.
    assert.ok((await search.search(repo, "secret-outside.txt", 200)).files.every((hit) => !hit.path.includes("secret-outside")));
  } finally {
    search.close();
  }
});

test("git runs no command a repository's config names: its file system monitor is off", { skip: git === null && "no git on this Mac" }, async () => {
  const hostile = join(root, "hostile");
  const marker = join(root, "fsmonitor-ran");
  write(join(hostile, "a.txt"));
  run(hostile, "init", "-q");
  run(hostile, "add", "-A");
  run(hostile, "commit", "-q", "-m", "a");
  const hook = join(root, "fsmonitor.sh");
  writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  run(hostile, "config", "core.fsmonitor", hook);
  // As git itself does, without the setting the bridge gives.
  execFileSync(git!, ["ls-files", "--others"], { cwd: hostile, stdio: "ignore" });
  assert.ok(existsSync(marker), "git runs the monitor by itself");
  rmSync(marker);
  const search = new FileSearch({ watch: false });
  try {
    assert.equal((await search.search(hostile, "a.txt", 10)).source, "git");
    assert.equal(existsSync(marker), false);
  } finally {
    search.close();
  }
});

test("a folder git ignores whole is walked", { skip: git === null && "no git on this Mac" }, async () => {
  write(join(repo, "build", "inner", "made.js"));
  const search = new FileSearch({ watch: false });
  try {
    const answer = await search.search(join(repo, "build"), "made", 10);
    assert.equal(answer.source, "walk");
    assert.deepEqual(answer.files.map((hit) => hit.path), ["inner/made.js"]);
  } finally {
    search.close();
  }
});

test("an untracked repository inside is one folder, not also a file with no name", { skip: git === null && "no git on this Mac" }, async () => {
  const folder = join(root, "outer");
  write(join(folder, "a.txt"));
  run(folder, "init", "-q");
  write(join(folder, "inner", "b.txt"));
  run(join(folder, "inner"), "init", "-q");
  const search = new FileSearch({ watch: false });
  try {
    assert.deepEqual(await all(search, folder), ["d inner", "f a.txt"]);
    const hits = (await search.search(folder, "inner", 10)).files;
    assert.deepEqual(hits.map((hit) => [hit.path, hit.name, hit.kind]), [["inner", "inner", "folder"]]);
  } finally {
    search.close();
  }
});

test("elsewhere: a walk that skips node_modules, .git, DerivedData and .DS_Store, and follows no link", async () => {
  const search = new FileSearch({ watch: false });
  try {
    const answer = await search.search(plain, "", 200);
    assert.equal(answer.source, "walk");
    assert.deepEqual(await all(search, plain), ["d docs", "d src", "f docs/plan.md", "f linked-out", "f src/main.swift"]);
    assert.ok((await search.search(plain, "secret-outside.txt", 200)).files.every((hit) => !hit.path.includes("secret-outside")));
  } finally {
    search.close();
  }
});

test("without git a repository is walked, its .git and node_modules skipped", async () => {
  const search = new FileSearch({ git: null, watch: false });
  try {
    const answer = await search.search(repo, "", 200);
    assert.equal(answer.source, "walk");
    const paths = answer.files.map((hit) => hit.path);
    assert.ok(paths.includes("README.md"));
    assert.ok(!paths.some((path) => path.startsWith(".git/") || path === ".git" || path.startsWith("node_modules")));
  } finally {
    search.close();
  }
});

test("ranking: a file's name first, then the path; each word of the query must match; the ranges are what matched", async () => {
  const search = new FileSearch({ watch: false });
  try {
    const read = await search.search(repo, "fileread", 10);
    assert.equal(read.files[0].path, "src/sessions/fileRead.ts");
    assert.equal(read.files[0].name, "fileRead.ts");
    assert.equal(read.files[0].kind, "file");
    assert.deepEqual(read.files[0].ranges, [[13, 21]]);
    assert.equal(read.files[0].path.slice(13, 21), "fileRead");

    const methods = await search.search(repo, "gw meth", 10);
    assert.equal(methods.files[0].path, "src/gateway/methods.ts");
    assert.equal(methods.matched, 1);

    // A folder is found as a folder.
    const folder = await search.search(repo, "hermesbackend", 10);
    assert.deepEqual([folder.files[0].path, folder.files[0].kind], ["Packages/PortalsKit/Sources/HermesBackend", "folder"]);

    // Nothing for what no path holds in order.
    assert.equal((await search.search(repo, "zzq", 10)).files.length, 0);
    // Case does not matter.
    assert.equal((await search.search(repo, "README", 10)).files[0].path, "README.md");
    assert.equal((await search.search(repo, "readme", 10)).files[0].path, "README.md");
  } finally {
    search.close();
  }
});

test("ranges fall on the path's own characters, also past ASCII: an emoji, and a capital whose small form is longer", async () => {
  const folder = join(root, "unicode");
  write(join(folder, "notes", "🚀launch.md"));
  write(join(folder, "İstanbul-trip.md"));
  write(join(folder, "Über.md"));
  const search = new FileSearch({ watch: false });
  try {
    const launch = (await search.search(folder, "launch", 5)).files[0];
    assert.deepEqual(launch.ranges, [[8, 14]]);
    assert.equal(launch.path.slice(8, 14), "launch");
    const trip = (await search.search(folder, "trip", 5)).files[0];
    assert.equal(trip.path, "İstanbul-trip.md");
    assert.equal(trip.path.slice(trip.ranges[0][0], trip.ranges[0][1]), "trip");
    const uber = (await search.search(folder, "über", 5)).files[0];
    assert.equal(uber.path, "Über.md");
    assert.deepEqual(uber.ranges, [[0, 4]]);
  } finally {
    search.close();
  }
});

test("matching past ASCII: an emoji's two halves only together, and capitals folded the same in the path and the query", async () => {
  const folder = join(root, "unicode-fold");
  write(join(folder, "😁🪀.md"));
  write(join(folder, "🚀launch.md"));
  write(join(folder, "İstanbul.md"));
  write(join(folder, "İÜBER.md"));
  const search = new FileSearch({ watch: false });
  try {
    // 🚀 and 😁🪀 share their halves: 😁 starts as 🚀 does, 🪀 ends as it does.
    const rocket = (await search.search(folder, "🚀", 10)).files;
    assert.deepEqual(rocket.map((hit) => [hit.path, hit.ranges]), [["🚀launch.md", [[0, 2]]]]);
    for (const query of ["İstanbul", "istanbul", "İSTANBUL"]) {
      const hits = (await search.search(folder, query, 10)).files;
      assert.deepEqual(hits.map((hit) => hit.path), ["İstanbul.md"], query);
      assert.equal(hits[0].path.slice(hits[0].ranges[0][0], hits[0].ranges[0][1]), "İstanbul", query);
    }
    const uber = (await search.search(folder, "über", 10)).files;
    assert.deepEqual(uber.map((hit) => [hit.path, hit.ranges]), [["İÜBER.md", [[1, 5]]]]);
  } finally {
    search.close();
  }
});

test("a query typed on narrows the last one's matches and answers as a fresh search would", async () => {
  const typed = new FileSearch({ watch: false, unwatchedMs: 60_000 });
  const fresh = new FileSearch({ watch: false, unwatchedMs: 60_000 });
  try {
    for (const query of ["s", "sr", "src", "src s", "src se", "src ses"]) {
      const a = await typed.search(repo, query, 50);
      const b = await fresh.search(repo, query, 50);
      fresh.close();
      assert.deepEqual(a.files, b.files, query);
      assert.equal(a.matched, b.matched, query);
    }
    assert.equal(typed.listings, 1);
  } finally {
    typed.close();
    fresh.close();
  }
});

test("Greek basenames fold final and ordinary sigma alike while narrowing and highlighting", async () => {
  const folder = join(root, "greek-fold");
  for (const name of ["ΟΣ.md", "ος.txt", "οσ.js", "İΟΣ.md"]) write(join(folder, name));
  const search = new FileSearch({ git: null, watch: false });
  try {
    for (const query of ["Ο", "ΟΣ", "ος", "οσ"]) {
      const answer = await search.search(folder, query);
      assert.deepEqual(answer.files.map((hit) => hit.path).sort(), ["ΟΣ.md", "ος.txt", "οσ.js", "İΟΣ.md"].sort(), query);
      for (const hit of answer.files) {
        const start = hit.path.startsWith("İ") ? 1 : 0;
        assert.deepEqual(hit.ranges, [[start, start + query.length]], hit.path);
        assert.equal(fold(hit.path.slice(start, start + query.length)), fold(query));
      }
    }
    assert.equal(fold("İΟΣ"), "iοσ");
    assert.equal(fold("İος"), "iοσ");
    assert.equal(fold("🚀ΟΣ.md").length, "🚀ΟΣ.md".length);
  } finally {
    search.close();
  }
});

test("a watched folder's listing follows files made and removed", async () => {
  const folder = join(root, "watched");
  write(join(folder, "first.txt"));
  const search = new FileSearch();
  try {
    assert.deepEqual((await search.search(folder, "first", 10)).files.map((hit) => hit.path), ["first.txt"]);
    assert.equal((await search.search(folder, "second", 10)).files.length, 0);
    write(join(folder, "deep", "second.txt"));
    const found = await eventually(async () => (await search.search(folder, "second", 10)).files.map((hit) => hit.path));
    assert.deepEqual(found, ["deep/second.txt"]);
    unlinkSync(join(folder, "first.txt"));
    await eventually(async () => ((await search.search(folder, "first", 10)).files.length === 0 ? [] : null), (value) => value !== null);
    const listings = search.listings;
    // Nothing changed: no listing again.
    await search.search(folder, "deep", 10);
    await search.search(folder, "deep", 10);
    assert.equal(search.listings, listings);
  } finally {
    search.close();
  }
});

test("a watched repository follows what git's listing reads: info/exclude, a tracked folder with a skipped name, and the index of a repository above", { skip: git === null && "no git on this Mac" }, async () => {
  const folder = join(root, "git-watched");
  write(join(folder, "dist", "bundle.js"));
  write(join(folder, "sub", "tracked.log"));
  write(join(folder, "sub", "other.txt"));
  run(folder, "init", "-q");
  run(folder, "add", "-A");
  run(folder, "commit", "-q", "-m", "first");
  write(join(folder, ".gitignore"), "*.log\n");
  // Untracked: an ignore rule can leave it out.
  write(join(folder, "keep.txt"));
  const search = new FileSearch();
  const sub = new FileSearch();
  try {
    assert.deepEqual((await search.search(folder, "bundle", 10)).files.map((hit) => hit.path), ["dist/bundle.js"]);
    // A new file in the tracked dist, not ignored: git lists it.
    write(join(folder, "dist", "chunk.js"));
    assert.deepEqual(await eventually(async () => (await search.search(folder, "chunk", 10)).files.map((hit) => hit.path)), ["dist/chunk.js"]);
    // Ignored through .git/info/exclude: git leaves it out.
    writeFileSync(join(folder, ".git", "info", "exclude"), "keep.txt\n");
    await eventually(async () => ((await search.search(folder, "keep", 10)).files.length === 0 ? [] : null), (value) => value !== null);
    // A subfolder of the repository: its index is outside, and git rm --cached changes
    // only the index (the file stays, ignored now, so git no longer lists it).
    assert.deepEqual((await sub.search(join(folder, "sub"), "tracked", 10)).files.map((hit) => hit.path), ["tracked.log"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    run(folder, "rm", "-q", "--cached", "sub/tracked.log");
    await eventually(async () => ((await sub.search(join(folder, "sub"), "tracked", 10)).files.length === 0 ? [] : null), (value) => value !== null);
  } finally {
    search.close();
    sub.close();
  }
});

test("a git listing reads again soon after a change in an ignored skipped folder, and that of a subfolder after a while (ignore rules above it)", { skip: git === null && "no git on this Mac" }, async () => {
  const folder = join(root, "git-doubtful");
  write(join(folder, "README.md"));
  write(join(folder, ".gitignore"), "*.log\n");
  write(join(folder, "dist", "debug.log"));
  write(join(folder, "sub", "kept.txt"));
  run(folder, "init", "-q");
  run(folder, "add", "-A");
  run(folder, "commit", "-q", "-m", "first");
  write(join(folder, "sub", "untracked-notes.md"));
  const search = new FileSearch({ doubtfulMs: 200, externalMs: 300 });
  try {
    assert.equal((await search.search(folder, "source", 10)).files.length, 0);
    // dist holds only ignored files, so git listed no dist: a file there not ignored is
    // found all the same.
    write(join(folder, "dist", "source.ts"));
    assert.deepEqual(await eventually(async () => (await search.search(folder, "source", 10)).files.map((hit) => hit.path)), ["dist/source.ts"]);
    // A subfolder: the repository's info/exclude is outside it.
    assert.deepEqual((await search.search(join(folder, "sub"), "untracked", 10)).files.map((hit) => hit.path), ["untracked-notes.md"]);
    writeFileSync(join(folder, ".git", "info", "exclude"), "untracked-notes.md\n");
    await eventually(async () => ((await search.search(join(folder, "sub"), "untracked", 10)).files.length === 0 ? [] : null), (value) => value !== null);
  } finally {
    search.close();
  }
});

test("a repository's git folder that cannot be watched leaves its listing fresh only as long as an unwatched one", async () => {
  const folder = join(root, "git-unwatchable");
  write(join(folder, "a.txt"));
  // A stand-in git: its git folder is one that does not exist, so it cannot be watched.
  const fakeGit = join(root, "unwatchable-git");
  writeFileSync(fakeGit, `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = "--deleted" ] && exit 0; [ "$arg" = "--absolute-git-dir" ] && { echo '${join(root, "no-such-git-dir")}'; exit 0; }; done\nprintf 'a.txt\\0'\n`, { mode: 0o755 });
  let now = 1000;
  const search = new FileSearch({ git: fakeGit, unwatchedMs: 500, now: () => now });
  try {
    // The folder's own watcher given time to settle: nothing changes in it after.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await search.search(folder, "a", 10)).source, "git");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const listings = search.listings;
    await search.search(folder, "a", 10);
    assert.equal(search.listings, listings);
    now += 600;
    await search.search(folder, "a", 10);
    assert.equal(search.listings, listings + 1);
  } finally {
    search.close();
  }
});

test("a folder swapped for a link to elsewhere after it was checked lists nothing from there", async () => {
  const folder = join(root, "swapped-root");
  write(join(folder, "mine.txt"));
  for (const gitToUse of [null, git]) {
    const search = new FileSearch({ git: gitToUse, watch: false, unwatchedMs: 0 });
    try {
      assert.deepEqual((await search.search(folder, "mine", 10)).files.map((hit) => hit.path), ["mine.txt"]);
      await rename(folder, `${folder}-moved`);
      symlinkSync(outside, folder);
      const answer = await search.search(folder, "secret", 10);
      assert.deepEqual(answer.files, [], String(gitToUse));
    } finally {
      search.close();
      unlinkSync(folder);
      await rename(`${folder}-moved`, folder);
    }
  }
});

test("the walk keeps nothing read through a folder swapped for a link between being seen and being read", async () => {
  const folder = join(root, "swapped");
  write(join(folder, "safe", "inside.txt"));
  write(join(folder, "top.txt"));
  const listing = await walk(folder, 0, 1000, async (path) => {
    if (path === join(folder, "safe")) {
      // Another process swaps it for a link to elsewhere just before it is read.
      await rename(join(folder, "safe"), join(folder, "safe-moved"));
      symlinkSync(outside, join(folder, "safe"));
    }
    return readdir(path, { withFileTypes: true });
  });
  assert.deepEqual([...listing.paths].sort(), ["safe", "top.txt"]);
});

test("a folder not watched is listed again once its listing is older than unwatchedMs", async () => {
  const folder = join(root, "unwatched");
  write(join(folder, "a.txt"));
  let now = 1000;
  const search = new FileSearch({ watch: false, unwatchedMs: 500, now: () => now });
  try {
    await search.search(folder, "a", 10);
    write(join(folder, "b.txt"));
    assert.equal((await search.search(folder, "b.txt", 10)).files.length, 0);
    now += 600;
    assert.deepEqual((await search.search(folder, "b.txt", 10)).files.map((hit) => hit.path), ["b.txt"]);
    assert.equal(search.listings, 2);
  } finally {
    search.close();
  }
});

test("a folder slow to list again is answered from its listing before, said to be refreshing, and from the new one after", async () => {
  const folder = join(root, "slow");
  const list = join(root, "slow-list.txt");
  write(join(folder, "a.txt"));
  writeFileSync(list, "a.txt\0");
  // A git that takes 300 ms to list what the list file says, and lists nothing deleted.
  const slowGit = join(root, "slow-git");
  writeFileSync(slowGit, `#!/bin/sh\nsleep 0.3\nfor arg in "$@"; do [ "$arg" = "--deleted" ] && exit 0; done\ncat '${list}'\n`, { mode: 0o755 });
  let now = 1000;
  const search = new FileSearch({ git: slowGit, watch: false, unwatchedMs: 100, refreshWaitMs: 50, now: () => now });
  try {
    const first = await search.search(folder, "", 10);
    assert.deepEqual(first.files.map((hit) => hit.path), ["a.txt"]);
    assert.equal(first.refreshing, undefined);
    writeFileSync(list, "a.txt\0b.txt\0");
    now += 200;
    const during = await search.search(folder, "", 10);
    assert.deepEqual(during.files.map((hit) => hit.path), ["a.txt"]);
    assert.equal(during.refreshing, true);
    // Asked again meanwhile: the same listing under way, not another, and still said to be
    // refreshing (a device that stops asking on an answer without it would miss b.txt).
    const again = await search.search(folder, "", 10);
    assert.deepEqual(again.files.map((hit) => hit.path), ["a.txt"]);
    assert.equal(again.refreshing, true);
    // Once the listing is in (300 ms of the stand-in, and starting it, longer under load).
    const after = await eventually(async () => {
      const answer = await search.search(folder, "", 10);
      return answer.refreshing ? null : answer;
    });
    assert.deepEqual(after.files.map((hit) => hit.path), ["a.txt", "b.txt"]);
    assert.equal(search.listings, 2);
  } finally {
    search.close();
  }
});

test("a watched folder being listed again stays said to be refreshing for every search until the new listing is in", async () => {
  const folder = join(root, "slow-watched");
  const list = join(root, "slow-watched-list.txt");
  write(join(folder, "a.txt"));
  writeFileSync(list, "a.txt\0");
  const slowGit = join(root, "slow-watched-git");
  writeFileSync(slowGit, `#!/bin/sh\nsleep 0.5\nfor arg in "$@"; do [ "$arg" = "--deleted" ] && exit 0; done\ncat '${list}'\n`, { mode: 0o755 });
  // Watched on Linux too, where a FileSearch watches nothing unless told to.
  const search = new FileSearch({ git: slowGit, refreshWaitMs: 20, watch: true });
  try {
    await search.search(folder, "", 10);
    writeFileSync(list, "a.txt\0b.txt\0");
    write(join(folder, "b.txt"));
    // The watcher marks the listing stale (given time for its events to come in); the
    // search after starts the listing again.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const during = await search.search(folder, "", 10);
    assert.equal(during.refreshing, true);
    const again = await search.search(folder, "", 10);
    assert.equal(again.refreshing, true);
    assert.deepEqual(again.files.map((hit) => hit.path), ["a.txt"]);
    const after = await eventually(async () => {
      const answer = await search.search(folder, "", 10);
      return answer.refreshing ? null : answer.files.map((hit) => hit.path);
    });
    assert.deepEqual(after, ["a.txt", "b.txt"]);
  } finally {
    search.close();
  }
});

test("bounded: a folder's paths past maxEntries are left out and said to be, and the least recently searched folder is let go of", async () => {
  const many = join(root, "many");
  for (let index = 0; index < 30; index += 1) write(join(many, `f${String(index).padStart(2, "0")}.txt`));
  const search = new FileSearch({ watch: false, maxEntries: 10, maxFolders: 2 });
  try {
    const answer = await search.search(many, "", 200);
    assert.equal(answer.total, 10);
    assert.equal(answer.truncated, true);
    await search.search(plain, "", 10);
    await search.search(repo, "", 10);
    assert.deepEqual(search.folders, [plain, repo]);
  } finally {
    search.close();
  }
  const total = new FileSearch({ watch: false, maxTotalEntries: 12 });
  try {
    await total.search(plain, "", 10);
    await total.search(repo, "", 10);
    assert.deepEqual(total.folders, [repo]);
  } finally {
    total.close();
  }
});

test("a listing made again lets go of the one before, also where the last query's matches pointed into it", async () => {
  const folder = join(root, "relisted");
  write(join(folder, "a.txt"));
  write(join(folder, "b.txt"));
  let now = 1000;
  const search = new FileSearch({ watch: false, unwatchedMs: 100, now: () => now });
  try {
    await search.search(folder, "a", 10);
    write(join(folder, "c.txt"));
    now += 200;
    // An empty query keeps no matches: only the new listing (three files) should be held.
    assert.equal((await search.search(folder, "", 10)).total, 3);
    assert.equal(search.entriesHeld, 3);
  } finally {
    search.close();
  }
});

test("a folder a device names is checked once in folderCheckMs, and a refusal is not kept", async () => {
  let now = 0;
  const search = new FileSearch({ watch: false, folderCheckMs: 1000, now: () => now });
  let checks = 0;
  const check = async () => {
    checks += 1;
    return "/real";
  };
  try {
    assert.equal(await search.checkedFolder("~/a", check), "/real");
    assert.equal(await search.checkedFolder("~/a", check), "/real");
    assert.equal(checks, 1);
    now += 1000;
    await search.checkedFolder("~/a", check);
    assert.equal(checks, 2);
    await assert.rejects(search.checkedFolder("/no", async () => {
      throw new Error("refused");
    }));
    await assert.rejects(search.checkedFolder("/no", async () => {
      throw new Error("refused again");
    }), /again/);
  } finally {
    search.close();
  }
});

test("what a change in the folder counts for: not in skipped folders, and in .git only its index and HEAD", () => {
  assert.equal(matters("src/a.ts"), true);
  assert.equal(matters(".gitignore"), true);
  // In a skipped folder git listed nothing in: doubtful (a git listing is made again within doubtfulMs).
  assert.equal(matters("node_modules/x/y.js"), "doubtful");
  assert.equal(matters("app/DerivedData/x"), "doubtful");
  assert.equal(matters("nested/.git/index"), false);
  assert.equal(matters(".git/index"), true);
  assert.equal(matters(".git/HEAD"), true);
  assert.equal(matters(".git/objects/ab/cdef"), false);
  assert.equal(matters(".git/index.lock"), false);
  // A folder named like a skipped one is a change all the same.
  assert.equal(matters("node_modules"), true);
  // git's own ignore list for the repository is read with every listing.
  assert.equal(matters(".git/info/exclude"), true);
  assert.equal(matters(".git/info/attributes"), false);
  // A skipped folder git listed something in (a tracked dist) counts.
  assert.equal(matters("dist/new.js"), "doubtful");
  assert.equal(matters("dist/new.js", new Set(["dist"])), true);
  assert.equal(matters("app/dist/x/y.js", new Set(["app/dist"])), true);
  assert.equal(matters("node_modules/x.js", new Set(["dist"])), "doubtful");
});

test("findGit: one on the PATH other than macOS's stub", () => {
  const bin = join(root, "bin");
  write(join(bin, "git"));
  assert.equal(findGit(`/usr/bin:${bin}`), join(bin, "git"));
  // macOS's stub however the PATH spells it, or a link to it, is passed over too.
  assert.equal(findGit(`/usr/bin/:/usr//bin:${bin}`), join(bin, "git"));
  const linked = join(root, "linked-bin");
  mkdirSync(linked, { recursive: true });
  if (existsSync("/usr/bin/git")) symlinkSync("/usr/bin/git", join(linked, "git"));
  assert.equal(findGit(`${linked}:${bin}`), join(bin, "git"));
});

// MARK: On the wire

test("files.search on the wire: listed in gateway.ready, for a thread not followed and for a folder on the list, refused for others", async () => {
  const general = join(root, "general");
  write(join(general, "notes", "meeting.md"));
  write(join(general, "todo.txt"));
  const bridge = await startTestBridge({ temporaryFolders: [], config: { generalFolder: general } });
  try {
    const client = await TestClient.open(bridge);
    assert.ok(client.readyPayload.bridge.features.includes("file_search"));
    const thread = await createThread(client);
    const other = await TestClient.open(bridge);
    const answer = await other.call("files.search", { session_id: thread, query: "meet" });
    assert.equal(answer.folder, general);
    assert.equal(answer.source, "walk");
    assert.deepEqual(answer.files.map((hit: any) => [hit.path, hit.name, hit.kind]), [["notes/meeting.md", "meeting.md", "file"]]);
    assert.deepEqual(answer.files[0].ranges, [[6, 10]]);
    const byFolder = await other.call("files.search", { folder: general, query: "", limit: 1 });
    assert.deepEqual(byFolder.files.map((hit: any) => hit.path), ["notes"]);
    await assert.rejects(other.call("files.search", { folder: outside, query: "secret" }), (error: any) => error.code === -32602);
    await assert.rejects(other.call("files.search", { session_id: "no-such-thread", query: "a" }), (error: any) => error.code === 4007);
    await assert.rejects(other.call("files.search", { query: "a" }), (error: any) => error.code === -32602);
    await assert.rejects(other.call("files.search", { session_id: thread, query: "a", limit: "ten" }), (error: any) => error.code === -32602);
    await other.close();
    await client.close();
  } finally {
    await bridge.dispose();
  }
});

async function eventually<T>(read: () => Promise<T | null>, done: (value: T | null) => boolean = (value) => value !== null && (!Array.isArray(value) || value.length > 0)): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (done(value)) return value as T;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
