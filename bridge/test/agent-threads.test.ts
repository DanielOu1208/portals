import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathsFor } from "../src/config.ts";
import { allowRefused, movedFromPlan, workingMode } from "../src/fleet/fleet.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { Provider, ProviderSession, SessionOptions, SessionSink, ThreadMode } from "../src/providers/types.ts";
import { createThread, isEvent, startTestBridge, temporaryHome, TestClient, type Frame, type RpcFailure, type TestBridge } from "./helpers.ts";

// Threads an agent started through the fleet (feature agent_threads, docs/gateway-protocol.md
// section 11): shared into the sidebar on every device with a mark, and answered by the
// thread that started them, as a device answers: never always, and an allow only from a
// thread that has the access it gives.

const unknown = (error: RpcFailure) => error.code === 4007;
const refused = (words: RegExp) => (error: RpcFailure) => error.code === -32602 && words.test(error.message);

/**
 * The scripted agent with modes; `default` comes to ask, as Claude Code's own settings
 * may, or to what it is given. In plan mode an approval is a plan to approve whose work
 * starts in `default`, as Claude Code's is after planning from its default mode.
 */
class ModeFake extends FakeProvider {
  readonly supportsModes = true;
  readonly defaultsTo: WorkingMode;

  constructor(directory: string, defaultsTo: WorkingMode = "ask") {
    super({ directory, delayMs: 3 });
    this.defaultsTo = defaultsTo;
  }

  override async startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    return withModes(options, sink, this.defaultsTo, (planning) => super.startSession(options, planning));
  }

  override async resumeSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    return withModes(options, sink, this.defaultsTo, (planning) => super.resumeSession(options, planning));
  }
}

type WorkingMode = Exclude<ThreadMode, "default">;

async function withModes(
  options: SessionOptions, sink: SessionSink, defaultsTo: WorkingMode, start: (sink: SessionSink) => Promise<ProviderSession>,
): Promise<ProviderSession> {
  let mode: ThreadMode = options.mode ?? "default";
  const planning: SessionSink = {
    emit: (event) => sink.emit(event),
    ask: (request, signal) => sink.ask(mode === "plan" && request.kind === "approval" ? { ...request, plan: { startsIn: "default" } } : request, signal),
  };
  return Object.assign(await start(planning), {
    mode: () => ({ mode, defaultsTo }),
    setMode: async (next: ThreadMode) => {
      mode = next;
    },
  });
}

interface Setup {
  bridge: TestBridge;
  /** The device that made the parent thread and follows it. */
  owner: TestClient;
  /** A device that has the started thread open, as the app does once it is opened. */
  watcher: TestClient;
  /** The thread the others are started from. */
  parent: string;
}

async function setUp(t: TestContext, defaultsTo?: WorkingMode): Promise<Setup> {
  const data = temporaryHome();
  const bridge = await startTestBridge({ providers: new Map<string, Provider>([["fake", new ModeFake(join(data, "fake"), defaultsTo)]]) });
  const owner = await TestClient.open(bridge);
  const watcher = await TestClient.open(bridge);
  t.after(async () => {
    await Promise.all([owner.close(), watcher.close()]);
    await bridge.dispose();
    rmSync(data, { recursive: true, force: true });
  });
  return { bridge, owner, watcher, parent: await createThread(owner) };
}

/** A thread started from `parent` with `text`, blocked on its first question, which `watcher` follows. */
async function blocked(setup: Setup, text: string): Promise<{ child: string; request: Frame }> {
  const started = await setup.owner.call("thread.start", { profile: "fake", from: setup.parent, text, wait: true, timeout_ms: 5000 });
  assert.equal(started.state, "blocked");
  await setup.watcher.call("session.resume", { session_id: started.thread.id, profile: "fake" });
  return { child: started.thread.id, request: started.open_requests[0] };
}

/** The `request.cancel` `client` was sent for `request` of `thread`. */
function cancelOf(client: TestClient, thread: string, request: string): Promise<Frame> {
  return client.find((frame) => isEvent(frame, "request.cancel", thread) && frame.params.payload.id === request).then((frame) => frame.params.payload);
}

function setMode(setup: Setup, mode: ThreadMode): Promise<Frame> {
  return setup.owner.call("session.set_mode", { session_id: setup.parent, mode, profile: "fake" });
}

test("gateway.ready lists agent_threads", async (t) => {
  const { owner } = await setUp(t);
  assert.ok(owner.readyPayload.bridge.features.includes("agent_threads"));
});

