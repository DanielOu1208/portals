import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prompt, ProviderEvent, ProviderSession, SessionSink, StoredMessage } from "../src/providers/types.ts";
import { openAsk, withCardAnswers } from "../src/sessions/answers.ts";
import type { LoggedEvent } from "../src/sessions/eventLog.ts";
import type { Registry, ThreadRecord } from "../src/sessions/registry.ts";
import { Session, type Peer } from "../src/sessions/session.ts";
import { WaitingStore } from "../src/sessions/waiting.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Questions an agent asks without waiting (feature async_questions), straight on a
// Session, with an agent that takes messages mid-turn.

const nextStep = () => new Promise<void>((resolve) => setImmediate(resolve));

const questions = [{ qid: "q0", question: "Which colour?", choices: ["Red", "Blue"], multiSelect: false }];

async function setUp(id: string, stored: { history?: StoredMessage[]; cardAnswers?: ThreadRecord["cardAnswers"]; follow?: boolean } = {}) {
  const record: ThreadRecord = { id, agent: "stand-in", cwd: "/tmp", title: "Colours", model: "m", provider: "p", reasoningEffort: "low", createdAt: 0, updatedAt: 0, origin: "phone" };
  if (stored.cardAnswers) record.cardAnswers = stored.cardAnswers;
  const core = new Session(record, { has: () => false } as unknown as Registry);
  const started: string[] = [];
  const steered: string[] = [];
  let sink!: SessionSink;
  const agent: ProviderSession = {
    history: async () => structuredClone(stored.history ?? []),
    settings: () => ({ model: "m", provider: "p", reasoningEffort: "low" }),
    startTurn: (prompt: Prompt) => { started.push(prompt.text); },
    steer: async (prompt: Prompt) => { steered.push(prompt.text); return true; },
    interrupt: async () => false,
    setModel: async () => ({ deferred: false }),
    setReasoning: async () => {},
    close: async () => {},
  };
  sink = core.sink;
  await core.attach(agent);
  const sent: { id: string; method: string; params: Record<string, unknown> }[] = [];
  const events: LoggedEvent[] = [];
  const device: Peer = { isOpen: true, takesRequests: true, keepsAsyncQuestions: true, sendRequest(rid, method, params) { sent.push({ id: rid, method, params }); }, sendEvent(event) { events.push(event); } };
  if (stored.follow !== false) core.follow(device);
  const emit = (event: ProviderEvent) => sink.emit(event);
  return { core, record, device, started, steered, sent, events, emit };
}

/** The stored conversation as `role:text`, a tool's row as `name:content`. */
function shown(messages: readonly StoredMessage[]): string[] {
  return messages.map((message) => (message.role === "tool" ? `${message.name}:${message.content}` : `${message.role}:${message.role === "compaction" ? "" : message.text}`));
}

test("a message handed to the running turn answers a question asked without waiting, and its row stays where it was asked", async () => {
  const { core, started, steered, sent, emit } = await setUp("async-steer");
  core.submit("make a readme").begin?.();
  await nextStep();
  assert.deepEqual(started, ["make a readme"]);
  emit({ type: "text", text: "Let me ask. " });
  emit({ type: "questions", id: "call_1", questions, text: "Which colour?\n- Red\n- Blue" });
  emit({ type: "text", text: "Going on meanwhile." });
  await nextStep();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.async, true);
  // While its card is open, the row is in place, marked as asking.
  const asking = core.messages.find((message) => message.role === "tool" && message.name === "clarify");
  assert.deepEqual(asking?.role === "tool" && JSON.parse(asking.content!), { responses: [], asking: true });

  assert.equal(core.submit("Blue, please").status, "steered");
  await nextStep();
  assert.deepEqual(steered, ["Blue, please"]);
  assert.deepEqual(core.requests.list(), []);
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  const order = core.messages.map((message) => (message.role === "tool" ? `${message.name}:${message.content}` : `${message.role}:${message.role === "compaction" ? "" : message.text}`));
  assert.deepEqual(order.slice(0, 3), ["user:make a readme", "assistant:Let me ask. ", "clarify:null"]);
  assert.ok(order.indexOf("clarify:null") < order.indexOf("user:Blue, please"));
  await core.close();
});

