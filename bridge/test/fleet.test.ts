import assert from "node:assert/strict";
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Fleet, type ThreadSummary } from "../src/fleet/fleet.ts";
import { Links, type LinkCallOptions } from "../src/fleet/links.ts";
import { Folders } from "../src/folders.ts";
import type { Provider, ProviderSession, SessionSink } from "../src/providers/types.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { Registry } from "../src/sessions/registry.ts";
import { createThread, isEvent, runTurn, startTestBridge, temporaryHome, TestClient, type Frame, type RpcFailure, type TestBridge } from "./helpers.ts";

// The fleet (docs/fleet-plan.md; docs/gateway-protocol.md, section 11): threads listed,
// read, sent to, waited for, started and stopped by a connection that does not follow
// them.

let bridge: TestBridge;

before(async () => {
  // Slow enough that a `slow` turn (8× this per word, about 70 words) is still running
  // when the next call arrives.
  bridge = await startTestBridge({ config: { fake: { delayMs: 3 } } });
});

after(() => bridge.dispose());

/**
 * A thread and two connections: `owner` made it and follows it, as the app does;
 * `other` never opens it.
 */
async function setUp(t: TestContext): Promise<{ owner: TestClient; other: TestClient; thread: string }> {
  const owner = await TestClient.open(bridge);
  const other = await TestClient.open(bridge);
  t.after(() => Promise.all([owner.close(), other.close()]));
  return { owner, other, thread: await createThread(owner) };
}

function isQuestion(frame: Frame): boolean {
  return typeof frame.id === "string" && frame.id.startsWith("srq-") && typeof frame.method === "string";
}

async function listed(client: TestClient, thread: string, params: Record<string, unknown> = {}): Promise<Frame | undefined> {
  const { threads } = await client.call("threads.list", params);
  return threads.find((entry: Frame) => entry.id === thread);
}

/** What a message sent through the fleet opens with when it names no thread it is from. */
const line = "[Portals: from the command line]";

/** The fake agent's reply to `text` sent through the fleet: it says back the first twelve words it was sent. */
function echo(text: string): string {
  const said = `${line} ${text}`.split(/\s+/).slice(0, 12).join(" ").replace(/[.!?]+$/, "");
  return `Hello from the fake agent. You said: ${said}.`;
}

const unknown = (error: RpcFailure) => error.code === 4007;
const invalid = (error: RpcFailure) => error.code === -32602;

test("gateway.ready lists the fleet feature", async (t) => {
  const { owner } = await setUp(t);
  assert.ok(owner.readyPayload.bridge.features.includes("fleet"));
});

test("threads.list lists a thread to a connection that never opened it, with what it is doing", async (t) => {
  const { owner, other, thread } = await setUp(t);
  await runTurn(owner, thread, "hello there");

  const idle = await listed(other, thread);
  assert.ok(idle);
  assert.equal(idle.agent, "fake");
  assert.equal(idle.agent_name, "Fake agent");
  assert.equal(idle.title, "Fake: hello there");
  assert.equal(idle.folder, realpathSync(tmpdir()));
  assert.equal(idle.state, "idle");
  assert.equal(typeof idle.updated, "number");

  await owner.call("prompt.submit", { session_id: thread, text: "slow please", profile: "fake" });
  assert.equal((await listed(other, thread))?.state, "working");
  assert.ok(await listed(other, thread, { state: "working" }));
  assert.equal(await listed(other, thread, { state: "idle" }), undefined);
  assert.ok(await listed(other, thread, { profile: "fake" }));
  assert.equal(await listed(other, thread, { profile: "nobody" }), undefined);
  await assert.rejects(other.call("threads.list", { state: "busy" }), invalid);
  await owner.call("session.interrupt", { session_id: thread, profile: "fake" });
});

