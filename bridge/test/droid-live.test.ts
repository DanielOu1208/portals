import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { DroidWorkingState, McpAuthOutcome, McpServerStatusInfoSchema, type DroidStreamEvent } from "@factory/droid-sdk/node";
import { outputTail, tokenTotal } from "../src/providers/droid/activity.ts";
import { DroidStream } from "../src/providers/droid/stream.ts";
import { gatewayTool } from "../src/providers/droid/tools.ts";
import type { ProviderEvent, StoredMessage } from "../src/providers/types.ts";
import { Transcript } from "../src/sessions/transcript.ts";

test("live Droid output and turn usage survive a full resume snapshot without appending twice", () => {
  const transcript = new Transcript();
  transcript.startTurn("run it");
  transcript.apply({ type: "tool.start", id: "exec", name: "terminal", args: { command: "printf hello" } });
  transcript.apply({ type: "tool.progress", id: "exec", output: "hel", progress: "Running" });
  transcript.apply({ type: "tool.progress", id: "exec", output: "hello", outputTruncated: false });
  transcript.apply({ type: "turn.usage", usage: { tokens: 12 } });
  transcript.apply({ type: "turn.usage", usage: { tokens: 20 } });
  assert.deepEqual(transcript.inflight(), {
    user: "run it", assistant: "", turn_usage: { tokens: 20 },
    tools: [{ tool_id: "exec", name: "terminal", args: { command: "printf hello" }, output: "hello", progress: "Running", output_truncated: false }],
  });
  transcript.apply({ type: "tool.end", id: "exec", name: "terminal", args: {}, result: { output: "hello", exit_code: 0 } });
  assert.equal(transcript.inflight()?.tools, undefined);
  assert.equal(transcript.messages.at(-1)?.role, "tool");
  transcript.apply({ type: "turn.end", status: "complete", spent: { tokens: 20 } });
  transcript.startTurn("next");
  assert.deepEqual(transcript.inflight(), { user: "next", assistant: "" });
});

test("repeated tool completions replace the original transcript row without moving it or losing metadata", () => {
  const transcript = new Transcript();
  transcript.startTurn("background");
  transcript.apply({ type: "tool.end", id: "exec", name: "terminal", args: { command: "run", summary: "Original" },
    context: "Original context", result: { output: "Background process started (PID: 1)" } });
  transcript.apply({ type: "turn.end", status: "complete", spent: { tokens: 50 } });
  const original = transcript.messages[1];
  assert.equal(original.role, "tool");
  const timestamp = original.timestamp;
  transcript.startTurn("another turn");
  transcript.apply({ type: "text", text: "Uninterrupted reply" });
  transcript.apply({ type: "tool.end", id: "exec", name: "terminal", args: {}, result: { output: "Finished", exit_code: 0 } });
  transcript.apply({ type: "tool.end", id: "exec", name: "terminal", args: {}, result: { output: "Finished", exit_code: 0 } });
  assert.equal(transcript.messages.filter((m) => m.role === "tool" && m.tool_call_id === "exec").length, 1);
  assert.equal(transcript.messages[1], original);
  assert.equal(original.timestamp, timestamp);
  assert.ok(original.role === "tool");
  assert.deepEqual(original.args, { command: "run", summary: "Original" });
  assert.equal(original.context, "Original context");
  assert.deepEqual(original.turn_usage, { tokens: 50 });
  assert.deepEqual(JSON.parse(original.content!), { output: "Finished", exit_code: 0 });
  assert.equal(transcript.inflight()?.assistant, "Uninterrupted reply", "an old row update does not flush the current reply");
});

test("a call begun in this turn keeps its own row when its id repeats an earlier call's", () => {
  const transcript = new Transcript();
  transcript.startTurn("first");
  transcript.apply({ type: "tool.start", id: "fake-tool-1", name: "read_file", args: { path: "a.txt" } });
  transcript.apply({ type: "tool.end", id: "fake-tool-1", name: "read_file", args: { path: "a.txt" }, result: "old contents" });
  transcript.apply({ type: "turn.end", status: "complete" });
  transcript.startTurn("second, after the agent counted its calls again");
  transcript.apply({ type: "tool.start", id: "fake-tool-1", name: "terminal", args: { command: "ls" } });
  transcript.apply({ type: "tool.end", id: "fake-tool-1", name: "terminal", args: { command: "ls" }, result: "new listing" });
  const rows = transcript.messages.filter((message) => message.role === "tool");
  assert.deepEqual(rows.map((row) => row.role === "tool" ? [row.name, row.content] : []), [["read_file", "old contents"], ["terminal", "new listing"]]);
});

