import assert from "node:assert/strict";
import { test } from "node:test";
import { setLogLevel } from "../src/log.ts";
import { RequestBroker, type Follower } from "../src/sessions/broker.ts";
import { createThread, startTestBridge, TestClient } from "./helpers.ts";

// The broker on its own, with stand-in connections.

class StubFollower implements Follower {
  readonly takesRequests: boolean;
  readonly received: { id: string; method: string; params: Record<string, unknown> }[] = [];

  constructor(takesRequests = true) {
    this.takesRequests = takesRequests;
  }

  sendRequest(id: string, method: string, params: Record<string, unknown>): void {
    this.received.push({ id, method, params });
  }
}

function makeBroker(followers: Set<Follower>) {
  const closed: [string, string][] = [];
  const answeredBy: (Follower | undefined)[] = [];
  const details: (Record<string, unknown> | undefined)[] = [];
  const broker = new RequestBroker({
    sessionID: "s1",
    followers: () => followers,
    closed: (id, reason, by, more) => {
      closed.push([id, reason]);
      answeredBy.push(by);
      details.push(more);
    },
  });
  return { broker, closed, answeredBy, details };
}

test("a question goes only to followers that take questions", () => {
  const asking = new StubFollower();
  const silent = new StubFollower(false);
  const bystander = new StubFollower();
  const { broker } = makeBroker(new Set([asking, silent]));
  void broker.ask("approval", { command: "ls", choices: ["once", "deny"] });

  assert.equal(asking.received.length, 1);
  assert.equal(silent.received.length, 0);
  assert.equal(bystander.received.length, 0);
  const sent = asking.received[0];
  assert.match(sent.id, /^srq-[0-9a-f]{12}$/);
  assert.equal(sent.method, "approval");
  assert.deepEqual(sent.params, { session_id: "s1", command: "ls", choices: ["once", "deny"] });
  assert.deepEqual(broker.list(), [{ id: sent.id, method: "approval", params: sent.params }]);
});

test("a device a question cannot be sent to keeps none after it from having it: the question is still open and announced, and the failure is logged as an error", async (t) => {
  const failing: Follower = {
    takesRequests: true,
    sendRequest: () => {
      throw new Error("the device could not be sent it");
    },
  };
  const asking = new StubFollower();
  const opened: string[] = [];
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => lines.push(String(chunk)) > 0);
  setLogLevel("error");
  t.after(() => setLogLevel("silent"));
  const broker = new RequestBroker({ sessionID: "s1", followers: () => [failing, asking], closed: () => {}, opened: (request) => opened.push(request.id) });
  const answer = broker.ask("approval", { command: "ls", choices: ["once", "deny"] });

  assert.equal(asking.received.length, 1);
  const id = asking.received[0].id;
  assert.deepEqual(opened, [id]);
  assert.deepEqual(broker.list().map((request) => request.id), [id]);
  assert.equal(broker.answer(asking, id, { result: { choice: "once" } }), true);
  assert.deepEqual(await answer, { result: { choice: "once" } });
  const errors = lines.filter((line) => / error /.test(line));
  assert.equal(errors.length, 1);
  assert.match(errors[0], / error could not send a question to a device \{/);
  const fields = JSON.parse(errors[0].slice(errors[0].indexOf("{")));
  assert.deepEqual([fields.session, fields.method], ["s1", "approval"]);
  assert.match(fields.error, /^Error: the device could not be sent it\n\s+at /);
});

test("an open question is announced once, with nobody following too, but not one withdrawn before it was asked", async () => {
  const opened: { id: string; method: string; params: Record<string, unknown> }[] = [];
  const broker = new RequestBroker({ sessionID: "s1", followers: () => [], closed: () => {}, opened: (request) => opened.push(request) });
  void broker.ask("clarify", { questions: [{ qid: "q0", question: "Which?" }] });
  assert.deepEqual(opened, broker.list());
  assert.equal(opened[0].params.session_id, "s1");

  const aborted = new AbortController();
  aborted.abort("interrupted");
  assert.deepEqual(await broker.ask("approval", { command: "ls" }, aborted.signal), { withdrawn: "interrupted" });
  assert.equal(opened.length, 1);
});

