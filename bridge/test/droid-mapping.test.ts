import "./environment.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  AutonomyLevel, DroidInteractionMode, FactoryDroidMessageSchema, ModelProvider, ReasoningEffort,
  RequestPermissionRequestParamsSchema, ToolConfirmationOutcome, ToolConfirmationType,
  type AskUserRequestParams, type DroidAssistantMessage, type DroidResultMessage,
  type DroidStreamEvent, type ModelInfo, type RequestPermissionRequestParams,
} from "@factory/droid-sdk/node";
import { imageType } from "../src/providers/images.ts";
import { appEffort, modeFor, modelCatalog, policyFor, sdkEffort } from "../src/providers/droid/models.ts";
import { askUser, requestPermission } from "../src/providers/droid/requests.ts";
import { droidEnvironment } from "../src/providers/droid/sdk.ts";
import { DroidStore, type DroidThread } from "../src/providers/droid/store.ts";
import { DroidStream } from "../src/providers/droid/stream.ts";
import { contentText, gatewayResult, gatewayTool } from "../src/providers/droid/tools.ts";
import {
  SettingRefused, type AgentRequest, type ProviderEvent, type RequestAnswer,
  type SessionSink, type StoredMessage,
} from "../src/providers/types.ts";

const defaults = { autonomyLevel: AutonomyLevel.Medium, interactionMode: DroidInteractionMode.Auto };
const model: ModelInfo = {
  id: "example", displayName: "Example model", shortDisplayName: "Example",
  modelProvider: ModelProvider.ANTHROPIC, isCustom: false,
  supportedReasoningEfforts: [ReasoningEffort.Off, ReasoningEffort.Low, ReasoningEffort.High],
  defaultReasoningEffort: ReasoningEffort.Off,
};

function assistant(id: string, text: string, thinking = ""): DroidAssistantMessage {
  return {
    type: "assistant", text,
    message: FactoryDroidMessageSchema.parse({
      id, role: "assistant", createdAt: 1, updatedAt: 1,
      content: [...(thinking ? [{ type: "thinking", thinking, signature: "" }] : []), { type: "text", text }],
    }),
  };
}

function result(text: string): Extract<DroidResultMessage, { subtype: "success" }> {
  return {
    type: "result", subtype: "success", success: true, interrupted: false, error: null,
    sessionId: "sdk-session", durationMs: 1, tokenUsage: null, messages: [], text, turnCount: 1,
  };
}

function streamFixture() {
  const messages: StoredMessage[] = [];
  const events: ProviderEvent[] = [];
  const stream = new DroidStream(messages, (event) => events.push(event), "/w");
  return { messages, events, stream };
}

function answering(answer: RequestAnswer, inspect?: (request: AgentRequest, signal?: AbortSignal) => void): SessionSink {
  return { emit() {}, async ask(request, signal) { inspect?.(request, signal); return answer; } };
}

function permission(
  values = [ToolConfirmationOutcome.ProceedOnce, ToolConfirmationOutcome.Cancel], plan = false,
): RequestPermissionRequestParams {
  return RequestPermissionRequestParamsSchema.parse({
    toolUses: [{
      toolUse: { type: "tool_use", id: "call", name: plan ? "ExitSpecMode" : "Execute", input: {} },
      confirmationType: plan ? ToolConfirmationType.ExitSpecMode : ToolConfirmationType.Execute,
      details: plan
        ? { type: ToolConfirmationType.ExitSpecMode, title: "Migration", plan: "1. Inspect\n2. Update" }
        : { type: ToolConfirmationType.Execute, command: "pwd", fullCommand: "cd /project && pwd" },
    }],
    options: values.map((value) => ({ label: value, value })),
  });
}

const questions: AskUserRequestParams = {
  toolCallId: "ask",
  questions: [
    { index: 7, topic: "Name", question: "What name?", options: [] },
    { index: 2, topic: "Targets", question: "Which targets?", options: ["iOS", "macOS", "Web"], multiSelect: true },
  ],
};

