import assert from "node:assert/strict";
import { test } from "./opencode-test.ts";
import { storedMessages } from "../src/providers/opencode/history.ts";
import { majorVersion } from "../src/providers/opencode/options.ts";
import type { Message, PermissionRequest } from "../src/providers/opencode/protocol.ts";
import { approvalOptions, settingsOf } from "../src/providers/opencode/session.ts";
import { approvalCommand, approvalDescription, gatewayResult, gatewayTool, unified } from "../src/providers/opencode/tools.ts";
import { recordedMessages, recording } from "./opencode-serve.ts";

// OpenCode's tool calls, permission requests and stored conversations as the app reads
// them, from what OpenCode 2.2.5 sent (test/fixtures/opencode).

const cwd = "/tmp/oc-spike/project";

function asked(name: string): PermissionRequest {
  return recording(name).find((event) => event.type === "permission.asked")!.data as unknown as PermissionRequest;
}

test("OpenCode's tools become the gateway's, with the args the app's rows read", () => {
  assert.deepEqual(gatewayTool("shell", { command: "ls -la", description: "List files" }), { name: "terminal", args: { command: "ls -la" }, context: "List files" });
  assert.deepEqual(gatewayTool("read", { path: "a.txt" }), { name: "read_file", args: { path: "a.txt" } });
  assert.deepEqual(gatewayTool("write", { path: "a.txt", content: "hi\n" }), { name: "write_file", args: { path: "a.txt", content: "hi\n" } });
  assert.deepEqual(gatewayTool("edit", { filePath: "a.txt", oldString: "hi", newString: "hello" }), { name: "patch", args: { path: "a.txt" } });
  assert.deepEqual(gatewayTool("grep", { pattern: "TODO" }), { name: "search_files", args: { pattern: "TODO" } });
  assert.deepEqual(gatewayTool("webfetch", { url: "https://example.com" }), { name: "web_extract", args: { url: "https://example.com" } });
  assert.deepEqual(gatewayTool("subagent", { prompt: "Look around", agent: "explore", description: "Explore" }), { name: "delegate_task", args: { task: "Look around", agent: "explore" }, context: "Explore" });
  // A tool of the user's own: as OpenCode gave it.
  assert.deepEqual(gatewayTool("jira_lookup", { key: "P-1" }), { name: "jira_lookup", args: { key: "P-1" } });
});

test("results take the shape the app reads, a denied call shown as denied", () => {
  const shell = gatewayTool("shell", { command: "false" });
  assert.deepEqual(gatewayResult("shell", { command: "false" }, shell, { ok: false, error: { type: "tool.failed", message: "" }, content: [{ type: "text", text: "nope" }], metadata: { exit: 1 } }, cwd), { output: "nope", exit_code: 1 });
  assert.deepEqual(gatewayResult("shell", {}, shell, { ok: "stopped" }, cwd), { status: "error", error: "Stopped before it finished." });
  const denied = gatewayResult("write", { path: "a.txt" }, gatewayTool("write", { path: "a.txt" }), { ok: false, error: { type: "permission.rejected", message: "" } }, cwd);
  assert.deepEqual(denied, { status: "blocked", error: "Denied from Portals.", user_summary: "You denied this change — it was not made." });
  const edit = { filePath: `${cwd}/a.txt`, oldString: "hi", newString: "hello" };
  const result = gatewayResult("edit", edit, gatewayTool("edit", edit), { ok: true, content: [] }, cwd) as { success: boolean; diff: string };
  assert.equal(result.success, true);
  assert.match(result.diff, /^--- a\/a\.txt\n\+\+\+ b\/a\.txt\n/m);
  assert.match(result.diff, /-hi\n\+hello/);
  assert.deepEqual(gatewayResult("read", {}, gatewayTool("read", {}), { ok: true, content: [{ type: "text", text: "body" }, { type: "file", uri: "file:///x.png", name: "x.png" }] }, cwd), { content: "body\n[x.png]" });
});

