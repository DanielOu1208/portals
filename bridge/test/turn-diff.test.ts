import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { gatewayResult as acpResult, gatewayTool as acpTool, type ToolCall as AcpToolCall } from "../src/providers/acp/tools.ts";
import { gatewayResult as claudeResult } from "../src/providers/claude/tools.ts";
import { gatewayResult as droidResult, gatewayTool as droidTool } from "../src/providers/droid/tools.ts";
import type { StoredMessage } from "../src/providers/types.ts";
import { editDiffOf, piecesOf, turnDiff, turnDiffCap, withTurnDiffs } from "../src/sessions/turnDiff.ts";
import { createThread, runTurn, startTestBridge, TestClient } from "./helpers.ts";

// What a turn changed, as one diff (feature turn_diff): the diffs its edits carry, joined
// per file, with lines added and removed; kept with the turn's last stored message.

let at = 0;
function user(text: string): StoredMessage {
  return { role: "user", text, timestamp: (at += 1) };
}
function said(text: string): StoredMessage {
  return { role: "assistant", text, timestamp: (at += 1) };
}
function edit(diff: string, result: Record<string, unknown> = { success: true }): StoredMessage {
  return { role: "tool", name: "patch", args: {}, content: JSON.stringify({ ...result, diff }), tool_call_id: `t${at}`, timestamp: (at += 1) };
}
function lines(...all: string[]): string {
  return all.join("\n") + "\n";
}

const appEdit = lines("--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1,3 +1,4 @@", " a", "-b", "+B", "+B2", " c");
const appAgain = lines("--- a/src/app.ts", "+++ b/src/app.ts", "@@ -9 +10 @@", "-x", "+y");
const added = lines("--- /dev/null", "+++ b/notes.md", "@@ -0,0 +1,2 @@", "+one", "+two");
const deleted = lines("--- a/old.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-gone", "-too");

test("a turn's edits are joined per file in the order made, with each file's lines added and removed and the turn's", () => {
  const changed = turnDiff([user("Go"), edit(appEdit), edit(added), said("Now the rest."), edit(deleted), edit(appAgain), said("Done.")]);
  assert.deepEqual(
    changed?.files.map(({ path, status, added, removed }) => ({ path, status, added, removed })),
    [
      { path: "src/app.ts", status: "modified", added: 3, removed: 2 },
      { path: "notes.md", status: "added", added: 2, removed: 0 },
      { path: "old.ts", status: "deleted", added: 0, removed: 2 },
    ],
  );
  assert.equal(changed?.added, 5);
  assert.equal(changed?.removed, 4);
  assert.equal(changed?.cut, undefined);
  assert.equal(changed?.files[0].diff, lines("--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1,3 +1,4 @@", " a", "-b", "+B", "+B2", " c", "@@ -9 +10 @@", "-x", "+y"));
  assert.equal(changed?.files[1].diff, added);
  assert.equal(changed?.files[2].diff, deleted);
});

test("an edit denied, failed or with no diff changes nothing; a turn that changed no file has none", () => {
  assert.equal(turnDiff([user("Go"), edit(appEdit, { status: "blocked" }), edit(appEdit, { success: false }), said("No.")]), undefined);
  assert.equal(turnDiff([user("Go"), { role: "tool", name: "terminal", args: {}, content: '{"output":"a diff of nothing","exit_code":0}', tool_call_id: "t", timestamp: 1 }]), undefined);
  // Hermes's inline diff, where its result has none.
  const hermes: StoredMessage = {
    role: "tool",
    name: "patch",
    args: {},
    content: '{"success": true}',
    tool_call_id: "h",
    timestamp: 1,
    display_metadata: { tool_result_metadata: { inline_diff: lines("--- a//tmp/x/hello.txt", "+++ b//tmp/x/hello.txt", "@@ -1 +1 @@", "-hi", "+hello") } },
  };
  assert.equal(editDiffOf(hermes)?.startsWith("--- a//tmp"), true);
  assert.equal(turnDiff([hermes])?.files[0].path, "/tmp/x/hello.txt");
});

test("a removed line that reads like a file's header stays in its hunk, and git's own header lines are skipped", () => {
  const sql = lines("diff --git a/q.sql b/q.sql", "index 1234567..89abcde 100644", "--- a/q.sql", "+++ b/q.sql", "@@ -1,2 +1,1 @@", "--- a comment", "+++ not a header", "-select 1;");
  const pieces = piecesOf(sql);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].before, "q.sql");
  assert.deepEqual([pieces[0].added, pieces[0].removed], [1, 2]);
});

