import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { DeskSessions } from "../src/desk.ts";
import { pathsFor } from "../src/config.ts";
import { readOnlyText } from "../src/gateway/methods.ts";
import { socketConnector } from "../src/providers/codex/client.ts";
import { CodexProvider } from "../src/providers/codex/provider.ts";
import { withoutOwn } from "../src/providers/claude/options.ts";
import { terminalHasIt } from "../src/providers/claude/session.ts";
import { sdkSessionFiles } from "../src/providers/claude/provider.ts";
import type { Provider } from "../src/providers/types.ts";
import { Registry, type ThreadRecord } from "../src/sessions/registry.ts";
import { fakeClaude, FakeFiles, inFolder, play, recordedHistory as claudeHistory } from "./claude-fixtures.ts";
import { fixtureCwd, recordedHistory as codexHistory, recordedThread, rewrite } from "./codex-fixtures.ts";
import { FakeDaemon } from "./codex-daemon.ts";
import { isEvent, RpcFailure, startTestBridge, TestClient, type Frame } from "./helpers.ts";

// Sessions started in a terminal at the desk (src/desk.ts): which are listed, in what
// state, and how `session.adopt` takes one up (continued, forked or only read), with
// recorded Claude sessions and a stand-in for Codex's daemon in place of the agents.

let root: string;
let daemon: FakeDaemon;
let images: string;
const at = (path: string) => join(root, path);
const minute = 60_000;
const now = Date.now();

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "portals-desk-test-")));
  for (const path of ["projects/app", "projects/notes", "projects/secret", "scratch/run", "scratch/general/inside"]) {
    mkdirSync(at(path), { recursive: true });
  }
  daemon = await FakeDaemon.start();
  images = mkdtempSync(join(tmpdir(), "portals-desk-images-"));
});

after(async () => {
  await daemon.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(images, { recursive: true, force: true });
});

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A Claude Code whose sessions and terminals the test sets. */
function claude(files = new FakeFiles()) {
  const open = new Set<string>();
  const made = fakeClaude({ files, agents: async () => [...open].map((sessionId, index) => ({ pid: 100 + index, kind: "interactive", sessionId, status: "idle" })) });
  return { ...made, open };
}

function sessionQueries(queries: ReturnType<typeof fakeClaude>["queries"]) {
  return queries.filter((query) => query.options.persistSession !== false);
}

/** A bridge whose General folder is `projects` and whose only temporary folder is `scratch`. */
async function bridgeWith(providers: Map<string, any>, options: { general?: string; home?: string; keepHome?: boolean } = {}) {
  return startTestBridge({
    providers,
    home: options.home,
    keepHome: options.keepHome,
    config: options.home ? undefined : { generalFolder: options.general ?? at("projects"), folders: { hide: [at("projects/secret")] } },
    temporaryFolders: [at("scratch")],
  });
}

function codexProvider(): CodexProvider {
  return new CodexProvider({
    settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: images },
    connect: socketConnector(daemon.socketPath),
    checkVersion: false,
    configPath: join(daemon.folder, "config.toml"),
  });
}

// MARK: Claude Code

test("Claude Code: the desk's sessions, newest first, with their state; the bridge's own and unlisted folders left out", async (t) => {
  const { provider, files, open } = claude();
  const bridge = await bridgeWith(new Map([["claude", provider]]));
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const session = (id: string, cwd: string | undefined, age: number, titles: { customTitle?: string; summary?: string; firstPrompt?: string } = {}) =>
    files.sessions.push({ sessionId: id, cwd, lastModified: now - age * minute, summary: titles.summary ?? "", ...titles });
  session("newest", at("projects/app"), 1, { customTitle: "Fix the login", summary: "Fix the login" });
  session("older", at("projects/notes"), 30, { summary: "Notes, tidied" });
  session("prompt-only", at("projects/app"), 60, { firstPrompt: "Write a haiku\n  about   rain" });
  session("long", at("projects/app"), 90, { summary: "x".repeat(300) });
  session("temporary", at("scratch/run"), 2, { summary: "In a scratch folder" });
  session("hidden", at("projects/secret"), 3, { summary: "Hidden by config.json" });
  session("gone", at("projects/gone"), 4, { summary: "Its folder is gone" });
  session("nowhere", undefined, 5, { summary: "No folder" });
  session("own", bridge.home, 6, { summary: "In the bridge's folder" });
  open.add("newest");

  const listed = await client.call("desk.list", { profile: "claude" });
  assert.deepEqual(listed.sessions, [
    { id: "newest", title: "Fix the login", folder: at("projects/app"), updated: Math.floor((now - minute) / 1000), state: "open" },
    { id: "older", title: "Notes, tidied", folder: at("projects/notes"), updated: Math.floor((now - 30 * minute) / 1000), state: "closed" },
    { id: "prompt-only", title: "Write a haiku about rain", folder: at("projects/app"), updated: Math.floor((now - 60 * minute) / 1000), state: "closed" },
    { id: "long", title: `${"x".repeat(119)}…`, folder: at("projects/app"), updated: Math.floor((now - 90 * minute) / 1000), state: "closed" },
  ]);
  assert.deepEqual((await client.call("desk.list", { profile: "claude", limit: 2 })).sessions.map((entry: Frame) => entry.id), ["newest", "older"]);
  await assert.rejects(client.call("desk.list", { profile: "claude", limit: 0 }), (error: RpcFailure) => error.code === -32602);

  // Taken up, a session is a thread of the bridge's and no longer listed.
  await client.call("session.adopt", { profile: "claude", session_id: "older", mode: "continue" });
  assert.deepEqual((await client.call("desk.list", { profile: "claude" })).sessions.map((entry: Frame) => entry.id), ["newest", "prompt-only", "long"]);
});

