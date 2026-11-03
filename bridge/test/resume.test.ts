import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { replayLimit } from "../src/sessions/session.ts";
import { createThread, isEvent, runTurn, startTestBridge, streamedText, TestClient, type Frame, type TestBridge } from "./helpers.ts";

// Resuming, reconnecting and replaying (docs/gateway-protocol.md, section 8).

let bridge: TestBridge;

before(async () => {
  // Slow enough that a `slow` turn (8× this per word, about 70 words) is still running
  // while a second client connects.
  bridge = await startTestBridge({ config: { fake: { delayMs: 3 } } });
});

after(() => bridge.dispose());

/** Waits until `client` has seen `count` deltas of `session`. */
async function deltas(client: TestClient, session: string, count: number): Promise<void> {
  await client.find(() => client.events(session).filter((event) => event.type === "message.delta").length >= count);
}

function seqs(events: Frame[]): number[] {
  return events.map((event) => event.seq);
}

test("session.resume answers before any event of the session, and the snapshot and the live events meet exactly", async (t) => {
  const first = await TestClient.open(bridge);
  const session = await createThread(first);
  t.after(() => first.close());
  await first.call("prompt.submit", { session_id: session, text: "slow please", profile: "fake" });
  await deltas(first, session, 3);

  const second = await TestClient.open(bridge);
  t.after(() => second.close());
  const start = second.frames.length;
  const response = await second.request("session.resume", { session_id: session, profile: "fake", inline_images: false });
  const replyIndex = second.frames.indexOf(response);
  const firstEvent = second.frames.findIndex((frame, index) => index >= start && frame.method === "event" && frame.params.session_id === session);
  assert.ok(firstEvent === -1 || firstEvent > replyIndex, "an event of the session arrived before the resume answer");

  const snapshot = response.result;
  assert.equal(snapshot.session_id, session);
  assert.equal(snapshot.running, true);
  assert.deepEqual(snapshot.inflight.user, "slow please");
  assert.ok(snapshot.inflight.assistant.length > 0);
  // The user's message is stored as soon as its turn starts, exactly as inflight names it.
  assert.deepEqual(snapshot.messages.at(-1).role, "user");
  assert.deepEqual(snapshot.messages.at(-1).text, "slow please");
  assert.deepEqual(snapshot.open_requests, []);
  assert.equal(snapshot.info.running, true);

  const done = await second.from(start, (frame) => isEvent(frame, "message.complete", session), 15_000);
  const live = second.events(session);
  // What the snapshot had, then what came live: the whole reply, nothing twice.
  assert.equal(snapshot.inflight.assistant + streamedText(live), done.params.payload.text);
  // The live events are numbered one by one, and the same as on the first connection.
  const numbers = seqs(live);
  assert.deepEqual(numbers, numbers.map((_, index) => numbers[0] + index));
  const onFirst = first.events(session).filter((event) => event.seq >= numbers[0]);
  assert.deepEqual(onFirst, live);
});

test("a dropped connection catches up with session.events.since and misses nothing", async (t) => {
  const first = await TestClient.open(bridge);
  const session = await createThread(first);
  await first.call("prompt.submit", { session_id: session, text: "slow please", profile: "fake" });
  await deltas(first, session, 4);
  const seen = first.events(session);
  const lastSeen = seen.at(-1).seq;
  await first.close();

  // The app reconnects: same epoch, so resume, then fetch what it missed.
  const second = await TestClient.open(bridge);
  t.after(() => second.close());
  assert.equal(second.readyPayload.replay_epoch, first.readyPayload.replay_epoch);
  const resumed = await second.call("session.resume", { session_id: session, profile: "fake", inline_images: false });
  assert.equal(resumed.session_id, session);
  assert.equal(resumed.running, true);
  const since = await second.call("session.events.since", { session_id: session, last_seen: lastSeen, profile: "fake" });
  assert.equal(since.truncated, false);
  assert.deepEqual(since.open_requests, []);
  assert.ok(since.latest_seq >= lastSeen);
  assert.equal(since.events[0]?.seq ?? lastSeen + 1, lastSeen + 1);

  // Apply as the app does: in order, skipping anything not above the last applied seq.
  await second.find((frame) => isEvent(frame, "message.complete", session), 15_000);
  let applied = lastSeen;
  let text = streamedText(seen);
  const complete: Frame[] = [];
  for (const event of [...since.events, ...second.events(session)]) {
    if (event.seq <= applied) continue;
    assert.equal(event.seq, applied + 1, "a gap between the replay and the live events");
    applied = event.seq;
    if (event.type === "message.delta") text += event.payload.text;
    if (event.type === "message.complete") complete.push(event);
  }
  assert.equal(complete.length, 1);
  assert.equal(text, complete[0].payload.text);
});

