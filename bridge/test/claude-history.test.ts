import "./environment.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { historyFromSession, turnCutOff } from "../src/providers/claude/history.ts";
import type { ProviderEvent, StoredMessage } from "../src/providers/types.ts";
import { fakeClaude, fixtureCwd, joined, recordedHistory, replayStream } from "./claude-fixtures.ts";

// A cold thread's history, from what `getSessionMessages` returned for the recordings:
// no `tool_use_result` there, so diffs and answers are rebuilt from the tool calls.

function history(name: string): StoredMessage[] {
  return historyFromSession(recordedHistory(name), fixtureCwd);
}

/** A message's text; a tool message and a compaction have none. */
function textOf(message: StoredMessage | undefined): string {
  return message && message.role !== "tool" && message.role !== "compaction" ? message.text : "";
}

function tools(messages: StoredMessage[]) {
  return messages.filter((message): message is Extract<StoredMessage, { role: "tool" }> => message.role === "tool");
}

test("a tool turn: the message, what Claude said and thought, one tool message per call, the reply", () => {
  const messages = history("tools");
  assert.deepEqual(
    messages.map((message) => (message.role === "tool" ? `tool:${message.name}` : message.role)),
    ["user", "tool:read_file", "assistant", "tool:patch", "tool:terminal", "assistant"],
  );
  assert.equal(textOf(messages[0]), "Read hello.txt with the Read tool. Then use the Edit tool to change hi to hello in it, and run `cat hello.txt` with the Bash tool. Finish with one short sentence.");
  assert.equal(messages[0].timestamp, Date.parse("2026-11-04T09:26:17.278Z") / 1000);
  const said = messages[2] as Extract<StoredMessage, { role: "assistant" }>;
  // Haiku 5.5 read the file at once, then thought before its edit and said nothing.
  assert.equal(said.text, "");
  assert.match(said.reasoning ?? "", /^I'm changing "hi" to "hello"/);

  const [read, edit, bash] = tools(messages);
  // History has Read's numbered text; the numbers are taken off.
  assert.deepEqual(JSON.parse(read.content!), { content: "hi\n" });
  // No line numbers are known without the file, so the diff has no hunk header.
  assert.deepEqual(JSON.parse(edit.content!), { success: true, diff: "--- a/hello.txt\n+++ b/hello.txt\n-hi\n+hello\n" });
  assert.deepEqual(edit.args, { path: "/tmp/aeriportal-cwd/hello.txt", old_string: "hi", new_string: "hello" });
  assert.deepEqual(JSON.parse(bash.content!), { output: "hello", exit_code: 0 });
  assert.equal(bash.tool_call_id, "toolu_011Qem8joxfsu6eARNcTcsi8");
  assert.equal(textOf(messages.at(-1)), 'I changed "hi" to "hello" in hello.txt, and `cat` confirms the file now reads "hello".');
});

test("a denied tool is stored as blocked, so the app shows that it did not run (recorded before the app was called Portals)", () => {
  const [denied, allowed] = tools(history("approval"));
  assert.deepEqual(JSON.parse(denied.content!), { status: "blocked", error: "Denied from AeriPortal.", user_summary: "You denied this change — it was not made." });
  // A file Claude says it created ("File created successfully at: …") is new in its diff too.
  assert.deepEqual(JSON.parse(allowed.content!), { diff: "--- /dev/null\n+++ b/note.txt\n@@ -0,0 +1 @@\n+note\n" });
  assert.equal(history("approval").filter((message) => message.role === "user").length, 2);
});

test("a question is a clarify message with the answer Claude was told", () => {
  const [question] = tools(history("clarify"));
  assert.equal(question.name, "clarify");
  assert.deepEqual(question.args, { questions: [{ question: "Which language do you prefer?", choices: ["Python", "Swift"] }] });
  assert.deepEqual(JSON.parse(question.content!), { responses: [{ question: "Which language do you prefer?", user_response: "Swift" }] });
});

test("an interrupted reply is marked, and Claude's interruption note is not shown as the user's", () => {
  const messages = history("interrupt");
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant"],
  );
  const reply = messages[1] as Extract<StoredMessage, { role: "assistant" }>;
  assert.equal(reply.text, "1\n2\n3\n4");
  assert.deepEqual(reply.display_metadata, { interrupted: true });
});

