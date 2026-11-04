import "./environment.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { cancelled, dialogAnswer, dialogCard, isDialog } from "../src/providers/pi/dialogs.ts";
import { appLevel, modelLevels, piLevel } from "../src/providers/pi/options.ts";
import type { PiModel, PiRecord, PiState, PiUiRequest } from "../src/providers/pi/protocol.ts";
import { piCatalog } from "../src/providers/pi/provider.ts";
import { PiStream } from "../src/providers/pi/stream.ts";
import { errorText, gatewayResult, gatewayTool, type ToolOutcome } from "../src/providers/pi/tools.ts";
import type { ProviderEvent } from "../src/providers/types.ts";
import { answers, fixture, fixtureCwd, joined, recordings, replay, turnsBegun } from "./pi-fixtures.ts";

// Golden tests: recorded runs of the real Pi (test/fixtures/pi, made with
// scripts/record-pi.ts) through the mapper, with no Pi running. Each
// `<name>.events.json` is what the mapper made of `<name>.jsonl` when it was last
// checked by hand; UPDATE_GOLDEN=1 rewrites them after a deliberate change.
//
// What Pi could not be made to do for a recording is tested below on records written
// by hand from Pi's docs/json.md; each such test says so.

for (const name of recordings) {
  test(`pi ${name}: the recording maps to its golden events`, () => {
    const events = joined(replay(name));
    const golden = new URL(`fixtures/pi/${name}.events.json`, import.meta.url);
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) {
      writeFileSync(golden, JSON.stringify(events, null, 1) + "\n");
    }
    assert.deepEqual(events, JSON.parse(readFileSync(golden, "utf8")));
  });
}

function ofType<T extends ProviderEvent["type"]>(events: ProviderEvent[], type: T): Extract<ProviderEvent, { type: T }>[] {
  return events.filter((event): event is Extract<ProviderEvent, { type: T }> => event.type === type);
}

function said(events: ProviderEvent[]): string {
  return ofType(events, "text").map((event) => event.text).join("");
}

function thought(events: ProviderEvent[]): string {
  return ofType(events, "reasoning").map((event) => event.text).join("");
}

function types(events: ProviderEvent[]): string[] {
  return events.map((event) => (event.type === "tool.start" || event.type === "tool.end" ? `${event.type}:${event.name}` : event.type));
}

/** A stream with a turn the session began and a run under way. */
function running(): PiStream {
  const stream = new PiStream({ cwd: "/w" });
  stream.beginTurn();
  assert.deepEqual(stream.map({ type: "agent_start" }), []);
  return stream;
}

function all(stream: PiStream, records: PiRecord[]): ProviderEvent[] {
  return records.flatMap((record) => stream.map(record));
}

const assistantStart: PiRecord = { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } };

function update(type: string, contentIndex: number, more: Record<string, unknown> = {}): PiRecord {
  return { type: "message_update", assistantMessageEvent: { type, contentIndex, ...more } };
}

function assistantEnd(content: unknown[], stopReason = "stop", errorMessage?: string): PiRecord {
  return { type: "message_end", message: { role: "assistant", content: content as never, stopReason, ...(errorMessage ? { errorMessage } : {}) } };
}

// MARK: Turns

test("every recorded turn ends with exactly one turn.end", () => {
  for (const name of recordings) {
    const events = replay(name);
    assert.equal(ofType(events, "turn.end").length, turnsBegun(name), name);
    // None of the recordings has a run Pi began by itself.
    assert.equal(ofType(events, "turn.begin").length, 0, name);
  }
  // The recordings cover a turn each way a turn can end.
  assert.equal(turnsBegun("plain"), 1);
  assert.equal(turnsBegun("dialog"), 7);
  assert.equal(turnsBegun("compact"), 5);
});

test("a plain reply streams, and the turn ends when Pi settles, not at its system or user messages", () => {
  const events = replay("plain");
  assert.equal(said(events), "A JSON line is one complete JSON value written on a single line. In JSON Lines files, each line is a separate record, usually followed by a newline.");
  assert.ok(ofType(events, "text").length > 20, "the reply streams piece by piece");
  // The system message Pi sends first and the user's own message say nothing.
  assert.deepEqual(types(events).filter((type) => type !== "text"), ["turn.end", "usage"]);
  // What it spent: the tokens of Pi's request, in, out and cached (feature turn_usage).
  assert.deepEqual(ofType(events, "turn.end")[0], { type: "turn.end", status: "complete", spent: { tokens: 1194 } });
  // The recorder asked for the stats after the turn; the ring is Pi's context use.
  assert.deepEqual(events.at(-1), { type: "usage", usage: { used: 1194, max: 272_000 } });
});

test("a turn's end comes at agent_settled: complete, interrupted when aborted, an error with the last message's reason", () => {
  // Written by hand: the three ends side by side.
  const complete = running();
  assert.deepEqual(all(complete, [assistantStart, assistantEnd([{ type: "text", text: "hi" }]), { type: "agent_end", willRetry: false }]), [{ type: "text", text: "hi" }]);
  assert.equal(complete.inTurn, true);
  assert.deepEqual(complete.map({ type: "agent_settled", aborted: false }), [{ type: "turn.end", status: "complete" }]);
  assert.equal(complete.inTurn, false);
  assert.equal(complete.inRun, false);
  // A second settle (or one with no turn open) ends nothing.
  assert.deepEqual(complete.map({ type: "agent_settled", aborted: false }), []);

  const stopped = running();
  stopped.map(assistantEnd([{ type: "text", text: "1" }], "aborted", "stream ended"));
  assert.deepEqual(stopped.map({ type: "agent_settled", aborted: true }), [{ type: "turn.end", status: "interrupted" }]);
  // An older Pi's settle says nothing of an abort; the last message does, either way Pi stores one.
  const older = running();
  older.map(assistantEnd([], "aborted"));
  assert.deepEqual(older.map({ type: "agent_settled" }), [{ type: "turn.end", status: "interrupted" }]);
  const olderCommand = running();
  olderCommand.map(assistantEnd([], "error", "This operation was aborted"));
  assert.deepEqual(olderCommand.map({ type: "agent_settled" }), [{ type: "turn.end", status: "interrupted" }]);

  const failed = running();
  failed.map(assistantEnd([], "error", "503 no capacity"));
  assert.deepEqual(failed.map({ type: "agent_settled", aborted: false }), [{ type: "turn.end", status: "error", error: "503 no capacity", retryable: true }]);
});

