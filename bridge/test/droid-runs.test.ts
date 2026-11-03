import "./environment.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DroidSession } from "../src/providers/droid/session.ts";
import type { Registry } from "../src/sessions/registry.ts";
import { Session } from "../src/sessions/session.ts";

// A DroidSession under a Session, with a stand-in for Droid's SDK handle whose raw
// notifications the test sends (`notify`), as in droid-work.test.ts but whole: what
// Droid's wire is known to say of background commands, steering messages and Stop
// and what is
// not known told both ways.

/* eslint-disable @typescript-eslint/no-explicit-any */
const next = () => new Promise((resolve) => setImmediate(resolve));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 200; n++) { if (check()) return; await next(); }
  assert.fail("the stand-in did not reach the expected state");
}
const result = () => ({ type: "result", subtype: "success", success: true, interrupted: false, sessionId: "root", durationMs: 1, tokenUsage: null, messages: [], text: "", turnCount: 1, error: null });

async function rig() {
  let now = 0;
  let script: (text: string) => AsyncGenerator<any> = async function* () { yield result(); };
  let context: () => Promise<{ used: number; limit: number }> = async () => ({ used: 1, limit: 100 });
  const callbacks = new Set<(raw: any) => void>();
  const exits = new Set<(error: Error) => void>();
  const events: any[] = [], starts: string[] = [], handed: string[] = [], deleted: string[] = [];
  const state: any = { version: 1, id: "thread", session: "root", cwd: process.cwd(), defaults: { autonomyLevel: "off", interactionMode: "auto" }, defaultModel: "m", defaultEffort: "low", settings: { model: "m", provider: "droid", reasoningEffort: "low" }, mode: "default", beforePlan: "ask", open: false, messages: [] };
  const core = new Session({ id: "thread", agent: "droid", cwd: process.cwd(), title: "t", ...state.settings, createdAt: 0, updatedAt: 0, origin: "phone" }, { has: () => false } as unknown as Registry);
  const handle: any = {
    id: "root", cwd: process.cwd(), settings: { modelId: "m", reasoningEffort: "low", autonomyLevel: "off", interactionMode: "auto" },
    stream: (text: string) => { starts.push(text); return script(text); },
    updateSettings: async () => ({}), getContextStats: () => context(),
    addUserMessage: async (_params: unknown, id: string) => { handed.push(id); return {}; },
    resolveQueuedUserMessage: async (params: { requestId: string }) => { deleted.push(params.requestId); return {}; },
    onNotification: (cb: (raw: any) => void) => { callbacks.add(cb); return () => callbacks.delete(cb); },
    closed: 0,
    onExit: (listener: (error: Error) => void) => { exits.add(listener); return () => exits.delete(listener); }, connected: () => true, close: async () => { handle.closed++; }, interrupt: async () => {},
  };
  const host: any = {
    sdk: { open: async () => handle }, store: { write: () => {} },
    pool: { warmed() {}, touch() {}, cooled() {} },
    note: null, tellsThread: false, interruptGraceMs: 1000, backgroundHoldMs: 1000, now: () => now,
    model: () => undefined, learn() {}, forget() {}, name: async () => null,
  };
  const droid = new DroidSession({ id: "thread", cwd: process.cwd(), title: "t", settings: state.settings } as any,
    { emit: (event: any) => { events.push(event); core.sink.emit(event); }, ask: async () => ({ kind: "withdrawn", reason: "test" }) } as any, host, state);
  await droid.initialize();
  await core.attach(droid);
  const notify = (notification: Record<string, unknown>, sessionId = "root") => { for (const cb of callbacks) cb({ params: { sessionId, notification } }); };
  const start = async (text: string) => {
    const count = events.filter((event) => event.type === "turn.end").length;
    core.submit(text).begin?.();
    await until(() => events.filter((event) => event.type === "turn.end").length > count);
  };
  // Droid's completion of a background command: a hidden user message that names only the call's id.
  const completion = (output: string, id = "call_0") => notify({ type: "create_message", message: { id: `execute-completion:${id}`, role: "user", visibility: "llm_only",
    content: [{ type: "text", text: `Background Execute command finished.\ntool_use_id: ${id}\nexit_status: code 0\noutput: ${output}` }] } });
  return { core, droid, handle, state, events, starts, handed, deleted, exits, notify, start, completion,
    script: (value: typeof script) => { script = value; }, context: (value: typeof context) => { context = value; }, advance: (value: number) => { now = value; } };
}

const launch = async function* () {
  yield { type: "tool_call", toolUseId: "call_0", name: "Execute", input: { command: "npm test", fireAndForget: true } };
  yield { type: "tool_result", toolUseId: "call_0", toolName: "Execute", content: "Background process started (PID: 12)", isError: false };
  yield result();
};
const output = (r: Awaited<ReturnType<typeof rig>>, id: string) => {
  const row = r.state.messages.find((message: any) => message.tool_call_id === id);
  return row?.content ? JSON.parse(row.content).output : undefined;
};

// recent-15. Droid passes the model's own tool ids through (CLI 0.249.0's converter keeps
// `call_…` ids; Kimi-style models number them `Execute:0`), and a background command's
// completion names only that id (`execute-completion:<id>`). Whether a model reuses an id
// across answers is not recorded: these tell it as if one does.

test("a background command under the id of one whose tracking expired is tracked, and its completion updates its own row (recent-15)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  r.script(launch);
  await r.start("first");
  const oldId = r.state.messages.find((message: any) => message.role === "tool").tool_call_id;
  r.advance(1000);
  assert.equal(r.droid.hasBackgroundWork(), false);
  await r.start("second");
  const newId = r.state.messages.findLast((message: any) => message.role === "tool").tool_call_id;
  assert.notEqual(newId, oldId);
  assert.equal(r.droid.hasBackgroundWork(), true);
  r.completion("NEW OUTPUT");
  assert.equal(r.events.filter((event) => event.type === "tool.end").at(-1).id, newId);
  assert.equal(output(r, newId), "NEW OUTPUT");
  // Droid takes the completion in a turn of its own.
  r.notify({ type: "agent_turn_completed", reason: "completed" });
  assert.equal(r.droid.hasBackgroundWork(), false);
});

