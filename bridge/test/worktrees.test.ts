import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { Folders, type RecentFolder } from "../src/folders.ts";
import { threadRepo, worktreeOf } from "../src/git.ts";
import { noteRepos } from "../src/sessions/manager.ts";
import { Registry } from "../src/sessions/registry.ts";
import { createThread, RpcFailure, runTurn, startTestBridge, TestClient, type Frame } from "./helpers.ts";

// Worktrees under their repository (feature worktrees): a folder in a git worktree is
// listed as its repository's main checkout, in `folders.list` and with each thread, which
// keeps it once the worktree is gone; new threads may start in a worktree of a folder on
// the list, and nowhere else new. Real repositories and worktrees, made with git in the
// temporary folder.

let root: string;
/** A repository with a commit: `main` (its main checkout), with `main/src/app`. */
let main: string;
/** Worktrees of it: `feature` beside it, `inside` under its `.claude/worktrees`. */
let feature: string;
let inside: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A repository at `path` with one commit. */
function repository(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  writeFileSync(join(path, "README.md"), "hello\n");
  git(path, "add", ".");
  git(path, "commit", "-q", "-m", "first");
  return realpathSync(path);
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "portals-worktrees-test-")));
  main = repository(join(root, "Portals"));
  mkdirSync(join(main, "src", "app"), { recursive: true });
  writeFileSync(join(main, "src", "app", "main.swift"), "print(1)\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "app");
  git(main, "worktree", "add", "-q", "-b", "night/feature", join(root, "portals-feature"));
  feature = realpathSync(join(root, "portals-feature"));
  git(main, "worktree", "add", "-q", "-b", "claude/fix", join(main, ".claude", "worktrees", "fix"));
  inside = realpathSync(join(main, ".claude", "worktrees", "fix"));
});

after(() => rmSync(root, { recursive: true, force: true }));

test("a worktree's folders are its repository's main checkout's, as git itself says", () => {
  // git's own answer, for the record: the main checkout's `.git`.
  assert.equal(realpathSync(resolve(feature, git(feature, "rev-parse", "--git-common-dir"))), join(main, ".git"));
  assert.deepEqual(worktreeOf(feature), { repo: main, main, top: feature });
  // A folder in it is the main checkout's matching one, or its top where it has none.
  assert.deepEqual(worktreeOf(join(feature, "src", "app")), { repo: join(main, "src", "app"), main, top: feature });
  mkdirSync(join(feature, "src", "new-on-branch"), { recursive: true });
  assert.deepEqual(worktreeOf(join(feature, "src", "new-on-branch")), { repo: main, main, top: feature });
  // One kept inside the main checkout, as Claude Code keeps its own.
  assert.deepEqual(worktreeOf(inside), { repo: main, main, top: inside });
  // Through a symlink: by real paths.
  const link = join(root, "feature-link");
  execFileSync("ln", ["-s", feature, link]);
  assert.deepEqual(worktreeOf(link), { repo: main, main, top: feature });
});

test("the main checkout, a folder in it, a plain folder and one that is not there are in no worktree", () => {
  assert.equal(worktreeOf(main), null);
  assert.equal(worktreeOf(join(main, "src", "app")), null);
  assert.equal(worktreeOf(join(main, ".claude")), null);
  const plain = join(root, "plain");
  mkdirSync(plain, { recursive: true });
  assert.equal(worktreeOf(plain), null);
  assert.equal(worktreeOf(join(root, "missing")), null);
});

