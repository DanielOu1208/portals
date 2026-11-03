import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { botChatTitle, HermesHost } from "../src/providers/hermes/provider.ts";
import type { Provider } from "../src/providers/types.ts";
import { Registry } from "../src/sessions/registry.ts";
import { FakeHermes } from "./hermes-serve.ts";
import { isEvent, RpcFailure, startTestBridge, TestClient, type Frame, type TestBridge } from "./helpers.ts";

// Each Hermes profile keeps one ongoing conversation (feature bot_chat): the session
// titled "Bot Chat", which Hermes Desktop keeps for the profile too. Against the stand-in
// for `hermes serve` (test/hermes-serve.ts).

let hermes: FakeHermes;
let cwd: string;
let state: string;
const open: { close(): Promise<unknown> }[] = [];

function hermesAgents(cachePath = join(state, "hermes.json")): Map<string, Provider> {
  const agents = new Map<string, Provider>();
  new HermesHost({
    settings: { path: "/nonexistent/hermes", start: false, folder: cwd, logPath: join(state, "hermes-serve.log") },
    cachePath,
    connect: hermes.connector(),
    backoff: [0.05, 0.1],
  }).addTo(agents);
  return agents;
}

async function bridgeAndPhone(): Promise<{ bridge: TestBridge; phone: TestClient }> {
  const bridge = await startTestBridge({ providers: hermesAgents(), config: { generalFolder: cwd } });
  open.push({ close: () => bridge.dispose() });
  const phone = await TestClient.open(bridge);
  open.unshift(phone);
  return { bridge, phone };
}

beforeEach(async () => {
  hermes = await FakeHermes.start();
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "portals-botchat-test-")));
  state = mkdtempSync(join(tmpdir(), "portals-botchat-state-"));
});