test("a message sent mid-turn is a turn of its own in history", () => {
  const messages = history("steer");
  assert.deepEqual(
    messages.map((message) => [message.role, textOf(message).split("\n")[0]]),
    [
      ["user", "Count from 1 to 25, one number per line. Do not use any tools."],
      ["assistant", "1"],
      ["user", "When you have finished counting, also say the word banana."],
      ["assistant", "banana"],
    ],
  );
});

test("plan mode: the plan is a row, then the work", () => {
  const names = tools(history("plan")).map((message) => message.name);
  assert.deepEqual(names, ["write_file", "ToolSearch", "plan", "write_file", "read_file"]);
});

test("commands, their output, images and subagents' own messages", () => {
  const messages = historyFromSession(
    [
      { type: "user", message: { role: "user", content: "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args>all</command-args>" }, timestamp: "2026-10-06T10:00:00Z" },
      { type: "user", message: { role: "user", content: "<local-command-stdout>12k of 200k tokens used.</local-command-stdout>" }, timestamp: "2026-10-06T10:00:01Z" },
      { type: "user", message: { role: "user", content: "Caveat: The messages below were generated by the user while running local commands." } },
      { type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "What is this?" }] } },
      { type: "assistant", parent_tool_use_id: "task-1", message: { role: "assistant", content: [{ type: "text", text: "a subagent talking" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "A square." }] } },
    ],
    "/tmp",
  );
  assert.deepEqual(
    messages.map((message) => [message.role, textOf(message)]),
    [
      ["user", "/context all"],
      ["assistant", "12k of 200k tokens used."],
      ["user", "What is this?\n@image:image-1.png"],
      ["assistant", "A square."],
    ],
  );
  // A message without a time takes the one before it.
  assert.equal(messages[2].timestamp, Date.parse("2026-10-06T10:00:01Z") / 1000);
});

