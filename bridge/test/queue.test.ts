import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathsFor } from "../src/config.ts";
import type { Provider, ProviderSession, StoredMessage } from "../src/providers/types.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import type { LoggedEvent } from "../src/sessions/eventLog.ts";
import { Registry, type ThreadRecord } from "../src/sessions/registry.ts";
import { GivenUp, Session, type Peer, type SessionListener } from "../src/sessions/session.ts";
import { failedKept } from "../src/sessions/failed.ts";
import { WaitingStore } from "../src/sessions/waiting.ts";
import { createThread, startTestBridge, TestClient, type Frame } from "./helpers.ts";

// The messages waiting for a running turn (feature queue), in the moment between one
// turn's end and the start of the turn the next of them opens: what a device that
// resumes then is shown, and what one already following is told. A session on its own,
// with an agent that only starts turns.

function session(options: { lastQueueID?: number; waiting?: WaitingStore; listener?: SessionListener; agent?: string } = {}): Session {
  const record: ThreadRecord = {
    id: "queue-thread", agent: options.agent ?? "stand-in", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone",
  };
  // Not in the registry: the session keeps its record itself.
  return new Session(record, { has: () => false } as unknown as Registry, options);
}

const agent = {
  history: async () => [],
  settings: () => ({ model: "m", provider: "p", reasoningEffort: "" }),
  startTurn: () => {},
  interrupt: async () => false,
  close: async () => {},
} as unknown as ProviderSession;

function follower(): { peer: Peer; events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  return { peer: { isOpen: true, takesRequests: false, sendRequest: () => {}, sendEvent: (event: LoggedEvent) => events.push(event) } as unknown as Peer, events };
}

const nextStep = () => new Promise((resolve) => setImmediate(resolve));

for (const provider of ["droid", "claude", "codex", "pi"]) test(`${provider}'s own turn heard before a reserved Queue turn starts goes first, without losing either turn (D7)`, async () => {
  const thread = session({ agent: provider });
  const starts: string[] = [];
  await thread.attach({ ...agent, startTurn: (prompt) => { starts.push(prompt.text); } });
  thread.submit("first").begin?.();
  thread.submit("waiting", { queue: true });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  thread.sink.emit({ type: "turn.begin", user: "", host: { kind: "hidden", text: "" } });
  thread.sink.emit({ type: "text", text: "Background work finished." });
  await nextStep();
  assert.deepEqual(starts, ["first"], "the waiting message must not replace the provider's own turn");
  assert.equal((thread.snapshot().inflight as { assistant: string }).assistant, "Background work finished.");
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.deepEqual(starts, ["first", "waiting"]);
  assert.ok(thread.messages.some((message) => message.role === "assistant" && message.text === "Background work finished."));
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await thread.close();
});

test("the message that opens the next turn stays on the list until that turn has started, for a device that resumes in between", async () => {
  const thread = session();
  await thread.attach(agent);
  thread.submit("first").begin?.();
  const waiting = thread.submit("second", { queue: true });
  thread.sink.emit({ type: "turn.end", status: "complete" });

  const resumed = thread.snapshot();
  assert.equal(resumed.running, true);
  assert.deepEqual(resumed.queued, [{ id: waiting.queueID, text: "second" }]);
  const device = follower();
  thread.follow(device.peer);
  await nextStep();
  assert.deepEqual(
    device.events.map((event) => [event.type, event.payload]),
    [["message.start", { text: "second", sender: "user", queue_id: waiting.queueID }], ["queue.changed", { queued: [], can_steer: false }]],
  );
});

test("a message sent in that moment is listed after the one about to start, which can no longer be taken off or steered", async () => {
  const thread = session();
  await thread.attach(agent);
  const device = follower();
  thread.follow(device.peer);
  thread.submit("first").begin?.();
  const opening = thread.submit("A", { queue: true });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  const from = device.events.length;
  const after = thread.submit("B", { queue: true });
  assert.equal(thread.removeQueued(opening.queueID!), false);
  assert.equal(thread.steerQueued(opening.queueID!), "gone");
  await nextStep();
  assert.deepEqual(
    device.events.slice(from).map((event) => [event.type, event.payload]),
    [
      ["queue.changed", { queued: [{ id: opening.queueID, text: "A" }, { id: after.queueID, text: "B" }], can_steer: false }],
      ["message.start", { text: "A", sender: "user", queue_id: opening.queueID }],
      ["queue.changed", { queued: [{ id: after.queueID, text: "B" }], can_steer: false }],
    ],
  );
});

test("a message waiting on the list carries the id its device gave it, so a device whose send lost its answer knows the message waits as its own", async () => {
  const thread = session();
  await thread.attach(agent);
  const device = follower();
  thread.follow(device.peer);
  thread.submit("first").begin?.();
  const from = device.events.length;
  const mine = thread.submit("mine", { queue: true, messageID: "m-7" });
  const plain = thread.submit("no id", { queue: true });
  await nextStep();
  const listed = [{ id: mine.queueID, text: "mine", message_id: "m-7" }, { id: plain.queueID, text: "no id" }];
  assert.deepEqual(device.events.slice(from).map((event) => [event.type, event.payload]).at(-1), ["queue.changed", { queued: listed, can_steer: false }]);
  // And as a device that opens the thread now is shown the list.
  assert.deepEqual(thread.snapshot().queued, listed);
});

test("a device that opens a running thread whole is told the status line the bridge holds, and none once the run is over or a new one begins", async () => {
  const thread = session();
  await thread.attach(agent);
  thread.submit("first").begin?.();
  thread.sink.emit({ type: "status", text: "Compacting the conversation…" });
  assert.equal(thread.snapshot().status_line, "Compacting the conversation…");
  // Taken down: none.
  thread.sink.emit({ type: "status", text: "" });
  assert.equal(thread.snapshot().status_line, undefined);
  thread.sink.emit({ type: "status", text: "Claude's API did not answer; trying again (attempt 2 of 10)…" });
  assert.equal(thread.snapshot().status_line, "Claude's API did not answer; trying again (attempt 2 of 10)…");
  // The run's end takes it down, though nothing else did.
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.equal(thread.snapshot().status_line, undefined);
  // One put up between runs is not the next run's.
  thread.sink.emit({ type: "status", text: "Claude's API did not answer; trying again (attempt 3 of 10)…" });
  assert.equal(thread.snapshot().status_line, undefined);
  thread.submit("second").begin?.();
  assert.equal(thread.snapshot().running, true);
  assert.equal(thread.snapshot().status_line, undefined);
});

test("a device that opens a running thread whole is not told a status line the agent's going on took down on the devices following it", async () => {
  // The app takes the line down as a reply, a thought, closed text or a tool call comes
  // (ThreadState): Pi says its retry is over only later (auto_retry_end), if at all.
  const retry = "Pi is trying again (attempt 1 of 3)…";
  const goingOn: Array<{ name: string; event: Record<string, unknown> }> = [
    { name: "text", event: { type: "text", text: "Back." } },
    { name: "reasoning", event: { type: "reasoning", text: "Hm." } },
    { name: "commentary", event: { type: "commentary", text: "Looking.", alreadyStreamed: false } },
    { name: "tool.start", event: { type: "tool.start", id: "t1", name: "terminal", args: { command: "ls" } } },
  ];
  for (const { name, event } of goingOn) {
    const thread = session();
    await thread.attach(agent);
    thread.submit("first").begin?.();
    thread.sink.emit({ type: "status", text: retry });
    assert.equal(thread.snapshot().status_line, retry, name);
    thread.sink.emit(event as never);
    assert.equal(thread.snapshot().status_line, undefined, name);
  }
  // A question asked is not the agent going on: the app shows no tool row for it. Nor
  // closed text of nothing but spaces, which the app leaves out.
  const thread = session();
  await thread.attach(agent);
  thread.submit("first").begin?.();
  thread.sink.emit({ type: "status", text: retry });
  thread.sink.emit({ type: "tool.start", id: "q1", name: "clarify", args: {} } as never);
  assert.equal(thread.snapshot().status_line, retry);
  thread.sink.emit({ type: "commentary", text: " \n\t", alreadyStreamed: false } as never);
  assert.equal(thread.snapshot().status_line, retry);
});

