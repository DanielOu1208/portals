import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { DroidSessionFiles, droidHistory, snapshotField } from "../src/providers/droid/desk.ts";
import { sessionsSoFar } from "../src/providers/droid/store.ts";
import { DroidActivity } from "../src/providers/droid/activity.ts";
import { DroidForks, processStart } from "../src/providers/droid/fork.ts";
import { DroidProvider } from "../src/providers/droid/provider.ts";
import { listedDroids, openedDroids, type DroidProcess } from "../src/providers/droid/processes.ts";
import { cancelledForkTool, settledDroidSnapshot, unfinishedDroidTools } from "../src/providers/droid/pending.ts";
import type { DroidSdk } from "../src/providers/droid/sdk.ts";
import { DeskRefused, type SessionSink } from "../src/providers/types.ts";
import { startTestBridge, TestClient } from "./helpers.ts";

const instant = "2026-10-29T12:00:00.000Z";
function jsonl(...entries: unknown[]): string { return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"; }
function message(role: string, content: unknown, extra = {}) {
  return { type: "message", id: randomUUID(), timestamp: instant, message: { role, content, ...extra } };
}
function scratch(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "portals-droid-desk-"));
  const state = join(home, "bridge");
  let processes: DroidProcess[] = [];
  let loads = 0;
  let forks = 0;
  const sdk: DroidSdk = {
    async open() { loads++; throw new Error("An adoption must not load its source."); },
    async models() { return []; },
    async fork(snapshot, cwd, title, runtime) {
      forks++;
      assert.notEqual(snapshot, source);
      assert.deepEqual(JSON.parse(readFileSync(runtime, "utf8")), { hooks: { hooksDisabled: true } });
      const snapshotPath = join(home, ".factory", "sessions", "btw", `${snapshot}.jsonl`);
      const text = readFileSync(snapshotPath, "utf8").split("\n");
      assert.equal(unfinishedDroidTools(text.join("\n")).size, 0, "snapshot is settled before any native load");
      const first = JSON.parse(text[0]);
      assert.ok(first[snapshotField]);
      assert.ok(existsSync(join(state, "fork-snapshots", `${snapshot}.json`)), "manifest precedes snapshot");
      const id = randomUUID();
      first.id = id;
      first.title = title;
      const path = sessionPath(id, cwd);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, [JSON.stringify(first), ...text.slice(1)].join("\n"));
      return id;
    },
  };
  const provider = new DroidProvider({
    command: "/test/droid", directory: state, idleMs: 1000, maxWarm: 1, env: { HOME: home },
    sdk, checkVersion: false, processes: async () => processes,
  });
  t.after(async () => { await provider.close(); rmSync(home, { recursive: true, force: true }); });
  function sessionPath(id: string, cwd: string) { return join(home, ".factory", "sessions", cwd.replaceAll("/", "-"), `${id}.jsonl`); }
  function session(id = randomUUID(), cwd = "/test/project", header = {}, body = [message("user", [{ type: "text", text: "Fix the scratch bug" }])]) {
    const path = sessionPath(id, cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, jsonl({ type: "session_start", id, cwd, title: "Scratch conversation", ...header }, ...body));
    return { id, path, cwd };
  }
  const source = randomUUID();
  return { home, state, provider, sdk, session, source, files: new DroidSessionFiles(home, join(state, "names")),
    processes: (value: DroidProcess[]) => { processes = value; }, loads: () => loads, forks: () => forks };
}
const sink: SessionSink = { emit() {}, async ask() { return { kind: "withdrawn", reason: "no" }; } };

test("Droid desk discovery is file-only and excludes children, naming sessions, snapshots, malformed and symlinked files", async (t) => {
  const r = scratch(t);
  const source = r.session();
  r.session(randomUUID(), "/test/project", { callingSessionId: source.id });
  r.session(randomUUID(), "/test/project", { decompSessionType: "subagent" });
  r.session(randomUUID(), "/test/project", { [snapshotField]: "marker" });
  r.session(randomUUID(), join(r.state, "names"));
  r.session(randomUUID(), "/test/project", {}, []);
  const invalid = r.session();
  writeFileSync(invalid.path, '{"type":"session_start"\n');
  const symlink = r.session();
  rmSync(symlink.path);
  symlinkSync(source.path, symlink.path);
  const listed = await r.provider.deskSessions(100);
  assert.deepEqual(listed.map((session) => session.id), [source.id]);
  assert.equal(listed[0].state, "closed");
  assert.equal(r.loads(), 0);
  assert.equal(r.forks(), 0);
});

test("Droid desk summaries update after a file changes, and ids cannot traverse directories", async (t) => {
  const r = scratch(t);
  const source = r.session();
  assert.equal((await r.files.newest(5))[0].title, "Scratch conversation");
  const text = readFileSync(source.path, "utf8").replace("Scratch conversation", "A much newer title");
  writeFileSync(source.path, text);
  assert.equal((await r.files.newest(5))[0].title, "A much newer title");
  assert.equal(await r.files.find("../outside"), null);
  assert.equal(await r.files.find(randomUUID()), null);
});

test("Droid read adoption preserves displayed history and settings without loading or rewriting the original", async (t) => {
  const r = scratch(t);
  const source = r.session(undefined, undefined, {}, [
    message("user", [{ type: "text", text: "Visible question" }]),
    message("user", [{ type: "text", text: "secret hook output" }], { hookEventName: "SessionStart", visibility: "user_only" }),
    message("user", [{ type: "text", text: "hidden context" }], { visibility: "llm_only" }),
    message("assistant", [{ type: "thinking", thinking: "Visible thought" }, { type: "text", text: "Visible answer" }]),
    message("assistant", [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "/test/project/a.txt" } }]),
    message("user", [{ type: "tool_result", tool_use_id: "read", content: [{ type: "text", text: "hello" }] }]),
  ]);
  writeFileSync(source.path.replace(".jsonl", ".settings.json"), JSON.stringify({
    model: "claude-haiku-5-5", reasoningEffort: "high", autonomyLevel: "medium", interactionMode: "auto",
  }));
  const before = readFileSync(source.path);
  const adopted = await r.provider.adopt(source.id, "read");
  assert.deepEqual(adopted.settings, { model: "claude-haiku-5-5", provider: "droid", reasoningEffort: "high" });
  const state = r.provider.store.read(source.id);
  assert.deepEqual(state.defaults, { autonomyLevel: "medium", interactionMode: "auto" });
  const resumed = await r.provider.resumeSession({ id: source.id, cwd: source.cwd, settings: adopted.settings, readOnly: true }, sink);
  const history = await resumed.history();
  assert.deepEqual(history.map((row) => row.role), ["user", "assistant", "tool"]);
  assert.equal(history[0].timestamp, Date.parse(instant) / 1000);
  assert.equal(history[1].role === "assistant" && history[1].reasoning, "Visible thought");
  assert.deepEqual(history[2].role === "tool" && JSON.parse(history[2].content!), { content: "hello" });
  await assert.rejects(resumed.initialize(), /view only/);
  assert.deepEqual(readFileSync(source.path), before);
  assert.equal(r.loads(), 0);
});