test("Droid assistant text and thinking finals supplement deltas without replaying them", () => {
  const { messages, events, stream } = streamFixture();
  const deltas: DroidStreamEvent[] = [
    { type: "thinking_text_delta", messageId: "a", blockIndex: 0, text: "Consider" },
    { type: "assistant_text_delta", messageId: "a", blockIndex: 1, text: "Hel" },
    { type: "assistant_text_delta", messageId: "a", blockIndex: 1, text: "lo" },
  ];
  deltas.forEach((event) => stream.accept(event));
  stream.accept(assistant("a", "Hello world", "Consider carefully"));
  stream.accept(assistant("a", "Hello world", "Consider carefully"));
  stream.accept(result("Hello world"));
  stream.finish();
  stream.finish();
  assert.deepEqual(events, [
    { type: "reasoning", text: "Consider" }, { type: "text", text: "Hel" },
    { type: "text", text: "lo" }, { type: "text", text: " world" },
    { type: "reasoning", text: " carefully" },
  ]);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { role: "assistant", text: "Hello world", reasoning: "Consider carefully", timestamp: messages[0]!.timestamp });
});

test("Droid full assistant messages work without deltas and remain separate by message id", () => {
  const { messages, events, stream } = streamFixture();
  stream.accept(assistant("a", "First", "One"));
  stream.accept(assistant("b", "Second", "Two"));
  stream.accept(result("FirstSecond"));
  stream.finish();
  assert.deepEqual(events, [
    { type: "text", text: "First" }, { type: "reasoning", text: "One" },
    { type: "text", text: "Second" }, { type: "reasoning", text: "Two" },
  ]);
  assert.deepEqual(messages.map((message) => message.role === "assistant" && [message.text, message.reasoning]), [["First", "One"], ["Second", "Two"]]);
});

test("Droid result-only text is emitted and retained once, including after thinking-only deltas", () => {
  for (const thinking of [false, true]) {
    const { messages, events, stream } = streamFixture();
    if (thinking) stream.accept({ type: "thinking_text_delta", messageId: "a", blockIndex: 0, text: "Thinking" });
    const final = result("Fallback");
    stream.accept(final);
    stream.accept(final);
    stream.finish();
    assert.equal(stream.result, final);
    assert.deepEqual(events.filter((event) => event.type === "text"), [{ type: "text", text: "Fallback" }]);
    assert.equal(messages.filter((message) => message.role === "assistant" && message.text === "Fallback").length, 1);
    if (thinking) assert.ok(messages.some((message) => message.role === "assistant" && message.reasoning === "Thinking"));
  }
});

test("Droid tool start/end rows and saved history use gateway names and arguments", () => {
  const { messages, events, stream } = streamFixture();
  stream.accept(assistant("a", "Checking"));
  const call: DroidStreamEvent = { type: "tool_call", name: "Execute", toolUseId: "cmd", input: { command: "pwd", fireAndForget: true } };
  stream.accept(call);
  stream.accept(call);
  const completed: DroidStreamEvent = {
    type: "tool_result", toolUseId: "cmd", toolName: "Execute", content: "/project\nexit code: 0", isError: false,
  };
  stream.accept(completed);
  stream.accept(completed);
  stream.finish();
  // A background command's id is Droid's with an end of its own, which no other call can have.
  const id = (events[2] as { id: string }).id;
  assert.match(id, /^cmd#bg-[0-9a-f]{8}$/);
  assert.deepEqual(events.slice(1, 3), [
    { type: "commentary", text: "Checking", alreadyStreamed: true },
    { type: "tool.start", id, name: "terminal", args: { command: "pwd", fireAndForget: true } },
  ]);
  const ends = events.filter((event) => event.type === "tool.end");
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0], {
    type: "tool.end", id, name: "terminal", args: { command: "pwd", fireAndForget: true },
    result: { output: "/project\nexit code: 0", exit_code: 0 }, durationSeconds: ends[0]!.durationSeconds,
  });
  assert.ok(ends[0]!.durationSeconds! >= 0);
  const saved = messages.find((message) => message.role === "tool");
  assert.deepEqual(saved, {
    role: "tool", name: "terminal", args: { command: "pwd", fireAndForget: true }, tool_call_id: id,
    timestamp: saved!.timestamp, content: JSON.stringify(ends[0]!.result),
  });
});