test("a device that opens a running thread whole is told the status line over a tool's end, whose start may have been missed, as the app keeps it over that end", async () => {
  // The app opens a turn for a tool's end whose start it missed, which is no run's start:
  // it keeps its line over it (ThreadState), as the bridge does (merge-p1).
  const line = "Reconnecting… 1/5";
  const thread = session();
  await thread.attach(agent);
  thread.submit("first").begin?.();
  thread.sink.emit({ type: "status", text: line });
  thread.sink.emit({ type: "tool.end", id: "t9", name: "terminal", args: {}, result: { output: "done", exit_code: 0 } } as never);
  assert.equal(thread.snapshot().status_line, line);
  // The run's end takes it down, here as on every device.
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.equal(thread.snapshot().status_line, undefined);
});

test("a device that opens a running thread whole is told what the agent says it is doing, as the line a device following shows, and none once it says it does nothing", async () => {
  const thread = session();
  await thread.attach(agent);
  thread.submit("first").begin?.();
  // Droid's working states are on the status line the app shows (status.update, kind working).
  thread.sink.emit({ type: "working", state: "compacting_conversation", text: "Compacting conversation" } as never);
  assert.equal(thread.snapshot().status_line, "Compacting conversation");
  thread.sink.emit({ type: "status", text: "Retrying" });
  thread.sink.emit({ type: "working", state: "idle", text: "" } as never);
  assert.equal(thread.snapshot().status_line, undefined);
  // A notice is not the line.
  thread.sink.emit({ type: "status", text: "Retrying" });
  thread.sink.emit({ type: "notice", level: "warn", text: "Slow" } as never);
  assert.equal(thread.snapshot().status_line, "Retrying");
});

test("a thread's next session numbers its messages waiting on from the last, so a device never meets an id twice", async () => {
  const thread = session({ lastQueueID: 5 });
  await thread.attach(agent);
  thread.submit("first").begin?.();
  assert.equal(thread.submit("second", { queue: true }).queueID, "6");
  assert.equal(thread.latestQueueID, 6);
});

// MARK: Across a restart