test("two background commands at work at once under one id each take a completion, the first launched the first, said to be uncertain, and the process is held until both have (recent-15)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  r.script(launch);
  await r.start("first");
  await r.start("second");
  const ids = r.state.messages.filter((message: any) => message.role === "tool").map((message: any) => message.tool_call_id);
  assert.equal(ids.length, 2);
  r.completion("FIRST OUTPUT");
  r.notify({ type: "agent_turn_completed", reason: "completed" });
  // Droid named only the id both had: its row and the person are told it may be the other's.
  assert.match(output(r, ids[0]), /FIRST OUTPUT$/);
  assert.match(output(r, ids[0]), /cannot tell which one ended/);
  assert.match(r.events.findLast((event) => event.type === "notice").text, /cannot tell which one ended/);
  // The second is still at work: its process is not let go.
  assert.equal(r.droid.hasBackgroundWork(), true);
  await r.droid.cool();
  assert.equal(r.handle.closed, 0);
  r.completion("SECOND OUTPUT");
  r.notify({ type: "agent_turn_completed", reason: "completed" });
  // The only one at work under the id now, but which of the two ended first was never known: still in doubt.
  assert.match(output(r, ids[1]), /may be another's\.\nSECOND OUTPUT$/);
  assert.equal(r.droid.hasBackgroundWork(), false);
});

test("the same words twice under one id while two commands had it end both, the second said to be uncertain; told again once none is at work, they change nothing (recent-15)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  r.script(launch);
  await r.start("first");
  await r.start("second");
  const ids = r.state.messages.filter((message: any) => message.role === "tool").map((message: any) => message.tool_call_id);
  r.completion("OK");
  r.completion("OK");
  r.notify({ type: "agent_turn_completed", reason: "completed" });
  assert.match(output(r, ids[1]), /may be another's\.\nOK$/);
  assert.equal(r.droid.hasBackgroundWork(), false);
  const ends = r.events.filter((event) => event.type === "tool.end").length;
  r.completion("OK");
  assert.equal(r.events.filter((event) => event.type === "tool.end").length, ends);
});

test("a background Task under the id of an ended one from an earlier turn is tracked with its own child (recent-15)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  let run = 0;
  r.script(async function* () {
    const child = `child-${++run}`;
    yield { type: "tool_call", toolUseId: "task_0", name: "Task", input: { description: child, await: false } };
    r.notify({ type: "child_session_available", toolUseId: "task_0", childSessionId: child });
    yield { type: "tool_result", toolUseId: "task_0", toolName: "Task", content: `Task launched in background.\nsession_id: ${child}\nsubagent_type: explorer`, isError: false };
    yield result();
  });
  await r.start("first");
  r.notify({ type: "agent_turn_completed", reason: "completed" }, "child-1");
  assert.equal(r.droid.hasBackgroundWork(), false);
  await r.start("second");
  assert.equal(r.droid.hasBackgroundWork(), true);
  assert.deepEqual(r.state.subagents.map((child: any) => [child.id, child.status]), [["child-1", "completed"], ["child-2", "running"]]);
});

test("a late word of an earlier Task's child under a reused id does not settle the newer Task (recent-15)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  let run = 0;
  r.script(async function* () {
    const child = `child-${++run}`;
    yield { type: "tool_call", toolUseId: "task_0", name: "Task", input: { description: child, await: false } };
    r.notify({ type: "child_session_available", toolUseId: "task_0", childSessionId: child });
    yield { type: "tool_result", toolUseId: "task_0", toolName: "Task", content: `Task launched in background.\nsession_id: ${child}\nsubagent_type: explorer`, isError: false };
    yield result();
  });
  await r.start("first");
  r.notify({ type: "agent_turn_completed", reason: "completed" }, "child-1");
  await r.start("second");
  // The first child's end told again, and its report as a completion message.
  r.notify({ type: "agent_turn_completed", reason: "error" }, "child-1");
  r.notify({ type: "create_message", message: { id: "task-completion:child-1", role: "system", visibility: "llm_only",
    content: [{ type: "text", text: "Background task completed.\ntask_id: child-1\nreason: completed\noutput: OLD REPORT" }] } });
  assert.deepEqual(r.state.subagents.map((child: any) => [child.id, child.status]), [["child-1", "completed"], ["child-2", "running"]]);
  assert.equal(r.droid.hasBackgroundWork(), true);
});

test("a completion under a reused id goes to the earlier command still at work when the newer one under it ended at its launch (recent-15)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  r.script(launch);
  await r.start("first");
  // The second, under the same id, exits as it launches: no completion follows for it.
  r.script(async function* () {
    yield { type: "tool_call", toolUseId: "call_0", name: "Execute", input: { command: "true", fireAndForget: true } };
    yield { type: "tool_result", toolUseId: "call_0", toolName: "Execute", content: "Command completed with exit code 0", isError: false };
    yield result();
  });
  await r.start("second");
  const ids = r.state.messages.filter((message: any) => message.role === "tool").map((message: any) => message.tool_call_id);
  assert.equal(r.droid.hasBackgroundWork(), true);
  r.completion("FIRST OUTPUT");
  r.notify({ type: "agent_turn_completed", reason: "completed" });
  assert.equal(output(r, ids[0]), "FIRST OUTPUT");
  assert.equal(r.droid.hasBackgroundWork(), false);
});

test("a late completion of a command whose tracking expired is its own, not held for a command begun after (recent-15)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  r.script(launch);
  await r.start("first");
  r.advance(1000);
  assert.equal(r.droid.hasBackgroundWork(), false);
  await r.start("second");
  r.completion("NEW OUTPUT");
  r.notify({ type: "agent_turn_completed", reason: "completed" });
  r.completion("OLD OUTPUT");
  r.notify({ type: "agent_turn_completed", reason: "completed" });
  const ids = r.state.messages.filter((message: any) => message.role === "tool").map((message: any) => message.tool_call_id);
  assert.match(output(r, ids[0]), /OLD OUTPUT$/);
  // A third, begun within the half minute an early completion waits, is at work.
  await r.start("third");
  assert.equal(r.droid.hasBackgroundWork(), true);
  const third = r.state.messages.findLast((message: any) => message.role === "tool").tool_call_id;
  assert.doesNotMatch(output(r, third), /OUTPUT/);
});

test("a completion that comes as another command under the id is announced, before the stream names it, is said to be uncertain (recent-15)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  r.script(launch);
  await r.start("first");
  const streamEnd = gate();
  r.script(async function* () {
    // Droid's raw notifications run ahead of the turn's stream.
    r.notify({ type: "tool_call", toolUse: { id: "call_0", name: "Execute", input: { command: "npm test", fireAndForget: true } } });
    r.notify({ type: "tool_result", toolUseId: "call_0", content: "Background process started (PID: 13)", isError: false });
    r.completion("SECOND OUTPUT");
    await streamEnd.promise;
    yield* launch();
  });
  r.core.submit("second").begin?.();
  await until(() => r.events.some((event) => event.type === "notice" && /cannot tell which one ended/.test(event.text)));
  const first = r.state.messages.find((message: any) => message.role === "tool").tool_call_id;
  assert.match(output(r, first), /may be another's\.\nSECOND OUTPUT$/);
  streamEnd.resolve();
  await until(() => r.events.filter((event) => event.type === "turn.end").length === 2);
});