test("session.adopt takes up no session desk.list leaves out for its folder, in any mode, and forks nothing", async (t) => {
  const { provider, files } = claude();
  const bridge = await bridgeWith(new Map<string, Provider>([["claude", provider], ["codex", codexProvider()]]));
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const session = (id: string, cwd: string) => files.sessions.push({ sessionId: id, cwd, lastModified: now - minute, summary: `In ${id}` });
  session("temporary", at("scratch/run"));
  session("hidden", at("projects/secret"));
  session("gone", at("projects/gone"));
  session("own", bridge.home);
  session("listed", at("projects/app"));
  assert.deepEqual((await client.call("desk.list", { profile: "claude" })).sessions.map((entry: Frame) => entry.id), ["listed"]);
  for (const id of ["temporary", "hidden", "gone", "own"]) {
    for (const mode of ["continue", "read", "fork"]) {
      await assert.rejects(client.call("session.adopt", { profile: "claude", session_id: id, mode }), (error: RpcFailure) => {
        assert.equal(error.code, -32602, `${id} ${mode}`);
        assert.match(error.message, /folder/);
        return true;
      });
    }
  }
  assert.deepEqual(files.forks, []);
  // Codex's the same: nothing is forked in Codex either.
  const turns = rewrite(codexHistory("tools").turns, [[fixtureCwd, at("projects/secret")]]);
  const hidden = daemon.addThread(at("projects/secret"), turns, { preview: "Secret work", updatedAt: Math.floor(now / 1000) });
  const forks = daemon.callsOf("thread/fork").length;
  await assert.rejects(client.call("session.adopt", { profile: "codex", session_id: hidden, mode: "fork" }), (error: RpcFailure) => error.code === -32602);
  await assert.rejects(client.call("session.adopt", { profile: "codex", session_id: hidden, mode: "continue" }), (error: RpcFailure) => error.code === -32602);
  assert.equal(daemon.callsOf("thread/fork").length, forks);
  assert.deepEqual((await client.call("threads.changes", {})).threads ?? [], []);
  assert.equal((await client.call("session.adopt", { profile: "claude", session_id: "listed", mode: "read" })).session_id, "listed");
});

test("a session only read is not continued once its folder is one desk.list leaves out", async (t) => {
  const { provider, files } = claude();
  const bridge = await bridgeWith(new Map<string, Provider>([["claude", provider]]));
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const folder = at("projects/going");
  mkdirSync(folder, { recursive: true });
  const id = "6d3c8a9e-0000-4000-8000-000000000009";
  files.sessions.push({ sessionId: id, cwd: folder, lastModified: now, summary: "Going" });
  files.stored.set(id, { title: null, messages: inFolder(claudeHistory("plain"), folder) });
  assert.equal((await client.call("session.adopt", { profile: "claude", session_id: id, mode: "read" })).session_id, id);
  // The folder is gone since: continuing would take it up anew, which desk.list no longer offers.
  rmSync(folder, { recursive: true, force: true });
  await assert.rejects(client.call("session.adopt", { profile: "claude", session_id: id, mode: "continue" }), (error: RpcFailure) => {
    assert.equal(error.code, -32602);
    assert.match(error.message, /folder/);
    return true;
  });
  assert.equal(JSON.parse(readFileSync(join(bridge.home, "state", "threads.json"), "utf8")).threads[0].readOnly, true);
});

test("the bridge's own Claude processes, which claude agents lists as interactive, are not terminals", () => {
  const listed = [
    { pid: 100, kind: "interactive", sessionId: "terminal" },
    { pid: 200, kind: "interactive", sessionId: "bridge-warm" },
    { kind: "background", sessionId: "background" },
  ];
  assert.deepEqual((withoutOwn(listed, new Set([200])) as { sessionId: string }[]).map((agent) => agent.sessionId), ["terminal", "background"]);
  assert.equal(withoutOwn("not a list", new Set([200])), "not a list");
});

test("a temporary folder that is General (or under it) counts", async (t) => {
  const { provider, files } = claude();
  const bridge = await bridgeWith(new Map([["claude", provider]]), { general: at("scratch/general") });
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  files.sessions.push(
    { sessionId: "in-general", cwd: at("scratch/general"), lastModified: now, summary: "Here" },
    { sessionId: "under-general", cwd: at("scratch/general/inside"), lastModified: now - minute, summary: "Under it" },
    { sessionId: "beside-general", cwd: at("scratch/run"), lastModified: now - 2 * minute, summary: "Beside it" },
  );
  assert.deepEqual((await client.call("desk.list", { profile: "claude" })).sessions.map((entry: Frame) => entry.id), ["in-general", "under-general"]);
});