test("a submodule, a bare repository's worktree and a `.git` file naming nothing are no worktree of a checkout", () => {
  const library = repository(join(root, "library"));
  const host = repository(join(root, "host"));
  git(host, "submodule", "add", "-q", library, "vendor/library");
  const submodule = realpathSync(join(host, "vendor", "library"));
  // Its `.git` is a file too, naming a folder of the host's with no `commondir`.
  assert.match(git(submodule, "rev-parse", "--git-dir"), /\.git\/modules\/vendor\/library$/);
  assert.equal(worktreeOf(submodule), null);

  const bare = join(root, "bare.git");
  git(root, "clone", "-q", "--bare", main, bare);
  git(bare, "worktree", "add", "-q", "-b", "from-bare", join(root, "bare-worktree"));
  assert.equal(worktreeOf(join(root, "bare-worktree")), null);

  const odd = join(root, "odd");
  mkdirSync(odd, { recursive: true });
  writeFileSync(join(odd, ".git"), "gitdir: /nowhere/at/all\n");
  assert.equal(worktreeOf(odd), null);
  writeFileSync(join(odd, ".git"), "nonsense");
  assert.equal(worktreeOf(odd), null);

  // A `.git` file naming a repository's worktree that is not this folder: git would not
  // take it as that worktree, nor is it here. Nor a folder of git's own made to look like one.
  writeFileSync(join(odd, ".git"), `gitdir: ${join(main, ".git", "worktrees", "portals-feature")}\n`);
  assert.equal(worktreeOf(odd), null);
  const fake = join(root, "fake-kept");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "commondir"), join(main, ".git"));
  writeFileSync(join(fake, "gitdir"), join(odd, ".git"));
  writeFileSync(join(odd, ".git"), `gitdir: ${fake}\n`);
  assert.equal(worktreeOf(odd), null);
});

test("a folder in a worktree is listed as the main checkout's same folder only when that one is in the main checkout", () => {
  // The main checkout's `src/linked` leads out of it; the worktree's is a folder of its own.
  const outside = join(root, "outside-target");
  mkdirSync(outside, { recursive: true });
  execFileSync("ln", ["-s", outside, join(main, "src", "linked")]);
  mkdirSync(join(feature, "src", "linked"), { recursive: true });
  assert.deepEqual(worktreeOf(join(feature, "src", "linked")), { repo: main, main, top: feature });
  unlinkSync(join(main, "src", "linked"));
});

test("git's files a `.git` file leads to are read only when they are small plain files, never waited on", () => {
  // A named pipe where `commondir` would be: reading it would hold the bridge for good.
  const piped = join(root, "piped");
  const kept = join(root, "piped-kept");
  mkdirSync(piped, { recursive: true });
  mkdirSync(kept, { recursive: true });
  execFileSync("mkfifo", [join(kept, "commondir")]);
  writeFileSync(join(piped, ".git"), `gitdir: ${kept}\n`);
  assert.equal(worktreeOf(piped), null);
  assert.equal(threadRepo(piped, main), undefined);
  // A huge `.git` file is not read whole.
  writeFileSync(join(piped, ".git"), `gitdir: ${join(main, ".git", "worktrees", "portals-feature")}\n${"x".repeat(1024 * 1024)}`);
  assert.equal(worktreeOf(piped), null);
});

test("a thread keeps its repository once its worktree is gone, and drops it in a folder that is no worktree any more", () => {
  const gone = join(root, "portals-gone");
  git(main, "worktree", "add", "-q", "-b", "night/gone", gone);
  const known = threadRepo(gone, undefined);
  assert.equal(known, main);
  // Removed: its folder goes with it.
  git(main, "worktree", "remove", gone);
  assert.equal(threadRepo(gone, known), main);
  assert.equal(threadRepo(gone, undefined), undefined);

  // Its folder kept, git no longer keeping it: still the repository's.
  const stale = join(root, "portals-stale");
  git(main, "worktree", "add", "-q", "-b", "night/stale", stale);
  rmSync(join(main, ".git", "worktrees", "portals-stale"), { recursive: true, force: true });
  assert.equal(threadRepo(stale, main), main);

  // A folder that is a plain one now (its `.git` taken away): its own again.
  const plain = join(root, "portals-plain");
  git(main, "worktree", "add", "-q", "-b", "night/plain", plain);
  rmSync(join(plain, ".git"));
  git(main, "worktree", "prune");
  assert.equal(threadRepo(plain, main), undefined);
});

