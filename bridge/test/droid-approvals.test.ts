import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PickOptionsRequestParamsSchema, RequestPermissionRequestParamsSchema, ToolConfirmationOutcome, type RequestPermissionRequestParams } from "@factory/droid-sdk/node";
import { approvalDetails, approvalOptions } from "../src/providers/droid/approvals.ts";
import { DroidHandoff } from "../src/providers/droid/handoff.ts";
import { DroidPermissions } from "../src/providers/droid/permissions.ts";
import { askUser, pickOptions, requestPermission } from "../src/providers/droid/requests.ts";
import type { AgentRequest, RequestAnswer, SessionSink } from "../src/providers/types.ts";

function permission(details: object = { type: "exit_spec_mode", plan: "Do one thing.", title: "Plan" }): RequestPermissionRequestParams {
  return RequestPermissionRequestParamsSchema.parse({
    toolUses: [{ toolUse: { type: "tool_use", id: "plan-call", name: "ExitSpecMode", input: { authentication: "SECRET" } },
      confirmationType: "exit_spec_mode", details }],
    options: Object.values(ToolConfirmationOutcome).map((value) => ({ value, label: `CLI ${value}` })),
  });
}

function sink(answer: RequestAnswer, inspect?: (request: AgentRequest) => void): SessionSink {
  return { emit() {}, async ask(request) { inspect?.(request); return answer; } };
}

test("Droid's questions keep line breaks in custom answers; pick lists still accept only their offered rows", async () => {
  const text = "First line\nSecond line\n\nFourth line";
  const params = { toolCallId: "ask", questions: [{ index: 1, topic: "Plan", question: "What should change?", options: ["Small", "Large"] }] };
  assert.deepEqual(await askUser(params, sink({ kind: "clarify", answers: { "1": text } }), new AbortController().signal), {
    answers: [{ index: 1, question: "What should change?", answer: text }],
  });
  const pick = PickOptionsRequestParamsSchema.parse({ toolCallId: "pick", title: "Pick", multi: false, preselectedIds: [], rows: [{ id: "a", label: "A" }] });
  assert.deepEqual(await pickOptions(pick, sink({ kind: "clarify", answers: { pick: text } }), new AbortController().signal), { cancelled: true, selectedIds: [] });
});

test("every offered approval outcome keeps its SDK identity and honest scope; broader grants require confirmation", () => {
  const options = approvalOptions(permission());
  assert.deepEqual(options.map((o) => o.id), Object.values(ToolConfirmationOutcome));
  for (const option of options) {
    assert.equal(option.label, `CLI ${option.id}`);
    assert.ok(option.description);
    assert.ok(option.effects.length);
    assert.equal(option.requiresConfirmation === true,
      option.effects.some((e) => ["settings", "new_session", "external"].includes(e.scope)), option.id);
  }
  assert.match(options.find((o) => o.id === "proceed_auto_run_medium")!.description, /medium/);
  const generic = options.find((o) => o.id === "proceed_auto_run")!;
  assert.match(generic.description, /CLI proceed_auto_run/);
  assert.doesNotMatch(generic.description, /low|medium|high/);
  assert.deepEqual(options.find((o) => o.id === "proceed_report_false_positive")!.effects.map((e) => e.scope), ["once", "external"]);
  const unknown = permission();
  unknown.options.push({ value: "future_outcome" as ToolConfirmationOutcome, label: "Unknown" });
  assert.ok(!approvalOptions(unknown).some((o) => o.id === "future_outcome"));
});

test("MCP and path grants distinguish exact file, directory, named tools, and whole-server persistence", () => {
  const edit = approvalOptions(permission({ type: "edit", filePath: "/project/src/a.ts", fileName: "a.ts", oldContent: "a", newContent: "b" }));
  assert.match(edit.find((o) => o.id === "proceed_always")!.description, /directory.*\/project\/src/);
  assert.match(edit.find((o) => o.id === "proceed_always_file")!.description, /exact file path: \/project\/src\/a.ts, not its parent/);
  const mcp = approvalOptions(permission({ type: "mcp_tool", toolName: "mcp__docs__search", actualToolName: "search", serverName: "docs", impactLevel: "read" }));
  assert.match(mcp.find((o) => o.id === "proceed_always_tools")!.description, /named MCP tools.*docs\/search/);
  assert.match(mcp.find((o) => o.id === "proceed_always_server")!.description, /all tools.*docs/);
});