afterEach(async () => {
  for (const one of open.splice(0)) await one.close();
  await hermes.close();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

async function create(on: TestClient, profile = "hermes"): Promise<string> {
  return (await on.call("session.create", { profile, source: "tui", cwd })).session_id;
}

async function hermesThreads(on: TestClient): Promise<Frame[]> {
  return (await on.call("threads.list", { local: true })).threads.filter((thread: Frame) => thread.agent === "hermes");
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a new Hermes thread is the profile's Bot Chat, made once however many devices ask at once, and it is never removed nor renamed", async () => {
  const { bridge, phone } = await bridgeAndPhone();
  const mac = await TestClient.open(bridge);
  open.unshift(mac);
  const [first, second] = await Promise.all([create(phone), create(mac)]);
  assert.equal(first, second);
  const made = hermes.callsOf("session.create");
  assert.equal(made.length, 1);
  assert.equal(made[0].params.title, botChatTitle);
  assert.equal(made[0].params.hidden, true);
  assert.equal(made[0].params.follow_profile_config, true);
  assert.equal(made[0].params.model, undefined);
  assert.equal(hermes.sessions.get(first)!.title, botChatTitle);
  // Asked again later, it is the same one, and Hermes is not asked to make another.
  const again = await phone.call("session.create", { profile: "hermes", source: "tui", cwd });
  assert.equal(again.session_id, first);
  assert.equal(again.ongoing, true);
  assert.equal(hermes.callsOf("session.create").length, 1);

  const listed = await hermesThreads(phone);
  assert.deepEqual(listed.map((thread) => [thread.id, thread.title, thread.ongoing]), [[first, "Hermes", true]]);
  await assert.rejects(phone.call("thread.delete", { thread: first }), (error: RpcFailure) => /always there/.test(error.message));
  await assert.rejects(phone.call("session.rename", { session_id: first, title: "Plans" }), (error: RpcFailure) => /keeps its name/.test(error.message));
  assert.equal(hermes.sessions.get(first)!.title, botChatTitle);
});

test("a Bot Chat Hermes already keeps, as one Hermes Desktop made, is the profile's thread, with what was said in it", async () => {
  const kept = "20261020_101500_b0tc4t";
  hermes.addSession(kept, "aeri", [
    { role: "user", text: "Good morning", timestamp: 1_761_000_001 },
    { role: "assistant", text: "Morning! What's on today?", timestamp: 1_761_000_002 },
  ], botChatTitle);
  const { phone } = await bridgeAndPhone();
  assert.equal(await create(phone, "aeri"), kept);
  assert.equal(hermes.callsOf("session.create").length, 0);
  const resumed = await phone.call("session.resume", { session_id: kept, profile: "aeri" });
  assert.deepEqual(resumed.messages.map((message: Frame) => message.text), ["Good morning", "Morning! What's on today?"]);
  const listed = (await phone.call("threads.list", { local: true })).threads.find((thread: Frame) => thread.id === kept);
  assert.equal(listed.title, "Aeri");
  assert.equal(listed.ongoing, true);
});

test("when Hermes cannot say whether the profile has a Bot Chat, none is made", async () => {
  hermes.listFails = { code: 5000, message: "database is locked" };
  const { phone } = await bridgeAndPhone();
  await assert.rejects(create(phone), (error: RpcFailure) => /database is locked/.test(error.message));
  assert.equal(hermes.callsOf("session.create").length, 0);
  // Once it can, the thread is made.
  hermes.listFails = null;
  const thread = await create(phone);
  assert.equal(hermes.sessions.get(thread)!.title, botChatTitle);
});

test("a Bot Chat another app names first, while the bridge makes one, is the one the profile keeps", async () => {
  const desk = "20261020_101600_d35k00";
  hermes.onTitle = () => {
    if (!hermes.sessions.has(desk)) hermes.addSession(desk, "default", [], botChatTitle);
  };
  const { phone } = await bridgeAndPhone();
  assert.equal(await create(phone), desk);
  assert.equal(hermes.callsOf("session.close").length, 1);
  assert.deepEqual((await hermesThreads(phone)).map((thread) => thread.id), [desk]);
});

test("as the bridge starts, the profile's Bot Chat goes on the list and its other threads leave it, still kept in Hermes", async () => {
  const kept = "20261020_101700_b0tc4t";
  hermes.addSession(kept, "default", [{ role: "user", text: "Remind me at five", timestamp: 1_761_000_001 }], botChatTitle);
  hermes.addSession("20261001_090000_01d001");
  hermes.addSession("20261002_090000_01d002");
  const first = await startTestBridge({ providers: new Map(), config: { generalFolder: cwd }, keepHome: true });
  await first.dispose();
  const registry = new Registry(join(first.home, "state", "threads.json"));
  const base = { agent: "hermes", cwd, model: "zai-org/GLM-5.3-Flash", provider: "gmi", reasoningEffort: "", createdAt: 1791181301, updatedAt: 1791181301, origin: "phone" } as const;
  registry.add({ ...base, id: "20261001_090000_01d001", title: "Trip plans" });
  registry.add({ ...base, id: "20261002_090000_01d002", title: "Groceries" });
  const restarted = await startTestBridge({ home: first.home, providers: hermesAgents(join(first.home, "hermes.json")) });
  open.push({ close: () => restarted.dispose() });
  const phone = await TestClient.open(restarted);
  open.unshift(phone);
  await until(async () => (await hermesThreads(phone)).length === 1);
  const [listed] = await hermesThreads(phone);
  assert.equal(listed.id, kept);
  assert.equal(listed.ongoing, true);
  assert.equal(listed.title, "Hermes");
  assert.equal(hermes.callsOf("session.create").length, 0);
  // Listed, not loaded: Hermes is asked for it once a device opens it.
  assert.equal(hermes.callsOf("session.resume").length, 0);
  assert.equal(hermes.sessions.size, 3);
  assert.equal(await create(phone), kept);
});

test("a profile Hermes lists only once the bridge runs (put back, or made) has its Bot Chat on the list and its other threads leave it, as at the start", async () => {
  // The backlog's "Left: a profile taken out and put back while the bridge runs keeps its
  // old threads on the list until the bridge's next start".
  const kept = "20261020_101700_a3r1bc";
  hermes.addSession(kept, "aeri", [{ role: "user", text: "Plan the week", timestamp: 1_761_000_001 }], botChatTitle);
  hermes.addSession("20261003_090000_a3r1o1", "aeri");
  const first = await startTestBridge({ providers: new Map(), config: { generalFolder: cwd }, keepHome: true });
  await first.dispose();
  const registry = new Registry(join(first.home, "state", "threads.json"));
  registry.add({ agent: "aeri", cwd, model: "zai-org/GLM-5.3-Flash", provider: "gmi", reasoningEffort: "", createdAt: 1791181301, updatedAt: 1791181301, origin: "phone", id: "20261003_090000_a3r1o1", title: "Old aeri thread" });
  // Taken out of Hermes when the bridge starts.
  const all = hermes.profiles;
  hermes.profiles = all.filter((profile) => profile.name !== "aeri");
  const restarted = await startTestBridge({ home: first.home, providers: hermesAgents(join(first.home, "hermes.json")) });
  open.push({ close: () => restarted.dispose() });
  const phone = await TestClient.open(restarted);
  open.unshift(phone);
  const aeriThreads = async () => (await phone.call("threads.list", { local: true })).threads.filter((thread: Frame) => thread.agent === "aeri");
  await until(() => hermes.callsOf("profiles.list").length > 0);
  assert.deepEqual((await aeriThreads()).map((thread: Frame) => thread.id), ["20261003_090000_a3r1o1"]);

  // Put back: Hermes lists it again once the bridge asks (after a reconnect).
  hermes.profiles = all;
  hermes.dropAll();
  await until(async () => (await phone.call("profiles.list")).profiles.some((profile: Frame) => profile.name === "aeri"));
  await until(async () => (await aeriThreads()).length === 1 && (await aeriThreads())[0].id === kept);
  const [listed] = await aeriThreads();
  assert.equal(listed.ongoing, true);
  assert.equal(listed.title, "Aeri");
  // Still kept in Hermes.
  assert.equal(hermes.sessions.has("20261003_090000_a3r1o1"), true);
});

test("a profile whose Bot Chat Hermes no longer has, back once the bridge runs, lets go of the one on the list, and a new one is made when asked", async () => {
  // From Codex's review of n14: the one on the list could never be opened ("session not
  // found"), and no other was made while it was there. As the bridge starts, the same.
  const first = await startTestBridge({ providers: new Map(), config: { generalFolder: cwd }, keepHome: true });
  await first.dispose();
  const registry = new Registry(join(first.home, "state", "threads.json"));
  registry.add({ agent: "aeri", cwd, model: "zai-org/GLM-5.3-Flash", provider: "gmi", reasoningEffort: "", createdAt: 1791181301, updatedAt: 1791181301, origin: "phone", id: "20261004_090000_9011e0", title: "Aeri", ongoing: true });
  const all = hermes.profiles;
  hermes.profiles = all.filter((profile) => profile.name !== "aeri");
  const restarted = await startTestBridge({ home: first.home, providers: hermesAgents(join(first.home, "hermes.json")) });
  open.push({ close: () => restarted.dispose() });
  const phone = await TestClient.open(restarted);
  open.unshift(phone);
  const aeriThreads = async () => (await phone.call("threads.list", { local: true })).threads.filter((thread: Frame) => thread.agent === "aeri");
  await until(() => hermes.callsOf("profiles.list").length > 0);
  hermes.profiles = all;
  hermes.dropAll();
  await until(async () => (await phone.call("profiles.list")).profiles.some((profile: Frame) => profile.name === "aeri"));
  await until(async () => (await aeriThreads()).length === 0);
  const made = await create(phone, "aeri");
  assert.notEqual(made, "20261004_090000_9011e0");
  assert.equal(hermes.callsOf("session.create").at(-1)?.params.title, botChatTitle);
  assert.deepEqual((await aeriThreads()).map((thread: Frame) => [thread.id, thread.ongoing]), [[made, true]]);
});

test("/compress compacts the Bot Chat in Hermes as a turn of its own, with what to keep in focus, and says so when nothing changed", async () => {
  const { phone } = await bridgeAndPhone();
  const thread = await create(phone);
  await phone.call("session.resume", { session_id: thread, profile: "hermes" });
  const catalog = await phone.call("commands.catalog", { session_id: thread, profile: "hermes" });
  assert.ok(catalog.pairs.some(([name]: [string]) => name === "/compress"));
  assert.deepEqual(await phone.call("command.dispatch", { name: "compress", arg: "", session_id: thread, profile: "hermes" }), { type: "send", message: "/compress" });

  let start = phone.frames.length;
  assert.equal((await phone.call("prompt.submit", { session_id: thread, text: "/compress", profile: "hermes" })).status, "streaming");
  let done = (await phone.from(start, (frame) => isEvent(frame, "message.complete", thread))).params;
  assert.equal(done.payload.status, "complete");
  const compacted = phone.frames.slice(start).find((frame) => isEvent(frame, "session.compacted", thread));
  assert.deepEqual(compacted?.params.payload, { trigger: "manual", tokens_before: 24_063 });
  const asked = hermes.callsOf("session.compress").at(-1)!;
  assert.equal(asked.params.session_id, hermes.sessions.get(thread)!.runtime);
  assert.equal(asked.params.focus_topic, undefined);

  hermes.compressResult = { status: "compressed", removed: 0, summary: { headline: "No changes from compression: 3 messages", noop: true } };
  start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: thread, text: "/compact the trip plans", profile: "hermes" });
  done = (await phone.from(start, (frame) => isEvent(frame, "message.complete", thread))).params;
  assert.equal(done.payload.status, "complete");
  assert.equal(hermes.callsOf("session.compress").at(-1)!.params.focus_topic, "the trip plans");
  assert.equal(phone.frames.slice(start).some((frame) => isEvent(frame, "session.compacted", thread)), false);
  const notice = phone.frames.slice(start).find((frame) => isEvent(frame, "status.update", thread) && frame.params.payload.kind === "info");
  assert.equal(notice?.params.payload.text, "No changes from compression: 3 messages");

  hermes.compressFails = { code: 4009, message: "session busy" };
  start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: thread, text: "/compress", profile: "hermes" });
  done = (await phone.from(start, (frame) => isEvent(frame, "message.complete", thread))).params;
  assert.equal(done.payload.status, "error");
  assert.match(done.payload.text ?? done.payload.error ?? "", /could not compress the conversation: session busy/);
});