test("what Claude Code wrote in the user's place when background work ended is the line the app shows for it", () => {
  const ended = history("background").filter((message) => message.role === "user")[1];
  assert.deepEqual(
    { ...ended, timestamp: 0 },
    {
      role: "user",
      text: 'Background command "Sleep 3 seconds in background" completed (exit code 0)',
      timestamp: 0,
      display_kind: "process_complete",
      display_metadata: { display_text: 'Background command "Sleep 3 seconds in background" completed (exit code 0)' },
    },
  );
  // After a restart: what did not finish, then the user's own message.
  assert.deepEqual(
    history("resumed").map((message) => [message.role, message.role === "user" ? (message.display_kind ?? "") : "", textOf(message).split("\n")[0]]),
    [
      ["user", "", "Run `sleep 600` with the Bash tool in the background (run_in_background: true), then end your turn with one short sentence. Do not wait for it."],
      ["tool", "", ""],
      ["assistant", "", "I started `sleep 600` in the background (task bq3l87u5p) and am not waiting on it."],
      ["user", "process_complete", "Background shell command didn't finish before the previous session ended"],
      ["user", "", "Is that command still running? Answer in one short sentence without using any tools."],
      ["assistant", "", textOf(history("resumed").at(-1)).split("\n")[0]],
    ],
  );
  const agents = historyFromSession(
    [{ type: "user", message: { role: "user", content: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "Write the report" finished</summary>\n<result>Done.</result>\n</task-notification>' } }],
    "/tmp",
  );
  assert.deepEqual(agents.map((message) => (message.role === "user" ? message.display_kind : "")), ["async_delegation_complete"]);
});

test("a /compact: the command, then the mark of where it compacted; the summary and the 'Compacted' after it are left out", () => {
  // getSessionMessages starts again at the compaction: the turn before it is gone.
  assert.deepEqual(history("compact"), [
    { role: "user", text: "/compact", timestamp: Date.parse("2026-11-04T09:19:14.037Z") / 1000 },
    { role: "compaction", trigger: "manual", timestamp: Date.parse("2026-11-04T09:19:18.210Z") / 1000 },
  ]);
});

test("a /compact that compacted nothing is a turn that failed: Claude Code keeps only the command", () => {
  assert.deepEqual(
    history("compact-failed").map((message) => [message.role, textOf(message), message.role === "assistant" ? message.display_kind : undefined]),
    [
      ["user", "/compact", undefined],
      ["assistant", "The conversation was not compacted.", "failed_turn"],
    ],
  );
});

test("a compaction Claude Code made by itself is marked where the conversation goes on", () => {
  const messages = historyFromSession(
    [
      { type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation…" }, timestamp: "2026-10-06T10:00:00Z" },
      { type: "user", message: { role: "user", content: "Carry on with the tests." }, timestamp: "2026-10-06T10:00:01Z" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All pass." }] }, timestamp: "2026-10-06T10:00:02Z" },
    ],
    "/tmp",
  );
  assert.deepEqual(
    messages.map((message) => (message.role === "compaction" ? `compaction:${message.trigger}` : `${message.role}:${textOf(message)}`)),
    ["compaction:auto", "user:Carry on with the tests.", "assistant:All pass."],
  );
  assert.equal(messages[0].timestamp, Date.parse("2026-10-06T10:00:00Z") / 1000);
});

test("each turn's last message says the tokens it spent, the same that its result said live, each request once", () => {
  const spent = (name: string) => history(name).filter((message) => message.turn_usage).map((message) => message.turn_usage?.tokens);
  const live = (name: string) => (joined(replayStream(name)) as ProviderEvent[]).flatMap((event) => (event.type === "turn.end" && event.spent?.tokens ? [event.spent.tokens] : []));
  for (const name of ["plain", "tools", "approval", "background", "subagents", "interrupt"]) assert.deepEqual(spent(name), live(name), name);
  // The live turn had a message steered in; history shows it as a turn of its own, each with its own share.
  assert.deepEqual(spent("steer"), [24_885, 28_254]);
  assert.deepEqual(live("steer"), [24_885 + 28_254]);
  // It goes with the turn's last message: the reply.
  const tools = history("tools");
  assert.equal(tools.at(-1)?.role, "assistant");
  assert.deepEqual(tools.at(-1)?.turn_usage, { tokens: 82_277 });
});

// recovery-8: a turn the bridge recorded running that is over at the next load is told as
// finished only when Claude Code's record shows it ended; one a crash cut off mid-way is
// told as stopped. Entries as Claude Code 2.1.299 stores them (`getSessionMessages`).
test("a session's last turn reads as cut off when its last entry is a tool call, a tool's result or the message that opened it, and as ended after the model's finished answer, a Stop or a command", () => {
  const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
  const answer = (stop_reason: string | null, content: unknown[] = [{ type: "text", text: "Done." }]) => ({ type: "assistant", message: { role: "assistant", content, stop_reason } });
  const call = answer("tool_use", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]);
  const result = user([{ type: "tool_result", tool_use_id: "toolu_1", content: "a\nb" }]);
  const opened = user("Fix the tests");
  // Cut off: the call never ran, its result never answered, the message never answered.
  assert.equal(turnCutOff([opened, call]), true);
  assert.equal(turnCutOff([opened, call, result]), true);
  assert.equal(turnCutOff([answer("end_turn"), opened]), true);
  assert.equal(turnCutOff([opened, answer("tool_use", [{ type: "text", text: "Looking." }]), call]), true);
  // A subagent's entries (its own tool calls) are not the turn's end.
  assert.equal(turnCutOff([opened, answer("end_turn"), { ...call, parent_tool_use_id: "toolu_9" }]), false);
  // Ended: the model's finished answer, a Stop's mark, a command's output.
  assert.equal(turnCutOff([opened, call, result, answer("end_turn")]), false);
  assert.equal(turnCutOff([opened, call, result, answer("max_tokens")]), false);
  assert.equal(turnCutOff([opened, call, result, user([{ type: "text", text: "[Request interrupted by user for tool use]" }])]), false);
  assert.equal(turnCutOff([user("<command-name>/model</command-name><command-args>haiku</command-args>"), user("<local-command-stdout>Set model to haiku</local-command-stdout>")]), false);
  // A skill's command, or the line Claude Code wrote as background work ended, opens a
  // turn the model answers: unanswered, it was cut off (Codex's review). A `/compact`
  // ends its turn without an answer.
  assert.equal(turnCutOff([answer("end_turn"), user("<command-name>/grill-me</command-name><command-args>the plan</command-args>")]), true);
  assert.equal(turnCutOff([answer("end_turn"), user("<task-notification><task-id>b1</task-id><status>completed</status><summary>Background command \"npm test\" completed (exit code 0)</summary></task-notification>")]), true);
  assert.equal(turnCutOff([opened, answer("end_turn"), { type: "user", isCompactSummary: true, message: { role: "user", content: "Summary" } }, user("<command-name>/compact</command-name><command-args></command-args>")]), false);
  assert.equal(turnCutOff([opened, answer("end_turn"), user("<command-name>/compact</command-name><command-args></command-args>")]), false);
  // Not known (no stop reason), and nothing at all: as before, ended.
  assert.equal(turnCutOff([opened, answer(null)]), false);
  assert.equal(turnCutOff([]), false);
});

test("a Claude session loaded from its file says whether its last turn was cut off", async () => {
  const { provider, files } = fakeClaude();
  const sink = { emit() {} } as never;
  const settings = { model: "default", provider: "anthropic", reasoningEffort: "" };
  const opened = { type: "user", message: { role: "user", content: "Fix the tests" } };
  files.stored.set("cut", { title: null, messages: [opened, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }], stop_reason: "tool_use" } }] });
  files.stored.set("ended", { title: null, messages: [opened, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed." }], stop_reason: "end_turn" } }] });
  const cut = await provider.resumeSession({ id: "cut", cwd: "/tmp", settings, title: null }, sink);
  const ended = await provider.resumeSession({ id: "ended", cwd: "/tmp", settings, title: null }, sink);
  assert.equal(cut.lastTurnCutOff?.(), true);
  assert.equal(ended.lastTurnCutOff?.(), false);
  await cut.close();
  await ended.close();
});

// recovery-7, verified with real Claude Code 2.1.299 on 2026-10-26 (Haiku, a scratch folder,
// every tool denied): a turn stopped as the bridge stops one (ClaudeSession.close: the
// interrupt, then its input ended right after the answer) leaves its partial answer, with
// no stop reason, and `[Request interrupted by user]` (the run's three entries, paths
// replaced). It reads back as stopped, and not as cut off.
test("a turn stopped as the bridge stops one reads back as stopped: real Claude Code wrote its interrupted mark (recovery-7)", () => {
  const entries = readFileSync(new URL("./fixtures/claude/stopped-at-close.session.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const stored = historyFromSession(entries, "/tmp/aeriportal-cwd") as (StoredMessage & { text?: unknown; display_metadata?: { interrupted?: boolean } })[];
  assert.deepEqual(stored.map((message) => [message.role, message.display_metadata?.interrupted ?? false]), [["user", false], ["assistant", true]]);
  assert.match(String(stored[1].text), /^1\n2\n3\n/);
  assert.equal(entries[1].message.stop_reason, null);
  assert.equal(turnCutOff(entries), false);
});