test("Droid exec processes map only to their id or folder; owned children and unrelated processes do not block", () => {
  const id = randomUUID();
  const open = openedDroids([
    { pid: 1, command: "/tmp/droid", args: `droid exec --resume ${id}`, argv: ["droid", "exec", "--resume", id], cwd: "/other" },
    { pid: 2, command: "/tmp/droid", args: "droid exec --input-format stream-jsonrpc", cwd: "/project" },
    { pid: 3, command: "/tmp/droid", args: "droid daemon" },
    { pid: 4, command: "/tmp/not-droid", args: "not-droid daemon" },
  ], new Set([3]));
  assert.deepEqual([...open.ids], [id]);
  assert.deepEqual([...open.folders], ["/project"]);
  assert.equal(open.uncertain, false);
});

test("Droid exec prompt text cannot bypass Continue's ownership check, with flat or structured arguments", async (t) => {
  const r = scratch(t);
  const source = r.session();
  const mentioned = randomUUID();
  const prompt = `Explain --resume ${mentioned} in the docs`;
  for (const argv of [undefined, ["droid", "exec", prompt]]) {
    r.processes([{ pid: 1, command: "/tmp/droid", args: `droid exec ${prompt}`, argv, cwd: source.cwd }]);
    await assert.rejects(r.provider.adopt(source.id, "continue"), /Quit.*Droid.*fork/);
  }
  r.processes([{ pid: 2, command: "/tmp/droid", args: `droid exec ${prompt} --session-id ${source.id}`, cwd: "/elsewhere" }]);
  await assert.rejects(r.provider.adopt(source.id, "continue"), /Quit.*Droid.*fork/);
  assert.equal(openedDroids([{ pid: 3, command: "/tmp/droid", args: `droid exec ${prompt}` }], new Set()).uncertain, true);
  assert.equal(r.loads(), 0);
});

test("Droid bare and --resume TUIs can switch sessions, and desktop IPC daemon conservatively owns all sessions", () => {
  for (const args of ["droid", `droid --resume ${randomUUID()}`, "droid daemon --listen ipc"]) {
    assert.equal(openedDroids([{ pid: 1, command: "/Applications/Factory.app/Contents/Resources/bin/droid", args }], new Set()).uncertain, true);
  }
});

test("Droid Continue refuses a mapped worker and Factory daemon, but read and snapshot fork remain available", async (t) => {
  const r = scratch(t);
  const source = r.session(r.source);
  for (const process of [
    { pid: 1, command: "/tmp/droid", args: `droid exec --resume ${source.id}`, cwd: "/other" },
    { pid: 2, command: "/Applications/Factory.app/Contents/Resources/bin/droid", args: "droid daemon --listen ipc" },
  ]) {
    r.processes([process]);
    await assert.rejects(r.provider.adopt(source.id, "continue"), /Quit.*(?:Droid|Factory app).*fork|Factory app.*Fork/);
    await r.provider.adopt(source.id, "read");
    const fork = await r.provider.adopt(source.id, "fork");
    assert.notEqual(fork.id, source.id);
  }
  assert.equal(r.loads(), 0);
  assert.equal(r.forks(), 2);
});

test("Droid Continue accepts unrelated exec folders, then rechecks before a cold resume", async (t) => {
  const r = scratch(t);
  const source = r.session();
  r.processes([{ pid: 1, command: "/tmp/droid", args: "droid exec", cwd: "/unrelated" }]);
  const adopted = await r.provider.adopt(source.id, "continue");
  const session = await r.provider.resumeSession({ id: source.id, cwd: source.cwd, settings: adopted.settings }, sink);
  r.processes([{ pid: 2, command: "/tmp/droid", args: "droid daemon --listen ipc" }]);
  await assert.rejects(session.initialize(), /Factory app.*Fork/);
  assert.equal(r.loads(), 0);
});

test("Droid snapshot forks keep the original byte-identical, clean marked snapshots and retain original lineage", async (t) => {
  const r = scratch(t);
  const source = r.session(r.source);
  const before = readFileSync(source.path);
  const fork = await r.provider.adopt(source.id, "fork");
  const made = await r.files.find(fork.id);
  assert.ok(made);
  assert.equal(fork.title, "Scratch conversation (fork)");
  const header = JSON.parse(readFileSync(made.path, "utf8").split("\n")[0]);
  assert.equal(header.parent, source.id);
  assert.equal(header[snapshotField], undefined);
  assert.deepEqual(readFileSync(source.path), before);
  assert.deepEqual(readdirSync(join(r.home, ".factory", "sessions", "btw")), []);
  assert.deepEqual(readdirSync(join(r.state, "fork-snapshots")), []);
});

for (const returnsSource of [false, true]) test(`a warm Droid fork ${returnsSource ? "refuses a returned source id" : "settles interrupted native calls before registration"}`, async (t) => {
  const r = scratch(t);
  const body = [
    message("user", "Interrupted request"),
    message("assistant", [{ type: "tool_use", id: "execute", name: "Execute", input: { command: "touch must-not-run" } }]),
  ];
  const source = r.session(undefined, undefined, {}, body);
  const kept = { ...await r.files.thread((await r.files.find(source.id))!), id: "warm-source", deskSource: false };
  r.provider.store.write(kept);
  const session = await r.provider.resumeSession({ id: kept.id, cwd: kept.cwd, settings: kept.settings }, sink);
  const child = returnsSource ? source : r.session(undefined, source.cwd, {}, body);
  t.mock.method(session, "fork", async () => ({ id: child.id, thread: structuredClone(kept), warm: true }));
  const before = readFileSync(source.path);
  if (returnsSource) await assert.rejects(r.provider.adopt(kept.id, "fork"), /separate session/);
  else {
    const fork = await r.provider.adopt(kept.id, "fork");
    assert.equal(unfinishedDroidTools(readFileSync(child.path, "utf8")).size, 0);
    assert.ok(r.provider.store.read(fork.id).messages.some((row) => row.role === "tool" && row.content?.includes(cancelledForkTool)));
  }
  assert.deepEqual(readFileSync(source.path), before);
  assert.equal(r.loads(), 0);
});

test("Droid failed forks clean their exact snapshot and leave unrelated files alone", async (t) => {
  const r = scratch(t);
  const source = r.session(r.source);
  const other = join(r.home, ".factory", "sessions", "btw", "unrelated.jsonl");
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, "untouched");
  r.sdk.fork = async () => { throw new Error("native fork failed"); };
  await assert.rejects(r.provider.adopt(source.id, "fork"), /native fork failed/);
  assert.deepEqual(readdirSync(dirname(other)), ["unrelated.jsonl"]);
  assert.equal(readFileSync(other, "utf8"), "untouched");
  assert.deepEqual(readdirSync(join(r.state, "fork-snapshots")), []);
});