test("edits without line numbers are kept apart in the file's diff", () => {
  const first = lines("--- a/f.txt", "+++ b/f.txt", "-hi", "+hello");
  const second = lines("--- a/f.txt", "+++ b/f.txt", "-bye", "+goodbye");
  assert.equal(turnDiff([edit(first), edit(second)])?.files[0].diff, lines("--- a/f.txt", "+++ b/f.txt", "-hi", "+hello", "@@", "-bye", "+goodbye"));
});

test("past about 512 KB a file's diff is cut at a line's end and the files after it have none, their counts whole", () => {
  const long = Array.from({ length: 20_000 }, (_, index) => `+line ${index} ${"x".repeat(20)}`);
  const big = lines("--- /dev/null", "+++ b/big.txt", "@@ -0,0 +1,20000 @@", ...long);
  const changed = turnDiff([edit(big), edit(added)]);
  assert.equal(changed?.cut, true);
  const [first, second] = changed!.files;
  assert.equal(first.cut, true);
  assert.equal(first.added, 20_000);
  assert.ok(first.diff.length <= turnDiffCap && first.diff.length > turnDiffCap - 100);
  assert.ok(first.diff.endsWith("\n"));
  assert.deepEqual({ ...second, diff: second.diff }, { path: "notes.md", status: "added", added: 2, removed: 0, diff: "", cut: true });
});

test("each stored turn's last message says what that turn changed, a running one's nothing yet", () => {
  const messages = [said("Hello."), user("One"), edit(appEdit), said("Done."), user("Two"), said("Nothing to change."), user("Three"), edit(added), said("Done.")];
  messages[5].turn_diff = { files: [], added: 0, removed: 0 }; // stale, from before
  withTurnDiffs(messages);
  assert.deepEqual(messages.map((message) => message.turn_diff?.files.map((file) => file.path)), [
    undefined,
    undefined,
    undefined,
    ["src/app.ts"],
    undefined,
    undefined,
    undefined,
    undefined,
    ["notes.md"],
  ]);
  // The last turn still runs: it has none until it ends.
  withTurnDiffs(messages, 0, 6);
  assert.equal(messages[8].turn_diff, undefined);
  assert.deepEqual(messages[3].turn_diff?.files.map((file) => file.path), ["src/app.ts"]);
});

test("the fake agent's turn that changes four files ends saying so, and its last stored message says it after a restart", async (t) => {
  let bridge = await startTestBridge({ keepHome: true });
  t.after(() => rmSync(bridge.home, { recursive: true, force: true }));
  let client = await TestClient.open(bridge);
  const session = await createThread(client);
  await runTurn(client, session, "hello");
  const events = await runTurn(client, session, "diff please");
  const complete = events.at(-1)!;
  assert.equal(complete.type, "message.complete");
  const changed = complete.payload.turn_diff;
  assert.deepEqual(
    changed.files.map((file: Record<string, unknown>) => [file.path, file.status, file.added, file.removed]),
    [
      ["src/app.ts", "modified", 3, 2],
      ["README.md", "modified", 1, 1],
      ["notes/todo.md", "added", 4, 0],
      ["old-server.ts", "deleted", 0, 3],
    ],
  );
  assert.deepEqual([changed.added, changed.removed], [8, 6]);
  let messages = (await client.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(messages.at(-1).turn_diff, changed);
  // The turn before changed nothing.
  assert.equal(messages.filter((message: Record<string, unknown>) => message.turn_diff).length, 1);

  await client.close();
  const home = bridge.home;
  await bridge.dispose();
  bridge = await startTestBridge({ home, keepHome: true });
  t.after(() => bridge.dispose());
  client = await TestClient.open(bridge);
  t.after(() => client.close());
  messages = (await client.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(messages.at(-1).turn_diff, changed);
});

test("an edit without line numbers shows the lines its old and new text share as unchanged, and counts only what changed", () => {
  // As Claude Code's history gives an Edit: its old and new text, whole.
  const quoted = lines("--- a/notes.md", "+++ b/notes.md", "-Nothing yet.", "+Nothing yet.", "+", "+Now hello.");
  const docstring = lines("--- a/greet.py", "+++ b/greet.py", "-def greet(name):", '+def greet(name):', '+    """Say hello."""', "-x", "+y");
  const changed = turnDiff([edit(quoted), edit(docstring)]);
  assert.deepEqual(changed?.files.map((file) => [file.path, file.added, file.removed]), [["notes.md", 2, 0], ["greet.py", 2, 1]]);
  assert.equal(changed?.files[0].diff, lines("--- a/notes.md", "+++ b/notes.md", " Nothing yet.", "+", "+Now hello."));
  assert.equal(changed?.files[1].diff, lines("--- a/greet.py", "+++ b/greet.py", " def greet(name):", '+    """Say hello."""', "-x", "+y"));
});

test("an edit of very many short lines is counted whole, with or without line numbers, never thrown away", () => {
  // 200,000 lines of "+a": a spread of them would pass the engine's limit on arguments.
  const many = Array.from({ length: 200_000 }, () => "+a").join("\n") + "\n";
  const numbered = turnDiff([edit(lines("--- /dev/null", "+++ b/many.txt", "@@ -0,0 +1,200000 @@") + many)]);
  assert.equal(numbered?.files[0].added, 200_000);
  const bare = turnDiff([edit(lines("--- a/bare.txt", "+++ b/bare.txt", "-a") + many)]);
  assert.deepEqual([bare?.files[0].added, bare?.files[0].removed], [199_999, 0]);
});

test("Claude's structured Write of 150,000 short lines reaches the turn diff with its counts whole", () => {
  const count = 150_000;
  const result = claudeResult("Write", { file_path: "/w/many.txt", content: "a\n".repeat(count) }, {
    content: "The file has been updated successfully.",
    isError: false,
    structured: {
      type: "update",
      structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: count, lines: Array.from({ length: count }, () => "+a") }],
    },
  }, "/w") as { diff: string };
  const changed = turnDiff([edit(result.diff)]);
  assert.deepEqual(changed?.files.map((file) => [file.path, file.added, file.removed]), [["many.txt", count, 0]]);
  assert.equal(changed?.cut, undefined);
  assert.ok(result.diff.endsWith("+a\n"));
});