test("a session keeps running when every connection is gone", async (t) => {
  const first = await TestClient.open(bridge);
  const session = await createThread(first);
  await first.call("prompt.submit", { session_id: session, text: "slow please", profile: "fake" });
  await deltas(first, session, 2);
  await first.close();

  const second = await TestClient.open(bridge);
  t.after(() => second.close());
  const resumed = await second.call("session.resume", { session_id: session });
  if (resumed.running) await second.nextEvent("message.complete", session, 15_000);
  const later = await second.call("session.resume", { session_id: session });
  assert.equal(later.running, false);
  assert.equal(later.inflight, undefined);
  const reply = later.messages.at(-1);
  assert.equal(reply.role, "assistant");
  assert.match(reply.text, /That is the end of the long reply\.$/);
});

test("a log that no longer reaches back says truncated, so the app takes a snapshot", async (t) => {
  const small = await startTestBridge({ logCapacity: 5 });
  t.after(() => small.dispose());
  const client = await TestClient.open(small);
  t.after(() => client.close());
  const session = await createThread(client);
  const events = await runTurn(client, session, "hello there friend");
  const latest = events.at(-1).seq;
  assert.ok(latest > 5);

  assert.deepEqual(await client.call("session.events.since", { session_id: session, last_seen: 0 }), {
    events: [],
    truncated: true,
    latest_seq: latest,
    open_requests: [],
  });
  const recent = await client.call("session.events.since", { session_id: session, last_seen: latest - 2 });
  assert.equal(recent.truncated, false);
  assert.deepEqual(seqs(recent.events), [latest - 1, latest]);
  assert.deepEqual(recent.events, events.slice(-2));
  assert.deepEqual((await client.call("session.events.since", { session_id: session, last_seen: latest })).events, []);
});

test("after a restart the epoch is new and a thread comes back from its stored history", async (t) => {
  const before = await startTestBridge({ keepHome: true });
  const client = await TestClient.open(before);
  const session = await createThread(client, { title: "Before the restart" });
  await runTurn(client, session, "use a tool please");
  await client.close();
  await before.dispose();

  const after = await startTestBridge({ home: before.home });
  t.after(() => after.dispose());
  assert.notEqual(after.replayEpoch, before.replayEpoch);
  const again = await TestClient.open(after);
  t.after(() => again.close());
  const resumed = await again.call("session.resume", { session_id: session, profile: "fake", inline_images: false });
  assert.equal(resumed.session_id, session);
  assert.equal(resumed.running, false);
  assert.equal(resumed.info.title, "Fake: use a tool please");
  assert.deepEqual(
    resumed.messages.map((message: Frame) => [message.role, message.name ?? null]),
    [
      ["user", null],
      ["assistant", null],
      ["tool", "patch"],
      ["tool", "terminal"],
      ["assistant", null],
    ],
  );

  // The thread carries on where it was.
  const events = await runTurn(again, session, "and again");
  assert.equal(events[0].type, "message.start");
  assert.equal(events.at(-1).payload.status, "complete");
  const later = await again.call("session.resume", { session_id: session });
  assert.equal(later.messages.length, 7);
});

// MARK: Feature resume_replay

/**
 * What a device that holds `session` up to event `since`, numbered in `epoch`, resumes it
 * with: `base` where the replay of the conversation it took began, 0 for a thread made
 * here with `session.create` and nothing said before it, whose replay begins with its
 * conversation (the app takes it from the answer it took the thread whole with).
 */
