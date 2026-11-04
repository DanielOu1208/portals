import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { OpenCodeStopNotes, restartsExecution, stopNoteLimits } from "../src/providers/opencode/stopNotes.ts";
import type { Message } from "../src/providers/opencode/protocol.ts";
import { OpenCodeSession } from "../src/providers/opencode/session.ts";
import { OpenCodeProvider } from "../src/providers/opencode/provider.ts";
import type { OpenCodeApi } from "../src/providers/opencode/client.ts";
import type { ProviderEvent } from "../src/providers/types.ts";
import type { OwnedStopResult } from "../src/providers/opencode/server.ts";
import { FakeOpenCode } from "./opencode-serve.ts";
import { startTestBridge, TestClient } from "./helpers.ts";

const id = "ses_stop_notes";
const result = (complete = true, settled = [id], unsettled: string[] = []): OwnedStopResult => ({
  serverIdentity: "server_native_process", complete, settled, unsettled,
  executions: [...settled, ...unsettled].map((sessionID) => ({ sessionID, openerID: "user_1", assistantID: "assistant_1", ...(settled.includes(sessionID) ? { terminalID: "idle_1", outcome: "interrupted" as const } : {}) })),
});
const idle = (outcome: "interrupted" | "succeeded" | "failed" = "interrupted", created = Date.now()): Message[] => [{ id: "idle_1", type: "idle", outcome, time: { created } }];
const restarted = (): Message[] => [
  { id: "user_1", type: "user", text: "Original work", time: { created: 1 } },
  { id: "assistant_1", type: "assistant", content: [], error: { type: "aborted", message: "Step interrupted" }, time: { created: 2 } },
  { id: "restart_1", type: "synthetic", text: "Continue after restart", metadata: { notice: "restart" }, time: { created: 3 } },
];
function rig(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "portals-opencode-notes-"));
  t.after(() => rmSync(home, { force: true, recursive: true }));
  const path = join(home, "opencode.log.stops.json");
  return { path, home, notes: new OpenCodeStopNotes(path) };
}

