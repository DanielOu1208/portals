import "./environment.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentFolder, findSessionFile, historyFromSession, movedSessions, readHistory, sessionFolderName } from "../src/providers/pi/history.ts";
import type { StoredMessage } from "../src/providers/types.ts";
import { fixture, fixtureCwd, liveTranscript, recordedHistory, recordings, sessionText, timeless } from "./pi-fixtures.ts";

// A cold thread's history, from the session files Pi left behind for the recordings
// (`<name>.session.jsonl`), read with no Pi running. Each `<name>.history.json` is what
// was read when it was last checked by hand; UPDATE_GOLDEN=1 rewrites them.

/** The recordings that have a session file: `models` sent no message, so Pi wrote none. */
const withSession = recordings.filter((name) => name !== "models");

for (const name of withSession) {
  test(`pi ${name}: the session file reads into its golden history`, () => {
    const history = recordedHistory(name);
    const golden = new URL(`fixtures/pi/${name}.history.json`, import.meta.url);
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) {
      writeFileSync(golden, JSON.stringify(history, null, 1) + "\n");
    }
    assert.deepEqual(history, JSON.parse(readFileSync(golden, "utf8")));
  });
}

function messages(name: string): StoredMessage[] {
  return recordedHistory(name).messages;
}

/** A message's text; a tool message and a compaction have none. */
function textOf(message: StoredMessage | undefined): string {
  return message && message.role !== "tool" && message.role !== "compaction" ? message.text : "";
}

function tools(all: StoredMessage[]) {
  return all.filter((message): message is Extract<StoredMessage, { role: "tool" }> => message.role === "tool");
}

function shape(all: StoredMessage[]): string[] {
  return all.map((message) => (message.role === "tool" ? `tool:${message.name}` : message.role === "user" && message.display_kind ? `user:${message.display_kind}` : message.role));
}

// MARK: The same as live

/** The recordings whose turns Pi stored whole: history is what the live events leave behind. */
const storedWhole = ["plain", "tools", "stop-tool", "resume", "image", "compact-auto", "thinking", "error", "own"];

for (const name of storedWhole) {
  test(`pi ${name}: history has the same messages, rows and diffs as the live events put through Transcript`, () => {
    assert.deepEqual(timeless(messages(name)), timeless(liveTranscript(name)));
  });
}

test("where history and a live turn differ, and why", () => {
  assert.deepEqual([...storedWhole, "stop", "steer", "compact", "dialog", "killed", "commands"].sort(), [...withSession].sort());

  // A message sent while Pi worked that Stop cleared from Pi's queue: the bridge had
  // stored it when it was sent, Pi never did.
  assert.deepEqual(shape(liveTranscript("stop")), ["user", "assistant", "user:steer", "assistant"]);
  assert.deepEqual(shape(messages("stop")), ["user", "assistant"]);

  // A message taken into the run: the bridge stores it when it is sent, Pi where it
  // delivered it, one behind the command's result and one behind the reply. Both read
  // as sent while Pi worked.
  assert.deepEqual(shape(liveTranscript("steer")), ["user", "user:steer", "user:steer", "tool:terminal", "assistant", "assistant"]);
  assert.deepEqual(shape(messages("steer")), ["user", "tool:terminal", "user:steer", "assistant", "user:steer", "assistant"]);
  // Pi keeps the time a message was queued, which is before the result it follows in
  // the file: that is how one is told from a message sent to a Pi at rest, which is as
  // new as its entry. Times in a history never go backwards.
  const stored = sessionText("steer").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.type === "message" && entry.message.role !== "system");
  assert.deepEqual(stored.map((entry) => entry.message.role), ["user", "assistant", "toolResult", "user", "assistant", "user", "assistant"]);
  const sentBeforeWritten = stored.map((entry, index) => index > 0 && entry.message.timestamp < Date.parse(stored[index - 1].timestamp));
  assert.deepEqual(sentBeforeWritten, [false, false, false, true, false, true, false]);
  for (const name of withSession) {
    const times = messages(name).map((message) => message.timestamp);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), name);
  }

  // Pi stores nothing of a command it carried out itself: no `/compact` (the mark
  // stays, as Pi's own), and none of an extension's commands or what they answered.
  assert.deepEqual(shape(liveTranscript("compact")), ["user", "assistant", "user", "assistant", "user", "compaction", "user", "assistant", "user", "assistant"]);
  assert.deepEqual(shape(messages("compact")), ["user", "assistant", "user", "assistant", "compaction", "user", "assistant"]);
  assert.equal(liveTranscript("dialog").filter((message) => message.role === "user").length, 7);
  assert.equal(messages("dialog").filter((message) => message.role === "user").length, 1);
  // Two calls that ran at once: live in the order they ended, in Pi's file in the order they were made.
  assert.deepEqual(tools(liveTranscript("dialog")).map((message) => message.args.command), ["echo second", "echo first"]);
  assert.deepEqual(tools(messages("dialog")).map((message) => message.args.command), ["echo first", "echo second"]);

  // A reply cut by the process's death is not in Pi's file.
  assert.deepEqual(shape(liveTranscript("killed")), ["user", "assistant", "assistant"]);
  assert.deepEqual(shape(messages("killed")), ["user"]);

  // A prompt template is stored as the text it expanded to.
  assert.equal(textOf(liveTranscript("commands")[2]), "/shout kiwi");
  assert.equal(textOf(messages("commands")[2]), "Reply with only this word in capital letters and nothing else: kiwi");
});

