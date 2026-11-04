import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { historyFromThread, userInputText } from "../src/providers/codex/history.ts";
import { CodexSession } from "../src/providers/codex/session.ts";
import type { Thread } from "../src/providers/codex/types/index.ts";
import type { StoredMessage } from "../src/providers/types.ts";
import { Session } from "../src/sessions/session.ts";
import { withTurnDiffs } from "../src/sessions/turnDiff.ts";
import { fixtureCwd, recordedHistory } from "./codex-fixtures.ts";

// A Codex thread read back with `thread/read` (as recorded), in the stored-message
// format `session.resume` returns.

test("a turn with commentary, a command, an edit and a reply reads back with its rows and diff", () => {
  const { messages, running } = historyFromThread(recordedHistory("tools"), fixtureCwd, false);
  assert.equal(running, null);
  assert.deepEqual(
    messages.map((message) => (message.role === "tool" ? message.name : message.role)),
    ["user", "assistant", "terminal", "patch", "terminal", "assistant"],
  );
  assert.equal(messages[0].role === "user" && messages[0].text, "In hello.txt, change hi to hello by editing the file with a patch. Then run `wc -c hello.txt`. Finish with one short sentence.");
  const patch = messages[3];
  assert.equal(patch.role, "tool");
  if (patch.role !== "tool") return;
  assert.deepEqual(patch.args, { path: `${fixtureCwd}/hello.txt` });
  // The result is JSON text, as the app reads it.
  assert.deepEqual(JSON.parse(patch.content!), { success: true, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n" });
  assert.equal(patch.tool_call_id, "exec-d5f2b71e-9664-4cef-9578-b966781771ed");
  const command = messages[2];
  assert.deepEqual(command.role === "tool" && JSON.parse(command.content!), { output: "hi\n", exit_code: 0 });
  assert.equal(messages[1].role === "assistant" && messages[1].text, "I’ll patch `hello.txt`, then check its byte count.\n");
  // Times are the turn's, in seconds.
  assert.equal(messages[0].timestamp, 1_793_783_604);
  assert.equal(messages[5].timestamp, 1_793_783_618);
});

test("a declined change reads back as blocked", () => {
  const { messages } = historyFromThread(recordedHistory("approval"), fixtureCwd, false);
  const tools = messages.filter((message) => message.role === "tool");
  assert.deepEqual(tools.map((message) => message.role === "tool" && JSON.parse(message.content!)), [
    { status: "blocked", error: "Declined.", user_summary: "You denied this change — it was not made." },
    { diff: "--- /dev/null\n+++ b/other.txt\n@@ -0,0 +1 @@\n+other\n" },
  ]);
});

test("reasoning goes with the reply after it; a steered message keeps its kind", () => {
  const reasoning = historyFromThread(recordedHistory("reasoning"), fixtureCwd, false).messages;
  assert.equal(reasoning.length, 2);
  const reply = reasoning[1];
  assert.equal(reply.role, "assistant");
  assert.match(reply.role === "assistant" ? (reply.reasoning ?? "") : "", /^\*\*Validating prime numbers\*\*/);

  // Codex (0.162.1) keeps no part of the message it let go of when the steer came in.
  const steer = historyFromThread(recordedHistory("steer"), fixtureCwd, false).messages;
  assert.deepEqual(
    steer.map((message) => [message.role, message.role === "user" ? (message.display_kind ?? null) : null]),
    [
      ["user", null],
      ["user", "steer"],
      ["assistant", null],
    ],
  );
});

test("completed trailing reasoning is kept before a running turn is left open, or an idle one marked interrupted", () => {
  const thread: Thread = recordedHistory("reasoning");
  const turn = thread.turns[0];
  turn.status = "inProgress";
  turn.completedAt = null;
  turn.durationMs = null;
  turn.items = turn.items.filter((item) => item.type !== "agentMessage");
  const reasoning = turn.items.find((item) => item.type === "reasoning")!.summary.join("\n\n");
  for (const active of [true, false]) {
    const { messages, running, ends } = historyFromThread(thread, fixtureCwd, active);
    assert.deepEqual(messages.at(-1), {
      role: "assistant",
      text: "",
      timestamp: turn.startedAt,
      reasoning,
      ...(!active ? { display_metadata: { interrupted: true } } : {}),
    });
    assert.equal(running?.turnId ?? null, active ? turn.id : null);
    assert.equal(ends.get(turn.id), messages.length);
  }
  // A completed reasoning item with no summary adds no blank assistant row.
  turn.items.find((item) => item.type === "reasoning")!.summary = [];
  assert.deepEqual(historyFromThread(thread, fixtureCwd, true).messages.map((message) => message.role), ["user"]);
});

test("a running Codex attachment keeps completed reasoning once through redelivery, reconnect, final answer and reload", async (t) => {
  const thread: Thread = recordedHistory("reasoning");
  const turn = thread.turns[0];
  const completed = structuredClone(turn);
  const reasoning = turn.items.find((item) => item.type === "reasoning")!;
  const answer = turn.items.find((item) => item.type === "agentMessage")!;
  const thought = reasoning.summary.join("\n\n");
  assert.equal(thought.length, 434);
  const earlier: Thread = recordedHistory("tools");
  const previous = historyFromThread(earlier, fixtureCwd, false).messages;
  // As the session keeps them: each ended turn's last message also says what it changed (turn_diff).
  const kept = withTurnDiffs(structuredClone(previous));
  thread.turns.unshift(...earlier.turns);
  thread.status = { type: "active", activeFlags: [] };
  Object.assign(turn, { status: "inProgress", completedAt: null, durationMs: null });
  turn.items = turn.items.filter((item) => item.type !== "agentMessage");
  const host = {
    client: {
      async call(method: string) {
        assert.ok(method === "thread/read" || method === "thread/resume", method);
        return { thread };
      },
    },
    defaults: () => null,
    async defaultsFor() { throw new Error("No folder defaults in this fixture."); },
    efforts: () => [],
    forget() {},
  };
  const settings = { model: "gpt-6.1-sol", provider: "openai", reasoningEffort: "high" };
  const core = new Session({ id: thread.id, agent: "codex", cwd: fixtureCwd, title: null, ...settings, createdAt: 1, updatedAt: 1, origin: "phone" }, { has: () => false, set() {}, update() {} } as never);
  const provider = new CodexSession({ id: thread.id, cwd: fixtureCwd, settings }, core.sink, host as never, { applied: null, subscribed: false });
  t.after(() => provider.close());
  await provider.load();
  await core.attach(provider);
  const assertOnce = (messages: StoredMessage[], expected = kept) => {
    assert.deepEqual(messages.slice(0, expected.length), expected);
    assert.equal(messages.map((message) => message.role === "assistant" ? (message.reasoning ?? "") : "").join(""), thought);
  };
  const assertSnapshot = (running: boolean) => {
    const snapshot = core.snapshot(); // The whole session.resume answer, including inflight.
    assert.equal(snapshot.running, running);
    assertOnce(snapshot.messages as StoredMessage[]);
    assert.equal((snapshot.inflight as { reasoning?: string } | undefined)?.reasoning, undefined);
  };
  assertSnapshot(true);
  assert.equal(provider.turnEnd(turn.id), (core.snapshot().messages as StoredMessage[]).length);
  provider.notification("item/completed", { threadId: thread.id, turnId: turn.id, item: reasoning });
  assertSnapshot(true);
  provider.connectionLost();
  await provider.reconnected(Promise.resolve(new Set([thread.id])));
  assertSnapshot(true);
  provider.notification("item/completed", { threadId: thread.id, turnId: turn.id, item: reasoning });
  provider.notification("item/completed", { threadId: thread.id, turnId: turn.id, item: answer });
  assertSnapshot(true);
  Object.assign(turn, completed);
  thread.status = { type: "idle" };
  provider.notification("turn/completed", { threadId: thread.id, turn: completed });
  assertSnapshot(false);
  const final = (core.snapshot().messages as StoredMessage[]).at(-1);
  assert.equal(final?.role === "assistant" ? final.text : undefined, answer.text);
  assertOnce(await provider.reload(), previous);
});

test("an interrupted turn is marked; a failed one says why", () => {
  const interrupted = historyFromThread(recordedHistory("interrupt"), fixtureCwd, false).messages;
  // With how long it ran, as Codex keeps it (feature turn_usage).
  assert.deepEqual(interrupted.at(-1), { role: "assistant", text: "", timestamp: interrupted.at(-1)!.timestamp, display_metadata: { interrupted: true }, turn_usage: { seconds: 2.167 } });
  const failed = historyFromThread(
    { turns: [{ id: "t", items: [{ type: "userMessage", id: "u", clientId: null, content: [{ type: "text", text: "Go", text_elements: [] }] }], itemsView: "full", status: "failed", error: { message: "Usage limit reached", codexErrorInfo: null, additionalDetails: null, misalignment: null }, startedAt: 5, completedAt: 6, durationMs: 1000 }] } as never,
    "/w",
    false,
  ).messages;
  assert.deepEqual(failed.at(-1), { role: "assistant", text: "Usage limit reached", timestamp: 6, display_kind: "failed_turn", turn_usage: { seconds: 1 } });
});

test("a turn still running in a running thread is left open, with the message that opened it", () => {
  const thread = structuredClone(recordedHistory("tools"));
  const turn = thread.turns[0];
  turn.status = "inProgress";
  turn.items = turn.items.slice(0, 3);
  const { messages, running } = historyFromThread(thread, fixtureCwd, true);
  assert.equal(running?.turnId, turn.id);
  assert.equal(running?.user, messages[0].role === "user" ? messages[0].text : "");
  assert.equal(running?.items.length, 3);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
  // In a thread Codex is not running, the same turn was cut off.
  assert.equal(historyFromThread(thread, fixtureCwd, false).running, null);
});

test("a running turn with a message steered into it is open from that message, the last one sent, as the app shows a steer opening a turn", () => {
  const thread = structuredClone(recordedHistory("steer"));
  const turn = thread.turns[0];
  turn.status = "inProgress";
  const { messages, running } = historyFromThread(thread, fixtureCwd, true);
  const users = messages.filter((message) => message.role === "user");
  assert.equal(users.length, 2);
  assert.equal(running?.user, users[1].role === "user" ? users[1].text : "");
  assert.equal(running?.user, "When you have finished counting, also say the word banana.");
});

test("a thread read while a /compact runs is running that command: the reply before it is not cut off", () => {
  const thread = structuredClone(recordedHistory("compact"));
  // The compaction's item is still in progress, so the turn has none yet.
  const compacting = thread.turns[1];
  Object.assign(compacting, { status: "inProgress", items: [], completedAt: null });
  const { messages, running } = historyFromThread(thread, fixtureCwd, true);
  assert.deepEqual(
    messages.map((message) => [message.role, message.role === "user" || message.role === "assistant" ? message.text : null, message.role === "assistant" ? (message.display_metadata ?? null) : null]),
    [
      ["user", "Reply with the single word hello. Do not use any tools.", null],
      ["assistant", "hello", null],
      ["user", "/compact", null],
    ],
  );
  assert.deepEqual(running, { turnId: compacting.id, user: "/compact", items: [] });
  // In a thread Codex is not running, it was cut off before it compacted anything.
  assert.deepEqual(
    historyFromThread(thread, fixtureCwd, false).messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
});

test("a /compact reads back as the command and the mark of where it compacted; Codex compacting by itself mid-turn as a mark there", () => {
  const { messages } = historyFromThread(recordedHistory("compact"), fixtureCwd, false);
  assert.deepEqual(
    messages.map((message) => (message.role === "compaction" ? `compaction:${message.trigger}` : `${message.role}:${message.role === "tool" ? message.name : message.text}`)),
    ["user:Reply with the single word hello. Do not use any tools.", "assistant:hello", "user:/compact", "compaction:manual"],
  );
  // The command opens its turn; the mark is where it ended. History does not say how full the context was.
  assert.deepEqual(messages.slice(2), [
    { role: "user", text: "/compact", timestamp: 1_793_783_835 },
    { role: "compaction", trigger: "manual", timestamp: 1_793_783_835, turn_usage: { seconds: 0.207 } },
  ]);

  const message = (id: string, text: string) => ({ type: "userMessage", id, clientId: null, content: [{ type: "text", text, text_elements: [] }] });
  const byItself = historyFromThread(
    {
      turns: [
        {
          id: "t",
          items: [message("u", "Run the tests."), { type: "contextCompaction", id: "c" }, { type: "agentMessage", id: "a", text: "All pass.", phase: "final_answer" }],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 5,
          completedAt: 9,
          durationMs: 4000,
        },
      ],
    } as never,
    "/w",
    false,
  ).messages;
  assert.deepEqual(
    byItself.map((entry) => (entry.role === "compaction" ? `compaction:${entry.trigger}` : entry.role)),
    ["user", "compaction:auto", "assistant"],
  );
});

test("images in a message read back as @image lines after its text", () => {
  assert.equal(
    userInputText([
      { type: "localImage", path: "/state/images/abc/shot.png" },
      { type: "text", text: "What is this?", text_elements: [] },
    ]),
    "What is this?\n@image:shot.png",
  );
});

test("a wait reads back naming the sub-agent it was about, as the line names it from the stored thread; a spawn's row carries its task and no names (subagent_calls)", () => {
  const { messages } = historyFromThread(recordedHistory("subagent"), fixtureCwd, false);
  const tools = messages.filter((message) => message.role === "tool");
  assert.deepEqual(
    tools.map((message) => message.role === "tool" && [message.name, message.context, message.args]),
    [["delegate_task", "wait", { agents: ["pear"] }]],
  );
  const spawn = { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed", receiverThreadIds: ["c1"], prompt: "Count the files.", model: "gpt-6-luna", agentsStates: {} };
  const close = { type: "collabAgentToolCall", id: "close", tool: "closeAgent", status: "completed", receiverThreadIds: ["c1"], prompt: null, model: null, agentsStates: { c1: { status: "shutdown" } } };
  const v1 = historyFromThread({ turns: [{ id: "t", status: "completed", startedAt: 1, completedAt: 2, items: [spawn, close] }] as never }, fixtureCwd, false);
  assert.deepEqual(
    v1.messages.map((message) => message.role === "tool" && [message.context, message.args]),
    [
      ["spawnAgent", { task: "Count the files.", agent: "gpt-6-luna" }],
      ["closeAgent", { agents: ["Count the files."] }],
    ],
  );
});

test("questions Codex asked without waiting read back as a clarify row, answered by the user's next message or unanswered", () => {
  const asked = (id: string) => ({
    type: "agentMessage",
    id,
    text: "Which colour?\n- Red\n- Blue",
    phase: "final_answer",
    delivery: "async",
    questions: [{ title: "Which colour?", options: ["Red", "Blue"] }],
  });
  const user = (id: string, text: string) => ({ type: "userMessage", id, content: [{ type: "text", text, text_elements: [] }] });
  const reply = (id: string, text: string) => ({ type: "agentMessage", id, text, phase: "final_answer", delivery: null, questions: null });
  const thread = {
    turns: [
      { id: "t1", status: "completed", startedAt: 1, completedAt: 2, items: [user("u1", "Make a README"), asked("a1"), reply("m1", "asked")] },
      { id: "t2", status: "completed", startedAt: 3, completedAt: 4, items: [user("u2", "Blue"), asked("a2"), reply("m2", "Done in blue.")] },
    ],
  } as unknown as Thread;
  const { messages } = historyFromThread(thread, "/w", false);
  assert.deepEqual(
    messages.map((message) => (message.role === "tool" ? `${message.name}:${message.content}` : `${message.role}:${"text" in message ? message.text : ""}`)),
    [
      "user:Make a README",
      "clarify:null",
      "assistant:asked",
      "user:Blue",
      `clarify:${JSON.stringify({ responses: [], unanswered: true })}`,
      "assistant:Done in blue.",
    ],
  );
  const row = messages[1];
  assert.deepEqual(row.role === "tool" && row.args, { questions: [{ question: "Which colour?", choices: ["Red", "Blue"] }], async: true });
});