test("a long Bot Chat opens with its last turns, and the turns before come a page at a time, until a change no event told of moves them", async () => {
  const kept = "20261020_101800_b0tc4t";
  const messages: Frame[] = [];
  for (let turn = 1; turn <= 5; turn += 1) {
    messages.push({ role: "user", text: `Question ${turn}`, timestamp: 1_761_000_000 + turn * 10 });
    if (turn === 4) messages.push({ role: "user", text: "And one more thing", timestamp: 1_761_000_000 + turn * 10 + 1, display_kind: "steer" });
    messages.push({ role: "assistant", text: `Answer ${turn}`, timestamp: 1_761_000_000 + turn * 10 + 2 });
  }
  hermes.addSession(kept, "default", messages, botChatTitle);
  const { phone } = await bridgeAndPhone();
  assert.equal(await create(phone), kept);
  const epoch = phone.readyPayload.replay_epoch;
  const resumed = await phone.call("session.resume", { session_id: kept, profile: "hermes", limit: 2, replay_epoch: epoch });
  // Turn 4 keeps its steer: a page starts only at a message that opened a turn.
  assert.deepEqual(resumed.messages.map((message: Frame) => message.text), ["Question 4", "And one more thing", "Answer 4", "Question 5", "Answer 5"]);
  assert.equal(resumed.history_start, 6);
  assert.equal(resumed.has_earlier, true);
  assert.equal(typeof resumed.replay_base, "number");

  const page = await phone.call("session.history", { session_id: kept, before: 6, limit: 2, replay_epoch: epoch, replay_base: resumed.replay_base });
  assert.deepEqual(page.messages.map((message: Frame) => message.text), ["Question 2", "Answer 2", "Question 3", "Answer 3"]);
  assert.equal(page.start, 2);
  assert.equal(page.has_earlier, true);
  const last = await phone.call("session.history", { session_id: kept, before: 2, replay_epoch: epoch, replay_base: resumed.replay_base });
  assert.deepEqual(last.messages.map((message: Frame) => message.text), ["Question 1", "Answer 1"]);
  assert.equal(last.start, 0);
  assert.equal(last.has_earlier, false);

  assert.deepEqual(await phone.call("session.history", { session_id: kept, before: 6, replay_epoch: epoch, replay_base: resumed.replay_base + 1 }), { moved: true });
  assert.deepEqual(await phone.call("session.history", { session_id: kept, before: 6, replay_epoch: "another-run", replay_base: resumed.replay_base }), { moved: true });
  // Without a limit, the whole conversation, as before.
  const whole = await phone.call("session.resume", { session_id: kept, profile: "hermes" });
  assert.equal(whole.messages.length, 11);
  assert.equal(whole.history_start, undefined);
});