test("an ACP replacement of 150,000 lines reaches the turn diff cut to the existing limit with its counts whole", () => {
  const count = 150_000;
  const call: AcpToolCall = {
    toolCallId: "many-replaced", kind: "edit", status: "completed",
    diffs: [{ path: "/w/many.txt", oldText: "before\n".repeat(count), newText: "after\n".repeat(count) }],
  };
  const result = acpResult(call, acpTool(call), "/w") as { diff: string };
  const changed = turnDiff([edit(result.diff)]);
  assert.deepEqual(changed?.files.map((file) => [file.path, file.added, file.removed, file.cut]), [["many.txt", count, count, true]]);
  assert.ok(result.diff.length < 45_000);
});

test("an ACP edit before 150,000 unchanged suffix lines counts just the first-line replacement", () => {
  const suffix = "same\n".repeat(150_000);
  const call: AcpToolCall = {
    toolCallId: "many-unchanged", kind: "edit", status: "completed",
    diffs: [{ path: "/w/many.txt", oldText: `before\n${suffix}`, newText: `after\n${suffix}` }],
  };
  const result = acpResult(call, acpTool(call), "/w") as { diff: string };
  const changed = turnDiff([edit(result.diff)]);
  assert.deepEqual(changed?.files.map((file) => [file.path, file.added, file.removed]), [["many.txt", 1, 1]]);
  assert.equal(changed?.cut, undefined);
  assert.equal(result.diff, lines("--- a/many.txt", "+++ b/many.txt", "@@ -1,4 +1,4 @@", "-before", "+after", " same", " same", " same"));
});

test("Hermes's inline diffs, drawn for a terminal in colours under 'review diff', are read as unified ones", () => {
  // As Hermes's chat-tools fixture has them: a write_file, then a patch of the same file.
  const hermes = (inline: string): StoredMessage => ({
    role: "tool",
    name: "patch",
    args: {},
    content: "ok",
    tool_call_id: `h${at}`,
    timestamp: (at += 1),
    display_metadata: { tool_result_metadata: { inline_diff: inline } },
  } as StoredMessage);
  const write = "  ┊ review diff\n\u001b[38;2;218;165;32ma//tmp/aeriportal-cwd/hello.txt → b//tmp/aeriportal-cwd/hello.txt\u001b[0m\n\u001b[38;2;139;134;130m@@ -0,0 +1 @@\u001b[0m\n\u001b[38;2;255;255;255;48;2;19;87;20m+hi\u001b[0m";
  const patch = "  ┊ review diff\n\u001b[38;2;218;165;32ma//tmp/aeriportal-cwd/hello.txt → b//tmp/aeriportal-cwd/hello.txt\u001b[0m\n\u001b[38;2;139;134;130m@@ -1 +1 @@\u001b[0m\n\u001b[38;2;255;255;255;48;2;119;20;20m-hi\u001b[0m\n\u001b[38;2;255;255;255;48;2;19;87;20m+hello\u001b[0m";
  const changed = turnDiff([hermes(write), hermes(patch)]);
  assert.deepEqual(changed?.files.map((file) => [file.path, file.added, file.removed]), [["/tmp/aeriportal-cwd/hello.txt", 2, 1]]);
  assert.deepEqual([changed?.added, changed?.removed], [2, 1]);
  assert.ok(!changed?.files[0].diff.includes("\u001b"));
});