test("Droid snapshot forks cancel unfinished calls and native pending markers before any load, without running or editing the source", async (t) => {
  const r = scratch(t);
  const source = r.session(r.source, undefined, {}, [
    message("user", "A scratch request"),
    message("assistant", [
      { type: "tool_use", id: "execute", name: "Execute", input: { command: "touch scratch-marker" } },
      { type: "tool_use", id: "task", name: "Task", input: { prompt: "A pending task" } },
    ]),
    message("tool", [{ type: "tool_result", toolUseId: "execute", content: "__TOOL_RESULT_PENDING__" }]),
  ]);
  const before = readFileSync(source.path);
  assert.equal(unfinishedDroidTools(before.toString()).size, 2);
  const fork = await r.provider.adopt(source.id, "fork");
  const tools = r.provider.store.read(fork.id).messages.filter((row) => row.role === "tool");
  assert.equal(tools.length, 2);
  assert.ok(tools.every((row) => row.content?.includes(cancelledForkTool)));
  assert.equal(JSON.parse(tools[0].content!).exit_code, 1);
  assert.equal(JSON.parse(tools[1].content!).success, false);
  assert.deepEqual(readFileSync(source.path), before);
  assert.equal(r.loads(), 0);
  const settled = settledDroidSnapshot(before.toString());
  assert.equal(unfinishedDroidTools(settled).size, 0);
  const cancellation = JSON.parse(settled.trimEnd().split("\n").at(-1)!);
  assert.equal(cancellation.message.role, "user", "native persisted format, not in-memory role=tool");
  assert.equal(cancellation.parentId, JSON.parse(before.toString().trimEnd().split("\n").at(-1)!).id);
  assert.ok(cancellation.message.content.every((block: Record<string, unknown>) =>
    typeof block.tool_use_id === "string" && block.is_error === true && block.toolUseId === undefined));
});

test("Droid Continue refuses unfinished calls before adoption and rechecks before a cold native load", async (t) => {
  const r = scratch(t);
  const source = r.session();
  const adopted = await r.provider.adopt(source.id, "continue");
  const resumed = await r.provider.resumeSession({ id: source.id, cwd: source.cwd, settings: adopted.settings }, sink);
  writeFileSync(source.path, readFileSync(source.path, "utf8") + jsonl(message("assistant", [
    { type: "tool_use", id: "pending", name: "Execute", input: { command: "touch scratch-marker" } },
  ])));
  await assert.rejects(r.provider.adopt(source.id, "continue"), /unfinished tool calls.*automatically/);
  await assert.rejects(resumed.initialize(), /unfinished tool calls.*automatically/);
  assert.equal(r.loads(), 0);
});

test("a cold continued Droid fork preserves authoritative policy and display but resets native usage counters", async (t) => {
  const r = scratch(t);
  const source = r.session();
  writeFileSync(source.path.replace(".jsonl", ".settings.json"), JSON.stringify({ autonomyLevel: "high", interactionMode: "auto" }));
  await r.provider.adopt(source.id, "continue");
  const kept = r.provider.store.read(source.id);
  kept.mode = "ask";
  kept.sessionTokens = 100_000;
  kept.liveSessionTokens = 100_000;
  kept.sessionCredits = 25;
  kept.messages.push({ role: "assistant", text: "Kept display", timestamp: Date.now(), turn_usage: { tokens: 100, seconds: 1 } });
  r.provider.store.write(kept);
  const fork = await r.provider.adopt(source.id, "fork");
  const copy = r.provider.store.read(fork.id);
  assert.equal(copy.mode, "ask");
  assert.deepEqual(copy.messages, kept.messages);
  assert.equal(copy.sessionTokens, 0);
  assert.equal(copy.liveSessionTokens, 0);
  assert.equal(copy.sessionCredits, 0);
  let tokens: number | undefined;
  new DroidActivity((event) => { if (event.type === "turn.usage") tokens = event.usage.tokens; }, copy.liveSessionTokens!)
    .accept({ type: "token_usage_update", inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 });
  assert.equal(tokens, 1000, "the first fork turn does not subtract its source's baseline");
});

test("Droid startup sweeps only snapshots with both durable manifest and matching header marker", (t) => {
  const r = scratch(t);
  const folder = join(r.home, ".factory", "sessions", "btw");
  const manifests = join(r.state, "fork-snapshots");
  mkdirSync(folder, { recursive: true });
  mkdirSync(manifests, { recursive: true });
  const ids = [0, 1, 2].map(() => `706f7274${randomUUID().slice(8)}`);
  for (const [index, id] of ids.entries()) {
    writeFileSync(join(manifests, `${id}.json`), JSON.stringify({ id, token: "ours", cwd: "/test/project", pid: index === 2 ? process.pid : 2147483647 }));
    writeFileSync(join(folder, `${id}.jsonl`), jsonl({ type: "session_start", id, [snapshotField]: index === 1 ? "not-ours" : "ours" }));
    writeFileSync(join(folder, `${id}.settings.json`), "{}");
  }
  new DroidForks(r.state, r.home).sweep();
  assert.equal(existsSync(join(folder, `${ids[0]}.jsonl`)), false);
  assert.equal(existsSync(join(folder, `${ids[0]}.settings.json`)), false);
  assert.equal(existsSync(join(manifests, `${ids[0]}.json`)), false);
  for (const id of ids.slice(1)) assert.equal(existsSync(join(folder, `${id}.jsonl`)), true);
});

test("Droid read preflight never overwrites a kept Portals transcript; its native id lists only as its Portals id", async (t) => {
  const r = scratch(t);
  const source = r.session();
  const imported = await r.files.thread((await r.files.find(source.id))!, "portals-thread");
  imported.messages.push({ role: "assistant", text: "Portals-only display", timestamp: Date.now() });
  r.provider.store.write(imported);
  const before = readFileSync(r.provider.store.file(imported.id)!);
  await r.provider.adopt(imported.id, "read");
  assert.deepEqual(readFileSync(r.provider.store.file(imported.id)!), before);
  assert.deepEqual((await r.provider.deskSessions(10)).map((entry) => entry.id), ["portals-thread"]);
  assert.equal(await r.provider.keeps(imported.id), true);
});

test("a Droid desk snapshot fork imports the latest source history, not a previous read's stale transcript", async (t) => {
  const r = scratch(t);
  const source = r.session(r.source);
  await r.provider.adopt(source.id, "read");
  writeFileSync(source.path, readFileSync(source.path, "utf8") + jsonl(message("assistant", "A newer answer")));
  const fork = await r.provider.adopt(source.id, "fork");
  assert.ok(r.provider.store.read(fork.id).messages.some((row) => row.role === "assistant" && row.text === "A newer answer"));
});

test("an already continued Droid desk thread retains its Portals-only display when adopted again", async (t) => {
  const r = scratch(t);
  const source = r.session();
  await r.provider.adopt(source.id, "continue");
  const state = r.provider.store.read(source.id);
  assert.equal(state.deskReadOnly, false);
  state.messages.push({ role: "assistant", text: "Portals-only display", timestamp: Date.now() });
  r.provider.store.write(state);
  await r.provider.adopt(source.id, "continue");
  assert.deepEqual(r.provider.store.read(source.id).messages, state.messages);
});

test("a Droid fork captures display changes completed while native discovery was awaiting", async (t) => {
  const r = scratch(t);
  const source = r.session();
  const kept = { ...await r.files.thread((await r.files.find(source.id))!), id: "owned-source", deskSource: false };
  r.provider.store.write(kept);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const find = DroidSessionFiles.prototype.find;
  let held = false;
  t.mock.method(DroidSessionFiles.prototype, "find", async function (this: DroidSessionFiles, id: string) {
    if (id === source.id && !held) { held = true; entered.resolve(); await release.promise; }
    return find.call(this, id);
  });
  t.after(() => release.resolve());
  const forking = r.provider.adopt(kept.id, "fork");
  await entered.promise;
  kept.messages.push({ role: "assistant", text: "Finished while discovering", timestamp: Date.now() });
  r.provider.store.write(kept);
  writeFileSync(source.path, readFileSync(source.path, "utf8") + jsonl(message("assistant", "Finished while discovering")));
  release.resolve();
  const fork = await forking;
  assert.deepEqual(r.provider.store.read(fork.id).messages, kept.messages);
});

