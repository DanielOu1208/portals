import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { codexProjects, FolderRefused, Folders, makeGeneral, type RecentFolder } from "../src/folders.ts";
import { machineWord } from "../src/platform.ts";
import { CodexProvider } from "../src/providers/codex/provider.ts";
import { socketConnector } from "../src/providers/codex/client.ts";
import { FakeDaemon } from "./codex-daemon.ts";
import { RpcFailure, startTestBridge, TestClient } from "./helpers.ts";

// The folders offered for new threads (src/folders.ts): what is kept, in what order,
// and what session.create then accepts.

let root: string;
const minute = 60_000;
const now = Date.UTC(2026, 9, 6, 20, 0, 0);

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "portals-folders-test-")));
  for (const path of ["home/coding_projects/aerirc", "home/coding_projects/notes", "home/coding_projects/old", "home/.codex/worktrees/x", "home/hidden/secret", "home/bridge", "scratch/run"]) {
    mkdirSync(join(root, path), { recursive: true });
  }
  symlinkSync(join(root, "home/coding_projects/aerirc"), join(root, "home/aerirc-link"));
});

after(() => rmSync(root, { recursive: true, force: true }));

function folders(sources: RecentFolder[][], options: { limit?: number; temporary?: string[] } = {}): Folders {
  return new Folders({
    general: join(root, "home/coding_projects"),
    hide: [join(root, "home/hidden")],
    own: [join(root, "home/bridge")],
    sources: sources.map((list) => async () => list),
    home: join(root, "home"),
    temporary: options.temporary ?? [join(root, "scratch")],
    limit: options.limit,
  });
}

const at = (path: string) => join(root, path);

test("General comes first; the rest are the folders agents used, newest first, each once by its real path", async () => {
  const list = await folders([
    // Claude Code's sessions.
    [
      { path: at("home/coding_projects/notes"), lastUsed: now - 120 * minute },
      { path: at("home/aerirc-link"), lastUsed: now - 5 * minute },
    ],
    // Codex's threads and its trusted projects (no time).
    [
      { path: at("home/coding_projects/aerirc"), lastUsed: now - 60 * minute },
      { path: at("home/coding_projects/old") },
      { path: at("home/coding_projects/notes"), lastUsed: now - 30 * minute },
    ],
  ]).list();
  assert.deepEqual(list.general, { path: at("home/coding_projects"), name: "General" });
  assert.deepEqual(list.folders, [
    { path: at("home/coding_projects/aerirc"), name: "aerirc", last_used: Math.floor((now - 5 * minute) / 1000) },
    { path: at("home/coding_projects/notes"), name: "notes", last_used: Math.floor((now - 30 * minute) / 1000) },
    // Never used as far as anyone says: after the rest, and without a time.
    { path: at("home/coding_projects/old"), name: "old" },
  ]);
});

test("what is never offered: missing folders, /, home, General itself, temporary, hidden and dot folders, the bridge's own", async () => {
  const list = await folders([
    [
      { path: "/", lastUsed: now },
      { path: at("home"), lastUsed: now },
      { path: at("home/coding_projects"), lastUsed: now },
      { path: at("home/coding_projects/gone"), lastUsed: now },
      { path: at("scratch/run"), lastUsed: now },
      { path: at("home/hidden/secret"), lastUsed: now },
      { path: at("home/.codex/worktrees/x"), lastUsed: now },
      { path: at("home/bridge"), lastUsed: now },
      { path: "relative/path", lastUsed: now },
      { path: at("home/coding_projects/notes"), lastUsed: now - minute },
    ],
  ]).list();
  assert.deepEqual(list.folders.map((folder) => folder.name), ["notes"]);
});

test("the usual temporary folders are never offered", async () => {
  const list = await new Folders({ general: at("home/coding_projects"), hide: [], own: [], sources: [async () => [{ path: at("home/coding_projects/notes"), lastUsed: now }]], home: at("home") }).list();
  // root is under the system's temporary folder.
  assert.deepEqual(list.folders, []);
});