// MARK: What each entry becomes

test("a tool turn: the message, one tool message per call with its result, the reply; times in seconds", () => {
  const all = messages("tools");
  assert.deepEqual(shape(all), ["user", "tool:read_file", "tool:terminal", "tool:patch", "tool:terminal", "tool:write_file", "assistant"]);
  assert.match(textOf(all[0]), /^Do these five steps in order/);
  const [read, wc, edit, ls, write] = tools(all);
  // The result is JSON text, as the app reads it.
  assert.deepEqual(JSON.parse(read.content!), { content: "hi\n" });
  assert.deepEqual(read.args, { path: "hello.txt" });
  assert.match(read.tool_call_id, /^call_[A-Za-z0-9]+\|fc_[0-9a-f]+$/);
  assert.deepEqual(JSON.parse(wc.content!), { output: "       3 hello.txt\n", exit_code: 0 });
  // Pi keeps an edit's patch in its file, so history has the same diff as the live turn.
  assert.deepEqual(edit.args, { path: "hello.txt", old_string: "hi", new_string: "hello" });
  assert.deepEqual(JSON.parse(edit.content!), { success: true, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1,1 +1,1 @@\n-hi\n+hello\n" });
  // No `structuredContent` in the file: the code comes from Pi's last line, which is taken off.
  assert.deepEqual(JSON.parse(ls.content!), { output: "ls: no-such-file.txt: No such file or directory\n", exit_code: 1 });
  assert.deepEqual(JSON.parse(write.content!), { diff: "--- a/done.txt\n+++ b/done.txt\n+done\n" });
  assert.equal(textOf(all.at(-1)), "Updated `hello.txt`, ran both commands, and wrote `done` to `done.txt`.");
  // Pi's times are milliseconds; the app reads seconds.
  assert.equal(all[0].timestamp, 1_793_786_658.283);
  assert.equal(read.timestamp, 1_793_786_661.299);
  for (const message of all) assert.ok(message.timestamp > 1_700_000_000 && message.timestamp < 2_000_000_000);
});

test("a reply stopped mid-stream is marked interrupted, with what it had said", () => {
  const all = messages("stop");
  assert.deepEqual(all[1], { role: "assistant", text: "1\n2\n3\n", timestamp: 1_793_786_673.759, display_metadata: { interrupted: true } });
});

test("a turn stopped while a command ran reads as interrupted, not as a failed turn", () => {
  // Pi's file ends with an empty assistant message, stopReason error, "This operation was aborted".
  const last = sessionText("stop-tool").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.equal(last.message.stopReason, "error");
  assert.equal(last.message.errorMessage, "This operation was aborted");
  const all = messages("stop-tool");
  assert.deepEqual(shape(all), ["user", "tool:terminal", "assistant"]);
  assert.deepEqual(JSON.parse(tools(all)[0].content!), { status: "error", error: "Stopped before it finished." });
  // What the stopped turn spent goes with its last message (feature turn_usage).
  assert.deepEqual(timeless([all[2]]), [{ role: "assistant", text: "", display_metadata: { interrupted: true }, turn_usage: { tokens: 1183 } }]);
  assert.equal(all.some((message) => message.role === "assistant" && message.display_kind === "failed_turn"), false);
});

test("a turn the provider refused is a failed turn with its sentence, without the JSON", () => {
  const all = messages("error");
  assert.deepEqual(timeless(all), [
    { role: "user", text: "Reply with the single word hello." },
    { role: "assistant", text: "OpenAI API error (401): Incorrect API key provided: not-a-re**-key. You can find your API key at https://platform.openai.com/account/api-keys.", display_kind: "failed_turn" },
  ]);
});

test("thinking is the reply's reasoning; an image is an @image line; a skill reads as it was typed", () => {
  const reply = messages("thinking")[1];
  assert.equal(reply.role === "assistant" && reply.reasoning, "**Cross-checking the count**");
  assert.match(textOf(reply), /^115 — /);

  assert.equal(textOf(messages("image")[0]), "What colour is this square? Reply with one word.\n@image:image-1.png");
  // The recorded message does hold the image itself.
  assert.match(sessionText("image"), /"type":"image","data":"iVBOR/);

  // Pi stores the skill's whole text and what followed its name.
  assert.match(sessionText("commands"), /<skill name=\\"greet\\" location=/);
  assert.equal(textOf(messages("commands")[0]), "/skill:greet Ada");
});

test("a compacted file still shows everything that was said, with a mark where Pi summarised", () => {
  const all = messages("compact");
  // The first two turns were summarised; they are still on the path.
  assert.match(textOf(all[1]), /^The sea hums softly/);
  assert.deepEqual(timeless([all[4]]), [{ role: "compaction", trigger: "auto", tokens_before: 1230, turn_usage: { tokens: 1230 } }]);
  assert.equal(textOf(all.at(-1)), "bye");
  // One Pi began by itself reads the same way.
  assert.deepEqual(timeless(messages("compact-auto").slice(-1)), [{ role: "compaction", trigger: "auto", tokens_before: 1199, turn_usage: { tokens: 1199 } }]);
});

test("the calls a codemode script made are part of its one row; system messages are not shown", () => {
  const all = messages("own");
  assert.deepEqual(shape(all), ["user", "tool:execute_code", "assistant"]);
  assert.deepEqual(JSON.parse(tools(all)[0].content!), { output: 'Script completed\nWall time 0.1 seconds\nOutput:\n[11,12]' });
  // Every session file starts with a system message, before the user's.
  for (const name of withSession) assert.match(sessionText(name), /"message":\{"role":"system"/, name);
  assert.equal(messages("plain").length, 2);
});

test("a thread resumed in a second process reads as one conversation; one killed mid-reply keeps the message", () => {
  assert.deepEqual(timeless(messages("resume")), [
    { role: "user", text: "Remember the word kiwi. Reply with only: ok" },
    // Each turn's tokens, from Pi's own file: the second turn sends the first again.
    { role: "assistant", text: "ok", turn_usage: { tokens: 1156 } },
    { role: "user", text: "Which word did I ask you to remember? Reply with only that word." },
    { role: "assistant", text: "kiwi", turn_usage: { tokens: 1183 } },
  ]);
  // The resumed process says it has the earlier messages, as the file does.
  const resumed = fixture("resume").filter((entry) => entry.kind === "receive" && entry.record.command === "get_state")[1];
  assert.equal(resumed.record.data.messageCount, 3);
  assert.equal(messages("killed").length, 1);
});

// MARK: Written by hand

/** A session file from its entries, each given its id, its parent and a time. */
function file(entries: Record<string, unknown>[], header = true): string {
  const lines = header ? [JSON.stringify({ type: "session", version: 3, id: "t1", timestamp: "2026-10-12T10:00:00.000Z", cwd: "/w" })] : [];
  return [...lines, ...entries.map((entry) => JSON.stringify(entry))].join("\n") + "\n";
}

let at = 0;
/**
 * A message's entry, written a second after the one before it. The message is as new as
 * its entry, unless it was sent `sentAgo` milliseconds before that: one Pi queued keeps
 * the time it was sent.
 */
function entry(id: string, parentId: string | null, message: Record<string, unknown>, sentAgo = 0): Record<string, unknown> {
  at += 1000;
  const written = 1_791_800_000_000 + at;
  return { type: "message", id, parentId, timestamp: new Date(written).toISOString(), message: { ...message, timestamp: written - sentAgo } };
}

function user(id: string, parentId: string | null, text: string): Record<string, unknown> {
  return entry(id, parentId, { role: "user", content: [{ type: "text", text }] });
}

function assistant(id: string, parentId: string | null, content: unknown[], more: Record<string, unknown> = {}): Record<string, unknown> {
  return entry(id, parentId, { role: "assistant", content, stopReason: "stop", ...more });
}

test("the conversation is the path from the file's last entry, not every line of it", () => {
  // Written by hand: `/tree` at the desk went back to the first reply and asked again.
  const text = file([
    { type: "model_change", id: "m", parentId: null, timestamp: "2026-10-12T10:00:00.000Z", provider: "openai", modelId: "gpt-6-luna" },
    user("u1", "m", "Name a fruit."),
    assistant("a1", "u1", [{ type: "text", text: "Apple." }]),
    user("u2", "a1", "Another."),
    assistant("a2", "u2", [{ type: "text", text: "Banana." }]),
    { type: "branch_summary", id: "b", parentId: "a1", timestamp: "2026-10-12T10:01:00.000Z", fromId: "a2", summary: "Asked for a second fruit." },
    user("u3", "b", "A vegetable instead."),
    assistant("a3", "u3", [{ type: "text", text: "Carrot." }]),
    { type: "label", id: "l", parentId: "a3", timestamp: "2026-10-12T10:02:00.000Z", targetId: "a1", label: "start" },
  ]);
  assert.deepEqual(timeless(historyFromSession(text, "/w").messages), [
    { role: "user", text: "Name a fruit." },
    { role: "assistant", text: "Apple." },
    { role: "user", text: "A vegetable instead." },
    { role: "assistant", text: "Carrot." },
  ]);
});

test("a retried attempt keeps what it said and loses its error; the attempt that stood is the failed turn", () => {
  // Written by hand: no retry could be recorded.
  const text = file([
    user("u1", null, "Go."),
    assistant("a1", "u1", [{ type: "text", text: "Let me" }], { stopReason: "error", errorMessage: "529 overloaded" }),
    assistant("a2", "a1", [{ type: "thinking", thinking: "Again.\n\n" }, { type: "text", text: "Here it is." }]),
    user("u2", "a2", "Once more."),
    assistant("a3", "u2", [], { stopReason: "error", errorMessage: "529 overloaded" }),
    assistant("a4", "a3", [], { stopReason: "error", errorMessage: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }),
  ]);
  assert.deepEqual(timeless(historyFromSession(text, "/w").messages), [
    { role: "user", text: "Go." },
    { role: "assistant", text: "Let me" },
    { role: "assistant", text: "Here it is.", reasoning: "Again." },
    { role: "user", text: "Once more." },
    { role: "assistant", text: "529 Overloaded", display_kind: "failed_turn" },
  ]);
});

test("retry checks in a long conversation do not copy its remaining entries", () => {
  const entries: Record<string, unknown>[] = [];
  let parent: string | null = null;
  for (let turn = 0; turn < 1000; turn += 1) {
    entries.push(user(`u${turn}`, parent, "Go."));
    entries.push(assistant(`e${turn}`, `u${turn}`, [], { stopReason: "error", errorMessage: "529 overloaded" }));
    entries.push(assistant(`a${turn}`, `e${turn}`, [{ type: "text", text: "Done." }]));
    parent = `a${turn}`;
  }
  const text = file(entries);
  const slice = Array.prototype.slice;
  let copied = 0;
  let history: ReturnType<typeof historyFromSession>;
  try {
    Array.prototype.slice = function (start, end) {
      const result = slice.call(this, start, end);
      if (this.length === entries.length) copied += result.length;
      return result;
    };
    history = historyFromSession(text, "/w");
  } finally {
    Array.prototype.slice = slice;
  }
  assert.equal(copied, 0);
  assert.equal(history.messages.length, 2000);
  assert.equal(textOf(history.messages.at(-1)), "Done.");
  assert.equal(history.messages.some((message) => message.role === "assistant" && message.display_kind === "failed_turn"), false);
});

test("user messages: a string, blocks with images, one sent while Pi worked, and an empty one", () => {
  // Written by hand.
  const text = file([
    entry("u1", null, { role: "user", content: "An older message, stored as a string." }),
    assistant("a1", "u1", [{ type: "thinking", thinking: "One." }, { type: "thinking", thinking: "  " }, { type: "thinking", thinking: "Two." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 4", timeout: null } }], { stopReason: "toolUse" }),
    entry("r1", "a1", { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "(no output)" }], isError: false, durationMs: 4000 }),
    // Sent while the command ran, and delivered behind its result.
    entry("u2", "r1", { role: "user", content: [{ type: "text", text: "Look at these." }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }, { type: "image", data: "AAAA", mimeType: "image/webp" }] }, 2500),
    assistant("a2", "u2", [{ type: "text", text: "Two " }, { type: "text", text: "pictures." }]),
    entry("u3", "a2", { role: "user", content: [] }),
    entry("x1", "u3", { role: "custom", customType: "search", content: "for the model", display: true }),
    entry("x2", "x1", { role: "bashExecution", command: "ls", output: "a", exitCode: 0 }),
    { type: "custom_message", id: "x3", parentId: "x2", timestamp: "2026-10-12T10:00:09.000Z", customType: "search", content: "also for the model", display: true },
  ]);
  assert.deepEqual(timeless(historyFromSession(text, "/w").messages), [
    { role: "user", text: "An older message, stored as a string." },
    // Thinking with no text is kept; blank blocks are not paragraphs.
    { role: "assistant", text: "", reasoning: "One.\n\nTwo." },
    { role: "tool", name: "terminal", args: { command: "sleep 4" }, content: '{"output":"","exit_code":0}', tool_call_id: "c1" },
    // Sent before the result it follows was written: taken into the run.
    { role: "user", text: "Look at these.\n@image:image-1.jpg\n@image:image-2.webp", display_kind: "steer" },
    { role: "assistant", text: "Two pictures." },
  ]);
});

test("a message sent while Pi worked is told by its time, not by what it follows", () => {
  // Written by hand: Pi was killed (or the bridge restarted) right after a command's
  // result was stored, and the next message came later, to a new process.
  const cut = file([
    user("u1", null, "Run the tests."),
    assistant("a1", "u1", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }], { stopReason: "toolUse" }),
    entry("r1", "a1", { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, durationMs: 900 }),
    user("u2", "r1", "Are you there?"),
    assistant("a2", "u2", [{ type: "text", text: "Yes." }]),
  ]);
  assert.deepEqual(timeless(historyFromSession(cut, "/w").messages), [
    { role: "user", text: "Run the tests." },
    { role: "tool", name: "terminal", args: { command: "npm test" }, content: '{"output":"ok","exit_code":0}', tool_call_id: "c1" },
    // A message of its own, which opens a turn: nothing was running when it was sent.
    { role: "user", text: "Are you there?" },
    { role: "assistant", text: "Yes." },
  ]);
  // Written by hand: sent while a reply with no tool call streamed. Pi delivers it behind that reply and answers on.
  const midReply = file([
    user("u1", null, "Tell me a story."),
    assistant("a1", "u1", [{ type: "text", text: "Once upon a time." }]),
    entry("u2", "a1", { role: "user", content: [{ type: "text", text: "Make it short." }] }, 1500),
    assistant("a2", "u2", [{ type: "text", text: "The end." }]),
    user("u3", "a2", "Thanks."),
  ]);
  assert.deepEqual(timeless(historyFromSession(midReply, "/w").messages), [
    { role: "user", text: "Tell me a story." },
    { role: "assistant", text: "Once upon a time." },
    { role: "user", text: "Make it short.", display_kind: "steer" },
    { role: "assistant", text: "The end." },
    { role: "user", text: "Thanks." },
  ]);
  // An entry that does not say when it was written marks nothing.
  const undated = midReply.split("\n").map((line) => (line.includes('"id":"a1"') ? JSON.stringify({ ...JSON.parse(line), timestamp: undefined }) : line)).join("\n");
  assert.deepEqual(timeless(historyFromSession(undated, "/w").messages).filter((message: any) => message.display_kind), []);
});

test("a tool call with no result by the user's next message, or by the file's end, closes as stopped", () => {
  // Written by hand: Pi died while the tool ran.
  const text = file([
    user("u1", null, "Run the tests."),
    assistant("a1", "u1", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }], { stopReason: "toolUse" }),
    user("u2", "a1", "Are you there?"),
    assistant("a2", "u2", [{ type: "toolCall", id: "c2", name: "mcp__notes__search", arguments: { query: "x" } }], { stopReason: "toolUse" }),
  ]);
  const all = historyFromSession(text, "/w").messages;
  assert.deepEqual(timeless(all), [
    { role: "user", text: "Run the tests." },
    { role: "tool", name: "terminal", args: { command: "npm test" }, content: '{"status":"error","error":"Stopped before it finished."}', tool_call_id: "c1" },
    // No tool result came before it, so it is not marked as sent mid-run.
    { role: "user", text: "Are you there?" },
    { role: "tool", name: "search", args: { query: "x" }, content: '{"status":"error","error":"Stopped before it finished."}', tool_call_id: "c2", context: "notes" },
  ]);
});

