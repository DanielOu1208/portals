import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderSession } from "../src/providers/types.ts";
import type { LoggedEvent } from "../src/sessions/eventLog.ts";
import type { Registry, ThreadRecord } from "../src/sessions/registry.ts";
import { Session, type Peer } from "../src/sessions/session.ts";
import { createThread, isEvent, startTestBridge, TestClient, type Frame } from "./helpers.ts";

// Every message said in a thread reaches every device that follows it (feature
// turn_messages): the turn's start carries the message that opened it, with who sent it
// and the id the device gave it, and `message.steered` one handed to the running turn.
// Before, a turn started on one device showed on another without its message until the
// thread was opened again.

function session(cwd = "/w"): Session {
  const record: ThreadRecord = {
    id: "said-thread", agent: "stand-in", cwd, title: null, model: "m", provider: "p", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone",
  };
  // Not in the registry: the session keeps its record itself.
  return new Session(record, { has: () => false } as unknown as Registry);
}

function agent(options: { steer?: () => Promise<boolean>; catchingUp?: () => Promise<void> | undefined; started?: string[] } = {}): ProviderSession {
  return {
    history: async () => [],
    settings: () => ({ model: "m", provider: "p", reasoningEffort: "" }),
    startTurn: (prompt: { text: string }) => options.started?.push(prompt.text),
    interrupt: async () => false,
    close: async () => {},
    ...(options.steer ? { steer: options.steer } : {}),
    ...(options.catchingUp ? { catchingUp: options.catchingUp } : {}),
  } as unknown as ProviderSession;
}

function follower(): { peer: Peer; events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  return { peer: { isOpen: true, takesRequests: false, sendRequest: () => {}, sendEvent: (event: LoggedEvent) => events.push(event) } as unknown as Peer, events };
}

const nextStep = () => new Promise((resolve) => setImmediate(resolve));

function said(events: LoggedEvent[]): [string, unknown][] {
  return events.filter((event) => event.type === "message.start" || event.type === "message.steered").map((event) => [event.type, event.payload]);
}

test("a turn a device's message opens carries that message, who sent it and the id the device gave it", async () => {
  const thread = session();
  await thread.attach(agent());
  const other = follower();
  thread.follow(other.peer);
  thread.submit("Fix the login", { messageID: "m-1" }).begin?.();
  assert.deepEqual(said(other.events), [["message.start", { text: "Fix the login", sender: "user", message_id: "m-1" }]]);
});

test("the snapshot's stored messages and its turn in progress keep the id the device gave each message (feature message_ids)", async () => {
  const thread = session();
  await thread.attach(agent({ steer: async () => true }));
  thread.submit("Fix the login", { messageID: "m-1" }).begin?.();
  type Snapshot = { messages: { role: string; text: string; message_id?: string; display_kind?: string }[]; inflight?: { user: string; message_id?: string } };
  let snapshot = thread.snapshot() as unknown as Snapshot;
  // A device whose send lost its answer finds its message by its id, here and in the turn in progress.
  assert.deepEqual(snapshot.messages.map(({ role, text, message_id }) => ({ role, text, message_id })), [{ role: "user", text: "Fix the login", message_id: "m-1" }]);
  assert.equal(snapshot.inflight?.message_id, "m-1");
  // Steered in, from the list and as sent; and a message sent with no id has none.
  assert.equal(thread.submit("and use tabs", { messageID: "m-2" }).status, "steered");
  const waiting = thread.submit("then this", { queue: true, messageID: "m-3" });
  assert.equal(thread.steerQueued(waiting.queueID!), "steered");
  assert.equal(thread.submit("no id").status, "steered");
  snapshot = thread.snapshot() as unknown as Snapshot;
  assert.deepEqual(snapshot.messages.filter((message) => message.role === "user").map(({ text, message_id }) => [text, message_id]), [
    ["Fix the login", "m-1"], ["and use tabs", "m-2"], ["then this", "m-3"], ["no id", undefined],
  ]);
  assert.equal(snapshot.inflight?.user, "no id");
  assert.equal(snapshot.inflight?.message_id, undefined);
  thread.sink.emit({ type: "turn.end", status: "complete" });
  // A message that waited for the next turn keeps its id when that turn opens.
  thread.submit("next", { messageID: "m-4" }).begin?.();
  snapshot = thread.snapshot() as unknown as Snapshot;
  assert.equal(snapshot.messages.at(-1)?.message_id, "m-4");
  assert.equal(snapshot.inflight?.message_id, "m-4");
});