test("Claude Code: a session open in a terminal is not continued; once closed it is, resumed by its own id", async (t) => {
  const { provider, files, open, queries } = claude();
  const bridge = await bridgeWith(new Map([["claude", provider]]));
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const id = "6d3c8a9e-0000-4000-8000-000000000001";
  files.sessions.push({ sessionId: id, cwd: at("projects/app"), lastModified: now, summary: "Say hello", firstPrompt: "Say hello." });
  files.stored.set(id, { title: null, messages: inFolder(claudeHistory("tools"), at("projects/app")) });
  open.add(id);

  await assert.rejects(
    client.call("session.adopt", { profile: "claude", session_id: id, mode: "continue" }),
    (error: RpcFailure) => error.code === -32602 && error.message === terminalHasIt,
  );
  await assert.rejects(client.call("session.adopt", { profile: "claude", session_id: id, mode: "later" }), (error: RpcFailure) => error.code === -32602 && /^mode must be one of/.test(error.message));
  await assert.rejects(client.call("session.adopt", { profile: "claude", session_id: "missing", mode: "continue" }), (error: RpcFailure) => error.code === -32602 && /no session by that id/.test(error.message));
  assert.deepEqual(JSON.parse(readFileSync(join(bridge.home, "state", "threads.json"), "utf8")).threads, []);

  open.delete(id);
  const adopted = await client.call("session.adopt", { profile: "claude", session_id: id, mode: "continue" });
  assert.equal(adopted.session_id, id);
  assert.equal(adopted.stored_session_id, id);
  assert.equal(adopted.info.cwd, at("projects/app"));
  assert.equal(adopted.info.title, "Say hello");
  assert.equal(adopted.info.model, "default");
  const [record] = JSON.parse(readFileSync(join(bridge.home, "state", "threads.json"), "utf8")).threads;
  assert.equal(record.origin, "desk");
  assert.equal(record.readOnly, undefined);

  // The history so far, then a turn that resumes the session itself.
  const resumed = await client.call("session.resume", { session_id: id, profile: "claude" });
  assert.deepEqual(
    resumed.messages.map((message: Frame) => (message.role === "tool" ? message.name : message.role)),
    ["user", "read_file", "assistant", "patch", "terminal", "assistant"],
  );
  const start = client.frames.length;
  assert.equal((await client.call("prompt.submit", { session_id: id, text: "Hello." })).status, "streaming");
  await until(() => sessionQueries(queries).length === 1);
  const [query] = sessionQueries(queries);
  assert.equal(query.options.resume, id);
  assert.equal(query.options.sessionId, undefined);
  assert.equal(query.options.forkSession, undefined);
  void play(query, "plain");
  await client.from(start, (frame) => isEvent(frame, "message.complete", id));

  // The process goes away; meanwhile the desk opened the session again: the next turn
  // does not start, and says why.
  query.end();
  await until(() => !query.isRunning);
  await new Promise((resolve) => setTimeout(resolve, 10));
  open.add(id);
  const next = client.frames.length;
  await client.call("prompt.submit", { session_id: id, text: "Again." });
  const failed = await client.from(next, (frame) => isEvent(frame, "message.complete", id));
  assert.equal(failed.params.payload.status, "error");
  assert.equal(failed.params.payload.text, terminalHasIt);
  assert.equal(sessionQueries(queries).length, 1);
});

test("Claude Code: a session open in a terminal is forked into a new thread with its history; the original is left alone", async (t) => {
  const { provider, files, open, queries } = claude();
  const bridge = await bridgeWith(new Map([["claude", provider]]));
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const id = "6d3c8a9e-0000-4000-8000-000000000002";
  files.sessions.push({ sessionId: id, cwd: at("projects/app"), lastModified: now, summary: "Edit hello", customTitle: "Edit hello" });
  files.stored.set(id, { title: "Edit hello", messages: inFolder(claudeHistory("tools"), at("projects/app")) });
  open.add(id);

  const forked = await client.call("session.adopt", { profile: "claude", session_id: id, mode: "fork" });
  assert.notEqual(forked.session_id, id);
  assert.deepEqual(files.forks, [[id, forked.session_id]]);
  assert.equal(forked.info.title, "Edit hello (fork)");
  assert.equal(forked.info.cwd, at("projects/app"));
  const resumed = await client.call("session.resume", { session_id: forked.session_id });
  assert.equal(resumed.messages.length, 6);

  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: forked.session_id, text: "Hello." });
  await until(() => sessionQueries(queries).length === 1);
  const [query] = sessionQueries(queries);
  // The fork is its own session: resumed by its id, with no terminal check for it.
  assert.equal(query.options.resume, forked.session_id);
  void play(query, "plain");
  await client.from(start, (frame) => isEvent(frame, "message.complete", forked.session_id));
  // The original is still on the desk's list, open.
  assert.deepEqual((await client.call("desk.list", { profile: "claude" })).sessions.map((entry: Frame) => [entry.id, entry.state]), [[id, "open"]]);
});

test("Claude Code: a session only read takes no message, shows what the terminal adds, and can be continued once closed", async (t) => {
  const { provider, files, open, queries } = claude();
  const bridge = await bridgeWith(new Map([["claude", provider]]));
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const id = "6d3c8a9e-0000-4000-8000-000000000003";
  const messages = inFolder(claudeHistory("tools"), at("projects/app"));
  files.sessions.push({ sessionId: id, cwd: at("projects/app"), lastModified: now, summary: "Edit hello" });
  files.stored.set(id, { title: null, messages: messages.slice(0, 3) });
  open.add(id);

  const read = await client.call("session.adopt", { profile: "claude", session_id: id, mode: "read" });
  assert.equal(read.session_id, id);
  const [record] = JSON.parse(readFileSync(join(bridge.home, "state", "threads.json"), "utf8")).threads;
  assert.equal(record.readOnly, true);
  await assert.rejects(client.call("prompt.submit", { session_id: id, text: "Hi." }), (error: RpcFailure) => error.code === -32602 && error.message === readOnlyText);
  await assert.rejects(client.call("image.attach_bytes", { session_id: id, content_base64: "aGk=", filename: "a.png" }), (error: RpcFailure) => error.message === readOnlyText);
  await assert.rejects(client.call("config.set", { session_id: id, key: "reasoning", value: "low" }), (error: RpcFailure) => error.message === readOnlyText);
  assert.equal((await client.call("session.resume", { session_id: id })).messages.length, 2);
  // The terminal went on: the next look shows it.
  files.stored.set(id, { title: null, messages });
  assert.equal((await client.call("session.resume", { session_id: id })).messages.length, 6);
  assert.equal(sessionQueries(queries).length, 0);

  // Continued, while the terminal still has it: refused, and it stays only read.
  await assert.rejects(client.call("session.adopt", { profile: "claude", session_id: id, mode: "continue" }), (error: RpcFailure) => error.message === terminalHasIt);
  await assert.rejects(client.call("prompt.submit", { session_id: id, text: "Hi." }), (error: RpcFailure) => error.message === readOnlyText);
  // Closed there: it is continued, as the same thread.
  open.delete(id);
  const continued = await client.call("session.adopt", { profile: "claude", session_id: id, mode: "continue" });
  assert.equal(continued.session_id, id);
  assert.equal(JSON.parse(readFileSync(join(bridge.home, "state", "threads.json"), "utf8")).threads[0].readOnly, undefined);
  const start = client.frames.length;
  assert.equal((await client.call("prompt.submit", { session_id: id, text: "Hello." })).status, "streaming");
  await until(() => sessionQueries(queries).length === 1);
  void play(sessionQueries(queries)[0], "plain");
  await client.from(start, (frame) => isEvent(frame, "message.complete", id));
});