test("a linked Mac returning 150,000 threads remains reachable and all its threads are listed", async (t) => {
  const home = temporaryHome();
  const providers = new Map<string, Provider>();
  const sessions = new SessionManager({ registry: new Registry(join(home, "threads.json")), providers });
  const url = "http://127.0.0.1:1";
  const links = new Links(join(home, "links.json"), { macs: () => [{ name: "archive", url }], token: () => "test-token" });
  const threads: ThreadSummary[] = Array.from({ length: 150_000 }, (_, index) => ({
    id: `t${index}`, agent: "fake", agent_name: "Fake", folder: "/w", state: "idle", updated: index,
  }));
  const frameBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: "c1", result: { threads } }));
  // Links' WebSocket clients accept 64 MiB. This is a valid response, not an oversized frame.
  assert.ok(frameBytes < 64 * 1024 * 1024);
  t.diagnostic(`The fake linked Mac's response is ${frameBytes} bytes, below the 64 MiB frame limit.`);
  t.mock.method(links, "call", async (name: string, method: string, params: Record<string, unknown>, _timeout: number, options: LinkCallOptions) => {
    assert.equal(name, "archive");
    assert.ok(method === "threads.delta" || method === "threads.list");
    assert.deepEqual(params, method === "threads.list" ? { local: true } : {});
    const reply = options.receive!({ threads }, "threads.list");
    assert.ok("result" in reply);
    return reply.result;
  });
  const fleet = new Fleet({ sessions, providers, folders: new Folders({ general: home, hide: [], own: [], sources: [] }), links, here: { id: "0123456789abcdef", name: "Test Mac" } });
  t.after(async () => {
    fleet.close();
    await sessions.close();
    rmSync(home, { recursive: true, force: true });
  });

  const listed = await fleet.everyThread();
  assert.deepEqual(listed.machines, [{ name: "archive", url, reachable: true }]);
  assert.equal(listed.threads.length, threads.length);
  assert.deepEqual(listed.threads[0], { ...threads.at(-1), id: "archive/t149999", machine: "archive" });
  assert.deepEqual(listed.threads.at(-1), { ...threads[0], id: "archive/t0", machine: "archive" });
});

for (const malformed of ["not a thread list", [{ id: "partial", agent: "fake", state: "idle", updated: 2 }, null]]) {
  test(`a malformed linked-Mac ${typeof malformed === "string" ? "list" : "row"} contributes no partial threads and leaves healthy Macs listed`, async (t) => {
    const home = temporaryHome();
    const providers = new Map<string, Provider>();
    const sessions = new SessionManager({ registry: new Registry(join(home, "threads.json")), providers });
    const url = "http://127.0.0.1:1";
    const links = new Links(join(home, "links.json"), {
      macs: () => [{ name: "broken", url }, { name: "healthy", url }], token: () => "test-token",
    });
    const thread: ThreadSummary = { id: "whole", agent: "fake", agent_name: "Fake", folder: "/w", state: "idle", updated: 1 };
    t.mock.method(links, "call", async (name: string, _method: string, _params: unknown, _timeout: number, options: LinkCallOptions) => {
      const reply = options.receive!({ threads: name === "broken" ? malformed : [thread] }, "threads.list");
      assert.ok("result" in reply);
      return reply.result;
    });
    const fleet = new Fleet({ sessions, providers, folders: new Folders({ general: home, hide: [], own: [], sources: [] }), links, here: { id: "0123456789abcdef", name: "Test Mac" } });
    t.after(async () => {
      fleet.close();
      await sessions.close();
      rmSync(home, { recursive: true, force: true });
    });

    const listed = await fleet.everyThread();
    assert.equal(listed.machines?.[0].reachable, false);
    assert.equal(typeof listed.machines?.[0].error, "string");
    assert.deepEqual(listed.machines?.[1], { name: "healthy", url, reachable: true });
    assert.deepEqual(listed.threads, [{ ...thread, id: "healthy/whole", machine: "healthy" }]);
  });
}

