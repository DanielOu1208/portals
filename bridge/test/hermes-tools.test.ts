import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { HermesSession, storedMessages, type HermesHost } from "../src/providers/hermes/session.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

// Hermes 0.22.0 renamed its to-do tool to `todo_list` and its process tool to
// `process_manage`, and loads both only when a model asks (`tool_call`). The app draws a
// plan for `todo` and a terminal for `process`, so the bridge passes them on by those names.

const settings = { model: "m", provider: "p", reasoningEffort: "" };
const plan = [
  { id: "1", content: "Read the notes", status: "completed" },
  { id: "2", content: "Write the summary", status: "in_progress" },
];

function session(): { adapter: HermesSession; events: ProviderEvent[] } {
  const events: ProviderEvent[] = [];
  const host: HermesHost = { call: async <T>() => ({}) as T, bind() {}, forget() {}, respond() {}, respondError() {} };
  const adapter = new HermesSession({ id: "stored", cwd: "/tmp", settings }, "default", {
    emit: (event) => { events.push(event); }, ask: async () => ({ kind: "withdrawn", reason: "test" }),
  }, host, { session_id: "runtime" });
  adapter.attached();
  return { adapter, events };
}

test("Hermes's todo_list and process_manage come to the app as todo and process, a to-do call's end with the whole list", () => {
  const { adapter, events } = session();
  adapter.event("message.start", 1, {});
  const update = { todos: [{ id: "2", content: "Write the summary", status: "in_progress" }], merge: true };
  adapter.event("tool.start", 2, { tool_id: "t1", name: "todo_list", args: update, context: "1 task" });
  adapter.event("tool.complete", 3, { tool_id: "t1", name: "todo_list", args: update, result: { todos: plan, summary: { total: 2 } }, todos: plan, revision: 2 });
  adapter.event("tool.start", 4, { tool_id: "t2", name: "process_manage", args: { action: "list" } });
  const tools = events.filter((event) => event.type === "tool.start" || event.type === "tool.end");
  assert.deepEqual(tools.map((event) => event.name), ["todo", "todo", "process"]);
  assert.deepEqual(tools[0].args, update);
  assert.deepEqual(tools[1].args, { ...update, todos: plan });
  assert.equal(tools[0].context, "1 task");
});

test("a to-do call Hermes keeps as its tool_call reads back as todo, each with the whole list as it stood after it", () => {
  const first = { calls: [{ name: "todo_list", arguments: { todos: plan } }] };
  const merged = { calls: JSON.stringify([{ name: "todo_list", arguments: JSON.stringify({ todos: [{ id: "2", content: "Write the summary", status: "completed" }, { id: "3", content: "Send it", status: "pending" }], merge: true }) }]) };
  const read = { name: "todo_list", arguments: {} };
  const rows = storedMessages([
    { role: "user", text: "Plan it", timestamp: 0 },
    { role: "tool", name: "tool_call", tool_call_id: "c1", timestamp: 1, context: "todo_list", args: first },
    { role: "tool", name: "tool_call", tool_call_id: "c2", timestamp: 2, args: merged },
    { role: "tool", name: "tool_call", tool_call_id: "c3", timestamp: 3, args: read },
    { role: "tool", name: "process", tool_call_id: "c4", timestamp: 4, args: { action: "poll" } },
    { role: "tool", name: "tool_call", tool_call_id: "c5", timestamp: 5, args: { calls: [{ name: "process_manage", arguments: { action: "list" } }] } },
    { role: "tool", name: "tool_call", tool_call_id: "c6", timestamp: 6, args: { calls: [{ name: "a", arguments: {} }, { name: "b", arguments: {} }] } },
    { role: "tool", name: "terminal", tool_call_id: "c7", timestamp: 7, args: { command: "ls" } },
  ]);
  const tools = rows.filter((row) => row.role === "tool");
  assert.deepEqual(tools.map((row) => row.name), ["todo", "todo", "todo", "process", "process", "tool_call", "terminal"]);
  assert.deepEqual(tools[0].args, { todos: plan });
  assert.equal(tools[0].context, "todo_list");
  const after = [plan[0], { id: "2", content: "Write the summary", status: "completed" }, { id: "3", content: "Send it", status: "pending" }];
  assert.deepEqual(tools[1].args.todos, after);
  assert.equal(tools[1].args.merge, true);
  assert.deepEqual(tools[2].args, { todos: after });
  assert.deepEqual(tools[4].args, { action: "list" });
  // A batch of several is left as Hermes keeps it.
  assert.ok(Array.isArray(tools[5].args.calls));
  assert.equal(tools[0].tool_call_id, "c1");
});

test("a to-do call in a batch Hermes keeps as one tool_call reads back as a todo of its own, the batch kept as it is, and a later merge builds on it", () => {
  const initial = [
    { id: "a", content: "one", status: "pending" },
    { id: "b", content: "two", status: "pending" },
  ];
  const batch = { calls: [{ name: "todo_list", arguments: { todos: initial } }, { name: "terminal", arguments: { command: "pwd" } }] };
  const rows = storedMessages([
    { role: "tool", name: "tool_call", tool_call_id: "batch", timestamp: 1, args: batch, content: "{\"output\":\"/tmp\"}" },
    { role: "tool", name: "todo_list", tool_call_id: "merge", timestamp: 2, args: { merge: true, todos: [{ id: "a", status: "completed" }] } },
  ]);
  const tools = rows.filter((row) => row.role === "tool");
  assert.deepEqual(tools.map((row) => row.name), ["tool_call", "todo", "todo"]);
  // The batch, with the other tool's call and result, as Hermes keeps it.
  assert.deepEqual(tools[0].args, batch);
  assert.equal(tools[0].content, "{\"output\":\"/tmp\"}");
  assert.deepEqual(tools[1].args, { todos: initial });
  assert.equal(new Set(tools.map((row) => row.tool_call_id)).size, 3);
  assert.equal(tools[1].timestamp, 1);
  assert.deepEqual(tools[2].args.todos, [{ id: "a", content: "one", status: "completed" }, initial[1]]);
});