test("OpenCode's patches read as unified diffs", () => {
  const patch = "Index: hello.txt\n===================================================================\n--- hello.txt\n+++ hello.txt\n@@ -0,0 +1,1 @@\n+hi there\n";
  assert.equal(unified(patch), "--- a/hello.txt\n+++ b/hello.txt\n@@ -0,0 +1,1 @@\n+hi there\n");
  // Already so, or a new file: left alone.
  assert.equal(unified("--- a/x\n+++ b/x\n"), "--- a/x\n+++ b/x\n");
  assert.equal(unified("--- /dev/null\n+++ b/x\n"), "--- /dev/null\n+++ b/x\n");
});

test("a permission request is one card: what OpenCode wants to do, and what saying always saves", () => {
  const shell = asked("approval");
  assert.equal(approvalCommand(shell), "echo spike-ok");
  assert.equal(approvalDescription(shell), "OpenCode wants to run this command");
  const options = approvalOptions(shell);
  assert.deepEqual(options.map((option) => option.id), ["once", "always", "reject"]);
  assert.deepEqual(options[1].effects, [{ scope: "settings", text: "Saved in OpenCode for this project: allow shell echo *." }]);
  assert.equal(options[1].requiresConfirmation, true);
  // Nothing to save: no always.
  assert.deepEqual(approvalOptions({ ...shell, save: [] }).map((option) => option.id), ["once", "reject"]);
  assert.match(approvalCommand(asked("edit")), /^Edit hello\.txt\n--- a\/hello\.txt/);
  assert.equal(approvalCommand({ id: "p", sessionID: "s", action: "webfetch", resources: ["https://example.com"] }), "Fetch https://example.com");
  assert.equal(approvalCommand({ id: "p", sessionID: "s", action: "external_directory", resources: ["/etc"] }), "Use files outside the project: /etc");
  assert.equal(approvalCommand({ id: "p", sessionID: "s", action: "doom_scroll", resources: [] }), "doom_scroll");
});

test("a stored conversation reads as the thread showed it, a failed turn with OpenCode's error", () => {
  const stored = storedMessages(recordedMessages(), cwd);
  assert.deepEqual(stored.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
  // OpenCode's times are milliseconds; the gateway's seconds.
  assert.equal(stored[0].timestamp, 1_793_744_740.743);
  const failed: Message[] = [
    { type: "user", id: "m1", text: "Hello?", time: { created: 1000 } },
    { type: "idle", id: "m2", outcome: "failed", error: { type: "provider.invalid-request", message: "Upstream request failed" }, time: { created: 2000 } },
    { type: "compaction", id: "m3", status: "completed", reason: "auto", time: { created: 3000 } },
    { type: "idle", id: "m4", outcome: "interrupted", time: { created: 4000 } },
  ];
  assert.deepEqual(storedMessages(failed, cwd), [
    { role: "user", text: "Hello?", timestamp: 1 },
    { role: "assistant", text: "Upstream request failed", timestamp: 2, display_kind: "failed_turn" },
    { role: "compaction", trigger: "auto", timestamp: 3 },
  ]);
});

test("a session's model is the thread's, OpenCode's default variant no thinking level of its own", () => {
  const given = { model: "x", provider: "y", reasoningEffort: "high" };
  assert.deepEqual(settingsOf(given, { id: "m", providerID: "p", variant: "default" }), { model: "p/m", provider: "p", reasoningEffort: "" });
  assert.deepEqual(settingsOf(given, { id: "m", providerID: "p", variant: "max" }), { model: "p/m", provider: "p", reasoningEffort: "max" });
  assert.deepEqual(settingsOf(given, undefined), { ...given, model: "y/x" });
  assert.equal(majorVersion("2.2.5"), 2);
  assert.equal(majorVersion("1.18.35"), 1);
  assert.equal(majorVersion(null), null);
});
