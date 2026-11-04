import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenCodeApi } from "../src/providers/opencode/client.ts";
import { storedMessages } from "../src/providers/opencode/history.ts";
import type { Message, OpenCodeEvent, TokenUsage } from "../src/providers/opencode/protocol.ts";
import { OpenCodeSession, sessionError } from "../src/providers/opencode/session.ts";
import { gatewayResult, gatewayTool } from "../src/providers/opencode/tools.ts";
import { notSignedIn, signInHint } from "../src/providers/signIn.ts";
import type { ProviderEvent, SessionSink } from "../src/providers/types.ts";

const id = "ses_parity";
const tick = () => new Promise<void>((done) => setImmediate(done));
const user = (): Message => ({ type: "user", id: "user", text: "Help Dana", time: { created: 1 } });
const tokens = (input: number): TokenUsage => ({ input, output: 2, reasoning: 1, cache: { read: 3, write: 4 } });
const assistant = (id: string, input: number): Message => ({ type: "assistant", id, content: [{ type: "text", text: "Working" }], tokens: tokens(input), time: { created: 2 } });
let sequence = 0;
const frame = (type: string, data: object = {}): OpenCodeEvent => ({ id: `evt_${++sequence}`, type, data: { sessionID: id, ...data } });

async function rig() {
  const events: ProviderEvent[] = [], unknown: string[] = [];
  let messages: Message[] = [user()];
  const api = {
    messages: async () => messages, active: async () => new Set([id]), inbox: async () => [],
    pendingPermissions: async () => [], forms: async () => [], sessions: async () => [],
    shellOutput: async (_directory: string, _shell: string, _cursor: number) => ({ output: "", cursor: 0, size: 0, truncated: false }),
  };
  const sink: SessionSink = { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "test" }) };
  const session = new OpenCodeSession({ id, cwd: "/tmp/parity", settings: { model: "p/m", provider: "p", reasoningEffort: "" } }, sink,
    { api: async () => api as unknown as OpenCodeApi, bind() {}, forget() {}, contextOf: () => 1000, levelsOf() {}, unknown: (kind) => unknown.push(kind) },
    { info: { id, time: { created: 1, updated: 1 } }, messages, running: true });
  session.attached();
  await tick();
  return { session, events, unknown, api, messages: (value: Message[]) => { messages = value; } };
}

function startShell(session: OpenCodeSession, tool = "shell") {
  session.event(frame("session.tool.input.started", { id: "call", name: tool }));
  session.event(frame("session.tool.called", { id: "call", input: { command: "build" } }));
  session.event(frame("session.tool.progress", { id: "call", metadata: { shellID: "sh_owned" } }));
}

test("todowrite uses the shared checklist live and in native history, including errors", async () => {
  const input = { todos: [{ content: "Read", status: "completed", priority: "high" }, { content: "Build", status: "in_progress", priority: "medium" }] };
  const tool = gatewayTool("todowrite", input);
  assert.deepEqual(tool, { name: "todo", args: input, context: "1 of 2 done" });
  assert.deepEqual(gatewayResult("todowrite", input, tool, { ok: true, content: [] }, "/tmp"), { output: "✓ Read\n→ Build" });
  assert.deepEqual(gatewayResult("todowrite", input, tool, { ok: false, error: { type: "failed", message: "No changes" } }, "/tmp"), { error: "No changes" });
  const stored = storedMessages([{ type: "assistant", id: "a", time: { created: 1 }, content: [{ type: "tool", id: "todo", name: "todowrite", state: { status: "completed", input, content: [] } }] }], "/tmp");
  assert.equal(stored[0]?.role === "tool" && stored[0].name, "todo");
  assert.equal(stored[0]?.role === "tool" && stored[0].content, '{"output":"✓ Read\\n→ Build"}');
  const r = await rig();
  try {
    r.session.event(frame("session.tool.input.started", { id: "todo", name: "todowrite" }));
    r.session.event(frame("session.tool.called", { id: "todo", input }));
    r.session.event(frame("session.tool.success", { id: "todo", content: [] }));
    assert.equal(r.events.find((event) => event.type === "tool.start")?.name, "todo");
    assert.deepEqual(r.events.find((event) => event.type === "tool.end")?.result, { output: "✓ Read\n→ Build" });
  } finally { await r.session.close(); }
});