test("Stop lets go of a compression Hermes cannot stop: the turn ends at once, and a message sent meanwhile goes once Hermes is done", async () => {
  const { phone } = await bridgeAndPhone();
  const thread = await create(phone);
  await phone.call("session.resume", { session_id: thread, profile: "hermes" });
  let finish = () => {};
  hermes.onCompress = () => new Promise<void>((resolve) => (finish = resolve));

  let start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: thread, text: "/compress", profile: "hermes" });
  await until(() => hermes.callsOf("session.compress").length === 1);
  await phone.call("session.interrupt", { session_id: thread, profile: "hermes" });
  const stopped = (await phone.from(start, (frame) => isEvent(frame, "message.complete", thread))).params;
  assert.equal(stopped.payload.status, "interrupted");
  const said = phone.frames.slice(start).find((frame) => isEvent(frame, "status.update", thread) && frame.params.payload.kind === "info");
  assert.match(said?.params.payload.text ?? "", /cannot be stopped/);
  // Hermes's own Stop would only drop what waits behind the compression.
  assert.equal(hermes.callsOf("session.interrupt").length, 0);

  // A message sent meanwhile waits for the compression, and can be stopped while it does.
  start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: thread, text: "Never mind", profile: "hermes" });
  const waiting = await phone.from(start, (frame) => isEvent(frame, "thinking.delta", thread) && /finish compacting/.test(frame.params.payload.text ?? ""));
  assert.ok(waiting);
  await phone.call("session.interrupt", { session_id: thread, profile: "hermes" });
  assert.equal((await phone.from(start, (frame) => isEvent(frame, "message.complete", thread))).params.payload.status, "interrupted");
  assert.equal(hermes.callsOf("prompt.submit").length, 0);

  start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: thread, text: "Plan the week", profile: "hermes" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hermes.callsOf("prompt.submit").length, 0);
  finish();
  // What the compression did is told still, then the message goes.
  await phone.from(start, (frame) => isEvent(frame, "session.compacted", thread));
  await until(() => hermes.callsOf("prompt.submit").length === 1);
  assert.equal(hermes.callsOf("prompt.submit")[0].params.text, "Plan the week");
});