test("as the bridge starts, the repositories of many threads from before are saved a batch at a time, not once each", async () => {
  const home = join(root, "registry-home");
  mkdirSync(home, { recursive: true });
  const path = join(home, "threads.json");
  const threads = Array.from({ length: 250 }, (_, index) => ({ id: `t${index}`, agent: "fake", cwd: feature, title: null, model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone", revision: 1, turnRevision: 1 }));
  writeFileSync(path, JSON.stringify({ list: "abcdef0123456789", revision: 1, threads }));
  const registry = new Registry(path);
  let saves = 0;
  const save = (registry as any).save.bind(registry);
  (registry as any).save = (...args: unknown[]) => {
    saves += 1;
    return save(...args);
  };
  let moves = 0;
  registry.moved = () => (moves += 1);
  await noteRepos(registry);
  assert.ok(registry.all().every((record) => record.repo === main));
  assert.equal(saves, 3);
  assert.equal(moves, 3);
  assert.equal(new Registry(path).get("t249")?.repo, main);
  // Nothing more to find: nothing written.
  await noteRepos(registry);
  assert.equal(saves, 3);
});

function folders(sources: RecentFolder[][], added?: string): Folders {
  return new Folders({
    general: join(root, "general"),
    hide: [join(root, "hidden")],
    own: [join(root, "bridge")],
    sources: sources.map((list) => async () => list),
    home: join(root, "home"),
    temporary: [join(root, "scratch")],
    added,
  });
}

test("folders.list lists a worktree's folders as its repository's, never as folders of their own", async () => {
  mkdirSync(join(root, "general"), { recursive: true });
  const now = Date.now();
  const list = await folders([
    [
      { path: feature, lastUsed: now - 1_000 },
      { path: inside, lastUsed: now - 2_000 },
      { path: main, lastUsed: now - 60_000 },
      { path: join(feature, "src", "app"), lastUsed: now - 5_000 },
    ],
  ]).list();
  // Once each, as of the newest use of any of its worktrees.
  assert.deepEqual(
    list.folders.map((folder) => [folder.path, folder.last_used]),
    [
      [main, Math.floor((now - 1_000) / 1000)],
      [join(main, "src", "app"), Math.floor((now - 5_000) / 1000)],
    ],
  );
});

test("a new thread may start in a worktree of a folder on the list, and in no other new folder", async () => {
  mkdirSync(join(root, "general"), { recursive: true });
  const listed = folders([[{ path: main, lastUsed: Date.now() }]]);
  assert.equal(await listed.resolve(feature), feature);
  assert.equal(await listed.resolve(inside), inside);
  // A folder in one: its main checkout is on the list.
  assert.equal(await listed.resolve(join(feature, "src", "app")), join(feature, "src", "app"));

  // A repository not on the list: its worktree is refused, as is any folder.
  const other = repository(join(root, "other"));
  git(other, "worktree", "add", "-q", "-b", "x", join(root, "other-x"));
  await assert.rejects(listed.resolve(join(root, "other-x")), /worktree of a folder from the list/);
  const plain = join(root, "random");
  mkdirSync(plain, { recursive: true });
  await assert.rejects(listed.resolve(plain), /not on it/);
  // Nor one in the bridge's own folder, even of a repository on the list.
  const own = join(root, "bridge", "wt");
  git(main, "worktree", "add", "-q", "-b", "own", own);
  await assert.rejects(listed.resolve(own), /not on it/);
  git(main, "worktree", "remove", "--force", own);

  // Through a folder the user added.
  const added = folders([], join(root, "added.json"));
  await assert.rejects(added.resolve(feature));
  added.add(main);
  assert.equal(await added.resolve(feature), feature);
});

test("adding a worktree adds its repository, and answers with the folder chosen, where an older app starts the thread", () => {
  mkdirSync(join(root, "general"), { recursive: true });
  const list = folders([], join(root, "added-2.json"));
  const answer = list.add(feature, 1_700_000_000_000);
  assert.deepEqual(answer, { path: feature, name: "portals-feature", last_used: 1_700_000_000, added: true, repo: main });
  assert.deepEqual(list.add(join(feature, "src", "app"), 1_700_000_000_000), {
    path: join(feature, "src", "app"),
    name: "app",
    last_used: 1_700_000_000,
    added: true,
    repo: join(main, "src", "app"),
  });
  // A folder in no worktree says nothing of one.
  assert.equal("repo" in list.add(main), false);
  // A worktree of the General folder's repository: General, which is never added.
  const general = new Folders({ general: main, hide: [], own: [], sources: [], home: join(root, "home"), temporary: [] });
  assert.deepEqual(general.add(feature), { path: feature, name: "portals-feature", repo: main });
  assert.deepEqual(general.add(main), { path: main, name: "General" });
});

test("a worktree in a folder config.json hides or in the bridge's own is not listed or added as its repository", async () => {
  mkdirSync(join(root, "general"), { recursive: true });
  const hidden = join(root, "hidden", "wt");
  const own = join(root, "bridge", "wt2");
  git(main, "worktree", "add", "-q", "-b", "hidden-wt", hidden);
  git(main, "worktree", "add", "-q", "-b", "own-wt", own);
  try {
    const list = folders([[{ path: hidden, lastUsed: Date.now() }, { path: own, lastUsed: Date.now() }]], join(root, "added-hidden.json"));
    assert.deepEqual((await list.list()).folders, []);
    assert.throws(() => list.add(hidden), /keeps off the list/);
    assert.throws(() => list.add(own), /keeps off the list/);
    assert.deepEqual((await list.list()).folders, []);
    // General falling back to the home folder (the one configured is not there) is still General.
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const fallback = new Folders({ general: join(root, "no-such-general"), hide: [], own: [], sources: [], home, temporary: [] });
    assert.deepEqual(fallback.add(home), { path: realpathSync(home), name: "General" });
  } finally {
    git(main, "worktree", "remove", "--force", hidden);
    git(main, "worktree", "remove", "--force", own);
  }
});

test("a worktree of a repository whose main checkout is never offered (hidden, temporary, hidden by config.json) is a folder of its own, as before the feature", async () => {
  mkdirSync(join(root, "general"), { recursive: true });
  const cases = [
    // Dotfiles style: the main checkout in a hidden folder.
    [repository(join(root, "home", ".config", "nvim")), join(root, "code", "nvim-feature")],
    [repository(join(root, "scratch", "made")), join(root, "code", "made-feature")],
    [repository(join(root, "hidden", "kept")), join(root, "code", "kept-feature")],
  ];
  for (const [index, [repo, path]] of cases.entries()) {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "src");
    git(repo, "worktree", "add", "-q", "-b", "feature", path);
    const worktree = realpathSync(path);
    assert.equal(worktreeOf(worktree)?.main, repo);

    // Added: itself, with no `repo`, and listed so; a new thread may start in it.
    const added = folders([], join(root, `added-alone-${index}.json`));
    assert.deepEqual(added.add(worktree, 1_700_000_000_000), { path: worktree, name: basename(worktree), last_used: 1_700_000_000, added: true });
    assert.deepEqual((await added.list()).folders.map((folder) => [folder.path, folder.added]), [[worktree, true]]);
    assert.equal(await added.resolve(worktree), worktree);
    added.remove(worktree);
    assert.deepEqual((await added.list()).folders, []);

    // Where an agent worked: listed as itself, a folder in it too, and a new thread may start in either.
    const now = Date.now();
    const worked = folders([[{ path: worktree, lastUsed: now }, { path: join(worktree, "src"), lastUsed: now - 1_000 }]]);
    assert.deepEqual((await worked.list()).folders.map((folder) => folder.path), [worktree, join(worktree, "src")]);
    assert.equal(await worked.resolve(worktree), worktree);
    assert.equal(await worked.resolve(join(worktree, "src")), join(worktree, "src"));

    // A worktree of it that is itself hidden is still never offered.
    const tucked = join(repo, ".claude", "worktrees", "tucked");
    git(repo, "worktree", "add", "-q", "-b", "tucked", tucked);
    const hiddenToo = folders([[{ path: tucked, lastUsed: now }]]);
    assert.deepEqual((await hiddenToo.list()).folders, []);
    assert.throws(() => hiddenToo.add(tucked), /keeps off the list/);
    await assert.rejects(hiddenToo.resolve(tucked), /not on it/);
  }
});

test("a worktree added before the bridge knew of worktrees is listed as its repository, added, and taken off with it", async () => {
  mkdirSync(join(root, "general"), { recursive: true });
  const file = join(root, "added-before.json");
  writeFileSync(file, JSON.stringify({ folders: [{ path: feature, addedAt: 1_700_000_000_000 }] }));
  // Thirty newer folders: an added one stays listed past them.
  const newer: RecentFolder[] = [];
  for (let index = 0; index < 30; index += 1) {
    const path = join(root, "newer", String(index));
    mkdirSync(path, { recursive: true });
    newer.push({ path, lastUsed: 1_800_000_000_000 + index });
  }
  const list = folders([newer], file);
  const listed = (await list.list()).folders;
  assert.deepEqual(listed.find((folder) => folder.path === main), { path: main, name: "Portals", last_used: 1_700_000_000, added: true });
  assert.equal(listed.some((folder) => folder.path === feature), false);
  list.remove(main);
  assert.equal((await list.list()).folders.some((folder) => folder.path === main), false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).folders, []);
});

test("through the bridge: listed threads carry the repository of their worktree, kept after it is removed and the bridge restarts", async (t) => {
  const general = join(root, "general");
  mkdirSync(general, { recursive: true });
  const transient = join(root, "portals-transient");
  git(main, "worktree", "add", "-q", "-b", "night/transient", transient);
  let bridge = await startTestBridge({ config: { generalFolder: general }, temporaryFolders: [], keepHome: true });
  let client = await TestClient.open(bridge);
  const home = bridge.home;
  t.after(async () => {
    await client.close();
    await bridge.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  assert.ok(client.readyPayload.bridge.features.includes("worktrees"));
  const listed = async (thread: string): Promise<Frame> => (await client.call("threads.changes", {})).threads.find((row: Frame) => row.id === thread);

  // Before its repository is on the list, a worktree is refused like any folder.
  await assert.rejects(createThread(client, { cwd: transient }), (error: unknown) => error instanceof RpcFailure && /worktree of a folder from the list/.test(error.message));
  const added = await client.call("folders.add", { path: transient });
  assert.deepEqual([added.path, added.repo], [realpathSync(transient), main]);
  assert.ok(!(await client.call("folders.list", {})).folders.some((folder: Frame) => folder.path !== main && folder.path.includes("portals-")));

  // From its first listing, before any turn: under the repository, its own folder beside it.
  const inWorktree = await createThread(client, { cwd: transient });
  const atMain = await createThread(client, { cwd: main });
  assert.deepEqual([(await listed(inWorktree)).folder, (await listed(inWorktree)).repo], [realpathSync(transient), main]);
  assert.equal((await listed(atMain)).repo, undefined);
  await runTurn(client, inWorktree, "hello");
  await waitFor(async () => (await listed(inWorktree)).branch === "night/transient");

  // Through the fleet too, as `portals start --folder` does.
  const started = await client.call("thread.start", { profile: "fake", cwd: feature });
  assert.equal((await listed(started.thread.id)).repo, main);

  // The worktree removed while the bridge is stopped: still under the repository.
  await client.close();
  await bridge.dispose();
  git(main, "worktree", "remove", "--force", transient);
  bridge = await startTestBridge({ home, keepHome: true, temporaryFolders: [] });
  client = await TestClient.open(bridge);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = await listed(inWorktree);
  assert.deepEqual([after.folder, after.repo, after.branch], [join(root, "portals-transient"), main, "night/transient"]);
});

test("threads from before: the bridge finds their worktree as it starts", async (t) => {
  const general = join(root, "general");
  mkdirSync(general, { recursive: true });
  let bridge = await startTestBridge({ config: { generalFolder: general }, temporaryFolders: [], keepHome: true });
  let client = await TestClient.open(bridge);
  const home = bridge.home;
  t.after(async () => {
    await client.close();
    await bridge.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  await client.call("folders.add", { path: main });
  const thread = await createThread(client, { cwd: feature });
  await client.close();
  await bridge.dispose();
  // As a bridge before the feature kept it: no repository.
  const threadsFile = join(home, "state", "threads.json");
  const stored = JSON.parse((await import("node:fs")).readFileSync(threadsFile, "utf8"));
  for (const record of stored.threads) delete record.repo;
  writeFileSync(threadsFile, JSON.stringify(stored, null, 1) + "\n");

  bridge = await startTestBridge({ home, keepHome: true, temporaryFolders: [] });
  client = await TestClient.open(bridge);
  await waitFor(async () => (await client.call("threads.changes", {})).threads.find((row: Frame) => row.id === thread)?.repo === main);
});

async function waitFor(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
