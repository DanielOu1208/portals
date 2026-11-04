import "./environment.ts";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ClaudeCheckpoints } from "../src/providers/claude/checkpoints.ts";
import { historyFromSession } from "../src/providers/claude/history.ts";
import { CodexSession } from "../src/providers/codex/session.ts";
import { CodexProvider } from "../src/providers/codex/provider.ts";
import { historyFromThread } from "../src/providers/codex/history.ts";
import type { Thread } from "../src/providers/codex/types/index.ts";
import type { ProviderEvent } from "../src/providers/types.ts";
import { fakeClaude, FakeFiles } from "./claude-fixtures.ts";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "provider-fork-cwd-")));
after(() => rmSync(cwd, { recursive: true, force: true }));
const user = (uuid: string, text = "duplicate") => ({ type: "user", uuid, parent_tool_use_id: null, message: { role: "user", content: text } });
const assistant = (uuid: string, stop_reason = "end_turn") => ({ type: "assistant", uuid, parent_tool_use_id: null, message: { role: "assistant", stop_reason, content: [{ type: "text", text: "reply" }] } });
const toolAnswer = (uuid: string) => ({ type: "user", uuid, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "done" }] } });

class BoundaryFiles extends FakeFiles {
  readonly cuts: string[] = [];
  override async fork(id: string, folder: string, upToMessageId?: string): Promise<string> {
    assert.ok(upToMessageId);
    this.cuts.push(upToMessageId);
    const messages = this.stored.get(id)!.messages as { uuid: string }[];
    const end = messages.findIndex((entry) => entry.uuid === upToMessageId);
    assert.ok(end >= 0);
    const fork = `fork-${this.cuts.length}`;
    this.started.push({ ...this.started.find((entry) => entry.sessionId === id)!, sessionId: fork, cwd: folder });
    this.stored.set(fork, { title: "fork", messages: structuredClone(messages.slice(0, end + 1)).map((entry) => ({ ...entry, uuid: `copy-${fork}-${entry.uuid}` })) });
    return fork;
  }
}

function seededClaude(checkpointPath?: string) {
  const files = new BoundaryFiles();
  files.started.push({ sessionId: "source", summary: "source", cwd, lastModified: 1 });
  files.stored.set("source", { title: "source", messages: [user("first"), assistant("first-reply"), user("steer"), assistant("steer-reply"), toolAnswer("tail"), user("second"), assistant("second-reply"), user("desk"), assistant("desk-reply")] });
  const fake = fakeClaude({ files, checkpointPath });
  // Metadata exactly mirrors accepted bridge sends, including a steer that Claude
  // persisted after an end_turn assistant (indistinguishable in cold history).
  fake.provider.checkpoints.sent("source", "first", false);
  fake.provider.checkpoints.sent("source", "steer", true);
  fake.provider.checkpoints.observed("source", toolAnswer("tail"));
  fake.provider.checkpoints.finish("source");
  fake.provider.checkpoints.sent("source", "second", false);
  fake.provider.checkpoints.observed("source", assistant("second-reply"));
  fake.provider.checkpoints.finish("source");
  return { ...fake, files };
}

