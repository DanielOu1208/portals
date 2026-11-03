import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { mkdirSync, mkdtempSync, realpathSync, rmSync, type FSWatcher, type WatchEventType } from "node:fs";
import { readdir } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FolderSearch } from "../src/folderSearch.ts";
import { startTestBridge, TestClient } from "./helpers.ts";

class StartingWatcher extends EventEmitter implements FSWatcher {
  closed = false;
  dropped = 0;
  private readonly started: number;
  private readonly clock: { now: number };

  constructor(clock: { now: number }, listener: (event: WatchEventType, name: string | null) => void) {
    super();
    this.clock = clock;
    this.started = clock.now;
    this.on("change", listener);
  }

  change(name: string): void {
    if (this.closed) return;
    if (this.clock.now - this.started < 100) {
      this.dropped += 1;
      return;
    }
    this.emit("change", "rename", name);
  }

  close(): void { this.closed = true; this.emit("close"); }
  ref(): this { return this; }
  unref(): this { return this; }
}

function silentStart(t: TestContext): { clock: { now: number }; watchers: Map<string, StartingWatcher>; advance: (ms: number) => void } {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = { now: 0 };
  const watchers = new Map<string, StartingWatcher>();
  const mock = t.mock.method(fs, "watch", (...args: Parameters<typeof fs.watch>) => {
    const listener = args[args.length - 1];
    if (typeof listener !== "function") throw new Error("a watcher needs its callback");
    const watcher = new StartingWatcher(clock, listener);
    watchers.set(String(args[0]), watcher);
    return watcher;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  return { clock, watchers, advance: (ms) => { clock.now += ms; t.mock.timers.tick(ms); } };
}

function fixture(t: TestContext): { home: string; search: FolderSearch } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "folder-watch-start-")));
  mkdirSync(join(home, "code", "existing"), { recursive: true });
  const search = new FolderSearch({
    home, refusing: () => () => false, taking: () => (path) => ({ path }),
    listed: async () => [], os: "macos", watch: true,
  });
  t.after(() => { search.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, search };
}

test("one startup reconcile recovers new folders and git when the first watcher events are lost", async (t) => {
  const gap = silentStart(t);
  const { home, search } = fixture(t);
  await search.search("existing");
  mkdirSync(join(home, "code", "fresh", "deep"), { recursive: true });
  mkdirSync(join(home, "code", "existing", ".git"));
  mkdirSync(join(home, "LateTop", "inner"), { recursive: true });
  gap.watchers.get(join(home, "code"))!.change("fresh/deep");
  gap.watchers.get(join(home, "code"))!.change("existing/.git");
  gap.watchers.get(home)!.change("LateTop");
  assert.equal(gap.watchers.get(join(home, "code"))!.dropped, 2);
  assert.equal(gap.watchers.get(home)!.dropped, 1);
  assert.deepEqual((await search.search("fresh")).folders, []);
  gap.advance(200);
  await Promise.resolve();
  const applying = (search as unknown as { applying?: Promise<void> }).applying;
  assert.ok(applying, "startup reconciliation starts without another search");
  await applying;
  assert.deepEqual((await search.search("fresh")).folders.map((hit) => hit.relative).sort(), ["code/fresh", "code/fresh/deep"]);
  assert.deepEqual((await search.search("LateTop")).folders.map((hit) => hit.relative).sort(), ["LateTop", "LateTop/inner"]);
  assert.equal((await search.search("existing")).folders[0]?.git, true);
  assert.equal(search.walks, 1);
});

test("a newly watched top gets its own bounded startup reconciliation", async (t) => {
  const gap = silentStart(t);
  const { home, search } = fixture(t);
  await search.search("existing");
  gap.advance(200);
  await search.search("existing");
  mkdirSync(join(home, "TopNew", "inner"), { recursive: true });
  gap.watchers.get(home)!.change("TopNew");
  assert.equal((await search.search("inner")).folders[0]?.relative, "TopNew/inner");
  mkdirSync(join(home, "TopNew", "inner", ".git"));
  gap.watchers.get(join(home, "TopNew"))!.change("inner/.git");
  assert.equal(gap.watchers.get(join(home, "TopNew"))!.dropped, 1);
  gap.advance(200);
  assert.equal((await search.search("inner")).folders[0]?.git, true);
  assert.equal(search.walks, 1);
});