test("step counts update context during a turn and sum each step once across reconnect", async () => {
  const r = await rig();
  try {
    r.session.event(frame("session.step.ended", { assistantMessageID: "a1", tokens: tokens(10) }));
    r.session.event(frame("session.step.ended", { assistantMessageID: "a2", tokens: tokens(20) }));
    r.session.event(frame("session.step.ended", { assistantMessageID: "a2", tokens: tokens(20) }));
    r.messages([user(), assistant("a1", 10), assistant("a2", 20)]);
    r.session.reconnected();
    await r.session.catchingUp();
    assert.deepEqual(r.events.filter((event) => event.type === "usage").map((event) => event.usage), [{ used: 20, max: 1000 }, { used: 30, max: 1000 }]);
    r.messages([user(), assistant("a1", 10), assistant("a2", 20), { type: "idle", id: "idle", outcome: "succeeded", time: { created: 3 } }]);
    r.session.event(frame("session.execution.succeeded"));
    await r.session.catchingUp();
    assert.deepEqual(r.events.find((event) => event.type === "turn.end"), { type: "turn.end", status: "complete", usage: { used: 30, max: 1000 }, spent: { tokens: 50 } });
  } finally { await r.session.close(); }
});

test("failed steps preserve usage and malformed counts are ignored", async () => {
  const r = await rig();
  try {
    r.session.event(frame("session.step.ended", { assistantMessageID: "bad", tokens: { input: 5 } }));
    r.session.event(frame("session.step.failed", { assistantMessageID: "a", tokens: tokens(10), error: { type: "provider.authentication", message: "Unauthorized" } }));
    r.session.event(frame("session.execution.failed"));
    const end = r.events.find((event) => event.type === "turn.end");
    assert.equal(end?.error, notSignedIn("opencode"));
    assert.deepEqual(end?.spent, { tokens: 20 });
    assert.deepEqual(end?.usage, { used: 20, max: 1000 });
  } finally { await r.session.close(); }
});

test("native history keeps image markers and turn totals across steering", () => {
  const stored = storedMessages([
    { type: "user", id: "u", text: "", files: [{ data: "private-bytes", mime: "image/png", source: { type: "inline" }, name: "/tmp/photo.png" }, { data: "private-bytes", mime: "image/webp", source: { type: "inline" } }, { data: "private-text", mime: "text/plain", source: { type: "inline" }, name: "notes.txt" }], time: { created: 1000 } },
    assistant("a1", 10), { ...user(), id: "steering" }, assistant("a2", 20),
    { type: "idle", id: "end", outcome: "succeeded", time: { created: 3000 } },
  ], "/tmp");
  assert.equal(stored[0]?.role === "user" && stored[0].text, "@image:photo.png\n@image:image-2.webp");
  assert.deepEqual(stored.at(-1)?.turn_usage, { tokens: 50 });
  assert.equal(JSON.stringify(stored).includes("private-"), false);
});

