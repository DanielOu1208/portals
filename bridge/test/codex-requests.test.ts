import "./environment.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexEffort, collaborationMode, desktopDefaults, policyFor, settledDefaults, threadModeFor } from "../src/providers/codex/options.ts";
import { approvalRequest, approvalResponse, clarifyRequest, clarifyResponse, planRequest, requestKey, responseFor } from "../src/providers/codex/requests.ts";
import { changeDiff, displayCommand, gatewayResult, gatewayTool } from "../src/providers/codex/tools.ts";
import { titleFrom } from "../src/providers/titles.ts";
import { fixture, fixtureCwd } from "./codex-fixtures.ts";

// Codex's requests as the app's cards and back, `/mode` as Codex's policies, the
// thinking levels, and how work items look as rows. The request params are the ones
// recorded from Codex (test/fixtures/codex).

function recordedRequest(name: string, method: string, index = 0): any {
  return fixture(name).filter((entry) => entry.kind === "request" && entry.method === method)[index].params;
}

test("a command approval offers once, always (Codex's own rule) and deny, and deny declines without stopping the turn", () => {
  const params = recordedRequest("tools", "item/commandExecution/requestApproval");
  const request = approvalRequest("item/commandExecution/requestApproval", params, fixtureCwd, undefined);
  // Codex offered accept, the rule and cancel: no "for this thread".
  assert.deepEqual(request, { kind: "approval", command: "cat hello.txt", description: "Codex wants to run a command", choices: ["once", "always", "deny"] });
  assert.deepEqual(approvalResponse("item/commandExecution/requestApproval", params, "once"), { decision: "accept" });
  assert.deepEqual(approvalResponse("item/commandExecution/requestApproval", params, "always"), {
    decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["cat", "hello.txt"] } },
  });
  assert.deepEqual(approvalResponse("item/commandExecution/requestApproval", params, "deny"), { decision: "decline" });
});