test("owned-stop notes survive restart, are private and atomic, and are consumed once", (t) => {
  const r = rig(t);
  r.notes.remember(result());
  assert.equal(statSync(r.path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(r.home), ["opencode.log.stops.json"]);
  const fresh = new OpenCodeStopNotes(r.path);
  assert.match(fresh.take(id, [], idle(), new Set())!.text, /stopped because the host shut down its OpenCode server/);
  assert.equal(new OpenCodeStopNotes(r.path).take(id, [], idle(), new Set()), undefined);
});

test("replay explicitly reports actual native auto-continuation instead of claiming it stopped", (t) => {
  const r = rig(t);
  r.notes.remember(result(false, [], [id]));
  assert.match(r.notes.take(id, [], restarted(), new Set([id]))!.text, /OpenCode resumed this turn after the host stopped/);
});

test("unknown inventory warns each thread once even with no unsettled IDs", (t) => {
  const r = rig(t);
  r.notes.remember(result(false, [], []));
  const messages: Message[] = [{ id: "user_1", type: "user", text: "still unresolved", time: { created: 1 } }];
  assert.match(r.notes.take(id, [], messages, new Set())!.text, /may resume when OpenCode next starts/);
  assert.equal(new OpenCodeStopNotes(r.path).take(id, [], messages, new Set()), undefined);
  assert.match(r.notes.take("ses_other", [], messages, new Set())!.text, /may resume/);
});

test("child outcomes route to their owning root and disappear after successful completion", (t) => {
  const r = rig(t);
  r.notes.remember(result(false, [], ["ses_child"]));
  assert.match(r.notes.take(id, ["ses_child"], idle("succeeded"), new Set(["ses_child"]), 0, true, new Map([[id, idle("succeeded")], ["ses_child", restarted()]]))!.text, /1 subagent was resumed by OpenCode/);
  r.notes.remember(result(true, [id]));
  assert.equal(r.notes.take(id, [], idle("succeeded", Date.now() + 1), new Set()), undefined);
});

test("missing native threads drop their targeted note without warning another thread", (t) => {
  const r = rig(t);
  r.notes.remember(result());
  r.notes.shown(id);
  assert.equal(new OpenCodeStopNotes(r.path).take("ses_other", [], [], new Set()), undefined);
});

test("unknown notes expire after a fixed age and never become permanent warnings", (t) => {
  const r = rig(t);
  r.notes.remember(result(false, [], []));
  const saved = JSON.parse(readFileSync(r.path, "utf8"));
  saved.records[0].at = Date.now() - stopNoteLimits.ageMs - 1;
  writeFileSync(r.path, JSON.stringify(saved));
  assert.equal(new OpenCodeStopNotes(r.path).take(id, [], [], new Set()), undefined);
});

test("a fresh thread cannot inherit an unknown warning from a server stopped before it existed", (t) => {
  const r = rig(t);
  r.notes.remember(result(false, [], []));
  assert.equal(r.notes.take(id, [], [], new Set(), Date.now() + 1), undefined);
});

test("an old interrupted turn cannot disguise an uncertain child's shutdown outcome", (t) => {
  const r = rig(t);
  r.notes.remember(result(true, [], ["ses_child"]));
  assert.match(r.notes.take(id, ["ses_child"], idle(), new Set())!.text, /may resume/);
});

test("missing, corrupt, invalid and oversized ledger files cannot prevent thread loading", (t) => {
  const r = rig(t);
  assert.equal(r.notes.take(id, [], [], new Set()), undefined);
  for (const bytes of ["not JSON", JSON.stringify({ format: 1, records: [result()] }), " ".repeat(stopNoteLimits.bytes + 1)]) {
    writeFileSync(r.path, bytes);
    assert.equal(new OpenCodeStopNotes(r.path).take(id, [], [], new Set()), undefined);
  }
});

test("ledger count, ID and byte bounds degrade to explicit unknown inventory", (t) => {
  const r = rig(t);
  for (let n = 0; n < stopNoteLimits.records + 3; ++n) {
    r.notes.remember(result(true, Array.from({ length: stopNoteLimits.ids + 1 }, (_, i) => `ses_${n}_${i}_${"x".repeat(130)}`)));
  }
  const saved = JSON.parse(readFileSync(r.path, "utf8"));
  assert.ok(saved.records.length <= stopNoteLimits.records);
  assert.ok(statSync(r.path).size <= stopNoteLimits.bytes);
  assert.ok(saved.records.every((record: any) => record.settled.length <= stopNoteLimits.ids && record.complete === false));
  assert.match(r.notes.take("ses_not_in_truncated_ids", [], [], new Set())!.text, /may resume/);
});

test("the shown-thread bound expires unknown inventory instead of repeating forgotten warnings", (t) => {
  const r = rig(t);
  r.notes.remember(result(false, [], []));
  for (let n = 0; n < stopNoteLimits.shown; ++n) r.notes.shown(`ses_${n}`);
  assert.equal(new OpenCodeStopNotes(r.path).take("ses_0", [], [], new Set()), undefined);
  assert.equal(r.notes.take("ses_not_seen", [], [], new Set()), undefined);
});

test("native settlement still ends an open generic turn after the provider session was closed", async () => {
  const events: ProviderEvent[] = [];
  const api = { pendingPermissions: async () => [], forms: async () => [] } as unknown as OpenCodeApi;
  const session = new OpenCodeSession(
    { id, cwd: "/tmp", settings: { model: "p/m", provider: "p", reasoningEffort: "" } },
    { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "" }) },
    { api: async () => api, bind() {}, forget() {}, contextOf() {}, levelsOf() {} },
    { info: { id, time: { created: 1, updated: 1 } }, messages: [{ id: "user_1", type: "user", text: "Working", time: { created: 1 } }], running: true },
  );
  session.attached();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await session.close();
  assert.equal(session.serverStopped(result()), false, "a closed view has not delivered the note live");
  session.serverStopped(result());
  const ended = events.filter((event) => event.type === "turn.end");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].status, "interrupted");
  assert.match(ended[0].error!, /stopped because the host shut down its OpenCode server/);
});