test("Stop while an extension still asked about a tool, and other ways a stop is stored", () => {
  // Written by hand from a run against a stand-in model: the tool ends "Operation aborted".
  const stopped = file([
    user("u1", null, "Run it."),
    assistant("a1", "u1", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo hi" } }], { stopReason: "toolUse" }),
    entry("r1", "a1", { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "Operation aborted" }], details: {}, isError: true }),
    assistant("a2", "r1", [], { stopReason: "error", errorMessage: "Some other words for an abort" }),
  ]);
  assert.deepEqual(timeless(historyFromSession(stopped, "/w").messages), [
    { role: "user", text: "Run it." },
    { role: "tool", name: "terminal", args: { command: "echo hi" }, content: '{"status":"error","error":"Stopped before it finished."}', tool_call_id: "c1" },
    { role: "assistant", text: "", display_metadata: { interrupted: true } },
  ]);
  // An empty error message after a tool that simply failed is a failed turn.
  const failed = file([
    user("u1", null, "Run it."),
    assistant("a1", "u1", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "false" } }], { stopReason: "toolUse" }),
    entry("r1", "a1", { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "Command exited with code 1" }], isError: true, durationMs: 3 }),
    assistant("a2", "r1", [], { stopReason: "error", errorMessage: "503 no capacity" }),
  ]);
  assert.deepEqual(timeless(historyFromSession(failed, "/w").messages).at(-1), { role: "assistant", text: "503 no capacity", display_kind: "failed_turn" });
  // An error with no words at all still says something.
  const silent = file([user("u1", null, "Hi."), assistant("a1", "u1", [], { stopReason: "error" })]);
  assert.equal(textOf(historyFromSession(silent, "/w").messages.at(-1)), "Pi stopped with an error.");
});

