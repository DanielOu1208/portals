import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { parseModelValue } from "../src/gateway/methods.ts";
import { childEnvironment, claudeEffort, permissionModeFor, queryOptions, threadModeFor } from "../src/providers/claude/options.ts";
import { permissionRequest, permissionResult } from "../src/providers/claude/permissions.ts";
import { addedDiff, approvalCommand, gatewayResult, gatewayTool, unifiedDiff } from "../src/providers/claude/tools.ts";
import { imageType, userMessage } from "../src/providers/claude/session.ts";
import { threadModes, type RequestAnswer } from "../src/providers/types.ts";
import { withFiles } from "../src/sessions/files.ts";
import { fixture } from "./claude-fixtures.ts";

// Claude's permission prompts as the app's cards and back, and the small mappings
// around them: modes, thinking levels, the app's model strings, tool names, images.

const cwd = "/tmp/aeriportal-cwd";
const bashRule: PermissionUpdate[] = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }];

test("a command asks with once, session, always and deny when Claude suggests a lasting rule", () => {
  const request = permissionRequest("Bash", { command: "npm test", description: "Run the tests" }, bashRule, cwd);
  // Claude is told a note given with a no as the no's reason.
  assert.deepEqual(request, { kind: "approval", command: "npm test", description: "Claude wants to run a command", choices: ["once", "session", "always", "deny"], takesNote: true });
  // Without suggestions there is nothing to remember: once or deny.
  assert.deepEqual((permissionRequest("Bash", { command: "ls" }, undefined, cwd) as { choices: string[] }).choices, ["once", "deny"]);
});

test("the recorded Write prompt: an edit card with the file and its diff, no always (the suggestion is for the session)", () => {
  const prompt = fixture("approval").find((entry) => entry.kind === "permission")!;
  const request = permissionRequest(prompt.tool!, prompt.input!, prompt.options!.suggestions, cwd);
  assert.deepEqual(request, {
    kind: "approval",
    command: "Edit /tmp/aeriportal-cwd/note.txt\n--- a/note.txt\n+++ b/note.txt\n+note\n",
    description: "Claude wants to change a file",
    choices: ["once", "session", "deny"],
    takesNote: true,
  });
});

test("approval answers become Claude's permission results", () => {
  const input = { command: "npm test" };
  assert.deepEqual(permissionResult("Bash", input, bashRule, { kind: "approval", choice: "once" }), { behavior: "allow", updatedInput: input });
  assert.deepEqual(permissionResult("Bash", input, bashRule, { kind: "approval", choice: "session" }), {
    behavior: "allow",
    updatedInput: input,
    updatedPermissions: [{ ...bashRule[0], destination: "session" }],
  });
  assert.deepEqual(permissionResult("Bash", input, bashRule, { kind: "approval", choice: "always" }), { behavior: "allow", updatedInput: input, updatedPermissions: bashRule });
  assert.deepEqual(permissionResult("Bash", input, bashRule, { kind: "approval", choice: "deny" }), { behavior: "deny", message: "Denied from Portals." });
  assert.deepEqual(permissionResult("Bash", input, bashRule, { kind: "approval", choice: "deny", note: "Run npm run lint first." }), {
    behavior: "deny",
    message: "Denied from Portals. The user wants this instead: Run npm run lint first.",
  });
  assert.equal(permissionResult("Bash", input, bashRule, { kind: "withdrawn", reason: "interrupted" }).behavior, "deny");
});