test("Droid interrupted streams close pending tools and keep unfinished assistant deltas once", () => {
  const { messages, events, stream } = streamFixture();
  stream.accept({ type: "assistant_text_delta", messageId: "a", blockIndex: 0, text: "Partial" });
  stream.accept({ type: "tool_call", name: "Read", toolUseId: "read", input: { file_path: "/project/a", offset: 2, limit: 4 } });
  stream.accept({ ...result(""), subtype: "interrupted", interrupted: true, success: false });
  stream.finish();
  stream.finish();
  const ends = events.filter((event) => event.type === "tool.end");
  assert.deepEqual(ends, [{
    type: "tool.end", id: "read", name: "read_file", args: { path: "/project/a", offset: 2, limit: 4 },
    result: { success: false, error: "The turn ended before this tool reported a result." },
  }]);
  assert.equal(messages.filter((message) => message.role === "assistant" && message.text === "Partial").length, 1);
  const saved = messages.find((message) => message.role === "tool");
  assert.ok(saved?.role === "tool");
  assert.deepEqual(saved.args, ends[0]!.args);
  assert.deepEqual(JSON.parse(saved.content!), ends[0]!.result);
});

test("Droid file and task tools map actual input fields; unknown tools retain their arguments", () => {
  const cases: [string, Record<string, unknown>, ReturnType<typeof gatewayTool>][] = [
    ["Create", { file_path: "/a", content: "new" }, { name: "write_file", args: { path: "/a", content: "new" } }],
    ["Edit", { file_path: "/a", old_str: "old", new_str: "new" }, { name: "patch", args: { path: "/a", old_string: "old", new_string: "new" } }],
    ["ApplyPatch", { input: "*** patch" }, { name: "patch", args: { patch: "*** patch" } }],
    ["Grep", { pattern: "text", path: "/a", glob_pattern: "*.ts" }, { name: "search_files", args: { pattern: "text", in: "/a", glob: "*.ts" } }],
    ["Task", { prompt: "Inspect", subagent_type: "worker", description: "Review" }, { name: "delegate_task", args: { task: "Inspect", agent: "worker" }, context: "Review" }],
    ["Custom", { nested: { a: 1 } }, { name: "Custom", args: { nested: { a: 1 } } }],
  ];
  for (const [name, input, expected] of cases) assert.deepEqual(gatewayTool(name, input), expected);
});

test("Droid tool results retain text blocks, exit codes, failures and file diffs", () => {
  assert.equal(contentText([{ type: "text", text: "a" }, { type: "image", data: "ignored" }, { type: "text", text: "b" }]), "a\nb");
  assert.deepEqual(gatewayResult(gatewayTool("Execute", { command: "false" }), "Exited with code 7", true, "/w"), { output: "Exited with code 7", exit_code: 7 });
  assert.deepEqual(gatewayResult(gatewayTool("Execute", { command: "false" }), "failed", true, "/w"), { output: "failed", exit_code: 1 });
  assert.deepEqual(gatewayResult(gatewayTool("Read", { file_path: "/a" }), [{ type: "text", text: "contents" }], false, "/w"), { content: "contents" });
  assert.deepEqual(gatewayResult(gatewayTool("Read", { file_path: "/a" }), "denied", true, "/w"), { success: false, error: "denied" });
  assert.deepEqual(gatewayResult(gatewayTool("Edit", { file_path: "a.ts", old_str: "old", new_str: "new" }), "updated", false, "/w"), {
    success: true, output: "updated", diff: "--- a/a.ts\n+++ b/a.ts\n-old\n+new\n",
  });
});