test("threads taken up from the desk are kept across a restart, as they were taken up", async () => {
  const files = new FakeFiles();
  const first = claude(files);
  const before = await startTestBridge({
    keepHome: true,
    providers: new Map([["claude", first.provider]]),
    config: { generalFolder: at("projects") },
    temporaryFolders: [at("scratch")],
  });
  const phone = await TestClient.open(before);
  const continued = "6d3c8a9e-0000-4000-8000-000000000004";
  const read = "6d3c8a9e-0000-4000-8000-000000000005";
  for (const id of [continued, read]) {
    files.sessions.push({ sessionId: id, cwd: at("projects/notes"), lastModified: now, summary: `Session ${id.slice(-1)}` });
    files.stored.set(id, { title: null, messages: inFolder(claudeHistory("tools"), at("projects/notes")) });
  }
  first.open.add(read);
  await phone.call("session.adopt", { profile: "claude", session_id: continued, mode: "continue" });
  await phone.call("session.adopt", { profile: "claude", session_id: read, mode: "read" });
  await phone.close();
  await before.close();

  const second = claude(files);
  const after = await startTestBridge({ home: before.home, providers: new Map([["claude", second.provider]]), temporaryFolders: [at("scratch")] });
  const again = await TestClient.open(after);
  try {
    const records = JSON.parse(readFileSync(join(after.home, "state", "threads.json"), "utf8")).threads;
    assert.deepEqual(records.map((record: Frame) => [record.id, record.origin, record.readOnly ?? false, record.title]), [
      [continued, "desk", false, "Session 4"],
      [read, "desk", true, "Session 5"],
    ]);
    const resumed = await again.call("session.resume", { session_id: continued });
    assert.equal(resumed.messages.length, 6);
    assert.equal(resumed.info.cwd, at("projects/notes"));
    await again.call("session.resume", { session_id: read });
    await assert.rejects(again.call("prompt.submit", { session_id: read, text: "Hi." }), (error: RpcFailure) => error.message === readOnlyText);
    // Neither is offered again.
    assert.deepEqual((await again.call("desk.list", { profile: "claude" })).sessions, []);
    // The one continued is still checked against the terminals when Claude starts for it.
    second.open.add(continued);
    const start = again.frames.length;
    await again.call("prompt.submit", { session_id: continued, text: "Hi." });
    const failed = await again.from(start, (frame) => isEvent(frame, "message.complete", continued));
    assert.equal(failed.params.payload.text, terminalHasIt);
  } finally {
    await again.close();
    await after.dispose();
  }
});

test("Claude Code: a thread taken off the list is offered again, with its own checks, whether the desk or a device started it", async (t) => {
  const { provider, files, open, queries } = claude();
  const bridge = await bridgeWith(new Map([["claude", provider]]));
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const removed = () => JSON.parse(readFileSync(join(bridge.home, "state", "removed.json"), "utf8")).threads.map((entry: Frame) => entry.thread.id);
  const fromDesk = "6d3c8a9e-0000-4000-8000-000000000006";
  files.sessions.push({ sessionId: fromDesk, cwd: at("projects/app"), lastModified: now - minute, summary: "Tidy the README" });
  files.stored.set(fromDesk, { title: null, messages: inFolder(claudeHistory("tools"), at("projects/app")) });
  await client.call("session.adopt", { profile: "claude", session_id: fromDesk, mode: "continue" });
  // Started from a device: Claude Code's list of the desk's sessions leaves it out.
  const fromPhone = (await client.call("session.create", { profile: "claude", title: "From the phone" })).session_id;
  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: fromPhone, text: "Write the notes." });
  await until(() => sessionQueries(queries).length === 1);
  void play(sessionQueries(queries)[0], "plain");
  await client.from(start, (frame) => isEvent(frame, "message.complete", fromPhone));
  files.started.push({ sessionId: fromPhone, cwd: at("projects"), lastModified: now, summary: "Write the notes" });
  files.stored.set(fromPhone, { title: null, messages: inFolder(claudeHistory("tools"), at("projects")) });
  const phoneTitle = (await client.call("threads.changes", {})).threads.find((entry: Frame) => entry.id === fromPhone).title;
  // Not Claude Code's own summary of it: the title comes back from the bridge's record.
  assert.notEqual(phoneTitle, "Write the notes");
  assert.deepEqual((await client.call("desk.list", { profile: "claude" })).sessions, []);

  await client.call("thread.delete", { thread: fromDesk });
  await client.call("thread.delete", { thread: fromPhone });
  assert.deepEqual(removed(), [fromDesk, fromPhone]);
  const offered = (await client.call("desk.list", { profile: "claude" })).sessions;
  assert.deepEqual(
    offered.map((entry: Frame) => [entry.id, entry.title, entry.folder, entry.state]),
    [
      [fromPhone, phoneTitle, at("projects"), "closed"],
      [fromDesk, "Tidy the README", at("projects/app"), "closed"],
    ],
  );

  // Claude Code's own checks still hold: not continued while a terminal has it.
  open.add(fromDesk);
  await assert.rejects(client.call("session.adopt", { profile: "claude", session_id: fromDesk, mode: "continue" }), (error: RpcFailure) => error.message === terminalHasIt);
  open.delete(fromDesk);
  for (const [id, title] of [
    [fromDesk, "Tidy the README"],
    [fromPhone, phoneTitle],
  ]) {
    const adopted = await client.call("session.adopt", { profile: "claude", session_id: id, mode: "continue" });
    assert.equal(adopted.session_id, id);
    // With the title it had, as offered.
    assert.equal(adopted.info.title, title);
    assert.equal((await client.call("session.resume", { session_id: id })).messages.length, 6);
  }
  assert.deepEqual(removed(), []);
  assert.deepEqual((await client.call("desk.list", { profile: "claude" })).sessions, []);
  assert.deepEqual(
    (await client.call("threads.changes", {})).threads.map((entry: Frame) => entry.id).sort(),
    [fromDesk, fromPhone].sort(),
  );
});