test("Droid's output tail reads only the end of a long output and keeps exactly what reading all of it kept", () => {
  // The tail as it was worked out from the whole output, before only the end was read.
  const whole = (text: string) => {
    const lines = text.split("\n");
    const bytes = Buffer.from(lines.slice(-200).join("\n"));
    let start = Math.max(0, bytes.length - 8192);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    return { output: bytes.subarray(start).toString(), truncated: lines.length > 200 || start > 0 };
  };
  const inputs = ["", "short\n", "x".repeat(8192), "x".repeat(8193), `${"x".repeat(8191)}🙂`, `🙂${"x".repeat(8191)}`,
    `${"a".repeat(9000)}\n${"漢🙂".repeat(3000)}`, Array.from({ length: 300 }, (_, n) => `line ${n}`).join("\n"),
    Array.from({ length: 199 }, () => "y".repeat(60)).join("\n"), Array.from({ length: 5000 }, (_, n) => `row ${n}\r`).join("\n"),
    `${"é".repeat(5000)}\n${"z".repeat(5000)}`, "\n".repeat(10_000)];
  for (const text of inputs) assert.deepEqual(outputTail(text), whole(text), `for an output of ${text.length} units`);
});

function rig(baseline: number | null = 0) {
  const events: ProviderEvent[] = [], messages: StoredMessage[] = [];
  const stream = new DroidStream(messages, (event) => events.push(event), "/tmp", baseline);
  return { events, messages, stream };
}

test("Droid working states are transient, deduplicated and cleared when the stream ends", () => {
  const { events, messages, stream } = rig();
  for (const state of [DroidWorkingState.Thinking, DroidWorkingState.Thinking,
    DroidWorkingState.WaitingForToolConfirmation, DroidWorkingState.ExecutingTool, DroidWorkingState.CompactingConversation]) {
    stream.accept({ type: "working_state_changed", state });
  }
  stream.finish();
  stream.finish();
  assert.deepEqual(events, [
    { type: "working", state: "thinking", text: "Thinking" },
    { type: "working", state: "waiting_for_tool_confirmation", text: "Waiting for approval" },
    { type: "working", state: "executing_tool", text: "Running tool" },
    { type: "working", state: "compacting_conversation", text: "Compacting conversation" },
    { type: "working", state: "idle", text: "" },
  ]);
  assert.deepEqual(messages, []);
});

test("Droid replaces cumulative output even with empty text, bounds fallback output and ignores incomplete input", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { events, stream } = rig();
  stream.accept({ type: "tool_call_delta", toolUse: { type: "tool_use", id: "cmd", name: "Execute", input: {} } });
  assert.equal(events.length, 0);
  stream.accept({ type: "tool_call", toolUseId: "cmd", name: "Execute", input: { command: "printf hi" } });
  const progress = (fullOutput: string | undefined, text = ""): DroidStreamEvent => ({
    type: "tool_progress", toolUseId: "cmd", toolName: "Execute", content: text,
    update: { type: "status", text, ...(fullOutput !== undefined ? { fullOutput } : {}) },
  });
  stream.accept(progress("first\n", "first"));
  stream.accept(progress("first\n"));
  stream.accept(progress("first\nsecond\n"));
  t.mock.timers.tick(250);
  assert.deepEqual(events.filter((event) => event.type === "tool.progress").map((event) => event.output), ["first\n", "first\nsecond\n"]);
  stream.accept(progress("x".repeat(70_000)));
  t.mock.timers.tick(250);
  const bounded = events.at(-1);
  assert.ok(bounded?.type === "tool.progress");
  assert.equal(bounded.output?.length, 8192);
  assert.equal(bounded.outputTruncated, true);
  stream.accept(progress(undefined, "last"));
  stream.accept(progress(undefined, "last"));
  t.mock.timers.tick(250);
  assert.equal(events.filter((event) => event.type === "tool.progress").length, 4);
  const fallback = events.at(-1);
  assert.ok(fallback?.type === "tool.progress");
  assert.equal(fallback.output?.endsWith("last"), true);
  stream.accept({ type: "tool_result", toolUseId: "cmd", toolName: "Execute", content: "final", isError: false });
  const count = events.length;
  stream.accept(progress("late"));
  assert.equal(events.length, count);
});