test("Droid keeps once/deny as the legacy fallback and describes exact offered rich grants", async () => {
  const controller = new AbortController();
  let asked = 0;
  let approved = 0;
  const sink = answering({ kind: "approval", choice: "once" }, (request, signal) => {
    asked++;
    assert.equal(signal, controller.signal);
    assert.ok(request.kind === "approval");
    assert.equal(request.command, "cd /project && pwd");
    assert.deepEqual(request.choices, ["once", "deny"]);
    assert.ok(request.options?.some((option) => option.id === "proceed_always" && option.requiresConfirmation));
    assert.ok(!request.options?.some((option) => option.id.startsWith("proceed_new_session")), "replacement only applies to Spec plans");
    assert.deepEqual(request.details, [{ toolId: "call", name: "Execute", type: "exec", command: "cd /project && pwd" }]);
  });
  assert.equal(await requestPermission(permission(Object.values(ToolConfirmationOutcome)), sink, controller.signal, "edits", () => approved++), ToolConfirmationOutcome.ProceedOnce);
  assert.equal(asked, 1);
  assert.equal(approved, 0, "ordinary approval must not exit plan mode");
});

test("Droid does not invent once when only broader permission grants are offered", async () => {
  let approved = 0;
  const sink = answering({ kind: "approval", choice: "once" }, (request) => {
    assert.ok(request.kind === "approval");
    assert.deepEqual(request.choices, ["deny"]);
  });
  assert.deepEqual(await requestPermission(permission([ToolConfirmationOutcome.ProceedAlways, ToolConfirmationOutcome.ProceedNewSession, ToolConfirmationOutcome.Cancel]), sink, new AbortController().signal, "ask", () => approved++), { selectedOption: ToolConfirmationOutcome.Cancel });
  assert.equal(approved, 0);
});

test("Droid permission denial carries the user's note, while withdrawal cancels safely", async () => {
  for (const answer of [
    { kind: "approval", choice: "deny", note: "Keep the existing file" },
    { kind: "withdrawn", reason: "turn ended" },
    { kind: "approval", choice: "always" },
  ] satisfies RequestAnswer[]) {
    const actual = await requestPermission(permission(), answering(answer), new AbortController().signal, "ask", () => assert.fail("not approved"));
    assert.deepEqual(actual, { selectedOption: ToolConfirmationOutcome.Cancel, ...(answer.kind === "approval" && answer.note ? { comment: answer.note } : {}) });
  }
});

test("Droid permissions cancel before asking and refuse requests without safe cancellation", async () => {
  const sink = answering({ kind: "approval", choice: "once" }, () => assert.fail("must not ask"));
  const controller = new AbortController();
  controller.abort("stopped");
  assert.equal(await requestPermission(permission(), sink, controller.signal, "ask", () => assert.fail("not approved")), ToolConfirmationOutcome.Cancel);
  await assert.rejects(requestPermission(permission([ToolConfirmationOutcome.ProceedOnce]), sink, new AbortController().signal, "ask", () => {}), /no safe cancellation/);
});

test("Droid refuses unsupported Mission approvals instead of offering a misleading card", async () => {
  for (const confirmationType of [ToolConfirmationType.ProposeMission, ToolConfirmationType.StartMissionRun]) {
    const params = permission();
    params.toolUses[0]!.confirmationType = confirmationType;
    const notices: ProviderEvent[] = [];
    const sink: SessionSink = {
      emit(event) { notices.push(event); },
      async ask() { assert.fail("Missions must not be approved through a core tool card"); },
    };
    assert.equal(await requestPermission(params, sink, new AbortController().signal, "full", () => assert.fail("not a plan")), ToolConfirmationOutcome.Cancel);
    assert.ok(notices.some((event) => event.type === "notice" && /Missions are not supported/.test(event.text)));
  }
});

