import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { historyFromSession } from "../src/providers/claude/history.ts";
import { ClaudeStream } from "../src/providers/claude/stream.ts";
import { gatewayResult, historyLosesDiff } from "../src/providers/claude/tools.ts";
import type { ProviderEvent, StoredMessage } from "../src/providers/types.ts";
import { DiffStore, diffsKeptBytes, keepDelayMs, withKeptDiffs } from "../src/sessions/keptDiffs.ts";
import { turnDiff, turnDiffCap } from "../src/sessions/turnDiff.ts";
import { Transcript } from "../src/sessions/transcript.ts";
import { fakeClaude, FakeFiles, playEntries, type Entry, type FakeQuery } from "./claude-fixtures.ts";
import { isEvent, startTestBridge, TestClient, type Frame } from "./helpers.ts";

// The diffs the bridge keeps of edits whose agent's history will not give them back as
// they were (feature turn_diff, src/sessions/keptDiffs.ts): Claude Code's history keeps
// no structured patch, so a `replace_all` Edit that changed two lines read back from it
// changed one, and a Write over a file removed nothing. Kept by the tool call's id, they
// are put back when a thread is loaded again, so its turns' counts are those shown live.

/** The file a Claude turn edited with `replace_all`: two of its lines say `log(a);`. */
const appBefore = "const a = 1;\nlog(a);\nconst b = 2;\nlog(a);\n";

/**
 * One Claude turn as Claude Code streams it: an Edit with `replace_all` that changed both
 * `log(a);` lines, a Write over a file of two lines with one, and a reply. `structured`:
 * with each result's `tool_use_result`, as a live turn has it; without, as Claude's stored
 * history gives the same messages.
 */