test("Claude checkpoints survive restart, distinguish duplicate openers from steers, and include tool-result tails", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "provider-checkpoints-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "checkpoints.json");
  const { provider, files } = seededClaude(path);
  t.after(() => provider.close());
  const recreated = fakeClaude({ files, checkpointPath: path }).provider;
  t.after(() => recreated.close());
  const loaded = await recreated.resumeSession({ id: "source", cwd, settings: { model: "sonnet", provider: "anthropic", reasoningEffort: "high" } }, { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "interrupted" }) });
  const rows = (await loaded.history()).filter((row) => row.role === "user");
  assert.deepEqual(rows.map((row) => row.checkpoint?.id), ["first", undefined, "second", undefined]);
  const first = await recreated.forkAt("source", "first", false, cwd);
  assert.equal(files.cuts.at(-1), "tail");
  assert.equal(first.cwd, cwd);
  assert.equal(first.settings.model, "sonnet");
  assert.equal(first.settings.reasoningEffort, "high");
  // Forked native IDs are new. The next fork uses the remapped ID and the same tail.
  const loadedFork = await recreated.resumeSession({ id: first.id, cwd, settings: first.settings }, { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "interrupted" }) });
  assert.equal(loadedFork.lastTurnCutOff?.(), false);
  const forkRows = historyFromSession(await files.messages(first.id), cwd, recreated.checkpoints.forSession(first.id, await files.messages(first.id)));
  const copiedRow = forkRows.find((row) => row.role === "user" && row.checkpoint);
  const copiedOpener = copiedRow?.role === "user" ? copiedRow.checkpoint?.id : undefined;
  assert.equal(copiedOpener, `copy-${first.id}-first`);
  await recreated.forkAt(first.id, copiedOpener!, false, cwd);
  assert.equal(files.cuts.at(-1), `copy-${first.id}-tail`);
});

test("Claude edit before first is empty; before later and after last use exact UUIDs and reject unsafe IDs before mutation", async (t) => {
  const { provider, files } = seededClaude();
  t.after(() => provider.close());
  const first = await provider.forkAt("source", "first", true, cwd);
  assert.notEqual(first.id, "source");
  assert.deepEqual(await files.messages(first.id), []);
  assert.deepEqual(files.cuts, []);
  await provider.forkAt("source", "second", true, cwd);
  assert.equal(files.cuts.at(-1), "tail");
  await provider.forkAt("source", "second", false, cwd);
  assert.equal(files.cuts.at(-1), "second-reply");
  const count = files.cuts.length;
  for (const id of ["missing", "steer", "desk", "tail"]) await assert.rejects(provider.forkAt("source", id, false, cwd), /safe message boundary/);
  files.stored.get("source")!.messages.push(user("running"));
  await assert.rejects(provider.forkAt("source", "first", true, cwd), /not finished/);
  assert.equal(files.cuts.length, count);
});

test("untracked Claude history offers only a provable first-input edit and excludes commands and native answers", () => {
  const messages = [user("first"), assistant("reply"), user("ambiguous"), assistant("other"), toolAnswer("answer")];
  assert.deepEqual(historyFromSession(messages, cwd).filter((row) => row.role === "user").map((row) => row.checkpoint), [{ id: "first", can_fork: false, can_edit: true }, undefined]);
  assert.equal(historyFromSession([user("command", "/compact")], cwd).some((row) => row.role === "user" && row.checkpoint), false);
  const checkpoints = new ClaudeCheckpoints();
  checkpoints.sent("source", "first", false);
  checkpoints.sent("source", "absent-steer", true);
  checkpoints.finish("source");
  assert.equal(checkpoints.boundary("source", "first", messages), undefined);
});

const codexTurn = (id: string, status = "completed", texts = ["duplicate"]) => ({ id, status, itemsView: "full", items: texts.map((text, i) => ({ type: "userMessage", id: `${id}-${i}`, content: [{ type: "text", text }] })) });

async function codex(thread: Record<string, any>, version = "0.166.0", wrongPrefix = false) {
  const calls: { method: string; params: any }[] = [];
  let forkTurns: unknown[] = [];
  const provider = new CodexProvider({ settings: { mode: "own", path: "/nonexistent/codex", socket: null, imagesDir: cwd }, connect: async (handlers) => ({
    send(message) {
      if (!message.method || message.method === "initialized") return;
      const method = message.method;
      const params = message.params as any;
      calls.push({ method, params });
      let result: unknown;
      if (method === "initialize") result = { userAgent: `codex_cli_rs/${version} (test)` };
      else if (method === "thread/read") result = { thread: params.threadId === "fork" ? { ...thread, id: "fork", turns: wrongPrefix ? thread.turns : forkTurns } : thread };
      else {
        assert.equal(method, "thread/fork");
        const index = thread.turns.findIndex((turn: any) => turn.id === (params.beforeTurnId ?? params.lastTurnId));
        forkTurns = thread.turns.slice(0, index + (params.beforeTurnId ? 0 : 1));
        result = { thread: { id: "fork" }, cwd, model: "kept-model", reasoningEffort: "high" };
      }
      queueMicrotask(() => handlers.message({ id: message.id, result }));
    },
    close() {},
  }), checkVersion: false });
  provider.models = async () => ({ providers: [], model: "fallback", provider: "openai", reasoning: "low" });
  await provider.client.start();
  return { provider, calls };
}