test("Droid abort during permission UI cannot approve a stale plan", async () => {
  const controller = new AbortController();
  const sink = answering({ kind: "approval", choice: "once" }, () => controller.abort("withdrawn"));
  assert.deepEqual(await requestPermission(permission(undefined, true), sink, controller.signal, "edits", () => assert.fail("stale plan approved")), { selectedOption: ToolConfirmationOutcome.Cancel });
});

test("Droid plan approval calls back exactly once; plan denial never calls back", async () => {
  for (const choice of ["once", "deny"] as const) {
    let approved = 0;
    let asked = 0;
    const sink = answering({ kind: "approval", choice }, (request) => {
      asked++;
      assert.ok(request.kind === "approval");
      assert.deepEqual(request.plan, { startsIn: "full" });
      assert.equal(request.command, "# Migration\n\n1. Inspect\n2. Update");
      assert.match(request.description!, /plan/);
    });
    const actual = await requestPermission(permission(undefined, true), sink, new AbortController().signal, "full", () => approved++);
    assert.deepEqual(actual, choice === "once" ? ToolConfirmationOutcome.ProceedOnce : { selectedOption: ToolConfirmationOutcome.Cancel });
    assert.equal(asked, 1);
    assert.equal(approved, choice === "once" ? 1 : 0);
  }
});

test("Droid AskUser preserves question indices, free text and multi-select answer strings", async () => {
  const controller = new AbortController();
  const sink = answering({ kind: "clarify", answers: { "2": "iOS, Web", "7": "A free-form name" } }, (request, signal) => {
    assert.equal(signal, controller.signal);
    assert.deepEqual(request, {
      kind: "clarify", requiresAllAnswers: true, questions: [
        { qid: "7", question: "What name?", header: "Name", choices: [], multiSelect: false },
        { qid: "2", question: "Which targets?", header: "Targets", choices: ["iOS", "macOS", "Web"], multiSelect: true },
      ],
    });
  });
  assert.deepEqual(await askUser(questions, sink, controller.signal), {
    answers: [
      { index: 7, question: "What name?", answer: "A free-form name" },
      { index: 2, question: "Which targets?", answer: "iOS, Web" },
    ],
  });
});

test("Droid AskUser cancels only explicit cancellation, withdrawal and wrong-kind answers", async () => {
  const answers: RequestAnswer[] = [
    { kind: "clarify", answers: null },
    { kind: "withdrawn", reason: "stopped" }, { kind: "approval", choice: "once" },
  ];
  for (const answer of answers) {
    assert.deepEqual(await askUser(questions, answering(answer), new AbortController().signal), { cancelled: true, answers: [] });
  }
});

test("Droid AskUser retains partial answers and states which answer was omitted", async () => {
  for (const missing of [undefined, null, "", "  "]) {
    const response = await askUser(questions, answering({ kind: "clarify", answers: { "7": "name", "2": missing ?? null } }), new AbortController().signal);
    assert.deepEqual(response, { answers: [
      { index: 7, question: "What name?", answer: "name" },
      { index: 2, question: "Which targets?", answer: "No answer provided." },
    ] });
  }
});

test("Droid AskUser does not ask after abort or for zero questions; abort overrides a late answer", async () => {
  const controller = new AbortController();
  controller.abort();
  const never = answering({ kind: "clarify", answers: {} }, () => assert.fail("must not ask"));
  assert.deepEqual(await askUser(questions, never, controller.signal), { cancelled: true, answers: [] });
  assert.deepEqual(await askUser({ toolCallId: "empty", questions: [] }, never, new AbortController().signal), { cancelled: true, answers: [] });
  const pending = new AbortController();
  const late = answering({ kind: "clarify", answers: { "7": "name", "2": "Web" } }, () => pending.abort());
  assert.deepEqual(await askUser(questions, late, pending.signal), { cancelled: true, answers: [] });
});

