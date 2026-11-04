import "./environment.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { machineWord } from "../src/platform.ts";
import { ClaudeSignIn } from "../src/providers/claude/signIn.ts";
import { ClaudeStream, ContextWindows } from "../src/providers/claude/stream.ts";
import { fromAgentLog, fromJournal, pastSubagents } from "../src/providers/claude/tasks.ts";
import { tinyCheckJournal } from "./claude-fixtures.ts";
import type { ProviderEvent } from "../src/providers/types.ts";
import { fixture, joined, processes, recordedHistory, replayStream } from "./claude-fixtures.ts";

// Golden tests: real Claude Code streams (test/fixtures/claude, recorded with
// scripts/record-claude.ts) through the mapper, with no Claude running. Each
// `<name>.events.json` is what the mapper made of `<name>.jsonl` when it was last
// checked by hand; UPDATE_GOLDEN=1 rewrites them after a deliberate change.

const scenarios = ["plain", "tools", "approval", "clarify", "plan", "interrupt", "steer", "background", "resumed", "compact", "compact-failed", "subagents", "workflow-stop"];

for (const name of scenarios) {
  test(`${name}: the recording maps to its golden events`, () => {
    // As JSON has them: a key left undefined (no usage known yet) is no key.
    const events = JSON.parse(JSON.stringify(joined(replayStream(name))));
    const golden = new URL(`fixtures/claude/${name}.events.json`, import.meta.url);
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

test("a result releases streamed message ids, including one followed by another queued turn", () => {
  const stream = new ClaudeStream({ cwd: "/tmp" });
  const map = (message: Record<string, unknown>) => stream.map(message as Parameters<ClaudeStream["map"]>[0]);
  stream.sent("first");
  stream.sent("second");
  for (const [n, user] of ["first", "second"].entries()) {
    const id = `streamed-${n}`;
    map({ type: "stream_event", event: { type: "message_start", message: { id } } });
    assert.equal(text(map({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } })), "hello");
    assert.equal(ofType(map({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "thought" } } }), "reasoning")[0].text, "thought");
    assert.deepEqual(map({ type: "assistant", message: { id, content: [{ type: "text", text: "hello" }, { type: "thinking", thinking: "thought" }] } }), [], "the final message does not repeat its streamed blocks");
    const result = map({ type: "result", subtype: "success", user_message_uuids: [user] });
    assert.equal(ofType(result, "turn.end").length, n);
    // These ids are needed only to suppress the whole messages before their result.
    const held = Object.values(stream).filter((value) => value instanceof Set && value.has(id));
    assert.equal(held.length, 0, "completed requests leave no ids in the stream's dedup sets");
  }
});

test("a plain reply streams its text and ends complete with the context use; thinking streams before what it leads to", () => {
  const events = replayStream("plain");
  assert.match(text(events), /^Hello/);
  // What the turn spent: the result's usage, in, out and cached (it read and wrote the cache), each once.
  assert.deepEqual(events.at(-1), { type: "turn.end", status: "complete", usage: { used: 24847, max: 1_000_000 }, spent: { tokens: 24847 } });
  // The whole messages that repeat the streamed text add nothing.
  assert.equal(ofType(events, "turn.end").length, 1);
  // Haiku 5.5 thinks when it chooses to (adaptive thinking): not for that hello, nor for its Read, but before its edit.
  const tools = replayStream("tools");
  assert.ok(ofType(tools, "reasoning").length > 5, "thinking streams word by word");
  assert.ok(tools.findIndex((event) => event.type === "reasoning") < tools.findIndex((event) => event.type === "tool.start" && event.name === "patch"));
});

// 2026-10-27, an hour into a Claude Code thread's first turn: "in this session i
// cant see ur context usage". The window came only from a result, so each process showed
// no meter until its first turn ended.
test("a process on a model an earlier one ran shows the context use from its first request, not its turn's end", () => {
  const windows = new ContextWindows();
  const first = replayStream("plain", { windows });
  assert.deepEqual(ofType(first, "usage"), [], "the first process on a model learns its window from its result");
  const second = replayStream("plain", { windows });
  const shown = ofType(second, "usage")[0];
  assert.equal(shown?.usage.max, 1_000_000);
  assert.ok(shown.usage.used > 0);
  assert.ok(second.indexOf(shown) < second.findIndex((event) => event.type === "text"), "before a word of the reply");
});

test("the window Claude Code gives when asked shows the context use at once, and is the model's for its next process", () => {
  const windows = new ContextWindows();
  const map = (stream: ClaudeStream, message: Record<string, unknown>) => stream.map(message as Parameters<ClaudeStream["map"]>[0]);
  const start = (stream: ClaudeStream, model: string) => {
    map(stream, { type: "system", subtype: "init", model });
    return map(stream, { type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 10, cache_read_input_tokens: 990 } } } });
  };
  const stream = new ClaudeStream({ cwd: "/tmp", windows });
  assert.deepEqual(start(stream, "claude-haiku-5-5"), []);
  assert.equal(stream.knowsWindow, false);
  assert.deepEqual(stream.window("claude-haiku-5-5", 1_000_000), [{ type: "usage", usage: { used: 1000, max: 1_000_000 } }]);
  assert.deepEqual(stream.window("claude-haiku-5-5", 200_000), [], "a window known is kept");
  assert.deepEqual(start(new ClaudeStream({ cwd: "/tmp", windows }), "claude-haiku-5-5"), [{ type: "usage", usage: { used: 1000, max: 1_000_000 } }]);
  // Another model's window is its own, and an answer for another model than the process runs says nothing of it.
  const opus = new ClaudeStream({ cwd: "/tmp", windows });
  assert.deepEqual(start(opus, "claude-opus-5-5"), []);
  assert.deepEqual(opus.window("claude-haiku-5-5", 1_000_000), []);
  assert.equal(opus.knowsWindow, false);
  // Before a request there is nothing to measure yet; the first one shows it.
  const early = new ClaudeStream({ cwd: "/tmp", windows: new ContextWindows() });
  map(early, { type: "system", subtype: "init", model: "claude-sonnet-5-5" });
  assert.deepEqual(early.window("claude-sonnet-5-5", 1_000_000), []);
  assert.deepEqual(map(early, { type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 5 } } } }), [{ type: "usage", usage: { used: 5, max: 1_000_000 } }]);
});