test("doubt reaches a command Droid announced under the id of one at work, when its completion came before the stream named it (recent-15)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  r.script(launch);
  await r.start("first");
  const named = gate();
  r.script(async function* () {
    r.notify({ type: "tool_call", toolUse: { id: "call_0", name: "Execute", input: { command: "npm test", fireAndForget: true } } });
    r.completion("FAST");
    await named.promise;
    yield* launch();
  });
  r.core.submit("second").begin?.();
  await until(() => r.events.some((event) => event.type === "notice"));
  named.resolve();
  await until(() => r.events.filter((event) => event.type === "turn.end").length === 2);
  r.completion("SLOW");
  r.notify({ type: "agent_turn_completed", reason: "completed" });
  const ids = r.state.messages.filter((message: any) => message.role === "tool").map((message: any) => message.tool_call_id);
  assert.match(output(r, ids[0]), /may be another's\.\nFAST$/);
  assert.match(output(r, ids[1]), /may be another's\.\nSLOW$/);
});

// recent-18. Droid's Stop (`droid.interrupt_session`) answers `{}`; the turn settles after
// (fixtures/droid/interrupt.jsonl). Whether a background command Droid had not acknowledged
// started is told only then: its launch receipt, or a cancelled result.

test("a background command whose launch Droid acknowledges after Stop keeps its real completion (recent-18)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const launched = gate();
  r.script(async function* () {
    yield { type: "tool_call", toolUseId: "call_0", name: "Execute", input: { command: "npm test", fireAndForget: true } };
    await launched.promise;
    yield { type: "tool_result", toolUseId: "call_0", toolName: "Execute", content: "Background process started (PID: 12)", isError: false };
    yield result();
  });
  r.core.submit("first").begin?.();
  await until(() => r.events.some((event) => event.type === "tool.start"));
  assert.equal(await r.droid.interrupt(), true);
  r.notify({ type: "tool_result", toolUseId: "call_0", content: "Background process started (PID: 12)", isError: false });
  // Still at work: Stop on the turn does not stop a command in the background.
  assert.equal(r.droid.hasBackgroundWork(), true);
  r.completion("ACTUAL OUTCOME");
  launched.resolve();
  await until(() => r.events.some((event) => event.type === "turn.end"));
  const row = r.state.messages.findLast((message: any) => message.role === "tool");
  assert.equal(JSON.parse(row.content).output, "ACTUAL OUTCOME");
});

test("a background command Droid never acknowledged fails at the turn's end, and a completion that comes after all still counts (recent-18)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const ended = gate();
  r.script(async function* () {
    yield { type: "tool_call", toolUseId: "call_0", name: "Execute", input: { command: "npm test", fireAndForget: true } };
    await ended.promise;
    yield result();
  });
  r.core.submit("first").begin?.();
  await until(() => r.events.some((event) => event.type === "tool.start"));
  assert.equal(await r.droid.interrupt(), true);
  ended.resolve();
  await until(() => r.events.some((event) => event.type === "turn.end"));
  // Nothing holds the process for it.
  assert.equal(r.droid.hasBackgroundWork(), false);
  // Droid had started it after all.
  r.completion("LATE OUTCOME");
  const row = r.state.messages.findLast((message: any) => message.role === "tool");
  assert.equal(JSON.parse(row.content).output, "LATE OUTCOME");
});

// recent-16. A steering message is Droid's `add_user_message`, answered `{}` once queued;
// Droid's receipt is a user `create_message` naming the request (SDK 0.9.1). Droid takes
// what is still queued once its loop is idle (CLI 0.249.0's request queue, read as text),
// so one still queued as the turn ends is very likely taken after it, as a turn of its own.

async function steeredAtTheEnd(r: Awaited<ReturnType<typeof rig>>) {
  const streamEnd = gate();
  r.script(async function* () { await streamEnd.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.length === 1);
  r.core.submit("second");
  r.core.submit("local", { queue: true });
  await until(() => r.handed.length === 1);
  r.script(async function* () { yield result(); });
  return { id: r.handed[0], end: () => streamEnd.resolve() };
}
const failedTurns = (r: Awaited<ReturnType<typeof rig>>) => r.core.messages.filter((message: any) => message.role === "assistant" && message.display_kind === "failed_turn").length;

test("a steering message Droid takes as its turn ends, before Portals takes it back, goes on as taken and is not failed (recent-16)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const { id, end } = await steeredAtTheEnd(r);
  r.handle.resolveQueuedUserMessage = async (params: { requestId: string }) => {
    r.deleted.push(params.requestId);
    // Droid's receipt comes first, on its one output; then its {}.
    r.notify({ type: "create_message", requestId: params.requestId, message: { role: "user" } });
    return {};
  };
  end();
  await until(() => r.starts.includes("local"));
  assert.deepEqual(r.deleted, [id]);
  assert.equal(r.droid.queuedConsumed(id), true);
  assert.equal(failedTurns(r), 0);
  assert.deepEqual(r.starts, ["first", "local"]);
  assert.ok(r.core.messages.some((message: any) => message.role === "user" && message.text === "second"));
});

test("a steering message still queued as the turn ends is taken back from Droid before it fails, so Try again sends it once (recent-16)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const { id, end } = await steeredAtTheEnd(r);
  end();
  await until(() => r.starts.includes("local"));
  assert.deepEqual(r.deleted, [id]);
  assert.equal(r.droid.queuedConsumed(id), false);
  assert.equal(failedTurns(r), 1);
  assert.deepEqual(r.starts, ["first", "local"]);
});

test("Droid's receipt for a steering message after Portals failed it keeps it as taken and tells the person (recent-16)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const { id, end } = await steeredAtTheEnd(r);
  r.handle.resolveQueuedUserMessage = async () => { throw new Error("Droid took too long to answer."); };
  end();
  await until(() => r.starts.includes("local"));
  assert.equal(failedTurns(r), 1);
  const notices = r.events.filter((event) => event.type === "notice").length;
  r.notify({ type: "create_message", requestId: id, message: { role: "user" } });
  // Kept as taken: a restart does not send it again.
  assert.equal(r.droid.queuedConsumed(id), true);
  assert.equal(failedTurns(r), 0, "Droid's receipt takes back the failure, not just its retry");
  assert.equal(r.events.filter((event) => event.type === "notice").length, notices + 1);
  assert.match(r.events.findLast((event) => event.type === "notice").text, /do not send it again/);
});