test("the session's name is its title: the last one given, none when it was cleared", () => {
  // Written by hand.
  const named = (names: (string | undefined)[]) =>
    file([user("u1", null, "Hi."), ...names.map((name, index) => ({ type: "session_info", id: `n${index}`, parentId: index === 0 ? "u1" : `n${index - 1}`, timestamp: "2026-10-12T10:00:00.000Z", ...(name === undefined ? {} : { name }) }))]);
  assert.equal(historyFromSession(named(["First", "  Second  "]), "/w").title, "Second");
  assert.equal(historyFromSession(named(["First", undefined]), "/w").title, null);
  assert.equal(recordedHistory("plain").title, null);
});

test("a file that is missing, empty or cut mid-line reads as far as it goes", async (t) => {
  assert.deepEqual(historyFromSession("", "/w"), { messages: [], title: null });
  // Only the header: a thread with no message yet.
  assert.deepEqual(historyFromSession(file([]), "/w"), { messages: [], title: null });
  assert.deepEqual(historyFromSession("not json at all\n{}\n[1,2]\nnull\n", "/w"), { messages: [], title: null });
  // Pi was killed while it wrote the last line: what came before it still reads.
  const whole = sessionText("tools");
  const cut = whole.slice(0, whole.lastIndexOf('{"type":"message"') + 40);
  const read = historyFromSession(cut, fixtureCwd).messages;
  assert.deepEqual(shape(read), ["user", "tool:read_file", "tool:terminal", "tool:patch", "tool:terminal", "tool:write_file"]);
  // Entries with fields missing are passed over.
  const odd = file([{ type: "message", id: "a" }, { type: "message", id: "b", parentId: "a", message: {} }, { type: "message", id: "c", parentId: "b", message: { role: "assistant" } }, { type: "compaction", id: "d", parentId: "c" }]);
  assert.deepEqual(historyFromSession(odd, "/w").messages.map((message) => message.role), ["compaction"]);

  const folder = mkdtempSync(join(tmpdir(), "pi-history-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  assert.deepEqual(await readHistory(null, "/w"), { messages: [], title: null });
  assert.deepEqual(await readHistory(join(folder, "none.jsonl"), "/w"), { messages: [], title: null });
  const path = join(folder, "plain.jsonl");
  writeFileSync(path, sessionText("plain"));
  // With the file it was read from and how much of it was read, which a thread compares
  // with the file later to tell whether a Pi at the desk went on with it.
  assert.deepEqual(await readHistory(path, fixtureCwd), { ...recordedHistory("plain"), read: { file: path, size: Buffer.byteLength(sessionText("plain")) } });
});

// MARK: Where the file is

test("Pi's folder for a working folder's sessions, as Pi names it", () => {
  assert.equal(sessionFolderName("/tmp/portals-cwd"), "--tmp-portals-cwd--");
  assert.equal(sessionFolderName("/Users/dev/coding_projects/my.app"), "--Users-dev-coding_projects-my.app--");
  assert.equal(sessionFolderName("C:\\work\\app"), "--C--work-app--");
  // The recorder kept the resume scenario in Pi's own sessions folder, under that name.
  const [stats] = fixture("resume").filter((entry) => entry.kind === "receive" && entry.record.command === "get_session_stats");
  assert.equal(stats.record.data.sessionFile, `/home/dev/.pi/agent/sessions/${sessionFolderName(fixtureCwd)}/2026-11-04T10-04-50-282Z_00000000-0000-4000-8000-000000000007.jsonl`);

  assert.equal(agentFolder({}), join(homedir(), ".pi", "agent"));
  assert.equal(agentFolder({ PI_CODING_AGENT_DIR: "/elsewhere/agent" }), "/elsewhere/agent");
  assert.equal(agentFolder({ PI_CODING_AGENT_DIR: "~/pi-agent" }), join(homedir(), "pi-agent"));
});

test("a thread's session file is found by its id: in its folder's place first, then anywhere under sessions", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-history-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PI_CODING_AGENT_DIR: join(root, "agent") };
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const id = "00000000-0000-4000-8000-0000000000aa";
  // No sessions folder at all, then none for this thread.
  assert.equal(await findSessionFile(id, cwd, env), null);
  const sessions = join(root, "agent", "sessions");
  const own = join(sessions, sessionFolderName(cwd));
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "2026-10-12T10-00-00-000Z_00000000-0000-4000-8000-0000000000bb.jsonl"), "");
  writeFileSync(join(own, "not-a-session.txt"), "");
  assert.equal(await findSessionFile(id, cwd, env), null);

  // In another folder (Pi named it by another rule, or the project moved): still found.
  const other = join(sessions, "--somewhere-else--");
  mkdirSync(other);
  const moved = join(other, `2026-10-11T09-00-00-000Z_${id}.jsonl`);
  writeFileSync(moved, "");
  assert.equal(await findSessionFile(id, cwd, env), moved);

  // In its own folder: that one wins, and of two the newer.
  writeFileSync(join(own, `2026-10-12T10-00-00-000Z_${id}.jsonl`), "");
  const newest = join(own, `2026-10-12T11-00-00-000Z_${id}.jsonl`);
  writeFileSync(newest, "");
  assert.equal(await findSessionFile(id, cwd, env), newest);
  // Asked about with a folder that is gone by now, the thread's file is still found by its id.
  assert.match((await findSessionFile(id, join(root, "no-such-project"), env)) ?? "", new RegExp(`_${id}\\.jsonl$`));
  assert.equal(await findSessionFile("00000000-0000-4000-8000-0000000000cc", join(root, "no-such-project"), env), null);

  // Pi names the folder after the real path, which a link to the project is not.
  const link = join(root, "link");
  symlinkSync(cwd, link);
  assert.equal(await findSessionFile(id, link, env), newest);
});