test("what another app of Hermes's says in the Bot Chat comes to the devices that hold it, and to one that opens it", async () => {
  const kept = "20261028_090000_b0tc4t";
  hermes.addSession(kept, "default", [
    { role: "user", text: "Good morning", timestamp: 1_761_000_001 },
    { role: "assistant", text: "Morning!", timestamp: 1_761_000_002 },
  ], botChatTitle);
  const { bridge } = await bridgeAndPhone();
  // A device that takes a thread again when told to, as the app does (feature session_resync).
  const phone = await TestClient.open(bridge, { capabilities: { session_resync: true } });
  open.unshift(phone);
  assert.equal(await create(phone), kept);
  await phone.call("session.resume", { session_id: kept, profile: "hermes" });
  await until(() => hermes.callsOf("session.list").some((call) => call.params.title === botChatTitle && hermes.callsOf("session.resume").length > 0));
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Said in Hermes Desktop: its Hermes writes the store, and says only that sessions changed.
  hermes.sessions.get(kept)!.messages.push(
    { role: "user", text: "What's on today?", timestamp: 1_761_000_101 },
    { role: "assistant", text: "Two meetings.", timestamp: 1_761_000_102 },
  );
  const start = phone.frames.length;
  hermes.broadcast("sessions.changed");
  await phone.from(start, (frame) => isEvent(frame, "session.invalidated", kept));
  const again = await phone.call("session.resume", { session_id: kept, profile: "hermes" });
  assert.deepEqual(again.messages.map((message: Frame) => message.text), ["Good morning", "Morning!", "What's on today?", "Two meetings."]);
  const listed = (await phone.call("threads.changes", {})).threads.find((thread: Frame) => thread.id === kept);
  assert.equal(listed?.preview, "What's on today?");

  // Nothing changed: nothing is taken again.
  const quiet = phone.frames.length;
  hermes.broadcast("sessions.changed");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(phone.frames.slice(quiet).some((frame) => isEvent(frame, "session.invalidated", kept)), false);

  // No word from Hermes: a device that opens the thread takes what was said all the same.
  hermes.sessions.get(kept)!.messages.push({ role: "user", text: "Thanks", timestamp: 1_761_000_201 });
  const mac = await TestClient.open(bridge);
  open.unshift(mac);
  const opened = await mac.call("session.resume", { session_id: kept, profile: "hermes" });
  assert.equal(opened.messages.at(-1)?.text, "Thanks");
});

// Bug hunt round 4 (BC3 to BC6): looks at the Bot Chat that race a turn of the bridge's
// own, a device's attachment or another change Hermes tells of.

/** A Bot Chat Hermes keeps, open on a phone that takes a thread again when told to (feature session_resync). */
async function botChatOnPhone(kept: string): Promise<{ phone: TestClient; said: { messages: Frame[] } }> {
  hermes.addSession(kept, "default", [
    { role: "user", text: "Good morning", timestamp: 1_761_000_001 },
    { role: "assistant", text: "Morning!", timestamp: 1_761_000_002 },
  ], botChatTitle);
  const { bridge } = await bridgeAndPhone();
  const phone = await TestClient.open(bridge, { capabilities: { session_resync: true } });
  open.unshift(phone);
  assert.equal(await create(phone), kept);
  await phone.call("session.resume", { session_id: kept, profile: "hermes" });
  await until(() => hermes.callsOf("session.list").some((call) => call.params.title === botChatTitle));
  await new Promise((resolve) => setTimeout(resolve, 80));
  return { phone, said: hermes.sessions.get(kept)! };
}