test("a question answered after its turn keeps its row in that turn, before the answer's own turn", async () => {
  const { core, started, sent, emit } = await setUp("async-later");
  core.submit("make a readme").begin?.();
  await nextStep();
  emit({ type: "questions", id: "call_1", questions, text: "Which colour?\n- Red\n- Blue" });
  emit({ type: "text", text: "Going on meanwhile." });
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.equal(core.requests.list().length, 1);
  // A command brings the agent no message: the card stays.
  core.submit("/compact").begin?.();
  await nextStep();
  assert.equal(core.requests.list().length, 1);
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  const follower = [...(core as unknown as { followers: Set<never> }).followers][0];
  assert.ok(core.requests.answer(follower, sent[0].id, { result: { answers: { q0: "Red" } } }));
  await nextStep();
  assert.deepEqual(started, ["make a readme", "/compact", "Red"]);
  const rows = core.messages.map((message) => (message.role === "tool" ? `${message.name}:${message.content}` : `${message.role}:${message.role === "compaction" ? "" : message.text}`));
  const row = rows.findIndex((entry) => entry.startsWith("clarify:"));
  assert.equal(rows[row], `clarify:${JSON.stringify({ responses: [{ question: "Which colour?", user_response: "Red" }] })}`);
  assert.ok(row < rows.indexOf("user:/compact"));
  await core.close();
});

const row = (content: unknown): StoredMessage => ({
  role: "tool", name: "clarify", tool_call_id: "call_1", timestamp: 2,
  args: { questions: [{ question: "Which colour?", choices: ["Red", "Blue"] }], async: true }, content: JSON.stringify(content),
});
const unanswered = { responses: [], unanswered: true };

test("the answers given on the card go to the agent as a message marked as the card's, and the other devices are told them", async () => {
  const { core, record, device, started, events, emit } = await setUp("async-card-answer");
  const other: { events: LoggedEvent[] } = { events: [] };
  core.follow({ isOpen: true, takesRequests: true, keepsAsyncQuestions: true, sendRequest() {}, sendEvent(event) { other.events.push(event); } });
  core.submit("make a readme").begin?.();
  await nextStep();
  emit({ type: "questions", id: "call_1", questions, text: "Which colour?\n- Red\n- Blue" });
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  const [open] = core.requests.list();
  assert.ok(core.requests.answer(device, open.id, { result: { answers: { q0: "Blue" } } }));
  await nextStep();
  assert.deepEqual(started, ["make a readme", "Blue"]);
  // The others close their card with the answer, which its row shows.
  const cancel = other.events.find((event) => event.type === "request.cancel");
  assert.deepEqual(cancel?.payload, { id: open.id, reason: "resolved", answer: { answers: { q0: "Blue" } } });
  // Its turn opens with it, marked as the card's, on every device and in the stored copy.
  const start = events.filter((event) => event.type === "message.start").at(-1);
  assert.equal(start?.payload?.text, "Blue");
  assert.equal(start?.payload?.card_answer, "call_1");
  const said = core.messages.find((message) => message.role === "user" && message.text === "Blue");
  assert.equal(said?.role === "user" && said.card_answer, "call_1");
  assert.deepEqual(core.snapshot().inflight, { user: "Blue", assistant: "", card_answer: "call_1" });
  // A message typed afterwards is the person's own.
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  core.submit("thanks").begin?.();
  await nextStep();
  assert.equal(events.filter((event) => event.type === "message.start").at(-1)?.payload?.card_answer, undefined);
  // The thread's record keeps how the card settled them, for a restart.
  assert.deepEqual(record.cardAnswers, [{ id: "call_1", answers: ["Blue"], said: "Blue" }]);
  await core.close();
});