test("rich approval details whitelist safe fields and carry real unified diffs", () => {
  const p = permission({ type: "edit", filePath: "/project/a.ts", fileName: "a.ts", oldContent: "same\nold\n", newContent: "same\nnew\n" });
  assert.deepEqual(approvalDetails(p, "/project"), [{
    toolId: "plan-call", name: "ExitSpecMode", type: "edit", path: "/project/a.ts",
    diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n same\n-old\n+new\n",
  }]);
  const created = approvalDetails(permission({ type: "create", filePath: "/project/b.ts", fileName: "b.ts", content: "new\n" }), "/project")[0];
  assert.match(created.diff!, /^--- \/dev\/null\n\+\+\+ b\/b.ts\n@@ -0,0 \+1 @@\n\+new\n$/);
  const shield = approvalDetails(permission({ type: "droid_shield_violation", command: "echo safe", reason: "A security finding" }), "/project")[0];
  assert.deepEqual(shield.findings, [{ title: "Droid Shield", message: "A security finding" }]);
  assert.ok(!JSON.stringify([created, shield, ...approvalDetails(p, "/project")]).includes("SECRET"));
});

test("rich permission answers return exact SDK options, edited Markdown, and notes", async () => {
  for (const option of Object.values(ToolConfirmationOutcome)) {
    const selected: string[] = [];
    const response = await requestPermission(permission(), sink({ kind: "approval.option", option, editedPlan: "Revised plan\n", note: "User note" }),
      new AbortController().signal, "ask", (value) => selected.push(value));
    assert.deepEqual(response, { selectedOption: option, comment: "User note", ...(option === "proceed_edit" ? { editedSpecContent: "Revised plan\n" } : {}) });
    assert.deepEqual(selected, ["cancel", "proceed_edit"].includes(option) ? [] : [option]);
  }
});

test("missing edits and unknown or unoffered rich answers never approve", async () => {
  for (const answer of [
    { kind: "approval.option", option: "proceed_edit" },
    { kind: "approval.option", option: "proceed_edit", editedPlan: " \n" },
    { kind: "approval.option", option: "unknown" },
  ] satisfies RequestAnswer[]) {
    assert.deepEqual(await requestPermission(permission(), sink(answer), new AbortController().signal, "ask", () => assert.fail("not approved")),
      { selectedOption: "cancel" });
  }
  const p = permission();
  p.options = p.options.filter((o) => o.value === "cancel");
  assert.deepEqual(await requestPermission(p, sink({ kind: "approval.option", option: "proceed_once" }), new AbortController().signal, "ask", () => assert.fail("not offered")),
    { selectedOption: "cancel" });
});

test("permission_resolved matches tool-use IDs, withdraws once, and cannot approve a stale answer", async () => {
  let cardSignal: AbortSignal | undefined;
  let answer!: (answer: RequestAnswer) => void;
  const selections: string[] = [];
  const cards = new DroidPermissions({ emit() {}, ask(_request, signal) {
    cardSignal = signal;
    return new Promise((resolve) => { answer = resolve; });
  } }, (_params, outcome) => selections.push(outcome));
  const waiting = cards.ask(permission(), new AbortController().signal, "ask", "/project");
  cards.notification({ type: "permission_resolved", toolUseIds: ["other"], selectedOption: "proceed_once" });
  assert.equal(cardSignal?.aborted, false);
  const resolved = { type: "permission_resolved", toolUseIds: ["plan-call"], selectedOption: "proceed_auto_run_low" };
  cards.notification(resolved);
  cards.notification(resolved);
  assert.equal(cardSignal?.reason, "resolved");
  answer({ kind: "approval.option", option: "proceed_new_session_high" });
  assert.deepEqual(await waiting, { selectedOption: "cancel" });
  assert.deepEqual(selections, ["proceed_auto_run_low"]);
});