test("threads.list lists a thread from an earlier run without loading it, and thread.read loads it", async (t) => {
  const first = await startTestBridge({ keepHome: true });
  const before = await TestClient.open(first);
  const thread = await createThread(before);
  await runTurn(before, thread, "remember this");
  await before.close();
  await first.dispose();

  const second = await startTestBridge({ home: first.home });
  const client = await TestClient.open(second);
  t.after(async () => {
    await client.close();
    await second.dispose();
  });

  const entry = await listed(client, thread);
  assert.equal(entry?.state, "idle");
  assert.equal(entry?.title, "Fake: remember this");
  // Not loaded by being listed: the bridge has no events of it to replay.
  assert.equal((await client.call("session.events.since", { session_id: thread, last_seen: 0, profile: "fake" })).truncated, true);

  const reading = await client.call("thread.read", { thread });
  assert.equal(reading.messages[0].text, "remember this");
  assert.equal(reading.messages.at(-1).text, "Hello from the fake agent. You said: remember this.");
});

test("thread.read gives the last turns and the turn in progress, and does not follow the thread", async (t) => {
  const { owner, other, thread } = await setUp(t);
  await runTurn(owner, thread, "first");
  await runTurn(owner, thread, "second");

  const one = await other.call("thread.read", { thread });
  assert.equal(one.thread.id, thread);
  assert.deepEqual(one.messages.map((message: Frame) => message.role), ["user", "assistant"]);
  assert.equal(one.messages[0].text, "second");
  assert.equal(one.messages[1].text, "Hello from the fake agent. You said: second.");
  assert.deepEqual(one.open_requests, []);
  assert.equal(one.inflight, undefined);

  const two = await other.call("thread.read", { thread, last: 2 });
  assert.deepEqual(two.messages.map((message: Frame) => message.text).filter((text: string) => !text.startsWith("Hello")), ["first", "second"]);
  // More turns than there are is all of them.
  assert.equal((await other.call("thread.read", { thread, last: 50 })).messages.length, 4);
  await assert.rejects(other.call("thread.read", { thread, last: 0 }), invalid);

  await owner.call("prompt.submit", { session_id: thread, text: "slow please", profile: "fake" });
  const running = await other.call("thread.read", { thread });
  assert.equal(running.thread.state, "working");
  assert.equal(running.inflight.user, "slow please");
  assert.equal(running.messages.at(-1).text, "slow please");
  await owner.call("session.interrupt", { session_id: thread, profile: "fake" });

  assert.deepEqual(other.events(thread), [], "reading made the connection a follower");
});

test("thread.read leaves out the reasoning of the turn in progress, which session.resume keeps", async (t) => {
  const { owner, other, thread } = await setUp(t);
  await owner.call("prompt.submit", { session_id: thread, text: "think slowly please", profile: "fake" });
  // Its reply has begun: the reasoning before it is not stored yet, only held for the turn.
  await owner.nextEvent("message.delta", thread);
  const resumed = await owner.call("session.resume", { session_id: thread, profile: "fake" });
  assert.match(resumed.inflight.reasoning, /think first/);
  const reading = await other.call("thread.read", { thread });
  assert.equal(reading.inflight.user, "think slowly please");
  assert.equal(typeof reading.inflight.assistant, "string");
  assert.equal("reasoning" in reading.inflight, false);
  await owner.call("session.interrupt", { session_id: thread, profile: "fake" });
});

test("thread.send starts a turn the thread's followers see, and thread.wait answers with its reply", async (t) => {
  const { owner, other, thread } = await setUp(t);
  const start = owner.frames.length;

  assert.deepEqual(await other.call("thread.send", { thread, text: "hello from elsewhere" }), { status: "streaming" });
  const rest = await other.call("thread.wait", { thread });
  const done = await owner.from(start, (frame) => isEvent(frame, "message.complete", thread));

  assert.equal(rest.state, "idle");
  assert.equal(rest.timed_out, false);
  assert.equal(rest.reply, echo("hello from elsewhere"));
  assert.equal(rest.reply, done.params.payload.text);
  assert.deepEqual(rest.open_requests, []);
  assert.ok(owner.frames.slice(start).some((frame) => isEvent(frame, "message.start", thread)));
  assert.deepEqual(other.events(thread), [], "sending made the connection a follower");

  // Already at rest: answered at once, with the same reply.
  assert.equal((await other.call("thread.wait", { thread })).reply, rest.reply);
});