test("Droid policies map explicit Medium and preserve inherited defaults", () => {
  assert.deepEqual(policyFor("default", defaults, "ask"), defaults);
  for (const [mode, autonomyLevel] of [["ask", AutonomyLevel.Off], ["edits", AutonomyLevel.Low], ["medium", AutonomyLevel.Medium], ["full", AutonomyLevel.High]] as const) {
    const policy = { autonomyLevel, interactionMode: DroidInteractionMode.Auto };
    assert.deepEqual(policyFor(mode, defaults, "ask"), policy);
    assert.equal(modeFor(policy), mode);
    assert.deepEqual(policyFor("plan", defaults, mode), { ...policy, interactionMode: DroidInteractionMode.Spec });
  }
  assert.deepEqual(policyFor("plan", defaults, "default"), { ...defaults, interactionMode: DroidInteractionMode.Spec });
  assert.deepEqual(policyFor("plan", defaults, "plan"), { autonomyLevel: AutonomyLevel.Off, interactionMode: DroidInteractionMode.Spec });
  assert.equal(modeFor(defaults), "medium");
  assert.equal(modeFor({ ...defaults, interactionMode: DroidInteractionMode.Spec }), "plan");
});

test("Droid reasoning translates off to none and validates actual model-supported efforts", () => {
  assert.equal(appEffort(ReasoningEffort.Off), "none");
  assert.equal(appEffort(ReasoningEffort.Dynamic), "");
  assert.equal(appEffort("unknown"), "");
  assert.equal(sdkEffort("none", model), ReasoningEffort.Off);
  assert.equal(sdkEffort("high", model), ReasoningEffort.High);
  assert.equal(sdkEffort("none", { ...model, supportedReasoningEfforts: [ReasoningEffort.None] }), ReasoningEffort.None);
  for (const effort of ["max", "dynamic", "invented"]) assert.throws(() => sdkEffort(effort, model), SettingRefused);
  assert.throws(() => sdkEffort("none", { ...model, supportedReasoningEfforts: [ReasoningEffort.High] }), /Example model/);
});

test("Droid catalog filters disabled models and presents only known app reasoning levels", () => {
  const catalog = modelCatalog([
    { ...model, supportedReasoningEfforts: [...model.supportedReasoningEfforts, ReasoningEffort.Dynamic] },
    { ...model, id: "disabled", disabled: true, disabledReason: "Unavailable" },
  ], { model: "Local CLI model", reasoning: "low" });
  assert.deepEqual(catalog.providers, [{ slug: "droid", name: "Droid", models: ["default", "example"] }]);
  assert.equal(catalog.model, "default");
  assert.equal(catalog.provider, "droid");
  assert.equal(catalog.reasoning, "low");
  assert.deepEqual(catalog.names, { default: "Local CLI model", example: "Example model" });
  assert.deepEqual(catalog.levels, { example: ["none", "low", "high"] });
  assert.deepEqual(catalog.defaultLevels, { example: "none" });
});

test("Droid's default entry is named by the model Droid's settings give and stands for it in the list, with its levels", () => {
  const other = { ...model, id: "other", displayName: "Other model" };
  const catalog = modelCatalog([model, other], { model: "example", reasoning: "low" });
  assert.deepEqual(catalog.providers[0].models, ["default", "other"]);
  assert.equal(catalog.names?.default, "Example model");
  assert.deepEqual(catalog.levels?.default, catalog.levels?.example);
  assert.equal(catalog.defaultLevels?.default, catalog.defaultLevels?.example);
});