test("Droid coalesces per-tool progress at 250ms and keeps a UTF-8 and line-bounded latest tail", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { events, stream } = rig();
  stream.accept({ type: "tool_call", toolUseId: "cmd", name: "Execute", input: {} });
  const progress = (fullOutput: string): DroidStreamEvent => ({
    type: "tool_progress", toolUseId: "cmd", toolName: "Execute", content: "",
    update: { type: "status", fullOutput },
  });
  stream.accept(progress("first"));
  for (let n = 0; n < 1000; n++) stream.accept(progress(`${n}\n${"漢🙂".repeat(3000)}`));
  assert.equal(events.filter((e) => e.type === "tool.progress").length, 1);
  t.mock.timers.tick(249);
  assert.equal(events.filter((e) => e.type === "tool.progress").length, 1);
  t.mock.timers.tick(1);
  const tail = events.at(-1);
  assert.ok(tail?.type === "tool.progress");
  assert.ok(Buffer.byteLength(tail.output!) <= 8192);
  assert.doesNotMatch(tail.output!, /\uFFFD/);
  assert.equal(tail.outputTruncated, true);
  const lines = Array.from({ length: 300 }, (_, n) => `line ${n}`).join("\n");
  stream.accept(progress(lines));
  t.mock.timers.tick(250);
  const lineTail = events.at(-1);
  assert.ok(lineTail?.type === "tool.progress");
  assert.equal(lineTail.output!.split("\n").length, 200);
  assert.equal(lineTail.output!.split("\n")[0], "line 100");
  assert.equal(lineTail.outputTruncated, true);
  stream.accept(progress("last pending"));
  const fullFinal = "complete output ".repeat(5000);
  stream.accept({ type: "tool_result", toolUseId: "cmd", toolName: "Execute", content: fullFinal, isError: false });
  assert.equal(events.at(-2)?.type, "tool.progress", "terminal completion may flush the latest pending tail");
  assert.match(JSON.stringify(events.at(-1)), /complete output/);
  assert.ok(JSON.stringify(events.at(-1)).length > 8192, "the final result is not tail-truncated");
  const count = events.length;
  t.mock.timers.tick(1000);
  assert.equal(events.length, count, "terminal completion cancels delayed progress");
});

test("non-terminal Droid progress is a bounded status, not stdout", () => {
  const { events, stream } = rig();
  stream.accept({ type: "tool_call", toolUseId: "read", name: "Read", input: { file_path: "/tmp/a" } });
  stream.accept({ type: "tool_progress", toolUseId: "read", toolName: "Read", content: "Loading", update: { type: "status", text: "Loading".repeat(1000) } });
  const progress = events.at(-1);
  assert.ok(progress?.type === "tool.progress");
  assert.equal(progress.progress?.length, 2000);
  assert.equal(progress.output, undefined);
});

test("Droid turns subtract the persisted live baseline but never add thinking twice", () => {
  const { events, stream } = rig(100);
  const usage = { type: "token_usage_update" as const, inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 10, thinkingTokens: 15 };
  stream.accept(usage);
  stream.accept(usage);
  stream.accept({ ...usage, outputTokens: 30 });
  assert.deepEqual(events, [
    { type: "turn.usage", usage: { tokens: 60 } },
    { type: "turn.usage", usage: { tokens: 70 } },
  ]);
  assert.equal(tokenTotal({ inputTokens: -1 }), undefined);
  assert.equal(tokenTotal({ outputTokens: NaN }), undefined);
  assert.equal(tokenTotal(null), undefined);
  const unknown = rig(null);
  unknown.stream.accept(usage);
  assert.deepEqual(unknown.events, []);
});