test("thread.send with wait answers in one call", async (t) => {
  const { other, thread } = await setUp(t);
  const result = await other.call("thread.send", { thread, text: "one call", wait: true });
  assert.equal(result.status, "streaming");
  assert.equal(result.state, "idle");
  assert.equal(result.reply, echo("one call"));
});

test("a thread asking leave is blocked, takes no answer from a connection that does not follow it, and goes on once a follower answers", async (t) => {
  const { owner, other, thread } = await setUp(t);
  const start = owner.frames.length;

  const blocked = await other.call("thread.send", { thread, text: "approve this", wait: true });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.kind, "permission");
  assert.equal(blocked.timed_out, false);
  assert.equal(blocked.open_requests.length, 1);
  assert.equal(blocked.open_requests[0].method, "approval");
  assert.equal((await listed(other, thread, { state: "blocked" }))?.kind, "permission");

  const request = await owner.from(start, isQuestion);
  assert.equal(request.id, blocked.open_requests[0].id);
  other.answer(request.id, { choice: "once" });
  assert.equal((await other.call("thread.wait", { thread })).state, "blocked");

  owner.answer(request.id, { choice: "once" });
  await owner.from(start, (frame) => isEvent(frame, "tool.complete", thread));
  const rest = await other.call("thread.wait", { thread });
  assert.equal(rest.state, "idle");
  assert.equal(rest.reply, `The command ran. ${echo("approve this")}`);
});

test("a thread with a question is blocked on a question", async (t) => {
  const { owner, other, thread } = await setUp(t);
  const start = owner.frames.length;

  const blocked = await other.call("thread.send", { thread, text: "ask me", wait: true });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.kind, "question");
  assert.equal(blocked.open_requests[0].method, "clarify");

  const request = await owner.from(start, isQuestion);
  owner.answer(request.id, { answers: { q0: "Swift" } });
  await owner.from(start, (frame) => isEvent(frame, "tool.complete", thread));
  assert.match((await other.call("thread.wait", { thread })).reply, /^You chose Swift\./);
});

test("a failed turn leaves the thread in error, with why, until its next turn", async (t) => {
  const { other, thread } = await setUp(t);

  const failed = await other.call("thread.send", { thread, text: "fail now", wait: true });
  assert.equal(failed.state, "error");
  assert.equal(failed.reply, "The fake agent failed on purpose.");
  assert.ok(await listed(other, thread, { state: "error" }));

  assert.equal((await other.call("thread.send", { thread, text: "again", wait: true })).state, "idle");
  assert.equal((await listed(other, thread))?.state, "idle");
});

test("thread.stop interrupts the running turn", async (t) => {
  const { other, thread } = await setUp(t);
  await other.call("thread.send", { thread, text: "slow please" });

  assert.deepEqual(await other.call("thread.stop", { thread }), { stopped: true });
  assert.equal((await other.call("thread.wait", { thread })).state, "idle");
  assert.deepEqual(await other.call("thread.stop", { thread }), { stopped: false });
});

test("thread.wait gives up when the time is up, and says the thread is still working", async (t) => {
  const { other, thread } = await setUp(t);
  await other.call("thread.send", { thread, text: "slow please" });

  const waited = await other.call("thread.wait", { thread, timeout_ms: 20 });
  assert.equal(waited.timed_out, true);
  assert.equal(waited.state, "working");
  await other.call("thread.stop", { thread });
});

