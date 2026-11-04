import "./environment.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { machineWord } from "../src/platform.ts";
import { CodexStream, rateLimitNotices, windowName } from "../src/providers/codex/stream.ts";
import { notSignedIn } from "../src/providers/signIn.ts";
import type { ProviderEvent } from "../src/providers/types.ts";
import { fixture, fixtureCwd, joined, recordedHistory, recordedThread, replayStream } from "./codex-fixtures.ts";

// Golden tests: real Codex streams (test/fixtures/codex, recorded with
// scripts/record-codex.ts) through the mapper, with no Codex running. Each
// `<name>.events.json` is what the mapper made of `<name>.jsonl` when it was last
// checked by hand; UPDATE_GOLDEN=1 rewrites them after a deliberate change.

const scenarios = ["plain", "tools", "approval", "clarify", "reasoning", "steer", "interrupt", "compact", "subagent", "plan"];

for (const name of scenarios) {
  test(`codex ${name}: the recording maps to its golden events`, () => {
    const events = joined(replayStream(name));
    const golden = new URL(`fixtures/codex/${name}.events.json`, import.meta.url);
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) {
      writeFileSync(golden, JSON.stringify(events, null, 1) + "\n");
    }
    assert.deepEqual(events, JSON.parse(readFileSync(golden, "utf8")));
  });
}

function ofType<T extends ProviderEvent["type"]>(events: ProviderEvent[], type: T): Extract<ProviderEvent, { type: T }>[] {
  return events.filter((event): event is Extract<ProviderEvent, { type: T }> => event.type === type);
}

function text(events: ProviderEvent[]): string {
  return ofType(events, "text").map((event) => event.text).join("");
}

test("commentary streams, then closes as an interim piece; the command is a terminal row; the final answer ends the turn", () => {
  const events = replayStream("plain");
  const [commentary] = ofType(events, "commentary");
  assert.equal(commentary.text, "I’ll list this folder and check whether 221 is prime.");
  assert.equal(commentary.alreadyStreamed, true);
  // The commentary came word by word before it closed.
  assert.ok(events.indexOf(commentary) > events.findIndex((event) => event.type === "text"));
  const [end] = ofType(events, "tool.end");
  // Codex's login-shell wrapper is left off.
  assert.deepEqual(end.args, { command: "ls" });
  assert.deepEqual(end.result, { output: "hello.txt\n", exit_code: 0 });
  // Only the text after the last closed piece is the reply.
  const after = events.slice(events.indexOf(end));
  assert.equal(text(after), "I saw `hello.txt`; 221 is not prime (13 × 17).");
  // What it spent: how far the thread's tokens rose in it (two requests), and Codex's time for it.
  assert.deepEqual(events.at(-1), { type: "turn.end", status: "complete", usage: { used: 22952, max: 258_400 }, spent: { tokens: 45_857, seconds: 8.315 }, agentTurn: "01a1a5d8-b56d-7760-a906-7c4eb706a9b2" });
});