test("answers given on the card while the turn runs join it marked as the card's", async () => {
  const { core, device, steered, events, emit } = await setUp("async-card-steer");
  core.submit("make a readme").begin?.();
  await nextStep();
  emit({ type: "questions", id: "call_1", questions, text: "Which colour?\n- Red\n- Blue" });
  await nextStep();
  const [open] = core.requests.list();
  assert.ok(core.requests.answer(device, open.id, { result: { answers: { q0: "Red" } } }));
  await nextStep();
  assert.deepEqual(steered, ["Red"]);
  // Listed as waiting for a moment, then handed to the turn: marked as the card's on both.
  const queues = events.filter((event) => event.type === "queue.changed").map((event) => event.payload);
  assert.deepEqual((queues[0]?.queued as { card_answer?: string }[])[0].card_answer, "call_1");
  assert.ok(queues.some((payload) => payload?.steered !== undefined));
  const said = core.messages.find((message) => message.role === "user" && message.text === "Red");
  assert.equal(said?.role === "user" && said.display_kind, "steer");
  assert.equal(said?.role === "user" && said.card_answer, "call_1");
  await core.close();
});

test("read back from the agent's history, a card's answers are their row's again, and the message they went as is marked as the card's", () => {
  const kept = [{ id: "call_1", answers: ["Blue"], said: "Blue" }];
  const history: StoredMessage[] = [
    { role: "user", text: "make a readme", timestamp: 1 },
    row(null),
    { role: "assistant", text: "Going on meanwhile.", timestamp: 3 },
    { role: "user", text: "Blue", timestamp: 4 },
    { role: "assistant", text: "Blue it is.", timestamp: 5 },
  ];
  const folded = withCardAnswers(history, kept);
  assert.deepEqual(JSON.parse((folded[1] as { content: string }).content), { responses: [{ question: "Which colour?", user_response: "Blue" }] });
  assert.equal(folded[3].role === "user" && folded[3].card_answer, "call_1");
  // The history it was given is left as it was.
  assert.equal(history[3].role === "user" && history[3].card_answer, undefined);
  // A message the person typed in its place is theirs.
  const typed = withCardAnswers([history[0], row(null), { role: "user", text: "green, actually", timestamp: 4 }], kept);
  assert.equal(typed[2].role === "user" && typed[2].card_answer, undefined);
  // Skipped on the card: its row says so, and no message is the card's.
  const skipped = withCardAnswers([history[0], row(unanswered)], [{ id: "call_1", answers: [""] }]);
  assert.deepEqual(JSON.parse((skipped[1] as { content: string }).content), { responses: [{ question: "Which colour?", user_response: "" }] });
});

test("the last questions a conversation ends with unanswered are open again; older ones, answered or settled ones are not", () => {
  const user = (text: string): StoredMessage => ({ role: "user", text, timestamp: 1 });
  const reply: StoredMessage = { role: "assistant", text: "Going on meanwhile.", timestamp: 3 };
  assert.deepEqual(openAsk([user("make a readme"), row(unanswered), reply], []), {
    id: "call_1", questions: [{ qid: "q0", question: "Which colour?", choices: ["Red", "Blue"], multiSelect: false }],
  });
  // A line of the agent's own after them is no message of the person's.
  assert.ok(openAsk([user("go"), row(unanswered), { role: "user", text: "", timestamp: 4, display_kind: "process_complete" }], []));
  // A message sent since answered them.
  assert.equal(openAsk([user("go"), row(unanswered), user("blue")], []), null);
  // Skipped or taken back on the card.
  assert.equal(openAsk([user("go"), row(unanswered)], [{ id: "call_1" }]), null);
  // Newer questions, answered, came after them.
  assert.equal(openAsk([user("go"), row(unanswered), { ...row(null), tool_call_id: "call_2" } as StoredMessage], []), null);
  // A row of other questions (a card the agent waited on) is none of these.
  assert.equal(openAsk([user("go"), { ...row(unanswered), args: { questions: [{ question: "Which colour?", choices: [] }] } } as StoredMessage], []), null);
});