test("sessions the bridge's environment moves are looked for where Pi then keeps them: one folder for every working folder's", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-history-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const moved = join(root, "elsewhere");
  mkdirSync(cwd);
  mkdirSync(moved);
  const env = { PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: moved };
  const id = "00000000-0000-4000-8000-0000000000dd";
  assert.equal(movedSessions(env, cwd), moved);
  assert.equal(movedSessions({ PI_CODING_AGENT_DIR: join(root, "agent") }, cwd), null);
  assert.equal(movedSessions({ PI_CODING_AGENT_SESSION_DIR: "~/pi-sessions" }, cwd), join(homedir(), "pi-sessions"));
  // A folder given without its whole path is in the folder Pi runs in, the thread's.
  assert.equal(movedSessions({ PI_CODING_AGENT_SESSION_DIR: "kept" }, cwd), join(cwd, "kept"));
  assert.equal(await findSessionFile(id, cwd, env), null);

  // One from before the variable was set, under Pi's own folder: still found.
  const usual = join(root, "agent", "sessions", sessionFolderName(cwd));
  mkdirSync(usual, { recursive: true });
  const before = join(usual, `2026-10-11T09-00-00-000Z_${id}.jsonl`);
  writeFileSync(before, "");
  assert.equal(await findSessionFile(id, cwd, env), before);
  // Where Pi keeps them now, with no folder per working folder: that one first.
  writeFileSync(join(moved, "2026-10-12T10-00-00-000Z_00000000-0000-4000-8000-0000000000ee.jsonl"), "");
  const now = join(moved, `2026-10-12T10-00-00-000Z_${id}.jsonl`);
  writeFileSync(now, "");
  assert.equal(await findSessionFile(id, cwd, env), now);
});