test("a file change is an edit row with a whole unified diff; a new file is a write row", () => {
  const edits = ofType(replayStream("tools"), "tool.end");
  assert.deepEqual(
    edits.map((event) => event.name),
    ["terminal", "patch", "terminal"],
  );
  assert.deepEqual(edits[1].args, { path: `${fixtureCwd}/hello.txt` });
  assert.deepEqual(edits[1].result, { success: true, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n" });
  const writes = ofType(replayStream("approval"), "tool.end");
  assert.deepEqual(writes[2].result, { diff: "--- /dev/null\n+++ b/other.txt\n@@ -0,0 +1 @@\n+other\n" });
});

test("declined changes and commands are stored as blocked", () => {
  const ends = ofType(replayStream("approval"), "tool.end");
  assert.deepEqual(ends[0].result, { status: "blocked", error: "Declined.", user_summary: "You denied this change — it was not made." });
  assert.deepEqual(ends[1].result, { status: "blocked", error: "Declined.", user_summary: "You denied this command — it did not run." });
});

test("reasoning summaries stream as reasoning before the answer", () => {
  const events = replayStream("reasoning");
  const reasoning = ofType(events, "reasoning");
  assert.ok(reasoning.length > 20, "the summary streams word by word");
  assert.match(reasoning.map((event) => event.text).join(""), /^\*\*Validating prime numbers\*\*/);
  assert.ok(events.findLastIndex((event) => event.type === "reasoning") < events.findIndex((event) => event.type === "text"));
});

test("a message steered into the turn closes what came before it; the reply after it is the turn's", () => {
  const events = replayStream("steer");
  assert.equal(ofType(events, "turn.end").length, 1);
  const [closed] = ofType(events, "commentary");
  assert.match(closed.text, /^1\n2\n3\n/);
  assert.equal(ofType(events, "text").at(-1)?.text, "banana");
});

test("an interrupted turn ends interrupted with what streamed before it", () => {
  const events = replayStream("interrupt");
  assert.equal(text(events), "1\n");
  // Stopped before Codex said any tokens: its time alone.
  assert.deepEqual(events.at(-1), { type: "turn.end", status: "interrupted", spent: { seconds: 2.167 } });
});

test("an item that started before the stream listened is reported whole when it completes, never from the middle", () => {
  const stream = new CodexStream({ cwd: "/w", now: () => 0 });
  stream.beginTurn("t1");
  // Deltas of a message whose start was missed are held back.
  assert.deepEqual(stream.map("item/agentMessage/delta", { turnId: "t1", itemId: "m1", delta: "lo world" }), []);
  assert.deepEqual(stream.map("item/completed", { turnId: "t1", item: { type: "agentMessage", id: "m1", text: "Hello world", phase: "final_answer" } }), [{ type: "text", text: "Hello world" }]);
  // A tool whose start was missed opens and closes at once.
  const events = stream.map("item/completed", { turnId: "t1", item: { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'echo hi'", status: "completed", aggregatedOutput: "hi\n", exitCode: 0, durationMs: 12 } });
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool.start", "tool.end"],
  );
  assert.equal((events[1] as { durationSeconds: number }).durationSeconds, 0.012);
  // Items the stored history holds are not reported again.
  stream.known([{ type: "commandExecution", id: "c2" }]);
  assert.deepEqual(stream.map("item/completed", { turnId: "t1", item: { type: "commandExecution", id: "c2", command: "ls", status: "completed" } }), []);
});

test("a message or reasoning streaming when the connection drops takes no more pieces, and its rest comes whole when it completes", () => {
  const stream = new CodexStream({ cwd: "/w", now: () => 0 });
  stream.beginTurn("t1");
  stream.map("item/started", { turnId: "t1", item: { type: "reasoning", id: "r1", summary: [] } });
  stream.map("item/reasoning/summaryTextDelta", { turnId: "t1", itemId: "r1", delta: "Think" });
  stream.map("item/started", { turnId: "t1", item: { type: "agentMessage", id: "m1", text: "" } });
  assert.deepEqual(stream.map("item/agentMessage/delta", { turnId: "t1", itemId: "m1", delta: "Hello " }), [{ type: "text", text: "Hello " }]);
  stream.connectionLost();
  // What streams once it is back follows a gap.
  assert.deepEqual(stream.map("item/reasoning/summaryPartAdded", { turnId: "t1", itemId: "r1", summaryIndex: 1 }), []);
  assert.deepEqual(stream.map("item/reasoning/summaryTextDelta", { turnId: "t1", itemId: "r1", delta: "again" }), []);
  assert.deepEqual(stream.map("item/agentMessage/delta", { turnId: "t1", itemId: "m1", delta: "world" }), []);
  assert.deepEqual(stream.map("item/completed", { turnId: "t1", item: { type: "reasoning", id: "r1", summary: ["Thinking", "Thinking again"] } }), [
    { type: "reasoning", text: "ing\n\nThinking again" },
  ]);
  assert.deepEqual(stream.map("item/completed", { turnId: "t1", item: { type: "agentMessage", id: "m1", text: "Hello big world", phase: "final_answer" } }), [
    { type: "text", text: "big world" },
  ]);
});

test("reconcile reports what a turn did while nobody listened, then its end", () => {
  const stream = new CodexStream({ cwd: fixtureCwd, now: () => 0 });
  const history = recordedHistory("tools");
  const [turn] = history.turns;
  stream.beginTurn(turn.id);
  // The first user message and the first command were seen live.
  stream.map("item/started", { turnId: turn.id, item: turn.items[0] });
  stream.map("item/started", { turnId: turn.id, item: turn.items[2] });
  stream.map("item/completed", { turnId: turn.id, item: turn.items[2] });
  const events = stream.reconcile(turn);
  assert.deepEqual(
    events.map((event) => (event.type === "tool.end" || event.type === "tool.start" ? `${event.type}:${event.name}` : event.type)),
    ["text", "commentary", "tool.start:patch", "tool.end:patch", "tool.start:terminal", "tool.end:terminal", "text", "turn.end"],
  );
});

test("what a turn reported is let go of once the next begins: a thread that runs many turns holds one turn's items, and shows each turn as before", () => {
  const stream = new CodexStream({ cwd: fixtureCwd, now: () => 0 });
  const [turn] = recordedHistory("tools").turns;
  const rows = (events: ProviderEvent[]) => events.filter((event) => event.type === "tool.end").length;
  for (let run = 0; run < 50; run += 1) {
    const id = `turn-${run}`;
    stream.beginTurn(id);
    let events: ProviderEvent[] = [];
    // Codex gives each item an id of its own, never one of another turn's.
    for (const item of turn.items) {
      const own = { ...item, id: `${item.id}-${run}` };
      events.push(...stream.map("item/started", { turnId: id, item: own }), ...stream.map("item/completed", { turnId: id, item: own }));
    }
    // A reconnect mid-turn tells nothing it reported again.
    events = [...events, ...stream.reconcile({ ...turn, id, status: "completed", items: turn.items.map((item: Record<string, unknown>) => ({ ...item, id: `${item.id}-${run}` })) })];
    assert.equal(rows(events), 3);
    assert.equal(events.filter((event) => event.type === "turn.end").length, 1);
  }
  // The set of what was reported, which kept every turn's before (its size is not shown anywhere else).
  assert.ok((stream as unknown as { done: Set<string> }).done.size <= turn.items.length);
});

test("a failed turn ends with Codex's error; one Codex retries is a passing status", () => {
  const stream = new CodexStream({ cwd: "/w" });
  stream.beginTurn("t1");
  assert.deepEqual(stream.map("error", { turnId: "t1", willRetry: true, error: { message: "Reconnecting… 1/5" } }), [{ type: "status", text: "Codex is trying again: Reconnecting… 1/5" }]);
  assert.deepEqual(stream.map("error", { turnId: "t1", willRetry: false, error: { message: "stream disconnected" } }), []);
  stream.map("item/started", { turnId: "t1", item: { type: "commandExecution", id: "c1", command: "sleep 100" } });
  const events = stream.map("turn/completed", { turn: { id: "t1", status: "failed", error: null, items: [] } });
  assert.deepEqual(events, [
    { type: "tool.end", id: "c1", name: "terminal", args: { command: "sleep 100" }, result: { status: "error", error: "Stopped before it finished." } },
    { type: "turn.end", status: "error", error: "stream disconnected", retryable: true },
  ]);
});

test("a turn Codex could not sign in for ends with what to run on the host, not the HTTP error, and can be tried again", () => {
  const signedOut = notSignedIn("codex");
  assert.equal(signedOut, `Codex is not signed in on this ${machineWord()}. Run \`codex login\` in a terminal there, then try again.`);
  // As Codex 0.166.0 ends a turn with no sign-in.
  const stream = new CodexStream({ cwd: "/w" });
  stream.beginTurn("t1");
  const error = { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null };
  assert.deepEqual(stream.map("turn/completed", { turn: { id: "t1", status: "failed", error, items: [] } }), [{ type: "turn.end", status: "error", error: signedOut, retryable: true }]);
  // Said by the error before a turn that names none, and as `unauthorized`.
  stream.beginTurn("t2");
  stream.map("error", { turnId: "t2", willRetry: false, error: { message: "401 Unauthorized", codexErrorInfo: "unauthorized" } });
  assert.deepEqual(stream.map("turn/completed", { turn: { id: "t2", status: "failed", error: null, items: [] } }), [{ type: "turn.end", status: "error", error: signedOut, retryable: true }]);
  // Another status is Codex's own error.
  stream.beginTurn("t3");
  const busy = { message: "unexpected status 503", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } }, additionalDetails: null };
  assert.deepEqual(stream.map("turn/completed", { turn: { id: "t3", status: "failed", error: busy, items: [] } }), [{ type: "turn.end", status: "error", error: "unexpected status 503", retryable: true }]);
});

test("plan updates are to-do rows; a thread name is the title", () => {
  const stream = new CodexStream({ cwd: "/w" });
  stream.beginTurn("t1");
  const events = stream.map("turn/plan/updated", {
    turnId: "t1",
    explanation: null,
    plan: [
      { step: "Read the file", status: "completed" },
      { step: "Edit it", status: "inProgress" },
      { step: "Test", status: "pending" },
    ],
  });
  assert.deepEqual(events[1], {
    type: "tool.end",
    id: "plan-t1-1",
    name: "todo",
    args: {
      todos: [
        { content: "Read the file", status: "completed" },
        { content: "Edit it", status: "in_progress" },
        { content: "Test", status: "pending" },
      ],
    },
    context: "1 of 3 done",
    result: { output: "✓ Read the file\n→ Edit it\n○ Test" },
  });
  assert.deepEqual(stream.map("thread/name/updated", { threadId: "x", threadName: " Fix the build " }), [{ type: "title", title: "Fix the build" }]);
});

test("usage limits at 80% or more are warned about once per window and reset", () => {
  const warned = new Set<string>();
  const limits = (used: number, resetsAt = 1_791_580_476) => ({
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: used, windowDurationMins: 10_080, resetsAt },
    secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_791_400_000 },
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: null,
  });
  assert.deepEqual(rateLimitNotices(limits(20), warned, "UTC"), []);
  assert.deepEqual(rateLimitNotices(limits(85), warned, "UTC"), [{ type: "notice", level: "warn", text: "You have used 85% of your weekly Codex limit; it resets Fri 9:14 PM." }]);
  assert.deepEqual(rateLimitNotices(limits(90), warned, "UTC"), []);
  assert.equal(rateLimitNotices(limits(85, 1_792_000_000), warned, "UTC").length, 1);
  assert.deepEqual(rateLimitNotices({ ...limits(100), rateLimitReachedType: "rate_limit_reached" }, warned, "UTC"), [
    { type: "notice", level: "warn", text: "You have reached your Codex usage limit; it resets Fri 9:14 PM." },
  ]);
  assert.equal(windowName(300), "5-hour");
  assert.equal(windowName(1440), "daily");
  assert.equal(windowName(43_200), "30-day");
});