test("an ACP agent's edit of a long new file and a short one: both files, the long one cut, its counts whole", () => {
  const big = Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join("\n") + "\n";
  const call: AcpToolCall = { toolCallId: "c1", kind: "edit", status: "completed", diffs: [{ path: "/w/big.txt", oldText: null, newText: big }, { path: "/w/small.txt", oldText: "a\n", newText: "b\n" }] } as AcpToolCall;
  const result = acpResult(call, acpTool(call), "/w") as { diff: string };
  assert.ok(result.diff.length < 45_000);
  const changed = turnDiff([edit(result.diff)]);
  assert.deepEqual(changed?.files.map((file) => [file.path, file.status, file.added, file.removed, file.cut ?? false]), [
    ["big.txt", "added", 10_000, 0, true],
    ["small.txt", "modified", 1, 1, false],
  ]);
  assert.equal(changed?.cut, true);
  assert.deepEqual([changed?.added, changed?.removed], [10_001, 1]);
});

test("Droid's ApplyPatch edits count in the turn's diff: a file added, one updated, one deleted", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: /w/new.md",
    "+one",
    "+two",
    "*** Update File: /w/app.ts",
    "@@ function main() {",
    " const a = 1;",
    "-console.log(a);",
    "+console.log(a + 1);",
    "+return a;",
    "*** Delete File: /w/old.ts",
    "*** End Patch",
  ].join("\n");
  const result = droidResult(droidTool("ApplyPatch", { patch }), "Applied", false, "/elsewhere") as { diff?: string };
  const changed = turnDiff([edit(result.diff ?? "")]);
  assert.deepEqual(changed?.files.map((file) => [file.path, file.status, file.added, file.removed]), [
    ["/w/new.md", "added", 2, 0],
    ["/w/app.ts", "modified", 2, 1],
    ["/w/old.ts", "deleted", 0, 0],
  ]);
});