test("Claude Code: a removed thread whose session Claude Code has deleted since is no longer offered", async (t) => {
  const { provider, files, queries } = claude();
  const bridge = await bridgeWith(new Map([["claude", provider]]));
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const thread = (await client.call("session.create", { profile: "claude", title: "From the phone" })).session_id;
  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: thread, text: "Write the notes." });
  await until(() => sessionQueries(queries).length === 1);
  void play(sessionQueries(queries)[0], "plain");
  await client.from(start, (frame) => isEvent(frame, "message.complete", thread));
  files.started.push({ sessionId: thread, cwd: at("projects"), lastModified: now, summary: "Write the notes" });
  await client.call("thread.delete", { thread });
  assert.deepEqual((await client.call("desk.list", { profile: "claude" })).sessions.map((entry: Frame) => entry.id), [thread]);

  // Claude Code's cleanup deletes it: taking it up could only fail.
  files.started.length = 0;
  assert.deepEqual((await client.call("desk.list", { profile: "claude" })).sessions, []);
  await assert.rejects(client.call("session.adopt", { profile: "claude", session_id: thread, mode: "continue" }), (error: RpcFailure) => error.code === -32602);
  // Still among the removed threads every device is told of.
  assert.deepEqual((await client.call("threads.changes", {})).removed, [thread]);
});

test("a removed thread another device takes up while desk.list asks whether its agent still keeps it is not offered", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "portals-desk-race-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const registry = new Registry(join(home, "threads.json"));
  const record: ThreadRecord = { id: "taken-up", agent: "claude", cwd: at("projects/app"), title: "Fix the login", model: "default", provider: "anthropic", reasoningEffort: "", createdAt: 1, updatedAt: 2, origin: "phone", preview: "Fix it" };
  registry.add(structuredClone(record));
  registry.remove(record.id);
  let answer: ((kept: boolean) => void) | undefined;
  const provider = {
    profile: { name: "claude", displayName: "Claude Code", description: "", model: "default", provider: "anthropic" },
    keeps: () => new Promise<boolean>((resolve) => (answer = resolve)),
  } as unknown as Provider;
  const desk = new DeskSessions({ registry, general: () => at("projects"), hide: [], own: [], temporary: [at("scratch")] });
  const listing = desk.list(provider);
  await until(() => answer !== undefined);
  registry.add(structuredClone(record));
  answer!(true);
  assert.deepEqual(await listing, []);
});

test("an agent with no sessions from the desk lists none and takes none up", async (t) => {
  const bridge = await startTestBridge();
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  assert.deepEqual(await client.call("desk.list", { profile: "fake" }), { sessions: [] });
  await assert.rejects(client.call("session.adopt", { profile: "fake", session_id: "x", mode: "continue" }), (error: RpcFailure) => error.code === -32602);
  assert.deepEqual(client.readyPayload.bridge.features, ["turn_file_undo", "message_fork", "mcp_auth", "folders", "model_levels", "push_host", "desk_sessions", "model_names", "compaction", "rename", "activity", "model_default_levels", "question_details", "modes", "push_relay", "push_sealed", "push_muting", "folders_add", "machine", "fleet", "fleet_delta", "fleet_delta_positions", "fleet_pages", "thread_sync", "agent_kinds", "queue", "files", "agent_looks", "sidebar_order", "machine_order", "approval_notes", "thread_branch", "subagents", "turn_messages", "subagents_clear", "subagent_names", "subagent_calls", "status_headline", "poll_now", "resume_replay", "agent_threads", "recent_threads", "held_elsewhere", "turn_usage", "session_leave", "worktrees", "turn_diff", "file_read", "session_resync", "message_reconciliation", "push_watcher", "message_ids", "senders", "async_questions", "background_commands", "net", "net_rename", "net_rename_devices", "lean_deltas", "thread_search", "file_search", "file_mentions", "folder_search", "answer_owner", "bot_chat", "history_pages", "tell_starters", "update_notice", "model_levels_none", "git_status", "usage_read", "open_on_host", "steer_withdrawn"]);
});

// MARK: Codex