function resumeFrom(session: string, since: number, epoch: string, base = 0): Record<string, unknown> {
  return { session_id: session, profile: "fake", inline_images: false, since, replay_epoch: epoch, replay_base: base };
}

test("a resume from an event of this run answers with the events missed in place of the conversation, and they meet the live events with no gap and nothing twice", async (t) => {
  const first = await TestClient.open(bridge);
  const session = await createThread(first);
  // A conversation longer than the events missed, which go in its place.
  await runTurn(first, session, "bench instant");
  const earlier = first.events(session).length;
  await first.call("prompt.submit", { session_id: session, text: "slow please", profile: "fake" });
  await first.find(() => first.events(session).slice(earlier).filter((event) => event.type === "message.delta").length >= 4);
  const seen = first.events(session).slice(earlier);
  const lastSeen = seen.at(-1).seq;
  await first.close();
  // The turn goes on while no device follows it.
  await sleep(60);

  const second = await TestClient.open(bridge);
  t.after(() => second.close());
  const start = second.frames.length;
  const response = await second.request("session.resume", resumeFrom(session, lastSeen, second.readyPayload.replay_epoch));
  const replyIndex = second.frames.indexOf(response);
  const firstEvent = second.frames.findIndex((frame, index) => index >= start && frame.method === "event" && frame.params.session_id === session);
  assert.ok(firstEvent === -1 || firstEvent > replyIndex, "an event of the session arrived before the resume answer");

  const answer = response.result;
  assert.equal(answer.replayed, true);
  assert.equal(answer.session_id, session);
  assert.equal(answer.running, true);
  assert.equal(answer.messages, undefined);
  assert.equal(answer.inflight, undefined);
  assert.deepEqual(answer.open_requests, []);
  assert.equal(answer.info.running, true);
  assert.equal(answer.info.model, "fake-1");
  assert.ok(answer.events.length > 0, "nothing was missed");
  assert.equal(answer.events[0].seq, lastSeen + 1);
  assert.equal(answer.latest_seq, answer.events.at(-1).seq);
  // Each as it went out live: the params of the event frame.
  assert.deepEqual(Object.keys(answer.events[0]).sort(), ["payload", "seq", "session_id", "type"]);

  // The replay, then what comes live: one after the other, with no number skipped or said twice.
  const done = await second.from(start, (frame) => isEvent(frame, "message.complete", session), 15_000);
  let applied = lastSeen;
  for (const event of [...answer.events, ...second.events(session)]) {
    assert.equal(event.seq, applied + 1, "a gap or an event twice between the replay and the live events");
    applied = event.seq;
  }
  assert.equal(streamedText([...seen, ...answer.events, ...second.events(session)]), done.params.payload.text);
});

test("a resume from the last event a device applied, with nothing missed, answers with no events and follows the thread", async (t) => {
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const session = await createThread(client);
  const last = (await runTurn(client, session, "hello there")).at(-1).seq;
  const other = await TestClient.open(bridge);
  t.after(() => other.close());
  const answer = await other.call("session.resume", resumeFrom(session, last, other.readyPayload.replay_epoch));
  assert.deepEqual(
    { replayed: answer.replayed, events: answer.events, latest_seq: answer.latest_seq, running: answer.running, messages: answer.messages },
    { replayed: true, events: [], latest_seq: last, running: false, messages: undefined },
  );
  // Followed from then on, as with the whole answer.
  const turn = await runTurn(client, session, "and again");
  await other.find((frame) => isEvent(frame, "message.complete", session));
  assert.deepEqual(other.events(session), turn);
  assert.equal(turn[0].seq, last + 1);
});