// Droid runs a steering message it takes after the turn's end as a turn of its own (CLI
// 0.249.0's request queue, read as text, not recorded): its receipt, then that turn as any
// turn Droid is sent goes, its end (`agent_turn_completed`, its id the message's) and idle:
// fixtures/droid/plain.jsonl from the receipt on. The bridge's stream for the turn before
// ended at that turn's own end, so these come only as raw notifications.
function droidsOwnTurn(r: Awaited<ReturnType<typeof rig>>, id: string, until?: string): void {
  const records = readFileSync(new URL("./fixtures/droid/plain.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const notifications = records.filter((record: any) => record.kind === "notification" && record.notification.params?.notification)
    .map((record: any) => structuredClone(record.notification.params.notification));
  for (const notification of notifications.slice(notifications.findIndex((notification: any) => notification.type === "create_message" && notification.requestId))) {
    if (notification.type === until) return;
    if (notification.requestId) {
      notification.requestId = id;
      notification.message.id = id;
      notification.message.content = [{ type: "text", text: "second" }];
    }
    if (notification.type === "agent_turn_completed") notification.turnId = id;
    r.notify(notification);
  }
}
function follower(r: Awaited<ReturnType<typeof rig>>): any[] {
  const seen: any[] = [];
  r.core.follow({ isOpen: true, sendEvent: (event: any) => seen.push(event) } as any);
  return seen;
}
const turnShape = (seen: any[]) => seen.filter((event) => ["message.start", "message.delta", "message.complete"].includes(event.type))
  .map((event) => event.type === "message.delta" ? `delta ${event.payload.text}` : event.type);
const settle = async () => { for (let n = 0; n < 20; n++) await next(); };

test("Droid's own turn for a steering message it took after Portals failed it opens a turn: its reply streams live and is kept, the message shown once (recent-16)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const streamEnd = gate();
  r.script(async function* () { await streamEnd.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.length === 1);
  r.core.submit("second");
  await until(() => r.handed.length === 1);
  const id = r.handed[0];
  streamEnd.resolve();
  // Taken back with Droid's {} and no receipt: failed, at rest.
  await until(() => failedTurns(r) === 1 && !r.core.isRunning);
  const seen = follower(r);
  droidsOwnTurn(r, id);
  await settle();
  assert.deepEqual(turnShape(seen), ["message.start", "delta hello", "message.complete"]);
  // The turn opens with no second copy of the message, which is shown as it was failed.
  assert.equal(seen.find((event) => event.type === "message.start").payload, undefined);
  assert.equal(r.core.messages.filter((message: any) => message.role === "user" && message.text === "second").length, 1);
  // Droid's history, as the bridge keeps it: the message once, as steered, then its reply.
  assert.deepEqual(r.state.messages.slice(-2).map((message: any) => [message.role, message.text, message.display_kind]),
    [["user", "second", "steer"], ["assistant", "hello", undefined]]);
  assert.equal(r.droid.busy, false);
  assert.equal(r.core.isRunning, false);
});

test("Droid's own turn for a steering message taken after the turn's end, before Portals took it back, opens a turn the message joins; the next message waits for its end (recent-16)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const { id, end } = await steeredAtTheEnd(r);
  const answer = gate();
  r.handle.resolveQueuedUserMessage = async (params: { requestId: string }) => { r.deleted.push(params.requestId); await answer.promise; return {}; };
  end();
  await until(() => r.deleted.length === 1 && !r.droid.busy);
  const seen = follower(r);
  // Its receipt, before Droid's answer to the take-back, and its turn.
  droidsOwnTurn(r, id, "agent_turn_completed");
  answer.resolve();
  await settle();
  assert.deepEqual(r.starts, ["first"]);
  assert.deepEqual(turnShape(seen), ["message.start", "delta hello"]);
  assert.equal(r.droid.queuedConsumed(id), true);
  // Steered into the turn it opened: shown once, and not failed.
  assert.deepEqual(r.core.messages.filter((message: any) => message.role === "user" && message.text === "second").map((message: any) => message.display_kind), ["steer"]);
  assert.equal(failedTurns(r), 0);
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: id });
  await until(() => r.starts.includes("local"));
  assert.deepEqual(turnShape(seen).slice(0, 4), ["message.start", "delta hello", "message.complete", "message.start"]);
});

// Merged with main's 8714a96f: what Droid says after its end of the bridge's turn, while
// that turn still closes, is told after it (`catchingUp`), a steering message's receipt
// too. This test said the late turn was carried in the bridge's turn (one turn, its end
// Droid's last); it now says each of Droid's turns is told as one.
test("Droid's own turn for a steering message taken after the turn's own end, while the bridge still closes that turn, is told after it as a turn of its own the message opens: each turn ends with its own end (recent-16)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const streamEnd = gate(), read = gate();
  let reading = false;
  r.script(async function* () { await streamEnd.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.length === 1);
  r.core.submit("second");
  await until(() => r.handed.length === 1);
  const id = r.handed[0];
  const seen = follower(r);
  // The turn's own end, then the context read the bridge makes before it tells the end.
  r.context(async () => { reading = true; await read.promise; return { used: 1, limit: 100 }; });
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: "first-turn" });
  streamEnd.resolve();
  await until(() => reading);
  droidsOwnTurn(r, id, "agent_turn_completed");
  // Nothing of Droid's own turn is told while the bridge's closes.
  await settle();
  assert.deepEqual(turnShape(seen), []);
  read.resolve();
  await settle();
  // The bridge's turn ends as Droid ended it; Droid's own opens, with no line: the message joins it.
  assert.deepEqual(turnShape(seen), ["message.complete", "message.start", "delta hello"]);
  assert.equal(seen.filter((event) => event.type === "message.start").at(-1).payload, undefined);
  assert.deepEqual(r.events.filter((event) => event.type === "turn.end").map((event) => event.status), ["complete"]);
  assert.equal(r.core.isRunning, true);
  assert.equal(r.droid.queuedConsumed(id), true);
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: id });
  await until(() => !r.core.isRunning);
  assert.deepEqual(turnShape(seen), ["message.complete", "message.start", "delta hello", "message.complete"]);
  assert.deepEqual(r.core.messages.filter((message: any) => message.role === "user" && message.text === "second").map((message: any) => message.display_kind), ["steer"]);
  assert.equal(failedTurns(r), 0);
  // Kept in that order: the message, then its reply, after the bridge's turn.
  assert.deepEqual(r.state.messages.filter((message: any) => message.role !== "tool").map((message: any) => [message.role, message.text, message.display_kind]),
    [["user", "first", undefined], ["user", "second", "steer"], ["assistant", "hello", undefined]]);
});

test("a steering message Droid takes late while the bridge runs the next message's turn goes into that turn: no turn is opened for it (recent-16)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const { id, end } = await steeredAtTheEnd(r);
  const next = gate();
  r.script(async function* () { await next.promise; yield result(); });
  end();
  await until(() => r.starts.includes("local"));
  const seen = follower(r);
  // Droid ran it before the next message, whose stream it reaches (this stand-in's does not).
  droidsOwnTurn(r, id, "agent_turn_completed");
  await settle();
  assert.equal(r.events.some((event) => event.type === "turn.begin"), false);
  assert.deepEqual(turnShape(seen), []);
  assert.equal(r.droid.queuedConsumed(id), true);
  next.resolve();
  await until(() => !r.core.isRunning);
  assert.deepEqual(turnShape(seen), ["message.complete"]);
});

