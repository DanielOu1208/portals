import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseConfig } from "../src/config.ts";
import { notice, noticeReplyChars } from "../src/fleet/fleet.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { Provider } from "../src/providers/types.ts";
import { createThread, startTestBridge, temporaryHome, TestClient, type Frame, type TestBridge } from "./helpers.ts";

// The thread that started a thread is told, with a message from it, when that one comes
// to rest, fails or asks something (Fleet.tellStarter; 2026-10-28: "we should add
// a deterministic mechanism that notifies the parent thread when the child is finished").

interface Setup {
  bridge: TestBridge;
  owner: TestClient;
  parent: string;
}

async function setUp(t: TestContext, tellStarters = true, delayMs = 3): Promise<Setup> {
  const data = temporaryHome();
  const bridge = await startTestBridge({
    providers: new Map<string, Provider>([["fake", new FakeProvider({ directory: join(data, "fake"), delayMs })]]),
    config: { fleet: { tellStarters } },
  });
  const owner = await TestClient.open(bridge);
  t.after(async () => {
    await owner.close();
    await bridge.dispose();
    rmSync(data, { recursive: true, force: true });
  });
  return { bridge, owner, parent: await createThread(owner) };
}

/** The messages of `thread` from others than the person: notices among them. */
async function fleetMessages(owner: TestClient, thread: string): Promise<string[]> {
  const reading = await owner.call("thread.read", { thread, last: 20 });
  return (reading.messages as Frame[]).filter((message) => message.role === "user" && String(message.text).startsWith("[Portals: from")).map((message) => String(message.text));
}

/** Waits until `thread` has a message from the fleet that `matches`, and gives it. */
async function toldOf(owner: TestClient, thread: string, matches: RegExp, withinMs = 5000): Promise<string> {
  const until = Date.now() + withinMs;
  for (;;) {
    const found = (await fleetMessages(owner, thread)).find((text) => matches.test(text));
    if (found) return found;
    if (Date.now() > until) assert.fail(`no message matching ${matches} in ${thread}: ${JSON.stringify(await fleetMessages(owner, thread))}`);
    await delay(25);
  }
}

test("a thread started from another tells it when it finishes its turn, from itself, with its last reply", async (t) => {
  const { owner, parent } = await setUp(t);
  const started = await owner.call("thread.start", { profile: "fake", from: parent, text: "look into it" });
  assert.equal(started.tells_starter, true);
  const child = started.thread.id as string;
  const told = await toldOf(owner, parent, /Notice from the bridge: this thread finished its turn/);
  assert.match(told, new RegExp(`^\\[Portals: from Fake agent .*\\(thread ${child}\\)\\]`));
  assert.match(told, /Its last reply:\n\nHello from the fake agent\. You said: .*look into it\./s);
  // Once for that rest: nothing more comes of it.
  await delay(150);
  assert.equal((await fleetMessages(owner, parent)).filter((text) => text.includes("finished its turn")).length, 1);

  // Each turn after is told too (the fake agent says back the first line of a message
  // from another thread: the line saying whom it is from).
  await owner.call("thread.send", { thread: child, text: "and again", from: parent });
  const until = Date.now() + 5000;
  while ((await fleetMessages(owner, parent)).filter((text) => text.includes("finished its turn")).length < 2) {
    if (Date.now() > until) assert.fail("the second turn was not told");
    await delay(25);
  }
});

test("a starter waiting for its thread hears it through the wait, and is not told as well", async (t) => {
  const { owner, parent } = await setUp(t);
  const started = await owner.call("thread.start", { profile: "fake", from: parent, text: "quick one", wait: true, timeout_ms: 5000 });
  assert.equal(started.state, "idle");
  assert.match(started.reply, /You said: .*quick one/s);
  await delay(200);
  assert.deepEqual(await fleetMessages(owner, parent), []);

  // A wait that some other caller holds does not count: the starter is told.
  const child = started.thread.id as string;
  const other = await createThread(owner);
  await owner.call("thread.send", { thread: child, text: "once more", from: parent, wait: true, timeout_ms: 5000 });
  await delay(150);
  assert.deepEqual(await fleetMessages(owner, parent), []);
  await owner.call("thread.send", { thread: child, text: "and once more", from: other, wait: true, timeout_ms: 5000 });
  await toldOf(owner, parent, /finished its turn/);
});