test("tools become the app's rows: Read, then Edit with a diff from Claude's patch, then Bash with its output", () => {
  const events = replayStream("tools");
  const ends = ofType(events, "tool.end");
  assert.deepEqual(
    ends.map((event) => event.name),
    ["read_file", "patch", "terminal"],
  );
  const [read, edit, bash] = ends;
  assert.deepEqual(read.args, { path: "/tmp/aeriportal-cwd/hello.txt" });
  // Claude's own result has the file without its line numbers.
  assert.deepEqual(read.result, { content: "hi\n" });
  // Only path, old and new: the app shows the diff and no input.
  assert.deepEqual(edit.args, { path: "/tmp/aeriportal-cwd/hello.txt", old_string: "hi", new_string: "hello" });
  assert.deepEqual(edit.result, { success: true, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n" });
  assert.deepEqual(bash.args, { command: "cat hello.txt" });
  assert.deepEqual(bash.result, { output: "hello", exit_code: 0 });
  // Each start comes before its end, and every start ends.
  for (const end of ends) {
    assert.ok(events.findIndex((event) => event.type === "tool.start" && event.id === end.id) < events.indexOf(end));
  }
  assert.equal(ofType(events, "tool.start").length, 3);
});

test("a denied write is stored as blocked; the allowed one as a new file's diff", () => {
  const events = replayStream("approval");
  const writes = ofType(events, "tool.end");
  assert.deepEqual(writes[0].result, { status: "blocked", error: "Denied from AeriPortal.", user_summary: "You denied this change — it was not made." });
  assert.deepEqual(writes[1].result, { diff: "--- /dev/null\n+++ b/note.txt\n@@ -0,0 +1 @@\n+note\n" });
  assert.deepEqual(
    ofType(events, "turn.end").map((event) => event.status),
    ["complete", "complete"],
  );
  // From the second turn on, the window is known and the context use is reported as it grows.
  assert.ok(ofType(events, "usage").length >= 2);
});

test("AskUserQuestion is a clarify row with the answer, which the app shows as the question", () => {
  const events = replayStream("clarify");
  const [start] = ofType(events, "tool.start");
  const [end] = ofType(events, "tool.end");
  assert.equal(start.name, "clarify");
  assert.deepEqual(start.args, { questions: [{ question: "Which language do you prefer?", choices: ["Python", "Swift"] }] });
  assert.deepEqual(end.result, { responses: [{ question: "Which language do you prefer?", user_response: "Swift" }] });
  assert.match(text(events), /Swift/);
});

test("plan mode: the plan is a row of its own, then the work it planned", () => {
  const events = replayStream("plan");
  const names = ofType(events, "tool.end").map((event) => event.name);
  assert.deepEqual(names, ["write_file", "ToolSearch", "plan", "write_file", "read_file"]);
  const plan = ofType(events, "tool.end")[2];
  assert.match(String(plan.args.content), /^# Plan: create plan\.txt/);
  assert.deepEqual(plan.result, { output: "Plan approved." });
  // No label: the row is called Plan already.
  assert.equal(plan.context, undefined);
  assert.deepEqual(ofType(events, "tool.end")[1].result, { output: "ExitPlanMode" });
});

test("an interrupted turn ends interrupted, with what streamed before it", () => {
  const events = replayStream("interrupt");
  assert.equal(text(events), "1\n2\n3\n4");
  // Claude Code's result for a stopped turn says no usage: what its request streamed, as its stored session keeps it.
  assert.deepEqual(events.at(-1), { type: "turn.end", status: "interrupted", usage: { used: 24851, max: 1_000_000 }, spent: { tokens: 24851 } });
});

test("a message sent mid-turn that gets a turn of its own stays in the app's one turn", () => {
  const events = replayStream("steer");
  // One end for both messages: the result for the first names only the first.
  assert.equal(ofType(events, "turn.end").length, 1);
  // The first reply is closed off, so the second does not run into it.
  const [closed] = ofType(events, "commentary");
  assert.equal(closed.alreadyStreamed, true);
  assert.match(closed.text, /^1\n2\n3/);
  assert.ok(events.indexOf(closed) < events.findLastIndex((event) => event.type === "text"));
  assert.equal(text(events.slice(events.indexOf(closed))), "banana");
});

test("without uuids (an older Claude Code), every result ends the turn", () => {
  const stream = new ClaudeStream({ cwd: "/tmp" });
  stream.sent("a");
  stream.sent("b");
  const end = stream.map({ type: "result", subtype: "success", is_error: false } as never);
  assert.deepEqual(end, [{ type: "turn.end", status: "complete", usage: undefined }]);
});

test("a result that answers only some of the messages keeps the turn open", () => {
  const stream = new ClaudeStream({ cwd: "/tmp" });
  stream.sent("a");
  stream.sent("b");
  assert.deepEqual(stream.map({ type: "result", subtype: "success", is_error: false, user_message_uuids: ["a"] } as never), []);
  assert.equal(stream.map({ type: "result", subtype: "success", is_error: false, user_message_uuids: ["b"] } as never)[0].type, "turn.end");
});

test("an error on a message with another sent in behind it is said in passing, and the turn goes on to answer that one", () => {
  const stream = new ClaudeStream({ cwd: "/tmp" });
  stream.sent("a");
  stream.sent("b");
  stream.map({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } } as never);
  stream.map({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Looking" } } } as never);
  assert.deepEqual(stream.map({ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded", user_message_uuids: ["a"] } as never), [
    { type: "commentary", text: "Looking", alreadyStreamed: true },
    { type: "notice", level: "error", text: "API Error: 529 overloaded" },
  ]);
  assert.deepEqual(stream.map({ type: "result", subtype: "success", is_error: false, user_message_uuids: ["b"] } as never), [{ type: "turn.end", status: "complete", usage: undefined }]);
  // One that stopped without a word says so all the same.
  const quiet = new ClaudeStream({ cwd: "/tmp" });
  quiet.sent("a");
  quiet.sent("b");
  assert.deepEqual(quiet.map({ type: "result", subtype: "error_during_execution", is_error: true, errors: [], user_message_uuids: ["a"] } as never), [
    { type: "notice", level: "error", text: "Claude Code stopped with an error." },
  ]);
});

test("the API's error is said once: Claude Code's own message saying it is left out, as the result says it", () => {
  // As Claude Code 2.1.299 sends it for a model that does not exist, with a second message waiting.
  const refused = "There's an issue with the selected model (claude-nonexistent-9-9). It may not exist or you may not have access to it.";
  const said = (uuid: string) => ({ type: "assistant", error: "model_not_found", message: { id: `e-${uuid}`, model: "<synthetic>", role: "assistant", content: [{ type: "text", text: refused }] }, user_message_uuids: [uuid] });
  const result = (uuid: string) => ({ type: "result", subtype: "success", is_error: true, result: refused, user_message_uuids: [uuid] });
  const stream = new ClaudeStream({ cwd: "/tmp" });
  stream.sent("a");
  stream.sent("b");
  assert.deepEqual(stream.map(said("a") as never), []);
  assert.deepEqual(stream.map(result("a") as never), [{ type: "notice", level: "error", text: refused }]);
  assert.deepEqual(stream.map(said("b") as never), []);
  assert.deepEqual(stream.map(result("b") as never), [{ type: "turn.end", status: "error", error: refused, retryable: true, usage: undefined }]);
});

test("a turn Claude Code refuses for the sign-in ends with what to run on the host, not its /login, and can be tried again", () => {
  // As Claude Code 2.1.318 says it with no sign-in (an empty config folder).
  const said = { type: "assistant", error: "authentication_failed", is_api_error_message: true, message: { id: "e", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Not logged in · Please run /login" }] } };
  const result = { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", terminal_reason: "api_error" };
  const refused = (signIn?: ClaudeSignIn) => {
    const stream = new ClaudeStream({ cwd: "/tmp", ...(signIn ? { signIn: signIn.thread("a") } : {}) });
    assert.deepEqual(stream.map(said as never), []);
    return stream.map(result as never);
  };
  const signedOut = `Claude Code is not signed in on this ${machineWord()}. Run \`claude auth login\` in a terminal there, then try again.`;
  assert.deepEqual(refused(), [{ type: "turn.end", status: "error", error: signedOut, retryable: true, usage: undefined }]);
  const now = Date.parse("2026-11-28T12:00:00Z");
  const login = new ClaudeSignIn({ credential: "login", now: () => now, timeZone: "UTC" });
  assert.equal((refused(login)[0] as { error: string }).error, signedOut);
  // A login Claude Code said ends before now has ended.
  login.heard("2026-11-27T08:00:00.000Z");
  assert.equal((refused(login)[0] as { error: string }).error, `Claude Code's sign-in on this ${machineWord()} has ended. Run \`claude auth login\` in a terminal there, then try again.`);
  // A key or a token in config.json is what was refused.
  assert.match((refused(new ClaudeSignIn({ credential: "apiKey" }))[0] as { error: string }).error, /^Claude Code was refused the API key in the host's config.json \(claude.apiKey\)/);
  assert.match((refused(new ClaudeSignIn({ credential: "oauthToken" }))[0] as { error: string }).error, /^Claude Code was refused the token in the host's config.json \(claude.oauthToken\)\. Make a new one with `claude setup-token`/);
  // A refusal of another kind is Claude Code's own words, and the next result is not taken for one.
  const stream = new ClaudeStream({ cwd: "/tmp", signIn: login.thread("a") });
  stream.map(said as never);
  stream.map(result as never);
  assert.deepEqual(stream.map({ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded" } as never), [
    { type: "turn.end", status: "error", error: "API Error: 529 overloaded", retryable: true, usage: undefined },
  ]);
});

test("from ten days before the Claude sign-in ends, each thread says so once a day, until it is renewed", () => {
  let now = Date.parse("2026-11-16T09:00:00Z");
  const signIn = new ClaudeSignIn({ credential: "login", now: () => now, timeZone: "UTC" });
  const end = (stream: ClaudeStream, endsAt = "2026-11-27T08:00:00.000Z") => stream.map({ type: "result", subtype: "success", is_error: false, credential_expires_at: endsAt } as never);
  const notice = { type: "notice", level: "warn", text: `Claude Code's sign-in on this ${machineWord()} ends on Fri, Nov 27. Run \`claude auth login\` in a terminal there before then to keep its threads working.` };
  const complete = { type: "turn.end", status: "complete", usage: undefined };
  const first = new ClaudeStream({ cwd: "/tmp", signIn: signIn.thread("a") });
  // Eleven days before: nothing yet.
  assert.deepEqual(end(first), [complete]);
  now = Date.parse("2026-11-17T09:00:00Z");
  assert.deepEqual(end(first), [notice, complete]);
  assert.deepEqual(end(first), [complete]);
  // Another thread, and another process of the first, the same day.
  assert.deepEqual(end(new ClaudeStream({ cwd: "/tmp", signIn: signIn.thread("b") })), [notice, complete]);
  assert.deepEqual(end(new ClaudeStream({ cwd: "/tmp", signIn: signIn.thread("a") })), [complete]);
  // The next day it says so again.
  now = Date.parse("2026-11-18T09:00:00Z");
  assert.deepEqual(end(first), [notice, complete]);
  // Signed in again: the new login ends a month on.
  now = Date.parse("2026-11-19T09:00:00Z");
  assert.deepEqual(end(first, "2026-12-19T08:00:00.000Z"), [complete]);
  // A result that says no date (an older Claude Code, an API key) leaves what was said.
  assert.deepEqual(first.map({ type: "result", subtype: "success", is_error: false } as never), [complete]);
});

test("an error result ends the turn as failed with a sentence; a tool left open is closed as stopped", () => {
  const stream = new ClaudeStream({ cwd: "/tmp", now: () => 0 });
  stream.map({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 100" } }] } } as never);
  const events = stream.map({ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded" } as never);
  assert.deepEqual(events, [
    { type: "tool.end", id: "t1", name: "terminal", args: { command: "sleep 100" }, result: { status: "error", error: "Stopped before it finished." } },
    { type: "turn.end", status: "error", error: "API Error: 529 overloaded", retryable: true, usage: undefined },
  ]);
  const quiet = new ClaudeStream({ cwd: "/tmp" }).map({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["[ede_diagnostic] x"] } as never);
  assert.deepEqual(quiet, [{ type: "turn.end", status: "error", error: "Claude Code stopped with an error.", retryable: true, usage: undefined }]);
});

test("a usage limit at 80% or more is a warning, once per window", () => {
  const stream = new ClaudeStream({ cwd: "/tmp", timeZone: "UTC" });
  const event = (fiveHour: number) =>
    ({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: { five_hour: { utilization: fiveHour, resetsAt: 1791337800 }, seven_day: { utilization: 0.09, resetsAt: 1791856800 } },
      },
    }) as never;
  assert.deepEqual(stream.map(event(0.15)), []);
  assert.deepEqual(stream.map(event(0.85)), [{ type: "notice", level: "warn", text: "You have used 85% of your 5-hour Claude limit; it resets Wed 1:50 AM." }]);
  assert.deepEqual(stream.map(event(0.9)), []);
  assert.deepEqual(stream.map({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1791856800 } } as never), [
    { type: "notice", level: "warn", text: "You have reached your weekly Claude usage limit; it resets Tue 2:00 AM." },
  ]);
  // The recordings' own events are far below the line.
  assert.deepEqual(ofType(replayStream("plain"), "notice"), []);
});

test("compacting shows a passing status, and a subagent's own messages are left out", () => {
  const stream = new ClaudeStream({ cwd: "/tmp" });
  assert.deepEqual(stream.map({ type: "system", subtype: "status", status: "compacting" } as never), [{ type: "status", text: "Compacting the conversation…" }]);
  assert.deepEqual(stream.map({ type: "system", subtype: "status", status: null } as never), [{ type: "status", text: "" }]);
  assert.deepEqual(
    stream.map({ type: "stream_event", parent_tool_use_id: "task-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "inside" } } } as never),
    [],
  );
});

test("/compact with nothing to compact ends its turn with Claude Code's reason, which asking again would not change", () => {
  const events = replayStream("compact");
  const ends = ofType(events, "turn.end");
  assert.equal(ends.length, 3);
  assert.deepEqual(ends[0], { type: "turn.end", status: "error", error: "No messages to compact.", retryable: false, usage: undefined });
  // Claude Code's "Error: …" is not Claude speaking.
  assert.equal(text(events.slice(0, events.indexOf(ends[0]))), "");
  assert.deepEqual(replayStream("compact-failed"), [ends[0]]);
});

test("/compact that runs: a passing status, the mark of its place with the tokens before, and the context falls to the summary", () => {
  const events = replayStream("compact");
  const ends = ofType(events, "turn.end");
  const last = events.slice(events.indexOf(ends[1]) + 1);
  assert.deepEqual(last, [
    { type: "status", text: "Compacting the conversation…" },
    { type: "status", text: "" },
    { type: "compacted", trigger: "manual", tokensBefore: 24966 },
    { type: "usage", usage: { used: 8584, max: 1_000_000 } },
    // Neither the summary nor Claude Code's "Compacted" is said.
    { type: "turn.end", status: "complete", usage: { used: 8584, max: 1_000_000 } },
  ]);
});

test("a compaction that fails ends the /compact that asked for it, and is only a warning in a turn Claude Code compacted by itself", () => {
  const failed = { type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "the API did not answer" } as never;
  const asked = new ClaudeStream({ cwd: "/tmp" });
  asked.map({ type: "system", subtype: "status", status: "compacting" } as never);
  assert.deepEqual(asked.map(failed), [{ type: "status", text: "" }]);
  assert.deepEqual(asked.map({ type: "result", subtype: "success", is_error: false, local_command: "compact" } as never), [
    { type: "turn.end", status: "error", error: "The conversation was not compacted: the API did not answer.", retryable: true, usage: undefined },
  ]);

  const byItself = new ClaudeStream({ cwd: "/tmp" });
  byItself.map(failed);
  assert.deepEqual(byItself.map({ type: "result", subtype: "success", is_error: false } as never), [
    { type: "notice", level: "warn", text: "The conversation was not compacted: the API did not answer." },
    { type: "turn.end", status: "complete", usage: undefined },
  ]);
  // Claude Code compacting by itself mid-turn is marked too.
  assert.deepEqual(new ClaudeStream({ cwd: "/tmp" }).map({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 180_000 } } as never), [
    { type: "compacted", trigger: "auto", tokensBefore: 180_000 },
  ]);
});

test("init and status messages tell the session its model and mode", () => {
  const stream = new ClaudeStream({ cwd: "/tmp" });
  for (const entry of fixture("plan")) if (entry.kind === "message") stream.map(entry.message);
  assert.equal(stream.reported.model, "claude-haiku-5-5");
  // Approving the plan moved the session out of plan mode.
  assert.equal(stream.reported.permissionMode, "default");
});

test("background work: the stream says it runs until it ends, and the turn Claude begins then says what ended", () => {
  const stream = new ClaudeStream({ cwd: "/tmp/aeriportal-cwd", now: () => 0 });
  const running: boolean[] = [];
  const events: ProviderEvent[] = [];
  for (const entry of fixture("background")) {
    if (entry.kind === "send") stream.sent(entry.uuid!);
    if (entry.kind !== "message") continue;
    events.push(...stream.map(entry.message));
    running.push(stream.hasBackgroundWork);
  }
  // Running from when the command started in the background until it ended, after the first turn.
  assert.equal(running.at(0), false);
  assert.ok(running.includes(true));
  assert.equal(running.at(-1), false);
  const begun = ofType(events, "turn.begin");
  assert.deepEqual(begun, [
    {
      type: "turn.begin",
      user: 'Background command "Sleep 3 seconds in background" completed (exit code 0)',
      host: { kind: "process_complete", text: 'Background command "Sleep 3 seconds in background" completed (exit code 0)' },
    },
  ]);
  // Two turns, each ended once: the app's, then Claude's own.
  const order = events.filter((event) => event.type === "turn.begin" || event.type === "turn.end").map((event) => event.type);
  assert.deepEqual(order, ["turn.end", "turn.begin", "turn.end"]);
});

test("a resumed session's empty result answers nothing: the turn ends with the reply to the message", () => {
  const [, resumed] = processes("resumed");
  const stream = new ClaudeStream({ cwd: "/tmp/aeriportal-cwd" });
  const events: ProviderEvent[] = [];
  for (const entry of resumed) {
    if (entry.kind === "send") stream.sent(entry.uuid!);
    if (entry.kind === "message") events.push(...stream.map(entry.message));
  }
  assert.deepEqual(ofType(events, "turn.begin"), []);
  assert.equal(ofType(events, "turn.end").length, 1);
  assert.equal(events.at(-1)?.type, "turn.end");
  assert.match(text(events), /^Probably not: the notification says the task stopped/);
});

test("work that ends while a message waits: Claude's own turn first keeps the app's turn open", () => {
  const stream = new ClaudeStream({ cwd: "/tmp" });
  stream.map({ type: "system", subtype: "task_started", task_id: "w1", task_type: "local_workflow", description: "Four fixes" } as never);
  stream.map({ type: "system", subtype: "task_notification", task_id: "w1", status: "completed", summary: 'Dynamic workflow "Four fixes" completed' } as never);
  stream.sent("a");
  assert.deepEqual(stream.map({ type: "system", subtype: "status", status: "requesting" } as never), [
    { type: "turn.begin", user: 'Dynamic workflow "Four fixes" completed', host: { kind: "async_delegation_complete", text: 'Dynamic workflow "Four fixes" completed' } },
  ]);
  assert.deepEqual(stream.map({ type: "result", subtype: "success", is_error: false, num_turns: 1 } as never), []);
  assert.deepEqual(stream.map({ type: "system", subtype: "status", status: "requesting", user_message_uuids: ["a"] } as never), []);
  assert.equal(stream.map({ type: "result", subtype: "success", is_error: false, num_turns: 1, user_message_uuids: ["a"] } as never)[0].type, "turn.end");
});

test("an agent that ends is named by its description, not its reply; several are counted; watchers are not work", () => {
  const stream = new ClaudeStream({ cwd: "/tmp" });
  stream.map({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [
      { task_id: "a1", task_type: "local_agent", description: "pong check" },
      { task_id: "m1", task_type: "local_bash", description: "watch the log", ambient: true },
    ],
  } as never);
  assert.equal(stream.hasBackgroundWork, true);
  stream.map({ type: "system", subtype: "task_notification", task_id: "a1", status: "completed", summary: "pong" } as never);
  stream.map({ type: "system", subtype: "task_notification", task_id: "b1", status: "failed", summary: 'Background command "make" failed with exit code 2' } as never);
  stream.map({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "m1", task_type: "local_bash", description: "watch the log", ambient: true }] } as never);
  assert.equal(stream.hasBackgroundWork, false);
  assert.deepEqual(stream.map({ type: "system", subtype: "status", status: "requesting" } as never), [
    { type: "turn.begin", user: 'Agent "pong check" finished (and 1 more)', host: { kind: "async_delegation_complete", text: 'Agent "pong check" finished (and 1 more)' } },
  ]);
});

test("a background subagent and a workflow: news of each from its start to its end, with the workflow's phases and agents", () => {
  const news = ofType(replayStream("subagents"), "subagent").map((event) => event.subagent);
  const agent = news.filter((subagent) => subagent.kind === "agent");
  const workflow = news.filter((subagent) => subagent.kind === "workflow");
  // Its kind, as Claude Code names it at the desk.
  assert.deepEqual(agent[0], { id: "a24479d5e93836222", kind: "agent", goal: "Count the files", role: "general-purpose", status: "running", startedAt: 0, background: true, stoppable: true });
  // Before the model's first summary, Claude Code's own line on its last tool.
  assert.equal(agent[1].summary, "Running List entries in current working directory");
  assert.equal(agent[1].tool, "terminal");
  const done = agent.at(-1)!;
  assert.equal(done.status, "completed");
  assert.equal(done.stoppable, false);
  assert.equal(done.summary, undefined);
  assert.match(done.result ?? "", /^0 entries\./);
  assert.equal(done.tokens, 18631);

  assert.deepEqual(
    { ...workflow[0] },
    { id: "wwn9e3l29", kind: "workflow", goal: "Two haiku agents reply with apple and pear in parallel", name: "tiny-check", status: "running", startedAt: 0, background: true, stoppable: true },
  );
  const first = workflow[1];
  assert.deepEqual(first.phases, [{ index: 1, title: "Check" }]);
  assert.deepEqual(
    first.agents?.map((one) => [one.label, one.phase, one.status]),
    [
      ["apple", "Check", "running"],
      ["pear", "Check", "running"],
    ],
  );
  // Its "summary" is only its description again, and its "tool" an agent's label.
  assert.equal(first.summary, undefined);
  assert.equal(first.tool, undefined);
  const ended = workflow.at(-1)!;
  assert.equal(ended.status, "completed");
  assert.deepEqual(
    ended.agents?.map((one) => [one.label, one.model, one.status, one.result]),
    [
      ["apple", "claude-haiku-5-5", "completed", "apple"],
      ["pear", "claude-haiku-5-5", "completed", "pear"],
    ],
  );
  assert.equal(ended.result, 'Dynamic workflow "Two haiku agents reply with apple and pear in parallel" completed');
});

test("a subagent in the foreground is part of the turn: it cannot be stopped by itself until it moves to the background", () => {
  const stream = new ClaudeStream({ cwd: "/tmp", now: () => 5 });
  const [started] = stream.map({ type: "system", subtype: "task_started", task_id: "f1", task_type: "local_agent", description: "Look around", is_backgrounded: false } as never);
  assert.deepEqual(started, { type: "subagent", subagent: { id: "f1", kind: "agent", goal: "Look around", status: "running", startedAt: 5, background: false, stoppable: false } });
  assert.equal(stream.board.isStoppable("f1"), false);
  stream.map({ type: "system", subtype: "task_updated", task_id: "f1", patch: { is_backgrounded: true } } as never);
  assert.equal(stream.board.isStoppable("f1"), true);
  // Commands and watchers are not agents.
  assert.deepEqual(stream.map({ type: "system", subtype: "task_started", task_id: "b1", task_type: "local_bash", description: "sleep 3" } as never), []);
  // Stopped: it ends so, and the stream says nothing more of it running.
  const [stopped] = stream.map({ type: "system", subtype: "task_updated", task_id: "f1", patch: { status: "killed", end_time: 9 } } as never);
  assert.deepEqual(stopped, { type: "subagent", subagent: { id: "f1", kind: "agent", goal: "Look around", status: "stopped", startedAt: 5, endedAt: 9, background: true, stoppable: false } });
  assert.equal(stream.board.isRunning, false);
});

test("a subagent's line is the model's summary once there is one: Claude Code's line on each tool does not replace it, a later summary does", () => {
  const stream = new ClaudeStream({ cwd: "/tmp", now: () => 5 });
  const progress = (more: Record<string, unknown>) => {
    const [news] = stream.map({ type: "system", subtype: "task_progress", task_id: "s1", ...more } as never);
    return news?.type === "subagent" ? news.subagent.summary : undefined;
  };
  stream.map({ type: "system", subtype: "task_started", task_id: "s1", task_type: "local_agent", description: "Step through", is_backgrounded: true } as never);
  // As seen live (Claude Code 2.1.299 on Haiku): its own line before each tool, the model's summary after half a minute.
  assert.equal(progress({ description: "Running Ping localhost 12 times", last_tool_name: "Bash" }), "Running Ping localhost 12 times");
  assert.equal(progress({ description: "Running Print system information", last_tool_name: "Bash" }), "Running Print system information");
  assert.equal(progress({ description: "Step through", summary: "Pinging localhost for the third time" }), "Pinging localhost for the third time");
  assert.equal(progress({ description: "Running Ping localhost 12 times", last_tool_name: "Bash" }), "Pinging localhost for the third time");
  assert.equal(progress({ description: "Step through", summary: "Checking the system details" }), "Checking the system details");
});

test("a subagent resumed by Claude is at work again, and what its earlier run says late does not end the new run", () => {
  const stream = new ClaudeStream({ cwd: "/tmp", now: () => 5 });
  const task = (subtype: string, run: string, more: Record<string, unknown> = {}) =>
    stream.map({ type: "system", subtype, task_id: "a1", run_id: run, task_type: "local_agent", description: "Count", is_backgrounded: true, ...more } as never);
  task("task_started", "001");
  task("task_notification", "001", { status: "completed", summary: "Three." });
  // Given more to do: the same task, a new run.
  const [again] = task("task_started", "002");
  assert.equal(again.type === "subagent" && again.subagent.status, "running");
  // The first run's late words change nothing.
  assert.deepEqual(task("task_updated", "001", { patch: { status: "completed", end_time: 9 } }), []);
  assert.deepEqual(task("task_notification", "001", { status: "completed", summary: "Three." }), []);
  assert.equal(stream.board.isStoppable("a1"), true);
  // Nor do they count as work that ended, which would begin Claude's next turn of its own with "Agent finished".
  assert.deepEqual(stream.map({ type: "system", subtype: "status", status: "requesting" } as never)[0], {
    type: "turn.begin",
    user: 'Agent "Count" finished',
    host: { kind: "async_delegation_complete", text: 'Agent "Count" finished' },
  });
  assert.deepEqual(stream.map({ type: "system", subtype: "status", status: "requesting" } as never), []);
  // The new run's own end ends it; one with no run id (an older Claude Code) is taken as before.
  const [ended] = task("task_notification", "002", { status: "completed", summary: "Four." });
  assert.deepEqual(ended.type === "subagent" && [ended.subagent.status, ended.subagent.result], ["completed", "Four."]);
  assert.equal(stream.map({ type: "system", subtype: "task_started", task_id: "a2", task_type: "local_agent", description: "Old" } as never).length, 1);
  assert.equal(stream.map({ type: "system", subtype: "task_notification", task_id: "a2", status: "completed", summary: "Done." } as never).length, 1);
});

test("subagents still running when Claude's process ends are stopped with it", () => {
  const stream = new ClaudeStream({ cwd: "/tmp", now: () => 7 });
  stream.map({ type: "system", subtype: "task_started", task_id: "w1", task_type: "local_workflow", workflow_name: "spec", description: "Write the spec" } as never);
  stream.map({
    type: "system",
    subtype: "task_progress",
    task_id: "w1",
    workflow_progress: [
      { type: "workflow_phase", index: 1, title: "Draft" },
      { type: "workflow_agent", index: 1, label: "writer", phaseTitle: "Draft", state: "start" },
    ],
  } as never);
  const [stopped] = stream.board.stopAll();
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.endedAt, 7);
  assert.deepEqual(stopped.agents, [{ id: "1", label: "writer", phase: "Draft", status: "stopped" }]);
  assert.deepEqual(stream.board.stopAll(), []);
});

test("a stored conversation tells of its subagents and workflows: what they were, how they ended, and the turn that started them", () => {
  const past = pastSubagents(recordedHistory("workflow-stop"));
  assert.equal(past.length, 1);
  const [{ subagent, turn }] = past;
  assert.deepEqual(
    { ...subagent, startedAt: 0, endedAt: 0 },
    { id: "w1ye6xeq1", kind: "workflow", goal: "Run one haiku agent that sleeps 45 seconds and replies done", name: "slow-check", status: "stopped", startedAt: 0, endedAt: 0, background: true, stoppable: false },
  );
  assert.equal(turn, 0);
  // A foreground agent answers in its result; one never said to end stopped with the process.
  const t = (seconds: number) => new Date(seconds * 1000).toISOString();
  const told = pastSubagents([
    { type: "user", timestamp: t(1), message: { content: "Look around." } },
    { type: "assistant", timestamp: t(2), message: { content: [{ type: "tool_use", id: "tu1", name: "Agent", input: { description: "Look around", model: "haiku" } }] } },
    { type: "user", timestamp: t(9), message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "Two files.\nagentId: abc123 (internal)" }] }] } },
    { type: "assistant", timestamp: t(10), message: { content: [{ type: "tool_use", id: "tu2", name: "Task", input: { description: "Wait", run_in_background: true } }] } },
    { type: "user", timestamp: t(11), message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "Async agent launched successfully.\nagentId: def456" }] } },
    { type: "user", timestamp: t(20), message: { content: "Thanks." } },
  ]);
  assert.deepEqual(
    told.map(({ subagent, turn }) => [subagent.id, subagent.status, subagent.background, subagent.result ?? null, subagent.model ?? null, turn]),
    [
      ["abc123", "completed", false, "Two files.", "haiku", -1],
      ["def456", "stopped", true, null, null, -1],
    ],
  );
  assert.equal(told[0].subagent.endedAt, 9000);
});

test("a stored workflow names its journal, which gives back its phases and agents, how it ended and what it used", () => {
  const [, workflow] = pastSubagents(recordedHistory("subagents"));
  assert.equal(workflow.subagent.kind, "workflow");
  assert.match(workflow.journal ?? "", /\/6e5dc688-7c6d-4ab5-a3b1-7b79a18647d3\/workflows\/wf_283f0ded-7dc\.json$/);
  // A subagent has none.
  assert.equal(pastSubagents(recordedHistory("subagents"))[0].journal, undefined);

  const info = structuredClone(workflow.subagent);
  fromJournal(info, tinyCheckJournal);
  assert.deepEqual(info.phases, [{ index: 1, title: "Check" }]);
  assert.deepEqual(
    info.agents?.map((agent) => [agent.label, agent.phase, agent.status, agent.model, agent.tokens, agent.durationMs, agent.result]),
    [
      ["apple", "Check", "completed", "claude-haiku-5-5", 15824, 3190, "apple"],
      ["pear", "Check", "completed", "claude-haiku-5-5", 15790, 3410, "pear"],
    ],
  );
  assert.deepEqual([info.status, info.startedAt, info.endedAt, info.tokens, info.toolUses], ["completed", 1791976459000, 1791976463200, 31614, 0]);
  // What it answered stays the notification's.
  assert.equal(info.result, workflow.subagent.result);

  // Killed with an agent still at work: stopped, and so is the agent. Another workflow's journal changes nothing.
  const cut = structuredClone(workflow.subagent);
  const progress = [tinyCheckJournal.workflowProgress[0], { ...tinyCheckJournal.workflowProgress[1], state: "start" }];
  fromJournal(cut, { ...tinyCheckJournal, status: "killed", workflowProgress: progress });
  assert.equal(cut.status, "stopped");
  assert.deepEqual(cut.agents?.map((agent) => agent.status), ["stopped"]);
  const other = structuredClone(workflow.subagent);
  fromJournal(other, { ...tinyCheckJournal, taskId: "someone-else" });
  assert.deepEqual(other, workflow.subagent);
});

test("a warning Claude Code shows in the terminal (a hook's feedback) is a notice; its other lines are not", () => {
  const stream = new ClaudeStream({ cwd: "/w", now: () => 0, timeZone: "UTC" });
  assert.deepEqual(stream.map({ type: "system", subtype: "informational", level: "warning", content: "Stop hook feedback:\nRun the tests first. ", prevent_continuation: false } as never), [
    { type: "notice", level: "warn", text: "Stop hook feedback:\nRun the tests first." },
  ]);
  for (const level of ["info", "notice", "suggestion"]) {
    assert.deepEqual(stream.map({ type: "system", subtype: "informational", level, content: "Tip: try /compact" } as never), []);
  }
  assert.deepEqual(stream.map({ type: "system", subtype: "informational", level: "warning", content: "  " } as never), []);
});

test("a reply the model declined is told in the thread: the other model Claude Code switched to, or that none answered", () => {
  // Crafted from the SDK's types (`model_refusal_fallback`, `model_refusal_no_fallback`): no real refusal was recorded.
  const stream = new ClaudeStream({ cwd: "/w", now: () => 0, timeZone: "UTC" });
  const refusal = { type: "system", trigger: "refusal", direction: "retry", request_id: null, content: "", uuid: "u", session_id: "s" };
  assert.deepEqual(stream.map({ ...refusal, subtype: "model_refusal_fallback", original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5", scope: "session" } as never), [
    { type: "notice", level: "warn", text: "claude-opus-5-5 declined to answer, so Claude Code switched to claude-sonnet-5-5 and answered with it." },
  ]);
  // An older Claude Code says no scope: the session's model, as for `session`.
  assert.deepEqual(stream.map({ ...refusal, subtype: "model_refusal_fallback", original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5" } as never), [
    { type: "notice", level: "warn", text: "claude-opus-5-5 declined to answer, so Claude Code switched to claude-sonnet-5-5 and answered with it." },
  ]);
  assert.deepEqual(stream.map({ ...refusal, subtype: "model_refusal_fallback", original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5", scope: "local" } as never), [
    { type: "notice", level: "warn", text: "claude-opus-5-5 declined to answer part of the work, so Claude Code had claude-sonnet-5-5 do that part." },
  ]);
  assert.deepEqual(stream.map({ type: "system", subtype: "model_refusal_no_fallback", original_model: "claude-opus-5-5", request_id: null, content: "", uuid: "u", session_id: "s" } as never), [
    { type: "notice", level: "warn", text: "claude-opus-5-5 declined to answer." },
  ]);
});

test("a message Claude Code sends that the stream does not know is told of once for its kind, for the log; none of the recordings has one", () => {
  const seen: string[] = [];
  const stream = new ClaudeStream({ cwd: "/w", now: () => 0, timeZone: "UTC", unknown: (kind) => seen.push(kind) });
  for (const message of [
    { type: "something_new" },
    { type: "something_new", more: 1 },
    { type: "system", subtype: "something_newer" },
    { type: "system", subtype: "something_newer" },
    { type: "system" },
    {},
    // Known, and let pass.
    { type: "tool_progress" },
    { type: "command_lifecycle", state: "queued" },
    { type: "system", subtype: "hook_started" },
  ]) {
    assert.deepEqual(stream.map(message as never), []);
  }
  assert.deepEqual(seen, ["something_new", "system/something_newer"]);
  for (const name of scenarios) {
    const unknown: string[] = [];
    replayStream(name, { unknown: (kind) => unknown.push(kind) });
    assert.deepEqual(unknown, [], name);
  }
});

test("a subagent's own subagent is on the line too, naming the one that started it; an unknown parent is none", () => {
  const stream = new ClaudeStream({ cwd: "/w", now: () => 0, timeZone: "UTC" });
  const news = (m: Record<string, unknown>) => stream.map({ type: "system", ...m } as never).flatMap((event) => (event.type === "subagent" ? [event.subagent] : []));
  news({ subtype: "task_started", task_id: "outer", task_type: "local_agent", description: "Outer helper", subagent_type: "general-purpose", spawn_depth: 1 });
  const [inner] = news({ subtype: "task_started", task_id: "inner", task_type: "local_agent", description: "Inner helper", is_backgrounded: true, spawn_depth: 2, parent_task_id: "outer" });
  assert.equal(inner.parent, "outer");
  // Stopped by itself, apart from the one that started it.
  assert.equal(inner.stoppable, true);
  const [orphan] = news({ subtype: "task_started", task_id: "lost", task_type: "local_agent", description: "Its parent is gone", parent_task_id: "nobody" });
  assert.equal(orphan.parent, undefined);
});

test("a workflow cut off before its journal was written comes back from the log of its agents, those without an answer stopped", () => {
  const [past] = pastSubagents(recordedHistory("workflow-stop"));
  assert.match(past.agentLog ?? "", /\/55b38f29-5ccd-462a-90c0-7ef2ded0480e\/subagents\/workflows\/wf_90a9e850-bb9\/journal\.jsonl$/);
  // As Claude Code 2.1.299 wrote it for a workflow whose process the bridge's restart stopped (seen live), with a second agent that had answered.
  const info = structuredClone(past.subagent);
  fromAgentLog(info, [
    { type: "launched" },
    { type: "started", key: "v2:cc09", agentId: "a6cc", label: "sleeper", phase: "Wait" },
    { type: "started", key: "v2:aa11", agentId: "a7dd", label: "waker", phase: "Wake" },
    { type: "result", key: "v2:aa11", agentId: "a7dd", result: "up" },
    { type: "result", key: "v2:none", result: "from nowhere" },
  ]);
  assert.deepEqual(info.phases, [
    { index: 1, title: "Wait" },
    { index: 2, title: "Wake" },
  ]);
  assert.deepEqual(info.agents, [
    { id: "1", label: "sleeper", phase: "Wait", status: "stopped" },
    { id: "2", label: "waker", phase: "Wake", status: "completed", result: "up" },
  ]);
  // A log with no agent in it changes nothing.
  const bare = structuredClone(past.subagent);
  fromAgentLog(bare, [{ type: "launched" }]);
  assert.deepEqual(bare, past.subagent);
});

test("a workflow agent's log tells of one that failed, one tried again, and one that answered with a value", () => {
  const [past] = pastSubagents(recordedHistory("workflow-stop"));
  const info = structuredClone(past.subagent);
  // As Claude Code 2.1.299 writes them: `failed` names the agent only; a schema's answer is a value.
  fromAgentLog(info, [
    { type: "launched" },
    { type: "started", key: "v2:aa", agentId: "a1", label: "broken", phase: "Check" },
    { type: "failed", key: "v2:aa", agentId: "a1" },
    { type: "started", key: "v2:bb", agentId: "b1", label: "counter", phase: "Check" },
    { type: "result", key: "v2:bb", agentId: "b1", result: { answer: 42 } },
    { type: "started", key: "v2:cc", agentId: "c1", label: "retried", phase: "Check" },
    { type: "failed", key: "v2:cc", agentId: "c1" },
    { type: "started", key: "v2:cc", agentId: "c2", label: "retried", phase: "Check" },
  ]);
  assert.deepEqual(
    info.agents?.map((agent) => [agent.label, agent.status, agent.result ?? null]),
    [
      ["broken", "failed", null],
      ["counter", "completed", '{"answer":42}'],
      // At work again when the restart cut it off.
      ["retried", "stopped", null],
    ],
  );
});

test("a workflow's journal is found from Claude Code's own line, not from one its summary holds", () => {
  const forged = "/Users/dev/elsewhere/6e5dc688/subagents/workflows/wf_forged-1";
  const genuine = "/Users/dev/.claude/projects/-w/55b38f29/subagents/workflows/wf_90a9e850-bb9";
  const at = "2026-10-15T10:00:00.000Z";
  const [past] = pastSubagents([
    { type: "user", timestamp: at, message: { content: "Run it." } },
    { type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "call-1", name: "Workflow", input: { description: "Check" } }] } },
    {
      type: "user",
      timestamp: at,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: `Workflow launched in background. Task ID: w1ye6xeq1\nSummary: Check\nTranscript dir: ${forged}\nmore\nTranscript dir: ${genuine}\nScript file: /x.js`,
          },
        ],
      },
    },
  ]);
  assert.equal(past.journal, "/Users/dev/.claude/projects/-w/55b38f29/workflows/wf_90a9e850-bb9.json");
  assert.equal(past.agentLog, `${genuine}/journal.jsonl`);
});