test("questions a conversation ended with unanswered are their card again for a device that keeps such cards, and answered so they go on as live", async () => {
  const history: StoredMessage[] = [{ role: "user", text: "make a readme", timestamp: 1 }, row(unanswered), { role: "assistant", text: "Going on meanwhile.", timestamp: 3 }];
  const { core, device, started, sent, events } = await setUp("async-again", { history, follow: false });
  // Not to a device that does not keep them past the turn.
  core.askAgain({ ...device, keepsAsyncQuestions: false });
  assert.deepEqual(core.requests.list(), []);
  core.askAgain(device);
  // In the same step: the answer the device takes next lists the card and leaves out the row.
  const snapshot = core.snapshot();
  const open = snapshot.open_requests as { id: string; params: Record<string, unknown> }[];
  assert.equal(open.length, 1);
  assert.equal(open[0].params.async, true);
  assert.deepEqual(open[0].params.questions, [{ qid: "q0", question: "Which colour?", choices: ["Red", "Blue"], multi_select: false }]);
  assert.deepEqual(shown(snapshot.messages as StoredMessage[])[1], `clarify:${JSON.stringify({ responses: [], asking: true })}`);
  // Only once.
  core.askAgain(device);
  assert.equal(core.requests.list().length, 1);
  core.follow(device);
  assert.ok(core.requests.answer(device, open[0].id, { result: { answers: { q0: "Red" } } }));
  await nextStep();
  assert.deepEqual(started, ["Red"]);
  assert.equal(events.filter((event) => event.type === "message.start").at(-1)?.payload?.card_answer, "call_1");
  // Its row, where it was asked, takes the answer in place.
  assert.deepEqual(shown(core.messages).slice(0, 4), [
    "user:make a readme", `clarify:${JSON.stringify({ responses: [{ question: "Which colour?", user_response: "Red" }] })}`, "assistant:Going on meanwhile.", "user:Red",
  ]);
  assert.equal(sent.length, 0);
  await core.close();
});

test("a message sent before questions found unanswered are put again answers them", async () => {
  const history: StoredMessage[] = [{ role: "user", text: "make a readme", timestamp: 1 }, row(unanswered)];
  const { core, device } = await setUp("async-again-typed", { history });
  core.submit("blue").begin?.();
  await nextStep();
  core.askAgain(device);
  assert.deepEqual(core.requests.list(), []);
  assert.equal(shown(core.messages)[1], "clarify:null");
  await core.close();
});

test("questions found unanswered are not put again once a card settled them", async () => {
  const history: StoredMessage[] = [{ role: "user", text: "make a readme", timestamp: 1 }, row(unanswered)];
  const { core, device } = await setUp("async-again-settled", { history, cardAnswers: [{ id: "call_1" }] });
  core.askAgain(device);
  assert.deepEqual(core.requests.list(), []);
  await core.close();
});

test("a message typed at the desk answers a question asked without waiting, as one sent from a device does; a turn the agent opens by itself does not", async () => {
  const { core, sent, emit } = await setUp("async-desk");
  core.submit("make a readme").begin?.();
  await nextStep();
  emit({ type: "questions", id: "call_1", questions, text: "Which colour?\n- Red\n- Blue" });
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.equal(sent.length, 1);
  // A turn the agent opens by itself (a background task's news) is no answer: the card stays.
  emit({ type: "turn.begin", user: "", host: { kind: "hidden", text: "" } });
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.equal(core.requests.list().length, 1);
  // A command typed at the desk brings the agent no message either.
  emit({ type: "turn.begin", user: "/compact" });
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.equal(core.requests.list().length, 1);
  // Typed at the desk (a Codex thread followed there too): the agent takes it as the answer.
  emit({ type: "turn.begin", user: "Blue" });
  await nextStep();
  assert.deepEqual(core.requests.list(), []);
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  const rows = shown(core.messages);
  assert.ok(rows.indexOf("clarify:null") !== -1 && rows.indexOf("clarify:null") < rows.indexOf("user:Blue"));
  // How it ended agrees with what a restart reads back from the history: answered by a message.
  assert.equal(openAsk(core.messages, []), null);
  await core.close();
});