test("a turn that fails as it begins is told to the starter's wait alone, sent or started with wait", async (t) => {
  const { owner, parent } = await setUp(t);
  const started = await owner.call("thread.start", { profile: "fake", from: parent, text: "fail now", wait: true, timeout_ms: 5000 });
  assert.equal(started.state, "error");
  assert.match(started.reply, /failed on purpose/);
  await owner.call("thread.send", { thread: started.thread.id, text: "fail again", from: parent, wait: true, timeout_ms: 5000 });
  await delay(300);
  assert.deepEqual(await fleetMessages(owner, parent), []);

  // Without a wait, the failure is told.
  await owner.call("thread.send", { thread: started.thread.id, text: "fail once more", from: parent });
  assert.match(await toldOf(owner, parent, /turn ended with an error/), /failed on purpose/);
});

test("a wait called off before or while its message goes keeps nothing from the starter: the failure is told", async (t) => {
  const { bridge, owner, parent } = await setUp(t);
  const child = (await owner.call("thread.start", { profile: "fake", from: parent, text: "first", wait: true, timeout_ms: 5000 })).thread.id as string;
  // The caller gone already (its connection closed while the thread was made).
  const gone = new AbortController();
  gone.abort();
  await assert.rejects(bridge.fleet.sendAndWait(child, "fail now", 5000, gone.signal, { from: parent }));
  await toldOf(owner, parent, /turn ended with an error/);

  // Gone while the message is on its way: before the turn that fails at once ends.
  const leaving = new AbortController();
  const sending = bridge.fleet.sendAndWait(child, "fail again", 5000, leaving.signal, { from: parent });
  leaving.abort();
  await assert.rejects(sending);
  const until = Date.now() + 5000;
  while ((await fleetMessages(owner, parent)).filter((text) => text.includes("turn ended with an error")).length < 2) {
    if (Date.now() > until) assert.fail("the second failure was not told");
    await delay(25);
  }
});

test("a thread waiting for an answer tells its starter what it asks", async (t) => {
  const { owner, parent } = await setUp(t);
  const started = await owner.call("thread.start", { profile: "fake", from: parent, text: "ask please" });
  const told = await toldOf(owner, parent, /this thread is waiting for an answer/);
  const reading = await owner.call("thread.read", { thread: started.thread.id });
  const request = (reading.open_requests as Frame[])[0];
  assert.ok(request, "the started thread asks");
  assert.match(told, new RegExp(`- a question \\(request ${request.id}\\)`));
  assert.match(told, /portals answer/);
});

test("with fleet.tellStarters off, or for a thread no thread started, no one is told", async (t) => {
  const off = await setUp(t, false);
  assert.equal((await off.owner.call("thread.start", { profile: "fake", from: off.parent, text: "quiet", wait: false })).tells_starter, false);
  await delay(300);
  assert.deepEqual(await fleetMessages(off.owner, off.parent), []);

  const on = await setUp(t);
  // Started by the command in a shell, or by a person: it has no thread to tell.
  assert.equal((await on.owner.call("thread.start", { profile: "fake", text: "from a shell", wait: true, timeout_ms: 5000 })).tells_starter, false);
  await delay(150);
  assert.deepEqual(await fleetMessages(on.owner, on.parent), []);
});

test("a message a thread sends its starter while it works is no report: the notice still follows its turn", async (t) => {
  // Slow enough that the started thread is still at work when it writes.
  const { owner, parent } = await setUp(t, true, 60);
  const started = await owner.call("thread.start", { profile: "fake", from: parent, text: "check with me" });
  const child = started.thread.id as string;
  assert.equal((await owner.call("thread.wait", { thread: child, timeout_ms: 1 })).state, "working");
  await owner.call("thread.send", { thread: parent, text: "Is Swift fine?", from: child });
  await owner.call("thread.wait", { thread: child, timeout_ms: 5000 });
  await toldOf(owner, parent, /Is Swift fine\?/);
  await toldOf(owner, parent, /Notice from the bridge: this thread finished its turn/);
});

test("a thread that reports to its starter while it works gets no notice of that rest; its next turn's comes", async (t) => {
  const { owner, parent } = await setUp(t, true, 60);
  const started = await owner.call("thread.start", { profile: "fake", from: parent, text: "report back" });
  const child = started.thread.id as string;
  assert.equal((await owner.call("thread.wait", { thread: child, timeout_ms: 1 })).state, "working");
  // No thread named: the one that started it is found.
  const reported = await owner.call("thread.report", { text: "Done: all good.", from: child });
  assert.equal(reported.thread, parent);
  await owner.call("thread.wait", { thread: child, timeout_ms: 5000 });
  await toldOf(owner, parent, /Done: all good\./);
  await delay(300);
  assert.deepEqual((await fleetMessages(owner, parent)).filter((text) => text.includes("Notice from the bridge")), []);

  // Its next turn, with no report, is told.
  await owner.call("thread.send", { thread: child, text: "one more" });
  await toldOf(owner, parent, /Notice from the bridge: this thread finished its turn/);
});