test("Droid child environment disables updates without changing login settings or synthesizing credentials", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/existing/home", PATH: "/existing/bin", FACTORY_DROID_AUTO_UPDATE_ENABLED: "true", OMIT: undefined };
  const before = { ...env };
  const child = droidEnvironment(env);
  assert.deepEqual(env, before);
  assert.deepEqual(child, { HOME: "/existing/home", PATH: "/existing/bin", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" });
  assert.equal(Object.hasOwn(child, "FACTORY_API_KEY"), false);
  assert.equal(Object.hasOwn(child, "FACTORY_TOKEN"), false);
  child.HOME = "/child-only";
  assert.equal(env.HOME, "/existing/home");
});

function storedThread(): DroidThread {
  return {
    version: 1, id: "thread", session: "original-sdk-session", cwd: "/project",
    settings: { model: "default", provider: "droid", reasoningEffort: "none" },
    defaults, defaultModel: model.id, defaultEffort: ReasoningEffort.Off,
    mode: "plan", beforePlan: "edits", open: false,
    messages: [
      { role: "user", text: "Inspect", timestamp: 1 },
      { role: "assistant", text: "Checking", reasoning: "Carefully", timestamp: 2 },
      { role: "tool", name: "read_file", args: { path: "/project/a" }, tool_call_id: "read", timestamp: 3, content: '{"content":"a"}' },
    ],
  };
}

test("Droid store round-trips session mappings and rewrites with owner-only permissions", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "droid-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new DroidStore(directory);
  const thread = storedThread();
  store.write(thread);
  const threads = join(directory, "threads");
  const path = join(threads, readdirSync(threads)[0]!);
  assert.equal(store.exists(thread.id), true);
  assert.deepEqual(store.read(thread.id), thread);
  assert.equal(statSync(threads).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  chmodSync(path, 0o644);
  store.write({ ...thread, open: true });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(store.read(thread.id).open, true);
  assert.deepEqual(readdirSync(threads).sort(), [basename(path), `${basename(path)}.bak`], "no temporary file remains; the file the save replaced is kept");
});

test("Droid missing and corrupt mappings throw rather than manufacturing a replacement session", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "droid-corrupt-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new DroidStore(directory);
  const failure = /missing or unreadable.*not replaced/;
  assert.equal(store.exists("missing"), false);
  assert.throws(() => store.read("missing"), failure);
  assert.deepEqual(readdirSync(directory), []);
  const thread = storedThread();
  store.write(thread);
  const path = join(directory, "threads", `${createHash("sha256").update(thread.id).digest("hex")}.json`);
  for (const corrupt of [
    "{", "null", JSON.stringify({ ...thread, session: "" }), JSON.stringify({ ...thread, id: "another-thread" }),
    JSON.stringify({ ...thread, version: 2 }), JSON.stringify({ ...thread, messages: [{ role: "tool", name: "Read" }] }),
    JSON.stringify({ ...thread, mode: "invented" }),
  ]) {
    writeFileSync(path, corrupt);
    assert.throws(() => store.read(thread.id), failure);
    assert.equal(readFileSync(path, "utf8"), corrupt, "failed reads must not overwrite the bad mapping");
  }
});