test("messages waiting when the bridge stops are sent, with their images and files, once it starts again, and only once", async () => {
  let bridge = await startTestBridge({ keepHome: true });
  const home = bridge.home;
  try {
    let client = await TestClient.open(bridge);
    const session = await createThread(client);
    assert.equal((await client.call("prompt.submit", { session_id: session, text: "slow please", profile: "fake" })).status, "streaming");
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    await client.call("image.attach_bytes", { session_id: session, content_base64: png, filename: "photo.png", profile: "fake" });
    const notes = await client.call("file.attach_bytes", { session_id: session, content_base64: Buffer.from("notes").toString("base64"), filename: "notes.txt", profile: "fake" });
    const first = await client.call("prompt.submit", { session_id: session, text: "after the restart", profile: "fake", when_busy: "queue" });
    const second = await client.call("prompt.submit", { session_id: session, text: "and then this", profile: "fake", when_busy: "queue" });
    assert.deepEqual([first, second], [{ status: "queued", queue_id: "1" }, { status: "queued", queue_id: "2" }]);
    // On disk from the moment the device is told, as a bridge that stops at once has it.
    const kept = JSON.parse(readFileSync(join(pathsFor(home).waiting, `${session}.json`), "utf8"));
    assert.deepEqual(kept.map((message: Frame) => message.id), ["1", "2"]);
    await client.close();
    await bridge.dispose();

    bridge = await startTestBridge({ home });
    client = await TestClient.open(bridge);
    const done = async () => {
      const users = (await client.call("session.resume", { session_id: session })).messages.filter((message: Frame) => message.role === "user");
      return users.length === 3 ? users : undefined;
    };
    let users: Frame[] | undefined;
    for (let tries = 0; tries < 300 && !(users = await done()); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(users?.map((message: Frame) => message.text), [
      "slow please",
      `after the restart\n\nFiles attached in Portals (saved on this Mac):\n- ${notes.path}\n@image:photo.png`,
      "and then this",
    ]);
    await client.call("session.resume", { session_id: session });
    for (let tries = 0; tries < 300 && (await client.call("sessions.activity")).sessions.length > 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const replies = (await client.call("session.resume", { session_id: session })).messages.filter((message: Frame) => message.role === "assistant").map((message: Frame) => message.text);
    assert.match(replies.at(-2), /You said: after the restart\. I got one image\. I got one file\.$/);
    assert.match(replies.at(-1), /You said: and then this\.$/);
    // Sent, and gone from the disk: a third start sends nothing again.
    assert.equal(existsSync(join(pathsFor(home).waiting, `${session}.json`)), false);
    await client.close();
  } finally {
    await bridge.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

// MARK: Kept on disk

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function store(): { waiting: WaitingStore; folder: string } {
  const root = mkdtempSync(join(tmpdir(), "portals-waiting-test-"));
  roots.push(root);
  const folder = join(root, "waiting");
  return { waiting: new WaitingStore(folder), folder };
}

/** An agent that counts the turns it is given and can say a turn began at the desk. */
function countingAgent(options: { steer?: () => Promise<boolean | "refused"> } = {}) {
  const started: string[] = [];
  const provider = {
    history: async () => [],
    settings: () => ({ model: "m", provider: "p", reasoningEffort: "" }),
    startTurn: (prompt: { text: string }) => started.push(prompt.text),
    interrupt: async () => false,
    close: async () => {},
    ...(options.steer ? { steer: options.steer } : {}),
  } as unknown as ProviderSession;
  return { provider, started };
}

test("a message about to open its turn when the bridge closes waits on disk, and no turn starts for it", async () => {
  const { waiting } = store();
  const thread = session({ waiting });
  const agent = countingAgent();
  await thread.attach(agent.provider);
  thread.submit("first").begin?.();
  thread.submit("after", { queue: true });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await thread.close();
  await nextStep();
  assert.deepEqual(agent.started, ["first"]);
  assert.deepEqual(waiting.read("queue-thread").map((message) => message.text), ["after"]);
});

test("a message the agent turns down once the bridge is closing waits on disk, in the order sent, and no turn starts for it", async () => {
  for (const two of [false, true]) {
    const { waiting } = store();
    const thread = session({ waiting });
    const refusals: ((taken: boolean) => void)[] = [];
    const agent = countingAgent({ steer: () => new Promise<boolean>((resolve) => refusals.push(resolve)) });
    await thread.attach(agent.provider);
    thread.submit("first").begin?.();
    assert.equal(thread.submit("A").status, "steered");
    if (two) assert.equal(thread.submit("B").status, "steered");
    thread.sink.emit({ type: "turn.end", status: "complete" });
    // The later one is turned down first and waits behind the earlier one, still out.
    if (two) refusals[1](false);
    await nextStep();
    await thread.close();
    // Closing the agent's side turns down what was still out.
    refusals[0](false);
    await nextStep();
    await nextStep();
    assert.deepEqual(agent.started, ["first"], two ? "two messages" : "one message");
    assert.deepEqual(waiting.read("queue-thread").map((message) => message.text), two ? ["A", "B"] : ["A"], two ? "two messages" : "one message");
  }
});

test("a message the agent surely never had, turned down once the bridge was closing, opens its turn with its words after the next start, which the agent's history does not have", async () => {
  const { waiting } = store();
  const thread = session({ waiting });
  const refusals: ((taken: boolean | "refused") => void)[] = [];
  const agent = countingAgent({ steer: () => new Promise((resolve) => refusals.push(resolve)) });
  await thread.attach(agent.provider);
  thread.submit("first").begin?.();
  assert.equal(thread.submit("follow-up").status, "steered");
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await thread.close();
  refusals[0]("refused");
  await nextStep();
  assert.deepEqual(waiting.read("queue-thread").map((message) => message.text), ["follow-up"]);

  // The next start: the agent never had it, so its history ends with the first turn.
  const again = session({ waiting });
  const next = countingAgent();
  const device = follower();
  await again.attach({ ...next.provider, history: async () => [{ role: "user", text: "first", timestamp: 1 }, { role: "assistant", text: "done", timestamp: 2 }] } as ProviderSession);
  again.follow(device.peer);
  await nextStep();
  await nextStep();
  assert.deepEqual(next.started, ["follow-up"]);
  // Its turn opens with it, on every device and in the stored copy.
  assert.deepEqual(device.events.find((event) => event.type === "message.start")?.payload, { text: "follow-up", sender: "user" });
  assert.equal((again.snapshot().inflight as { user?: string } | null)?.user, "follow-up");
  again.sink.emit({ type: "turn.end", status: "complete" });
  assert.deepEqual(again.messages.filter((message) => message.role === "user").map((message) => message.role === "user" && message.text), ["first", "follow-up"]);
});

test("a message whose steer's answer was lost as its turn ended, which the agent may have taken, still opens with nothing after the next start, so it shows once where the agent has it", async () => {
  const { waiting } = store();
  const thread = session({ waiting });
  const refusals: ((taken: boolean | "refused") => void)[] = [];
  const agent = countingAgent({ steer: () => new Promise((resolve) => refusals.push(resolve)) });
  await thread.attach(agent.provider);
  thread.submit("first").begin?.();
  assert.equal(thread.submit("follow-up").status, "steered");
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await thread.close();
  // Not known: the agent took it into the first turn, as its history shows.
  refusals[0](false);
  await nextStep();

  const again = session({ waiting });
  const next = countingAgent();
  const device = follower();
  await again.attach({ ...next.provider, history: async () => [
    { role: "user", text: "first", timestamp: 1 }, { role: "user", text: "follow-up", timestamp: 2 }, { role: "assistant", text: "done", timestamp: 3 },
  ] } as ProviderSession);
  again.follow(device.peer);
  await nextStep();
  await nextStep();
  assert.deepEqual(next.started, ["follow-up"]);
  assert.equal(device.events.find((event) => event.type === "message.start")?.payload, undefined);
  again.sink.emit({ type: "turn.end", status: "complete" });
  // Once, where the agent has it; its own turn opens with a row nobody sees.
  assert.deepEqual(again.messages.filter((message) => message.role === "user").map((message) => [message.role === "user" && message.text, message.display_kind]), [["first", undefined], ["follow-up", undefined], ["", "hidden"]]);
});

test("a message the agent never had, read back from disk, keeps its place before one said again since: a newer one turned down meanwhile goes after it", async () => {
  const { waiting } = store();
  waiting.write("queue-thread", [{ id: "4", text: "A", images: [], resent: true, refused: true }]);
  const thread = session({ waiting });
  const refusals: ((taken: boolean | "refused") => void)[] = [];
  const agent = countingAgent({ steer: () => new Promise((resolve) => refusals.push(resolve)) });
  const attached = thread.attach(agent.provider);
  // As Codex tells of a turn begun at the desk while the thread was being read.
  queueMicrotask(() => thread.sink.emit({ type: "turn.begin", user: "from the desk" }));
  await attached;
  await nextStep();
  await nextStep();
  assert.equal(thread.submit("B").status, "steered");
  // Turned down while the turn still runs, it waits behind A for that turn's end.
  refusals[0]("refused");
  await nextStep();
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await nextStep();
  await nextStep();
  assert.deepEqual(agent.started, ["A"]);
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await nextStep();
  await nextStep();
  assert.deepEqual(agent.started, ["A", "B"]);
});

test("a message waiting when its thread is loaded again waits for a turn the agent tells of just after, then has its own", async () => {
  const { waiting } = store();
  waiting.write("queue-thread", [{ id: "4", text: "kept", images: [] }]);
  const thread = session({ waiting });
  const agent = countingAgent();
  const attached = thread.attach(agent.provider);
  // As Codex tells of a turn begun at the desk while the thread was being read.
  queueMicrotask(() => thread.sink.emit({ type: "turn.begin", user: "from the desk" }));
  await attached;
  await nextStep();
  await nextStep();
  assert.deepEqual(agent.started, []);
  assert.equal(thread.isRunning, true);
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.deepEqual(agent.started, ["kept"]);
  assert.deepEqual(waiting.read("queue-thread"), []);
  assert.equal(thread.submit("next", { queue: true }).queueID, "5");
});

test("an image of a message steered in and sent back is on disk again with it", async () => {
  const { waiting } = store();
  const thread = session({ waiting });
  let refuse: (taken: boolean) => void = () => {};
  const agent = countingAgent({ steer: () => new Promise<boolean>((resolve) => (refuse = resolve)) });
  await thread.attach(agent.provider);
  thread.submit("first").begin?.();
  thread.attachImage({ filename: "photo.png", data: Buffer.from("png") });
  const queued = thread.submit("look", { queue: true });
  assert.equal(thread.steerQueued(queued.queueID!), "steered");
  assert.deepEqual(waiting.read("queue-thread"), []);
  // The agent did not take it in: it waits for a turn of its own, with its picture.
  refuse(false);
  await nextStep();
  const kept = waiting.read("queue-thread");
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].images.map((image) => image.data.toString()), ["png"]);
});

test("a list that cannot be written takes the thread's file with it, so a later start sends nothing taken off or sent already", () => {
  const { waiting, folder } = store();
  waiting.write("t", [{ id: "1", text: "a", images: [] }, { id: "2", text: "b", images: [] }]);
  // A folder where the next file is written makes the write fail.
  mkdirSync(join(folder, `t.json.${process.pid}.tmp`));
  assert.throws(() => waiting.write("t", [{ id: "2", text: "b", images: [] }]));
  assert.deepEqual(waiting.read("t"), []);
  assert.equal(existsSync(join(folder, "t.json")), false);
});

test("messages restored when a thread is loaded keep it at work, and one sent in that step waits behind them", async () => {
  const { waiting } = store();
  waiting.write("queue-thread", [{ id: "1", text: "kept", images: [] }]);
  const thread = session({ waiting });
  const agent = countingAgent();
  await thread.attach(agent.provider);
  // The step before the restored message starts: not to be taken off the list, and first in line.
  assert.equal(thread.isAtWork, true);
  assert.deepEqual(thread.submit("new"), { status: "queued", queueID: "2" });
  await nextStep();
  await nextStep();
  assert.deepEqual(agent.started, ["kept"]);
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.deepEqual(agent.started, ["kept", "new"]);
});

test("a thread being loaded for its messages waiting when the bridge closes starts nothing, and they stay on disk", async () => {
  const { waiting, folder } = store();
  const registry = new Registry(join(folder, "..", "threads.json"));
  registry.add({ id: "queue-thread", agent: "stand-in", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "", createdAt: 0, updatedAt: 0, origin: "phone" });
  waiting.write("queue-thread", [{ id: "1", text: "kept", images: [] }]);
  const agent = countingAgent();
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const provider = { profile: { name: "stand-in" }, resumeSession: async () => (await opened, agent.provider) } as unknown as Provider;
  const manager = new SessionManager({ registry, providers: new Map([["stand-in", provider]]), waiting });
  const sending = manager.sendWaiting();
  await nextStep();
  const closing = manager.close();
  open();
  await Promise.all([sending, closing]);
  await nextStep();
  await nextStep();
  assert.deepEqual(agent.started, []);
  assert.deepEqual(waiting.read("queue-thread").map((message) => message.text), ["kept"]);
});

test("a picture that cannot be deleted once its message no longer waits leaves the list written", () => {
  const { waiting, folder } = store();
  const picture = (name: string) => ({ filename: `${name}.png`, data: Buffer.from(name) });
  const b = { id: "2", text: "b", images: [picture("b")] };
  waiting.write("t", [{ id: "1", text: "a", images: [picture("a")] }, b]);
  chmodSync(join(folder, "t"), 0o500);
  try {
    waiting.write("t", [b]);
  } finally {
    chmodSync(join(folder, "t"), 0o700);
  }
  assert.deepEqual(waiting.read("t").map((message) => [message.text, message.images.map((image) => image.data.toString())]), [["b", ["b"]]]);
});

test("when the bridge closes while one thread loads, a thread already loaded opens no turn for its next message meanwhile", async () => {
  const { waiting, folder } = store();
  const registry = new Registry(join(folder, "..", "threads.json"));
  const record = (id: string, agent: string) => ({ id, agent, cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "", createdAt: 0, updatedAt: 0, origin: "phone" as const });
  registry.add(record("loaded", "quick"));
  registry.add(record("loading", "slow"));
  const quick = countingAgent();
  let sink: { emit: (event: { type: "turn.end"; status: "complete" }) => void } | undefined;
  const quickProvider = { profile: { name: "quick" }, resumeSession: async (_options: unknown, given: typeof sink) => ((sink = given), quick.provider) } as unknown as Provider;
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const slowProvider = { profile: { name: "slow" }, resumeSession: async () => (await opened, countingAgent().provider) } as unknown as Provider;
  const manager = new SessionManager({ registry, providers: new Map([["quick", quickProvider], ["slow", slowProvider]]), waiting });
  const loaded = await manager.load("loaded");
  loaded.submit("first").begin?.();
  loaded.submit("next", { queue: true });
  const loading = manager.load("loading").catch(() => undefined);
  const closing = manager.close();
  // The loaded thread's turn ends while the other still loads.
  sink!.emit({ type: "turn.end", status: "complete" });
  await nextStep();
  await nextStep();
  open();
  await Promise.all([closing, loading]);
  assert.deepEqual(quick.started, ["first"]);
  assert.deepEqual(waiting.read("loaded").map((message) => message.text), ["next"]);
});

test("a file saved for a message given up meanwhile says so, and a file attached since for the next is kept", async () => {
  const thread = session();
  const root = mkdtempSync(join(tmpdir(), "portals-given-up-"));
  roots.push(root);
  Object.assign(thread.record, { cwd: root });
  const old = thread.attachFile("old.txt", Buffer.from("old")).then(() => undefined, (error: unknown) => error);
  thread.dropAttachments();
  const fresh = await thread.attachFile("fresh.txt", Buffer.from("fresh"));
  assert.ok((await old) instanceof GivenUp);
  assert.equal(thread.hasAttachments(), true);
  assert.match(fresh, /fresh\.txt$/);
});

test("threads that finish loading as the bridge closes open no turn for their messages waiting, while another still loads", async () => {
  const { waiting, folder } = store();
  const registry = new Registry(join(folder, "..", "threads.json"));
  const gates = new Map<string, () => void>();
  const providers = new Map<string, Provider>();
  const agents = new Map<string, ReturnType<typeof countingAgent>>();
  for (const name of ["one", "two"]) {
    registry.add({ id: name, agent: name, cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "", createdAt: 0, updatedAt: 0, origin: "phone" });
    waiting.write(name, [{ id: "1", text: `waiting in ${name}`, images: [] }]);
    const agent = countingAgent();
    agents.set(name, agent);
    const opened = new Promise<void>((resolve) => gates.set(name, resolve));
    providers.set(name, { profile: { name }, resumeSession: async () => (await opened, agent.provider) } as unknown as Provider);
  }
  const manager = new SessionManager({ registry, providers, waiting });
  const loads = ["one", "two"].map((name) => manager.load(name).catch(() => undefined));
  const closing = manager.close();
  gates.get("one")!();
  await nextStep();
  await nextStep();
  await nextStep();
  assert.deepEqual(agents.get("one")!.started, []);
  gates.get("two")!();
  await Promise.all([closing, ...loads]);
  await nextStep();
  assert.deepEqual(agents.get("two")!.started, []);
  assert.deepEqual(["one", "two"].map((name) => waiting.read(name).map((message) => message.text)), [["waiting in one"], ["waiting in two"]]);
});

test("a file that fails to save for a message given up meanwhile says it was given up, and one of the message still waiting fails as itself", async () => {
  const thread = session();
  const root = mkdtempSync(join(tmpdir(), "portals-given-up-"));
  roots.push(root);
  // A file where the thread's folder should be: every save fails.
  writeFileSync(join(root, "not-a-folder"), "");
  Object.assign(thread.record, { cwd: join(root, "not-a-folder") });
  const abandoned = thread.attachFile("old.txt", Buffer.from("old")).then(() => undefined, (error: unknown) => error);
  thread.dropAttachments();
  assert.ok((await abandoned) instanceof GivenUp);
  const own = await thread.attachFile("new.txt", Buffer.from("new")).then(() => undefined, (error: unknown) => error);
  assert.ok(own instanceof Error && !(own instanceof GivenUp));
});

test("a no's note that waits for the turn to end, where the agent takes no message mid-turn, is kept on disk like any message waiting", async () => {
  const { waiting } = store();
  const thread = session({ waiting });
  const agent = countingAgent();
  await thread.attach(agent.provider);
  const asked: string[] = [];
  const device = { isOpen: true, takesRequests: true, sendRequest: (id: string) => asked.push(id), sendEvent: () => {} } as unknown as Peer;
  thread.follow(device);
  thread.submit("first").begin?.();
  const answered = thread.sink.ask({ kind: "approval", command: "rm -rf ./cache", choices: ["once", "deny"] });
  await nextStep();
  thread.requests.answer(device, asked[0], { result: { choice: "deny", note: "Clear ./tmp instead." } });
  assert.deepEqual(await answered, { kind: "approval", choice: "deny", note: "Clear ./tmp instead." });
  await nextStep();
  assert.deepEqual(thread.queuedMessages().map((message) => message.text), ["Clear ./tmp instead."]);
  assert.deepEqual(waiting.read("queue-thread").map((message) => message.text), ["Clear ./tmp instead."]);
});

test("a no's note given just as the bridge closes is on disk once the session has closed, not left for a step that may never come", async () => {
  const { waiting } = store();
  const thread = session({ waiting });
  const agent = countingAgent();
  await thread.attach(agent.provider);
  const asked: string[] = [];
  const device = { isOpen: true, takesRequests: true, sendRequest: (id: string) => asked.push(id), sendEvent: () => {} } as unknown as Peer;
  thread.follow(device);
  thread.submit("first").begin?.();
  const answered = thread.sink.ask({ kind: "approval", command: "rm -rf ./cache", choices: ["once", "deny"] });
  await nextStep();
  thread.requests.answer(device, asked[0], { result: { choice: "deny", note: "Clear ./tmp instead." } });
  await answered;
  // The bridge closes in the same step; the process may end as soon as the session has.
  thread.closeSoon();
  await thread.close();
  assert.deepEqual(waiting.read("queue-thread").map((message) => message.text), ["Clear ./tmp instead."]);
  await nextStep();
  assert.deepEqual(agent.started, ["first"]);
  assert.deepEqual(waiting.read("queue-thread").map((message) => message.text), ["Clear ./tmp instead."], "kept once");
});

test("a no's note whose answer is taken in the same step as the bridge closes is on disk once the answer has come back, not left for a step that may never come", async () => {
  const { waiting } = store();
  const thread = session({ waiting });
  const agent = countingAgent();
  await thread.attach(agent.provider);
  const asked: string[] = [];
  const device = { isOpen: true, takesRequests: true, sendRequest: (id: string) => asked.push(id), sendEvent: () => {} } as unknown as Peer;
  thread.follow(device);
  thread.submit("first").begin?.();
  const answered = thread.sink.ask({ kind: "approval", command: "rm -rf ./cache", choices: ["once", "deny"] });
  await nextStep();
  thread.requests.answer(device, asked[0], { result: { choice: "deny", note: "Clear ./tmp instead." } });
  // The bridge begins to close before the answer has come back to the agent's side.
  thread.closeSoon();
  const closed = thread.close();
  assert.deepEqual(await answered, { kind: "approval", choice: "deny", note: "Clear ./tmp instead." });
  await closed;
  // The process may end now, with no further step.
  assert.deepEqual(waiting.read("queue-thread").map((message) => message.text), ["Clear ./tmp instead."]);
  await nextStep();
  assert.deepEqual(agent.started, ["first"]);
  assert.deepEqual(waiting.read("queue-thread").map((message) => message.text), ["Clear ./tmp instead."], "kept once");
});


// MARK: An agent that cannot be reached

// A message sent at rest while the agent's side catches up after its connection dropped
// (Codex's, `catchingUp`) waits on the list, so the turns missed meanwhile are told first.
// About 15 seconds after it began to wait, while the agent cannot be reached (the
// connection is still down, or drops again before the catch-up ends: `unreachable`), its
// turn opens and fails at once, as one the agent could not start does: every device shows
// it failed, with Try again, and it is never sent later behind the user's back.

const unreachableText = "The agent is not reachable right now.";
const notSent = `${unreachableText} The message was not sent.`;

/** An agent whose side catches up after its connection dropped, and says when it cannot be reached once asked: the test says when. */
function reachingAgent(options: { steer?: () => Promise<boolean>; says?: boolean } = {}) {
  const started: string[] = [];
  let catching: { done: Promise<void>; resolve: () => void } | null = null;
  /** Each time the session asked whether the agent cannot be reached, with the answer to give. */
  const asked: { since: number; signal: AbortSignal; answer: (reason: string | undefined) => void }[] = [];
  const provider = {
    history: async () => [],
    settings: () => ({ model: "m", provider: "p", reasoningEffort: "" }),
    startTurn: (prompt: { text: string }) => started.push(prompt.text),
    interrupt: async () => false,
    close: async () => {},
    catchingUp: () => catching?.done,
    ...(options.steer ? { steer: options.steer } : {}),
    ...(options.says === false
      ? {}
      : {
          unreachable: (since: number, signal: AbortSignal) =>
            new Promise<string | undefined>((resolve) => {
              asked.push({ since, signal, answer: resolve });
              signal.addEventListener("abort", () => resolve(undefined), { once: true });
            }),
        }),
  } as unknown as ProviderSession;
  return {
    provider,
    started,
    asked,
    /** The connection drops: the agent's side catches up once it is back. */
    drop() {
      if (catching) return;
      let resolve: () => void = () => {};
      const done = new Promise<void>((settle) => (resolve = settle));
      catching = { done, resolve };
    },
    /** Back in step with the thread. */
    caughtUp() {
      const was = catching;
      catching = null;
      was?.resolve();
    },
  };
}

/**
 * `provider` with these turns stored, each with the agent's own id for it, as Codex keeps
 * them: `latest`, the latest of them the bridge has shown, and where each ends in the
 * conversation it gives.
 */
function storedTurns(provider: ProviderSession, turns: { id: string; user: string; reply: string; at: number }[], latest: () => string | null): ProviderSession {
  const history: StoredMessage[] = [];
  const ends = new Map<string, number>();
  for (const turn of turns) {
    history.push({ role: "user", text: turn.user, timestamp: turn.at }, { role: "assistant", text: turn.reply, timestamp: turn.at + 1 });
    ends.set(turn.id, history.length);
  }
  return { ...provider, history: async () => structuredClone(history), latestTurn: latest, turnEnd: (id: string) => ends.get(id) } as unknown as ProviderSession;
}

function shown(events: LoggedEvent[], from = 0): [string, unknown][] {
  return events.slice(from).map((event) => [event.type, event.payload]);
}

test("a message sent while the agent's side catches up, which then cannot be reached, fails as a turn of its own with Try again, leaves the list and the disk, and is never sent", async () => {
  const { waiting } = store();
  const ended: [string, string][] = [];
  const thread = session({ waiting, listener: { turnEnded: (_id, status, text) => ended.push([status, text]) } });
  const agent = reachingAgent();
  await thread.attach(agent.provider);
  const device = follower();
  thread.follow(device.peer);
  agent.drop();
  const before = Date.now();
  const waited = thread.submit("Check the build", { messageID: "m-1" });
  assert.equal(waited.status, "queued");
  // Asked whether the agent cannot be reached, from the moment the message began to wait.
  assert.equal(agent.asked.length, 1);
  assert.ok(agent.asked[0].since >= before && agent.asked[0].since <= Date.now());
  assert.deepEqual(waiting.read("queue-thread").map((message) => message.text), ["Check the build"]);
  const from = device.events.length;
  agent.asked[0].answer(unreachableText);
  await nextStep();
  assert.deepEqual(shown(device.events, from), [
    ["message.start", { text: "Check the build", sender: "user", message_id: "m-1", queue_id: waited.queueID }],
    ["message.complete", { status: "error", text: notSent, error_surface: { retryable: true } }],
    ["queue.changed", { queued: [], can_steer: false }],
  ]);
  assert.deepEqual(waiting.read("queue-thread"), []);
  assert.deepEqual(ended, [["error", notSent]]);
  assert.equal(thread.isAtWork, false);
  // A turn that ended, as the list shows it: no longer at work, and unseen.
  assert.equal(thread.record.inTurn, undefined);
  assert.equal(thread.record.unseen, true);
  // As a device that opens the thread now has it: the message, then why it failed.
  const resumed = thread.snapshot();
  assert.equal(resumed.queued, undefined);
  assert.deepEqual((resumed.messages as { role: string; text: string; display_kind?: string }[]).map((message) => [message.role, message.text, message.display_kind]), [
    ["user", "Check the build", undefined],
    ["assistant", notSent, "failed_turn"],
  ]);
  // Back in step: it is not sent behind the user's back.
  agent.caughtUp();
  await nextStep();
  await nextStep();
  assert.deepEqual(agent.started, []);
});

test("a message whose agent's side catches up before then goes as it would have, and the agent's side is no longer asked", async () => {
  const thread = session();
  const agent = reachingAgent();
  await thread.attach(agent.provider);
  agent.drop();
  assert.equal(thread.submit("Check the build").status, "queued");
  assert.equal(agent.asked.length, 1);
  agent.caughtUp();
  await nextStep();
  await nextStep();
  assert.deepEqual(agent.started, ["Check the build"]);
  assert.equal(agent.asked[0].signal.aborted, true);
  // A late answer changes nothing.
  agent.asked[0].answer(unreachableText);
  await nextStep();
  assert.deepEqual(agent.started, ["Check the build"]);
  assert.equal(thread.isRunning, true);
});

test("messages waiting behind one that fails fail with it, in the order sent; one said again (steered in before) waits on and goes once the agent's side has caught up", async () => {
  const refusals: ((taken: boolean) => void)[] = [];
  const thread = session();
  const agent = reachingAgent({ steer: () => new Promise<boolean>((resolve) => refusals.push(resolve)) });
  await thread.attach(agent.provider);
  const device = follower();
  thread.follow(device.peer);
  thread.submit("first").begin?.();
  assert.equal(thread.submit("A").status, "steered");
  thread.sink.emit({ type: "turn.end", status: "complete" });
  // The connection drops; the agent turns A down meanwhile: it is said again once caught up.
  agent.drop();
  refusals[0](false);
  await nextStep();
  const b = thread.submit("B");
  const c = thread.submit("C");
  assert.deepEqual([b.status, c.status], ["queued", "queued"]);
  // Asked once, for the first that waits: those behind it go, or fail, after it.
  assert.equal(agent.asked.length, 1);
  const from = device.events.length;
  agent.asked[0].answer(unreachableText);
  await nextStep();
  assert.deepEqual(shown(device.events, from), [
    ["message.start", { text: "B", sender: "user", queue_id: b.queueID }],
    ["message.complete", { status: "error", text: notSent, error_surface: { retryable: true } }],
    ["queue.changed", { queued: [{ id: c.queueID, text: "C" }], can_steer: true }],
    ["message.start", { text: "C", sender: "user", queue_id: c.queueID }],
    ["message.complete", { status: "error", text: notSent, error_surface: { retryable: true } }],
    ["queue.changed", { queued: [], can_steer: true }],
  ]);
  assert.deepEqual(agent.started, ["first"]);
  agent.caughtUp();
  await nextStep();
  await nextStep();
  assert.deepEqual(agent.started, ["first", "A"]);
});

test("a message that fails takes nothing off the subagents line: it never reached the agent", async () => {
  const thread = session();
  const agent = reachingAgent();
  await thread.attach(agent.provider);
  const device = follower();
  thread.follow(device.peer);
  thread.submit("Start a worker").begin?.();
  thread.sink.emit({ type: "subagent", subagent: { id: "worker", kind: "agent", goal: "Look", status: "completed", startedAt: 1000, endedAt: 2000, background: true, stoppable: false } });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  agent.drop();
  thread.submit("And then?");
  agent.asked[0].answer(unreachableText);
  await nextStep();
  assert.ok(device.events.some((event) => event.type === "message.complete" && event.payload?.status === "error"));
  assert.equal(device.events.some((event) => event.type === "subagent.cleared"), false);
  assert.deepEqual(thread.subagentList().map((entry) => entry.subagent_id), ["worker"]);
  assert.equal(thread.record.subagentsCleared, undefined);
  // Nor is it a turn of the agent's: one heard of later is of the last turn, beside the worker, as the app keeps the line by turns.
  thread.sink.emit({ type: "subagent", subagent: { id: "helper", kind: "agent", goal: "Help", status: "running", startedAt: 3000, background: true, stoppable: false, parent: "worker" } });
  assert.deepEqual(thread.subagentList().map((entry) => [entry.subagent_id, entry.turn]), [["worker", 1], ["helper", 1]]);
});

test("a message waiting behind a running turn is not asked about while the turn runs; once the turn ends with the agent's side still catching up, its wait starts then", async () => {
  const thread = session();
  const agent = reachingAgent();
  await thread.attach(agent.provider);
  thread.submit("first").begin?.();
  agent.drop();
  assert.equal(thread.submit("next", { queue: true }).status, "queued");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(agent.asked.length, 0);
  const ended = Date.now();
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.equal(agent.asked.length, 1);
  assert.ok(agent.asked[0].since >= ended);
  agent.caughtUp();
  await nextStep();
  await nextStep();
  assert.deepEqual(agent.started, ["first", "next"]);
});

test("a message taken off the list leaves the next to wait its own time", async () => {
  const thread = session();
  const agent = reachingAgent();
  await thread.attach(agent.provider);
  agent.drop();
  const a = thread.submit("A");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const sentB = Date.now();
  thread.submit("B");
  assert.equal(agent.asked.length, 1);
  assert.equal(thread.removeQueued(a.queueID!), true);
  assert.equal(agent.asked[0].signal.aborted, true);
  assert.equal(agent.asked.length, 2);
  assert.ok(agent.asked[1].since >= sentB);
  // The first answer, come late, fails nothing.
  agent.asked[0].answer(unreachableText);
  await nextStep();
  assert.deepEqual(thread.queuedMessages().map((message) => message.text), ["B"]);
});

test("a message waiting when the bridge closes does not fail: it waits on disk for the next start", async () => {
  const { waiting } = store();
  const thread = session({ waiting });
  const agent = reachingAgent();
  await thread.attach(agent.provider);
  const device = follower();
  thread.follow(device.peer);
  agent.drop();
  thread.submit("kept");
  thread.closeSoon();
  assert.equal(agent.asked[0].signal.aborted, true);
  agent.asked[0].answer(unreachableText);
  await nextStep();
  assert.equal(device.events.some((event) => event.type === "message.start"), false);
  assert.deepEqual(waiting.read("queue-thread").map((message) => message.text), ["kept"]);
});

test("an agent that cannot say whether it can be reached leaves a message waiting for its catch-up as before", async () => {
  const thread = session();
  const agent = reachingAgent({ says: false });
  await thread.attach(agent.provider);
  agent.drop();
  assert.equal(thread.submit("kept").status, "queued");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(thread.queuedMessages().map((message) => message.text), ["kept"]);
  agent.caughtUp();
  await nextStep();
  await nextStep();
  assert.deepEqual(agent.started, ["kept"]);
});

test("a message that waited behind a turn told as the agent's side caught up waits its own time again when that turn ends in a later drop", async () => {
  const thread = session();
  const agent = reachingAgent();
  await thread.attach(agent.provider);
  agent.drop();
  thread.submit("next");
  const first = agent.asked[0];
  // A turn missed at the desk, still running, is told as the agent's side catches up.
  thread.sink.emit({ type: "turn.begin", user: "typed at the desk" });
  agent.caughtUp();
  await nextStep();
  assert.equal(first.signal.aborted, true);
  // Down again, and the desk's turn ends a while later.
  agent.drop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const ended = Date.now();
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.equal(agent.asked.length, 2);
  assert.ok(agent.asked[1].since >= ended);
});

test("a message's wait starts again when a turn begins while the agent's side still catches up, and is timed from that turn's end", async () => {
  const thread = session();
  const agent = reachingAgent();
  await thread.attach(agent.provider);
  agent.drop();
  thread.submit("next");
  const first = agent.asked[0];
  // A turn missed at the desk is told while the agent's side still catches up (a read
  // that failed as the connection dropped again let it go): the message waits behind it.
  thread.sink.emit({ type: "turn.begin", user: "typed at the desk" });
  assert.equal(first.signal.aborted, true);
  // Its answer, come while that turn runs, fails nothing.
  first.answer(unreachableText);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const ended = Date.now();
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.equal(agent.asked.length, 2);
  assert.ok(agent.asked[1].since >= ended);
  assert.deepEqual(thread.queuedMessages().map((message) => message.text), ["next"]);
});

test("a message that failed is kept on disk as failed, in the thread's file of messages waiting, in the one write that takes it off the list there: a thread loaded again (after a restart) shows it failed in its place, and does not send it", async () => {
  const { waiting, folder } = store();
  const before = [
    { role: "user" as const, text: "Previous turn", timestamp: 1 },
    { role: "assistant" as const, text: "Previous reply", timestamp: 2 },
  ];
  const thread = session({ waiting });
  const agent = reachingAgent();
  await thread.attach({ ...agent.provider, history: async () => structuredClone(before) } as ProviderSession);
  agent.drop();
  thread.submit("Important text while away");
  thread.submit("And this");
  agent.asked[0].answer(unreachableText);
  await nextStep();
  assert.deepEqual(waiting.read("queue-thread"), []);
  assert.deepEqual(waiting.readFailed("queue-thread").map((message) => [message.text, message.error]), [
    ["Important text while away", notSent],
    ["And this", notSent],
  ]);
  const at = waiting.readFailed("queue-thread")[0].at;
  assert.ok(Math.abs(at - Date.now() / 1000) < 5);
  // A bridge from before this skips them: entries with no id or text of their own.
  const raw = JSON.parse(readFileSync(join(folder, "queue-thread.json"), "utf8")) as Record<string, unknown>[];
  assert.equal(raw.filter((entry) => typeof entry.id === "string" && typeof entry.text === "string").length, 0);
  // Nor does the bridge load the thread at its start for them: nothing waits.
  assert.deepEqual(waiting.threads(), []);
  await thread.close();

  // Loaded again: the agent's history never had them, and has a turn from after them.
  const after = [...before, { role: "user" as const, text: "Later", timestamp: Math.floor(at) + 60 }, { role: "assistant" as const, text: "Later reply", timestamp: Math.floor(at) + 61 }];
  const again = session({ waiting });
  const fresh = reachingAgent();
  await again.attach({ ...fresh.provider, history: async () => structuredClone(after) } as ProviderSession);
  await nextStep();
  await nextStep();
  assert.deepEqual(fresh.started, []);
  assert.deepEqual(again.messages.map((message) => [message.role, message.role === "user" || message.role === "assistant" ? message.text : "", "display_kind" in message ? message.display_kind : undefined]), [
    ["user", "Previous turn", undefined],
    ["assistant", "Previous reply", undefined],
    ["user", "Important text while away", undefined],
    ["assistant", notSent, "failed_turn"],
    ["user", "And this", undefined],
    ["assistant", notSent, "failed_turn"],
    ["user", "Later", undefined],
    ["assistant", "Later reply", undefined],
  ]);
  // A message sent then waits beside them, and they stay.
  again.submit("first");
  again.submit("next", { queue: true });
  assert.deepEqual(waiting.read("queue-thread").map((message) => message.text), ["next"]);
  assert.equal(waiting.readFailed("queue-thread").length, 2);
});

test("a thread keeps its latest failed messages only, however many fail at once", async () => {
  const { waiting } = store();
  const thread = session({ waiting });
  const agent = reachingAgent();
  await thread.attach(agent.provider);
  agent.drop();
  for (let index = 1; index <= failedKept + 5; index += 1) thread.submit(`message ${index}`);
  agent.asked[0].answer(unreachableText);
  await nextStep();
  const kept = waiting.readFailed("queue-thread");
  assert.equal(kept.length, failedKept);
  assert.deepEqual([kept[0].text, kept.at(-1)?.text], ["message 6", `message ${failedKept + 5}`]);
  assert.deepEqual(waiting.read("queue-thread"), []);
});

test("a retry begun in the same second as the failure it retries stays after it when the thread is loaded again (the agent's turns are timed in whole seconds)", async () => {
  const { waiting } = store();
  const second = Math.floor(Date.now() / 1000);
  waiting.write("queue-thread", [], [{ text: "Try me", error: notSent, at: second + 0.2 }]);
  const history = [
    { role: "user" as const, text: "Previous turn", timestamp: second - 30 },
    { role: "assistant" as const, text: "Previous reply", timestamp: second - 29 },
    { role: "user" as const, text: "Try me", timestamp: second },
    { role: "assistant" as const, text: "Done.", timestamp: second + 3 },
  ];
  const thread = session({ waiting });
  await thread.attach({ ...reachingAgent().provider, history: async () => structuredClone(history) } as ProviderSession);
  assert.deepEqual(thread.messages.map((message) => message.role === "user" || message.role === "assistant" ? message.text : ""), ["Previous turn", "Previous reply", "Try me", notSent, "Try me", "Done."]);
});

test("a no's note that opens a turn while a message waits for the agent's side to catch up makes it wait afresh from that turn's end", async () => {
  const thread = session();
  const agent = reachingAgent();
  await thread.attach(agent.provider);
  const asked: string[] = [];
  const device = { isOpen: true, takesRequests: true, sendRequest: (id: string) => asked.push(id), sendEvent: () => {} } as unknown as Peer;
  thread.follow(device);
  agent.drop();
  thread.submit("next");
  const first = agent.asked[0];
  // A sub-agent asks with no turn running; the no's note opens a turn of its own.
  const answered = thread.sink.ask({ kind: "approval", command: "rm -rf ./cache", choices: ["once", "deny"], subagent: "worker" });
  await nextStep();
  thread.requests.answer(device, asked[0], { result: { choice: "deny", note: "Clear ./tmp instead." } });
  await answered;
  await nextStep();
  assert.deepEqual(agent.started, ["Clear ./tmp instead."]);
  assert.equal(first.signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const ended = Date.now();
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.equal(agent.asked.length, 2);
  assert.ok(agent.asked[1].since >= ended);
});

test("a message whose failure cannot be written to disk does not fail: it waits on, as before", async () => {
  const { waiting, folder } = store();
  const thread = session({ waiting });
  const agent = reachingAgent();
  await thread.attach(agent.provider);
  const device = follower();
  thread.follow(device.peer);
  agent.drop();
  thread.submit("Keep me");
  // A folder where the next file is written makes the write fail.
  mkdirSync(join(folder, `queue-thread.json.${process.pid}.tmp`));
  agent.asked[0].answer(unreachableText);
  await nextStep();
  assert.equal(device.events.some((event) => event.type === "message.complete"), false);
  assert.deepEqual(thread.queuedMessages().map((message) => message.text), ["Keep me"]);
  rmSync(join(folder, `queue-thread.json.${process.pid}.tmp`), { recursive: true });
  agent.caughtUp();
  await nextStep();
  await nextStep();
  assert.deepEqual(agent.started, ["Keep me"]);
});

test("a failed message kept on disk goes before a turn the agent still runs when the thread is loaded again, which stays the last", async () => {
  const { waiting } = store();
  const at = Date.now() / 1000;
  waiting.write("queue-thread", [], [{ text: "Failed while away", error: notSent, at }]);
  // Begun at the desk before the message failed, and running still.
  const history = [
    { role: "user" as const, text: "Previous turn", timestamp: 1 },
    { role: "assistant" as const, text: "Previous reply", timestamp: 2 },
    { role: "user" as const, text: "Typed at the desk", timestamp: at - 10 },
  ];
  const thread = session({ waiting });
  const agent = reachingAgent();
  await thread.attach({ ...agent.provider, history: async () => structuredClone(history), attached: () => ({ user: "Typed at the desk" }) } as ProviderSession);
  assert.deepEqual(thread.messages.map((message) => [message.role, message.role === "user" || message.role === "assistant" ? message.text : ""]), [
    ["user", "Previous turn"],
    ["assistant", "Previous reply"],
    ["user", "Failed while away"],
    ["assistant", notSent],
    ["user", "Typed at the desk"],
  ]);
  assert.equal((thread.snapshot().inflight as { user: string }).user, "Typed at the desk");
  // What the running turn says goes with it.
  thread.sink.emit({ type: "text", text: "Done at the desk." });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.deepEqual(thread.messages.slice(-2).map((message) => message.role === "user" || message.role === "assistant" ? message.text : ""), ["Typed at the desk", "Done at the desk."]);
});

test("pictures that cannot be cleared once messages fail do not undo their failure, written already", async () => {
  const { waiting, folder } = store();
  const thread = session({ waiting });
  const agent = reachingAgent();
  await thread.attach(agent.provider);
  const device = follower();
  thread.follow(device.peer);
  agent.drop();
  thread.attachImage({ filename: "photo.png", data: Buffer.from("png") });
  thread.submit("Look");
  const pictures = join(folder, "queue-thread");
  assert.ok(existsSync(pictures));
  // Its pictures' folder can no longer be emptied.
  chmodSync(pictures, 0o500);
  try {
    agent.asked[0].answer(unreachableText);
    await nextStep();
    assert.ok(device.events.some((event) => event.type === "message.complete" && event.payload?.status === "error"));
    assert.deepEqual(waiting.read("queue-thread"), []);
    assert.deepEqual(waiting.readFailed("queue-thread").map((message) => message.text), ["Look\n@image:photo.png"]);
  } finally {
    chmodSync(pictures, 0o700);
  }
});

test("a failed message comes back where it showed: after the agent's turn shown before it, before a turn missed at the desk and told after it, in the order they failed", async () => {
  const { waiting } = store();
  const thread = session({ waiting });
  const agent = reachingAgent();
  const base = Math.floor(Date.now() / 1000) - 60;
  let latest: string | null = "earlier";
  await thread.attach(storedTurns(agent.provider, [{ id: "earlier", user: "Earlier", reply: "Earlier reply", at: base }], () => latest));
  agent.drop();
  thread.submit("Sent while away");
  thread.submit("And this");
  agent.asked[0].answer(unreachableText);
  await nextStep();
  // Typed at the desk before they failed, told only once the bridge was back.
  thread.sink.emit({ type: "turn.begin", user: "Typed at the desk" });
  latest = "desk";
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await thread.close();
  const turns = [
    { id: "earlier", user: "Earlier", reply: "Earlier reply", at: base },
    { id: "desk", user: "Typed at the desk", reply: "Done at the desk.", at: base + 30 },
  ];
  const again = session({ waiting });
  await again.attach(storedTurns(reachingAgent().provider, turns, () => "desk"));
  assert.deepEqual(again.messages.map((message) => (message.role === "user" || message.role === "assistant" ? message.text : "")), [
    "Earlier",
    "Earlier reply",
    "Sent while away",
    notSent,
    "And this",
    notSent,
    "Typed at the desk",
    "Done at the desk.",
  ]);
});

test("a failed message goes back after the very turn it showed after, by the agent's id for it, also when a turn missed at the desk and told after it began with the same words just after", async () => {
  const { waiting } = store();
  const thread = session({ waiting });
  const agent = reachingAgent();
  const base = Math.floor(Date.now() / 1000) - 60;
  let latest: string | null = "known";
  await thread.attach(storedTurns(agent.provider, [{ id: "known", user: "Continue", reply: "Earlier reply", at: base }], () => latest));
  agent.drop();
  thread.submit("Review this receipt");
  agent.asked[0].answer(unreachableText);
  await nextStep();
  agent.caughtUp();
  await nextStep();
  thread.sink.emit({ type: "turn.begin", user: "Continue" });
  latest = "desk";
  thread.sink.emit({ type: "text", text: "Desktop reply" });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  const shown = thread.messages.map((message) => (message.role === "user" || message.role === "assistant" ? message.text : ""));
  await thread.close();
  const again = session({ waiting });
  const turns = [
    { id: "known", user: "Continue", reply: "Earlier reply", at: base },
    { id: "desk", user: "Continue", reply: "Desktop reply", at: base + 3 },
  ];
  await again.attach(storedTurns(reachingAgent().provider, turns, () => "desk"));
  // As every device had it: the thread's latest is still the desk's reply, not the failure.
  assert.deepEqual(again.messages.map((message) => (message.role === "user" || message.role === "assistant" ? message.text : "")), shown);
  assert.deepEqual(shown, ["Continue", "Earlier reply", "Review this receipt", notSent, "Continue", "Desktop reply"]);
});

test("failed messages beyond the latest twenty kept leave the others where they showed", async () => {
  const { waiting } = store();
  const thread = session({ waiting });
  const agent = reachingAgent();
  const base = Math.floor(Date.now() / 1000) - 60;
  let latest: string | null = "known";
  await thread.attach(storedTurns(agent.provider, [{ id: "known", user: "Known turn", reply: "Known reply", at: base }], () => latest));
  agent.drop();
  // Each fails by itself, one after another.
  for (let index = 1; index <= failedKept + 1; index += 1) {
    thread.submit(`Failure ${index}`);
    agent.asked.at(-1)!.answer(unreachableText);
    await nextStep();
  }
  assert.equal(waiting.readFailed("queue-thread").length, failedKept);
  agent.caughtUp();
  await nextStep();
  thread.sink.emit({ type: "turn.begin", user: "Missed desk turn" });
  latest = "desk";
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await thread.close();
  const again = session({ waiting });
  const turns = [
    { id: "known", user: "Known turn", reply: "Known reply", at: base },
    { id: "desk", user: "Missed desk turn", reply: "Desk reply", at: base + 5 },
  ];
  await again.attach(storedTurns(reachingAgent().provider, turns, () => "desk"));
  const users = again.messages.filter((message) => message.role === "user").map((message) => (message.role === "user" ? message.text : ""));
  assert.deepEqual(users, ["Known turn", ...Array.from({ length: failedKept }, (_, index) => `Failure ${index + 2}`), "Missed desk turn"]);
});