test("Droid's Edit and Create count as Claude's do: shared quoted lines unchanged, a Create added, paths in the thread's folder relative, outside ones whole", () => {
  const before = "function a() {\n  return 1;\n}\n";
  const after = "function a() {\n  return 2;\n}\n";
  const changed = (result: unknown) => turnDiff([edit((result as { diff: string }).diff)])?.files.map((file) => [file.path, file.status, file.added, file.removed]);
  const droidEdit = droidResult(droidTool("Edit", { file_path: "/w/src/a.ts", old_str: before, new_str: after }), "updated", false, "/w");
  assert.deepEqual(changed(droidEdit), [["src/a.ts", "modified", 1, 1]]);
  const claudeEdit = claudeResult("Edit", { file_path: "/w/src/a.ts", old_string: before, new_string: after }, { content: "ok", isError: false }, "/w");
  assert.deepEqual(changed(droidEdit), changed(claudeEdit));

  const create = droidResult(droidTool("Create", { file_path: "/w/src/b.ts", content: "export const b = 1;\nexport const c = 2;\n" }), "created", false, "/w");
  assert.deepEqual(changed(create), [["src/b.ts", "added", 2, 0]]);
  assert.equal((create as { diff: string }).diff, lines("--- /dev/null", "+++ b/src/b.ts", "@@ -0,0 +1,2 @@", "+export const b = 1;", "+export const c = 2;"));

  // Outside the thread's folder: whole, with its leading "/" (a//etc/hosts).
  const outside = droidResult(droidTool("Edit", { file_path: "/etc/hosts", old_str: "a\n", new_str: "b\n" }), "updated", false, "/w");
  assert.equal((outside as { diff: string }).diff, lines("--- a//etc/hosts", "+++ b//etc/hosts", "-a", "+b"));
  assert.deepEqual(changed(outside), [["/etc/hosts", "modified", 1, 1]]);

  // An Edit and an ApplyPatch of the same file in one turn name it alike: one file.
  const patch = ["*** Begin Patch", "*** Update File: /w/src/a.ts", "@@", "-}", "+} // end", "*** End Patch"].join("\n");
  const applied = droidResult(droidTool("ApplyPatch", { patch }), "Applied", false, "/w") as { diff: string };
  assert.deepEqual(turnDiff([edit((droidEdit as { diff: string }).diff), edit(applied.diff)])?.files.map((file) => [file.path, file.added, file.removed]), [["src/a.ts", 2, 2]]);
  const moved = ["*** Begin Patch", "*** Update File: /w/src/a.ts", "*** Move to: /w/src/c.ts", "@@", "-x", "+y", "*** End Patch"].join("\n");
  const renamed = droidResult(droidTool("ApplyPatch", { patch: moved }), "Applied", false, "/w") as { diff: string };
  assert.deepEqual(renamed.diff.split("\n").slice(0, 3), ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/c.ts"]);
});

test("round 2: a Droid chunk changing lines that read like headers, Hermes context saying 'review diff', and a whole ACP write all count", () => {
  // Droid: `-- old comment` replaced with `++ new comment`, then a second file.
  const patch = ["*** Begin Patch", "*** Update File: /w/a.sql", "@@", "--- old comment", "+++ new comment", " select 1;", "*** Update File: /w/b.sql", "-x", "+y", "*** End Patch"].join("\n");
  const droid = droidResult(droidTool("ApplyPatch", { patch }), "Applied", false, "/elsewhere") as { diff: string };
  assert.deepEqual(turnDiff([edit(droid.diff)])?.files.map((file) => [file.path, file.added, file.removed]), [["/w/a.sql", 1, 1], ["/w/b.sql", 1, 1]]);

  // Hermes: a context line of the file that says "review diff" stays, and the file after it is its own.
  const inline = ["  ┊ review diff", "a/a.txt → b/a.txt", "@@ -1,3 +1,3 @@", " review diff", "-x", "+y", " end", "a/b.txt → b/b.txt", "@@ -1 +1 @@", "-p", "+q"].join("\n");
  const hermes = { role: "tool", name: "patch", args: {}, content: "ok", tool_call_id: "h-r2", timestamp: (at += 1), display_metadata: { tool_result_metadata: { inline_diff: inline } } } as StoredMessage;
  assert.deepEqual(turnDiff([hermes])?.files.map((file) => [file.path, file.added, file.removed]), [["a.txt", 1, 1], ["b.txt", 1, 1]]);

  // ACP: a whole file written, its content given without diffs: every line counts.
  const content = Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join("\n") + "\n";
  const call = { toolCallId: "w1", kind: "edit", status: "completed", rawInput: { content }, locations: [{ path: "/w/big.txt" }] } as unknown as AcpToolCall;
  const written = acpResult(call, acpTool(call), "/w") as { diff: string };
  const big = turnDiff([edit(written.diff)])?.files[0];
  assert.deepEqual([big?.added, big?.cut], [10_000, true]);
});

test("round 3: a Droid chunk ending in lines that read like headers, before the end or another chunk, and a long added file", () => {
  for (const after of [[], ["@@ later", " x", "-y", "+z"]]) {
    const patch = ["*** Begin Patch", "*** Update File: /w/a.sql", "@@", " select 1;", "--- old comment", "+++ new comment", ...after, "*** End Patch"].join("\n");
    const droid = droidResult(droidTool("ApplyPatch", { patch }), "Applied", false, "/elsewhere") as { diff: string };
    const files = turnDiff([edit(droid.diff)])?.files.map((file) => [file.path, file.added, file.removed]);
    assert.deepEqual(files, [["/w/a.sql", after.length ? 2 : 1, after.length ? 2 : 1]], JSON.stringify(after));
  }
  const long = ["*** Begin Patch", "*** Add File: /w/long.txt"].join("\n") + "\n" + Array.from({ length: 150_000 }, () => "+a").join("\n") + "\n*** End Patch";
  const added = droidResult(droidTool("ApplyPatch", { patch: long }), "Applied", false, "/elsewhere") as { diff: string };
  assert.equal(turnDiff([edit(added.diff)])?.files[0].added, 150_000);
});

test("an edit's old and new text alone that both read like headers ('-- old', '++ new') is one file's change", () => {
  const changed = turnDiff([edit(lines("--- a/opts", "+++ b/opts", "--- old option", "+++ new option", " keep"))]);
  assert.deepEqual(changed?.files.map((file) => [file.path, file.added, file.removed]), [["opts", 1, 1]]);
  assert.equal(changed?.files[0].diff, lines("--- a/opts", "+++ b/opts", "--- old option", "+++ new option", " keep"));
});

test("a file with no hunk (a rename alone) followed by another file's header: two files", () => {
  const changed = turnDiff([edit(lines("--- a/old.ts", "+++ b/new.ts", "--- a/b.ts", "+++ b/b.ts", "@@ -1 +1 @@", "-x", "+y"))]);
  assert.deepEqual(changed?.files.map((file) => [file.path, file.added, file.removed]), [["b.ts", 1, 1]]);
});