test("a thread an agent started is shared on every device and taken back with thread.mark, kept on disk; who started it is listed without its origin", async (t) => {
  const setup = await setUp(t);
  const { owner, watcher, parent, bridge } = setup;
  const child = (await owner.call("thread.start", { profile: "fake", from: parent })).thread.id as string;
  const first = await watcher.call("threads.changes");
  const listed = first.threads.find((entry: Frame) => entry.id === child);
  // Who, as facts too (feature senders): a thread of this Mac, so no Mac.
  assert.deepEqual(listed.started_by, { name: "Fake agent", thread: parent, from: { agent: "fake", agent_name: "Fake agent", thread: parent } });
  assert.equal(listed.shared, undefined);

  const shared = await watcher.call("thread.mark", { thread: child, shared: true });
  assert.equal(shared.thread.shared, true);
  const delta = await owner.call("threads.changes", { list: first.list.id, since: first.list.revision });
  assert.deepEqual(delta.threads.map((entry: Frame) => [entry.id, entry.shared]), [[child, true]]);
  assert.equal(JSON.parse(readFileSync(pathsFor(bridge.home).threads, "utf8")).threads.find((record: Frame) => record.id === child).shared, true);

  // Back under the thread that started it: the mark is gone, on disk too.
  const taken = await owner.call("thread.mark", { thread: child, shared: false });
  assert.equal(taken.thread.shared, undefined);
  const after = await watcher.call("threads.changes", { list: delta.list.id, since: delta.list.revision });
  assert.deepEqual(after.threads.map((entry: Frame) => [entry.id, entry.shared]), [[child, undefined]]);
  assert.equal(JSON.parse(readFileSync(pathsFor(bridge.home).threads, "utf8")).threads.find((record: Frame) => record.id === child).shared, undefined);
  await assert.rejects(owner.call("thread.mark", { thread: child }), refused(/pinned, archived, unseen, shared, recent or preview/));
  await assert.rejects(owner.call("thread.mark", { thread: child, shared: "yes" }), refused(/shared must be a boolean/));
});

test("only the thread that started a thread answers its approval: once, for the session or no, never always, and an allow only from a thread in full access", async (t) => {
  const setup = await setUp(t);
  const { owner, watcher, parent } = setup;
  const { child, request } = await blocked(setup, "approve please");
  assert.equal(request.method, "approval");
  const answer = (params: Record<string, unknown>) => owner.call("thread.answer", { thread: child, request: request.id, ...params });

  const another = await createThread(owner);
  await assert.rejects(answer({ choice: "deny" }), refused(/^Only the thread that started thread .* can answer its questions\. Tell the user it is blocked/));
  await assert.rejects(answer({ choice: "deny", from: another }), refused(/^Only the thread that started/));
  await assert.rejects(answer({ choice: "always", from: parent }), refused(/^An agent cannot allow always/));
  await assert.rejects(answer({ choice: "maybe", from: parent }), refused(/^Answer an approval with a choice: once, session or deny\.$/));
  await assert.rejects(answer({ answers: { q0: "yes" }, from: parent }), refused(/^This is an approval/));
  await assert.rejects(answer({ choice: "once", note: "Use printf", from: parent }), refused(/^A note goes only with deny/));
  // Its own thread follows the agent's settings, which come to ask: it cannot give more.
  await assert.rejects(answer({ choice: "once", from: parent }), refused(/needs your own thread to run in full access, and yours runs in ask mode\. Answer with deny/));
  await assert.rejects(owner.call("thread.answer", { thread: "no-such-thread", request: request.id, choice: "deny", from: parent }), unknown);
  await assert.rejects(answer({ choice: "deny", from: parent, request: "srq-000000000000" }), (error: RpcFailure) => unknown(error) && /has no open question srq-000000000000/.test(error.message));
  assert.equal((await owner.call("thread.read", { thread: child })).open_requests.length, 1);

  await setMode(setup, "full");
  assert.deepEqual(await answer({ choice: "once", from: parent }), { answered: true });
  // Every device's card closes, saying by whom and how.
  assert.deepEqual(await cancelOf(watcher, child, request.id), { id: request.id, reason: "resolved", by: "Fake agent", answer: { choice: "once" } });
  const ran = await owner.call("thread.wait", { thread: child, timeout_ms: 5000 });
  assert.equal(ran.state, "idle");
  assert.match(ran.reply, /The command ran\./);
  await assert.rejects(answer({ choice: "once", from: parent }), unknown);

  // In edits mode it may still say no, with what to do instead.
  const again = (await owner.call("thread.send", { thread: child, text: "approve this one too", from: parent, wait: true, timeout_ms: 5000 })).open_requests[0];
  await setMode(setup, "edits");
  await assert.rejects(owner.call("thread.answer", { thread: child, request: again.id, choice: "session", from: parent }), refused(/yours runs in edits mode/));
  assert.deepEqual(await owner.call("thread.answer", { thread: child, request: again.id, choice: "deny", note: "  Leave the build folder.  ", from: parent }), { answered: true });
  assert.deepEqual(await cancelOf(watcher, child, again.id), { id: again.id, reason: "resolved", by: "Fake agent", answer: { choice: "deny", note: "Leave the build folder." } });
  assert.match((await owner.call("thread.wait", { thread: child, timeout_ms: 5000 })).reply, /.+/);
  // The note follows the no as the parent's own message, never as the user's words.
  const said = (await owner.call("thread.read", { thread: child, last: 3 })).messages as { role: string; text?: string }[];
  const notes = said.filter((message) => message.role === "user" && message.text?.includes("Leave the build folder."));
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.text!, /^\[Portals: from Fake agent\b[^\]]*\]\nLeave the build folder\.$/);

  // A device's own answer closes the others' cards as before: no one named.
  await owner.call("session.resume", { session_id: child, profile: "fake" });
  const third = (await owner.call("thread.send", { thread: child, text: "approve once more", from: parent, wait: true, timeout_ms: 5000 })).open_requests[0];
  watcher.answer(third.id, { choice: "deny" });
  assert.deepEqual(await cancelOf(owner, child, third.id), { id: third.id, reason: "resolved" });
});