test("Codex: the desk's threads by recency, with their state; sub-agents, empty threads and the bridge's own left out", async (t) => {
  const bridge = await bridgeWith(new Map([["codex", codexProvider()]]));
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const app = at("projects/app");
  const closed = daemon.addThread(app, [], { preview: "Tidy the README\nand more", updatedAt: 1_900_000_100 });
  const idle = daemon.addThread(app, [], { loaded: true, name: "Named at the desk", preview: "First message", updatedAt: 1_900_000_200 });
  const waiting = daemon.addThread(app, [], { status: { type: "active", activeFlags: ["waitingOnApproval"] }, preview: "Create a file", updatedAt: 1_900_000_300 });
  const asking = daemon.addThread(app, [], { status: { type: "active", activeFlags: ["waitingOnUserInput"] }, preview: "Ask me", updatedAt: 1_900_000_250 });
  const running = daemon.addThread(app, [], { status: { type: "active", activeFlags: [] }, preview: "Count to ten", updatedAt: 1_900_000_400 });
  daemon.addThread(app, [], { preview: "A helper's work", parentThreadId: running, updatedAt: 1_900_000_500 });
  daemon.addThread(app, [], { preview: "Review", source: { subAgent: "review" }, updatedAt: 1_900_000_500 });
  daemon.addThread(app, [], { preview: "", updatedAt: 1_900_000_600 });
  daemon.addThread(at("scratch/run"), [], { preview: "In a scratch folder", updatedAt: 1_900_000_700 });
  const own = (await client.call("session.create", { profile: "codex" })).session_id;
  daemon.thread(own).preview = "From the phone";
  daemon.thread(own).updatedAt = 1_900_000_800;

  const from = daemon.calls.length;
  const listed = await client.call("desk.list", { profile: "codex" });
  assert.deepEqual(listed.sessions, [
    { id: running, title: "Count to ten", folder: app, updated: 1_900_000_400, state: "running" },
    { id: waiting, title: "Create a file", folder: app, updated: 1_900_000_300, state: "waiting" },
    { id: asking, title: "Ask me", folder: app, updated: 1_900_000_250, state: "waiting" },
    { id: idle, title: "Named at the desk", folder: app, updated: 1_900_000_200, state: "idle" },
    { id: closed, title: "Tidy the README", folder: app, updated: 1_900_000_100, state: "closed" },
  ]);
  // From Codex's index, and kept for a moment.
  const calls = daemon.calls.slice(from).filter((call) => call.method === "thread/list");
  assert.ok(calls.length > 0);
  assert.equal(calls[0].params.useStateDbOnly, true);
  assert.equal(calls[0].params.sortKey, "updated_at");
  await client.call("desk.list", { profile: "codex", limit: 1 });
  assert.equal(daemon.calls.slice(from).filter((call) => call.method === "thread/list").length, calls.length);
  daemon.threads.clear();
});

test("Codex: continuing a thread a terminal has waiting on an approval joins it; the card answers it and the turn finishes", async (t) => {
  const bridge = await bridgeWith(new Map([["codex", codexProvider()]]));
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const app = at("projects/app");
  const user = { type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "Create s1c.txt.", text_elements: [] }] };
  const turn = { id: "turn-desk", items: [user], itemsView: "full", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
  const thread = daemon.addThread(app, [turn], { loaded: true, status: { type: "active", activeFlags: ["waitingOnApproval"] }, preview: "Create s1c.txt.", updatedAt: 1_900_001_000 });
  // The terminal's approval, open before the bridge joins.
  const approval = daemon.request(thread, "item/commandExecution/requestApproval", {
    threadId: thread,
    turnId: "turn-desk",
    itemId: "c1",
    command: "/bin/zsh -lc 'printf hi > s1c.txt'",
    availableDecisions: ["accept", "decline"],
  });
  assert.deepEqual((await client.call("desk.list", { profile: "codex" })).sessions.map((entry: Frame) => [entry.id, entry.state]), [[thread, "waiting"]]);

  const adopted = await client.call("session.adopt", { profile: "codex", session_id: thread, mode: "continue" });
  assert.equal(adopted.session_id, thread);
  assert.equal(adopted.info.cwd, app);
  assert.equal(adopted.info.title, "Create s1c.txt.");
  assert.equal(adopted.info.running, true);
  assert.ok(daemon.callsOf("thread/resume").some((call) => call.params.threadId === thread));

  // The card is there to answer, however the app comes to see it.
  let resumed: Frame;
  const deadline = Date.now() + 3000;
  do {
    resumed = await client.call("session.resume", { session_id: thread, profile: "codex" });
  } while (resumed.open_requests.length === 0 && Date.now() < deadline);
  assert.equal(resumed.running, true);
  assert.deepEqual(resumed.inflight, { user: "Create s1c.txt.", assistant: "" });
  const [card] = resumed.open_requests;
  assert.equal(card.method, "approval");
  assert.equal(card.params.command, "printf hi > s1c.txt");
  const start = client.frames.length;
  client.answer(card.id, { choice: "once" });
  const answer = await approval;
  assert.deepEqual(answer.result, { decision: "accept" });
  assert.notEqual(answer.from, "terminal");
  daemon.finishTurn(thread, "turn-desk", "Created it.");
  const done = await client.from(start, (frame) => isEvent(frame, "message.complete", thread));
  assert.equal(done.params.payload.status, "complete");
  assert.equal(done.params.payload.text, "Created it.");
  const [record] = JSON.parse(readFileSync(join(bridge.home, "state", "threads.json"), "utf8")).threads.filter((entry: Frame) => entry.id === thread);
  assert.equal(record.origin, "desk");
  daemon.threads.clear();
});