test("overflow never delays the first answer and converges with one background walk", async (t) => {
  const gap = silentStart(t);
  const { home, search } = fixture(t);
  for (let i = 0; i < 96; i += 1) mkdirSync(join(home, "code", `dir${i}`));
  let reads = 0;
  search.read = (path) => {
    reads += 1;
    return readdir(path, { withFileTypes: true });
  };
  await search.search("dir");
  assert.equal(gap.clock.now, 0, "the first complete answer never waits for startup settlement");
  assert.equal(reads, 99);
  assert.equal(search.size, 98);
  assert.equal(search.walks, 1);
  const starting = (search as unknown as { watchStart: { reads: Set<string>; overflow: boolean } }).watchStart;
  assert.ok(starting);
  assert.equal(starting.reads.size, 32, "remembered paths remain bounded");
  assert.equal(starting.overflow, true);
  const watchers = [...gap.watchers.values()];
  mkdirSync(join(home, "code", "dir95", ".git"));
  mkdirSync(join(home, "code", "dir95", "late"));
  gap.watchers.get(join(home, "code"))!.change("dir95/.git");
  gap.watchers.get(join(home, "code"))!.change("dir95/late");
  assert.equal(gap.watchers.get(join(home, "code"))!.dropped, 2);
  gap.advance(200);
  await Promise.resolve();
  const recovery = (search as unknown as { walking?: { done: Promise<void> } }).walking;
  assert.ok(recovery, "overflow starts recovery without another search");
  await recovery.done;
  assert.equal(search.size, 99);
  assert.equal(reads, 199, "99 first reads plus one 100-directory recovery");
  assert.equal(search.reread, 0);
  assert.equal(search.walks, 2);
  assert.equal((await search.search("dir95")).folders[0]?.git, true);
  assert.deepEqual([...gap.watchers.values()], watchers, "recovery reuses established watchers");
  gap.advance(1000);
  await search.search("dir");
  assert.equal(reads, 199, "overflow recovery is not periodic polling");
  assert.equal(search.walks, 2);
});

test("closing before startup settlement cancels the timer without starting recovery", async (t) => {
  const gap = silentStart(t);
  const { home, search } = fixture(t);
  for (let i = 0; i < 96; i += 1) mkdirSync(join(home, "code", `dir${i}`));
  let reads = 0;
  search.read = (path) => {
    reads += 1;
    return readdir(path, { withFileTypes: true });
  };
  await search.search("dir");
  assert.ok((search as unknown as { watchStart?: unknown }).watchStart);
  search.close();
  assert.equal((search as unknown as { watchStart?: unknown }).watchStart, undefined);
  gap.advance(1000);
  await Promise.resolve();
  assert.equal(reads, 99);
  assert.equal(search.walks, 1);
  assert.equal(search.size, 0);
  assert.ok([...gap.watchers.values()].every((watcher) => watcher.closed));
});

test("a settled startup waiting for a slow first walk cannot recover a closed generation", async (t) => {
  const gap = silentStart(t);
  const { home, search } = fixture(t);
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  search.read = async (path) => {
    reads += 1;
    if (path === home) { entered(); await held; }
    return readdir(path, { withFileTypes: true });
  };
  const first = search.search("existing");
  await reading;
  gap.advance(200);
  search.close();
  release();
  assert.equal((await first).superseded, true);
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.equal(search.size, 0);
  assert.equal(search.walks, 1);
  assert.ok([...gap.watchers.values()].every((watcher) => watcher.closed));
});

test("a scratch gateway search recovers a startup mutation without receiving a watcher event", { skip: process.platform !== "darwin" }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "folder-watch-wire-")));
  mkdirSync(join(home, "code", "existing"), { recursive: true });
  const bridge = await startTestBridge({ userHome: home, temporaryFolders: [], config: { generalFolder: join(home, "code") } });
  const client = await TestClient.open(bridge);
  const gap = silentStart(t);
  try {
    await client.call("folders.search", { query: "existing" });
    mkdirSync(join(home, "code", "existing", ".git"));
    gap.watchers.get(join(home, "code"))!.change("existing/.git");
    assert.equal(gap.watchers.get(join(home, "code"))!.dropped, 1);
    gap.advance(200);
    assert.equal((await client.call("folders.search", { query: "existing" })).folders[0]?.git, true);
  } finally {
    await client.close();
    await bridge.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