test("Droid's own turn for a late steering message ends with a Stop, and with Droid's process (recent-16)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const late = async () => {
    const streamEnd = gate();
    r.script(async function* () { await streamEnd.promise; yield result(); });
    const ends = r.events.filter((event) => event.type === "turn.end").length;
    r.core.submit("first").begin?.();
    await until(() => r.handed.length === r.starts.length - 1);
    r.core.submit("second");
    await until(() => r.handed.length === r.starts.length);
    streamEnd.resolve();
    await until(() => r.events.filter((event) => event.type === "turn.end").length > ends && !r.core.isRunning);
    droidsOwnTurn(r, r.handed.at(-1)!, "agent_turn_completed");
    await until(() => r.core.isRunning);
    return r.handed.at(-1)!;
  };
  const id = await late();
  // Stopped: Droid ends its turn as cancelled.
  r.handle.interrupt = async () => { r.notify({ type: "agent_turn_completed", reason: "cancelled", turnId: id }); };
  assert.equal(await r.core.interrupt(), true);
  await until(() => !r.core.isRunning);
  assert.equal(r.events.findLast((event) => event.type === "turn.end").status, "interrupted");
  // Droid's process stops in the middle of another.
  await late();
  for (const exited of r.exits) exited(new Error("The Droid process stopped."));
  await until(() => !r.core.isRunning);
  assert.equal(r.events.findLast((event) => event.type === "turn.end").status, "error");
  assert.equal(r.droid.busy, false);
});

// Codex's review of the late-steer turns (droid-review probes, made tests).
async function lateTurn(r: Awaited<ReturnType<typeof rig>>): Promise<string> {
  const streamEnd = gate();
  r.script(async function* () { await streamEnd.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.includes("first"));
  r.core.submit("second");
  await until(() => r.handed.length === 1);
  streamEnd.resolve();
  await until(() => !r.core.isRunning);
  droidsOwnTurn(r, r.handed[0], "agent_turn_completed");
  await until(() => r.core.isRunning);
  return r.handed[0];
}

test("a background command's completion turn ending does not end Droid's own turn for a late steering message: the rest of its reply is kept (recent-16)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  r.script(launch);
  await r.start("background");
  const id = await lateTurn(r);
  r.completion("BACKGROUND OUTPUT");
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: "execute-completion:call_0" });
  // And the idle that follows it (Codex's re-check).
  r.notify({ type: "droid_working_state_changed", newState: "idle" });
  await settle();
  assert.equal(r.core.isRunning, true);
  r.notify({ type: "assistant_text_delta", messageId: "late-tail", blockIndex: 0, textDelta: " and the rest" });
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: id });
  await until(() => !r.core.isRunning);
  assert.ok(r.state.messages.some((message: any) => message.role === "assistant" && message.text?.includes("and the rest")));
});

test("Droid's own turn for a late steering message that hands a plan to a new session leaves the next message to open that session (recent-16)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const streamEnd = gate(), read = gate();
  let reading = false;
  r.script(async function* () { await streamEnd.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.length === 1);
  r.core.submit("second");
  await until(() => r.handed.length === 1);
  const id = r.handed[0];
  r.context(async () => { reading = true; await read.promise; return { used: 1, limit: 100 }; });
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: "first-turn" });
  streamEnd.resolve();
  await until(() => reading);
  droidsOwnTurn(r, id, "agent_turn_completed");
  read.resolve();
  await settle();
  (r.droid as any).permissionSelected({ toolUses: [{ toolUse: { id: "spec-call" }, details: { type: "exit_spec_mode" } }] }, "proceed_new_session_low");
  r.notify({ type: "tool_result", toolUseId: "spec-call", content: '{"approved":true,"handoff":{"isNewSession":true}}', isError: false });
  r.notify({ type: "create_message", message: { id: "implementation-root", role: "user", parentId: "root" } }, "implementation");
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: id }, "implementation");
  await until(() => !r.core.isRunning);
  assert.equal((r.droid as any).state.session, "implementation");
  // The handle on the planning session is let go of: the next message opens the new one.
  assert.equal(r.handle.closed, 1);
});

test("Droid's own turn for a late steering message that fails is told as failed, though the bridge's turn's stream tells its own success after it (recent-16)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const streamEnd = gate();
  r.script(async function* () { await streamEnd.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.length === 1);
  r.core.submit("second");
  await until(() => r.handed.length === 1);
  const id = r.handed[0];
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: "first-turn" });
  droidsOwnTurn(r, id, "agent_turn_completed");
  r.notify({ type: "agent_turn_completed", reason: "error", turnId: id });
  streamEnd.resolve();
  await until(() => !r.core.isRunning);
  assert.equal(r.events.findLast((event) => event.type === "turn.end").status, "error");
});

test("the end of a turn Droid ran for a steering message, heard while the next message's turn streams, is not that turn's end: a steer after it is not followed twice (recent-16)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const streamEnd = gate();
  r.script(async function* () { await streamEnd.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.length === 1);
  r.core.submit("second");
  await until(() => r.handed.length === 1);
  const earlier = r.handed[0];
  streamEnd.resolve();
  await until(() => !r.core.isRunning && !r.droid.busy);
  const next = gate();
  r.script(async function* () { await next.promise; yield result(); });
  r.core.submit("local").begin?.();
  await until(() => r.starts.includes("local"));
  // Droid ran the earlier steering message just before the next message.
  droidsOwnTurn(r, earlier, "assistant_text_delta");
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: earlier });
  assert.notEqual((r.droid as any).turn.droidDone, true);
  r.core.submit("third");
  await until(() => r.handed.length === 2);
  droidsOwnTurn(r, r.handed[1], "assistant_text_delta");
  assert.equal((r.droid as any).turn.own, undefined);
  // The next message's text is its stream's (here the stand-in's, which reads none of these).
  const texts = r.events.filter((event) => event.type === "text").length;
  r.notify({ type: "assistant_text_delta", messageId: "local-answer", blockIndex: 0, textDelta: "LOCAL TEXT" });
  await settle();
  assert.equal(r.events.filter((event) => event.type === "text").length, texts);
  next.resolve();
  await until(() => !r.core.isRunning);
});