test("AskUserQuestion is a clarify card; answers go back keyed by question text, a cancel is a deny", () => {
  const prompt = fixture("clarify").find((entry) => entry.kind === "permission")!;
  const request = permissionRequest(prompt.tool!, prompt.input!, undefined, cwd);
  assert.deepEqual(request, {
    kind: "clarify",
    questions: [
      {
        qid: "q0",
        question: "Which language do you prefer?",
        choices: ["Python", "Swift"],
        multiSelect: false,
        header: "Language",
        descriptions: { Python: "Python as your preferred language", Swift: "Swift as your preferred language" },
      },
    ],
  });
  // Exactly what Claude was given in the recording, after which it answered "Swift."
  assert.deepEqual(permissionResult(prompt.tool!, prompt.input!, undefined, { kind: "clarify", answers: { q0: "Swift" } }), prompt.answer);
  // Free text is passed on as typed; a multi-select answer arrives joined already.
  const many = { questions: [{ question: "Which?", header: "x", options: [{ label: "A" }, { label: "B" }], multiSelect: true }, { question: "Why?", options: [] }] };
  assert.deepEqual(permissionResult("AskUserQuestion", many, undefined, { kind: "clarify", answers: { q0: "A, B", q1: "Because" } }), {
    behavior: "allow",
    updatedInput: { ...many, answers: { "Which?": "A, B", "Why?": "Because" } },
  });
  assert.equal(permissionResult("AskUserQuestion", many, undefined, { kind: "clarify", answers: null }).behavior, "deny");
  assert.equal(permissionResult("AskUserQuestion", many, undefined, { kind: "clarify", answers: { q0: null, q1: null } }).behavior, "deny");
});

test("ExitPlanMode is an approval whose text is the plan", () => {
  const prompt = fixture("plan").find((entry) => entry.kind === "permission" && entry.tool === "ExitPlanMode")!;
  const request = permissionRequest("ExitPlanMode", prompt.input!, undefined, cwd);
  assert.equal(request.kind, "approval");
  assert.match((request as { command: string }).command, /^# Plan: create plan\.txt\n/);
  assert.equal((request as { description: string }).description, "Claude has a plan");
  assert.deepEqual((request as { choices: string[] }).choices, ["once", "deny"]);
  assert.deepEqual(permissionResult("ExitPlanMode", prompt.input!, undefined, { kind: "approval", choice: "once" }), prompt.answer);
  assert.equal(permissionResult("ExitPlanMode", prompt.input!, undefined, { kind: "approval", choice: "deny" }).behavior, "deny");
});

test("other tools' cards say what they would do in one line", () => {
  assert.equal(approvalCommand("WebFetch", { url: "https://example.com", prompt: "x" }, cwd), "Fetch https://example.com");
  assert.equal(approvalCommand("mcp__notes__add", { title: "Groceries" }, cwd), 'mcp__notes__add {"title":"Groceries"}');
  assert.match(approvalCommand("Edit", { file_path: "/tmp/aeriportal-cwd/a.txt", old_string: "x\ny", new_string: "z" }, cwd), /^Edit \/tmp\/aeriportal-cwd\/a\.txt\n--- a\/a\.txt\n\+\+\+ b\/a\.txt\n-x\n-y\n\+z\n$/);
});

test("/mode words map onto Claude's permission modes and back; medium is Claude's auto mode", () => {
  assert.deepEqual(threadModes.map((mode) => permissionModeFor(mode)), ["default", "acceptEdits", "auto", "plan", "bypassPermissions", null]);
  for (const mode of ["ask", "edits", "medium", "plan", "full"] as const) assert.equal(threadModeFor(permissionModeFor(mode)), mode);
  // Claude's mode that denies what is not allowed already, without asking, has no word.
  assert.equal(threadModeFor("dontAsk"), null);
});

test("the app's thinking levels go to the nearest Claude has", () => {
  assert.deepEqual(
    ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", ""].map(claudeEffort),
    ["low", "low", "low", "medium", "high", "xhigh", "max", "max", null],
  );
});

test("the app's model strings are read like Hermes's /model", () => {
  assert.deepEqual(parseModelValue("sonnet --provider anthropic --session"), { model: "sonnet", provider: "anthropic" });
  assert.deepEqual(parseModelValue("  haiku --session "), { model: "haiku", provider: undefined });
  assert.deepEqual(parseModelValue("claude-opus-4-8"), { model: "claude-opus-4-8", provider: undefined });
  assert.throws(() => parseModelValue("--session"), /Name a model/);
  assert.throws(() => parseModelValue("opus --global"), /only changes the model of one thread/);
});

test("the child's environment leaves out Claude Code's own variables and any inherited key", () => {
  const env = childEnvironment(
    { PATH: "/usr/bin", HOME: "/Users/dev", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "x", CLAUDECODE: "1", CLAUDE_EFFORT: "high", ANTHROPIC_API_KEY: "sk-env" },
    { clientApp: "portals-bridge/0.1.0", apiKey: null },
  );
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/Users/dev", CLAUDE_AGENT_SDK_CLIENT_APP: "portals-bridge/0.1.0" });
  assert.equal(childEnvironment({}, { clientApp: "a", apiKey: "sk-config" }).ANTHROPIC_API_KEY, "sk-config");
  // Claude Code summarises each run of its calls only when the bridge says (claude.toolSummaries);
  // one inherited from a terminal is dropped like the rest of Claude Code's own.
  assert.equal(childEnvironment({ CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES: "1" }, { clientApp: "a", apiKey: null }).CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES, undefined);
  assert.equal(childEnvironment({}, { clientApp: "a", apiKey: null, toolSummaries: true }).CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES, "1");
});

test("a token from claude setup-token reaches the child only from config.json, and an API key there is used over it", () => {
  // One in the bridge's own environment is dropped, as before.
  assert.equal(childEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-env" }, { clientApp: "a", apiKey: null }).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(childEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-env" }, { clientApp: "a", apiKey: null, oauthToken: "sk-ant-oat01-config" }).CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-config");
  const both = childEnvironment({}, { clientApp: "a", apiKey: "sk-config", oauthToken: "sk-ant-oat01-config" });
  assert.deepEqual([both.ANTHROPIC_API_KEY, both.CLAUDE_CODE_OAUTH_TOKEN], ["sk-config", undefined]);
});