test("at most the limit, the newest", async () => {
  const many = Array.from({ length: 5 }, (_, index) => {
    const path = at(`home/many/${index}`);
    mkdirSync(path, { recursive: true });
    return { path, lastUsed: now - index * minute };
  });
  const list = await folders([many], { limit: 3 }).list();
  assert.deepEqual(list.folders.map((folder) => folder.name), ["0", "1", "2"]);
});

test("a source that fails costs only its own folders", async () => {
  const list = await new Folders({
    general: at("home/coding_projects"),
    hide: [],
    own: [],
    temporary: [],
    home: at("home"),
    sources: [async () => Promise.reject(new Error("Codex is down")), async () => [{ path: at("home/coding_projects/notes"), lastUsed: now }]],
  }).list();
  assert.deepEqual(list.folders.map((folder) => folder.name), ["notes"]);
});

test("a General folder that does not exist is the home folder", async () => {
  const list = await new Folders({ general: at("home/nowhere"), hide: [], own: [], sources: [], home: at("home"), temporary: [] }).list();
  assert.deepEqual(list.general, { path: at("home"), name: "General" });
});

test("the bridge makes a missing General folder, one level only", () => {
  assert.equal(makeGeneral(at("home/Portals")), true);
  assert.equal(realpathSync(at("home/Portals")), at("home/Portals"));
  // There already: left as it is.
  assert.equal(makeGeneral(at("home/Portals")), true);
  // Its parent missing too: more likely a typo, so nothing is made.
  assert.equal(makeGeneral(at("home/no-such/Portals")), false);
  assert.throws(() => realpathSync(at("home/no-such")));
  assert.equal(makeGeneral("relative/Portals"), false);
});

test("a new thread runs in General, or a folder on the list, and nowhere else", async () => {
  const offered = folders([[{ path: at("home/coding_projects/aerirc"), lastUsed: now }]]);
  assert.equal(await offered.resolve(undefined), at("home/coding_projects"));
  assert.equal(await offered.resolve(""), at("home/coding_projects"));
  assert.equal(await offered.resolve(at("home/coding_projects")), at("home/coding_projects"));
  // By another path to the same folder: its real path.
  assert.equal(await offered.resolve(at("home/aerirc-link")), at("home/coding_projects/aerirc"));
  await assert.rejects(offered.resolve(at("home/coding_projects/notes")), (error: Error) => error instanceof FolderRefused && /is not on it\.$/.test(error.message));
  await assert.rejects(offered.resolve("/no/such/folder"), (error: Error) => error.message === `The folder /no/such/folder does not exist on this ${machineWord()}.`);
  await assert.rejects(offered.resolve("relative"), FolderRefused);
});