// Both of Droid's own turns at once (main's 8714a96f with #17's late steering message):
// background work ends while a steering message Droid took late waits to be run. Droid
// answers both in one turn of its own, which the line for what ended opens, and the
// message joins as steered; its end names the completion, and a message queued meanwhile
// waits for it. While the bridge's turn still closes, or at rest after it.
for (const when of ["closing", "at rest"] as const) test(`background work that ends while a late steering message is pending: one turn of Droid's own, opened by what ended, the message steered into it (${when})`, async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  r.script(launch);
  await r.start("background");
  const streamEnd = gate(), read = gate(), answer = gate();
  let reading = false;
  r.script(async function* () { await streamEnd.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.includes("first"));
  r.core.submit("second");
  await until(() => r.handed.length === 1);
  const id = r.handed[0];
  r.core.submit("next", { queue: true });
  const seen = follower(r);
  if (when === "closing") r.context(async () => { reading = true; await read.promise; return { used: 1, limit: 100 }; });
  // At rest, Droid has not yet answered the bridge's taking back of the message.
  else r.handle.resolveQueuedUserMessage = async (params: { requestId: string }) => { r.deleted.push(params.requestId); await answer.promise; return {}; };
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: "first-turn" });
  streamEnd.resolve();
  await until(() => when === "closing" ? reading : r.deleted.length === 1 && !r.core.isRunning);
  r.completion("BUILD OK");
  droidsOwnTurn(r, id, "agent_turn_completed");
  read.resolve();
  answer.resolve();
  await settle();
  assert.deepEqual(turnShape(seen), ["message.complete", "message.start", "delta hello"]);
  assert.ok(seen.some((event) => event.type === "status.update" && event.payload.text === '"npm test" finished'));
  assert.equal(r.droid.queuedConsumed(id), true);
  assert.deepEqual(r.core.messages.filter((message: any) => message.role === "user" && message.text === "second").map((message: any) => message.display_kind), ["steer"]);
  assert.equal(failedTurns(r), 0);
  assert.equal(r.core.isRunning, true);
  assert.deepEqual(r.starts, ["background", "first"]);
  // The end of the completion's turn is this one's: the queued message's turn begins.
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: "execute-completion:call_0" });
  await until(() => r.starts.includes("next"));
  assert.deepEqual(turnShape(seen).slice(0, 5), ["message.complete", "message.start", "delta hello", "message.complete", "message.start"]);
  assert.deepEqual(r.events.filter((event) => event.type === "turn.begin").length, 1);
  assert.deepEqual(r.state.messages.filter((message: any) => message.role !== "tool").slice(-4).map((message: any) => [message.role, message.text, message.display_kind]), [
    ["user", '"npm test" finished', "process_complete"], ["user", "second", "steer"], ["assistant", "hello", undefined], ["user", "next", undefined]]);
});

test("a late steering message's receipt held while the bridge's turn closes, when Droid's process stops then, still keeps the message as taken: Try again would send it twice", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const seen: any[] = [];
  r.core.follow({ isOpen: true, messageReconciliation: true, sendEvent: (event: any) => seen.push(event) } as any);
  const streamEnd = gate(), read = gate();
  let reading = false;
  r.script(async function* () { await streamEnd.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.length === 1);
  r.core.submit("second");
  await until(() => r.handed.length === 1);
  const id = r.handed[0];
  r.context(async () => { reading = true; await read.promise; return { used: 1, limit: 100 }; });
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: "first-turn" });
  streamEnd.resolve();
  await until(() => reading);
  droidsOwnTurn(r, id, "assistant_text_delta");
  assert.equal(r.droid.queuedConsumed(id), false, "held for after the turn");
  for (const exited of r.exits) exited(new Error("The Droid process stopped."));
  read.resolve();
  await until(() => !r.core.isRunning);
  await settle();
  assert.equal(r.droid.queuedConsumed(id), true);
  assert.match(r.events.findLast((event) => event.type === "notice").text, /do not send it again/);
  assert.equal(r.events.some((event) => event.type === "turn.begin"), false);
  assert.equal((r.core as any).transcript.isInTurn, false, "acceptance after process loss does not reopen the closed turn");
  assert.equal(seen.some((event) => event.type === "message.steered"), false);
  assert.equal(seen.some((event) => event.type === "session.invalidated"), true, "even capable clients refresh closed history");
  assert.equal(r.core.messages.some((message: any) => message.role === "assistant" && message.display_metadata?.failed_request_id === id), false);
  assert.equal(r.core.messages.filter((message: any) => message.role === "user" && message.text === "second").length, 1);
});

// Codex's review of the merge with main's 8714a96f (q-droid probes, made tests).
async function closingSteer(t: any) {
  const r = await rig();
  const streamEnd = gate(), read = gate();
  let reading = false;
  t.after(() => { streamEnd.resolve(); read.resolve(); return r.core.close(); });
  r.script(async function* () { await streamEnd.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.length === 1);
  r.core.submit("second");
  await until(() => r.handed.length === 1);
  r.context(async () => { reading = true; await read.promise; return { used: 1, limit: 100 }; });
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: "first-turn" });
  streamEnd.resolve();
  await until(() => reading);
  return { r, read, id: r.handed[0] };
}

test("a late steering message's receipt under another session's id, taken while the bridge's turn closes: Droid's turn told after it ends with its end", async (t) => {
  const { r, read, id } = await closingSteer(t);
  r.notify({ type: "create_message", requestId: id, message: { role: "user", id } }, "other-session");
  r.notify({ type: "assistant_text_delta", messageId: "reply", blockIndex: 0, textDelta: "hello" });
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: id });
  r.notify({ type: "droid_working_state_changed", newState: "idle" });
  read.resolve();
  await settle();
  assert.equal(r.droid.queuedConsumed(id), true);
  assert.equal(r.core.isRunning, false);
  assert.deepEqual(r.events.filter((event) => event.type === "turn.end").map((event) => event.status), ["complete", "complete"]);
  assert.ok(r.state.messages.some((message: any) => message.role === "assistant" && message.text === "hello"));
});

test("a plan handed to a new session while the bridge's turn closes, in Droid's turn for a late steering message, is taken up: the planning session's handle is let go of", async (t) => {
  const { r, read, id } = await closingSteer(t);
  r.notify({ type: "create_message", requestId: id, message: { role: "user", id } });
  r.notify({ type: "assistant_text_delta", messageId: "reply", blockIndex: 0, textDelta: "plan" });
  (r.droid as any).permissionSelected({ toolUses: [{ toolUse: { id: "spec-call" }, details: { type: "exit_spec_mode" } }] }, "proceed_new_session_low");
  r.notify({ type: "tool_result", toolUseId: "spec-call", content: '{"approved":true,"handoff":{"isNewSession":true}}', isError: false });
  r.notify({ type: "create_message", message: { id: "implementation-root", role: "user", parentId: "root" } }, "implementation");
  r.notify({ type: "assistant_text_delta", messageId: "impl", blockIndex: 0, textDelta: "implemented" }, "implementation");
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: id }, "implementation");
  r.notify({ type: "droid_working_state_changed", newState: "idle" }, "implementation");
  read.resolve();
  await settle();
  assert.equal(r.core.isRunning, false);
  assert.equal((r.droid as any).state.session, "implementation");
  assert.equal(r.handle.closed, 1);
  assert.ok(r.state.messages.some((message: any) => message.role === "assistant" && message.text === "implemented"));
});