test("the first answer wins and closes the question for everyone else", async () => {
  const phone = new StubFollower();
  const tablet = new StubFollower();
  const { broker, closed, answeredBy } = makeBroker(new Set([phone, tablet]));
  const asked = broker.ask("approval", { command: "ls" });
  const id = phone.received[0].id;

  assert.equal(broker.answer(tablet, id, { result: { choice: "deny" } }), true);
  assert.equal(broker.answer(phone, id, { result: { choice: "once" } }), false);
  assert.deepEqual(await asked, { result: { choice: "deny" } });
  assert.deepEqual(closed, [[id, "resolved"]]);
  // The tablet closed its own card; the others are told.
  assert.deepEqual(answeredBy, [tablet]);
  assert.deepEqual(broker.list(), []);
});

test("an answer for the thread that started the session, which follows nothing, wins as the first, and every follower is told by whom (feature agent_threads)", async () => {
  const phone = new StubFollower();
  const { broker, closed, answeredBy, details } = makeBroker(new Set([phone]));
  const asked = broker.ask("approval", { command: "ls" });
  const id = phone.received[0].id;

  const by = { by: "Claude Code", answer: { choice: "deny" } };
  assert.equal(broker.answerFor(id, { result: { choice: "deny" } }, by), true);
  assert.equal(broker.answerFor(id, { result: { choice: "once" } }, by), false);
  assert.equal(broker.answer(phone, id, { result: { choice: "once" } }), false);
  assert.deepEqual(await asked, { result: { choice: "deny" } });
  assert.deepEqual(closed, [[id, "resolved"]]);
  // No connection closed its own card: each is told.
  assert.deepEqual(answeredBy, [undefined]);
  assert.deepEqual(details, [by]);
  assert.equal(broker.answerFor("srq-unknown", { result: {} }, by), false);
});

test("an answer from a connection that does not follow the session is ignored", () => {
  const phone = new StubFollower();
  const stranger = new StubFollower();
  const { broker, closed } = makeBroker(new Set([phone]));
  void broker.ask("clarify", { questions: [] });
  const id = phone.received[0].id;
  assert.equal(broker.answer(stranger, id, { result: { answers: {} } }), false);
  assert.equal(broker.has(id), true);
  assert.deepEqual(closed, []);
});

test("a question stays open with nobody following, and is listed for whoever comes back", () => {
  const followers = new Set<Follower>();
  const { broker } = makeBroker(followers);
  void broker.ask("approval", { command: "ls" });
  const [open] = broker.list();
  assert.equal(open.method, "approval");

  // A connection that follows later is not sent the frame; it reads `open_requests`.
  const later = new StubFollower();
  followers.add(later);
  assert.equal(later.received.length, 0);
  assert.equal(broker.answer(later, open.id, { result: { choice: "once" } }), true);
});

test("a withdrawn question settles with its reason", async () => {
  const phone = new StubFollower();
  const { broker, closed } = makeBroker(new Set([phone]));
  const asked = broker.ask("approval", { command: "ls" });
  const controller = new AbortController();
  const second = broker.ask("approval", { command: "pwd" }, controller.signal);
  broker.withdraw(phone.received[0].id, "timeout");
  controller.abort("interrupted");
  assert.deepEqual(await asked, { withdrawn: "timeout" });
  assert.deepEqual(await second, { withdrawn: "interrupted" });
  assert.deepEqual(
    closed.map(([, reason]) => reason),
    ["timeout", "interrupted"],
  );
});

test("request ids are never reused", () => {
  const phone = new StubFollower();
  const { broker } = makeBroker(new Set([phone]));
  for (let index = 0; index < 200; index += 1) void broker.ask("approval", { command: "ls" });
  assert.equal(new Set(phone.received.map((request) => request.id)).size, 200);
});

// Through the gateway, with connections doing the app's handshake.