for (const mapped of [false, true]) for (const pending of [false, true])
test(`Droid reconciles ${mapped ? "mapped" : "legacy"} repeated background ids when the latest call is ${pending ? "cancelled" : "settled"}`, async (t) => {
  const r = scratch(t);
  const firstResult = pending ? "Earlier succeeded" : cancelledForkTool;
  const call = message("assistant", [{ type: "tool_use", id: "call_0", name: "Execute", input: { command: "echo test", fireAndForget: true } }]);
  const source = r.session(undefined, undefined, {}, [
    message("user", "Background work"), call,
    message("user", [{ type: "tool_result", tool_use_id: "call_0", content: firstResult, is_error: !pending }]),
    call, ...(pending ? [] : [message("user", [{ type: "tool_result", tool_use_id: "call_0", content: "Latest succeeded" }])]),
  ]);
  const kept = { ...await r.files.thread((await r.files.find(source.id))!), id: "background-source", deskSource: false };
  const rows = kept.messages.filter((row) => row.role === "tool");
  rows[0].tool_call_id = mapped ? "display-first" : "call_0#bg-aabbccdd";
  rows[1].tool_call_id = mapped ? "display-last" : "call_0#bg-eeff0011";
  const saved = { ...kept, ...(mapped ? { nativeToolIds: { "display-first": "call_0", "display-last": "call_0" } } : {}) };
  r.provider.store.write(saved);
  const fork = await r.provider.adopt(kept.id, "fork");
  const copied = r.provider.store.read(fork.id).messages.filter((row) => row.role === "tool");
  assert.equal(copied[0].content, rows[0].content, "historical result is not overwritten");
  if (pending) assert.match(copied[1].content ?? "", /cancelled.*not run/s);
  else assert.equal(copied[1].content, rows[1].content, "an older cancellation does not cancel a newer completed call");
  assert.equal(r.loads(), 0);
});

test("Droid imported background calls have stable distinct display ids and retain their native ids", async (t) => {
  const r = scratch(t);
  const call = message("assistant", [{ type: "tool_use", id: "call_0", name: "Execute", input: { command: "npm test", fireAndForget: true } }]);
  const source = r.session(undefined, undefined, {}, [
    message("user", "First run"), call, message("user", [{ type: "tool_result", tool_use_id: "call_0", content: "First result" }]),
    message("user", "Second run"), call, message("user", [{ type: "tool_result", tool_use_id: "call_0", content: "Second result" }]),
  ]);
  const state = await r.files.thread((await r.files.find(source.id))!);
  const rows = state.messages.filter((row) => row.role === "tool");
  assert.equal(new Set(rows.map((row) => row.tool_call_id)).size, 2);
  assert.deepEqual(rows.map((row) => JSON.parse(row.content!).output), ["First result", "Second result"]);
  assert.deepEqual(state.nativeToolIds, Object.fromEntries(rows.map((row) => [row.tool_call_id, "call_0"])));
  assert.deepEqual((await r.files.thread((await r.files.find(source.id))!)).messages, state.messages);
});

test("Droid Read gives absent, pending and null tool outcomes explicit unfinished errors without touching the source", async (t) => {
  const r = scratch(t);
  const source = r.session(undefined, undefined, {}, [
    message("user", "Unfinished work"),
    message("assistant", [
      { type: "tool_use", id: "execute", name: "Execute", input: { command: "touch do-not-run" } },
      { type: "tool_use", id: "edit", name: "Edit", input: { file_path: "/test/project/a", old_str: "old", new_str: "new" } },
      { type: "tool_use", id: "task", name: "Task", input: { prompt: "do not resume" } },
    ]),
    message("user", [{ type: "tool_result", tool_use_id: "execute", content: "Background process started (PID: 12)" }]),
    message("user", [
      { type: "tool_result", tool_use_id: "execute", content: "__TOOL_RESULT_PENDING__" },
      { type: "tool_result", tool_use_id: "edit", content: null },
    ]),
  ]);
  const before = readFileSync(source.path);
  await r.provider.adopt(source.id, "read");
  const rows = r.provider.store.read(source.id).messages.filter((row) => row.role === "tool");
  assert.equal(JSON.parse(rows[0].content!).exit_code, 1);
  for (const row of rows.slice(1)) assert.equal(JSON.parse(row.content!).success, false);
  assert.ok(rows.every((row) => /not finished/.test(row.content ?? "")));
  assert.equal(JSON.parse(rows[1].content!).diff, undefined, "unfinished edits never claim a successful diff");
  assert.deepEqual(readFileSync(source.path), before);
  assert.equal(r.loads(), 0);
});

test("Droid history ignores corrupt trailing lines without losing earlier visible messages", () => {
  const history = droidHistory(jsonl({ type: "session_start" }, message("user", "hello"), message("assistant", "done")) + '{"type":"message"', "/test");
  assert.deepEqual(history.map((row) => row.role), ["user", "assistant"]);
});