test("a message's images and files are in the turn's start as the stored message names them", async () => {
  const folder = mkdtempSync(join(tmpdir(), "portals-said-"));
  try {
    const thread = session(folder);
    await thread.attach(agent());
    const phone = follower();
    const other = follower();
    thread.follow(phone.peer);
    thread.follow(other.peer);
    thread.attachImage({ filename: "photo.png", data: Buffer.from("png") }, phone.peer);
    const path = await thread.attachFile("notes.txt", Buffer.from("notes"), { by: phone.peer });
    thread.submit("Look at these", { by: phone.peer }).begin?.();
    assert.deepEqual(said(other.events), [
      ["message.start", { text: `Look at these\n\nFiles attached in Portals (saved on this Mac):\n- ${path}\n@image:photo.png`, sender: "user" }],
    ]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a message that waited for its turn opens it with its text, its id on the list and the device's id", async () => {
  const thread = session();
  await thread.attach(agent());
  const other = follower();
  thread.follow(other.peer);
  thread.submit("first").begin?.();
  const waiting = thread.submit("second", { queue: true, messageID: "m-2" });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.deepEqual(said(other.events), [
    ["message.start", { text: "first", sender: "user" }],
    ["message.start", { text: "second", sender: "user", message_id: "m-2", queue_id: waiting.queueID }],
  ]);
});

test("a message handed to the running turn is told to every follower; one steered from the list is named by the list", async () => {
  const thread = session();
  await thread.attach(agent({ steer: async () => true }));
  const other = follower();
  thread.follow(other.peer);
  thread.submit("first").begin?.();
  assert.equal(thread.submit("and use tabs", { messageID: "m-3" }).status, "steered");
  const waiting = thread.submit("then this", { queue: true });
  const from = other.events.length;
  assert.equal(thread.steerQueued(waiting.queueID!), "steered");
  assert.deepEqual(said(other.events), [
    ["message.start", { text: "first", sender: "user" }],
    ["message.steered", { text: "and use tabs", sender: "user", message_id: "m-3" }],
  ]);
  // "Steer now": the list says which one left it for the turn, as before.
  assert.deepEqual(other.events.slice(from).map((event) => [event.type, event.payload?.steered]), [["queue.changed", waiting.queueID]]);
});

test("a message through the fleet says it was sent through Portals, also to an app without the feature, steered or opening a turn", async () => {
  const thread = session();
  await thread.attach(agent({ steer: async () => true }));
  const other = follower();
  thread.follow(other.peer);
  const opener = "[Portals: from the command line]\nCheck the build";
  thread.submit(opener, { fleet: true }).begin?.();
  thread.submit("[Portals: from the command line]\nand the tests", { fleet: true });
  assert.deepEqual(said(other.events), [
    ["message.start", { opened_by: "portals", text: opener, sender: "portals", from: {} }],
    ["message.steered", { text: "[Portals: from the command line]\nand the tests", sender: "portals", from: {} }],
  ]);
});

test("a turn begun at the desk opens with what was typed there; one the agent began by itself, or a message said again, opens with nothing", async () => {
  let refuse: (taken: boolean) => void = () => {};
  const thread = session();
  await thread.attach(agent({ steer: () => new Promise<boolean>((resolve) => (refuse = resolve)) }));
  const other = follower();
  thread.follow(other.peer);
  thread.sink.emit({ type: "turn.begin", user: "typed in the terminal" });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  thread.sink.emit({ type: "turn.begin", user: "", host: { kind: "hidden", text: "" } });
  // Steered in, and turned down as the turn ends: said again in a turn of its own.
  assert.equal(thread.submit("one more thing", { messageID: "m-4" }).status, "steered");
  thread.sink.emit({ type: "turn.end", status: "complete" });
  refuse(false);
  await nextStep();
  await nextStep();
  assert.deepEqual(said(other.events), [
    ["message.start", { text: "typed in the terminal", sender: "desk" }],
    ["message.start", undefined],
    ["message.steered", { text: "one more thing", sender: "user", message_id: "m-4" }],
    ["message.start", undefined],
  ]);
});

test("a message the agent turned down as the turn ended waits, while the agent's side catches up after its connection dropped, behind the turns it missed", async () => {
  let refuse: (taken: boolean) => void = () => {};
  let caughtUp: () => void = () => {};
  let catching: Promise<void> | undefined;
  const started: string[] = [];
  const thread = session();
  await thread.attach(agent({ steer: () => new Promise<boolean>((resolve) => (refuse = resolve)), catchingUp: () => catching, started }));
  const other = follower();
  thread.follow(other.peer);
  thread.submit("first").begin?.();
  assert.equal(thread.submit("one more thing").status, "steered");
  thread.sink.emit({ type: "turn.end", status: "complete" });
  // The connection to the agent drops; the agent turns the message down meanwhile.
  catching = new Promise<void>((resolve) => (caughtUp = resolve));
  refuse(false);
  await nextStep();
  await nextStep();
  assert.deepEqual(started, ["first"]);
  // A turn missed at the desk is told as the agent's side catches up: it is not turned away.
  thread.sink.emit({ type: "turn.begin", user: "typed at the desk" });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  catching = undefined;
  caughtUp();
  await nextStep();
  await nextStep();
  assert.deepEqual(started, ["first", "one more thing"]);
  assert.deepEqual(said(other.events).map(([type, payload]) => [type, (payload as { text?: string } | undefined)?.text]), [
    ["message.start", "first"],
    ["message.steered", "one more thing"],
    ["message.start", "typed at the desk"],
    ["message.start", undefined],
  ]);
});

test("messages the agent turned down as the turn ended are each said again in the order they were sent, also while its side catches up and when it turns the later one down first", async () => {
  for (const laterFirst of [false, true]) {
    const refusals: ((taken: boolean) => void)[] = [];
    let caughtUp: () => void = () => {};
    let catching: Promise<void> | undefined;
    const started: string[] = [];
    const thread = session();
    await thread.attach(agent({ steer: () => new Promise<boolean>((resolve) => refusals.push(resolve)), catchingUp: () => catching, started }));
    thread.submit("first").begin?.();
    assert.equal(thread.submit("A").status, "steered");
    assert.equal(thread.submit("B").status, "steered");
    thread.sink.emit({ type: "turn.end", status: "complete" });
    // The connection to the agent drops; it turns both messages down meanwhile.
    catching = new Promise<void>((resolve) => (caughtUp = resolve));
    const [refuseA, refuseB] = refusals;
    if (laterFirst) {
      refuseB(false);
      await nextStep();
      refuseA(false);
    } else {
      refuseA(false);
      await nextStep();
      refuseB(false);
    }
    await nextStep();
    await nextStep();
    assert.deepEqual(started, ["first"]);
    catching = undefined;
    caughtUp();
    await nextStep();
    await nextStep();
    assert.deepEqual(started, ["first", "A"], laterFirst ? "B turned down first" : "A turned down first");
    thread.sink.emit({ type: "turn.end", status: "complete" });
    await nextStep();
    assert.deepEqual(started, ["first", "A", "B"], laterFirst ? "B turned down first" : "A turned down first");
  }
});

test("a message said again waits for one steered in before it that the agent has yet to take or turn down, also once the agent's side has caught up", async () => {
  const refusals: ((taken: boolean) => void)[] = [];
  let caughtUp: () => void = () => {};
  let catching: Promise<void> | undefined;
  const started: string[] = [];
  const thread = session();
  await thread.attach(agent({ steer: () => new Promise<boolean>((resolve) => refusals.push(resolve)), catchingUp: () => catching, started }));
  thread.submit("first").begin?.();
  assert.equal(thread.submit("A").status, "steered");
  assert.equal(thread.submit("B").status, "steered");
  thread.sink.emit({ type: "turn.end", status: "complete" });
  catching = new Promise<void>((resolve) => (caughtUp = resolve));
  const [refuseA, refuseB] = refusals;
  // The later message is turned down while the agent's side catches up; the earlier one is still out.
  refuseB(false);
  await nextStep();
  await nextStep();
  catching = undefined;
  caughtUp();
  await Promise.resolve();
  await Promise.resolve();
  // Turned down only now, as the next turn would start.
  refuseA(false);
  await nextStep();
  await nextStep();
  assert.deepEqual(started, ["first", "A"]);
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.deepEqual(started, ["first", "A", "B"]);
});

test("a message said again goes ahead once the one steered in before it is taken", async () => {
  const answers: ((taken: boolean) => void)[] = [];
  const started: string[] = [];
  const thread = session();
  await thread.attach(agent({ steer: () => new Promise<boolean>((resolve) => answers.push(resolve)), started }));
  thread.submit("first").begin?.();
  assert.equal(thread.submit("A").status, "steered");
  assert.equal(thread.submit("B").status, "steered");
  thread.sink.emit({ type: "turn.end", status: "complete" });
  const [answerA, answerB] = answers;
  answerB(false);
  await nextStep();
  await nextStep();
  assert.deepEqual(started, ["first"], "B waits while A is out");
  answerA(true);
  await nextStep();
  await nextStep();
  assert.deepEqual(started, ["first", "B"]);
});

// MARK: Over the wire

test("a turn started on one device opens on another with its message and the sender's id for it", async (t) => {
  const bridge = await startTestBridge();
  const phone = await TestClient.open(bridge);
  const mac = await TestClient.open(bridge);
  t.after(async () => {
    await phone.close();
    await mac.close();
    await bridge.dispose();
  });
  assert.ok(phone.readyPayload.bridge.features.includes("turn_messages"));
  const thread = await createThread(phone);
  await mac.call("session.resume", { session_id: thread });
  const start = mac.frames.length;
  await phone.call("prompt.submit", { session_id: thread, text: "Hello from the phone", profile: "fake", message_id: "4F1C" });
  const opened = await mac.from(start, (frame) => isEvent(frame, "message.start", thread));
  assert.deepEqual(opened.params.payload, { text: "Hello from the phone", sender: "user", message_id: "4F1C" });
  await mac.from(start, (frame) => isEvent(frame, "message.complete", thread), 15_000);

  // An id longer than any device's is not passed on to every follower.
  const again = mac.frames.length;
  await phone.call("prompt.submit", { session_id: thread, text: "Again", profile: "fake", message_id: "x".repeat(101) });
  const second = await mac.from(again, (frame: Frame) => isEvent(frame, "message.start", thread));
  assert.deepEqual(second.params.payload, { text: "Again", sender: "user" });
  await mac.from(again, (frame) => isEvent(frame, "message.complete", thread), 15_000);
});

test("a thread opened again says how far its snapshot reaches, so a device that already follows it does not apply an event the snapshot holds a second time", async (t) => {
  const bridge = await startTestBridge();
  const phone = await TestClient.open(bridge);
  t.after(async () => {
    await phone.close();
    await bridge.dispose();
  });
  const thread = await createThread(phone);
  const start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: thread, text: "Hello", profile: "fake" });
  await phone.from(start, (frame) => isEvent(frame, "message.complete", thread), 15_000);
  const seqs = phone.frames.filter((frame) => frame.method === "event" && frame.params?.session_id === thread).map((frame) => frame.params.seq as number);
  const resumed = await phone.call("session.resume", { session_id: thread });
  assert.equal(resumed.latest_seq, Math.max(...seqs));
});