test("Droid's own turn for a late steering message whose plan's handoff fails ends as failed, not waiting for a new session", async (t) => {
  const r = await rig();
  const streamEnd = gate();
  t.after(() => { streamEnd.resolve(); return r.core.close(); });
  r.script(async function* () { await streamEnd.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.length === 1);
  r.core.submit("second");
  await until(() => r.handed.length === 1);
  const id = r.handed[0];
  streamEnd.resolve();
  await until(() => !r.core.isRunning);
  r.notify({ type: "create_message", requestId: id, message: { role: "user", id } });
  r.notify({ type: "assistant_text_delta", messageId: "plan", blockIndex: 0, textDelta: "plan" });
  (r.droid as any).permissionSelected({ toolUses: [{ toolUse: { id: "spec-call" }, details: { type: "exit_spec_mode" } }] }, "proceed_new_session_low");
  r.notify({ type: "tool_result", toolUseId: "spec-call", content: "could not create implementation session", isError: true });
  r.notify({ type: "agent_turn_completed", reason: "error", turnId: id });
  r.notify({ type: "droid_working_state_changed", newState: "idle" });
  await settle();
  assert.equal(r.core.isRunning, false);
  assert.equal(r.events.findLast((event) => event.type === "turn.end").status, "error");
  assert.equal((r.droid as any).state.session, "root");
});

// Codex's re-check of f17968f5.
const specApproved = (r: Awaited<ReturnType<typeof rig>>) => {
  (r.droid as any).permissionSelected({ toolUses: [{ toolUse: { id: "spec-call" }, details: { type: "exit_spec_mode" } }] }, "proceed_new_session_low");
  r.notify({ type: "tool_result", toolUseId: "spec-call", content: '{"approved":true,"handoff":{"isNewSession":true}}', isError: false });
};
const implementationRoot = (r: Awaited<ReturnType<typeof rig>>) => r.notify({ type: "create_message", message: { id: "implementation-root", role: "user", parentId: "root" } }, "implementation");

test("Droid's own turn for a late steering message whose planning session ends with spec_handoff before the new session is seen goes on in the new one", async (t) => {
  const r = await rig();
  const done = gate();
  t.after(() => { done.resolve(); return r.core.close(); });
  r.script(async function* () { await done.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.length === 1);
  r.core.submit("second");
  await until(() => r.handed.length === 1);
  const id = r.handed[0];
  done.resolve();
  await until(() => !r.core.isRunning);
  r.notify({ type: "create_message", requestId: id, message: { role: "user", id } });
  r.notify({ type: "assistant_text_delta", messageId: "plan", blockIndex: 0, textDelta: "plan" });
  specApproved(r);
  r.notify({ type: "agent_turn_completed", reason: "spec_handoff", turnId: id });
  implementationRoot(r);
  r.notify({ type: "assistant_text_delta", messageId: "impl", blockIndex: 0, textDelta: "implemented" }, "implementation");
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: id }, "implementation");
  await settle();
  assert.equal((r.droid as any).state.session, "implementation");
  assert.ok(r.state.messages.some((message: any) => message.role === "assistant" && message.text === "implemented"));
  assert.equal(r.core.isRunning, false);
  assert.equal(r.handle.closed, 1);
});

test("two late steering messages' turns held while the bridge's turn closes, the first handing a plan to a new session: both are told, and the planning handle is let go of only after them", async (t) => {
  const r = await rig();
  const streamEnd = gate(), read = gate();
  let reading = false;
  t.after(() => { streamEnd.resolve(); read.resolve(); return r.core.close(); });
  r.script(async function* () { await streamEnd.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.length === 1);
  r.core.submit("second");
  r.core.submit("third");
  await until(() => r.handed.length === 2);
  const [first, second] = r.handed;
  r.context(async () => { reading = true; await read.promise; return { used: 1, limit: 100 }; });
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: "first-turn" });
  streamEnd.resolve();
  await until(() => reading);
  r.notify({ type: "create_message", requestId: first, message: { role: "user", id: first } });
  r.notify({ type: "assistant_text_delta", messageId: "plan", blockIndex: 0, textDelta: "plan" });
  specApproved(r);
  implementationRoot(r);
  r.notify({ type: "assistant_text_delta", messageId: "impl1", blockIndex: 0, textDelta: "first reply" }, "implementation");
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: first }, "implementation");
  r.notify({ type: "droid_working_state_changed", newState: "idle" }, "implementation");
  r.notify({ type: "create_message", requestId: second, message: { role: "user", id: second } }, "implementation");
  r.notify({ type: "assistant_text_delta", messageId: "impl2", blockIndex: 0, textDelta: "second reply" }, "implementation");
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: second }, "implementation");
  r.notify({ type: "droid_working_state_changed", newState: "idle" }, "implementation");
  read.resolve();
  await settle();
  assert.equal(r.core.isRunning, false);
  assert.deepEqual(r.events.filter((event) => event.type === "turn.end").map((event) => event.status), ["complete", "complete", "complete"]);
  assert.equal(r.droid.queuedConsumed(second), true);
  assert.ok(r.state.messages.some((message: any) => message.role === "assistant" && message.text === "second reply"));
  assert.equal((r.droid as any).state.session, "implementation");
  assert.equal(r.handle.closed, 1);
});

// Codex's last look at 7f74207f.
test("a plan handed on while the bridge's turn closes, the planning session's spec_handoff end held with Droid's turn: what the new session says is told and its turn ends, and the planning handle is let go of", async (t) => {
  const { r, read, id } = await closingSteer(t);
  r.notify({ type: "create_message", requestId: id, message: { role: "user", id } });
  r.notify({ type: "assistant_text_delta", messageId: "reply", blockIndex: 0, textDelta: "plan" });
  specApproved(r);
  r.notify({ type: "agent_turn_completed", reason: "spec_handoff", turnId: id });
  implementationRoot(r);
  r.notify({ type: "assistant_text_delta", messageId: "impl", blockIndex: 0, textDelta: "implemented" }, "implementation");
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: id }, "implementation");
  r.notify({ type: "droid_working_state_changed", newState: "idle" }, "implementation");
  read.resolve();
  await settle();
  assert.equal(r.core.isRunning, false);
  assert.equal((r.droid as any).state.session, "implementation");
  assert.ok(r.state.messages.some((message: any) => message.role === "assistant" && message.text === "implemented"));
  assert.equal(r.handle.closed, 1);
});