test("a resume that cannot be replayed is the whole answer: another run's epoch, a number never given out, one the log no longer reaches, a conversation taken where the replay began elsewhere, or a since without an epoch or a base", async (t) => {
  const small = await startTestBridge({ logCapacity: 5 });
  t.after(() => small.dispose());
  const client = await TestClient.open(small);
  t.after(() => client.close());
  const session = await createThread(client);
  // A conversation longer than the events missed, for the light answer at the end.
  await runTurn(client, session, "bench instant");
  const events = await runTurn(client, session, "hello there friend");
  const latest = events.at(-1).seq;
  assert.ok(latest > 6);
  const epoch = client.readyPayload.replay_epoch;
  const whole = await client.call("session.resume", { session_id: session, profile: "fake", inline_images: false });
  const wholeKeys = Object.keys(whole).sort();
  assert.deepEqual(wholeKeys, ["info", "latest_seq", "messages", "open_requests", "running", "session_id"]);

  // As an older app is answered, unless it names this run: then also where the replay of
  // what it now holds begins, which it sends back with its next since.
  const asked: [string, Record<string, unknown>, string[]][] = [
    ["another run", resumeFrom(session, latest - 1, "8a9e048c70014c77aef21efa5a9a90ee"), wholeKeys],
    ["a since without an epoch", { session_id: session, profile: "fake", since: latest - 1, replay_base: 0 }, wholeKeys],
    ["a number never given out", resumeFrom(session, latest + 3, epoch), [...wholeKeys, "replay_base"].sort()],
    ["one the log no longer reaches", resumeFrom(session, 1, epoch), [...wholeKeys, "replay_base"].sort()],
    ["another base", resumeFrom(session, latest - 1, epoch, 3), [...wholeKeys, "replay_base"].sort()],
    ["a since without a base", { session_id: session, profile: "fake", since: latest - 1, replay_epoch: epoch }, [...wholeKeys, "replay_base"].sort()],
    ["an epoch without a since", { session_id: session, profile: "fake", replay_epoch: epoch, replay_base: 0 }, [...wholeKeys, "replay_base"].sort()],
  ];
  for (const [why, params, keys] of asked) {
    const answer = await client.call("session.resume", params);
    assert.deepEqual(Object.keys(answer).sort(), keys, why);
    assert.deepEqual(answer.messages, whole.messages, why);
    if (keys.includes("replay_base")) assert.equal(answer.replay_base, 0, why);
  }
  // And within the log, the light one.
  const light = await client.call("session.resume", resumeFrom(session, latest - 2, epoch));
  assert.deepEqual(light.events, events.slice(-2));
  assert.equal(light.replay_base, 0);
});

test("a device more events behind than the limit takes the whole thread", async (t) => {
  const quick = await startTestBridge({ config: { fake: { delayMs: 0 } } });
  t.after(() => quick.dispose());
  const client = await TestClient.open(quick);
  t.after(() => client.close());
  const session = await createThread(client);
  // A conversation longer than the events at the limit, which then go in its place.
  for (let turn = 0; turn < 6; turn += 1) await runTurn(client, session, "bench instant");
  const earlier = client.events(session).at(-1).seq;
  let latest = 0;
  while (latest <= earlier + replayLimit) latest = (await runTurn(client, session, "hello there friend")).at(-1).seq;
  const epoch = client.readyPayload.replay_epoch;

  const atTheLimit = await client.call("session.resume", resumeFrom(session, latest - replayLimit, epoch));
  assert.equal(atTheLimit.replayed, true);
  assert.equal(atTheLimit.events.length, replayLimit);
  const past = await client.call("session.resume", resumeFrom(session, latest - replayLimit - 1, epoch));
  assert.equal(past.replayed, undefined);
  assert.equal(past.events, undefined);
  assert.ok(past.messages.length > 0);
});