test("Claude: adoption rejects case-fold aliases without losing Ask or rejecting exact uppercase ids", async (t) => {
  const native = at("claude-native-identity");
  const cwd = at("projects/app");
  const project = join(native, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = native;
  let bridge: Awaited<ReturnType<typeof bridgeWith>> | undefined;
  let client: TestClient | undefined;
  t.after(async () => {
    try { await client?.close(); await bridge?.dispose(); }
    finally {
      if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prior;
      rmSync(native, { recursive: true, force: true });
    }
  });
  const made = claude();
  made.files.info = sdkSessionFiles.info;
  made.files.exists = async (id) => made.files.stored.has(id) || existsSync(join(project, `${id}.jsonl`));
  const stored = (id: string) => {
    const first = randomUUID();
    const timestamp = new Date(now).toISOString();
    writeFileSync(join(project, `${id}.jsonl`), [
      { type: "user", uuid: first, parentUuid: null, sessionId: id, cwd, isSidechain: false, userType: "external", timestamp, version: "2.1.293", message: { role: "user", content: "Mode source" } },
      { type: "assistant", uuid: randomUUID(), parentUuid: first, sessionId: id, cwd, timestamp, message: { role: "assistant", content: [{ type: "text", text: "OK" }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    made.files.sessions.push({ sessionId: id, cwd, lastModified: now, summary: "Mode source" });
    made.files.stored.set(id, { title: "Mode source", messages: inFolder(claudeHistory("plain"), cwd) });
  };
  const id = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  const uppercase = "FEDCBAFE-DCBA-4ABC-8DEF-FEDCBAFEDCBA";
  stored(id);
  stored(uppercase);
  assert.equal((await sdkSessionFiles.info(id))?.sessionId, id);
  const alias = id.toUpperCase();
  if (existsSync(join(project, `${alias}.jsonl`))) assert.equal((await getSessionInfo(alias))?.sessionId, alias, "the raw SDK echoes a case-fold alias");
  bridge = await bridgeWith(new Map([["claude", made.provider]]));
  client = await TestClient.open(bridge);
  await client.call("session.adopt", { profile: "claude", session_id: id, mode: "continue" });
  await client.call("session.set_mode", { session_id: id, mode: "ask" });
  assert.equal((await client.call("session.adopt", { profile: "claude", session_id: uppercase, mode: "read" })).session_id, uppercase);
  const records = () => JSON.parse(readFileSync(pathsFor(bridge!.home).threads, "utf8")).threads.map((row: ThreadRecord) => ({ id: row.id, mode: row.mode }));
  const before = records();
  const queries = made.queries.length;
  for (const raw of [alias, id.replace("abcdefab", "ABCDefab"), `./${id}`, `${id}/`]) for (const mode of ["continue", "read", "fork"]) {
    await assert.rejects(client.call("session.adopt", { profile: "claude", session_id: raw, mode }).then((result) => {
      t.diagnostic(`unexpected alias adoption: mode=${result.info.mode}`);
      return result;
    }), (error: RpcFailure) => error.code === -32602);
  }
  assert.deepEqual(records(), before);
  assert.equal(made.files.forks.length, 0);
  assert.equal(made.queries.length, queries);
});

test("Codex: adoption rejects normalized UUID aliases before a fork can lose Ask", async (t) => {
  const original = daemon.thread.bind(daemon);
  // ThreadId::from_string accepts either UUID spelling; responses serialize the canonical id.
  t.mock.method(daemon, "thread", (raw: string) => {
    if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(raw)) return original(raw);
    const hex = raw.replaceAll("-", "").toLowerCase();
    return original(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
  });
  const bridge = await bridgeWith(new Map([["codex", codexProvider()]]));
  const client = await TestClient.open(bridge);
  t.after(async () => { await client.close(); await bridge.dispose(); daemon.threads.clear(); });
  const id = daemon.addThread(at("projects/app"), rewrite(codexHistory("tools").turns, [[fixtureCwd, at("projects/app")]]), { preview: "Mode source" });
  await client.call("session.adopt", { profile: "codex", session_id: id, mode: "continue" });
  await client.call("session.set_mode", { session_id: id, mode: "ask" });
  const forked = await client.call("session.adopt", { profile: "codex", session_id: id, mode: "fork" });
  assert.equal(forked.info.mode, "ask");
  const records = () => JSON.parse(readFileSync(pathsFor(bridge.home).threads, "utf8")).threads.map((row: ThreadRecord) => ({ id: row.id, mode: row.mode }));
  const before = records();
  const forks = daemon.callsOf("thread/fork").length;
  const aliases = new Set([id.replaceAll("-", ""), id.toUpperCase(), id.replace(/[a-f]/, (letter) => letter.toUpperCase())]);
  aliases.delete(id);
  for (const raw of [...aliases, `./${id}`, `${id}/`]) for (const mode of ["fork", "read", "continue"]) {
    await assert.rejects(client.call("session.adopt", { profile: "codex", session_id: raw, mode }).then((result) => {
      t.diagnostic(`unexpected alias adoption: mode=${result.info.mode}`);
      return result;
    }), (error: RpcFailure) => error.code === -32602);
  }
  assert.deepEqual(records(), before);
  assert.equal(daemon.callsOf("thread/fork").length, forks);
});

for (const agent of ["claude", "codex"] as const) test(`${agent}: Fork thread keeps Ask, pre-plan and default-reset policy without changing its source`, async (t) => {
  const made = claude();
  const bridge = await bridgeWith(new Map([[agent, agent === "claude" ? made.provider : codexProvider()]]));
  const client = await TestClient.open(bridge);
  t.after(async () => { await client.close(); await bridge.dispose(); });
  let id: string;
  if (agent === "claude") {
    id = "6d3c8a9e-0000-4000-8000-000000000003";
    made.files.sessions.push({ sessionId: id, cwd: at("projects/app"), lastModified: now, summary: "Mode source" });
    made.files.stored.set(id, { title: "Mode source", messages: inFolder(claudeHistory("plain"), at("projects/app")) });
  } else {
    id = daemon.addThread(at("projects/app"), rewrite(codexHistory("tools").turns, [[fixtureCwd, at("projects/app")]]), { preview: "Mode source" });
  }
  await client.call("session.adopt", { profile: agent, session_id: id, mode: "continue" });
  await client.call("config.set", { session_id: id, key: "model", value: `${agent === "claude" ? "sonnet" : "gpt-6-luna"} --session` });
  await client.call("config.set", { session_id: id, key: "reasoning", value: "low" });
  const record = (id: string): ThreadRecord => JSON.parse(readFileSync(pathsFor(bridge.home).threads, "utf8")).threads.find((row: ThreadRecord) => row.id === id);
  for (const mode of ["ask", "plan", "default"]) {
    await client.call("session.set_mode", { session_id: id, mode });
    const source = record(id);
    const sourceInfo = (await client.call("session.resume", { session_id: id })).info;
    const fork = await client.call("session.adopt", { profile: agent, session_id: id, mode: "fork" });
    assert.equal(fork.info.mode, sourceInfo.mode);
    assert.deepEqual([fork.info.model, fork.info.provider, fork.info.reasoning_effort],
      [sourceInfo.model, sourceInfo.provider, sourceInfo.reasoning_effort]);
    const copied = record(fork.session_id);
    for (const key of ["mode", "modeBeforePlan", "modeReset"] as const) assert.equal(copied[key], source[key], key);
    assert.deepEqual(record(id), source);
    if (mode === "ask") {
      const start = client.frames.length;
      const from = daemon.calls.length;
      await client.call("prompt.submit", { session_id: fork.session_id, text: "Check the mode" });
      if (agent === "claude") {
        await until(() => sessionQueries(made.queries).length > 0);
        const query = sessionQueries(made.queries).at(-1)!;
        assert.equal(query.options.permissionMode, "default", "Claude asks instead of bypassing permissions");
        assert.equal(query.options.model, sourceInfo.model);
        void play(query, "plain");
      } else {
        const turn = await daemon.waitForCall((call) => call.method === "turn/start" && call.params.threadId === fork.session_id, from);
        assert.equal(turn.params.approvalPolicy, "untrusted");
        assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
        assert.equal(turn.params.model, sourceInfo.model);
        assert.equal(turn.params.effort, sourceInfo.reasoning_effort);
        daemon.finishTurn(fork.session_id, await daemon.activeTurn(fork.session_id), "Checked.");
      }
      await client.from(start, (frame) => isEvent(frame, "message.complete", fork.session_id));
    }
  }
});

test("Codex: a fork is a new thread with the history so far; a thread only read is never joined and takes no message", async (t) => {
  const bridge = await bridgeWith(new Map([["codex", codexProvider()]]));
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const app = at("projects/notes");
  const turns = rewrite(codexHistory("tools").turns, [
    [recordedThread("tools"), "x"],
    [fixtureCwd, app],
  ]);
  const thread = daemon.addThread(app, turns, { preview: "In hello.txt, change hi to hello.", updatedAt: 1_900_002_000 });

  const forked = await client.call("session.adopt", { profile: "codex", session_id: thread, mode: "fork" });
  assert.notEqual(forked.session_id, thread);
  assert.equal(forked.info.title, "In hello.txt, change hi to hello. (fork)");
  assert.deepEqual(daemon.callsOf("thread/fork").at(-1)!.params, { threadId: thread, excludeTurns: true });
  const resumed = await client.call("session.resume", { session_id: forked.session_id });
  assert.deepEqual(
    resumed.messages.map((message: Frame) => (message.role === "tool" ? message.name : message.role)),
    ["user", "assistant", "terminal", "patch", "terminal", "assistant"],
  );

  const from = daemon.calls.length;
  const read = await client.call("session.adopt", { profile: "codex", session_id: thread, mode: "read" });
  assert.equal(read.session_id, thread);
  assert.equal((await client.call("session.resume", { session_id: thread })).messages.length, 6);
  await assert.rejects(client.call("prompt.submit", { session_id: thread, text: "Again." }), (error: RpcFailure) => error.message === readOnlyText);
  assert.equal(daemon.calls.slice(from).some((call) => call.method === "thread/resume" || call.method === "turn/start"), false);

  // A thread with nothing in it cannot be taken up.
  const empty = daemon.addThread(app, [], { loaded: true, updatedAt: 1_900_002_100 });
  await assert.rejects(client.call("session.adopt", { profile: "codex", session_id: empty, mode: "continue" }), (error: RpcFailure) => error.code === -32602 && /no messages yet/.test(error.message));
  daemon.threads.clear();
});

test("Codex: a fork taken off the list is offered again once, and taken up again as the same thread", async (t) => {
  const bridge = await bridgeWith(new Map([["codex", codexProvider()]]));
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const app = at("projects/notes");
  const turns = rewrite(codexHistory("tools").turns, [
    [recordedThread("tools"), "x"],
    [fixtureCwd, app],
  ]);
  const thread = daemon.addThread(app, turns, { preview: "In hello.txt, change hi to hello.", updatedAt: 1_900_003_000 });
  const fork = (await client.call("session.adopt", { profile: "codex", session_id: thread, mode: "fork" })).session_id;
  assert.notEqual(fork, thread);
  assert.deepEqual((await client.call("desk.list", { profile: "codex" })).sessions.map((entry: Frame) => entry.id), [thread]);

  await client.call("thread.delete", { thread: fork });
  // Codex lists the fork itself; it is offered once, with the title it had here.
  const offered = (await client.call("desk.list", { profile: "codex" })).sessions;
  assert.deepEqual(
    offered.map((entry: Frame) => [entry.id, entry.title]).sort(),
    [
      [thread, "In hello.txt, change hi to hello."],
      [fork, "In hello.txt, change hi to hello. (fork)"],
    ].sort(),
  );
  const adopted = await client.call("session.adopt", { profile: "codex", session_id: fork, mode: "continue" });
  assert.equal(adopted.session_id, fork);
  assert.equal(adopted.info.title, "In hello.txt, change hi to hello. (fork)");
  assert.deepEqual(JSON.parse(readFileSync(join(bridge.home, "state", "removed.json"), "utf8")).threads, []);
  assert.deepEqual((await client.call("desk.list", { profile: "codex" })).sessions.map((entry: Frame) => entry.id), [thread]);
  const resumed = await client.call("session.resume", { session_id: fork });
  assert.deepEqual(
    resumed.messages.map((message: Frame) => (message.role === "tool" ? message.name : message.role)),
    ["user", "assistant", "terminal", "patch", "terminal", "assistant"],
  );
  daemon.threads.clear();
});