test("recorded: a refused turn ends with the provider's sentence, without its JSON", () => {
  assert.deepEqual(replay("error"), [
    { type: "turn.end", status: "error", error: "OpenAI API error (401): Incorrect API key provided: not-a-re**-key. You can find your API key at https://platform.openai.com/account/api-keys.", retryable: true },
  ]);
  assert.equal(errorText('Anthropic error: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), "Anthropic error: Overloaded");
  // As OpenAI refuses a model on a ChatGPT sign-in (seen live): the sentence is under `detail`, and the status is there twice.
  assert.equal(
    errorText(`OpenAI API error (400): 400 {"detail":"The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."}`),
    "OpenAI API error (400): The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
  );
  assert.equal(errorText('Some API error (500): 502 {"detail":"Bad gateway"}'), "Some API error (500): 502 Bad gateway");
  assert.equal(errorText('Error: {"detail":[{"loc":["body"],"msg":"field required"}]}'), 'Error: {"detail":[{"loc":["body"],"msg":"field required"}]}');
  assert.equal(errorText("  plain words {not json}  "), "plain words {not json}");
  assert.equal(errorText("x".repeat(400)).length, 300);
});

test("recorded: Stop while the reply streams, and Stop while a command runs, both end interrupted", () => {
  const streaming = replay("stop");
  assert.equal(said(streaming), "1\n2\n3\n");
  assert.deepEqual(streaming.at(-1), { type: "turn.end", status: "interrupted" });

  // The command gets its end from Pi ("Command aborted"), then Pi adds an empty message
  // with stopReason error; the settle says aborted, and that is what counts.
  const command = replay("stop-tool");
  assert.deepEqual(types(command), ["tool.start:terminal", "tool.end:terminal", "turn.end"]);
  assert.deepEqual(ofType(command, "tool.end")[0].result, { status: "error", error: "Stopped before it finished." });
  assert.deepEqual(command.at(-1), { type: "turn.end", status: "interrupted", spent: { tokens: 1183 } });
});

test("tools still open when the turn ends close as stopped, before the one turn.end", () => {
  // Written by hand: Pi gives a stopped tool its end (above); a process that dies does not.
  const stream = running();
  stream.map({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 100", timeout: null } });
  stream.map({ type: "tool_execution_start", toolCallId: "c2", toolName: "mcp__notes__search", args: { query: "x" } });
  const events = stream.finish("error", "Pi stopped unexpectedly.");
  assert.deepEqual(events, [
    { type: "tool.end", id: "c1", name: "terminal", args: { command: "sleep 100" }, result: { status: "error", error: "Stopped before it finished." } },
    { type: "tool.end", id: "c2", name: "search", args: { query: "x" }, context: "notes", result: { status: "error", error: "Stopped before it finished." } },
    { type: "turn.end", status: "error", error: "Pi stopped unexpectedly.", retryable: true },
  ]);
  // The turn is over: finishing again says nothing.
  assert.deepEqual(stream.finish("interrupted"), []);
  // The same at a settle.
  const settled = running();
  settled.map({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.txt" } });
  assert.deepEqual(types(settled.map({ type: "agent_settled", aborted: true })), ["tool.end:read_file", "turn.end"]);
});

test("recorded: a process killed mid-reply ends its turn once, and the next process starts clean", () => {
  const events = replay("killed");
  assert.deepEqual(joined(events), [
    { type: "text", text: "1", pieces: 1 },
    { type: "turn.end", status: "error", error: "Pi stopped unexpectedly.", retryable: true },
  ]);
});

test("a run that starts with no turn open is a turn of Pi's own, with no opening line", () => {
  // Written by hand: an extension sent Pi a message while the thread was at rest.
  const stream = new PiStream({ cwd: "/w" });
  assert.deepEqual(stream.map({ type: "agent_start" }), [{ type: "turn.begin", user: "", host: { kind: "hidden", text: "" } }]);
  assert.equal(stream.inTurn, true);
  const events = all(stream, [
    { type: "message_start", message: { role: "custom", customType: "subagent", content: "The background run finished.", display: true } },
    { type: "message_end", message: { role: "custom", customType: "subagent", content: "The background run finished.", display: true } },
    assistantStart,
    update("text_delta", 0, { delta: "It passed." }),
    assistantEnd([{ type: "text", text: "It passed." }]),
    { type: "agent_settled", aborted: false },
  ]);
  // The extension's message is for the model: during a run it is not the reply.
  assert.deepEqual(events, [{ type: "text", text: "It passed." }, { type: "turn.end", status: "complete" }]);

  // A turn the session began is not begun again by the run, and beginning one twice changes nothing.
  const own = new PiStream({ cwd: "/w" });
  own.beginTurn();
  own.beginTurn();
  assert.deepEqual(own.map({ type: "agent_start" }), []);
});

test("outside a turn nothing is said", () => {
  // Written by hand: records that arrive with no turn open (the stream missed its start).
  const stream = new PiStream({ cwd: "/w" });
  const events = all(stream, [
    assistantStart,
    update("text_delta", 0, { delta: "late" }),
    update("thinking_delta", 1, { delta: "late" }),
    assistantEnd([{ type: "text", text: "late" }], "toolUse"),
    { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
    { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "a" }] }, isError: false, durationMs: 1 },
    { type: "extension_ui_request", id: "n1", method: "notify", message: "hello", notifyType: "error" },
    { type: "extension_error", extensionPath: "/x/guard.ts", event: "tool_call", error: "boom" },
    { type: "agent_settled", aborted: false },
  ]);
  assert.deepEqual(events, []);
});

// MARK: Text and thinking

test("a text block with no delta is still said once", () => {
  // Written by hand: a provider that does not stream.
  const whole = running();
  assert.deepEqual(all(whole, [assistantStart, update("text_start", 0), update("text_end", 0, { content: "All at once." }), assistantEnd([{ type: "text", text: "All at once." }])]), [{ type: "text", text: "All at once." }]);
  // Not even a text_end: the finished message has it.
  const bare = running();
  assert.deepEqual(all(bare, [assistantStart, assistantEnd([{ type: "thinking", thinking: "Hm.\n\n" }, { type: "text", text: "Only here." }])]), [
    { type: "reasoning", text: "Hm." },
    { type: "text", text: "Only here." },
  ]);
  // A block that streamed in part gets its rest, and one that streamed whole nothing more.
  const part = running();
  const events = all(part, [assistantStart, update("text_delta", 0, { delta: "Half" }), update("text_end", 0, { content: "Half and half." }), assistantEnd([{ type: "text", text: "Half and half." }])]);
  assert.equal(said(events), "Half and half.");
  assert.equal(ofType(events, "text").length, 2);
});

test("recorded: thinking streams before the text, without the blank line OpenAI ends it with", () => {
  const events = replay("thinking");
  assert.equal(thought(events), "**Cross-checking the count**");
  assert.ok(events.findLastIndex((event) => event.type === "reasoning") < events.findIndex((event) => event.type === "text"));
  // The recording does end the block's deltas with a blank line.
  const deltas = fixture("thinking").flatMap((entry) => (entry.record?.assistantMessageEvent?.type === "thinking_delta" ? [entry.record.assistantMessageEvent.delta] : []));
  assert.equal(deltas.at(-1), "\n\n");
});

test("two thinking blocks are two paragraphs, and blank lines inside a block are kept", () => {
  // Written by hand: the recorded model thought once.
  const stream = running();
  const events = all(stream, [
    assistantStart,
    update("thinking_start", 0),
    update("thinking_delta", 0, { delta: "First part.\n\n" }),
    update("thinking_delta", 0, { delta: "Still the first.\n\n" }),
    update("thinking_end", 0, { content: "First part.\n\nStill the first." }),
    update("thinking_start", 1),
    update("thinking_delta", 1, { delta: "Second " }),
    update("thinking_delta", 1, { delta: "block." }),
    update("thinking_end", 1, { content: "Second block." }),
    update("text_delta", 2, { delta: "Done." }),
    assistantEnd([{ type: "thinking", thinking: "First part.\n\nStill the first." }, { type: "thinking", thinking: "Second block." }, { type: "text", text: "Done." }]),
  ]);
  assert.equal(thought(events), "First part.\n\nStill the first.\n\nSecond block.");
  assert.equal(said(events), "Done.");
});

test("text before a tool call is closed as commentary, so the reply does not run into it", () => {
  // Written by hand: the recorded model called its tools without a word.
  const stream = running();
  const events = all(stream, [
    assistantStart,
    update("thinking_delta", 0, { delta: "Look first." }),
    update("text_delta", 1, { delta: "I'll list " }),
    update("text_delta", 1, { delta: "the folder." }),
    update("toolcall_start", 2, { id: "c1", toolName: "bash" }),
    update("toolcall_delta", 2, { delta: '{"command":"ls"}' }),
    update("toolcall_end", 2),
    assistantEnd([{ type: "thinking", thinking: "Look first." }, { type: "text", text: "I'll list the folder." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls", timeout: null } }], "toolUse"),
    { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls", timeout: null } },
    { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "a.txt\n" }], structuredContent: { output: "a.txt\n", exit_code: 0 } }, isError: false, durationMs: 12 },
    assistantStart,
    update("thinking_delta", 0, { delta: "One file." }),
    update("text_delta", 1, { delta: "There is one file." }),
    assistantEnd([{ type: "thinking", thinking: "One file." }, { type: "text", text: "There is one file." }]),
    { type: "agent_settled", aborted: false },
  ]);
  assert.deepEqual(joined(events), [
    { type: "reasoning", text: "Look first.", pieces: 1 },
    { type: "text", text: "I'll list the folder.", pieces: 2 },
    { type: "commentary", text: "I'll list the folder.", alreadyStreamed: true },
    { type: "tool.start", id: "c1", name: "terminal", args: { command: "ls" } },
    { type: "tool.end", id: "c1", name: "terminal", args: { command: "ls" }, result: { output: "a.txt\n", exit_code: 0 }, durationSeconds: 0.012 },
    // After the tool the thinking starts afresh: no paragraph break carried over.
    { type: "reasoning", text: "One file.", pieces: 1 },
    { type: "text", text: "There is one file.", pieces: 1 },
    { type: "turn.end", status: "complete" },
  ]);
});

test("a message Pi takes into the run closes the text written before it", () => {
  // Recorded: a steer delivered after a command, and a follow-up after the reply.
  const recorded = replay("steer");
  assert.deepEqual(types(recorded), ["tool.start:terminal", "tool.end:terminal", "text", "commentary", "text", "text", "turn.end", "usage"]);
  assert.deepEqual(ofType(recorded, "commentary"), [{ type: "commentary", text: "done", alreadyStreamed: true }]);
  assert.equal(said(recorded.slice(recorded.findIndex((event) => event.type === "commentary"))), "cherry");
  assert.equal(ofType(recorded, "turn.end").length, 1);

  // Written by hand: one delivered while text streams with no tool running.
  const stream = running();
  const events = all(stream, [
    { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Count to three." }] } },
    assistantStart,
    update("text_delta", 0, { delta: "1\n2\n3\n" }),
    assistantEnd([{ type: "text", text: "1\n2\n3\n" }]),
    { type: "turn_end" },
    { type: "turn_start" },
    { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Now say banana." }] } },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Now say banana." }] } },
    assistantStart,
    update("text_delta", 0, { delta: "banana" }),
  ]);
  assert.deepEqual(events, [
    { type: "text", text: "1\n2\n3\n" },
    { type: "commentary", text: "1\n2\n3\n", alreadyStreamed: true },
    { type: "text", text: "banana" },
  ]);
});

test("a reply cut at the model's output limit says so", () => {
  // Written by hand.
  const stream = running();
  const events = all(stream, [assistantStart, update("text_delta", 0, { delta: "And then" }), assistantEnd([{ type: "text", text: "And then" }], "length")]);
  assert.deepEqual(events.at(-1), { type: "notice", level: "warn", text: "The reply was cut short: the model reached its output limit." });
});

test("an error Pi retries does not end the turn; the attempt's text is closed and the retry's is the reply", () => {
  // Written by hand from json.md: Pi retries only overload, rate-limit and 5xx failures.
  const stream = running();
  const events = all(stream, [
    assistantStart,
    update("text_delta", 0, { delta: "Let me" }),
    assistantEnd([{ type: "text", text: "Let me" }], "error", "529 overloaded"),
    { type: "agent_end", messages: [], willRetry: true },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" },
    { type: "agent_start" },
    assistantStart,
    update("text_delta", 0, { delta: "Here it is." }),
    assistantEnd([{ type: "text", text: "Here it is." }]),
    { type: "auto_retry_end", success: true, attempt: 2 },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled", aborted: false },
  ]);
  assert.deepEqual(events, [
    { type: "text", text: "Let me" },
    { type: "commentary", text: "Let me", alreadyStreamed: true },
    { type: "status", text: "Pi is trying again (1 of 3): 529 overloaded" },
    { type: "text", text: "Here it is." },
    { type: "status", text: "" },
    { type: "turn.end", status: "complete" },
  ]);

  // When every attempt fails, the last one's reason ends the turn.
  const failing = running();
  const end = all(failing, [
    assistantEnd([], "error", "529 overloaded"),
    { type: "auto_retry_start", attempt: 3, maxAttempts: 3, errorMessage: "529 overloaded" },
    assistantEnd([], "error", "529 overloaded"),
    { type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" },
    { type: "agent_settled", aborted: false },
  ]);
  assert.deepEqual(end.at(-1), { type: "turn.end", status: "error", error: "529 overloaded", retryable: true });
});

// MARK: Tools in a stream

test("recorded: five tools in a turn are five rows with their results and a diff", () => {
  const events = replay("tools");
  assert.deepEqual(types(events).slice(0, 10), [
    "tool.start:read_file",
    "tool.end:read_file",
    "tool.start:terminal",
    "tool.end:terminal",
    "tool.start:patch",
    "tool.end:patch",
    "tool.start:terminal",
    "tool.end:terminal",
    "tool.start:write_file",
    "tool.end:write_file",
  ]);
  const [read, wc, edit, ls, write] = ofType(events, "tool.end");
  // The nulls Pi sends for arguments the model left out are gone.
  assert.deepEqual(read.args, { path: "hello.txt" });
  assert.deepEqual(read.result, { content: "hi\n" });
  assert.equal(read.durationSeconds, 0.003);
  // Tool call ids hold a `|` and pass through as they are.
  assert.match(read.id, /^call_[A-Za-z0-9]+\|fc_[0-9a-f]+$/);
  assert.deepEqual(wc.result, { output: "       3 hello.txt\n", exit_code: 0 });
  // Pi's `{path, edits: [{oldText, newText}]}`, and its own patch with the usual header.
  assert.deepEqual(edit.args, { path: "hello.txt", old_string: "hi", new_string: "hello" });
  assert.deepEqual(edit.result, { success: true, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1,1 +1,1 @@\n-hi\n+hello\n" });
  // The failed command's code, and its output without Pi's "Command exited with code 1".
  assert.deepEqual(ls.result, { output: "ls: no-such-file.txt: No such file or directory\n", exit_code: 1 });
  assert.deepEqual(write.args, { path: "done.txt", content: "done" });
  assert.deepEqual(write.result, { diff: "--- a/done.txt\n+++ b/done.txt\n+done\n" });
  assert.equal(said(events), "Updated `hello.txt`, ran both commands, and wrote `done` to `done.txt`.");
});

test("recorded: two calls of one message run at once; the one an extension refused closes as blocked", () => {
  // The last turn of the recording: the extension asks about each command before it runs.
  const all = replay("dialog");
  const events = all.slice(all.findIndex((event) => event.type === "tool.start"));
  assert.deepEqual(types(events).filter((type) => type !== "text"), ["tool.start:terminal", "tool.start:terminal", "tool.end:terminal", "tool.end:terminal", "turn.end"]);
  assert.equal(said(events), "`echo first` ran; `echo second` was blocked by the user.");
  const [first, second] = ofType(events, "tool.start");
  const [refused, ran] = ofType(events, "tool.end");
  // The second call ended first: its row is matched by its id, not by its place.
  assert.equal(refused.id, second.id);
  assert.deepEqual(refused.args, { command: "echo second" });
  // It never ran: blocked with the extension's reason, not "exit code 1", and no duration.
  assert.deepEqual(refused.result, { status: "blocked", error: "Blocked by the user" });
  assert.equal(refused.durationSeconds, undefined);
  assert.equal(ran.id, first.id);
  assert.deepEqual(ran.result, { output: "first\n", exit_code: 0 });
});

test("recorded: the calls a codemode script makes are not rows of their own", () => {
  const events = replay("own");
  assert.deepEqual(types(events), ["tool.start:execute_code", "tool.end:execute_code", ...Array(ofType(events, "text").length).fill("text"), "turn.end", "usage"]);
  const [script] = ofType(events, "tool.end");
  assert.match(String(script.args.code), /^const results = await Promise\.all\(\[\n  tools\.read\(\{ path: "one\.txt"/);
  assert.deepEqual(script.result, { output: 'Script completed\nWall time 0.1 seconds\nOutput:\n[11,12]' });
  // The recording has the two nested reads, each with its parent's id.
  const nested = fixture("own").filter((entry) => entry.record?.type === "tool_execution_start" && entry.record.parentToolCallId);
  assert.equal(nested.length, 2);
  // His pi-subagents sets a widget as Pi starts and stops: nothing is made of it.
  assert.ok(fixture("own").some((entry) => entry.record?.method === "setWidget"));
});

test("a tool whose start was missed opens and closes at once", () => {
  // Written by hand.
  const stream = running();
  const events = stream.map({ type: "tool_execution_end", toolCallId: "c9", toolName: "ls", result: { content: [{ type: "text", text: "a\nb\n" }] }, isError: false, durationMs: 4 });
  assert.deepEqual(events, [
    { type: "tool.start", id: "c9", name: "search_files", args: {} },
    { type: "tool.end", id: "c9", name: "search_files", args: {}, result: { output: "a\nb\n" }, durationSeconds: 0.004 },
  ]);
});

// MARK: Compaction, the ring, titles

test("recorded: /compact is a status line and a manual mark; a refused one fails its turn with Pi's sentence and no notice", () => {
  const events = replay("compact");
  const at = events.findIndex((event) => event.type === "compacted");
  assert.deepEqual(events.slice(at - 2, at + 2), [
    { type: "status", text: "Compacting the conversation…" },
    { type: "status", text: "" },
    { type: "compacted", trigger: "manual", tokensBefore: 1230 },
    // Pi's estimate afterwards (1,482) is larger than what was there: the ring keeps its value.
    { type: "turn.end", status: "complete", usage: { used: 1230, max: 272_000 } },
  ]);
  assert.deepEqual(events.slice(at + 2, at + 5), [
    { type: "status", text: "Compacting the conversation…" },
    { type: "status", text: "" },
    { type: "turn.end", status: "error", error: "Already compacted", retryable: true, usage: { used: 1230, max: 272_000 } },
  ]);
  assert.equal(ofType(events, "notice").length, 0);
  // Right after the compaction Pi answers the stats with null, which changes nothing.
  assert.deepEqual(answers("compact", "get_session_stats")[1].contextUsage, { tokens: null, contextWindow: 272_000, percent: null });
  assert.deepEqual(ofType(events, "usage").map((event) => event.usage.used), [1230, 1335]);
});

test("recorded: a compaction Pi starts itself is an auto mark inside the turn, before the turn's end", () => {
  const events = replay("compact-auto");
  assert.deepEqual(types(events).slice(-4), ["status", "status", "compacted", "turn.end"]);
  assert.deepEqual(ofType(events, "compacted"), [{ type: "compacted", trigger: "auto", tokensBefore: 1199 }]);
});

test("a compaction of Pi's own that fails is a notice; an aborted one is not; the ring takes Pi's estimate when it is smaller", () => {
  // Written by hand from json.md: only manual and threshold compactions were recorded.
  const stream = running();
  assert.deepEqual(stream.map({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: "Compaction failed: the summary request was refused" }), [
    { type: "status", text: "" },
    { type: "notice", level: "warn", text: "Pi could not compact the conversation: the summary request was refused" },
  ]);
  assert.deepEqual(stream.map({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false }), [{ type: "status", text: "" }]);

  assert.deepEqual(stream.stats({ contextUsage: { tokens: 150_000, contextWindow: 200_000, percent: 75 } }), [{ type: "usage", usage: { used: 150_000, max: 200_000 } }]);
  const events = stream.map({ type: "compaction_end", reason: "overflow", result: { summary: "…", tokensBefore: 150_000, estimatedTokensAfter: 32_000 } as never, aborted: false, willRetry: true });
  assert.deepEqual(events, [
    { type: "status", text: "" },
    { type: "compacted", trigger: "auto", tokensBefore: 150_000 },
    { type: "usage", usage: { used: 32_000, max: 200_000 } },
  ]);
  assert.deepEqual(stream.usage, { used: 32_000, max: 200_000 });
  // The turn's end carries the last use known.
  assert.deepEqual(stream.map({ type: "agent_settled", aborted: false }), [{ type: "turn.end", status: "complete", usage: { used: 32_000, max: 200_000 } }]);
});

test("the ring: stats with tokens are a usage event, and null or nothing is none", () => {
  const stream = new PiStream({ cwd: "/w" });
  assert.deepEqual(stream.stats({ contextUsage: { tokens: 0, contextWindow: 272_000, percent: 0 } }), []);
  assert.deepEqual(stream.stats({ contextUsage: { tokens: null, contextWindow: 272_000, percent: null } }), []);
  assert.deepEqual(stream.stats(undefined), []);
  assert.deepEqual(stream.stats({}), []);
  assert.equal(stream.usage, undefined);
  assert.deepEqual(stream.stats({ contextUsage: { tokens: 1214, contextWindow: 272_000 } }), [{ type: "usage", usage: { used: 1214, max: 272_000 } }]);
  // Another model's window (the model was changed): the use known is said against it, also while Pi does not know the use.
  assert.deepEqual(stream.stats({ contextUsage: { tokens: null, contextWindow: 400_000, percent: null } }), [{ type: "usage", usage: { used: 1214, max: 400_000 } }]);
  assert.deepEqual(stream.stats({ contextUsage: { tokens: null, contextWindow: 400_000, percent: null } }), []);
});

test("recorded: a session's name is the title", () => {
  assert.deepEqual(ofType(replay("models"), "title"), [{ type: "title", title: "Recorded for the bridge" }]);
  // A name that was cleared is no title.
  assert.deepEqual(new PiStream({ cwd: "/w" }).map({ type: "session_info_changed" }), []);
});

// MARK: Extensions

test("recorded: what an extension's command says with notify is its turn's reply, and the turn ends at the prompt's answer", () => {
  const events = joined(replay("dialog")).slice(0, 12);
  assert.deepEqual(events, [
    { type: "text", text: "Confirmed", pieces: 1 },
    { type: "turn.end", status: "complete" },
    { type: "text", text: "Not confirmed", pieces: 1 },
    { type: "turn.end", status: "complete" },
    { type: "text", text: "Picked Banana", pieces: 1 },
    { type: "turn.end", status: "complete" },
    { type: "text", text: "Name: Ada", pieces: 1 },
    { type: "turn.end", status: "complete" },
    { type: "text", text: "Note has 3 lines", pieces: 1 },
    { type: "turn.end", status: "complete" },
    // A warning, but with no run under way it is all the command has to say.
    { type: "text", text: "No answer in time", pieces: 1 },
    { type: "turn.end", status: "complete" },
  ]);
});

test("notify and an extension's own message: the reply in a turn with no run, a notice during a run when it warns", () => {
  // Written by hand.
  const notify = (message: string, notifyType?: string): PiRecord => ({ type: "extension_ui_request", id: "n", method: "notify", message, ...(notifyType ? { notifyType } : {}) });
  const custom = (content: unknown, display: boolean): PiRecord => ({ type: "message_end", message: { role: "custom", customType: "search", content: content as never, display } });

  const command = new PiStream({ cwd: "/w" });
  command.beginTurn();
  const lines = all(command, [notify("Searching…"), notify("3 results", "info"), custom([{ type: "text", text: "1. a\n2. b\n3. c" }], true), custom("for the model only", false)]);
  assert.equal(said(lines), "Searching…\n3 results\n1. a\n2. b\n3. c");
  assert.deepEqual(command.finish("complete"), [{ type: "turn.end", status: "complete" }]);

  const run = running();
  assert.deepEqual(all(run, [notify("working", "info"), notify("careful", "warning"), notify("broken", "error"), custom("context for the model", true)]), [
    { type: "notice", level: "warn", text: "careful" },
    { type: "notice", level: "error", text: "broken" },
  ]);
  // The other things an extension shows wait for nothing and say nothing.
  for (const method of ["setStatus", "setWidget", "setTitle", "set_editor_text", "confirm", "select"]) {
    assert.deepEqual(run.map({ type: "extension_ui_request", id: "x", method, title: "t" }), [], method);
  }
});

test("an extension that throws is a notice naming its file, not its path", () => {
  // Written by hand from json.md.
  const stream = running();
  assert.deepEqual(stream.map({ type: "extension_error", extensionPath: "/somewhere/deep/permission-gate.ts", event: "tool_call", error: "ctx.ui is not a function" }), [
    { type: "notice", level: "warn", text: "A Pi extension failed (permission-gate.ts): ctx.ui is not a function" },
  ]);
});

test("an unknown record type and a record missing fields give no event and no throw", () => {
  const seen: string[] = [];
  const stream = new PiStream({ cwd: "/w", unknown: (type) => seen.push(type) });
  stream.beginTurn();
  stream.map({ type: "agent_start" });
  const odd: unknown[] = [
    { type: "something_new", payload: 1 },
    { type: "something_new" },
    { type: "another_new_one" },
    {},
    { type: 42 },
    { type: "message_start" },
    { type: "message_update" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta" } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: "x" } },
    { type: "message_end" },
    { type: "message_end", message: { role: "assistant" } },
    { type: "message_end", message: { role: "assistant", content: "not blocks" } },
    { type: "message_end", message: { role: "assistant", content: [null, 3, { type: "text" }, { type: "thinking" }] } },
    { type: "tool_execution_start" },
    { type: "tool_execution_start", toolCallId: "c1" },
    { type: "tool_execution_end" },
    { type: "tool_execution_end", toolCallId: "never-started" },
    { type: "compaction_end" },
    { type: "auto_retry_start" },
    { type: "extension_ui_request" },
    { type: "extension_ui_request", method: "notify" },
    { type: "extension_error" },
    // The records that are known and make nothing.
    { type: "turn_start" },
    { type: "turn_end" },
    { type: "agent_end" },
    { type: "queue_update", steering: [], followUp: [] },
    { type: "entry_appended", entry: {} },
    { type: "thinking_level_changed", level: "high" },
    { type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [] } },
    { type: "bash_execution_update", delta: "x" },
    { type: "summarization_retry_scheduled" },
    { type: "response", command: "get_state", success: true },
  ];
  const events = odd.flatMap((record) => stream.map(record as PiRecord));
  assert.deepEqual(events, [
    { type: "status", text: "" },
    { type: "status", text: "Pi is trying again" },
    { type: "notice", level: "warn", text: "A Pi extension failed: it gave no reason" },
  ]);
  // Each unknown kind is named once, for the log.
  assert.deepEqual(seen, ["something_new", "another_new_one"]);
  assert.equal(stream.inTurn, true);
});

// MARK: The tools table

function outcome(text: string, more: Partial<ToolOutcome> = {}): ToolOutcome {
  return { content: [{ type: "text", text }], isError: false, ran: true, ...more };
}

test("bash: output and exit code, from the result's field live and from Pi's text in history", () => {
  assert.deepEqual(gatewayTool("bash", { command: "ls -la", timeout: null }), { name: "terminal", args: { command: "ls -la" } });
  assert.deepEqual(gatewayTool("powershell", { command: "dir", timeout: 5 }), { name: "terminal", args: { command: "dir" } });
  const input = { command: "make" };
  assert.deepEqual(gatewayResult("bash", input, outcome("built\n"), "/w"), { output: "built\n", exit_code: 0 });
  // A command that printed nothing.
  assert.deepEqual(gatewayResult("bash", input, outcome("(no output)"), "/w"), { output: "", exit_code: 0 });
  // Live: the code is a field. The text agrees, and its last line is taken off the output.
  const failedText = "make: *** No rule\n\n\nCommand exited with code 2";
  assert.deepEqual(gatewayResult("bash", input, outcome(failedText, { isError: true, structured: { output: "make: *** No rule\n", exit_code: 2 } }), "/w"), { output: "make: *** No rule\n", exit_code: 2 });
  // History: only the text.
  assert.deepEqual(gatewayResult("bash", input, outcome(failedText, { isError: true }), "/w"), { output: "make: *** No rule\n", exit_code: 2 });
  assert.deepEqual(gatewayResult("bash", input, outcome("Command exited with code 127", { isError: true }), "/w"), { output: "", exit_code: 127 });
  // Failed some other way: Pi's sentence is the output, and the code is 1.
  assert.deepEqual(gatewayResult("bash", input, outcome("partial\n\nCommand timed out after 40 seconds", { isError: true }), "/w"), { output: "partial\n\nCommand timed out after 40 seconds", exit_code: 1 });
});

test("a command Stop ended is stopped, with what it had printed; a call that never ran is blocked, not exit code 1", () => {
  const input = { command: "npm test" };
  assert.deepEqual(gatewayResult("bash", input, outcome("Command aborted", { isError: true }), "/w"), { status: "error", error: "Stopped before it finished." });
  assert.deepEqual(gatewayResult("bash", input, outcome("3 passing\n\nCommand aborted", { isError: true }), "/w"), { status: "error", error: "Stopped before it finished.", output: "3 passing" });
  // Pi's other tools say "Operation aborted", ran or not.
  assert.deepEqual(gatewayResult("read", { path: "a" }, outcome("Operation aborted", { isError: true }), "/w"), { status: "error", error: "Stopped before it finished." });
  assert.deepEqual(gatewayResult("bash", input, outcome("Operation aborted", { isError: true, ran: false }), "/w"), { status: "error", error: "Stopped before it finished." });
  // No durationMs: an extension refused it, or its arguments were wrong.
  assert.deepEqual(gatewayResult("bash", input, outcome("Blocked by the user", { isError: true, ran: false }), "/w"), { status: "blocked", error: "Blocked by the user" });
  assert.deepEqual(gatewayResult("edit", { path: "a" }, outcome("Validation failed for tool \"edit\"", { isError: true, ran: false }), "/w"), { status: "blocked", error: 'Validation failed for tool "edit"' });
  assert.deepEqual(gatewayResult("nope", {}, { content: [], isError: true, ran: false }, "/w"), { status: "blocked", error: "It did not run." });
});

test("read, write and edit: a file's content, an all-added diff, and Pi's patch or one built from the replacements", () => {
  assert.deepEqual(gatewayTool("read", { path: "src/a.ts", offset: 10, limit: null }), { name: "read_file", args: { path: "src/a.ts", offset: 10 } });
  assert.deepEqual(gatewayResult("read", { path: "a" }, outcome("one\ntwo\n"), "/w"), { content: "one\ntwo\n" });
  assert.deepEqual(gatewayResult("read", { path: "a.png" }, { content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: false, ran: true }, "/w"), {
    content: "Read image file [image/png]\n[image]",
  });
  assert.deepEqual(gatewayResult("read", { path: "gone" }, outcome("ENOENT: no such file", { isError: true }), "/w"), { error: "ENOENT: no such file" });

  assert.deepEqual(gatewayTool("write", { path: "/w/notes/b.txt", content: "one\ntwo\n" }), { name: "write_file", args: { path: "/w/notes/b.txt", content: "one\ntwo\n" } });
  assert.deepEqual(gatewayResult("write", { path: "/w/notes/b.txt", content: "one\ntwo\n" }, outcome("Successfully wrote to /w/notes/b.txt"), "/w"), { diff: "--- a/notes/b.txt\n+++ b/notes/b.txt\n+one\n+two\n" });
  assert.deepEqual(gatewayResult("write", { path: "/etc/x", content: "y" }, outcome("EACCES: permission denied", { isError: true }), "/w"), { error: "EACCES: permission denied" });

  // One replacement: the row has the old and the new text. Several: only the path.
  const one = { path: "/w/a.txt", edits: [{ oldText: "hi", newText: "hello" }] };
  const several = { path: "a.txt", edits: [{ oldText: "hi", newText: "hello" }, { oldText: "bye\n", newText: "" }] };
  assert.deepEqual(gatewayTool("edit", one), { name: "patch", args: { path: "/w/a.txt", old_string: "hi", new_string: "hello" } });
  assert.deepEqual(gatewayTool("edit", several), { name: "patch", args: { path: "a.txt" } });
  // Pi's own patch, its header lines made the usual ones (the path inside the folder is relative).
  const details = { diff: "-1 hi\n+1 hello", patch: "--- /w/a.txt\n+++ /w/a.txt\n@@ -1,1 +1,1 @@\n-hi\n+hello\n", firstChangedLine: 1 };
  assert.deepEqual(gatewayResult("edit", one, outcome("Successfully replaced 1 block(s) in /w/a.txt.", { details }), "/w"), { success: true, diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-hi\n+hello\n" });
  // Without one (another release of Pi), a diff from the replacements, without line numbers.
  assert.deepEqual(gatewayResult("edit", several, outcome("Successfully replaced 2 block(s) in a.txt."), "/w"), { success: true, diff: "--- a/a.txt\n+++ b/a.txt\n-hi\n+hello\n-bye\n" });
  assert.deepEqual(gatewayResult("edit", one, outcome("Could not find the exact text in /w/a.txt.", { isError: true }), "/w"), { success: false, error: "Could not find the exact text in /w/a.txt." });
});

test("the rest of the table: searches, a script, the web, a subagent, an MCP tool and any other", () => {
  // The row's label is the pattern, so the folder searched goes by another name.
  assert.deepEqual(gatewayTool("grep", { pattern: "TODO", path: "src", glob: "*.ts", ignoreCase: null, literal: null, context: null, limit: null }), { name: "search_files", args: { pattern: "TODO", glob: "*.ts", in: "src" } });
  assert.deepEqual(gatewayTool("find", { pattern: "*.md", path: null, limit: null }), { name: "search_files", args: { pattern: "*.md" } });
  assert.deepEqual(gatewayTool("ls", { path: "docs", limit: null }), { name: "search_files", args: { path: "docs" } });
  assert.deepEqual(gatewayResult("grep", { pattern: "TODO" }, outcome("a.ts:3: // TODO"), "/w"), { output: "a.ts:3: // TODO" });

  assert.deepEqual(gatewayTool("codemode", { code: "return 1;" }), { name: "execute_code", args: { code: "return 1;" } });
  // Blocks that end their own line are not given another.
  assert.deepEqual(gatewayResult("codemode", { code: "return 1;" }, { content: [{ type: "text", text: "Script completed\nOutput:\n" }, { type: "text", text: "1" }], isError: false, ran: true }, "/w"), { output: "Script completed\nOutput:\n1" });

  // His pi-web-access takes one query or several, one address or several.
  assert.deepEqual(gatewayTool("web_search", { query: "node 24 release", numResults: 5 }), { name: "web_search", args: { query: "node 24 release" } });
  assert.deepEqual(gatewayTool("web_search", { queries: ["a", "b"] }), { name: "web_search", args: { query: "a, b" } });
  assert.deepEqual(gatewayTool("fetch_content", { url: "https://example.com", mode: "readable" }), { name: "web_extract", args: { url: "https://example.com" } });
  assert.deepEqual(gatewayTool("fetch_content", {}), { name: "web_extract", args: {} });

  // His pi-subagents: the task and the agent when it names them, else what it was given.
  assert.deepEqual(gatewayTool("subagent", { agent: "reviewer", task: "Review the diff", cwd: null }), { name: "delegate_task", args: { task: "Review the diff", agent: "reviewer" } });
  assert.deepEqual(gatewayTool("subagent", { action: "list", id: null }), { name: "delegate_task", args: { action: "list" } });

  // An MCP server's tool goes by its own name, with the server as its context.
  assert.deepEqual(gatewayTool("mcp__linear__list_issues", { team: "ENG", cursor: null }), { name: "list_issues", args: { team: "ENG" }, context: "linear" });
  assert.deepEqual(gatewayResult("mcp__linear__list_issues", {}, outcome("ENG-1, ENG-2"), "/w"), { output: "ENG-1, ENG-2" });
  assert.deepEqual(gatewayResult("mcp__linear__list_issues", {}, outcome("401 Unauthorized", { isError: true }), "/w"), { error: "401 Unauthorized" });
  // Anything else keeps its name.
  assert.deepEqual(gatewayTool("bg_wait", { seconds: 5 }), { name: "bg_wait", args: { seconds: 5 } });
  assert.deepEqual(gatewayResult("bg_wait", {}, { content: [], isError: true, ran: true }, "/w"), { error: "The tool failed." });
});

// MARK: Dialogs

/** The dialogs the recording's extension opened, by method, in order. */
function recordedDialogs(method: string): PiUiRequest[] {
  return fixture("dialog").flatMap((entry) => (entry.kind === "receive" && entry.record.type === "extension_ui_request" && entry.record.method === method ? [entry.record as PiUiRequest] : []));
}

function answered(id: string, value: string | null) {
  return { kind: "clarify" as const, answers: { [id]: value } };
}

test("recorded: each dialog is a card of one question, and each answer is the record Pi was sent", () => {
  const [confirm] = recordedDialogs("confirm");
  assert.deepEqual(dialogCard(confirm), { kind: "clarify", questions: [{ qid: confirm.id, question: "Send the report?\n\nIt goes to everyone on the list.", choices: ["Yes", "No"], multiSelect: false }] });
  const [select] = recordedDialogs("select");
  assert.deepEqual(dialogCard(select), { kind: "clarify", questions: [{ qid: select.id, question: "Which fruit?", choices: ["Apple", "Banana", "Cherry"], multiSelect: false }] });
  const [input] = recordedDialogs("input");
  // No choices: an answer is typed.
  assert.deepEqual(dialogCard(input), { kind: "clarify", questions: [{ qid: input.id, question: "Your name", choices: [], multiSelect: false }] });
  const [editor] = recordedDialogs("editor");
  assert.deepEqual(dialogCard(editor), { kind: "clarify", questions: [{ qid: editor.id, question: "Edit the note\n\nLine 1\nLine 2", choices: [], multiSelect: false }] });

  // What the recorder answered, as the bridge would write it.
  const sent = fixture("dialog").flatMap((entry) => (entry.kind === "send" && entry.record.type === "extension_ui_response" ? [entry.record] : []));
  assert.deepEqual(dialogAnswer(confirm, answered(confirm.id!, "Yes")), sent[0]);
  const again = recordedDialogs("confirm")[1];
  assert.deepEqual(dialogAnswer(again, { kind: "clarify", answers: null }), sent[1]);
  assert.deepEqual(dialogAnswer(select, answered(select.id!, "Banana")), sent[2]);
  assert.deepEqual(dialogAnswer(input, answered(input.id!, "Ada")), sent[3]);
  assert.deepEqual(dialogAnswer(editor, answered(editor.id!, "Line 1\nLine 2\nLine 3")), sent[4]);
  // The dialog that timed out carries its time, in milliseconds, for the session's timer.
  assert.equal(recordedDialogs("confirm")[2].timeout, 1000);
});

test("a dialog's answers: No and anything typed are not a yes; a typed answer to a select, a dismissal and a withdrawal cancel", () => {
  const confirm: PiUiRequest = { type: "extension_ui_request", id: "d1", method: "confirm", title: "Run this command?", message: "rm -rf build" };
  assert.deepEqual(dialogAnswer(confirm, answered("d1", "Yes")), { type: "extension_ui_response", id: "d1", confirmed: true });
  assert.deepEqual(dialogAnswer(confirm, answered("d1", "No")), { type: "extension_ui_response", id: "d1", confirmed: false });
  assert.deepEqual(dialogAnswer(confirm, answered("d1", "only the build folder")), { type: "extension_ui_response", id: "d1", confirmed: false });

  const select: PiUiRequest = { type: "extension_ui_request", id: "d2", method: "select", title: "Allow?", options: ["Allow", "Block"] };
  assert.deepEqual(dialogAnswer(select, answered("d2", "Allow")), { type: "extension_ui_response", id: "d2", value: "Allow" });
  // Something typed under Other is not one of Pi's options.
  assert.deepEqual(dialogAnswer(select, answered("d2", "maybe")), cancelled("d2"));
  // Dismissed on the phone, withdrawn by Stop, closed by the turn's end, or answered for another question.
  for (const answer of [answered("d2", null), { kind: "clarify" as const, answers: null }, { kind: "withdrawn" as const, reason: "interrupted" }, answered("other", "Allow"), { kind: "approval" as const, choice: "once" as const }]) {
    assert.deepEqual(dialogAnswer(select, answer), { type: "extension_ui_response", id: "d2", cancelled: true });
    assert.deepEqual(dialogAnswer(confirm, answer), { type: "extension_ui_response", id: "d1", cancelled: true });
  }
  // An empty line is an answer to an input.
  assert.deepEqual(dialogAnswer({ type: "extension_ui_request", id: "d3", method: "input", title: "Tag" }, answered("d3", "")), { type: "extension_ui_response", id: "d3", value: "" });
});

test("what an extension only shows is no dialog, and a dialog with nothing to say still asks", () => {
  for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "something_new"]) {
    const request: PiUiRequest = { type: "extension_ui_request", id: "x", method };
    assert.equal(isDialog(request), false, method);
    assert.equal(dialogCard(request), null, method);
  }
  // No id: nothing could be answered.
  assert.equal(isDialog({ type: "extension_ui_request", method: "confirm" }), false);
  const question = (request: Omit<PiUiRequest, "type">) => {
    const card = dialogCard({ type: "extension_ui_request", ...request });
    return card?.kind === "clarify" ? card.questions[0] : null;
  };
  assert.equal(question({ id: "a", method: "confirm" })?.question, "Go ahead?");
  assert.equal(question({ id: "a", method: "select", options: ["x", 3 as never, ""] })?.question, "Choose one");
  assert.deepEqual(question({ id: "a", method: "select", options: ["x", 3 as never, ""] })?.choices, ["x"]);
  assert.equal(question({ id: "a", method: "input" })?.question, "Pi asks for a line of text");
  assert.equal(question({ id: "a", method: "editor" })?.question, "Pi asks for some text");
});

// MARK: Levels

test("level names both ways: the app's none is Pi's off, ultra is the strongest a model has, and a missing level becomes the nearest", () => {
  assert.equal(appLevel("off"), "none");
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) assert.equal(appLevel(level), level);
  assert.equal(appLevel("turbo"), "");
  assert.equal(appLevel(undefined), "");

  const [state] = answers("models", "get_state");
  const luna = modelLevels(state.model);
  assert.equal(piLevel("none", luna), "off");
  assert.equal(piLevel("high", luna), "high");
  assert.equal(piLevel("ultra", luna), "max");
  // gpt-6-luna has no `minimal`. Recorded: asked for it, Pi itself went to `low`.
  assert.equal(piLevel("minimal", luna), "low");
  const clamped = fixture("models").filter((entry) => entry.record?.type === "thinking_level_changed").map((entry) => entry.record.level);
  assert.deepEqual(clamped.slice(0, 3), ["high", "max", "low"]);
  // No level chosen, or a word that is none.
  assert.equal(piLevel("", luna), null);
  assert.equal(piLevel("turbo", luna), null);
  // A model that does not think takes only off, whatever is asked.
  assert.equal(piLevel("high", ["none"]), "off");
});

test("a model's levels by its thinkingLevelMap, as the recorded Pi answered for its own model", () => {
  // The model the recording ran on, and what Pi said its levels are.
  const [state] = answers("models", "get_state");
  assert.equal(state.model.id, "gpt-6-luna");
  const [luna, nano] = answers("models", "get_available_thinking_levels");
  assert.deepEqual(luna.levels, ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(modelLevels(state.model), ["none", "low", "medium", "high", "xhigh", "max"]);
  // After the recorder moved to a model that does not think.
  const [moved] = answers("models", "set_model");
  assert.equal(moved.id, "gpt-4.1-nano");
  assert.deepEqual(nano.levels, ["off"]);
  assert.deepEqual(modelLevels(moved), ["none"]);

  // Each kind of map. None at all: off to high.
  assert.deepEqual(modelLevels({ reasoning: true }), ["none", "minimal", "low", "medium", "high"]);
  // Only the two strongest named (the Anthropic models here): they are added.
  assert.deepEqual(modelLevels({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } }), ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  // A level set to null is one the model does not have, the strongest included.
  assert.deepEqual(modelLevels({ reasoning: true, thinkingLevelMap: { off: null, minimal: null, xhigh: "high", max: null } }), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(modelLevels({ reasoning: false, thinkingLevelMap: { high: "high" } }), ["none"]);
  assert.deepEqual(modelLevels({}), ["none"]);

  // Every recorded model gets a list, each level one the app knows.
  const [catalog] = answers("models", "get_available_models");
  assert.equal(catalog.models.length, 44);
  for (const model of catalog.models) {
    const levels = modelLevels(model);
    assert.ok(levels.length >= 1, model.id);
    assert.equal(levels.includes("none") || model.thinkingLevelMap?.off === null, true, model.id);
    if (!model.reasoning) assert.deepEqual(levels, ["none"], model.id);
  }
});

test("the catalog's default level is one its default model takes: Pi's own model, the one pi.model names, or the first listed when Pi names none", () => {
  const thinks = { id: "deep", provider: "a", reasoning: true } as PiModel;
  const plain = { id: "plain", provider: "a", reasoning: false } as PiModel;
  const said = (state: PiState, models: PiModel[], preferred?: string) => {
    const catalog = piCatalog(state, models, preferred);
    return [catalog.model, catalog.provider, catalog.reasoning];
  };
  // Pi's own model, on Pi's own level.
  assert.deepEqual(said({ thinkingLevel: "medium", model: thinks }, [plain, thinks]), ["deep", "a", "medium"]);
  // The model pi.model names does not think.
  assert.deepEqual(said({ thinkingLevel: "medium", model: thinks }, [plain, thinks], "a/plain"), ["plain", "a", "none"]);
  // Pi names no model of its own: the first listed is the default, and the level is what that one takes.
  assert.deepEqual(said({ thinkingLevel: "medium" }, [plain, thinks]), ["plain", "a", "none"]);
  assert.deepEqual(said({ thinkingLevel: "medium" }, [thinks, plain]), ["deep", "a", "medium"]);
  // One that pi.model names and Pi does not list is passed over.
  assert.deepEqual(said({ thinkingLevel: "medium", model: thinks }, [plain, thinks], "b/none"), ["deep", "a", "medium"]);
  // No model at all: there is none to take a level.
  assert.deepEqual(said({ thinkingLevel: "medium" }, []), ["", "", "medium"]);
});

// From a live run (Pi, 2026-10-23): `tool_execution_update` gives a command's whole output so far.
test("a running command's output so far is its row's live output, and ends with its result", () => {
  const progress: ProviderEvent[] = [];
  const stream = new PiStream({ cwd: "/w", progress: (event) => progress.push(event) });
  stream.beginTurn();
  stream.map({ type: "agent_start" });
  const id = "call_1|fc_1";
  const args = { command: "for i in 1 2 3; do echo line $i; sleep 1; done", timeout: 30 };
  stream.map({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args } as PiRecord);
  const partial = (output: string) => ({ type: "tool_execution_update", toolCallId: id, toolName: "bash", args, partialResult: { content: [{ type: "text", text: output }], details: {} } }) as PiRecord;
  assert.deepEqual(stream.map(partial("line 1\n")), []);
  assert.deepEqual(progress, [{ type: "tool.progress", id, output: "line 1\n", outputTruncated: false }]);
  // The same again sends nothing; a read's partial result is no command's output.
  stream.map(partial("line 1\n"));
  stream.map({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "a.txt" } } as PiRecord);
  stream.map({ type: "tool_execution_update", toolCallId: "read-1", toolName: "read", partialResult: { content: [{ type: "text", text: "file" }] } } as PiRecord);
  assert.equal(progress.length, 1);
  const end = stream.map({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: "line 1\nline 2\nline 3\n" }] } } as PiRecord);
  assert.equal(ofType(end, "tool.end").length, 1);
  stream.map(partial("line 1\nline 2\nline 3\nlate\n"));
  assert.equal(progress.length, 1, "an ended call's output is not shown again");
});

test("a command the turn ended under keeps the output it showed live, with that it was stopped", () => {
  const stream = new PiStream({ cwd: "/w", progress: () => {} });
  stream.beginTurn();
  stream.map({ type: "agent_start" });
  const id = "call_1|fc_1";
  const args = { command: "npm run build", timeout: 300 };
  stream.map({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args } as PiRecord);
  stream.map({ type: "tool_execution_update", toolCallId: id, toolName: "bash", args, partialResult: { content: [{ type: "text", text: "compiling 1 of 40\n" }], details: {} } } as PiRecord);
  const [stopped] = ofType(stream.finish("interrupted"), "tool.end");
  assert.deepEqual(stopped.result, { status: "error", error: "Stopped before it finished.", output: "compiling 1 of 40\n" });
});

test("a command Stop ended, whose end says only that it was aborted, keeps the output it showed live", () => {
  for (const said of ["Command aborted", "Operation aborted"]) {
    const stream = new PiStream({ cwd: "/w", progress: () => {} });
    stream.beginTurn();
    stream.map({ type: "agent_start" });
    const id = "call_1|fc_1";
    const args = { command: "npm run build", timeout: 300 };
    stream.map({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args } as PiRecord);
    stream.map({ type: "tool_execution_update", toolCallId: id, toolName: "bash", args, partialResult: { content: [{ type: "text", text: "compiling 1 of 40\n" }], details: {} } } as PiRecord);
    const [stopped] = ofType(stream.map({ type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: true, durationMs: 1200, result: { content: [{ type: "text", text: said }], details: {} } } as PiRecord), "tool.end");
    assert.deepEqual(stopped.result, { status: "error", error: "Stopped before it finished.", output: "compiling 1 of 40\n" }, said);
  }
});