test("query options: Dana's settings, partial messages, summarized thinking, and resume or a chosen id", () => {
  const canUseTool = async () => ({ behavior: "deny" as const, message: "no" });
  const fresh = queryOptions({ claudePath: "/c", cwd, env: {}, sessionId: "id-1", model: "default", permissionMode: null, effort: null, adaptiveThinking: true, title: "T", canUseTool });
  assert.deepEqual(fresh.settingSources, ["user", "project", "local"]);
  assert.equal(fresh.allowDangerouslySkipPermissions, true);
  assert.equal(fresh.includePartialMessages, true);
  assert.deepEqual(fresh.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(fresh.sessionId, "id-1");
  assert.equal(fresh.resume, undefined);
  assert.equal(fresh.model, undefined);
  assert.equal(fresh.permissionMode, undefined);
  assert.equal(fresh.title, "T");
  const resumed = queryOptions({ claudePath: "/c", cwd, env: {}, resume: "id-1", model: "haiku", permissionMode: "acceptEdits", effort: "low", adaptiveThinking: false, canUseTool });
  assert.equal(resumed.resume, "id-1");
  assert.equal(resumed.sessionId, undefined);
  assert.equal(resumed.model, "haiku");
  assert.equal(resumed.permissionMode, "acceptEdits");
  assert.equal(resumed.effort, "low");
  assert.equal(resumed.thinking, undefined);
});

test("tools: names the app styles, args it labels by, and diffs", () => {
  assert.deepEqual(gatewayTool("Grep", { pattern: "TODO", path: "/src", glob: "*.ts" }), { name: "search_files", args: { pattern: "TODO", glob: "*.ts", in: "/src" } });
  assert.deepEqual(gatewayTool("WebSearch", { query: "swift" }), { name: "web_search", args: { query: "swift" } });
  assert.deepEqual(gatewayTool("Agent", { description: "Find the bug", prompt: "Look at…", subagent_type: "Explore" }), {
    name: "delegate_task",
    args: { task: "Look at…", agent: "Explore" },
    context: "Find the bug",
  });
  assert.deepEqual(gatewayTool("TodoWrite", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] }).context, "1 of 2 done");
  assert.deepEqual(gatewayTool("mcp__notes__add", { title: "x" }), { name: "mcp__notes__add", args: { title: "x" } });
  assert.deepEqual(gatewayResult("Bash", { command: "false" }, { content: "Exit code 1\nboom", isError: true }, cwd), { output: "Exit code 1\nboom", exit_code: 1 });
  assert.deepEqual(gatewayResult("TodoWrite", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }] }, { content: "ok", isError: false }, cwd), {
    output: "✓ a\n→ b",
  });
  assert.equal(
    unifiedDiff("/tmp/aeriportal-cwd/src/a.ts", [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [" x", "-y", "+y2", "+y3"] }], cwd),
    "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,2 +3,3 @@\n x\n-y\n+y2\n+y3\n",
  );
  assert.equal(addedDiff("/elsewhere/b.txt", "one\ntwo\n", cwd, true), "--- /dev/null\n+++ b//elsewhere/b.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n");
});