test("Droid hook and MCP notices are bounded, deduplicated and do not expose authentication fields", () => {
  const { events, stream } = rig();
  const hook: DroidStreamEvent = { type: "hook", hookId: "h", eventName: "PreToolUse", matcher: "Execute", status: "completed", exitCode: 7, stdout: "x".repeat(3000) };
  // Hooks that start or finish cleanly are not shown.
  stream.accept({ type: "hook", hookId: "fine", eventName: "Stop", status: "started" });
  stream.accept({ type: "hook", hookId: "fine", eventName: "Stop", status: "completed", exitCode: 0, stdout: "ok" });
  stream.accept({ type: "hook", hookId: "quiet", eventName: "SessionStart", status: "completed" });
  stream.accept(hook);
  stream.accept(hook);
  stream.accept({ ...hook, hookId: "hidden", suppressOutput: true, stdout: "SECRET_HOOK_OUTPUT" });
  stream.accept({ type: "mcp_auth_required", serverName: "docs", authUrl: "SECRET_AUTH_URL", state: "SECRET_STATE", message: "SECRET_MESSAGE" });
  stream.accept({ type: "mcp_auth_completed", serverName: "docs", outcome: McpAuthOutcome.Failed, message: "SECRET_MESSAGE" });
  stream.accept({ type: "mcp_status_changed", servers: [McpServerStatusInfoSchema.parse({
    name: "docs", status: "failed", source: "user", isManaged: false, serverType: "http",
    error: "SECRET_ERROR", pendingAuthUrl: "SECRET_AUTH_URL", pendingAuthState: "SECRET_STATE",
  })], summary: { total: 1, failed: 1, connected: 0, connecting: 0 } });
  const notices = events.filter((event) => event.type === "notice");
  assert.equal(notices.length, 5);
  assert.equal(notices[0].level, "error");
  assert.match(notices[0].text, /^PreToolUse \/ Execute: completed \(exit 7\)\n/);
  assert.equal(notices[0].text.split("\n")[1].length, 2000);
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
});

test("Droid TodoWrite retains its raw fallback and offers structured items only for a valid list", () => {
  assert.deepEqual(gatewayTool("TodoWrite", { todos: "1. [completed] done\n2. [in_progress] now\n3. [pending] next" }).args.items, [
    { text: "done", status: "completed" }, { text: "now", status: "in_progress" }, { text: "next", status: "pending" },
  ]);
  for (const todos of ["", "bad", "1. [pending] valid\nbad", "1. [unknown] no", "1. [pending] ", null]) {
    assert.deepEqual(gatewayTool("TodoWrite", { todos }).args, { todos, items: [] });
  }
  const input = { command: "pwd", summary: "Print folder", riskLevel: "low", fireAndForget: false, timeout: 10 };
  assert.deepEqual(gatewayTool("Execute", input).args, input);
});

test("recorded Droid Execute output replaces live snapshots and is finalized in one stored row", () => {
  const { events, messages, stream } = rig();
  const records = readFileSync(new URL("./fixtures/droid/execute.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  for (const record of records) if (record.event) stream.accept(record.event);
  stream.finish();
  const progress = events.filter((event) => event.type === "tool.progress");
  assert.equal(progress.at(-1)?.output, "first\nsecond\n");
  const tools = messages.filter((message) => message.role === "tool" && message.name === "terminal");
  assert.equal(tools.length, 1);
  assert.ok(tools[0].role === "tool");
  assert.ok(tools[0].args.summary);
  assert.equal(tools[0].args.riskLevel, "low");
  assert.match(tools[0].content ?? "", /first\\nsecond/);
});

test("a Droid command the turn ended under keeps the output it showed live, with why it has no result", () => {
  const { events, messages, stream } = rig();
  const records = readFileSync(new URL("./fixtures/droid/execute.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  // Stopped (or the turn ended) after it printed two lines, before Droid gave its result.
  for (const record of records) {
    if (record.event?.type === "tool_result") break;
    if (record.event) stream.accept(record.event);
  }
  // Shown live: its first line (the second waits out the interval between updates).
  assert.equal(events.filter((event) => event.type === "tool.progress").at(-1)?.output, "first\n");
  stream.finish();
  const end = events.filter((event) => event.type === "tool.end").at(-1);
  assert.ok(end?.type === "tool.end");
  const result = end.result as { success?: boolean; error?: string; output?: string };
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /turn ended before/);
  assert.equal(result.output, "first\nsecond\n");
  const row = messages.findLast((message) => message.role === "tool" && message.name === "terminal");
  assert.ok(row?.role === "tool");
  assert.match(row.content ?? "", /first\\nsecond/);
});