test("a folder the user adds is on the list, marked and kept, past the end of the list too, until it is taken off", async () => {
  const kept = at("home/bridge/folders.json");
  const options = { general: at("home/coding_projects"), hide: [at("home/hidden")], own: [at("home/bridge")], home: at("home"), temporary: [at("scratch")], limit: 1, added: kept };
  const offered = new Folders({ ...options, sources: [async () => [{ path: at("home/coding_projects/aerirc"), lastUsed: now }]] });
  // By a link to it: its real path, as listed.
  mkdirSync(at("home/links"), { recursive: true });
  symlinkSync(at("home/coding_projects/notes"), at("home/links/notes"));
  const notes = { path: at("home/coding_projects/notes"), name: "notes", last_used: Math.floor((now - minute) / 1000), added: true };
  assert.deepEqual(offered.add(at("home/links/notes"), now - minute), notes);
  // A newer folder takes the list's one place; the added one is listed after it all the
  // same, and takes a thread.
  assert.deepEqual((await offered.list()).folders, [{ path: at("home/coding_projects/aerirc"), name: "aerirc", last_used: Math.floor(now / 1000) }, notes]);
  assert.equal(await offered.resolve(at("home/coding_projects/notes")), at("home/coding_projects/notes"));
  // General is always there: nothing to keep.
  assert.deepEqual(offered.add(at("home/coding_projects")), { path: at("home/coding_projects"), name: "General" });

  // What is never offered cannot be added either.
  for (const path of ["/", at("home"), at("home/hidden/secret"), at("home/.codex/worktrees/x"), at("scratch/run"), at("home/bridge")]) {
    assert.throws(() => offered.add(path), (error: Error) => error instanceof FolderRefused && /^Threads cannot run in /.test(error.message), path);
  }
  assert.throws(() => offered.add("/no/such/folder"), (error: Error) => error instanceof FolderRefused && error.message === `The folder /no/such/folder does not exist on this ${machineWord()}.`);
  assert.throws(() => offered.add("relative"), FolderRefused);

  // A bridge started again still has it.
  const again = new Folders({ ...options, sources: [] });
  assert.deepEqual((await again.list()).folders, [notes]);
  assert.equal(await again.resolve(at("home/coding_projects/notes")), at("home/coding_projects/notes"));

  // Taken off, by the link as well as by its real path: gone, here and after a restart.
  // One the agents worked in lately stays listed, as any such folder, unmarked.
  again.remove(at("home/coding_projects/aerirc"));
  again.remove(at("home/links/notes"));
  assert.deepEqual((await again.list()).folders, []);
  await assert.rejects(again.resolve(at("home/coding_projects/notes")), FolderRefused);
  assert.deepEqual((await new Folders({ ...options, sources: [] }).list()).folders, []);
  const used = new Folders({ ...options, sources: [async () => [{ path: at("home/coding_projects/notes"), lastUsed: now }]] });
  used.add(at("home/coding_projects/notes"), now);
  used.remove(at("home/coding_projects/notes"));
  assert.deepEqual((await used.list()).folders, [{ path: at("home/coding_projects/notes"), name: "notes", last_used: Math.floor(now / 1000) }]);
});

test("config.toml's trusted projects are read from its table headers only", (t) => {
  const file = join(root, "config.toml");
  t.after(() => rmSync(file, { force: true }));
  writeFileSync(
    file,
    [
      'model = "gpt-6.1-sol"',
      '[projects."/Users/dev/coding_projects/aerirc"]',
      'trust_level = "trusted"',
      "  [ projects . '/Users/dev/My Notes' ]   # literal string",
      '[projects."/Users/dev/quote\\"d \\u00e9"]',
      '[projects."/Users/dev/bad\\q"]',
      '[mcp_servers."projects"]',
      'projects = "[projects.\\"/not/a/header\\"]"',
      "[projects.bare]",
    ].join("\n"),
  );
  assert.deepEqual(codexProjects(file), [{ path: "/Users/dev/coding_projects/aerirc" }, { path: "/Users/dev/My Notes" }, { path: '/Users/dev/quote"d é' }]);
  assert.deepEqual(codexProjects(join(root, "missing.toml")), []);
});

test("Codex's folders come from a list refreshed in the background, never waited for", async (t) => {
  const daemon = await FakeDaemon.start();
  const images = mkdtempSync(join(tmpdir(), "portals-folders-images-"));
  const config = join(root, "codex-config.toml");
  writeFileSync(config, `[projects."${at("home/coding_projects/old")}"]\n`);
  daemon.addThread(at("home/coding_projects/aerirc"), [], { updatedAt: 1_800_000_000 });
  daemon.addThread(at("home/coding_projects/notes"), [], { updatedAt: 1_700_000_000 });
  daemon.addThread(at("home/coding_projects/aerirc"), [], { updatedAt: 1_750_000_000 });
  const provider = new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images },
    connect: socketConnector(daemon.socketPath),
    checkVersion: false,
    configPath: config,
  });
  t.after(async () => {
    await provider.close();
    await daemon.close();
    rmSync(images, { recursive: true, force: true });
  });

  // Before the first answer: only config.toml's projects, at once.
  assert.deepEqual(await provider.recentFolders(), [{ path: at("home/coding_projects/old") }]);
  provider.start();
  const deadline = Date.now() + 3000;
  while ((await provider.recentFolders()).length < 3) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(await provider.recentFolders(), [
    { path: at("home/coding_projects/aerirc"), lastUsed: 1_800_000_000_000 },
    { path: at("home/coding_projects/notes"), lastUsed: 1_700_000_000_000 },
    { path: at("home/coding_projects/old") },
  ]);
  // Every page was read, from Codex's index rather than a scan of its files.
  const calls = daemon.callsOf("thread/list");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, { cursor: null, limit: 100, sortKey: "updated_at", useStateDbOnly: true });
  assert.equal(calls[1].params.cursor, "2");
});