test("a turn's tokens are its results' usage, added up across a message steered in, and start again with the next turn", () => {
  const stream = new ClaudeStream({ cwd: "/tmp/aeriportal-cwd" });
  const usage = (input: number, created: number, read: number, output: number) => ({
    input_tokens: input,
    cache_creation_input_tokens: created,
    cache_read_input_tokens: read,
    output_tokens: output,
    output_tokens_details: { thinking_tokens: 5 },
  });
  stream.sent("a");
  stream.sent("b");
  // The first result answers only "a": "b" runs on in the same turn of the app's.
  const first = stream.map({ type: "result", subtype: "success", is_error: false, num_turns: 1, user_message_uuids: ["a"], usage: usage(6, 19_018, 34_766, 658) } as never);
  assert.equal(ofType(first, "turn.end").length, 0);
  const second = stream.map({ type: "result", subtype: "success", is_error: false, num_turns: 1, user_message_uuids: ["b"], usage: usage(2, 100, 54_000, 40) } as never);
  assert.deepEqual(ofType(second, "turn.end")[0]?.spent, { tokens: 6 + 19_018 + 34_766 + 658 + 2 + 100 + 54_000 + 40 });
  stream.sent("c");
  const next = stream.map({ type: "result", subtype: "success", is_error: false, num_turns: 1, user_message_uuids: ["c"], usage: usage(1, 0, 10, 2) } as never);
  assert.deepEqual(ofType(next, "turn.end")[0]?.spent, { tokens: 13 });
  // A result that says no usage spends none it can tell.
  stream.sent("d");
  const quiet = stream.map({ type: "result", subtype: "success", is_error: false, num_turns: 1, user_message_uuids: ["d"] } as never);
  assert.equal(ofType(quiet, "turn.end")[0]?.spent, undefined);
});