test("a message sent while the thread works is queued, and the wait is for its own turn", async (t) => {
  const { other, thread } = await setUp(t);
  await other.call("thread.send", { thread, text: "slow please" });

  const second = await other.call("thread.send", { thread, text: "then this", wait: true });
  assert.equal(second.status, "queued");
  assert.equal(second.state, "idle");
  assert.equal(second.reply, echo("then this"));
});

test("a device that opens a thread while a fleet message runs and another waits is told who sent each (feature senders)", async (t) => {
  const { owner, other, thread } = await setUp(t);
  const sender = await createThread(owner);
  await other.call("thread.send", { thread, text: "slow please", from: sender });
  assert.equal((await other.call("thread.send", { thread, text: "then this" })).status, "queued");
  const resumed = await owner.call("session.resume", { session_id: thread, profile: "fake" });
  const from = { agent: "fake", agent_name: "Fake agent", thread: sender };
  assert.deepEqual(resumed.inflight.from, from);
  assert.deepEqual(resumed.queued.map((queued: Frame) => queued.from), [{}]);
  await other.call("thread.stop", { thread });
});

test("thread.start makes a thread nobody follows and runs its first message", async (t) => {
  const { owner, other } = await setUp(t);

  const started = await other.call("thread.start", { profile: "fake", text: "start here", wait: true });
  assert.equal(started.thread.agent, "fake");
  // Titled by what it says, not by the line saying who sent it.
  assert.equal(started.thread.title, "Fake: start here");
  assert.equal(started.status, "streaming");
  assert.equal(started.state, "idle");
  assert.equal(started.reply, echo("start here"));
  assert.ok(await listed(other, started.thread.id));
  assert.deepEqual(other.events(started.thread.id), [], "starting made the connection a follower");

  // It is a thread like any other: the app can open it.
  const snapshot = await owner.call("session.resume", { session_id: started.thread.id, profile: "fake", inline_images: false });
  assert.equal(snapshot.messages[0].text, `${line}\nstart here`);

  // With no message it only makes the thread.
  const empty = await other.call("thread.start", { profile: "fake", title: "For later" });
  assert.deepEqual(Object.keys(empty), ["thread", "tells_starter"]);
  assert.equal(empty.thread.title, "For later");
  assert.equal(empty.thread.state, "idle");

  await assert.rejects(other.call("thread.start", { profile: "fake", cwd: "/no/such/folder" }), invalid);
  await assert.rejects(other.call("thread.start", { profile: "nobody" }), invalid);
});

test("a message sent through the fleet opens with a line saying it is not the user's, and which thread it is from", async (t) => {
  const { owner, other, thread } = await setUp(t);
  const sender = await createThread(owner);
  await runTurn(owner, sender, "hi there");

  await other.call("thread.send", { thread, text: "from a thread", from: sender, wait: true });
  await other.call("thread.send", { thread, text: "from nobody known", from: "no-such-thread", wait: true });
  await other.call("thread.send", { thread, text: "from the shell", wait: true });
  const sent = (await other.call("thread.read", { thread, last: 3 })).messages.filter((message: Frame) => message.role === "user").map((message: Frame) => message.text);
  assert.deepEqual(sent, [
    `[Portals: from Fake agent · "Fake: hi there" (thread ${sender})]\nfrom a thread`,
    `${line}\nfrom nobody known`,
    `${line}\nfrom the shell`,
  ]);

  // The app's own messages are the user's, and say nothing more.
  await runTurn(owner, thread, "from the person");
  assert.equal((await other.call("thread.read", { thread })).messages[0].text, "from the person");

  await assert.rejects(other.call("thread.send", { thread, text: "to myself", from: thread }), invalid);
});

test("a thread the bridge does not know, and an empty message, are refused", async (t) => {
  const { other, thread } = await setUp(t);
  await assert.rejects(other.call("thread.read", { thread: "no-such-thread" }), unknown);
  await assert.rejects(other.call("thread.send", { thread: "no-such-thread", text: "hi" }), unknown);
  await assert.rejects(other.call("thread.wait", { thread: "no-such-thread" }), unknown);
  await assert.rejects(other.call("thread.stop", { thread: "no-such-thread" }), unknown);
  await assert.rejects(other.call("thread.send", { thread, text: "  " }), invalid);
  await assert.rejects(other.call("thread.send", { thread }), invalid);
});