test("only the connections following a session are asked, and the first answer wins", async (t) => {
  const bridge = await startTestBridge();
  t.after(() => bridge.dispose());
  const creator = await TestClient.open(bridge);
  const bystander = await TestClient.open(bridge);
  const silent = await TestClient.open(bridge, { takesRequests: false });
  const session = await createThread(creator);

  await creator.call("prompt.submit", { session_id: session, text: "please approve", profile: "fake" });
  const request = await creator.nextRequest();
  assert.equal(request.method, "approval");
  assert.equal(request.params.session_id, session);
  assert.equal(request.params.command, "rm -rf ./fake-build");
  assert.deepEqual(request.params.choices, ["once", "session", "always", "deny"]);

  // Another phone resumes the session: it is not sent the frame, it reads open_requests.
  const resumer = await TestClient.open(bridge);
  const resumed = await resumer.call("session.resume", { session_id: session, profile: "fake", inline_images: false });
  assert.equal(resumed.running, true);
  assert.deepEqual(resumed.open_requests, [{ id: request.id, method: "approval", params: request.params }]);
  // The silent connection follows too, but said it answers no questions.
  await silent.call("session.resume", { session_id: session });

  // The resumer answers first; the creator is told, and its later answer changes nothing.
  resumer.answer(request.id, { choice: "deny" });
  const cancel = await creator.nextEvent("request.cancel", session);
  assert.deepEqual(cancel.payload, { id: request.id, reason: "resolved" });
  creator.answer(request.id, { choice: "once" });

  const done = await creator.nextEvent("message.complete", session);
  await resumer.nextEvent("message.complete", session);
  // The one that answered is not told live; the replay log has it for everyone.
  assert.equal(resumer.events(session).filter((event) => event.type === "request.cancel").length, 0);
  assert.equal(silent.events(session).filter((event) => event.type === "request.cancel").length, 1);
  const logged = await resumer.call("session.events.since", { session_id: session, last_seen: 0 });
  assert.deepEqual(
    logged.events.filter((event: { type: string }) => event.type === "request.cancel").map((event: { seq: number }) => event.seq),
    [cancel.seq],
  );
  assert.match(done.payload.text, /^You said no, so nothing ran\./);
  const run = creator.events(session).find((event) => event.type === "tool.complete");
  assert.equal(run.payload.result.status, "blocked");

  // Nobody else was asked.
  const asked = (client: TestClient) => client.frames.filter((frame) => frame.method === "approval").length;
  assert.equal(asked(bystander), 0);
  assert.equal(asked(silent), 0);
  assert.equal(asked(resumer), 0);
  assert.equal(bystander.events(session).length, 0);

  for (const client of [creator, bystander, silent, resumer]) await client.close();
});

test("a question outlives its connection and is answered after a resume", async (t) => {
  const bridge = await startTestBridge();
  t.after(() => bridge.dispose());
  const first = await TestClient.open(bridge);
  const session = await createThread(first);
  await first.call("prompt.submit", { session_id: session, text: "ask me", profile: "fake" });
  const request = await first.nextRequest();
  assert.equal(request.method, "clarify");
  assert.deepEqual(request.params.questions, [{ qid: "q0", question: "Which language should I use?", choices: ["Python", "Swift"], multi_select: false }]);
  await first.close();

  const second = await TestClient.open(bridge);
  const resumed = await second.call("session.resume", { session_id: session });
  assert.equal(resumed.running, true);
  assert.deepEqual(resumed.open_requests.map((open: { id: string }) => open.id), [request.id]);
  // Listed, not sent again.
  assert.equal(second.frames.filter((frame) => frame.method === "clarify").length, 0);
  const since = await second.call("session.events.since", { session_id: session, last_seen: 0 });
  assert.deepEqual(since.open_requests.map((open: { id: string }) => open.id), [request.id]);

  second.answer(request.id, { answers: { q0: "Swift" } });
  const done = await second.nextEvent("message.complete", session);
  assert.match(done.payload.text, /^You chose Swift\./);
  const after = await second.call("session.events.since", { session_id: session, last_seen: 0 });
  assert.deepEqual(after.open_requests, []);
  await second.close();
});