for (const outcome of ["succeeded", "failed"] as const) {
  for (const closed of [false, true]) {
    test(`native ${outcome} during shutdown keeps its exact turn status with the view ${closed ? "closed" : "open"}`, async () => {
      const events: ProviderEvent[] = [];
      const api = { pendingPermissions: async () => [], forms: async () => [] } as unknown as OpenCodeApi;
      const session = new OpenCodeSession(
        { id, cwd: "/tmp", settings: { model: "p/m", provider: "p", reasoningEffort: "" } },
        { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "" }) },
        { api: async () => api, bind() {}, forget() {}, contextOf() {}, levelsOf() {} },
        { info: { id, time: { created: 1, updated: 1 } }, messages: [{ id: "user_1", type: "user", text: "Working", time: { created: 1 } }], running: true },
      );
      session.attached();
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (closed) await session.close();
      const completed = result();
      completed.executions![0].outcome = outcome;
      assert.equal(session.serverStopped(completed), !closed);
      session.serverStopped(completed);
      const ended = events.filter((event) => event.type === "turn.end");
      assert.equal(ended.length, 1, "the shutdown callback settles the generic turn once");
      assert.equal(ended[0].status, outcome === "succeeded" ? "complete" : "error");
      assert.equal(ended[0].error, outcome === "failed" ? "OpenCode stopped with an error." : undefined);
      assert.ok(!events.some((event) => event.type === "notice"), "a native completion is not a host stop notice");
      await session.close();
    });
  }

  test(`durably recorded ${outcome} remains completed when a later history page omits its terminal`, (t) => {
    const r = rig(t);
    const completed = result();
    completed.executions![0].outcome = outcome;
    r.notes.remember(completed);
    assert.equal(JSON.parse(readFileSync(r.path, "utf8")).records[0].executions[0].outcome, outcome);
    assert.equal(new OpenCodeStopNotes(r.path).take(id, [], [], new Set()), undefined);
    assert.equal(new OpenCodeStopNotes(r.path).pending, false);
  });
}

test("a completed root and child do not produce a false live stop notice", async () => {
  const events: ProviderEvent[] = [];
  const api = { pendingPermissions: async () => [], forms: async () => [] } as unknown as OpenCodeApi;
  const session = new OpenCodeSession(
    { id, cwd: "/tmp", settings: { model: "p/m", provider: "p", reasoningEffort: "" } },
    { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "" }) },
    { api: async () => api, bind() {}, forget() {}, contextOf() {}, levelsOf() {} },
    { info: { id, time: { created: 1, updated: 1 } }, messages: [], running: false, children: [{ id: "ses_child", parentID: id, time: { created: 1, updated: 1 } }], active: new Set(["ses_child"]) },
  );
  session.attached();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const completed = result(true, [id, "ses_child"]);
  for (const execution of completed.executions!) execution.outcome = "succeeded";
  assert.equal(session.serverStopped(completed), true);
  assert.ok(!events.some((event) => event.type === "notice" || event.type === "turn.end"));
  completed.executions![1].outcome = "interrupted";
  assert.equal(session.serverStopped(completed), true);
  assert.ok(events.some((event) => event.type === "notice" && /OpenCode subagent work stopped because the host/.test(event.text)));
  assert.ok(!events.some((event) => event.type === "notice" && /This turn stopped/.test(event.text)));
  await session.close();
});

test("a settled root beyond the execution limit has an unconfirmed outcome, never an inferred interruption", async (t) => {
  const r = rig(t);
  const events: ProviderEvent[] = [];
  const api = { pendingPermissions: async () => [], forms: async () => [] } as unknown as OpenCodeApi;
  const session = new OpenCodeSession(
    { id, cwd: "/tmp", settings: { model: "p/m", provider: "p", reasoningEffort: "" } },
    { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "" }) },
    { api: async () => api, bind() {}, forget() {}, contextOf() {}, levelsOf() {} },
    { info: { id, time: { created: 1, updated: 1 } }, messages: [{ id: "user_1", type: "user", text: "Working", time: { created: 1 } }], running: true },
  );
  session.attached();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const prior = Array.from({ length: stopNoteLimits.ids }, (_, index) => `ses_prior_${index}`);
  const capped = result(true, [...prior, id]);
  capped.executions = capped.executions!.slice(0, stopNoteLimits.ids);
  assert.equal(session.serverStopped(capped), true);
  const ended = events.filter((event) => event.type === "turn.end");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].status, "error");
  assert.equal(ended[0].retryable, true);
  assert.match(ended[0].error!, /could not confirm this turn's outcome/);
  assert.ok(events.some((event) => event.type === "notice" && event.level === "warn" && /may resume/.test(event.text)));
  assert.ok(!events.some((event) => event.type === "notice" && /stopped because/.test(event.text)));
  r.notes.remember(capped);
  const note = new OpenCodeStopNotes(r.path).take(id, [], idle("succeeded"), new Set())!;
  assert.match(note.text, /could not confirm/);
  assert.doesNotMatch(note.text, /stopped because/);
  await session.close();
});