test("Droid's shared image detector uses magic bytes and rejects unsupported or truncated inputs", () => {
  for (const [bytes, expected] of [
    [Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"],
    [Buffer.from("89504e470d0a1a0a", "hex"), "image/png"],
    [Buffer.from("GIF89a"), "image/gif"],
    [Buffer.from("RIFF0000WEBP"), "image/webp"],
  ] as const) assert.equal(imageType(bytes), expected);
  for (const bytes of [Buffer.alloc(0), Buffer.from([0xff, 0xd8]), Buffer.from("89504e470d0a1a", "hex"), Buffer.from("RIFF0000WAVE"), Buffer.from("\0\0\0\x18ftypheic")]) {
    assert.equal(imageType(bytes), null);
  }
});

test("text Droid streamed before a tool is kept before it, as the SDK gives the tool call before its message", () => {
  const messages: StoredMessage[] = [];
  const events: ProviderEvent[] = [];
  const stream = new DroidStream(messages, (event) => events.push(event), "/w");
  for (const event of [
    { type: "assistant_text_delta", messageId: "first", blockIndex: 0, text: "Let me check the file." },
    { type: "tool_call", name: "Read", toolUseId: "read", input: { file_path: "/tmp/a.txt" } },
    assistant("first", "Let me check the file."),
    { type: "tool_result", toolName: "Read", toolUseId: "read", content: "hello", isError: false },
    { type: "assistant_text_delta", messageId: "second", blockIndex: 0, text: "It says hello." },
    assistant("second", "It says hello."),
    result("It says hello."),
  ] as DroidStreamEvent[]) stream.accept(event);
  stream.finish();
  assert.deepEqual(messages.map((message) => message.role === "tool" ? `tool:${message.name}` : "text" in message ? `${message.role}:${message.text}` : message.role),
    ["assistant:Let me check the file.", "tool:read_file", "assistant:It says hello."]);
  assert.deepEqual(events.filter((event) => event.type === "commentary").map((event) => event.type === "commentary" && event.text), ["Let me check the file."]);
});

test("a message Droid retracts is not kept, nor taken for commentary before the next tool", () => {
  const messages: StoredMessage[] = [];
  const events: ProviderEvent[] = [];
  const stream = new DroidStream(messages, (event) => events.push(event), "/w");
  for (const event of [
    { type: "assistant_text_delta", messageId: "kept", blockIndex: 0, text: "First. " },
    assistant("kept", "First. "),
    { type: "assistant_text_delta", messageId: "retried", blockIndex: 0, text: "Half a sen" },
    { type: "assistant_message_retracted", messageId: "retried" },
    { type: "assistant_text_delta", messageId: "again", blockIndex: 0, text: "A whole sentence." },
    { type: "tool_call", name: "Read", toolUseId: "read", input: { file_path: "/tmp/a.txt" } },
    assistant("again", "A whole sentence."),
    { type: "tool_result", toolName: "Read", toolUseId: "read", content: "hello", isError: false },
    result(""),
  ] as DroidStreamEvent[]) stream.accept(event);
  stream.finish();
  assert.deepEqual(messages.map((message) => message.role === "tool" ? `tool:${message.name}` : "text" in message ? `${message.role}:${message.text}` : message.role),
    ["assistant:First. ", "assistant:A whole sentence.", "tool:read_file"]);
  assert.deepEqual(events.filter((event) => event.type === "commentary").map((event) => event.type === "commentary" && event.text), ["First. A whole sentence."]);
});

test("the desk list's map of Droid sessions to threads reads only thread files that changed (PR #19 review B9)", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "droid-mappings-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new DroidStore(directory);
  const one = storedThread();
  const two = { ...storedThread(), id: "thread-two", session: "session-two" };
  store.write(one);
  store.write(two);
  const sessions = () => store.mappings().map(({ id, session }) => `${id}:${session}`).sort();
  assert.deepEqual(sessions(), [`${one.id}:${one.session}`, "thread-two:session-two"].sort());
  // Unchanged files are not read again: one that could not be read now is still known.
  const threads = join(directory, "threads");
  const files = readdirSync(threads).filter((name) => name.endsWith(".json"));
  for (const file of files) chmodSync(join(threads, file), 0o000);
  t.after(() => { for (const file of files) try { chmodSync(join(threads, file), 0o600); } catch { /* removed */ } });
  assert.deepEqual(sessions(), [`${one.id}:${one.session}`, "thread-two:session-two"].sort());
  // A thread the bridge saves is known as saved; one changed or removed on disk is read again.
  for (const file of files) chmodSync(join(threads, file), 0o600);
  store.write({ ...two, session: "session-three" });
  assert.deepEqual(sessions(), [`${one.id}:${one.session}`, "thread-two:session-three"].sort());
  const path = join(threads, `${createHash("sha256").update(one.id).digest("hex")}.json`);
  writeFileSync(path, JSON.stringify({ ...one, session: "moved-elsewhere" }));
  assert.deepEqual(sessions(), [`${one.id}:moved-elsewhere`, "thread-two:session-three"].sort());
  rmSync(path);
  assert.deepEqual(sessions(), ["thread-two:session-three"].sort());
});