/** Hermes answers the next `session.resume` with its store as it was when the call came, once `release` is called. */
function slowResume(said: { messages: Frame[] }): { release(): void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  hermes.onResume = async () => {
    const then = structuredClone(said.messages);
    await gate;
    const now = said.messages;
    said.messages = then;
    setImmediate(() => (said.messages = now));
  };
  return { release: () => release() };
}

async function lookStarted(): Promise<void> {
  const before = hermes.callsOf("session.resume").length;
  hermes.broadcast("sessions.changed");
  await until(() => hermes.callsOf("session.resume").length > before);
}

async function threadTexts(phone: TestClient, kept: string): Promise<unknown[]> {
  return (await phone.call("session.resume", { session_id: kept, profile: "hermes" })).messages.map((message: Frame) => message.text);
}

test("a turn of the bridge's own that begins and ends while a look at the Bot Chat waits on Hermes is kept, and what was said elsewhere comes after it", async () => {
  const kept = "20261028_090000_b0tc5a";
  const { phone, said } = await botChatOnPhone(kept);
  said.messages.push({ role: "user", text: "What's on today?", timestamp: 1_761_000_101 }, { role: "assistant", text: "Two meetings.", timestamp: 1_761_000_102 });
  const look = slowResume(said);
  await lookStarted();

  // Meanwhile the phone's message runs a whole turn, which Hermes writes to its store.
  hermes.queueTurn(kept, "chat-text-complete");
  let start = phone.frames.length;
  assert.equal((await phone.call("prompt.submit", { session_id: kept, text: "Hello again", profile: "hermes" })).status, "streaming");
  await phone.from(start, (frame) => isEvent(frame, "message.complete", kept));
  said.messages.push({ role: "user", text: "Hello again", timestamp: 1_761_000_201 }, { role: "assistant", text: "Hello from Hermes!", timestamp: 1_761_000_202 });

  // The look's copy from before the turn is not taken.
  start = phone.frames.length;
  look.release();
  await new Promise((resolve) => setTimeout(resolve, 200));
  hermes.onResume = () => {};
  assert.equal(phone.frames.slice(start).some((frame) => isEvent(frame, "session.invalidated", kept)), false);

  // Hermes says it wrote the turn down: the store holds Hermes Desktop's turn as well, which is taken.
  start = phone.frames.length;
  hermes.broadcast("sessions.changed");
  await phone.from(start, (frame) => isEvent(frame, "session.invalidated", kept));
  assert.deepEqual(await threadTexts(phone, kept), ["Good morning", "Morning!", "What's on today?", "Two meetings.", "Hello again", "Hello from Hermes!"]);
});

test("a look the bridge turns down after Hermes answered it (an image attached meanwhile) is looked at again with the next change", async () => {
  const kept = "20261028_090000_b0tc5b";
  const { phone, said } = await botChatOnPhone(kept);
  said.messages.push({ role: "user", text: "What's on today?", timestamp: 1_761_000_101 }, { role: "assistant", text: "Two meetings.", timestamp: 1_761_000_102 });
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  hermes.onResume = () => gate;
  await lookStarted();
  // The person picks a photo for the next message while Hermes answers the look.
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  assert.equal((await phone.call("image.attach_bytes", { session_id: kept, content_base64: png, filename: "a.png", profile: "hermes" })).attached, true);
  let start = phone.frames.length;
  release();
  await new Promise((resolve) => setTimeout(resolve, 200));
  hermes.onResume = () => {};
  assert.equal(phone.frames.slice(start).some((frame) => isEvent(frame, "session.invalidated", kept)), false);

  // Then sends it, a turn of its own, which Hermes writes down in the moments after it.
  hermes.queueTurn(kept, "chat-text-complete");
  start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: kept, text: "Look at this", profile: "hermes" });
  await phone.from(start, (frame) => isEvent(frame, "message.complete", kept));
  said.messages.push({ role: "user", text: "Look at this", timestamp: 1_761_000_201 }, { role: "assistant", text: "Hello from Hermes!", timestamp: 1_761_000_202 });
  start = phone.frames.length;
  hermes.broadcast("sessions.changed");
  await phone.from(start, (frame) => isEvent(frame, "session.invalidated", kept));
  assert.ok((await threadTexts(phone, kept)).includes("What's on today?"));
});