test("a fleet message opens its turn by itself for the app, and leaves the person's attached images alone", async (t) => {
  const { owner, other, thread } = await setUp(t);
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  assert.equal((await owner.call("image.attach_bytes", { session_id: thread, content_base64: png.toString("base64"), filename: "mine.png" })).attached, true);

  const start = owner.frames.length;
  await other.call("thread.send", { thread, text: "from the fleet", wait: true });
  const opened = await owner.from(start, (frame) => isEvent(frame, "message.start", thread));
  // From the command line of this Mac, as facts too (feature senders): no agent, thread or Mac.
  assert.deepEqual(opened.params.payload, { opened_by: "portals", text: `${line}\nfrom the fleet`, sender: "portals", from: {} });
  assert.doesNotMatch((await other.call("thread.read", { thread })).messages.at(-2).text, /@image/);

  // The person's own message still has their image, and its turn opens as any does: with
  // that message, sent by the user (feature turn_messages), not opened by Portals.
  const own = owner.frames.length;
  await runTurn(owner, thread, "with my picture");
  assert.deepEqual((await owner.from(own, (frame) => isEvent(frame, "message.start", thread))).params.payload, { text: "with my picture\n@image:mine.png", sender: "user" });
  assert.match((await other.call("thread.read", { thread })).messages.at(-2).text, /@image:/);
});

test("a wait after a message the agent turns down as its turn ends waits for that message's own turn", async (t) => {
  // An agent like Codex: its turn can end before it says it did not take the message.
  const home = temporaryHome();
  let turns = 0;
  const settings = { model: "stub", provider: "stub", reasoningEffort: "" };
  const provider = {
    profile: { name: "stub", displayName: "Stub", description: "", model: "stub", provider: "stub" },
    async startSession(_options: unknown, sink: SessionSink): Promise<ProviderSession> {
      return {
        history: async () => [],
        settings: () => settings,
        startTurn() {
          const turn = ++turns;
          setTimeout(() => {
            sink.emit({ type: "text", text: `answer ${turn}` });
            sink.emit({ type: "turn.end", status: "complete" });
          }, 20);
        },
        steer: async () => {
          await sleep(70);
          return false;
        },
        interrupt: async () => false,
        close: async () => {},
      } as unknown as ProviderSession;
    },
  } as unknown as Provider;
  const providers = new Map<string, Provider>([["stub", provider]]);
  const sessions = new SessionManager({ registry: new Registry(join(home, "threads.json")), providers });
  const fleet = new Fleet({ sessions, providers, folders: new Folders({ general: home, hide: [], own: [], sources: [] }), links: new Links(join(home, "links.json")), here: { id: "0123456789abcdef", name: "Test Mac" } });
  t.after(async () => {
    fleet.close();
    await sessions.close();
    rmSync(home, { recursive: true, force: true });
  });

  const session = await sessions.create({ agent: "stub", cwd: home, title: null, settings });
  await fleet.send(session.id, "first");
  assert.equal((await fleet.send(session.id, "second")).status, "steered");
  const rest = await fleet.wait(session.id, 5000);
  assert.equal(rest.timed_out, false);
  assert.equal(rest.reply, "answer 2");
  assert.equal(turns, 2);
});

test("a wait that runs out while the thread is still answering gives what it has said so far", async (t) => {
  const { other, thread } = await setUp(t);
  await other.call("thread.send", { thread, text: "slow please" });
  await sleep(300);
  const rest = await other.call("thread.wait", { thread, timeout_ms: 50 });
  assert.equal(rest.timed_out, true);
  assert.equal(rest.state, "working");
  assert.match(rest.reply, /^This is a long reply from the fake agent/);
  await other.call("thread.stop", { thread });
});