test("child settlement and unknown inventory annotate their live root without falsely ending it", async () => {
  const events: ProviderEvent[] = [];
  const api = { pendingPermissions: async () => [], forms: async () => [] } as unknown as OpenCodeApi;
  const session = new OpenCodeSession(
    { id, cwd: "/tmp", settings: { model: "p/m", provider: "p", reasoningEffort: "" } },
    { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "" }) },
    { api: async () => api, bind() {}, forget() {}, contextOf() {}, levelsOf() {} },
    { info: { id, time: { created: 1, updated: 1 } }, messages: [], running: false, children: [{ id: "ses_child", parentID: id, time: { created: 1, updated: 1 } }], active: new Set(["ses_child"]) },
  );
  session.attached();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(session.serverStopped(result(true, ["ses_child"])), true);
  assert.equal(session.serverStopped(result(false, [], [])), true);
  assert.equal(events.filter((event) => event.type === "turn.end").length, 0);
  assert.ok(events.some((event) => event.type === "notice" && event.level === "warn" && /may resume/.test(event.text)));
  await session.close();
});

test("shutdown annotation survives the real manager's close order and overlays only the gateway history", async (t) => {
  const r = rig(t);
  const fake = await FakeOpenCode.start();
  const provider = new OpenCodeProvider({
    settings: { path: "/nonexistent/opencode", mode: "own", start: false, folder: r.home, logPath: r.path.replace(".stops.json", "") },
    locate: async () => ({ ...fake.endpoint(), own: true }),
  });
  const bridge = await startTestBridge({ keepHome: true, providers: new Map([["opencode", provider]]), config: { generalFolder: r.home } });
  const phone = await TestClient.open(bridge);
  let closed = false;
  try {
    const thread = (await phone.call("session.create", { profile: "opencode", cwd: r.home })).session_id;
    fake.queueTurn(thread, "approval");
    const start = phone.frames.length;
    await phone.call("prompt.submit", { session_id: thread, text: "Wait for approval" });
    await phone.from(start, (frame) => frame.method === "approval");
    const beforeClose = JSON.parse(readFileSync(join(bridge.home, "state", "threads.json"), "utf8"));
    assert.equal(beforeClose.threads.find((entry: any) => entry.id === thread)?.inTurn, true);
    let observed = false;
    (provider as any).locator = {
      stopDeadlineMs: 16000,
      close: async () => {
        assert.equal((provider as any).sessions.size, 0, "the generic manager already closed/forgot the provider session");
        fake.active.delete(thread);
        fake.sessions.get(thread)!.messages.push(...idle());
        (provider as any).serverStopped({ serverIdentity: "owned_test", settled: [thread], unsettled: [], complete: true, executions: [{ sessionID: thread, terminalID: "idle_1", outcome: "interrupted" }] });
        observed = true;
      },
    };
    assert.equal(provider.stopDeadlineMs, 16000);
    await phone.close();
    await bridge.close();
    closed = true;
    assert.equal(observed, true);
    const state = JSON.parse(readFileSync(join(bridge.home, "state", "threads.json"), "utf8"));
    const record = state.threads.find((entry: any) => entry.id === thread);
    assert.ok(record);
    assert.notEqual(record.inTurn, true);
    assert.ok(statSync(r.path).size > 0);
    const againProvider = new OpenCodeProvider({
      settings: { path: "/nonexistent/opencode", mode: "own", start: false, folder: r.home, logPath: r.path.replace(".stops.json", "") },
      locate: async () => ({ ...fake.endpoint(), own: true }),
    });
    const again = await startTestBridge({ home: bridge.home, providers: new Map([["opencode", againProvider]]) });
    const reopened = await TestClient.open(again);
    try {
      const nativeBefore = JSON.stringify(fake.sessions.get(thread)!.messages);
      const writes = fake.calls.filter((call) => call.method !== "GET").length;
      const snapshot = await reopened.call("session.resume", { session_id: thread });
      assert.ok(snapshot.messages.some((message: any) => /^Portals: This turn stopped because/.test(message.text ?? "")));
      assert.equal(JSON.stringify(fake.sessions.get(thread)!.messages), nativeBefore, "the overlay never enters OpenCode's history");
      const admissions = fake.calls.filter((call) => call.method !== "GET").slice(writes);
      assert.equal(admissions.some((call) => /\/(message|inbox|command|compact)$/.test(call.path)), false);
    } finally {
      await reopened.close();
      await again.dispose();
    }
  } finally {
    await phone.close();
    if (!closed) await bridge.close();
    await fake.close();
    rmSync(bridge.home, { recursive: true, force: true });
  }
});