test("Droid imports image-only sessions and keeps assistant text before its tool call", async (t) => {
  const r = scratch(t);
  r.session(undefined, undefined, {}, [message("user", [{ type: "image", source: { data: "not copied into history" } }])]);
  assert.equal((await r.files.newest(1)).length, 1);
  const rows = droidHistory(jsonl({ type: "session_start" },
    message("user", [{ type: "image", source: { data: "not copied into history" } }]),
    message("assistant", [{ type: "text", text: "First" }, { type: "tool_use", id: "t", name: "LS", input: {} }, { type: "text", text: "Last" }]),
  ), "/test");
  assert.deepEqual(rows.map((row) => row.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(JSON.stringify(rows).includes("not copied"), false);
});

test("Droid discovery and history honor visible, model-only and hidden message flags", async (t) => {
  const r = scratch(t);
  const source = r.session(undefined, undefined, {}, [
    message("user", "Visible to both", { visibility: "both" }),
    message("assistant", "Visible only to user", { visibility: "user_only" }),
    message("assistant", "Hidden context", { visibility: "llm_only" }),
    message("assistant", "Hidden from user", { hiddenFromUserViews: true }),
    message("user", "Hidden hook", { visibility: "user_only", hookEventName: "SessionStart" }),
  ]);
  r.session(undefined, undefined, {}, [message("user", "Hidden only", { hiddenFromUserViews: true })]);
  assert.deepEqual((await r.files.newest(10)).map((row) => row.id), [source.id]);
  const history = droidHistory(readFileSync(source.path, "utf8"), source.cwd);
  assert.deepEqual(history.map((row) => "text" in row ? row.text : row.role), ["Visible to both", "Visible only to user"]);
});

test("Droid imports persisted compaction_state boundaries", () => {
  const history = droidHistory(jsonl({ type: "session_start" },
    message("user", "Before compaction"),
    { type: "compaction_state", timestamp: instant, compactionState: {} },
    message("assistant", "After compaction"),
  ), "/test");
  assert.deepEqual(history.map((row) => row.role), ["user", "compaction", "assistant"]);
  assert.equal(history[1].timestamp, Date.parse(instant));
});

test("Droid display and fallback titles strip native hidden user context without rewriting it", async (t) => {
  const r = scratch(t);
  const hidden = ["system-reminder", "system-notification", "remote-delegation-instructions",
    "user-delegation-instructions", "slack-thread", "slack-image-manifest"]
    .map((tag) => `<${tag}>Hidden context</${tag}>`).join("\n");
  const literal = "<system-reminder>Quoted assistant example</system-reminder>";
  const source = r.session(undefined, undefined, { title: "" }, [
    message("user", hidden),
    message("user", `${hidden}\nVisible question`),
    message("user", [{ type: "text", text: `Another question\n${hidden}` }]),
    message("assistant", [{ type: "text", text: literal }]),
    message("user", [null, { type: "text" }, { type: "text", text: 123 }]),
  ]);
  r.session(undefined, undefined, {}, [message("user", hidden)]);
  const before = readFileSync(source.path);
  assert.deepEqual((await r.files.newest(10)).map((row) => [row.id, row.title]), [[source.id, "Visible question"]]);
  await r.provider.adopt(source.id, "read");
  assert.deepEqual(r.provider.store.read(source.id).messages.map((row) => "text" in row ? row.text : row.role),
    ["Visible question", "Another question", literal]);
  assert.deepEqual(readFileSync(source.path), before);
  assert.equal(r.loads(), 0);
});

for (const reopen of [false, true]) {
  test(`Droid Read refuses Continue after the source moves to a hidden folder, reopened=${reopen}`, async (t) => {
    const r = scratch(t);
    const cwd = realpathSync(r.home);
    const hidden = join(cwd, "hidden");
    mkdirSync(hidden);
    const source = r.session(undefined, cwd);
    const bridge = await startTestBridge({
      providers: new Map([["droid", r.provider]]),
      config: { generalFolder: cwd, folders: { hide: [hidden] } }, temporaryFolders: [],
    });
    t.after(() => bridge.dispose());
    const phone = await TestClient.open(bridge);
    t.after(() => phone.close());
    await phone.call("session.adopt", { profile: "droid", session_id: source.id, mode: "read" });
    const registry = join(bridge.home, "state", "threads.json");
    const before = JSON.parse(readFileSync(registry, "utf8")).threads;
    const lines = readFileSync(source.path, "utf8").split("\n");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), lastCwd: hidden });
    writeFileSync(source.path, lines.join("\n"));
    const moved = readFileSync(source.path);
    if (reopen) await phone.call("session.resume", { session_id: source.id });
    await assert.rejects(phone.call("session.adopt", { profile: "droid", session_id: source.id, mode: "continue" }),
      (error: Error) => error.message === `This session moved to ${hidden} since it was read; open it from there, or use Fork.`);
    assert.deepEqual(JSON.parse(readFileSync(registry, "utf8")).threads, before);
    assert.equal(r.provider.store.read(source.id).deskReadOnly, true);
    assert.deepEqual(readFileSync(source.path), moved);
    assert.equal(r.loads(), 0);
  });
}

test("Droid rechecks a desk source's folder before a cold native Continue", async (t) => {
  const r = scratch(t);
  const source = r.session();
  const adopted = await r.provider.adopt(source.id, "continue");
  const session = await r.provider.resumeSession({ id: source.id, cwd: source.cwd, settings: adopted.settings }, sink);
  const lines = readFileSync(source.path, "utf8").split("\n");
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), lastCwd: "/test/moved" });
  writeFileSync(source.path, lines.join("\n"));
  await assert.rejects(session.initialize(), /This session moved to \/test\/moved.*Fork/);
  assert.equal(r.loads(), 0);
});

test("Droid Read persists reload and cold reopen snapshots for file-based search", async (t) => {
  const r = scratch(t);
  const source = r.session();
  const adopted = await r.provider.adopt(source.id, "read");
  const options = { id: source.id, cwd: source.cwd, settings: adopted.settings, readOnly: true };
  const session = await r.provider.resumeSession(options, sink);
  writeFileSync(source.path, readFileSync(source.path, "utf8") + jsonl(message("assistant", "Reload search needle")));
  const native = readFileSync(source.path);
  await session.reload();
  assert.deepEqual(readFileSync(source.path), native);
  const search = (await r.provider.searchFile(options))!;
  assert.ok(JSON.parse(readFileSync(search.path, "utf8")).messages.some((row: { text?: string }) => row.text === "Reload search needle"));
  await session.close();
  writeFileSync(source.path, readFileSync(source.path, "utf8") + jsonl(message("assistant", "Cold reopen search needle")));
  const coldNative = readFileSync(source.path);
  const reopened = await r.provider.resumeSession(options, sink);
  assert.ok(JSON.parse(readFileSync(search.path, "utf8")).messages.some((row: { text?: string }) => row.text === "Cold reopen search needle"));
  await reopened.close();
  assert.deepEqual(readFileSync(source.path), coldNative);
  assert.equal(r.loads(), 0);
});

test("Droid Read refresh never replaces a snapshot already continued here", async (t) => {
  const r = scratch(t);
  const source = r.session();
  const read = await r.provider.adopt(source.id, "read");
  const session = await r.provider.resumeSession({ id: source.id, cwd: source.cwd, settings: read.settings, readOnly: true }, sink);
  await r.provider.adopt(source.id, "continue");
  const owned = r.provider.store.read(source.id);
  owned.messages.push({ role: "user", text: "Authoritative Portals message", timestamp: 0 });
  r.provider.store.write(owned);
  const before = readFileSync(r.provider.store.file(source.id)!);
  await session.reload();
  assert.deepEqual(readFileSync(r.provider.store.file(source.id)!), before);
});