test("shell output uses byte cursors and one poller per tool; completion rejects late output", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = await rig();
  const reads: [string, string, number][] = [];
  let late!: (value: { output: string; cursor: number; size: number; truncated: boolean }) => void;
  r.api.shellOutput = async (directory, shell, cursor) => {
    reads.push([directory, shell, cursor]);
    if (reads.length === 1) return { output: "猫\n", cursor: 4, size: 4, truncated: true };
    return new Promise((done) => { late = done; });
  };
  try {
    startShell(r.session);
    r.session.event(frame("session.tool.progress", { id: "call", metadata: { shellID: "sh_owned" } }));
    await tick();
    assert.deepEqual(reads, [["/tmp/parity", "sh_owned", 0]]);
    assert.deepEqual(r.events.find((event) => event.type === "tool.progress"), { type: "tool.progress", id: "call", output: "猫\n", outputTruncated: true });
    t.mock.timers.tick(250);
    await tick();
    assert.equal(reads.at(-1)?.[2], 4);
    r.session.event(frame("session.tool.success", { id: "call", content: [{ type: "text", text: "done" }] }));
    late({ output: "late", cursor: 8, size: 8, truncated: false });
    await tick();
    t.mock.timers.tick(1000);
    await tick();
    assert.equal(reads.length, 2);
    assert.equal(r.events.filter((event) => event.type === "tool.progress").length, 1);
  } finally { await r.session.close(); }
});

test("shell reads skip a large backlog and publish a bounded truncated tail", async () => {
  const r = await rig();
  const cursors: number[] = [];
  r.api.shellOutput = async (_directory, _shell, cursor) => {
    cursors.push(cursor);
    return cursor === 0 ? { output: "old", cursor: 3, size: 100_000, truncated: true } : { output: "z".repeat(8192), cursor: 100_000, size: 100_000, truncated: false };
  };
  try {
    startShell(r.session);
    await tick();
    assert.deepEqual(cursors, [0, 100_000 - 8192]);
    const progress = r.events.find((event) => event.type === "tool.progress");
    assert.equal(progress?.output?.length, 8192);
    assert.equal(progress?.outputTruncated, true);
  } finally { await r.session.close(); }
});

test("other tools cannot open shell readers and ignored native events do not warn", async () => {
  const r = await rig();
  let reads = 0;
  r.api.shellOutput = async () => { ++reads; return { output: "", cursor: 0, size: 0, truncated: false }; };
  try {
    startShell(r.session, "read");
    r.session.event(frame("session.step.started"));
    r.session.event(frame("session.instructions.updated"));
    r.session.event(frame("session.future.event"));
    await tick();
    assert.equal(reads, 0);
    assert.deepEqual(r.unknown, ["session.future.event"]);
  } finally { await r.session.close(); }
});

test("API wrappers scope MCP and shell reads to a directory and discover projects globally", async () => {
  const called: unknown[] = [];
  const native = {
    mcp: { list: async (input: unknown) => { called.push(input); return { data: [{ name: "docs", status: { type: "connected" } }] }; } },
    project: { list: async (input: unknown) => { called.push(input); return [{ id: "project", canonical: "/tmp/project" }]; } },
    shell: { output: async (input: unknown) => { called.push(input); return { data: { output: "ok", cursor: 9, size: 9, truncated: false } }; } },
  };
  const api = new OpenCodeApi(native as unknown as ConstructorParameters<typeof OpenCodeApi>[0]);
  assert.equal((await api.mcpStatuses("/tmp/project"))[0]?.name, "docs");
  assert.equal((await api.projects())[0]?.canonical, "/tmp/project");
  assert.equal((await api.shellOutput("/tmp/project", "sh", 7)).output, "ok");
  assert.deepEqual(called, [{ location: { directory: "/tmp/project" } }, { archived: false }, { location: { directory: "/tmp/project" }, id: "sh", cursor: 7, limit: 8192 }]);
});

test("sign-in errors use the native login command and unrelated errors keep their explanation", () => {
  assert.equal(signInHint("opencode"), "Run `opencode auth login` in a terminal there, then try again.");
  assert.equal(sessionError({ type: "provider.authentication", message: "raw" }), notSignedIn("opencode"));
  assert.equal(sessionError({ type: "provider.invalid-request", message: "Bad schema" }), "Bad schema");
  const stored = storedMessages([{ type: "idle", id: "failed", outcome: "failed", error: { type: "provider.authentication", message: "raw" }, time: { created: 1 } }], "/tmp");
  assert.equal(stored[0]?.role === "assistant" && stored[0].text, notSignedIn("opencode"));
});