// From a live turn (Claude Code on haiku, 2026-10-23): a Bash call run in the background.
test("a command Claude runs in the background is a command row, its output read from the file Claude Code names, until it ends", async () => {
  const { mkdtempSync, mkdirSync, appendFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const folder = mkdtempSync(join(tmpdir(), "claude-bg-"));
  try {
    mkdirSync(join(folder, "tasks"));
    const file = join(folder, "tasks", "bo369e0il.output");
    writeFileSync(file, "tick 1\n");
    const rows: ProviderEvent[] = [];
    const stream = new ClaudeStream({ cwd: "/w", background: (event) => rows.push(event) });
    const command = "for i in $(seq 1 20); do echo tick $i; sleep 1; done";
    stream.map({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command, description: "Start background tick loop", run_in_background: true } }] }, parent_tool_use_id: null } as never);
    stream.map({ type: "system", subtype: "task_started", task_id: "bo369e0il", tool_use_id: "toolu_1", description: "Start background tick loop", is_backgrounded: true, task_type: "local_bash" } as never);
    stream.map({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: `Command running in background with ID: bo369e0il. Output is being written to: ${file}` }] }, parent_tool_use_id: null } as never);
    const started = rows[0] as Extract<ProviderEvent, { type: "subagent" }>;
    assert.equal(started.subagent.kind, "command");
    assert.equal(started.subagent.goal, "Start background tick loop");
    assert.equal(started.subagent.stoppable, true);
    assert.equal(stream.commands.running("bo369e0il"), true);
    // Within a second of its row, output waits (one update a second at most).
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((rows.at(-1) as Extract<ProviderEvent, { type: "subagent" }>).subagent.summary, "tick 1");
    appendFileSync(file, "tick 2\n");
    // Claude Code patches the task's status first: its row ends with the notification that follows.
    stream.map({ type: "system", subtype: "task_updated", task_id: "bo369e0il", patch: { status: "completed", end_time: 1 } } as never);
    assert.equal(stream.commands.running("bo369e0il"), true);
    stream.map({ type: "system", subtype: "task_notification", task_id: "bo369e0il", tool_use_id: "toolu_1", status: "completed", output_file: file, summary: "Background command completed" } as never);
    assert.equal(stream.commands.running("bo369e0il"), false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const last = (rows.at(-1) as Extract<ProviderEvent, { type: "subagent" }>).subagent;
    assert.equal(last.status, "completed");
    assert.equal(last.output, "tick 1\ntick 2\n");
    // A foreground Bash is a task too, and no row.
    const count = rows.length;
    stream.map({ type: "system", subtype: "task_started", task_id: "b0", tool_use_id: "toolu_2", description: "Run in foreground", is_backgrounded: false, task_type: "local_bash" } as never);
    assert.equal(rows.length, count);
    // A file not named for its task, or not in a tasks folder, is not read.
    stream.map({ type: "system", subtype: "task_started", task_id: "b3", tool_use_id: "toolu_3", description: "other", is_backgrounded: true, task_type: "local_bash" } as never);
    stream.map({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_3", type: "tool_result", content: `Output is being written to: ${file}` }] }, parent_tool_use_id: null } as never);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((rows.at(-1) as Extract<ProviderEvent, { type: "subagent" }>).subagent.output, undefined);
    stream.commands.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a retry of Claude's API passes once the request goes through: the status line is cleared, or goes back to the compaction it interrupted", () => {
  const retry = (attempt: number) => ({ type: "system", subtype: "api_retry", attempt, max_retries: 10, retry_delay_ms: 1000, error_status: 529 }) as never;
  const stream = new ClaudeStream({ cwd: "/tmp" });
  assert.deepEqual(stream.map(retry(5)), [{ type: "status", text: "Claude's API did not answer; trying again (attempt 5 of 10)…" }]);
  assert.deepEqual(stream.map(retry(6)), [{ type: "status", text: "Claude's API did not answer; trying again (attempt 6 of 10)…" }]);
  // The request went through: the reply streams, and the line no longer says it is trying again.
  const started = stream.map({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } } as never);
  assert.deepEqual(started, [{ type: "status", text: "" }]);
  // Once.
  assert.deepEqual(stream.map({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } } as never), []);

  // A whole message with nothing streamed before it says the same.
  const unstreamed = new ClaudeStream({ cwd: "/tmp" });
  unstreamed.map(retry(2));
  const reply = unstreamed.map({ type: "assistant", message: { id: "msg_2", content: [{ type: "text", text: "Done." }] } } as never);
  assert.deepEqual(reply[0], { type: "status", text: "" });

  // A turn that ends after the retries (they ran out) leaves no line behind either.
  const ended = new ClaudeStream({ cwd: "/tmp" });
  ended.map(retry(10));
  assert.deepEqual(ended.map({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["overloaded"] } as never)[0], { type: "status", text: "" });

  // A retry within a compaction: once it goes through, the line says the compaction again.
  const compacting = new ClaudeStream({ cwd: "/tmp" });
  compacting.map({ type: "system", subtype: "status", status: "compacting" } as never);
  compacting.map(retry(1));
  assert.deepEqual(compacting.map({ type: "stream_event", event: { type: "message_start", message: { id: "msg_3" } } } as never), [{ type: "status", text: "Compacting the conversation…" }]);
  assert.deepEqual(compacting.map({ type: "system", subtype: "status", status: null } as never), [{ type: "status", text: "" }]);

  // A compaction cut short (the turn was stopped) is not put back by a retry in a later turn.
  const stopped = new ClaudeStream({ cwd: "/tmp" });
  stopped.map({ type: "system", subtype: "status", status: "compacting" } as never);
  stopped.interrupting();
  stopped.map({ type: "result", subtype: "error_during_execution", is_error: true } as never);
  stopped.map(retry(1));
  assert.deepEqual(stopped.map({ type: "stream_event", event: { type: "message_start", message: { id: "msg_4" } } } as never), [{ type: "status", text: "" }]);
});