test("the thread that started a thread answers its questions, whatever its mode", async (t) => {
  const setup = await setUp(t);
  const { owner, watcher, parent } = setup;
  await setMode(setup, "plan");
  const { child, request } = await blocked(setup, "ask please");
  assert.equal(request.method, "clarify");
  const answer = (params: Record<string, unknown>) => owner.call("thread.answer", { thread: child, request: request.id, from: parent, ...params });

  await assert.rejects(answer({ choice: "once" }), refused(/^This is a question: answer it with answers/));
  await assert.rejects(answer({}), refused(/^Answer a question with answers/));
  await assert.rejects(answer({ answers: {} }), refused(/^Give at least one answer/));
  await assert.rejects(answer({ answers: { q0: "   " } }), refused(/^Give at least one answer/));
  await assert.rejects(answer({ answers: { q0: 5 } }), refused(/^Each answer is text/));
  await assert.rejects(answer({ answers: ["Swift"] }), refused(/answers must be an object/));

  // A qid it was not asked is left out.
  assert.deepEqual(await answer({ answers: { q0: "Swift", q9: "Rust" } }), { answered: true });
  assert.deepEqual(await cancelOf(watcher, child, request.id), { id: request.id, reason: "resolved", by: "Fake agent", answer: { answers: { q0: "Swift" } } });
  assert.match((await owner.call("thread.wait", { thread: child, timeout_ms: 5000 })).reply, /You chose Swift\./);
});

test("a plan whose work starts in default needs what default comes to, not the plan mode the thread asks from", async (t) => {
  // `default` comes to full access here: approving the plan lets the thread work in it.
  const setup = await setUp(t, "full");
  const { owner, parent } = setup;
  const child = (await owner.call("thread.start", { profile: "fake", from: parent })).thread.id as string;
  await owner.call("session.resume", { session_id: child, profile: "fake" });
  await owner.call("session.set_mode", { session_id: child, mode: "plan", profile: "fake" });
  const plan = (await owner.call("thread.send", { thread: child, text: "approve the plan", from: parent, wait: true, timeout_ms: 5000 })).open_requests[0];
  assert.equal(plan.params.plan, true);
  assert.equal(plan.params.starts_in, "default");
  const approve = () => owner.call("thread.answer", { thread: child, request: plan.id, choice: "once", from: parent });

  for (const mode of ["edits", "ask", "plan"] as const) {
    await setMode(setup, mode);
    await assert.rejects(approve(), refused(new RegExp(`^Approving this plan lets the thread work in full access, which needs your own thread to run in that or more, and yours runs in ${mode} mode\\.`)));
  }
  assert.equal((await owner.call("thread.read", { thread: child })).open_requests.length, 1);
  await setMode(setup, "full");
  assert.deepEqual(await approve(), { answered: true });
});