test("closing a shared-service provider creates no stop ledger and interrupts no native execution", async (t) => {
  const r = rig(t);
  const fake = await FakeOpenCode.start();
  const provider = new OpenCodeProvider({
    settings: { path: "/nonexistent/opencode", mode: "shared", start: false, folder: r.home, logPath: r.path.replace(".stops.json", "") },
    locate: async () => ({ ...fake.endpoint(), own: false }),
  });
  try {
    const settings = { model: "opencode/deepseek-v4.1-flash-free", provider: "opencode", reasoningEffort: "" };
    const thread = await provider.newThread({ cwd: r.home, settings });
    const session = await provider.startSession({ id: thread, cwd: r.home, settings }, { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "" }) });
    session.attached?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await session.close();
    await provider.close();
    assert.equal((provider as any).stopSessions.size, 0);
    assert.equal(existsSync(r.path), false);
    assert.equal(fake.calls.some((call) => call.method === "POST" && /\/interrupt$/.test(call.path)), false);
    assert.equal(provider.stopDeadlineMs, undefined);
  } finally {
    await provider.close();
    await fake.close();
  }
});

test("a pending grandchild note uses fresh nested ownership before the root history is built", async (t) => {
  const r = rig(t);
  const fake = await FakeOpenCode.start();
  const info = (id: string, parentID?: string) => ({ id, parentID, location: { directory: r.home }, time: { created: 1, updated: 1 } });
  fake.addSession(info(id), idle("succeeded", 1));
  fake.addSession(info("ses_child", id));
  fake.addSession(info("ses_grandchild", "ses_child"), restarted());
  fake.active.add("ses_grandchild");
  r.notes.remember(result(true, [], ["ses_grandchild"]));
  const provider = new OpenCodeProvider({
    settings: { path: "/nonexistent/opencode", mode: "own", start: false, folder: r.home, logPath: r.path.replace(".stops.json", "") },
    locate: async () => ({ ...fake.endpoint(), own: true }),
  });
  try {
    const session = await provider.resumeSession(
      { id, cwd: r.home, settings: { model: "opencode/deepseek-v4.1-flash-free", provider: "opencode", reasoningEffort: "" } },
      { emit() {}, ask: async () => ({ kind: "withdrawn", reason: "" }) },
    );
    assert.ok((await session.history()).some((message) => "text" in message && /1 subagent was resumed by OpenCode/.test(message.text)));
    await session.close();
  } finally {
    await provider.close();
    await fake.close();
  }
});

test("one broken thread annotation cannot prevent the other owned-stop notes", async (t) => {
  const r = rig(t);
  const provider = new OpenCodeProvider({
    settings: { path: "/nonexistent/opencode", mode: "own", start: false, folder: r.home, logPath: r.path.replace(".stops.json", "") },
    locate: async () => { throw new Error("not used"); },
  });
  let told = false;
  (provider as any).stopSessions.set(id, { id, serverStopped() { throw new Error("one bad sink"); } });
  (provider as any).stopSessions.set("ses_good", { id: "ses_good", serverStopped() { told = true; return true; } });
  (provider as any).serverStopped(result(true, [id, "ses_good"]));
  assert.equal(told, true);
  assert.match(new OpenCodeStopNotes(r.path).take(id, [], idle(), new Set())!.text, /stopped because/);
  assert.equal(new OpenCodeStopNotes(r.path).take("ses_good", [], idle(), new Set()), undefined);
  await provider.close();
});

test("restart attribution requires the recorded aborted assistant's adjacent native notice, not activity or text", () => {
  const execution = { sessionID: id, openerID: "user_1", assistantID: "assistant_1" };
  assert.equal(restartsExecution(restarted(), execution), true);
  assert.equal(restartsExecution(restarted(), { ...execution, assistantID: "unrelated" }), false);
  assert.equal(restartsExecution(restarted(), { ...execution, openerID: "missing" }), false);
  for (const boundary of [
    { id: "manual", type: "user", text: "Separate task", time: { created: 4 } },
    ...idle(),
    { id: "command", type: "synthetic", text: "Separate command", time: { created: 4 } },
  ] as Message[]) {
    const beforeNotice = restarted();
    beforeNotice.splice(2, 0, boundary);
    assert.equal(restartsExecution(beforeNotice, execution), false);
    assert.equal(restartsExecution([...restarted(), boundary], execution), false);
  }
  const lookalike = restarted();
  (lookalike[2] as Extract<Message, { type: "synthetic" }>).metadata = {};
  assert.equal(restartsExecution(lookalike, execution), false);
  const notAborted = restarted();
  delete (notAborted[1] as Extract<Message, { type: "assistant" }>).error;
  assert.equal(restartsExecution(notAborted, execution), false);
  const repeated = [...restarted(), { ...restarted()[1], id: "assistant_retry" }, { ...restarted()[2], id: "restart_again" }];
  assert.equal(restartsExecution(repeated, execution), true);
});