function editTurn(cwd: string, session: string, structured: boolean): unknown[] {
  const app = join(cwd, "app.ts");
  const notes = join(cwd, "notes.txt");
  const use = (id: string, name: string, input: Record<string, unknown>) => ({
    type: "assistant",
    message: { id: `msg_${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 10, output_tokens: 5 } },
    parent_tool_use_id: null,
    session_id: session,
    uuid: `uuid-use-${id}`,
  });
  const result = (id: string, said: string, toolUseResult: Record<string, unknown>) => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: said }] },
    parent_tool_use_id: null,
    session_id: session,
    uuid: `uuid-result-${id}`,
    ...(structured ? { tool_use_result: toolUseResult } : {}),
  });
  return [
    use("toolu_edit", "Edit", { file_path: app, old_string: "log(a);", new_string: "print(a);", replace_all: true }),
    result("toolu_edit", `The file ${app} has been updated. All occurrences of 'log(a);' were successfully replaced with 'print(a);'.`, {
      filePath: app,
      oldString: "log(a);",
      newString: "print(a);",
      originalFile: appBefore,
      structuredPatch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [" const a = 1;", "-log(a);", "+print(a);", " const b = 2;", "-log(a);", "+print(a);"] }],
      userModified: false,
      replaceAll: true,
    }),
    use("toolu_write", "Write", { file_path: notes, content: "three\n" }),
    result("toolu_write", `The file ${notes} has been updated successfully.`, {
      type: "update",
      filePath: notes,
      content: "three\n",
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: ["-one", "-two", "+three"] }],
      originalFile: "one\ntwo\n",
    }),
    {
      type: "assistant",
      message: { id: "msg_reply", role: "assistant", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 10, output_tokens: 2 } },
      parent_tool_use_id: null,
      session_id: session,
      uuid: "uuid-reply",
    },
  ];
}

/** Each file's path, status and counts, and the turn's. */
function counts(changed: Frame): unknown {
  return { files: changed.files.map((file: Frame) => [file.path, file.status, file.added, file.removed]), added: changed.added, removed: changed.removed };
}

const liveCounts = { files: [["app.ts", "modified", 2, 2], ["notes.txt", "modified", 1, 2]], added: 3, removed: 4 };
/** What the same turn read back from Claude's history alone comes to. */
const rebuiltCounts = { files: [["app.ts", "modified", 1, 1], ["notes.txt", "modified", 1, 0]], added: 2, removed: 1 };

test("through Claude's own mappers: an edit's live diff that history loses is marked, and put back in place of the rebuilt one the counts are the live ones", () => {
  const cwd = "/tmp/kept-diffs-cwd";
  const live: ProviderEvent[] = [];
  const stream = new ClaudeStream({ cwd, now: () => 0, timeZone: "UTC" });
  for (const message of editTurn(cwd, "s", true)) live.push(...stream.map(message as never));
  const ends = live.filter((event) => event.type === "tool.end");
  assert.deepEqual(ends.map((event) => [event.id, event.keepDiff]), [["toolu_edit", true], ["toolu_write", true]]);

  // The live turn as the bridge stores it, and the same turn from history.
  const transcript = new Transcript([]);
  transcript.startTurn("Rename log, rewrite notes.");
  for (const event of live) transcript.apply(event);
  assert.deepEqual(counts(turnDiff(transcript.messages)), liveCounts);
  const opened = [{ type: "user", message: { role: "user", content: "Rename log, rewrite notes." }, parent_tool_use_id: null }];
  const history = historyFromSession([...opened, ...editTurn(cwd, "s", false)], cwd);
  assert.deepEqual(counts(turnDiff(history)), rebuiltCounts);

  // Put back by tool call id, the live diffs give the live counts and line numbers.
  const kept = new Map(ends.map((event) => [event.id, (event.result as { diff: string }).diff]));
  const restored = withKeptDiffs(history, kept);
  assert.deepEqual(counts(turnDiff(restored)), liveCounts);
  assert.deepEqual(turnDiff(restored), turnDiff(transcript.messages));
  const row = restored.find((message) => message.role === "tool" && message.tool_call_id === "toolu_edit");
  assert.deepEqual(JSON.parse((row as { content: string }).content), { success: true, diff: "--- a/app.ts\n+++ b/app.ts\n@@ -1,4 +1,4 @@\n const a = 1;\n-log(a);\n+print(a);\n const b = 2;\n-log(a);\n+print(a);\n" });
});

test("a new file written whole, a failed edit and a denied one are not kept: history gives them back the same, or they made no change", () => {
  const cwd = "/tmp/kept-diffs-cwd";
  const input = { file_path: `${cwd}/new.txt`, content: "a\nb\n" };
  const created = { content: `File created successfully at: ${cwd}/new.txt`, isError: false, structured: { type: "create", filePath: `${cwd}/new.txt`, content: "a\nb\n", structuredPatch: [], originalFile: null } };
  assert.equal(historyLosesDiff("Write", input, created, gatewayResult("Write", input, created, cwd), cwd), false);
  const edit = { file_path: `${cwd}/app.ts`, old_string: "x", new_string: "y" };
  const failed = { content: "String to replace not found in file.", isError: true, structured: {} };
  assert.equal(historyLosesDiff("Edit", edit, failed, gatewayResult("Edit", edit, failed, cwd), cwd), false);
  const denied = { content: "Denied from Portals.", isError: true, denied: true, structured: {} };
  assert.equal(historyLosesDiff("Edit", edit, denied, gatewayResult("Edit", edit, denied, cwd), cwd), false);
  // History's own rows: no structured result, nothing to keep.
  const plain = { content: "The file has been updated.", isError: false };
  assert.equal(historyLosesDiff("Edit", edit, plain, gatewayResult("Edit", edit, plain, cwd), cwd), false);
  assert.equal(historyLosesDiff("Bash", { command: "ls" }, { content: "a", isError: false, structured: { stdout: "a" } }, { output: "a", exit_code: 0 }, cwd), false);

  // Put back only on a row that says the edit was made.
  const rows: StoredMessage[] = [
    { role: "tool", name: "patch", args: {}, content: JSON.stringify({ success: false, error: "No." }), tool_call_id: "t1", timestamp: 1 },
    { role: "tool", name: "terminal", args: {}, content: "plain text", tool_call_id: "t2", timestamp: 2 },
  ];
  withKeptDiffs(rows, new Map([["t1", "--- a/x\n+++ b/x\n-a\n+b\n"], ["t2", "--- a/x\n+++ b/x\n-a\n+b\n"]]));
  assert.deepEqual(rows.map((row) => (row.role === "tool" ? row.content : null)), [JSON.stringify({ success: false, error: "No." }), "plain text"]);
});

test("the store keeps diffs by id, written a moment later or at a flush, readable before; a line it cannot read costs only itself", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "kept-diffs-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new DiffStore(join(folder, "diffs"));
  const file = join(folder, "diffs", "th%2Fone.jsonl");
  assert.deepEqual(store.read("th/one"), new Map());
  store.keep("th/one", "a", "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n");
  // Not written yet, and read all the same.
  assert.equal(existsSync(file), false);
  assert.equal(store.read("th/one").get("a"), "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n");
  await new Promise((resolve) => setTimeout(resolve, keepDelayMs + 100));
  assert.equal(existsSync(file), true);
  store.keep("th/one", "b", "--- a/y\n+++ b/y\n-3\n+4\n");
  store.keep("th/one", "a", "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+3\n");
  store.flush();
  // A line cut short by a crash, then one more kept: each line opens with its break, so the next is whole.
  writeFileSync(file, readFileSync(file, "utf8") + '\n{"id":"c","diff":"--- a/z', { flag: "w" });
  store.keep("th/one", "d", "--- a/w\n+++ b/w\n+5\n");
  store.flush();
  assert.deepEqual(
    [...new DiffStore(join(folder, "diffs")).read("th/one")],
    [
      ["a", "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+3\n"],
      ["b", "--- a/y\n+++ b/y\n-3\n+4\n"],
      ["d", "--- a/w\n+++ b/w\n+5\n"],
    ],
  );
  // A file that is not the bridge's at all is no diffs, and no failure.
  writeFileSync(file, Buffer.from([0, 159, 146, 150, 10, 123, 125, 10, 91, 93]));
  assert.deepEqual(store.read("th/one"), new Map());
  // Still kept, after it.
  store.keep("th/one", "e", "--- a/v\n+++ b/v\n+6\n");
  store.flush();
  assert.deepEqual([...store.read("th/one").keys()], ["e"]);

  // A removed thread's go, those waiting too; the sweep takes those the bridge did not let go of.
  store.keep("th/one", "f", "--- a/u\n+++ b/u\n+7\n");
  store.forget("th/one");
  store.flush();
  assert.equal(existsSync(file), false);
  store.keep("gone", "a", "--- a/x\n+++ b/x\n+1\n");
  store.keep("listed", "a", "--- a/x\n+++ b/x\n+1\n");
  store.flush();
  store.sweep((thread) => thread === "gone");
  assert.deepEqual([store.read("gone").size, store.read("listed").size], [0, 1]);
});

test("a copy of a thread's diffs is the fork's: those written and those still waiting, the original's left as they were", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "kept-diffs-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new DiffStore(join(folder, "diffs"));
  store.keep("thread", "a", "--- a/x\n+++ b/x\n-1\n+2\n");
  store.flush();
  store.keep("thread", "b", "--- a/y\n+++ b/y\n-3\n+4\n");
  store.copy("thread", "fork");
  const both = [
    ["a", "--- a/x\n+++ b/x\n-1\n+2\n"],
    ["b", "--- a/y\n+++ b/y\n-3\n+4\n"],
  ];
  assert.deepEqual([...store.read("fork")], both);
  store.flush();
  assert.deepEqual([...new DiffStore(join(folder, "diffs")).read("fork")], both);
  assert.deepEqual([...new DiffStore(join(folder, "diffs")).read("thread")], both);
  // A thread that kept none gives none, and makes no file.
  store.copy("none", "other");
  store.flush();
  assert.equal(existsSync(join(folder, "diffs", "other.jsonl")), false);
});

test("a diff past the turn's cap is kept cut, its counts whole; a thread's file past its cap keeps only its latest diffs", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "kept-diffs-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new DiffStore(join(folder, "diffs"));
  const long = ["--- a/big.txt", "+++ b/big.txt", "@@ -1,0 +1,100000 @@", ...Array.from({ length: 100_000 }, (_, index) => `+line ${index}`)].join("\n") + "\n";
  store.keep("th", "big", long);
  store.flush();
  const cut = store.read("th").get("big")!;
  assert.ok(cut.length <= turnDiffCap + 100);
  const changed = turnDiff([{ role: "tool", name: "write_file", args: {}, content: JSON.stringify({ diff: cut }), tool_call_id: "big", timestamp: 1 }]);
  assert.deepEqual([changed?.added, changed?.removed, changed?.cut], [100_000, 0, true]);

  // About 100 KB each: the file passes its cap, and keeps the latest that fit in half of it.
  const body = "x".repeat(100 * 1024);
  const count = Math.ceil(diffsKeptBytes / body.length) + 5;
  for (let index = 0; index < count; index += 1) {
    store.keep("th", `e${index}`, `--- a/f${index}\n+++ b/f${index}\n+${body}\n`);
    store.flush();
  }
  const kept = [...store.read("th").keys()];
  assert.ok(kept.length > 0 && kept.length < count);
  assert.equal(kept.at(-1), `e${count - 1}`);
  assert.ok(readFileSync(join(folder, "diffs", "th.jsonl"), "utf8").length <= diffsKeptBytes);
  // The latest, in order, with none left out between them.
  assert.deepEqual(kept, Array.from({ length: kept.length }, (_, index) => `e${count - kept.length + index}`));
});

test("a thread's file of diffs in a script of several bytes a character is cut to its cap in bytes, so each edit after does not write it whole again", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "kept-diffs-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new DiffStore(join(folder, "diffs"));
  const file = join(folder, "diffs", "th.jsonl");
  // About 100 K characters each, of three bytes each in UTF-8 (comments in Chinese, say).
  const body = "界".repeat(100 * 1024);
  const count = Math.ceil(diffsKeptBytes / Buffer.byteLength(body)) + 5;
  for (let index = 0; index < count; index += 1) {
    store.keep("th", `e${index}`, `--- a/f${index}\n+++ b/f${index}\n+${body}\n`);
    store.flush();
  }
  // Cut once it passed its cap: no bigger on disk than that, so the next edit only adds its line.
  const size = statSync(file).size;
  assert.ok(size <= diffsKeptBytes, `the file is ${size} bytes, past its cap of ${diffsKeptBytes}`);
  const before = readFileSync(file, "utf8");
  store.keep("th", "next", "--- a/g\n+++ b/g\n+one line\n");
  store.flush();
  assert.ok(readFileSync(file, "utf8").startsWith(before), "the next edit's line is added to the file as it was");
  assert.equal([...store.read("th").keys()].at(-1), "next");
});

// MARK: Through the bridge

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a Claude turn's replace_all Edit and Write over a file keep their live counts after a restart; one the bridge did not see has history's; a removed thread's diffs go", async (t) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "portals-kept-diffs-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const shared = new FakeFiles();
  const firstRun = fakeClaude({ files: shared });
  const before = await startTestBridge({ keepHome: true, providers: new Map([["claude", firstRun.provider]]), config: { generalFolder: cwd } });
  const home = before.home;
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const phone = await TestClient.open(before);
  const session = (await phone.call("session.create", { profile: "claude", cwd })).session_id;
  const start = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "Rename log, rewrite notes.", profile: "claude" });
  const threads = () => firstRun.queries.filter((query: FakeQuery) => query.options.persistSession !== false);
  await until(() => threads().length === 1);
  const turn = editTurn(cwd, session, true);
  const result = { type: "result", subtype: "success", is_error: false, num_turns: 3, result: "Done.", usage: { input_tokens: 30, output_tokens: 12 }, session_id: session, uuid: "uuid-result" };
  const entries: Entry[] = [{ kind: "send", at: 0 }, ...[...turn, result].map((message): Entry => ({ kind: "message", at: 0, message }))];
  await playEntries(threads()[0], entries);
  const complete = (await phone.from(start, (frame) => isEvent(frame, "message.complete", session))).params.payload;
  const live = complete.turn_diff;
  assert.deepEqual(counts(live), liveCounts);
  const liveRows = phone.frames.slice(start).filter((frame) => isEvent(frame, "tool.complete", session)).map((frame) => frame.params.payload.result);
  await phone.close();
  await before.close();
  assert.equal(existsSync(join(home, "state", "diffs", `${session}.jsonl`)), true);

  // Claude's stored session: the same messages without their structured results.
  const opened = { type: "user", uuid: "uuid-opened", session_id: session, message: { role: "user", content: "Rename log, rewrite notes." }, parent_tool_use_id: null };
  shared.stored.set(session, { title: null, messages: [opened, ...editTurn(cwd, session, false)] });
  const restarted = async () => {
    const bridge = await startTestBridge({ home, keepHome: true, providers: new Map([["claude", fakeClaude({ files: shared }).provider]]) });
    const client = await TestClient.open(bridge);
    const resumed = await client.call("session.resume", { session_id: session, profile: "claude", inline_images: false });
    return { bridge, client, messages: resumed.messages as Frame[] };
  };
  let again = await restarted();
  try {
    assert.deepEqual(again.messages.at(-1).turn_diff, live);
    const rows = again.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
    assert.deepEqual(rows, liveRows);
  } finally {
    await again.client.close();
    await again.bridge.close();
  }

  // A file that cannot be read is no diffs: the turn has the counts history gives, as one
  // made while the bridge was off has.
  writeFileSync(join(home, "state", "diffs", `${session}.jsonl`), "not the bridge's\n{");
  again = await restarted();
  try {
    assert.deepEqual(counts(again.messages.at(-1).turn_diff), rebuiltCounts);
    // Removed, the thread takes its file with it.
    assert.deepEqual(await again.client.call("thread.delete", { thread: session }), {});
    assert.equal(existsSync(join(home, "state", "diffs", `${session}.jsonl`)), false);
  } finally {
    await again.client.close();
    await again.bridge.close();
  }
});

test("a Claude thread forked keeps the live counts of the edits it was forked with, after a restart too", async (t) => {
  // The fork's history is Claude's copy of the thread's, which has no structured patches:
  // without the thread's kept diffs, its turns had the rebuilt counts.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "portals-kept-diffs-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const shared = new FakeFiles();
  const firstRun = fakeClaude({ files: shared });
  const bridge = await startTestBridge({ keepHome: true, providers: new Map([["claude", firstRun.provider]]), config: { generalFolder: cwd } });
  const home = bridge.home;
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const phone = await TestClient.open(bridge);
  let live: unknown;
  let forked: string;
  try {
    const session = (await phone.call("session.create", { profile: "claude", cwd })).session_id;
    const start = phone.frames.length;
    await phone.call("prompt.submit", { session_id: session, text: "Rename log, rewrite notes.", profile: "claude" });
    const threads = () => firstRun.queries.filter((query: FakeQuery) => query.options.persistSession !== false);
    await until(() => threads().length === 1);
    const result = { type: "result", subtype: "success", is_error: false, num_turns: 3, result: "Done.", usage: { input_tokens: 30, output_tokens: 12 }, session_id: session, uuid: "uuid-result" };
    const entries: Entry[] = [{ kind: "send", at: 0 }, ...[...editTurn(cwd, session, true), result].map((message): Entry => ({ kind: "message", at: 0, message }))];
    await playEntries(threads()[0], entries);
    live = (await phone.from(start, (frame) => isEvent(frame, "message.complete", session))).params.payload.turn_diff;
    assert.deepEqual(counts(live), liveCounts);

    // Claude's stored session, as its index lists it: the same messages without their structured results.
    const opened = { type: "user", uuid: "uuid-opened", session_id: session, message: { role: "user", content: "Rename log, rewrite notes." }, parent_tool_use_id: null };
    shared.stored.set(session, { title: "Rename log", messages: [opened, ...editTurn(cwd, session, false)] });
    shared.sessions.push({ sessionId: session, cwd, lastModified: Date.now(), summary: "Rename log", customTitle: "Rename log" });
    forked = (await phone.call("session.adopt", { profile: "claude", session_id: session, mode: "fork" })).session_id;
    assert.notEqual(forked, session);
    const resumed = await phone.call("session.resume", { session_id: forked, profile: "claude", inline_images: false });
    assert.deepEqual(resumed.messages.at(-1).turn_diff, live);
  } finally {
    await phone.close();
    await bridge.close();
  }

  const again = await startTestBridge({ home, keepHome: true, providers: new Map([["claude", fakeClaude({ files: shared }).provider]]) });
  const client = await TestClient.open(again);
  try {
    const read = await client.call("session.resume", { session_id: forked, profile: "claude", inline_images: false });
    assert.deepEqual(read.messages.at(-1).turn_diff, live);
  } finally {
    await client.close();
    await again.close();
  }
});