test("images go to Claude as base64 blocks before the text, typed by their bytes", () => {
  const png = Buffer.from("89504e470d0a1a0a0000", "hex");
  const jpeg = Buffer.from("ffd8ffe000", "hex");
  const heic = Buffer.from("000000186674797068656963", "hex");
  assert.equal(imageType(png), "image/png");
  assert.equal(imageType(jpeg), "image/jpeg");
  assert.equal(imageType(heic), null);
  const { message, skipped } = userMessage(
    {
      text: "What is this?",
      images: [
        { filename: "a.png", data: png },
        { filename: "b.jpg", data: jpeg },
        { filename: "c.heic", data: heic },
      ],
    },
    "00000000-0000-4000-8000-000000000000",
  );
  assert.equal(skipped, 1);
  assert.equal(message.uuid, "00000000-0000-4000-8000-000000000000");
  assert.deepEqual(message.message.content, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
    { type: "text", text: "What is this?" },
  ]);
  assert.equal(userMessage({ text: "plain", images: [] }, "u").message.message.content, "plain");
  // A command alone is Claude Code's; with files or images it is words, which a space
  // before it keeps Claude Code from running (it reads a slash in content blocks too).
  assert.equal(userMessage({ text: "/cost", images: [] }, "u").message.message.content, "/cost");
  const files = withFiles("/cost of these", ["/w/.portals/files/t/notes.txt"]);
  assert.equal(userMessage({ text: files, images: [], files: ["/w/.portals/files/t/notes.txt"] }, "u").message.message.content, ` ${files}`);
  assert.deepEqual(userMessage({ text: "/cost of this", images: [{ filename: "a.png", data: png }] }, "u").message.message.content.at(-1), { type: "text", text: " /cost of this" });
});

test("a plan: Start leaves plan mode for the mode given, Keep planning passes the note on", () => {
  const approve: RequestAnswer = { kind: "approval", choice: "once" };
  assert.deepEqual(permissionResult("ExitPlanMode", { plan: "Do it." }, undefined, approve, "bypassPermissions"), {
    behavior: "allow",
    updatedInput: { plan: "Do it." },
    updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
  });
  // With no mode to go to, Claude picks (it goes back to asking).
  assert.deepEqual(permissionResult("ExitPlanMode", { plan: "Do it." }, undefined, approve), { behavior: "allow", updatedInput: { plan: "Do it." } });
  const keepPlanning: RequestAnswer = { kind: "approval", choice: "deny", note: "Use SQLite, not files." };
  assert.deepEqual(permissionResult("ExitPlanMode", { plan: "Do it." }, undefined, keepPlanning, "bypassPermissions"), {
    behavior: "deny",
    message: "The plan was not approved in Portals. Keep planning, and change this: Use SQLite, not files.",
  });
});