test("Droid Read keeps the newest concurrent refresh in its history and search file", async (t) => {
  const r = scratch(t);
  const source = r.session();
  const read = await r.provider.adopt(source.id, "read");
  const session = await r.provider.resumeSession({ id: source.id, cwd: source.cwd, settings: read.settings, readOnly: true }, sink);
  const thread = DroidSessionFiles.prototype.thread;
  let captured!: () => void;
  let release!: () => void;
  const imported = new Promise<void>((resolve) => { captured = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  t.mock.method(DroidSessionFiles.prototype, "thread", async function (this: DroidSessionFiles, ...args: Parameters<typeof thread>) {
    const snapshot = await thread.apply(this, args);
    if (first) { first = false; captured(); await held; }
    return snapshot;
  });
  const older = session.reload();
  await imported;
  try {
    writeFileSync(source.path, readFileSync(source.path, "utf8") + jsonl(message("assistant", "Newest concurrent search needle")));
    assert.equal((await session.reload()).length, 2);
  } finally { release(); }
  await older;
  assert.equal(r.provider.store.read(source.id).messages.length, 2);
  assert.equal((await session.history()).length, 2);
  assert.equal(r.loads(), 0);
});

test("profiles advertise adoption only for providers that implement it", async (t) => {
  const r = scratch(t);
  const bridge = await startTestBridge({ providers: new Map([["droid", r.provider]]) });
  t.after(() => bridge.dispose());
  const phone = await TestClient.open(bridge);
  t.after(() => phone.close());
  assert.deepEqual((await phone.call("profiles.list")).profiles[0].adopt_modes, ["continue", "fork", "read"]);
});

test("the gateway forks an ordinary Droid thread by its Portals id with history and policy, without loading its source", async (t) => {
  const r = scratch(t);
  const cwd = realpathSync(r.home);
  const source = r.session(undefined, cwd);
  writeFileSync(source.path.replace(".jsonl", ".settings.json"), JSON.stringify({
    model: "claude-haiku-5-5", reasoningEffort: "high", autonomyLevel: "high", interactionMode: "auto",
  }));
  const native = await r.files.find(source.id);
  const kept = { ...await r.files.thread(native!), id: "portals-existing", deskSource: false };
  r.provider.store.write(kept);
  const before = readFileSync(source.path);
  const bridge = await startTestBridge({
    providers: new Map([["droid", r.provider]]), config: { generalFolder: cwd }, temporaryFolders: [],
  });
  t.after(() => bridge.dispose());
  const phone = await TestClient.open(bridge);
  t.after(() => phone.close());
  const original = await phone.call("session.adopt", { profile: "droid", session_id: kept.id, mode: "continue" });
  assert.equal(original.session_id, kept.id);
  const forked = await phone.call("session.adopt", { profile: "droid", session_id: kept.id, mode: "fork" });
  assert.notEqual(forked.session_id, original.session_id);
  assert.equal(forked.info.title, "Scratch conversation (fork)");
  assert.equal(forked.info.cwd, cwd);
  assert.equal((await phone.call("session.resume", { session_id: forked.session_id })).messages.length, 1);
  const copy = r.provider.store.read(forked.session_id);
  assert.deepEqual(copy.settings, kept.settings);
  assert.deepEqual(copy.defaults, kept.defaults);
  assert.deepEqual(readFileSync(source.path), before);
  assert.equal(r.loads(), 0);
  assert.equal(r.forks(), 1);
});

test("the gateway refreshes a read-only Droid snapshot on reopen and again before Continue without losing external messages", async (t) => {
  const r = scratch(t);
  const cwd = realpathSync(r.home);
  const source = r.session(undefined, cwd);
  const bridge = await startTestBridge({
    providers: new Map([["droid", r.provider]]), config: { generalFolder: cwd }, temporaryFolders: [],
  });
  t.after(() => bridge.dispose());
  const phone = await TestClient.open(bridge);
  t.after(() => phone.close());
  await phone.call("session.adopt", { profile: "droid", session_id: source.id, mode: "read" });
  const before = readFileSync(source.path, "utf8");
  writeFileSync(source.path, before + jsonl(message("assistant", "Arrived before reopening")));
  let resumed = await phone.call("session.resume", { session_id: source.id });
  assert.equal(resumed.messages.length, 2);
  writeFileSync(source.path, readFileSync(source.path, "utf8") + jsonl(message("user", "Arrived before Continue")));
  await phone.call("session.adopt", { profile: "droid", session_id: source.id, mode: "continue" });
  resumed = await phone.call("session.resume", { session_id: source.id });
  assert.equal(resumed.messages.length, 3);
  assert.equal(r.provider.store.read(source.id).messages.length, 3);
  const forked = await phone.call("session.adopt", { profile: "droid", session_id: source.id, mode: "fork" });
  assert.equal((await phone.call("session.resume", { session_id: forked.session_id })).messages.length, 3);
  assert.equal(r.loads(), 0);
});

test("a desk session forked in Portals, then used in another folder, can still be continued: the fork's folder check pins nothing (PR #19 review B3)", async (t) => {
  const r = scratch(t);
  const cwd = realpathSync(r.home);
  const other = join(cwd, "other");
  mkdirSync(other);
  const source = r.session(r.source, cwd);
  const bridge = await startTestBridge({
    providers: new Map([["droid", r.provider]]), config: { generalFolder: cwd }, temporaryFolders: [],
  });
  t.after(() => bridge.dispose());
  const phone = await TestClient.open(bridge);
  t.after(() => phone.close());
  await phone.call("session.adopt", { profile: "droid", session_id: source.id, mode: "fork" });
  // Resumed later in the CLI from another folder.
  const lines = readFileSync(source.path, "utf8").split("\n");
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), lastCwd: other });
  writeFileSync(source.path, lines.join("\n"));
  const continued = await phone.call("session.adopt", { profile: "droid", session_id: source.id, mode: "continue" });
  assert.equal(continued.info.cwd, other);
  assert.equal(r.loads(), 0);
});

test("a desk session read in Portals whose read-only thread is gone can be continued after it moves (PR #19 review B3)", async (t) => {
  const r = scratch(t);
  const source = r.session();
  await r.provider.adopt(source.id, "read");
  const lines = readFileSync(source.path, "utf8").split("\n");
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), lastCwd: "/test/moved" });
  writeFileSync(source.path, lines.join("\n"));
  // No read-only thread lists it any more: the bridge asks without one.
  const continued = await r.provider.adopt(source.id, "continue");
  assert.equal(continued.cwd, "/test/moved");
  // While one does, the move is refused as before.
  await r.provider.adopt(source.id, "read");
  const kept = r.provider.store.read(source.id);
  kept.deskReadOnly = true;
  kept.deskReadCwd = "/test/project";
  r.provider.store.write(kept);
  await assert.rejects(r.provider.adopt(source.id, "continue", true), /This session moved to \/test\/moved since it was read/);
  assert.equal(r.loads(), 0);
});

test("a Droid Mission session is listed, but Read and Fork refuse it plainly, and Fork makes no session (PR #19 review B4)", async (t) => {
  const r = scratch(t);
  const source = r.session(r.source);
  writeFileSync(source.path.replace(".jsonl", ".settings.json"), JSON.stringify({ interactionMode: "agi" }));
  assert.equal((await r.provider.deskSessions(10)).length, 1);
  await assert.rejects(r.provider.adopt(source.id, "read"), (error: Error) => error instanceof DeskRefused && /Mission/.test(error.message));
  await assert.rejects(r.provider.adopt(source.id, "fork"), (error: Error) => error instanceof DeskRefused && /Mission/.test(error.message));
  assert.equal(r.forks(), 0);
  assert.deepEqual(readdirSync(dirname(source.path)).filter((name) => name.endsWith(".jsonl")), [`${source.id}.jsonl`]);
  assert.deepEqual((await r.provider.deskSessions(10)).map((session) => session.id), [source.id]);
});

test("a Droid fork whose import fails after the bridge made it a fork of its own is kept, as another request may have taken it up meanwhile (PR #19 review B4, Codex's final check of PR #19)", async (t) => {
  const r = scratch(t);
  const source = r.session(r.source);
  let made = "";
  const fork = r.sdk.fork!.bind(r.sdk);
  r.sdk.fork = async (snapshot, cwd, title, runtime) => {
    const id = await fork(snapshot, cwd, title, runtime);
    made = join(r.home, ".factory", "sessions", cwd.replaceAll("/", "-"), `${id}.jsonl`);
    writeFileSync(made.replace(".jsonl", ".settings.json"), JSON.stringify({ interactionMode: "mission" }));
    return id;
  };
  await assert.rejects(r.provider.adopt(source.id, "fork"));
  assert.equal(r.forks(), 1);
  assert.ok(existsSync(made), "the fork's conversation is left in place");
  assert.ok(existsSync(made.replace(".jsonl", ".settings.json")), "and its settings");
  assert.equal(JSON.parse(readFileSync(made, "utf8").split("\n")[0])[snapshotField], undefined, "it is a fork of its own, no snapshot");
  assert.deepEqual(readdirSync(join(r.state, "fork-snapshots")), []);
});