test("Codex checkpoints mark only completed native user openers, excluding steers and synthetic compactions", () => {
  const thread = { turns: [codexTurn("first", "completed", ["duplicate", "duplicate"]), codexTurn("last"), codexTurn("running", "inProgress"), { id: "compact", status: "completed", items: [{ type: "contextCompaction" }] }] } as unknown as Thread;
  const rows = historyFromThread(thread, cwd, false).messages.filter((row) => row.role === "user");
  assert.deepEqual(rows.map((row) => row.checkpoint?.id), ["first", undefined, "last", undefined, undefined]);
});

test("Codex forks before first, after last, and duplicate-text middle by native turn ID, preserving settings", async (t) => {
  const thread = { id: "source", cwd, preview: "duplicate", status: { type: "idle" }, turns: [codexTurn("first"), codexTurn("last")] };
  const { provider, calls } = await codex(thread);
  t.after(() => provider.close());
  const first = await provider.forkAt("source", "first", true, cwd);
  assert.deepEqual(calls.findLast((call) => call.method === "thread/fork")?.params, { threadId: "source", beforeTurnId: "first", excludeTurns: true, deferGoalContinuation: true });
  assert.equal(first.cwd, cwd);
  assert.deepEqual(first.settings, { model: "kept-model", provider: "openai", reasoningEffort: "high" });
  await provider.forkAt("source", "last", false, cwd);
  assert.equal(calls.findLast((call) => call.method === "thread/fork")?.params.lastTurnId, "last");
  const forks = () => calls.filter((call) => call.method === "thread/fork").length;
  const count = forks();
  await assert.rejects(provider.forkAt("source", "missing", true, cwd), /no user turn/);
  thread.turns[1].status = "inProgress";
  await assert.rejects(provider.forkAt("source", "last", false, cwd), /finish/);
  assert.equal(forks(), count);
  await assert.rejects(provider.forkAt("alias", "first", false, cwd), /exact Codex thread/);
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Claude emits the stable opener checkpoint before turn.end; a sidecar write failure still ends the turn", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "provider-checkpoint-errors-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const malformed = join(folder, "malformed.json");
  writeFileSync(malformed, "{broken");
  const recovered = fakeClaude({ checkpointPath: malformed }).provider;
  t.after(() => recovered.close());
  assert.equal(recovered.checkpoints.forSession("source", []).size, 0);
  const blocked = join(folder, "blocked");
  writeFileSync(blocked, "a file cannot contain the sidecar");
  for (const [path, expected] of [[join(folder, "good.json"), true], [join(blocked, "index.json"), false]] as const) {
    const { provider, queries, files } = fakeClaude({ checkpointPath: path });
    t.after(() => provider.close());
    const events: ProviderEvent[] = [];
    const session = await provider.startSession({ id: "live", cwd, settings: { model: "sonnet", provider: "anthropic", reasoningEffort: "high" } }, { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "interrupted" }) });
    session.startTurn({ text: "duplicate", images: [] });
    await until(() => queries.some((query) => query.received.length === 1));
    const query = queries.find((query) => query.received.length === 1)!;
    const opener = query.received[0].uuid;
    files.stored.set("live", { title: "live", messages: [user(opener!), assistant("live-reply")] });
    query.emit({ ...assistant("live-reply"), session_id: "live" });
    query.emit({ type: "result", subtype: "success", is_error: false, user_message_uuids: [opener], usage: {}, session_id: "live" });
    await until(() => events.some((event) => event.type === "turn.end"));
    const checkpoint = events.findIndex((event) => event.type === "checkpoint");
    assert.equal(checkpoint >= 0, expected);
    if (expected) {
      assert.equal(events[checkpoint].type === "checkpoint" && events[checkpoint].checkpoint.id, opener);
      assert.ok(checkpoint < events.findIndex((event) => event.type === "turn.end"));
      const resumed = await provider.resumeSession({ id: "live", cwd, settings: session.settings() }, { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "interrupted" }) });
      const restored = (await resumed.history()).find((row) => row.role === "user");
      assert.equal(restored?.role === "user" && restored.checkpoint?.id, opener);
    } else {
      assert.equal(provider.checkpoints.forSession("live", [user(opener!), assistant("live-reply")]).size, 0);
    }
  }
});