test("Spec handoff requires the approved tool ID and a successor root envelope, ignoring Task children", () => {
  const h = new DroidHandoff("source");
  h.expect(permission());
  const user = (sessionId: string, extra = {}) => ({ sessionId, notification: { type: "create_message",
    message: { id: "root-user", role: "user", parentId: "root", ...extra } } });
  assert.equal(h.observe(user("unproved")), null);
  assert.equal(h.observe({ sessionId: "source", notification: { type: "tool_result", toolUseId: "wrong", content: '{"approved":true,"handoff":{"isNewSession":true}}' } }), null);
  assert.equal(h.observe(user("still-unproved")), null);
  h.observe({ sessionId: "source", notification: { type: "child_session_available", childSessionId: "child" } });
  h.observe({ sessionId: "source", notification: { type: "tool_result", toolUseId: "plan-call", content: '{"approved":true,"handoff":{"isNewSession":true}}' } });
  assert.equal(h.observe(user("source")), null);
  assert.equal(h.observe(user("child")), null);
  assert.equal(h.observe(user("bad-role", { role: "assistant" })), null);
  assert.equal(h.observe(user("non-root", { parentId: "another" })), null);
  assert.equal(h.observe(user("target")), "target");
  assert.equal(h.observe(user("another-target")), null);
  assert.equal(h.target, "target");
});

/** Droid asking leave for a Script (CLI 0.250's `script` confirmation): each call it makes, with that call's own confirmation. */
function scriptPermission(): RequestPermissionRequestParams {
  return RequestPermissionRequestParamsSchema.parse({
    toolUses: [{ toolUse: { type: "tool_use", id: "script-call", name: "Script", input: { code: "await Execute({ command: 'ls' })" } },
      confirmationType: "script", details: { type: "script", impactLevel: "medium", calls: [
        { toolName: "Execute", line: 1, column: 7, toolInput: { command: "ls" },
          confirmation: { type: "exec", fullCommand: "ls", command: "ls", impactLevel: "low" } },
        { toolName: "Edit", line: 2, column: 7, toolInput: { file_path: "/project/src/a.ts" },
          confirmation: { type: "edit", filePath: "/project/src/a.ts", fileName: "a.ts", oldContent: "old\n", newContent: "new\n" } },
      ] } }],
    options: [ToolConfirmationOutcome.ProceedOnce, ToolConfirmationOutcome.ProceedAlways, ToolConfirmationOutcome.Cancel].map((value) => ({ value, label: `CLI ${value}` })),
  });
}