test("what Hermes Desktop says in the Bot Chat while a turn of the bridge's own runs is taken once Hermes writes that turn down, and a turn of the bridge's own alone is not taken again", async () => {
  const kept = "20261028_090000_b0tc5c";
  const { phone, said } = await botChatOnPhone(kept);

  // A turn of the bridge's own alone: Hermes writing it down changes nothing on the devices.
  hermes.queueTurn(kept, "chat-text-complete");
  let start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: kept, text: "Hello", profile: "hermes" });
  await phone.from(start, (frame) => isEvent(frame, "message.complete", kept));
  said.messages.push({ role: "user", text: "Hello", timestamp: 1_761_000_051 }, { role: "assistant", text: "Hello from Hermes!", timestamp: 1_761_000_052 });
  start = phone.frames.length;
  const resumes = hermes.callsOf("session.resume").length;
  hermes.broadcast("sessions.changed");
  await until(() => hermes.callsOf("session.resume").length > resumes);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(phone.frames.slice(start).some((frame) => isEvent(frame, "session.invalidated", kept)), false);

  // A turn from the phone, waiting on a question, while Hermes Desktop's turn is written down.
  hermes.queueTurn(kept, "chat-clarify");
  start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: kept, text: "Ask me which language to use.", profile: "hermes" });
  const request = await phone.from(start, (frame) => frame.method === "clarify");
  said.messages.push({ role: "user", text: "What's on today?", timestamp: 1_761_000_101 }, { role: "assistant", text: "Two meetings.", timestamp: 1_761_000_102 });
  hermes.broadcast("sessions.changed");
  await new Promise((resolve) => setTimeout(resolve, 400));
  phone.send({ jsonrpc: "2.0", id: request.id, result: { answers: { q0: "Swift" } } });
  await phone.from(start, (frame) => isEvent(frame, "message.complete", kept));
  // Hermes writes the phone's turn and says its store changed.
  said.messages.push({ role: "user", text: "Ask me which language to use.", timestamp: 1_761_000_201 }, { role: "assistant", text: "You chose Swift.", timestamp: 1_761_000_202 });
  start = phone.frames.length;
  hermes.broadcast("sessions.changed");
  await phone.from(start, (frame) => isEvent(frame, "session.invalidated", kept));
  assert.ok((await threadTexts(phone, kept)).includes("What's on today?"));
});

test("when Hermes cannot say where the Bot Chat stood as it is opened, the first change made elsewhere is still taken", async () => {
  const kept = "20261028_090000_b0tc5d";
  // Hermes's list fails for a moment from the resume that opens the thread (a busy store).
  hermes.onResume = () => {
    hermes.listFails = { code: 5000, message: "database is locked" };
    setTimeout(() => (hermes.listFails = null), 30);
  };
  const { phone, said } = await botChatOnPhone(kept);
  hermes.onResume = () => {};
  hermes.listFails = null;
  said.messages.push({ role: "user", text: "What's on today?", timestamp: 1_761_000_101 }, { role: "assistant", text: "Two meetings.", timestamp: 1_761_000_102 });
  const start = phone.frames.length;
  hermes.broadcast("sessions.changed");
  await phone.from(start, (frame) => isEvent(frame, "session.invalidated", kept));
  assert.ok((await threadTexts(phone, kept)).includes("What's on today?"));
});

test("what Hermes Desktop writes in the Bot Chat just as the bridge reads it to open the thread is taken, not taken for where the thread began", async () => {
  const kept = "20261028_090000_b0tc5f";
  // Written once Hermes has answered the resume that opens the thread, before anything else is asked.
  let written = false;
  hermes.onResume = (params) => {
    if (written || params.session_id !== kept) return;
    written = true;
    setTimeout(() => hermes.sessions.get(kept)!.messages.push({ role: "user", text: "What's on today?", timestamp: 1_761_000_101 }), 0);
  };
  const { phone } = await botChatOnPhone(kept);
  hermes.onResume = () => {};
  assert.equal(written, true);
  hermes.broadcast("sessions.changed");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(await threadTexts(phone, kept), ["Good morning", "Morning!", "What's on today?"]);
});

test("a change Hermes tells of while a look at the Bot Chat is under way is looked at after it, and the devices told again", async () => {
  const kept = "20261028_090000_b0tc5e";
  const { phone, said } = await botChatOnPhone(kept);
  // Hermes Desktop: the person's message is written, then the reply a moment later.
  said.messages.push({ role: "user", text: "What's on today?", timestamp: 1_761_000_101 });
  const look = slowResume(said);
  const start = phone.frames.length;
  await lookStarted();
  said.messages.push({ role: "assistant", text: "Two meetings.", timestamp: 1_761_000_102 });
  hermes.broadcast("sessions.changed");
  await new Promise((resolve) => setTimeout(resolve, 400));
  hermes.onResume = () => {};
  look.release();
  await until(() => phone.frames.slice(start).filter((frame) => isEvent(frame, "session.invalidated", kept)).length >= 2);
  assert.deepEqual(await threadTexts(phone, kept), ["Good morning", "Morning!", "What's on today?", "Two meetings."]);
});