test("a report covers the work up to it: a message sent into the thread after it, while that turn still runs, is told once done", async (t) => {
  const { owner, parent } = await setUp(t, true, 60);
  const started = await owner.call("thread.start", { profile: "fake", from: parent, text: "do the first part" });
  const child = started.thread.id as string;
  assert.equal((await owner.call("thread.wait", { thread: child, timeout_ms: 1 })).state, "working");
  await owner.call("thread.report", { text: "First part done.", from: child });
  // The starter, told, sends more work at once, without waiting (the notice will come).
  assert.equal((await owner.call("thread.wait", { thread: child, timeout_ms: 1 })).state, "working");
  const sent = await owner.call("thread.send", { thread: child, text: "great, now the second part", from: parent });
  assert.notEqual(sent.status, "streaming");
  assert.equal((await owner.call("thread.wait", { thread: child, timeout_ms: 10_000 })).state, "idle");
  assert.ok(JSON.stringify((await owner.call("thread.read", { thread: child, last: 3 })).messages).includes("second part"));
  await toldOf(owner, parent, /Notice from the bridge: this thread finished its turn/);
  await delay(300);
  assert.equal((await fleetMessages(owner, parent)).filter((text) => text.includes("Notice from the bridge")).length, 1);
});

test("a starter's follow-up that comes before the report it answers is done going is told once done", async (t) => {
  // Codex's review of the round 4 bridge fixes: the report's mark went on after the starter's answer had cleared it.
  const { bridge, owner, parent } = await setUp(t, true, 60);
  const started = await owner.call("thread.start", { profile: "fake", from: parent, text: "do the first part" });
  const child = started.thread.id as string;
  assert.equal((await owner.call("thread.wait", { thread: child, timeout_ms: 1 })).state, "working");
  // The starter reads the report and answers it before the report's own send has come back
  // (its answer delayed on the way, as from another Mac).
  type Send = (id: string, text: string, by?: { from?: string }) => Promise<{ status: string }>;
  const fleet = bridge.fleet as unknown as { send: Send };
  const send = fleet.send.bind(fleet);
  fleet.send = async (id, text, by) => {
    const sent = await send(id, text, by);
    if (id === parent && by?.from === child) await send(child, "great, now the second part", { from: parent });
    return sent;
  };
  await owner.call("thread.report", { text: "First part done.", from: child });
  assert.equal((await owner.call("thread.wait", { thread: child, timeout_ms: 10_000 })).state, "idle");
  await toldOf(owner, parent, /Notice from the bridge: this thread finished its turn/);
});

test("a report made at rest does not keep its next turn from being told; a thread no thread started has no one to report to", async (t) => {
  const { owner, parent } = await setUp(t);
  const started = await owner.call("thread.start", { profile: "fake", from: parent, text: "first", wait: true, timeout_ms: 5000 });
  const child = started.thread.id as string;
  await owner.call("thread.report", { text: "an aside", from: child });
  await owner.call("thread.send", { thread: child, text: "second" });
  await toldOf(owner, parent, /Notice from the bridge: this thread finished its turn/);

  const alone = await owner.call("thread.start", { profile: "fake", text: "from a shell", wait: true, timeout_ms: 5000 });
  await assert.rejects(owner.call("thread.report", { text: "hello?", from: alone.thread.id }), (error: { code: number; message: string }) => error.code === -32602 && /No thread started this one/.test(error.message));
  await assert.rejects(owner.call("thread.report", { text: "hello?" }), (error: { code: number }) => error.code === -32602);
});

test("a notice says the turn finished or failed, with the reply cut short, or what is asked", () => {
  assert.equal(notice("idle", "", []), "Notice from the bridge: this thread finished its turn.");
  assert.equal(notice("idle", "Done.", []), "Notice from the bridge: this thread finished its turn. Its last reply:\n\nDone.");
  assert.equal(notice("error", "The model is overloaded.", []), "Notice from the bridge: this thread's turn ended with an error. Why:\n\nThe model is overloaded.");
  const long = notice("idle", "x".repeat(noticeReplyChars + 50), []);
  assert.ok(long.includes(`${"x".repeat(noticeReplyChars)}…\n(Cut short: \`portals read\` has all of it.)`));
  const asks = notice("blocked", "", [
    { id: "srq-1", method: "approval", params: { command: "rm -rf build", description: "delete the build folder" } },
    { id: "srq-2", method: "clarify", params: { questions: [{ qid: "q0", question: "Which  language?" }] } },
  ]);
  assert.match(asks, /- an approval \(request srq-1\): delete the build folder · rm -rf build/);
  assert.match(asks, /- a question \(request srq-2\): Which language\?/);
});