test("a resume whose events missed would take more than the conversation they stand in for is the whole answer, as for a short thread after a reply streamed", async (t) => {
  const quick = await startTestBridge({ config: { fake: { delayMs: 0 } } });
  t.after(() => quick.dispose());
  const client = await TestClient.open(quick);
  t.after(() => client.close());
  const session = await createThread(client);
  const epoch = client.readyPayload.replay_epoch;
  const whole = () => client.call("session.resume", { session_id: session, profile: "fake", inline_images: false });

  // A reply streamed in many small pieces: each an event of its own, where the
  // conversation keeps the text once.
  const held = (await runTurn(client, session, "hello there")).at(-1).seq;
  const turn = await runTurn(client, session, "slow please");
  const short = await whole();
  assert.ok(JSON.stringify(turn).length > 4 * JSON.stringify(short.messages).length);
  const answer = await client.call("session.resume", resumeFrom(session, held, epoch));
  assert.equal(answer.replayed, undefined);
  assert.equal(answer.events, undefined);
  assert.deepEqual(answer.messages, short.messages);
  assert.equal(answer.latest_seq, turn.at(-1).seq);

  // The same turn after a long conversation is the lighter answer.
  await runTurn(client, session, "bench instant");
  const since = (await runTurn(client, session, "hello there")).at(-1).seq;
  const again = await runTurn(client, session, "slow please");
  const long = await whole();
  assert.ok(JSON.stringify(again).length < JSON.stringify(long.messages).length);
  const light = await client.call("session.resume", resumeFrom(session, since, epoch));
  assert.equal(light.replayed, true);
  assert.deepEqual(light.events, again);
});

test("the events missed and the conversation are weighed in the bytes they take, not in characters: a reply in Chinese after a conversation in English is the whole answer when its events take more bytes", async (t) => {
  const quick = await startTestBridge({ config: { fake: { delayMs: 0 } } });
  t.after(() => quick.dispose());
  const client = await TestClient.open(quick);
  t.after(() => client.close());
  const session = await createThread(client);
  const epoch = client.readyPayload.replay_epoch;
  // Some 3,600 characters of English before, which take a byte each, then a turn the device
  // missed: a message of 12 words of Chinese, about a thousand characters, which the fake
  // agent says back, each character three bytes in UTF-8.
  const held = (await runTurn(client, session, "lorem ".repeat(600))).at(-1).seq;
  const turn = await runTurn(client, session, Array.from({ length: 12 }, () => "這是一個用中文寫的很長的句子".repeat(6)).join(" "));
  const whole = await client.call("session.resume", { session_id: session, profile: "fake", inline_images: false });
  const events = JSON.stringify(turn);
  const conversation = JSON.stringify(whole.messages);
  // Fewer characters than the conversation, but more bytes.
  assert.ok(events.length < conversation.length, `${events.length} characters of events, ${conversation.length} of the conversation`);
  assert.ok(Buffer.byteLength(events) > Buffer.byteLength(conversation), `${Buffer.byteLength(events)} bytes of events, ${Buffer.byteLength(conversation)} of the conversation`);

  const answer = await client.call("session.resume", resumeFrom(session, held, epoch));
  assert.equal(answer.replayed, undefined);
  assert.deepEqual(answer.messages, whole.messages);
});

test("the light answer carries the open questions, the messages waiting and the thread's info, as the whole one does", async (t) => {
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const session = await createThread(client);
  await client.call("prompt.submit", { session_id: session, text: "please approve", profile: "fake" });
  const request = await client.nextRequest();
  await client.call("prompt.submit", { session_id: session, text: "after that", profile: "fake", when_busy: "queue" });
  await client.call("config.set", { key: "model", value: "fake-2 --session", session_id: session, profile: "fake" });
  await client.find((frame) => isEvent(frame, "queue.changed", session));
  const since = client.events(session).at(-1).seq;

  const other = await TestClient.open(bridge);
  t.after(() => other.close());
  const light = await other.call("session.resume", resumeFrom(session, since, other.readyPayload.replay_epoch));
  const whole = await other.call("session.resume", { session_id: session, profile: "fake", inline_images: false });
  assert.equal(light.replayed, true);
  assert.deepEqual(light.events, []);
  assert.deepEqual(light.open_requests, [{ id: request.id, method: "approval", params: request.params }]);
  assert.deepEqual(light.open_requests, whole.open_requests);
  assert.deepEqual(light.queued.map((entry: Frame) => entry.text), ["after that"]);
  assert.deepEqual([light.queued, light.can_steer], [whole.queued, whole.can_steer]);
  // A model changed with no event: the info says it.
  assert.equal(light.info.model, "fake-2");
  assert.deepEqual(light.info, whole.info);

  client.answer(request.id, { choice: "deny" });
  await client.nextEvent("message.complete", session);
});