test("without a list of decisions every choice is offered, always only with a proposed rule", () => {
  const bare = { threadId: "t", turnId: "u", itemId: "i", command: "/bin/zsh -lc 'rm -rf build'", reason: "Needs to delete the build folder" };
  assert.deepEqual(approvalRequest("item/commandExecution/requestApproval", bare, "/w", undefined), {
    kind: "approval",
    command: "rm -rf build",
    description: "Needs to delete the build folder",
    choices: ["once", "session", "deny"],
  });
  const withRule = { ...bare, proposedExecpolicyAmendment: ["rm", "-rf"] };
  const offered = approvalRequest("item/commandExecution/requestApproval", withRule, "/w", undefined);
  assert.deepEqual(offered.kind === "approval" ? offered.choices : [], ["once", "session", "always", "deny"]);
  assert.deepEqual(approvalResponse("item/commandExecution/requestApproval", withRule, "session"), { decision: "acceptForSession" });
  assert.deepEqual(approvalResponse("item/commandExecution/requestApproval", withRule, "always"), { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm", "-rf"] } } });
});

test("a file change approval reads Edit <path> and the diff, and never offers always", () => {
  const params = recordedRequest("tools", "item/fileChange/requestApproval");
  const item = fixture("tools").find((entry) => entry.method === "item/started" && entry.params.item.id === params.itemId)!.params.item;
  const request = approvalRequest("item/fileChange/requestApproval", params, fixtureCwd, item.changes);
  assert.deepEqual(request, {
    kind: "approval",
    command: `Edit ${fixtureCwd}/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n`,
    description: "Codex wants to change a file",
    choices: ["once", "session", "deny"],
  });
  assert.deepEqual(approvalResponse("item/fileChange/requestApproval", params, "session"), { decision: "acceptForSession" });
  assert.deepEqual(approvalResponse("item/fileChange/requestApproval", params, "always"), { decision: "accept" });
  const added = recordedRequest("approval", "item/fileChange/requestApproval");
  const note = fixture("approval").find((entry) => entry.method === "item/started" && entry.params.item.id === added.itemId)!.params.item;
  const write = approvalRequest("item/fileChange/requestApproval", { ...added, grantRoot: "/w" }, fixtureCwd, note.changes);
  assert.deepEqual(write.kind === "approval" ? [write.command, write.description] : [], [
    `Edit ${fixtureCwd}/note.txt\n--- /dev/null\n+++ b/note.txt\n@@ -0,0 +1 @@\n+note\n`,
    "Codex wants to change a file (and to write anywhere in /w for the rest of the thread)",
  ]);
});

test("an MCP tool Codex asks about is an approval card offering what its persist allows, answered as Codex reads an elicitation's answer", () => {
  const method = "mcpServer/elicitation/request";
  // As Codex 0.166 asks in /mode ask.
  const params = {
    threadId: "t", turnId: "u", serverName: "scratch", mode: "form",
    _meta: {
      codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_description: "Says the text back in capitals.",
      tool_params: { text: "hi" }, tool_params_display: [{ name: "text", value: "hi", display_name: "text" }],
    },
    message: 'Allow the scratch MCP server to run tool "shout"?',
    requestedSchema: { type: "object", properties: {} },
  };
  assert.deepEqual(approvalRequest(method, params, "/w", undefined), {
    kind: "approval",
    command: 'scratch {"text":"hi"}',
    description: 'Allow the scratch MCP server to run tool "shout"?',
    choices: ["once", "session", "always", "deny"],
  });
  assert.deepEqual(approvalResponse(method, params, "once"), { action: "accept", content: null, _meta: null });
  assert.deepEqual(approvalResponse(method, params, "session"), { action: "accept", content: null, _meta: { persist: "session" } });
  assert.deepEqual(approvalResponse(method, params, "always"), { action: "accept", content: null, _meta: { persist: "always" } });
  assert.deepEqual(approvalResponse(method, params, "deny"), { action: "decline", content: null, _meta: null });
  // One remembered for the thread only, named by the tool, with no arguments.
  const named = { ...params, _meta: { codex_approval_kind: "mcp_tool_call", persist: "session", tool_name: "shout", tool_params: {} } };
  const card = approvalRequest(method, named, "/w", undefined);
  assert.deepEqual(card.kind === "approval" ? [card.command, card.choices] : [], ["scratch/shout", ["once", "session", "deny"]]);
  // Stop cancels it; a sub-agent's taken back as the turn ended is a no.
  assert.deepEqual(responseFor(method, params, { kind: "withdrawn", reason: "interrupted" }), { action: "cancel", content: null, _meta: null });
  assert.deepEqual(responseFor(method, params, { kind: "withdrawn", reason: "withdrawn" }, true), { action: "decline", content: null, _meta: null });
  assert.equal(responseFor(method, params, { kind: "withdrawn", reason: "withdrawn" }), null);
  assert.equal(requestKey(method, params), 'mcpServer/elicitation/request|t|u|scratch||Allow the scratch MCP server to run tool "shout"?|{"text":"hi"}');
  // A sub-agent's, or another tool's, with the same turn id and arguments is another request.
  assert.notEqual(requestKey(method, { ...params, threadId: "child" }), requestKey(method, params));
  assert.notEqual(requestKey(method, named), requestKey(method, { ...named, _meta: { ...named._meta, tool_name: "whisper" } }));
});

test("requestUserInput is a clarify card, answered by question id; dismissing it answers nothing", () => {
  const params = recordedRequest("clarify", "item/tool/requestUserInput");
  assert.deepEqual(clarifyRequest(params), {
    kind: "clarify",
    questions: [
      {
        qid: "preferred_language",
        question: "Which language do you prefer?",
        choices: ["Python", "Swift"],
        multiSelect: false,
        header: "Language",
        descriptions: { Python: "Choose Python.", Swift: "Choose Swift." },
      },
    ],
  });
  assert.deepEqual(clarifyResponse(params, { preferred_language: "Swift" }), { answers: { preferred_language: { answers: ["Swift"] } } });
  assert.deepEqual(clarifyResponse(params, { preferred_language: null }), { answers: {} });
  assert.deepEqual(clarifyResponse(params, null), { answers: {} });
  // What was recorded is what the bridge sends.
  const recorded = fixture("clarify").find((entry) => entry.kind === "answer")!.result;
  assert.deepEqual(clarifyResponse(params, { preferred_language: "Swift" }), recorded);
});

test("a request withdrawn by an interrupt is cancelled; one the turn's end withdrew needs no answer", () => {
  assert.deepEqual(responseFor("item/commandExecution/requestApproval", {}, { kind: "withdrawn", reason: "interrupted" }), { decision: "cancel" });
  assert.deepEqual(responseFor("item/tool/requestUserInput", {}, { kind: "withdrawn", reason: "interrupted" }), { answers: {} });
  assert.equal(responseFor("item/fileChange/requestApproval", {}, { kind: "withdrawn", reason: "withdrawn" }), null);
  // A sub-agent's, taken back as the turn of the thread it works for ended, is a no: it works on and waits.
  assert.deepEqual(responseFor("item/fileChange/requestApproval", {}, { kind: "withdrawn", reason: "withdrawn" }, true), { decision: "decline" });
  assert.deepEqual(responseFor("item/tool/requestUserInput", {}, { kind: "withdrawn", reason: "withdrawn" }, true), { answers: {} });
  assert.deepEqual(responseFor("item/commandExecution/requestApproval", {}, { kind: "withdrawn", reason: "interrupted" }, true), { decision: "cancel" });
  assert.deepEqual(responseFor("item/fileChange/requestApproval", {}, { kind: "approval", choice: "deny" }), { decision: "decline" });
  assert.equal(requestKey("item/fileChange/requestApproval", { itemId: "exec-1" }), "item/fileChange/requestApproval|exec-1|");
});

test("/mode as Codex's approval policy and sandbox; default is config.toml's", () => {
  const defaults = desktopDefaults({ model: "gpt-6.1-sol", model_reasoning_effort: "high", approval_policy: "never", sandbox_mode: "danger-full-access" });
  assert.deepEqual(policyFor("ask", defaults), {
    approvalPolicy: "untrusted",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  });
  assert.deepEqual(policyFor("edits", defaults)?.approvalPolicy, "on-request");
  assert.deepEqual(policyFor("edits", defaults)?.sandboxPolicy.type, "workspaceWrite");
  assert.deepEqual(policyFor("full", defaults), { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
  assert.deepEqual(policyFor("default", defaults), { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
  // Not known: nothing is overridden.
  assert.equal(policyFor("default", null), null);
  assert.equal(threadModeFor(defaults.approvalPolicy, defaults.sandbox), "full");
  assert.equal(threadModeFor("untrusted", "workspace-write"), "ask");
  assert.equal(threadModeFor("on-request", "danger-full-access"), null);
  // Reading only is no /mode of its own: plan mode is Codex's plan mode now.
  assert.equal(threadModeFor("on-request", "read-only"), null);
  assert.equal(defaults.summary, null);
  // Network access in workspace-write comes from config.toml.
  const online = desktopDefaults({ sandbox_workspace_write: { network_access: true } });
  assert.equal((policyFor("ask", online)?.sandboxPolicy as { networkAccess: boolean }).networkAccess, true);
});

test("/mode default where config.toml sets no approval policy or sandbox is what Codex does for the folder, not nothing", () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "portals-codex-trust-")));
  try {
    const trusted = join(folder, "trusted");
    const untrusted = join(folder, "untrusted");
    const other = join(folder, "other");
    const worktree = join(folder, "worktree");
    for (const path of [join(trusted, ".git"), join(trusted, "app"), untrusted, other, worktree]) mkdirSync(path, { recursive: true });
    // A worktree of the trusted repository counts as the repository.
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(trusted, ".git", "worktrees", "worktree")}\n`);
    const defaults = desktopDefaults({ projects: { [trusted]: { trust_level: "trusted" }, [untrusted]: { trust_level: "untrusted" } } });
    const workspace = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    // As Codex 0.162.1 gave threads started in such folders with nothing in config.toml.
    assert.deepEqual(policyFor("default", defaults, trusted), { approvalPolicy: "on-request", sandboxPolicy: workspace });
    assert.deepEqual(policyFor("default", defaults, join(trusted, "app")), { approvalPolicy: "on-request", sandboxPolicy: workspace });
    assert.deepEqual(policyFor("default", defaults, worktree), { approvalPolicy: "on-request", sandboxPolicy: workspace });
    assert.deepEqual(policyFor("default", defaults, untrusted), { approvalPolicy: "untrusted", sandboxPolicy: workspace });
    assert.deepEqual(policyFor("default", defaults, other), { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } });
    // What config.toml does set stands, the active profile's first.
    const half = desktopDefaults({ sandbox_mode: "danger-full-access", profile: "work", profiles: { work: { approval_policy: "never" } } });
    assert.deepEqual(policyFor("default", half, other), { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    assert.deepEqual(settledDefaults(defaults, trusted), { approvalPolicy: "on-request", sandbox: "workspace-write" });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("workspace-write is as config.toml's [sandbox_workspace_write] sets it up: the other folders it may write, and /tmp and $TMPDIR left out", () => {
  const table = { writable_roots: ["/Users/dev/out", "~/cache", "relative"], network_access: true, exclude_slash_tmp: true, exclude_tmpdir_env_var: true };
  const workspace = { type: "workspaceWrite", writableRoots: ["/Users/dev/out", join(homedir(), "cache")], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  const defaults = desktopDefaults({ sandbox_workspace_write: table, projects: { "/Users/dev/app": { trust_level: "trusted" } } });
  assert.deepEqual(policyFor("edits", defaults)?.sandboxPolicy, workspace);
  assert.deepEqual(policyFor("ask", defaults)?.sandboxPolicy, workspace);
  // Where config.toml sets no policy, as Codex runs a thread of a trusted project.
  assert.deepEqual(policyFor("default", defaults, "/Users/dev/app"), { approvalPolicy: "on-request", sandboxPolicy: workspace });
});

test("a plan of Codex's plan mode is a plan card whose no's note the session sends itself, in plan mode", () => {
  assert.deepEqual(planRequest("  1. Do it.\n", "edits"), {
    kind: "approval",
    command: "1. Do it.",
    description: "Codex has a plan",
    choices: ["once", "deny"],
    plan: { startsIn: "edits" },
    // Not handed to the thread as a message of the user's as well (feature approval_notes).
    takesNote: true,
  });
});

test("Codex's plan mode as a collaboration mode, with the model and level the turn runs with", () => {
  assert.deepEqual(collaborationMode("plan", "gpt-6-luna", "low"), { mode: "plan", settings: { model: "gpt-6-luna", reasoning_effort: "low", developer_instructions: null } });
  assert.deepEqual(collaborationMode("default", "gpt-6-luna", null).settings.reasoning_effort, null);
});

test("the app's thinking levels as one the model has: itself, else the next one up, else its strongest", () => {
  const sol = ["low", "medium", "high", "xhigh", "max", "ultra"];
  assert.equal(codexEffort("high", sol), "high");
  assert.equal(codexEffort("none", sol), "low");
  assert.equal(codexEffort("minimal", sol), "low");
  assert.equal(codexEffort("ultra", ["low", "medium", "high", "xhigh", "max"]), "max");
  assert.equal(codexEffort("", sol), null);
  // Levels not known yet go as they are.
  assert.equal(codexEffort("medium", []), "medium");
});

test("commands show without Codex's login-shell wrapper", () => {
  assert.equal(displayCommand("/bin/zsh -lc 'touch done.txt'"), "touch done.txt");
  assert.equal(displayCommand("/bin/zsh -lc ls"), "ls");
  assert.equal(displayCommand(`bash -c 'echo '"'"'hi'"'"''`), "echo 'hi'");
  assert.equal(displayCommand(`/bin/zsh -lc "echo \\"a b\\""`), 'echo "a b"');
  // Anything else is shown as it is.
  assert.equal(displayCommand("/bin/zsh -lc 'unterminated"), "/bin/zsh -lc 'unterminated");
  assert.equal(displayCommand("python3 -c 'print(1)'"), "python3 -c 'print(1)'");
  assert.equal(displayCommand(`/bin/zsh -lc "echo $HOME"`), `/bin/zsh -lc "echo $HOME"`);
});

test("each kind of change is a unified diff with headers", () => {
  assert.equal(changeDiff({ path: "/w/a.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-x\n+y\n" }, "/w"), "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n");
  assert.equal(changeDiff({ path: "/w/a.txt", kind: { type: "update", move_path: "/w/b.txt" }, diff: "@@ -1 +1 @@\n-x\n+y" }, "/w"), "--- a/a.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-x\n+y\n");
  assert.equal(changeDiff({ path: "/w/new.txt", kind: { type: "add" }, diff: "one\ntwo\n" }, "/w"), "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  assert.equal(changeDiff({ path: "/w/old.txt", kind: { type: "delete" }, diff: "gone\n" }, "/w"), "--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n");
  // Paths outside the folder keep their place; /tmp and /private/tmp are the same folder.
  assert.equal(changeDiff({ path: "/etc/hosts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" }, "/w").split("\n")[0], "--- a//etc/hosts");
  assert.equal(changeDiff({ path: "/tmp/w/a.txt", kind: { type: "add" }, diff: "x\n" }, "/private/tmp/w").split("\n")[1], "+++ b/a.txt");
});

test("other work items are rows too: MCP tools keep their name, web searches and agents get the app's", () => {
  assert.deepEqual(gatewayTool({ type: "mcpToolCall", id: "m", server: "docs", tool: "search", arguments: { query: "x" }, status: "completed" }), { name: "search", args: { query: "x" }, context: "docs" });
  assert.deepEqual(gatewayResult({ type: "mcpToolCall", id: "m", status: "completed", result: { content: [{ type: "text", text: "found" }], structuredContent: null }, error: null }, "/w"), { output: "found" });
  assert.deepEqual(gatewayResult({ type: "mcpToolCall", id: "m", status: "failed", result: null, error: { message: "timed out" } }, "/w"), { error: "timed out" });
  assert.deepEqual(gatewayTool({ type: "webSearch", id: "w", query: "swift testing", action: { type: "search", query: "swift testing" }, results: null }), { name: "web_search", args: { query: "swift testing" } });
  assert.deepEqual(gatewayTool({ type: "webSearch", id: "w", query: "", action: { type: "open_page", url: "https://example.com" }, results: null }), { name: "web_extract", args: { url: "https://example.com" } });
  assert.deepEqual(gatewayTool({ type: "collabAgentToolCall", id: "c", tool: "spawnAgent", prompt: "Review it", model: "gpt-6-luna" })?.name, "delegate_task");
  assert.equal(gatewayTool({ type: "agentMessage", id: "a", text: "hi" }), null);
  assert.deepEqual(gatewayResult({ type: "commandExecution", id: "c", status: "failed", aggregatedOutput: "no such file\n", exitCode: 1 }, "/w"), { output: "no such file\n", exit_code: 1 });
});

test("a new thread's title is its first message's first line, cut short", () => {
  assert.equal(titleFrom("Fix the build\nIt fails on CI."), "Fix the build");
  assert.equal(titleFrom("\n\n  Hello  "), "Hello");
  assert.equal(titleFrom("@image:shot.png"), null);
  assert.equal(titleFrom("x".repeat(100))?.length, 80);
  // A message sent through Portals is titled by what it says.
  assert.equal(titleFrom("[Portals: from Aeri (thread aeri)]\nFix the build"), "Fix the build");
});