test("a turn of Droid's own let go of as a message's turn begins, after it handed a plan to a new session: the message's turn opens the new session", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  await r.start("history");
  const pending = r.core.submit("next");
  assert.equal(pending.status, "streaming");
  r.notify({ type: "assistant_text_delta", messageId: "plan", blockIndex: 0, textDelta: "plan" });
  assert.ok((r.droid as any).turn?.own);
  specApproved(r);
  implementationRoot(r);
  assert.equal((r.droid as any).state.session, "implementation");
  let closedBefore = -1;
  const stream = r.handle.stream;
  r.handle.stream = (text: string) => { closedBefore = r.handle.closed; return stream(text); };
  pending.begin?.();
  await until(() => r.starts.includes("next"));
  // The planning session's handle was let go of before the message went to Droid.
  assert.equal(closedBefore, 1);
});

// Codex's look at 24d1b4db.
test("a turn of Droid's own that knows of nothing it answers is not ended by a background command's completion heard while it runs: its tool's result is kept", async (t) => {
  const { r, read, id } = await closingSteer(t);
  r.notify({ type: "create_message", requestId: id, message: { role: "user", id } });
  r.notify({ type: "assistant_text_delta", messageId: "plan", blockIndex: 0, textDelta: "plan" });
  specApproved(r);
  r.notify({ type: "agent_turn_completed", reason: "spec_handoff", turnId: id });
  implementationRoot(r);
  r.notify({ type: "assistant_text_delta", messageId: "implementation", blockIndex: 0, textDelta: "implementing" }, "implementation");
  read.resolve();
  await settle();
  assert.equal((r.droid as any).turn.own.ids.size, 0);
  const tool = (call: string, name: string, input: unknown) => r.notify({ type: "create_message", message: { id: `message-${call}`, role: "assistant", createdAt: 1, updatedAt: 1,
    content: [{ type: "tool_use", id: call, name, input }] } }, "implementation");
  tool("bg", "Execute", { command: "npm test", fireAndForget: true });
  r.notify({ type: "tool_result", messageId: "result-bg", toolUseId: "bg", content: "Background process started (PID: 12)", isError: false }, "implementation");
  tool("read", "Read", { file_path: "notes.txt" });
  r.notify({ type: "create_message", message: { id: "execute-completion:bg", role: "user", visibility: "llm_only",
    content: [{ type: "text", text: "Background Execute command finished.\ntool_use_id: bg\nexit_status: code 0\noutput: TESTS PASSED" }] } }, "implementation");
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: "execute-completion:bg" }, "implementation");
  assert.equal(r.core.isRunning, true);
  r.notify({ type: "droid_working_state_changed", newState: "idle" }, "implementation");
  r.notify({ type: "tool_result", messageId: "result-read", toolUseId: "read", content: "ACTUAL NOTES", isError: false }, "implementation");
  await settle();
  assert.match(r.state.messages.find((message: any) => message.role === "tool" && message.tool_call_id === "read").content, /ACTUAL NOTES/);
  // Its own end, unknown to it, still ends it.
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: id }, "implementation");
  await settle();
  assert.equal(r.core.isRunning, false);
  assert.equal(r.handle.closed, 1);
});

// Codex's look at 3ba9cbf8: the same, all of it held while the bridge's turn closes.
test("a background command's completion held with the rest while the bridge's turn closes does not end the turn of Droid's own it came in: its tool's result is kept", async (t) => {
  const { r, read, id } = await closingSteer(t);
  r.notify({ type: "create_message", requestId: id, message: { role: "user", id } });
  r.notify({ type: "assistant_text_delta", messageId: "plan", blockIndex: 0, textDelta: "plan" });
  specApproved(r);
  r.notify({ type: "agent_turn_completed", reason: "spec_handoff", turnId: id });
  implementationRoot(r);
  r.notify({ type: "assistant_text_delta", messageId: "implementation", blockIndex: 0, textDelta: "implementing" }, "implementation");
  const tool = (call: string, name: string, input: unknown) => {
    r.notify({ type: "tool_call", toolUse: { id: call, name, input } }, "implementation");
    r.notify({ type: "create_message", message: { id: `message-${call}`, role: "assistant", createdAt: 1, updatedAt: 1, content: [{ type: "tool_use", id: call, name, input }] } }, "implementation");
  };
  tool("bg", "Execute", { command: "npm test", fireAndForget: true });
  r.notify({ type: "tool_result", messageId: "result-bg", toolUseId: "bg", content: "Background process started (PID: 12)", isError: false }, "implementation");
  tool("read", "Read", { file_path: "notes.txt" });
  r.notify({ type: "create_message", message: { id: "execute-completion:bg", role: "user", visibility: "llm_only", createdAt: 1, updatedAt: 1,
    content: [{ type: "text", text: "Background Execute command finished.\ntool_use_id: bg\nexit_status: code 0\noutput: TESTS PASSED" }] } }, "implementation");
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: "execute-completion:bg" }, "implementation");
  r.notify({ type: "droid_working_state_changed", newState: "idle" }, "implementation");
  r.notify({ type: "tool_result", messageId: "result-read", toolUseId: "read", content: "ACTUAL NOTES", isError: false }, "implementation");
  r.notify({ type: "agent_turn_completed", reason: "completed", turnId: id }, "implementation");
  read.resolve();
  await settle();
  assert.match(r.state.messages.find((message: any) => message.role === "tool" && message.tool_call_id === "read").content, /ACTUAL NOTES/);
  assert.equal(r.core.isRunning, false);
  assert.equal(r.handle.closed, 1);
});

// recent-17. Droid answers `droid.resolve_queued_user_message` delete with `{}` whether it
// deleted the message or had taken it already (CLI 0.249.0: `if(!o){emitResponse(e.id,{})…}`).
// Its receipt for one it took comes first on its one output; should one come after all the
// same, Droid has the message.

test("Droid's receipt for a steering message after its {} to the removal keeps it as taken and tells the person (recent-17)", async (t) => {
  const r = await rig();
  t.after(() => r.core.close());
  const streamEnd = gate();
  r.script(async function* () { await streamEnd.promise; yield result(); });
  r.core.submit("first").begin?.();
  await until(() => r.starts.length === 1);
  const second = r.core.submit("second");
  await until(() => r.handed.length === 1);
  const id = r.handed[0];
  assert.equal(await r.core.removeQueued(second.queueID!), true);
  assert.deepEqual(r.deleted, [id]);
  assert.equal(r.droid.queuedConsumed(id), false);
  r.notify({ type: "create_message", requestId: id, message: { role: "user" } });
  assert.equal(r.droid.queuedConsumed(id), true);
  assert.match(r.events.findLast((event) => event.type === "notice").text, /do not send it again/);
  streamEnd.resolve();
  await until(() => r.events.some((event) => event.type === "turn.end"));
});