test("a read-only Droid desk thread whose source can no longer be imported still opens with its stored snapshot (PR #19 review B4)", async (t) => {
  const r = scratch(t);
  const source = r.session();
  const adopted = await r.provider.adopt(source.id, "read");
  writeFileSync(source.path.replace(".jsonl", ".settings.json"), JSON.stringify({ interactionMode: "agi" }));
  const resumed = await r.provider.resumeSession({ id: source.id, cwd: source.cwd, settings: adopted.settings, readOnly: true }, sink);
  assert.deepEqual((await resumed.history()).map((row) => row.role), ["user"]);
  assert.deepEqual((await resumed.reload!()).map((row) => row.role), ["user"]);
});

test("a droid that exits while the processes are listed is left out, not taken for a failed check (PR #19 review B7)", async () => {
  const gone = Object.assign(new Error("ps exited 1"), { code: 1 });
  const run = async (program: string, args: string[]) => {
    if (program === "/bin/ps" && args[0] === "-axo") return "  11 /tmp/droid\n  12 /tmp/droid\n  13 /usr/bin/other\n";
    if (program === "/usr/sbin/lsof") return "p11\nfcwd\nn/unrelated\n";
    if (program === "/bin/ps" && args[1] === "12") throw gone;
    if (program === "/bin/ps" && args[1] === "11") return "droid exec --input-format stream-jsonrpc\n";
    throw new Error(`unexpected ${program} ${args.join(" ")}`);
  };
  const listed = await listedDroids(run);
  assert.deepEqual(listed.map(({ pid }) => pid), [11]);
  // Any other failure is still a check that could not be made.
  await assert.rejects(listedDroids(async (program, args) => {
    if (program === "/bin/ps" && args[1] === "12") throw Object.assign(new Error("ps failed"), { code: 2 });
    return run(program, args);
  }));
});

test("the Droid sessions a Portals thread left behind (Spec's planning session, those before each /compact) are not listed as desk sessions (PR #19 review B5)", async (t) => {
  const r = scratch(t);
  const older = r.session(), previous = r.session(), current = r.session();
  const thread = { ...await r.files.thread((await r.files.find(current.id))!, "portals-thread"), deskSource: false, deskReadOnly: undefined };
  r.provider.store.write({ ...thread, previousSession: previous.id });
  assert.deepEqual((await r.provider.deskSessions(10)).map((session) => session.id).filter((id) => id !== older.id), ["portals-thread"]);
  r.provider.store.write({ ...thread, previousSession: previous.id, formerSessions: [older.id, previous.id] });
  assert.deepEqual((await r.provider.deskSessions(10)).map((session) => session.id), ["portals-thread"]);
});

test("a droid whose executable an update replaced still holds its session open (Linux's \"(deleted)\" path) (Codex's review of PR #19 fixes)", () => {
  const id = randomUUID();
  const open = openedDroids([
    { pid: 1, command: "/home/me/.local/bin/droid (deleted)", args: `droid exec --resume ${id}`, argv: ["droid", "exec", "--resume", id], cwd: "/other" },
    { pid: 2, command: "/home/me/.local/bin/droid (deleted)", args: "droid" },
  ], new Set());
  assert.deepEqual([...open.ids], [id]);
  assert.equal(open.uncertain, true);
});

test("a thread saved before it kept its former sessions keeps its previous one through its next /compact or Spec handoff (Codex's review of PR #19 fixes)", async (t) => {
  const r = scratch(t);
  const a = r.session(), b = r.session(), c = r.session();
  const old = { ...await r.files.thread((await r.files.find(b.id))!, "portals-thread"), deskSource: false, deskReadOnly: undefined, previousSession: a.id };
  // As the compaction and the handoff save the session they go on in.
  r.provider.store.write({ ...old, session: c.id, previousSession: old.session, formerSessions: sessionsSoFar(old) });
  assert.deepEqual(sessionsSoFar(old), [a.id, b.id]);
  assert.deepEqual((await r.provider.deskSessions(10)).map((session) => session.id), ["portals-thread"]);
  assert.deepEqual(sessionsSoFar({ ...old, formerSessions: [a.id, b.id], session: c.id, previousSession: b.id }), [a.id, b.id, c.id]);
});

test("the startup sweep removes a snapshot whose owner's pid now names another process, and keeps a live owner's (Codex's review of PR #19 fixes)", (t) => {
  const r = scratch(t);
  const folder = join(r.home, ".factory", "sessions", "btw");
  const manifests = join(r.state, "fork-snapshots");
  mkdirSync(folder, { recursive: true });
  mkdirSync(manifests, { recursive: true });
  const started = processStart(process.pid);
  assert.ok(started, "this process's start can be read");
  const [reused, live] = [0, 1].map(() => `706f7274${randomUUID().slice(8)}`);
  for (const [id, start] of [[reused, `${started} (an earlier process)`], [live, started]]) {
    writeFileSync(join(manifests, `${id}.json`), JSON.stringify({ id, token: "ours", cwd: "/test/project", pid: process.pid, started: start }));
    writeFileSync(join(folder, `${id}.jsonl`), jsonl({ type: "session_start", id, [snapshotField]: "ours" }));
  }
  new DroidForks(r.state, r.home).sweep();
  assert.equal(existsSync(join(folder, `${reused}.jsonl`)), false);
  assert.equal(existsSync(join(manifests, `${reused}.json`)), false);
  assert.equal(existsSync(join(folder, `${live}.jsonl`)), true);
  assert.equal(existsSync(join(manifests, `${live}.json`)), true);
});

test("a fork whose answer from Droid is lost after Droid wrote it leaves no session behind (Codex's review of PR #19 fixes)", async (t) => {
  const r = scratch(t);
  const source = r.session(r.source);
  const fork = r.sdk.fork!.bind(r.sdk);
  r.sdk.fork = async (...params) => {
    await fork(...params);
    throw new Error("Droid took too long to answer droid.fork_session.");
  };
  await assert.rejects(r.provider.adopt(source.id, "fork"), /too long/);
  assert.equal(r.forks(), 1);
  assert.deepEqual(readdirSync(dirname(source.path)), [`${source.id}.jsonl`]);
  assert.deepEqual(readdirSync(join(r.state, "fork-snapshots")), []);
});

test("the startup sweep also removes the fork a crashed bridge's snapshot was copied into, and only that (Codex's review of PR #19 fixes)", (t) => {
  const r = scratch(t);
  const folder = join(r.home, ".factory", "sessions", "btw");
  const manifests = join(r.state, "fork-snapshots");
  mkdirSync(folder, { recursive: true });
  mkdirSync(manifests, { recursive: true });
  const id = `706f7274${randomUUID().slice(8)}`;
  writeFileSync(join(manifests, `${id}.json`), JSON.stringify({ id, token: "ours", cwd: "/test/project", pid: 2147483647 }));
  writeFileSync(join(folder, `${id}.jsonl`), jsonl({ type: "session_start", id, [snapshotField]: "ours" }));
  // Droid's copy, made before the bridge could take the marker off it; a session of the person's; another bridge's copy.
  const output = r.session(undefined, "/test/project", { [snapshotField]: "ours" });
  writeFileSync(output.path.replace(".jsonl", ".settings.json"), "{}");
  const person = r.session(undefined, "/test/project");
  const other = r.session(undefined, "/test/project", { [snapshotField]: "theirs" });
  new DroidForks(r.state, r.home).sweep();
  assert.deepEqual(readdirSync(dirname(person.path)).sort(), [`${other.id}.jsonl`, `${person.id}.jsonl`].sort());
  assert.deepEqual(readdirSync(manifests), []);
  assert.equal(existsSync(join(folder, `${id}.jsonl`)), false);
});