test("/compact is a turn of its own: a passing status, then the mark with the context used before it, and the context Codex counts after it", () => {
  const events = replayStream("compact");
  const ends = ofType(events, "turn.end");
  assert.equal(ends.length, 2);
  assert.deepEqual(events.slice(events.indexOf(ends[0]) + 1), [
    { type: "status", text: "Compacting the conversation…" },
    // Codex's own count after compacting. On a thread this short its summary can be the
    // larger (codex-cli 0.166.0 counted 30,449 after 25,862), so it need not fall.
    { type: "usage", usage: { used: 30449, max: 258_400 } },
    { type: "status", text: "" },
    // Asked for: the turn has no message of the user's.
    { type: "compacted", trigger: "manual", tokensBefore: 25862 },
    // The compaction did not move the thread's tokens: it spent none Codex counts.
    { type: "turn.end", status: "complete", usage: { used: 30449, max: 258_400 }, spent: { seconds: 0.207 } },
  ]);
});

test("Codex compacting by itself mid-turn is marked as such; without its start, how full the context was is not known", () => {
  const stream = new CodexStream({ cwd: fixtureCwd });
  stream.beginTurn("t1");
  stream.map("item/started", { threadId: "th", turnId: "t1", item: { type: "userMessage", id: "u1", content: [] } });
  stream.map("thread/tokenUsage/updated", { threadId: "th", turnId: "t1", tokenUsage: { last: { totalTokens: 240_000 }, modelContextWindow: 258_400 } });
  stream.map("item/started", { threadId: "th", turnId: "t1", item: { type: "contextCompaction", id: "c1" } });
  assert.deepEqual(stream.map("item/completed", { threadId: "th", turnId: "t1", item: { type: "contextCompaction", id: "c1" } }), [
    { type: "status", text: "" },
    { type: "compacted", trigger: "auto", tokensBefore: 240_000 },
  ]);

  const late = new CodexStream({ cwd: fixtureCwd });
  late.beginTurn("t2");
  late.map("thread/tokenUsage/updated", { threadId: "th", turnId: "t2", tokenUsage: { last: { totalTokens: 6000 }, modelContextWindow: 258_400 } });
  assert.deepEqual(late.map("item/completed", { threadId: "th", turnId: "t2", item: { type: "contextCompaction", id: "c2" } }), [
    { type: "status", text: "" },
    { type: "compacted", trigger: "manual" },
  ]);
});