test("a plan whose thread was moved to another mode while it waited needs that mode: the work goes on in it", async (t) => {
  // `default` comes to ask mode here, so the plan itself needs only ask.
  const setup = await setUp(t, "ask");
  const { owner, parent } = setup;
  const child = (await owner.call("thread.start", { profile: "fake", from: parent })).thread.id as string;
  await owner.call("session.resume", { session_id: child, profile: "fake" });
  await owner.call("session.set_mode", { session_id: child, mode: "plan", profile: "fake" });
  const plan = (await owner.call("thread.send", { thread: child, text: "approve the plan", from: parent, wait: true, timeout_ms: 5000 })).open_requests[0];
  assert.equal(plan.params.starts_in, "default");
  const approve = () => owner.call("thread.answer", { thread: child, request: plan.id, choice: "once", from: parent });

  // The user gives the thread full access while its plan waits: an ask-mode starter may no longer approve it.
  await owner.call("session.set_mode", { session_id: child, mode: "full", profile: "fake" });
  await setMode(setup, "ask");
  await assert.rejects(approve(), refused(/^Approving this plan lets the thread work in full access, which needs your own thread to run in that or more, and yours runs in ask mode\./));
  assert.equal((await owner.call("thread.read", { thread: child })).open_requests.length, 1);
  await setMode(setup, "full");
  assert.deepEqual(await approve(), { answered: true });
});

test("an allow needs the caller's working mode to give what it allows: full access for a command, the mode a plan starts in for a plan", () => {
  const command = { id: "srq-1", method: "approval", params: { command: "rm -rf build", choices: ["once", "deny"] } };
  assert.equal(allowRefused(command, "full", undefined), undefined);
  for (const mode of ["edits", "ask", "plan"]) assert.match(allowRefused(command, mode, undefined)!, new RegExp(`yours runs in ${mode} mode`));
  assert.match(allowRefused(command, undefined, undefined)!, /the mode yours runs in is not known/);
  assert.match(allowRefused(command, "default", undefined)!, /not known/);
  assert.match(allowRefused(command, "sideways", undefined)!, /not known/);

  const plan = (startsIn: unknown) => ({ id: "srq-2", method: "approval", params: { command: "Plan", choices: ["once", "deny"], plan: true, starts_in: startsIn } });
  assert.equal(allowRefused(plan("edits"), "edits", undefined), undefined);
  assert.equal(allowRefused(plan("edits"), "full", undefined), undefined);
  assert.match(allowRefused(plan("edits"), "ask", undefined)!, /^Approving this plan lets the thread work in edits mode, which needs your own thread to run in that or more, and yours runs in ask mode\. Ask it to keep planning/);
  assert.equal(allowRefused(plan("ask"), "ask", undefined), undefined);
  assert.match(allowRefused(plan("ask"), "plan", undefined)!, /yours runs in plan mode/);
  // `default` is what the asking thread's agent settings come to; full access when that is not known.
  assert.equal(allowRefused(plan("default"), "ask", "ask"), undefined);
  assert.match(allowRefused(plan("default"), "edits", undefined)!, /work in full access/);
  assert.match(allowRefused(plan(undefined), "edits", undefined)!, /work in full access/);
  // Moved out of plan mode while the plan waited: the mode it is in now, when that is more.
  assert.match(allowRefused(plan("ask"), "ask", undefined, "edits")!, /work in edits mode/);
  assert.equal(allowRefused(plan("ask"), "edits", undefined, "edits"), undefined);
  assert.equal(allowRefused(plan("edits"), "edits", undefined, "ask"), undefined);
  assert.match(allowRefused(plan("default"), "ask", "ask", "full")!, /work in full access/);

  // What a thread moved out of plan mode while its plan waited works in now; full access when its default is not known.
  assert.equal(movedFromPlan(null), undefined);
  assert.equal(movedFromPlan({ mode: "plan", defaultsTo: "ask" }), undefined);
  assert.equal(movedFromPlan({ mode: "edits" }), "edits");
  assert.equal(movedFromPlan({ mode: "default", defaultsTo: "ask" }), "ask");
  assert.equal(movedFromPlan({ mode: "default" }), "full");

  assert.equal(workingMode(null), undefined);
  assert.equal(workingMode({ mode: "edits" }), "edits");
  assert.equal(workingMode({ mode: "default", defaultsTo: "full" }), "full");
  assert.equal(workingMode({ mode: "default" }), undefined);
});