// Codex's review of the round 4 bridge fixes: a change is the bridge's own only when
// Hermes's copy shows the bridge's own messages, and nothing else, since it was last read.

async function invalidatedAfter(phone: TestClient, kept: string, start: number): Promise<void> {
  await phone.from(start, (frame) => isEvent(frame, "session.invalidated", kept));
}

test("Hermes Desktop's reply written in the moments after a turn of the bridge's own, after its message was taken in, is taken too", async () => {
  const kept = "20261028_090000_b0tc5g";
  const { phone, said } = await botChatOnPhone(kept);
  hermes.queueTurn(kept, "chat-text-complete");
  let start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: kept, text: "Hello", profile: "hermes" });
  await phone.from(start, (frame) => isEvent(frame, "message.complete", kept));
  said.messages.push({ role: "user", text: "Hello", timestamp: 1_761_000_051 }, { role: "assistant", text: "Hello from Hermes!", timestamp: 1_761_000_052 });
  hermes.broadcast("sessions.changed");
  await new Promise((resolve) => setTimeout(resolve, 400));

  // Hermes Desktop: the person's message, then its reply a moment later, both within 10 s of the phone's turn.
  said.messages.push({ role: "user", text: "What's on today?", timestamp: 1_761_000_101 });
  start = phone.frames.length;
  hermes.broadcast("sessions.changed");
  await invalidatedAfter(phone, kept, start);
  said.messages.push({ role: "assistant", text: "Two meetings.", timestamp: 1_761_000_102 });
  start = phone.frames.length;
  hermes.broadcast("sessions.changed");
  await invalidatedAfter(phone, kept, start);
  assert.equal((await threadTexts(phone, kept)).at(-1), "Two meetings.");
});

test("a turn said in Hermes Desktop just after a /compress of the bridge's own is taken, though the bridge holds the /compress Hermes does not keep", async () => {
  const kept = "20261028_090000_b0tc5h";
  const { phone, said } = await botChatOnPhone(kept);
  let start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: kept, text: "/compress", profile: "hermes" });
  await phone.from(start, (frame) => isEvent(frame, "message.complete", kept));
  said.messages.push({ role: "user", text: "What's on today?", timestamp: 1_761_000_101 }, { role: "assistant", text: "Two meetings.", timestamp: 1_761_000_102 });
  start = phone.frames.length;
  hermes.broadcast("sessions.changed");
  await invalidatedAfter(phone, kept, start);
  assert.ok((await threadTexts(phone, kept)).includes("Two meetings."));
});

test("a Bot Chat the bridge makes takes what Hermes Desktop wrote in it as it was made", async () => {
  // Written once Hermes has named the new session, before the bridge opens it.
  hermes.onTitle = () => {
    hermes.onTitle = () => {};
    setTimeout(() => {
      const made = [...hermes.sessions.values()].find((session) => session.title === botChatTitle);
      made?.messages.push({ role: "user", text: "What's on today?", timestamp: 1_761_000_101 });
    }, 0);
  };
  const { bridge } = await bridgeAndPhone();
  const phone = await TestClient.open(bridge, { capabilities: { session_resync: true } });
  open.unshift(phone);
  const thread = await create(phone);
  await until(() => hermes.sessions.get(thread)?.messages.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  hermes.broadcast("sessions.changed");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(await threadTexts(phone, thread), ["What's on today?"]);
});

test("a message Hermes refused is not the bridge's own when the person sends the same words in Hermes Desktop", async () => {
  // Codex's review of the round 4 bridge fixes: a refused message stayed among the bridge's own.
  const kept = "20261028_090000_b0tc5i";
  const { phone, said } = await botChatOnPhone(kept);
  // No turn queued: Hermes refuses the message.
  let start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: kept, text: "continue", profile: "hermes" });
  const done = await phone.from(start, (frame) => isEvent(frame, "message.complete", kept));
  assert.equal(done.params.payload.status, "error");
  said.messages.push({ role: "user", text: "continue", timestamp: 1_761_000_101 }, { role: "assistant", text: "Carrying on in Desktop.", timestamp: 1_761_000_102 });
  start = phone.frames.length;
  hermes.broadcast("sessions.changed");
  await invalidatedAfter(phone, kept, start);
  assert.ok((await threadTexts(phone, kept)).includes("Carrying on in Desktop."));
});