test("legacy notes and the same active opener without a restart reference only warn", (t) => {
  for (const legacy of [true, false]) {
    const r = rig(t);
    const stopped = result(false, [], [id]);
    if (legacy) delete (stopped as Partial<typeof stopped>).executions;
    r.notes.remember(stopped);
    const note = r.notes.take(id, [], [...restarted().slice(0, 2), ...idle()], new Set([id]))!;
    assert.match(note.text, /may resume/);
    assert.doesNotMatch(note.text, /resumed this turn|This turn stopped because/);
    assert.equal(new OpenCodeStopNotes(r.path).take(id, [], restarted(), new Set([id])), undefined);
  }
});

test("a different interrupted terminal cannot replace the recorded shutdown terminal", (t) => {
  const r = rig(t);
  r.notes.remember(result());
  const messages = [...restarted().slice(0, 2), { ...idle()[0], id: "different_idle" }];
  const note = r.notes.take(id, [], messages, new Set())!;
  assert.match(note.text, /may resume/);
  assert.doesNotMatch(note.text, /This turn stopped because/);
});

test("provenance is bounded, ID-validated and whitelisted without retaining native content", (t) => {
  const r = rig(t);
  const executions = Array.from({ length: stopNoteLimits.ids + 2 }, (_, i) => ({
    sessionID: `ses_${i}`, openerID: `msg_${i}`, assistantID: "assistant_1", terminalID: "idle_1",
    text: "never persist native text", metadata: { secret: "never persist metadata" },
  }));
  executions[0].openerID = "界".repeat(54);
  r.notes.remember({ ...result(), executions });
  const saved = readFileSync(r.path, "utf8");
  const entries = JSON.parse(saved).records[0].executions;
  assert.equal(entries.length, stopNoteLimits.ids - 1);
  assert.ok(entries.every((entry: any) => Object.keys(entry).every((key) => ["sessionID", "openerID", "assistantID", "terminalID"].includes(key))));
  assert.doesNotMatch(saved, /never persist|secret/);
  assert.equal(new OpenCodeStopNotes(r.path).executionSessions(new Set(executions.map((entry) => entry.sessionID))).length, stopNoteLimits.ids - 1);
});

test("a root's exact settled note retains a warning about uncertain child work", (t) => {
  const r = rig(t);
  r.notes.remember(result(false, [id], ["ses_child"]));
  const note = r.notes.take(id, ["ses_child"], idle(), new Set())!;
  assert.match(note.text, /This turn stopped because/);
  assert.match(note.text, /1 subagent may resume/);
  assert.equal(note.afterMessageID, "idle_1");
});

test("mixed child and grandchild outcomes get one short summary independent of the root terminal", (t) => {
  const r = rig(t);
  const descendants = ["ses_a", "ses_b", "ses_c", "ses_d"];
  r.notes.remember(result(false, [id, ...descendants.slice(0, 2)], descendants.slice(2)));
  const histories = new Map<string, readonly Message[]>([
    ["ses_a", idle()], ["ses_b", idle()], ["ses_c", restarted()], ["ses_d", []],
  ]);
  const note = r.notes.take(id, descendants, idle(), new Set(["ses_c"]), 0, true, histories)!;
  assert.deepEqual(note.text.split("\n"), [
    "Portals: This turn stopped because the host shut down its OpenCode server.",
    "2 subagents stopped; 1 was resumed by OpenCode; 1 may resume.",
  ]);
  assert.equal(note.afterMessageID, "idle_1");
  assert.equal(new OpenCodeStopNotes(r.path).take(id, descendants, idle(), new Set(["ses_c"]), 0, true, histories), undefined);
});

test("completed child work gets no unconfirmed warning while another descendant's stop stays visible", (t) => {
  const r = rig(t);
  r.notes.remember(result(true, [id, "ses_done", "ses_stopped"]));
  const histories = new Map<string, readonly Message[]>([["ses_done", idle("succeeded")], ["ses_stopped", idle()]]);
  const note = r.notes.take(id, ["ses_done", "ses_stopped"], idle("succeeded"), new Set(), 0, true, histories)!;
  assert.equal(note.text, "Portals: 1 subagent stopped.");
  assert.equal(note.afterMessageID, "idle_1");
});