test("every recording's thread ids are the recording's own, and nothing personal is left in them", () => {
  for (const name of scenarios) {
    const raw = readFileSync(new URL(`fixtures/codex/${name}.jsonl`, import.meta.url), "utf8");
    assert.equal(/\/Users\/(?!dev\b)/.test(raw), false, name);
    assert.equal(/"balance":"[1-9]/.test(raw), false, name);
    assert.ok(fixture(name).some((entry) => entry.kind === "meta"), name);
  }
});

test("a turn's tokens are how far the thread's total rose in it, each request once, and its time is Codex's own", () => {
  const stream = new CodexStream({ cwd: fixtureCwd });
  const tokens = (turnId: string, total: number, last: number) =>
    stream.map("thread/tokenUsage/updated", {
      threadId: "th",
      turnId,
      tokenUsage: { total: { inputTokens: total - 10, outputTokens: 10, totalTokens: total }, last: { inputTokens: last - 10, outputTokens: 10, totalTokens: last }, modelContextWindow: 258_400 },
    });
  const end = (id: string, durationMs: number | null = null) => ofType(stream.complete({ id, status: "completed", items: [], durationMs } as never), "turn.end")[0];
  // The first turn the bridge sees, on a thread that already had 30k: from the total less its first request.
  stream.beginTurn("t1");
  tokens("t1", 52_843, 22_843);
  tokens("t1", 75_728, 22_885);
  // Said again (as Codex does when its limits change): counted once.
  tokens("t1", 75_728, 22_885);
  assert.deepEqual(end("t1", 4321).spent, { tokens: 45_728, seconds: 4.321 });
  // The next one starts from where the last ended; news of another turn only moves the total.
  stream.beginTurn("t2");
  tokens("other", 80_000, 4_272);
  tokens("t2", 100_000, 20_000);
  assert.deepEqual(end("t2").spent, { tokens: 20_000 });
  // One the bridge joined midway says no tokens, only Codex's time.
  stream.beginTurn("t3", true);
  tokens("t3", 130_000, 30_000);
  assert.deepEqual(end("t3", 900).spent, { seconds: 0.9 });
  // Nor does one Codex said nothing of.
  stream.beginTurn("t4");
  assert.equal(end("t4").spent, undefined);
});

// As GPT-6.1 Sol asks with request_user_input_async in a normal thread (Codex 0.163.0,
// recorded 2026-10-23): an agentMessage with delivery "async" and its questions, whole at once.
const asked = {
  type: "agentMessage",
  id: "call_0e032384134f49e79eb7ba5d6d1a1f6f",
  text: "Which colour should the README heading use?\n- Red\n- Green\n- Blue",
  phase: "final_answer",
  memoryCitation: null,
  delivery: "async",
  questions: [{ title: "Which colour should the README heading use?", options: ["Red", "Green", "Blue"] }],
};

test("questions Codex asks without waiting are a questions event in their text's place, after the text before them closes", () => {
  const stream = new CodexStream({ cwd: "/w", now: () => 0 });
  stream.beginTurn("t1");
  stream.map("item/started", { turnId: "t1", item: { type: "agentMessage", id: "m1", text: "" } });
  stream.map("item/agentMessage/delta", { turnId: "t1", itemId: "m1", delta: "Let me ask." });
  stream.map("item/completed", { turnId: "t1", item: { type: "agentMessage", id: "m1", text: "Let me ask.", phase: "final_answer" } });
  assert.deepEqual(stream.map("item/started", { turnId: "t1", item: asked }), []);
  assert.deepEqual(stream.map("item/completed", { turnId: "t1", item: asked }), [
    { type: "commentary", text: "Let me ask.", alreadyStreamed: true },
    {
      type: "questions",
      id: asked.id,
      questions: [{ qid: "q0", question: "Which colour should the README heading use?", choices: ["Red", "Green", "Blue"], multiSelect: false }],
      text: asked.text,
    },
  ]);
  // A freeform one has no choices; one whose words streamed already stays text.
  const freeform = { ...asked, id: "call_2", questions: [{ title: "Which folder?", options: null }], text: "Which folder?" };
  assert.deepEqual(stream.map("item/completed", { turnId: "t1", item: freeform }), [
    { type: "questions", id: "call_2", questions: [{ qid: "q0", question: "Which folder?", choices: [], multiSelect: false }], text: "Which folder?" },
  ]);
  stream.map("item/started", { turnId: "t1", item: { ...asked, id: "call_3", text: "" } });
  stream.map("item/agentMessage/delta", { turnId: "t1", itemId: "call_3", delta: "Which colour" });
  assert.deepEqual(stream.map("item/completed", { turnId: "t1", item: { ...asked, id: "call_3" } }), [{ type: "text", text: " should the README heading use?\n- Red\n- Green\n- Blue" }]);
});

// From a live turn (codex-cli 0.163.0, 2026-10-23): a command printing a line a second.
function commandItem(status: "inProgress" | "completed", output: string | null = null) {
  return {
    type: "commandExecution", id: "exec-1", command: "/bin/zsh -lc 'for i in 1 2 3; do echo tick $i; sleep 1; done'", cwd: "/w",
    processId: "90744", source: "unifiedExecStartup", status, commandActions: [], aggregatedOutput: output, exitCode: status === "completed" ? 0 : null, durationMs: null,
  };
}

test("a running command's output streams as its row's live output, at most four times a second, and stops with its result", async () => {
  const progress: ProviderEvent[] = [];
  const stream = new CodexStream({ cwd: "/w", progress: (event) => progress.push(event) });
  stream.beginTurn("turn-1");
  stream.map("item/started", { turnId: "turn-1", item: commandItem("inProgress") });
  stream.map("item/commandExecution/outputDelta", { turnId: "turn-1", itemId: "exec-1", delta: "tick 1\r\n" });
  stream.map("item/commandExecution/outputDelta", { turnId: "turn-1", itemId: "exec-1", delta: "tick 2\r\n" });
  assert.deepEqual(progress, [{ type: "tool.progress", id: "exec-1", output: "tick 1\n", outputTruncated: false }]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(progress.at(-1), { type: "tool.progress", id: "exec-1", output: "tick 1\ntick 2\n", outputTruncated: false });
  stream.map("item/commandExecution/outputDelta", { turnId: "turn-1", itemId: "exec-1", delta: "tick 3\r\n" });
  const ended = stream.map("item/completed", { turnId: "turn-1", item: commandItem("completed", "tick 1\r\ntick 2\r\ntick 3\r\n") });
  // A terminal's \r\n line ends are plain ones in its result, not blank lines between.
  assert.deepEqual(ofType(ended, "tool.end")[0].result, { output: "tick 1\ntick 2\ntick 3\n", exit_code: 0 });
  const count = progress.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(progress.length, count, "nothing goes out for a call that has ended");
  // Output of a call not open (another turn's, an unknown id) is not shown.
  stream.map("item/commandExecution/outputDelta", { turnId: "turn-1", itemId: "exec-9", delta: "stray\n" });
  assert.equal(progress.length, count);
});

test("a plan streams into its row as Codex writes it (the recorded plan's deltas), and its row then has the whole", async () => {
  const progress: ProviderEvent[] = [];
  let clock = 0;
  const stream = new CodexStream({ cwd: fixtureCwd, now: () => clock, progress: (event) => progress.push(event) });
  const thread = recordedThread("plan");
  const entries = fixture("plan").filter((entry) => entry.kind === "notification" && entry.params?.threadId === thread);
  const turn = entries.find((entry) => entry.method === "turn/started")!.params.turn.id;
  stream.beginTurn(turn);
  const plan = entries.find((entry) => entry.method === "item/completed" && entry.params.item.type === "plan")!.params.item;
  let ended: ProviderEvent[] = [];
  for (const entry of entries) {
    if (entry.method === "turn/completed") break;
    // Far enough apart that each piece goes out, as four a second allows.
    clock += 1000;
    const events = stream.map(entry.method!, entry.params);
    if (entry.method === "item/completed" && entry.params.item.type === "plan") ended = events;
  }
  const shown = progress.filter((event) => event.type === "tool.progress" && event.id === plan.id).map((event) => (event as { output: string }).output);
  assert.ok(shown.length > 10, "the plan comes a piece at a time");
  // The first piece as the recording has it (a recording on another release may start differently).
  assert.equal(shown[0], entries.find((entry) => entry.method === "item/plan/delta")!.params.delta);
  assert.ok(shown.every((output, index) => index === 0 || output.startsWith(shown[index - 1])), "each piece follows on from the last");
  // All that was written (Codex says the pieces need not add up to the plan it ends with)…
  assert.equal(shown.at(-1), entries.filter((entry) => entry.method === "item/plan/delta").map((entry) => entry.params.delta).join(""));
  // …then the plan as it ended.
  assert.deepEqual(ofType(ended, "tool.end")[0].args, { content: plan.text });
});

test("Codex waiting is a Wait row saying for how long", () => {
  const stream = new CodexStream({ cwd: "/w", now: () => 0 });
  stream.beginTurn("t1");
  // As Codex 0.166 sends its `clock.sleep`.
  const sleep = { type: "sleep", id: "call_1", durationMs: 2000 };
  assert.deepEqual(stream.map("item/started", { turnId: "t1", item: sleep }), [{ type: "tool.start", id: "call_1", name: "wait", args: {}, context: "2 seconds" }]);
  assert.deepEqual(stream.map("item/completed", { turnId: "t1", item: sleep }), [
    { type: "tool.end", id: "call_1", name: "wait", args: {}, context: "2 seconds", result: {}, durationSeconds: 2 },
  ]);
});

test("a review is one row from its start to its end, saying what it reviewed; its commands are rows between, and its findings are the reply after it", () => {
  let clock = 0;
  const stream = new CodexStream({ cwd: "/w", now: () => clock });
  stream.beginTurn("review");
  const entered = { type: "enteredReviewMode", id: "entered", review: "current changes" };
  assert.deepEqual(
    [...stream.map("item/started", { turnId: "review", item: entered }), ...stream.map("item/completed", { turnId: "review", item: entered })],
    [{ type: "tool.start", id: "entered", name: "review", args: {}, context: "current changes" }],
  );
  const command = { type: "commandExecution", id: "exec-1", command: "git diff", cwd: "/w", processId: null, status: "completed", commandActions: [], aggregatedOutput: "", exitCode: 0, durationMs: 5 };
  assert.deepEqual(ofType(stream.map("item/completed", { turnId: "review", item: command }), "tool.end").map((event) => event.name), ["terminal"]);
  clock = 24_000;
  const exited = { type: "exitedReviewMode", id: "exited", review: "No issues." };
  assert.deepEqual(stream.map("item/started", { turnId: "review", item: exited }), []);
  assert.deepEqual(stream.map("item/completed", { turnId: "review", item: exited }), [
    { type: "tool.end", id: "entered", name: "review", args: {}, context: "current changes", result: {}, durationSeconds: 24 },
  ]);
  // Its end alone (the bridge joined late) is a row of its own.
  stream.beginTurn("later");
  assert.deepEqual(ofType(stream.map("item/completed", { turnId: "later", item: { ...exited, id: "exited-2" } }), "tool.end")[0].name, "review");
  // One the turn's end cuts short is stopped.
  stream.beginTurn("cut");
  stream.map("item/started", { turnId: "cut", item: { ...entered, id: "entered-3" } });
  const end = stream.complete({ id: "cut", status: "interrupted" } as never);
  assert.deepEqual(ofType(end, "tool.end")[0], { type: "tool.end", id: "entered-3", name: "review", args: {}, context: "current changes", result: { status: "error", error: "Stopped before it finished." } });
});

test("a command still running when Codex completes its turn runs on in the background: its row closes with its output so far, not as stopped", () => {
  const background: object[] = [];
  const stream = new CodexStream({ cwd: "/w", now: () => 1000, background: (command) => background.push(command) });
  stream.beginTurn("turn-1");
  stream.map("item/started", { turnId: "turn-1", item: commandItem("inProgress") });
  stream.map("item/commandExecution/outputDelta", { turnId: "turn-1", itemId: "exec-1", delta: "tick 1\r\n" });
  const events = stream.map("turn/completed", { turn: { id: "turn-1", status: "completed", items: [] } });
  const [end] = ofType(events, "tool.end");
  assert.deepEqual(end.result, { output: "tick 1\n…still running in the background." });
  assert.deepEqual(background, [{ id: "exec-1", turn: "turn-1", command: "for i in 1 2 3; do echo tick $i; sleep 1; done", processId: "90744", startedAt: 1000, output: "tick 1\n", outputTruncated: false }]);
  // An interrupted turn's command stopped with it, as before.
  const later: object[] = [];
  const cut = new CodexStream({ cwd: "/w", background: (command) => later.push(command) });
  cut.beginTurn("turn-2");
  cut.map("item/started", { turnId: "turn-2", item: commandItem("inProgress") });
  const stopped = ofType(cut.map("turn/completed", { turn: { id: "turn-2", status: "interrupted", items: [] } }), "tool.end")[0];
  assert.deepEqual(stopped.result, { status: "error", error: "Stopped before it finished." });
  assert.equal(later.length, 0);
});

test("Codex trying again passes once it goes on: the next of the turn's news clears the line, or puts back the compaction it was in", () => {
  const stream = new CodexStream({ cwd: "/w" });
  stream.beginTurn("t1");
  assert.deepEqual(stream.map("error", { turnId: "t1", willRetry: true, error: { message: "Reconnecting… 2/5" } }), [{ type: "status", text: "Codex is trying again: Reconnecting… 2/5" }]);
  // It reconnected: the reply streams, and the line no longer says it is trying again.
  assert.deepEqual(stream.map("item/started", { turnId: "t1", item: { type: "agentMessage", id: "m1" } }), [{ type: "status", text: "" }]);
  assert.deepEqual(stream.map("item/agentMessage/delta", { turnId: "t1", itemId: "m1", delta: "Hi" }), [{ type: "text", text: "Hi" }]);

  // The turn ending says the same, when nothing came between.
  const ended = new CodexStream({ cwd: "/w" });
  ended.beginTurn("t2");
  ended.map("error", { turnId: "t2", willRetry: true, error: { message: "Reconnecting… 5/5" } });
  assert.deepEqual(ended.map("turn/completed", { turn: { id: "t2", status: "completed", error: null, items: [] } })[0], { type: "status", text: "" });

  // Within a compaction: back to the compaction.
  const compacting = new CodexStream({ cwd: "/w" });
  compacting.beginTurn("t3");
  compacting.map("item/started", { turnId: "t3", item: { type: "contextCompaction", id: "k1" } });
  compacting.map("error", { turnId: "t3", willRetry: true, error: { message: "Reconnecting… 1/5" } });
  assert.deepEqual(compacting.map("thread/tokenUsage/updated", { turnId: "t3", tokenUsage: {} }).filter((event) => event.type === "status"), []);
  assert.deepEqual(compacting.map("item/reasoning/summaryPartAdded", { turnId: "t3", itemId: "r1", summaryIndex: 0 }).filter((event) => event.type === "status"), [{ type: "status", text: "Compacting the conversation…" }]);
});

test("a command an interrupted turn stopped keeps the output it showed live, with that it was stopped", () => {
  const stream = new CodexStream({ cwd: "/w" });
  stream.beginTurn("turn-1");
  stream.map("item/started", { turnId: "turn-1", item: commandItem("inProgress") });
  stream.map("item/commandExecution/outputDelta", { turnId: "turn-1", itemId: "exec-1", delta: "tick 1\r\n" });
  stream.map("item/commandExecution/outputDelta", { turnId: "turn-1", itemId: "exec-1", delta: "tick 2\r\n" });
  const stopped = ofType(stream.map("turn/completed", { turn: { id: "turn-1", status: "interrupted", items: [] } }), "tool.end")[0];
  assert.deepEqual(stopped.result, { status: "error", error: "Stopped before it finished.", output: "tick 1\ntick 2\n" });
});