test("a Script's approval is the existing card: the Script and its impact, then each call it makes as that call's own approval would show it (n14, SDK 0.10.0)", async () => {
  const p = scriptPermission();
  assert.deepEqual(approvalDetails(p, "/project"), [
    { toolId: "script-call", name: "Script", type: "script", impact: "medium" },
    { toolId: "script-call", name: "Execute", type: "exec", command: "ls" },
    { toolId: "script-call", name: "Edit", type: "edit", path: "/project/src/a.ts", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" },
  ]);
  // A grant to save names what the Script's calls touch, as for a direct call.
  assert.match(approvalOptions(p).find((o) => o.id === "proceed_always")!.description, /directory.*\/project\/src/);
  let asked: AgentRequest | undefined;
  const answer = await requestPermission(p, sink({ kind: "approval", choice: "once" }, (request) => { asked = request; }), new AbortController().signal, "ask", () => {}, "/project");
  assert.equal(answer, ToolConfirmationOutcome.ProceedOnce);
  assert.equal(asked?.kind, "approval");
  if (asked?.kind !== "approval") return;
  assert.match(asked.command, /^ls$/m);
  assert.match(asked.command, /\+new/);
  assert.equal(asked.description, "Droid wants permission for what this Script does");
});

test("a mission recommendation, as Missions, is declined with a notice: Portals does not run Missions", async () => {
  const p = RequestPermissionRequestParamsSchema.parse({
    toolUses: [{ toolUse: { type: "tool_use", id: "mission", name: "RecommendMission", input: {} }, confirmationType: "recommend_mission", details: { type: "recommend_mission", reason: "Large change." } }],
    options: [ToolConfirmationOutcome.ProceedOnce, ToolConfirmationOutcome.Cancel].map((value) => ({ value, label: value })),
  });
  const notices: string[] = [];
  let asked = false;
  const answer = await requestPermission(p, { emit(event) { if (event.type === "notice") notices.push(event.text); }, async ask() { asked = true; return { kind: "approval", choice: "once" }; } },
    new AbortController().signal, "ask", () => {}, "/project");
  assert.equal(answer, ToolConfirmationOutcome.Cancel);
  assert.equal(asked, false);
  assert.deepEqual(notices, ["Droid Missions are not supported in Portals yet."]);
});

test("Droid's pick list (droid.pick_options) is the existing question card with its rows as choices, and the answer goes back as the rows' ids (n14, SDK 0.10.0)", async () => {
  const params = PickOptionsRequestParamsSchema.parse({
    toolCallId: "pick-1", title: "Channels @Droid-Dev has joined", hint: "Invite the bot to see more.", multi: true, preselectedIds: [],
    rows: [{ id: "C1", label: "general" }, { id: "C2", label: "dev, ops", detail: "private" }, { id: "C3", label: "random" }],
  });
  let asked: AgentRequest | undefined;
  // A label holding ", " numbers the choices (the answer joins several picks so).
  const answer = await pickOptions(params, sink({ kind: "clarify", answers: { pick: "2. dev, ops (private), 3. random" } }, (request) => { asked = request; }), new AbortController().signal);
  assert.deepEqual(asked, { kind: "clarify", requiresAllAnswers: true, questions: [{
    qid: "pick", question: "Channels @Droid-Dev has joined\n\nInvite the bot to see more.", choices: ["1. general", "2. dev, ops (private)", "3. random"], multiSelect: true,
  }] });
  assert.deepEqual(answer, { selectedIds: ["C2", "C3"] });
  // Withdrawn, in the person's own words, or with nothing to pick: cancelled, as Droid's own picker is.
  assert.deepEqual(await pickOptions(params, sink({ kind: "withdrawn", reason: "Stopped." }), new AbortController().signal), { cancelled: true, selectedIds: [] });
  assert.deepEqual(await pickOptions(params, sink({ kind: "clarify", answers: { pick: "the second one" } }), new AbortController().signal), { cancelled: true, selectedIds: [] });
  assert.deepEqual(await pickOptions({ ...params, rows: [] }, sink({ kind: "clarify", answers: { pick: "general" } }), new AbortController().signal), { cancelled: true, selectedIds: [] });
  // Labels that cannot be misread stay as they are.
  assert.deepEqual(await pickOptions({ ...params, rows: params.rows.filter((row) => row.id !== "C2") }, sink({ kind: "clarify", answers: { pick: "general, random" } }), new AbortController().signal), { selectedIds: ["C1", "C3"] });
});

test("a pick list whose labels could be read two ways (one holding \", \", or two alike) numbers its choices, so the answer names the rows picked (Codex's review of the SDK move, P2)", async () => {
  const params = PickOptionsRequestParamsSchema.parse({ toolCallId: "pick", title: "Pick", multi: true, preselectedIds: [],
    rows: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "ab", label: "A, B" }] });
  let asked: AgentRequest | undefined;
  assert.deepEqual(await pickOptions(params, sink({ kind: "clarify", answers: { pick: "1. A, 2. B" } }, (request) => { asked = request; }), new AbortController().signal), { selectedIds: ["a", "b"] });
  assert.deepEqual(asked?.kind === "clarify" && asked.questions[0].choices, ["1. A", "2. B", "3. A, B"]);
  const twins = PickOptionsRequestParamsSchema.parse({ ...params, multi: false, rows: [{ id: "x", label: "same" }, { id: "y", label: "same" }] });
  assert.deepEqual(await pickOptions(twins, sink({ kind: "clarify", answers: { pick: "2. same" } }), new AbortController().signal), { selectedIds: ["y"] });
});