function liveCodex(plan: boolean, ask: () => Promise<any>) {
  const events: ProviderEvent[] = [];
  let starts = 0;
  const host = {
    client: { supportsMessageForks: true, async call(method: string) {
      assert.equal(method, "turn/start");
      return { turn: { id: `turn-${++starts}` } };
    } },
    defaults: () => null,
    async defaultsFor() { throw new Error("No folder defaults"); },
    efforts: () => [],
    forget() {},
    nameThread() {},
  };
  const session = new CodexSession({ id: "live", cwd, title: "live", mode: plan ? "plan" : "default", settings: { model: "model", provider: "openai", reasoningEffort: "high" } }, { emit: (event) => events.push(event), ask }, host as never, { applied: null, subscribed: true });
  session.attached();
  return { session, events, starts: () => starts };
}

test("Codex emits one checkpoint before turn.end for its native opener, never for a composite plan continuation", async (t) => {
  for (const planning of [false, true]) {
    let approve: ((answer: any) => void) | undefined;
    const { session, events, starts } = liveCodex(planning, () => new Promise((resolve) => { approve = resolve; }));
    t.after(() => session.close());
    session.startTurn({ text: "prompt", images: [] });
    await until(() => starts() === 1);
    await new Promise((resolve) => setImmediate(resolve));
    session.notification("item/started", { threadId: "live", turnId: "turn-1", item: codexTurn("turn-1").items[0] });
    if (planning) session.notification("item/completed", { threadId: "live", turnId: "turn-1", item: { id: "plan", type: "plan", text: "Do the work" } });
    session.notification("turn/completed", { threadId: "live", turn: { id: "turn-1", status: "completed", items: [] } });
    if (planning) {
      assert.ok(approve);
      assert.equal(events.some((event) => event.type === "checkpoint"), false);
      approve!({ kind: "approval", choice: "allow" });
      await until(() => starts() === 2);
      await new Promise((resolve) => setImmediate(resolve));
      session.notification("item/started", { threadId: "live", turnId: "turn-2", item: codexTurn("turn-2").items[0] });
      session.notification("turn/completed", { threadId: "live", turn: { id: "turn-2", status: "completed", items: [] } });
      assert.equal(events.some((event) => event.type === "checkpoint"), false);
    } else {
      const checkpoint = events.findIndex((event) => event.type === "checkpoint");
      assert.ok(checkpoint >= 0);
      assert.equal(events[checkpoint].type === "checkpoint" && events[checkpoint].checkpoint.id, "turn-1");
      assert.ok(checkpoint < events.findIndex((event) => event.type === "turn.end"));
    }
    assert.ok(events.some((event) => event.type === "turn.end"));
  }
});

test("Codex refuses an old or unknown live server before a native fork and refuses a server that returns the full history", async (t) => {
  const thread = { id: "source", cwd, preview: "prompt", status: { type: "idle" }, turns: [codexTurn("first"), codexTurn("last")] };
  for (const version of ["0.162.1", "unknown", "0.166.0-preview"]) {
    const { provider, calls } = await codex(thread, version);
    t.after(() => provider.close());
    assert.equal(provider.client.supportsMessageForks, false);
    await assert.rejects(provider.forkAt("source", "first", true, cwd), /0.166.0 or newer/);
    assert.equal(calls.some((call) => call.method === "thread/fork"), false);
  }
  const { provider } = await codex(thread, "0.166.0", true);
  t.after(() => provider.close());
  await assert.rejects(provider.forkAt("source", "first", true, cwd), /exact requested turn prefix/);
});