test("a stored row of questions with no args, as Hermes may keep it, does not stop the thread from loading", async () => {
  const bare = { role: "tool", name: "clarify", tool_call_id: "call_9", timestamp: 2, content: JSON.stringify(unanswered) } as unknown as StoredMessage;
  const history: StoredMessage[] = [{ role: "user", text: "hello", timestamp: 1 }, bare];
  assert.equal(openAsk(history, []), null);
  assert.deepEqual(withCardAnswers(history, [{ id: "call_9", answers: ["Red"] }])[1].role, "tool");
  const { core } = await setUp("async-bare-row", { history, cardAnswers: [{ id: "call_9", answers: ["Red"] }] });
  assert.equal(core.messages.length, 2);
  await core.close();
});

test("a desk message its agent first took for a /compact answers a question asked without waiting once its words are known", async () => {
  const { core, emit } = await setUp("async-desk-opener");
  core.submit("make a readme").begin?.();
  await nextStep();
  emit({ type: "questions", id: "call_1", questions, text: "Which colour?\n- Red\n- Blue" });
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  // Codex loads the turn before its message comes (its hooks run first), taken for a /compact.
  emit({ type: "turn.begin", user: "/compact" });
  await nextStep();
  assert.equal(core.requests.list().length, 1);
  emit({ type: "turn.opener", user: "Blue" });
  await nextStep();
  assert.deepEqual(core.requests.list(), []);
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.ok(shown(core.messages).includes("clarify:null"));
  await core.close();
});