test("a fork Droid names whose saved header does not prove it is the bridge's copy is refused but never deleted (Codex's final check of PR #19)", async (t) => {
  for (const header of ["no token", "another token", "unreadable"]) {
    const r = scratch(t);
    const source = r.session(r.source);
    let made = "";
    const fork = r.sdk.fork!.bind(r.sdk);
    r.sdk.fork = async (snapshot, cwd, title, runtime) => {
      const id = await fork(snapshot, cwd, title, runtime);
      made = join(r.home, ".factory", "sessions", cwd.replaceAll("/", "-"), `${id}.jsonl`);
      const [first, ...rest] = readFileSync(made, "utf8").split("\n");
      const line = header === "unreadable" ? first.slice(0, 20) : JSON.stringify({ ...JSON.parse(first), [snapshotField]: header === "no token" ? undefined : "theirs" });
      writeFileSync(made, [line, ...rest].join("\n"));
      writeFileSync(made.replace(".jsonl", ".settings.json"), "{}");
      return id;
    };
    const before = () => readFileSync(made, "utf8");
    await assert.rejects(r.provider.adopt(source.id, "fork"), /could not be verified/, header);
    assert.ok(existsSync(made), header);
    assert.ok(existsSync(made.replace(".jsonl", ".settings.json")), header);
    assert.ok(before().length > 0, header);
  }
});

test("a process's start identity reads the same whatever time zone or locale the bridge runs in, and a record of the old form is kept (Codex's final check of PR #19)", (t) => {
  const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LC_TIME: process.env.LC_TIME };
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const here = processStart(process.pid);
  Object.assign(process.env, { TZ: "Pacific/Kiritimati", LC_ALL: "fr_FR.UTF-8", LC_TIME: "fr_FR.UTF-8" });
  assert.equal(processStart(process.pid), here);
  // A record written in the old form (ps's local time, no format) cannot be compared: it is kept.
  const r = scratch(t);
  const folder = join(r.home, ".factory", "sessions", "btw");
  const manifests = join(r.state, "fork-snapshots");
  mkdirSync(folder, { recursive: true });
  mkdirSync(manifests, { recursive: true });
  const id = `706f7274${randomUUID().slice(8)}`;
  writeFileSync(join(manifests, `${id}.json`), JSON.stringify({ id, token: "ours", cwd: "/test/project", pid: process.pid, started: "Thu Oct 30 02:11:00 2026" }));
  writeFileSync(join(folder, `${id}.jsonl`), jsonl({ type: "session_start", id, [snapshotField]: "ours" }));
  new DroidForks(r.state, r.home).sweep();
  assert.equal(existsSync(join(manifests, `${id}.json`)), true);
  assert.equal(existsSync(join(folder, `${id}.jsonl`)), true);
});

test("the sweep keeps a snapshot's record while a recent session's header cannot be read yet, and removes Droid's copy once it can (Codex's final check of PR #19)", (t) => {
  const r = scratch(t);
  const folder = join(r.home, ".factory", "sessions", "btw");
  const manifests = join(r.state, "fork-snapshots");
  mkdirSync(folder, { recursive: true });
  mkdirSync(manifests, { recursive: true });
  const id = `706f7274${randomUUID().slice(8)}`;
  writeFileSync(join(manifests, `${id}.json`), JSON.stringify({ id, token: "ours", cwd: "/test/project", pid: 2147483647 }));
  writeFileSync(join(folder, `${id}.jsonl`), jsonl({ type: "session_start", id, [snapshotField]: "ours" }));
  const output = r.session(undefined, "/test/project", { [snapshotField]: "ours" });
  const whole = readFileSync(output.path, "utf8");
  // Droid is still writing its copy: the header is cut short.
  writeFileSync(output.path, whole.slice(0, 30));
  new DroidForks(r.state, r.home).sweep();
  assert.equal(existsSync(output.path), true);
  assert.equal(existsSync(join(manifests, `${id}.json`)), true, "the record stays, to be tried again");
  assert.equal(existsSync(join(folder, `${id}.jsonl`)), true);
  writeFileSync(output.path, whole);
  new DroidForks(r.state, r.home).sweep();
  assert.equal(existsSync(output.path), false);
  assert.deepEqual(readdirSync(manifests), []);
});

test("a fork whose rewrite without the snapshot's token fails part way keeps its token until it is deleted as the bridge's, and leaves no temporary file (Codex's final check of PR #19)", async (t) => {
  const r = scratch(t);
  const source = r.session(r.source);
  let made = "";
  const fork = r.sdk.fork!.bind(r.sdk);
  r.sdk.fork = async (snapshot, cwd, title, runtime) => {
    const id = await fork(snapshot, cwd, title, runtime);
    made = join(r.home, ".factory", "sessions", cwd.replaceAll("/", "-"), `${id}.jsonl`);
    return id;
  };
  // The disk fails as the rewritten conversation is being written out.
  const { fsyncSync } = fs;
  let marked: unknown;
  let temporary: string[] = [];
  fs.fsyncSync = () => {
    marked = JSON.parse(readFileSync(made, "utf8").split("\n")[0])[snapshotField];
    temporary = readdirSync(dirname(made)).filter((name) => name.startsWith("."));
    throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
  };
  syncBuiltinESMExports();
  t.after(() => { fs.fsyncSync = fsyncSync; syncBuiltinESMExports(); });
  await assert.rejects(r.provider.adopt(source.id, "fork"), /No space left/);
  fs.fsyncSync = fsyncSync;
  syncBuiltinESMExports();
  assert.equal(typeof marked, "string", "the fork still carried the snapshot's token as the write failed");
  assert.equal(temporary.length, 1, "the rewrite was written beside it, under a name Droid does not list");
  assert.deepEqual(readdirSync(dirname(source.path)), [`${source.id}.jsonl`], "deleted as the bridge's copy, and no temporary file is left");
  assert.deepEqual(readdirSync(join(r.state, "fork-snapshots")), []);
});

test("a file already under the fork's temporary name is not the bridge's, and is left as it is (Codex's final check of PR #19)", async (t) => {
  const r = scratch(t);
  const source = r.session(r.source);
  let other = "";
  const fork = r.sdk.fork!.bind(r.sdk);
  r.sdk.fork = async (snapshot, cwd, title, runtime) => {
    const id = await fork(snapshot, cwd, title, runtime);
    other = join(r.home, ".factory", "sessions", cwd.replaceAll("/", "-"), `.${id}.${process.pid}.tmp`);
    writeFileSync(other, "not the bridge's");
    return id;
  };
  await assert.rejects(r.provider.adopt(source.id, "fork"), /EEXIST/);
  assert.equal(readFileSync(other, "utf8"), "not the bridge's");
  assert.deepEqual(readdirSync(dirname(source.path)).sort(), [basename(other), `${source.id}.jsonl`].sort(), "the fork is deleted as the bridge's copy; the other file stays");
  assert.deepEqual(readdirSync(join(r.state, "fork-snapshots")), []);
});