test("a notice cuts a reply or a question between characters, never in the middle of an emoji, and a message sent into a thread is well formed", async (t) => {
  // Bug hunt round 4, BC7: half of a surrogate pair, stored as the starter's message, goes on to its agent.
  const rocket = "\u{1F680}";
  const reply = notice("idle", `${"a".repeat(noticeReplyChars - 1)}${rocket} and more`, []);
  assert.ok(reply.isWellFormed());
  assert.ok(reply.includes(`${"a".repeat(noticeReplyChars - 1)}…`));
  const asked = notice("blocked", "", [{ id: "srq-1", method: "clarify", params: { question: `${"q".repeat(299)}${rocket} and more` } }]);
  assert.ok(asked.isWellFormed());

  const { bridge, owner, parent } = await setUp(t);
  const started = await owner.call("thread.start", { profile: "fake", from: parent, text: "hi", wait: true, timeout_ms: 5000 });
  // A text with half of a pair, as another bridge or a cut elsewhere could pass on.
  await owner.call("thread.send", { thread: started.thread.id, text: `half \ud83d of a rocket`, from: parent, wait: true, timeout_ms: 5000 });
  const sessions = (bridge.fleet as unknown as { sessions: { get(id: string): { messages: readonly Frame[] } | undefined } }).sessions;
  const stored = sessions.get(started.thread.id)?.messages.find((message) => message.role === "user" && String(message.text).includes("of a rocket"));
  assert.ok(stored);
  assert.ok(String(stored.text).isWellFormed());
});

test("fleet.tellStarters is on unless set off, and must be true or false", () => {
  assert.equal(parseConfig({}).fleet.tellStarters, true);
  assert.equal(parseConfig({ fleet: { tellStarters: false } }).fleet.tellStarters, false);
  assert.throws(() => parseConfig({ fleet: { tellStarters: "yes" } }), /fleet\.tellStarters must be true or false/);
});

test("a thread.send with a notice id this bridge has taken is answered as before and not sent again", async (t) => {
  const { owner, parent } = await setUp(t);
  const first = await owner.call("thread.send", { thread: parent, text: "Notice from the bridge: this thread finished its turn.", notice: "n-1" });
  const again = await owner.call("thread.send", { thread: parent, text: "Notice from the bridge: this thread finished its turn.", notice: "n-1" });
  assert.deepEqual(again, first);
  await owner.call("thread.wait", { thread: parent, timeout_ms: 5000 });
  const reading = await owner.call("thread.read", { thread: parent, last: 20 });
  assert.equal((reading.messages as Frame[]).filter((message) => message.role === "user" && String(message.text).includes("finished its turn")).length, 1);
  // Another id is another notice.
  await owner.call("thread.send", { thread: parent, text: "Notice from the bridge: this thread finished its turn.", notice: "n-2", wait: true, timeout_ms: 5000 });
  const later = await owner.call("thread.read", { thread: parent, last: 20 });
  assert.equal((later.messages as Frame[]).filter((message) => message.role === "user" && String(message.text).includes("finished its turn")).length, 2);
});

test("a notice whose time to be tried has run out is not sent, however late its try comes", async (t) => {
  // Codex's review of the round 4 bridge fixes: a retry timer that fired late (the Mac asleep) sent it all the same.
  const { bridge, owner, parent } = await setUp(t);
  const started = await owner.call("thread.start", { profile: "fake", from: parent, text: "hi" });
  const child = started.thread.id as string;
  await toldOf(owner, parent, /Notice from the bridge: this thread finished its turn/);
  type Fleet = { told: Map<string, string>; sendNotice(id: string, starter: string, seen: string, text: string, notice: string, since: number, tries: number): Promise<void> };
  const fleet = bridge.fleet as unknown as Fleet;
  // A try of it, due seven hours after it was first tried.
  await fleet.sendNotice(child, parent, fleet.told.get(child)!, "Notice from the bridge: this thread finished its turn. (late)", "n-late", Date.now() - 7 * 3_600_000, 3);
  await delay(200);
  assert.equal((await fleetMessages(owner, parent)).filter((text) => text.includes("(late)")).length, 0);
});