test("answers given on a card still waiting when the bridge stops go to the agent after it starts again marked as the card's", async () => {
  const root = mkdtempSync(join(tmpdir(), "portals-card-waiting-"));
  try {
    const waiting = new WaitingStore(join(root, "waiting"));
    const record: ThreadRecord = { id: "async-card-restart", agent: "stand-in", cwd: "/tmp", title: "Colours", model: "m", provider: "p", reasoningEffort: "low", createdAt: 0, updatedAt: 0, origin: "phone" };
    const started: string[] = [];
    // An agent that takes no message mid-turn: the card's answer waits for the turn's end.
    const agent = (): ProviderSession => ({
      history: async () => [],
      settings: () => ({ model: "m", provider: "p", reasoningEffort: "low" }),
      startTurn: (prompt: Prompt) => { started.push(prompt.text); },
      interrupt: async () => false,
      setModel: async () => ({ deferred: false }),
      setReasoning: async () => {},
      close: async () => {},
    });
    const before = new Session(record, { has: () => false } as unknown as Registry, { waiting });
    await before.attach(agent());
    const device: Peer = { isOpen: true, takesRequests: true, keepsAsyncQuestions: true, sendRequest() {}, sendEvent() {} };
    before.follow(device);
    before.submit("make a readme").begin?.();
    await nextStep();
    before.sink.emit({ type: "questions", id: "call_1", questions, text: "Which colour?\n- Red\n- Blue" });
    await nextStep();
    const [open] = before.requests.list();
    assert.ok(before.requests.answer(device, open.id, { result: { answers: { q0: "Blue" } } }));
    await nextStep();
    assert.deepEqual(before.queuedMessages(), [{ id: before.queuedMessages()[0].id, text: "Blue", card_answer: "call_1" }]);
    // The bridge stops while it waits.
    await before.close();

    const after = new Session(record, { has: () => false } as unknown as Registry, { waiting });
    await after.attach({ ...agent(), history: async () => [] });
    // Listed as the card's, while it waits for its turn.
    assert.equal(after.queuedMessages()[0]?.card_answer, "call_1");
    const events: LoggedEvent[] = [];
    after.follow({ isOpen: true, takesRequests: true, keepsAsyncQuestions: true, sendRequest() {}, sendEvent(event) { events.push(event); } });
    await nextStep();
    await nextStep();
    assert.deepEqual(started, ["make a readme", "Blue"]);
    // Its turn opens with it marked as the card's, on every device and in the stored copy.
    assert.equal(events.filter((event) => event.type === "message.start").at(-1)?.payload?.card_answer, "call_1");
    const said = after.messages.find((message) => message.role === "user" && message.text === "Blue");
    assert.equal(said?.role === "user" && said.card_answer, "call_1");
    await after.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a desk message whose words begin as a command's, with a picture attached, answers a question asked without waiting, as Codex's history reads it after a restart", async () => {
  for (const late of [false, true]) {
    const { core, emit } = await setUp(`async-desk-picture-${late}`);
    core.submit("make a readme").begin?.();
    await nextStep();
    emit({ type: "questions", id: "call_1", questions, text: "Which colour?\n- Red\n- Blue" });
    emit({ type: "turn.end", status: "complete" });
    await nextStep();
    // Codex says which is a command: its /compact, not a message with a picture whose words begin so.
    emit({ type: "turn.begin", user: "/compact", command: true });
    emit({ type: "turn.end", status: "complete" });
    await nextStep();
    assert.equal(core.requests.list().length, 1);
    if (late) {
      // Loaded before its message came, taken for a /compact, then told its words.
      emit({ type: "turn.begin", user: "/compact", command: true });
      await nextStep();
      assert.equal(core.requests.list().length, 1);
      emit({ type: "turn.opener", user: "/compact\n@image:blue.png" });
    } else {
      emit({ type: "turn.begin", user: "/compact\n@image:blue.png", command: false });
    }
    await nextStep();
    assert.deepEqual(core.requests.list(), [], late ? "told late" : "told at once");
    emit({ type: "turn.end", status: "complete" });
    await nextStep();
    assert.equal(openAsk(core.messages, []), null);
    await core.close();
  }
});

test("a message steered in that the agent turns down after asking a newer question answers that question once it opens a turn of its own, as the history reads it", async () => {
  let refuse!: (taken: boolean) => void;
  const { core, emit, started } = await setUp("async-resend");
  // An agent that takes messages mid-turn, slowly: this one is turned down after the turn ends.
  (core as unknown as { provider: ProviderSession }).provider.steer = () => new Promise<boolean>((resolve) => { refuse = resolve; });
  core.submit("make a readme").begin?.();
  await nextStep();
  assert.equal(core.submit("Blue").status, "steered");
  emit({ type: "questions", id: "call_after", questions, text: "Which colour?\n- Red\n- Blue" });
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.equal(core.requests.list().length, 1);
  refuse(false);
  await nextStep();
  await nextStep();
  // Said again, in a turn of its own: the agent has it now, and takes it as the answer.
  assert.equal(started.at(-1), "Blue");
  assert.deepEqual(core.requests.list(), []);
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.equal(core.isAtWork, false);
  await core.close();
});

test("a session taken off the list puts no card for questions its agent asks after", async () => {
  const opened: unknown[] = [];
  const { core, emit } = await setUp("async-retired");
  (core as unknown as { listener: unknown }).listener = { requestOpened: (_id: string, request: unknown) => opened.push(request) };
  core.retire();
  emit({ type: "questions", id: "call_late", questions, text: "Which colour?\n- Red\n- Blue" });
  await nextStep();
  assert.deepEqual(core.requests.list(), []);
  assert.deepEqual(opened, []);
});

test("answers given on a card as the bridge closes wait on disk for its next start, marked as the card's, rather than going to an agent being let go of", async () => {
  for (const atWork of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "portals-card-closing-"));
    try {
      const waiting = new WaitingStore(join(root, "waiting"));
      const record: ThreadRecord = { id: `async-card-closing-${atWork}`, agent: "stand-in", cwd: "/tmp", title: "Colours", model: "m", provider: "p", reasoningEffort: "low", createdAt: 0, updatedAt: 0, origin: "phone" };
      const started: string[] = [];
      const steered: string[] = [];
      const core = new Session(record, { has: () => false } as unknown as Registry, { waiting });
      await core.attach({
        history: async () => [],
        settings: () => ({ model: "m", provider: "p", reasoningEffort: "low" }),
        startTurn: (prompt: Prompt) => { started.push(prompt.text); },
        steer: async (prompt: Prompt) => { steered.push(prompt.text); return true; },
        interrupt: async () => false,
        setModel: async () => ({ deferred: false }),
        setReasoning: async () => {},
        close: async () => {},
      });
      const device: Peer = { isOpen: true, takesRequests: true, keepsAsyncQuestions: true, sendRequest() {}, sendEvent() {} };
      core.follow(device);
      core.submit("make a readme").begin?.();
      await nextStep();
      core.sink.emit({ type: "questions", id: "call_1", questions, text: "Which colour?\n- Red\n- Blue" });
      if (!atWork) core.sink.emit({ type: "turn.end", status: "complete" });
      await nextStep();
      const [open] = core.requests.list();
      assert.ok(core.requests.answer(device, open.id, { result: { answers: { q0: "Blue" } } }));
      // The bridge closes in the same step, before the answer goes on.
      core.closeSoon();
      await nextStep();
      assert.deepEqual([started, steered], [["make a readme"], []], atWork ? "at work" : "at rest");
      assert.deepEqual(waiting.read(record.id).map((message) => [message.text, message.cardAnswer]), [["Blue", "call_1"]]);
      await core.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a message whose turn fails before the agent produced anything puts back the question it answered; one the agent answered in does not", async () => {
  const { core, device, sent, events, emit } = await setUp("async-reply-failed");
  core.submit("make a readme").begin?.();
  await nextStep();
  emit({ type: "questions", id: "call_1", questions, text: "Which colour?\n- Red\n- Blue" });
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.equal(core.requests.list().length, 1);
  // The person answers in their own words; the agent's side fails that turn at once.
  core.submit("Blue, please").begin?.();
  await nextStep();
  assert.deepEqual(core.requests.list(), []);
  emit({ type: "turn.end", status: "error", error: "The agent's connection dropped." });
  await nextStep();
  await nextStep();
  // The card is back, put again (nobody is notified anew), and its row asks again.
  const [again] = core.requests.list();
  assert.ok(again, "the card is put again");
  assert.equal(again.params.async, true);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1].id, sent[0].id);
  assert.deepEqual(shown(core.messages)[1], `clarify:${JSON.stringify({ responses: [], asking: true })}`);
  assert.ok(events.some((event) => event.type === "request.cancel" && event.payload?.reason === "replied"));
  // Answered on the card, it goes on as a card asked live does.
  assert.ok(core.requests.answer(device, again.id, { result: { answers: { q0: "Blue" } } }));
  await nextStep();
  assert.equal(events.filter((event) => event.type === "message.start").at(-1)?.payload?.card_answer, "call_1");
  emit({ type: "turn.end", status: "complete" });
  await nextStep();

  // A turn in which the agent said something before failing had the message: the card stays closed.
  emit({ type: "questions", id: "call_2", questions, text: "Which colour?" });
  await nextStep();
  assert.equal(core.requests.list().length, 1);
  core.submit("Red").begin?.();
  await nextStep();
  emit({ type: "text", text: "Red it is." });
  emit({ type: "turn.end", status: "error", error: "Rate limited." });
  await nextStep();
  await nextStep();
  assert.deepEqual(core.requests.list(), []);
  // Nor one that ends well, or one the person stops.
  emit({ type: "questions", id: "call_3", questions, text: "Which colour?" });
  await nextStep();
  core.submit("Green").begin?.();
  await nextStep();
  emit({ type: "turn.end", status: "interrupted" });
  await nextStep();
  await nextStep();
  assert.deepEqual(core.requests.list(), []);
  await core.close();
});