test("both providers refuse native cwd drift before a fork, including a fresh empty Claude branch", async (t) => {
  const { provider: claude, files } = seededClaude();
  const { provider: codexProvider, calls } = await codex({ id: "source", cwd, preview: "prompt", status: { type: "idle" }, turns: [codexTurn("first")] });
  t.after(() => claude.close());
  t.after(() => codexProvider.close());
  const changed = realpathSync(mkdtempSync(join(tmpdir(), "provider-fork-drift-")));
  t.after(() => rmSync(changed, { recursive: true, force: true }));
  for (const expected of [changed, join(changed, "missing")]) {
    await assert.rejects(claude.forkAt("source", "first", true, expected), /folder no longer matches/);
    await assert.rejects(codexProvider.forkAt("source", "first", true, expected), /folder no longer matches/);
  }
  assert.equal(files.cuts.length, 0);
  assert.equal(calls.some((call) => call.method === "thread/fork"), false);
});

test("Codex offers no checkpoint for a review, though its stream has the prompt Codex gives its reviewer", async (t) => {
  const events: ProviderEvent[] = [];
  let started = 0;
  const host = {
    client: { supportsMessageForks: true, async call(method: string) {
      assert.equal(method, "review/start");
      started += 1;
      return { turn: { id: "review-1" } };
    } },
    defaults: () => null,
    async defaultsFor() { throw new Error("No folder defaults"); },
    efforts: () => [],
    forget() {},
    nameThread() {},
  };
  // The thread's last turn ran on the model and level it has, or #19 refuses the review.
  const applied = { model: "model", effort: "high", approvalPolicy: null, sandboxPolicy: null, summary: null };
  const session = new CodexSession({ id: "live", cwd, title: "live", mode: "default", settings: { model: "model", provider: "openai", reasoningEffort: "high" } }, { emit: (event) => events.push(event), ask: async () => ({}) as never }, host as never, { applied, subscribed: true });
  session.attached();
  t.after(() => session.close());
  session.startTurn({ text: "/review", images: [] });
  await until(() => started === 1);
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = { type: "userMessage", id: "prompt", clientId: null, content: [{ type: "text", text: "Review the current code changes and provide prioritized findings.", text_elements: [] }] };
  session.notification("item/started", { threadId: "live", turnId: "review-1", item: { type: "enteredReviewMode", id: "entered", review: "current changes" } });
  session.notification("turn/started", { threadId: "live", turn: { id: "reviewer-1", rootTurnId: "review-1", items: [], status: "inProgress" } });
  session.notification("item/started", { threadId: "live", turnId: "review-1", item: prompt });
  session.notification("item/completed", { threadId: "live", turnId: "review-1", item: prompt });
  session.notification("item/completed", { threadId: "live", turnId: "review-1", item: { type: "exitedReviewMode", id: "exited", review: "No findings." } });
  session.notification("turn/completed", { threadId: "live", turn: { id: "review-1", rootTurnId: "review-1", status: "completed", items: [] } });
  assert.ok(events.some((event) => event.type === "turn.end"));
  assert.equal(events.some((event) => event.type === "checkpoint"), false);
});

test("Claude keeps a turn's checkpoint when a Stop took back a message steered into it, before or after the turn ended", () => {
  for (const after of [false, true]) {
    const checkpoints = new ClaudeCheckpoints();
    checkpoints.sent("s", "open", false);
    checkpoints.sent("s", "steer", true);
    if (!after) checkpoints.withdrawn("s", "steer");
    checkpoints.observed("s", assistant("reply"));
    checkpoints.finish("s");
    if (after) checkpoints.withdrawn("s", "steer");
    // Claude Code never wrote the message it took back.
    assert.deepEqual([...checkpoints.forSession("s", [user("open"), assistant("reply")]).keys()], ["open"]);
  }
});