test("folders.list and session.create through the bridge", async (t) => {
  const bridge = await startTestBridge({ config: { generalFolder: at("home/coding_projects") }, temporaryFolders: [] });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());

  const empty = await client.call("folders.list", { profile: "fake" });
  assert.deepEqual(empty, { general: { path: at("home/coding_projects"), name: "General" }, folders: [] });
  await assert.rejects(client.call("folders.list", { profile: "hermes" }), (error: RpcFailure) => error.code === -32602);
  await assert.rejects(client.call("session.create", { profile: "fake", cwd: at("home/coding_projects/notes") }), (error: RpcFailure) => error.code === -32602 && /is not on it\.$/.test(error.message));

  // A thread in General, by default.
  const general = await client.call("session.create", { profile: "fake" });
  assert.equal(general.info.cwd, at("home/coding_projects"));
  // A folder the user chose on this Mac: added, listed, and then good for a thread.
  await assert.rejects(client.call("folders.add", { path: "/no/such/folder" }), (error: RpcFailure) => error.code === -32602 && error.message.endsWith(`does not exist on this ${machineWord()}.`));
  await assert.rejects(client.call("folders.add", {}), (error: RpcFailure) => error.code === -32602);
  const added = await client.call("folders.add", { path: at("home/coding_projects/old") });
  assert.deepEqual({ path: added.path, name: added.name, added: added.added }, { path: at("home/coding_projects/old"), name: "old", added: true });
  const withOld = await client.call("folders.list", { profile: "fake" });
  assert.deepEqual(withOld.folders.map((folder: { name: string; added?: boolean }) => [folder.name, folder.added]), [["old", true]]);
  // Taken off and put back: off the list, and no place for a thread, in between.
  await assert.rejects(client.call("folders.remove", {}), (error: RpcFailure) => error.code === -32602);
  assert.deepEqual(await client.call("folders.remove", { path: at("home/coding_projects/old") }), {});
  assert.deepEqual((await client.call("folders.list", { profile: "fake" })).folders, []);
  await assert.rejects(client.call("session.create", { profile: "fake", cwd: at("home/coding_projects/old") }), (error: RpcFailure) => error.code === -32602);
  await client.call("folders.add", { path: at("home/coding_projects/old") });
  const inOld = await client.call("session.create", { profile: "fake", cwd: at("home/coding_projects/old") });
  assert.equal(inOld.info.cwd, at("home/coding_projects/old"));

  // The bridge's own threads count: a thread made in notes (General then) puts it on
  // the list once General is elsewhere.
  const seeded = await startTestBridge({ keepHome: true, config: { generalFolder: at("home/coding_projects/notes") }, temporaryFolders: [] });
  const seededClient = await TestClient.open(seeded);
  await seededClient.call("session.create", { profile: "fake" });
  await seededClient.close();
  await seeded.close();
  const configPath = join(seeded.home, "config.json");
  writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), generalFolder: at("home/coding_projects") }));
  const restarted = await startTestBridge({ home: seeded.home, temporaryFolders: [] });
  t.after(() => restarted.dispose());
  const again = await TestClient.open(restarted);
  t.after(() => again.close());
  const list = await again.call("folders.list", { profile: "fake" });
  assert.deepEqual(list.folders.map((folder: { name: string }) => folder.name), ["notes"]);
  assert.equal(typeof list.folders[0].last_used, "number");
  const created = await again.call("session.create", { profile: "fake", cwd: at("home/coding_projects/notes") });
  assert.equal(created.info.cwd, at("home/coding_projects/notes"));
});