test("a message whose turn fails at once puts back questions found unanswered as the thread was loaded, for the next device that opens it", async () => {
  const history: StoredMessage[] = [{ role: "user", text: "make a readme", timestamp: 1 }, row(unanswered)];
  const { core, device, emit } = await setUp("async-again-failed", { history, follow: false });
  core.submit("blue").begin?.();
  await nextStep();
  assert.equal(shown(core.messages)[1], "clarify:null");
  emit({ type: "turn.end", status: "error", error: "The agent could not start." });
  await nextStep();
  assert.equal(shown(core.messages)[1], `clarify:${JSON.stringify(unanswered)}`);
  core.askAgain(device);
  assert.equal(core.requests.list().length, 1);
  await core.close();
});

test("the others' cards close saying which device's answer settled the request, when it gave its id (feature answer_owner)", async () => {
  const { core, emit } = await setUp("answer-owner", { follow: false });
  const seen = (name: string, deviceID?: string) => {
    const events: LoggedEvent[] = [];
    const peer: Peer = { isOpen: true, takesRequests: true, keepsAsyncQuestions: true, ...(deviceID ? { deviceID } : {}), sendRequest() {}, sendEvent(event) { events.push(event); } };
    core.follow(peer);
    return { name, peer, events };
  };
  const phone = seen("phone", "device-phone");
  const mac = seen("mac", "device-mac");
  const old = seen("old");
  core.submit("make a readme").begin?.();
  await nextStep();
  emit({ type: "questions", id: "call_1", questions, text: "Which colour?" });
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  const [first] = core.requests.list();
  assert.ok(core.requests.answer(phone.peer, first.id, { result: { answers: { q0: "Blue" } } }));
  await nextStep();
  const cancel = (events: LoggedEvent[], id: string) => events.find((event) => event.type === "request.cancel" && event.payload?.id === id)?.payload;
  assert.equal(cancel(mac.events, first.id)?.answered_by, "device-phone");
  assert.equal(cancel(old.events, first.id)?.answered_by, "device-phone");
  // Not sent back to the one that answered, but in the log a device replays from.
  assert.equal(cancel(phone.events, first.id), undefined);
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  // Answered by a connection that gave no id: no key.
  emit({ type: "questions", id: "call_2", questions, text: "Which colour?" });
  await nextStep();
  const [second] = core.requests.list();
  assert.ok(core.requests.answer(old.peer, second.id, { result: { answers: { q0: "Red" } } }));
  await nextStep();
  assert.equal(cancel(phone.events, second.id)?.reason, "resolved");
  assert.equal("answered_by" in (cancel(phone.events, second.id) ?? {}), false);
  await core.close();
});

test("a background command of an earlier turn ending as the answer's turn begins is no sign the agent had the answer: its failure puts the card back (recent-6)", async () => {
  const { core, emit } = await setUp("async-reply-background");
  core.submit("start work").begin?.();
  await nextStep();
  emit({ type: "tool.start", id: "old-command", name: "exec_command", args: { cmd: "long task" } });
  emit({ type: "questions", id: "call_1", questions, text: "Which colour?" });
  emit({ type: "tool.end", id: "old-command", name: "exec_command", args: {}, result: { output: "Still running in the background." } });
  emit({ type: "turn.end", status: "complete" });
  await nextStep();
  core.submit("Blue").begin?.();
  await nextStep();
  // Codex tells of a background terminal's end when its process ends, in whatever turn runs then.
  emit({ type: "tool.progress", id: "old-command", output: "done" });
  emit({ type: "tool.end", id: "old-command", name: "exec_command", args: {}, result: { output: "Background work finished", exit_code: 0 } });
  emit({ type: "turn.end", status: "error", error: "Could not send the turn" });
  await nextStep();
  await nextStep();
  assert.equal(core.requests.list().length, 1);
  await core.close();
});
