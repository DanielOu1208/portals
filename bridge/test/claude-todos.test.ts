import "./environment.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { historyFromSession } from "../src/providers/claude/history.ts";
import { ClaudeStream } from "../src/providers/claude/stream.ts";
import { ClaudeTodos } from "../src/providers/claude/todos.ts";
import type { ProviderEvent, StoredMessage } from "../src/providers/types.ts";

// Claude Code's task tools as to-do rows (src/providers/claude/todos.ts), from a real turn
// of Claude Code 2.1.299 on Haiku 4.5 (2026-10-26, a scratch folder, two files read): its
// SDK messages without the streamed pieces, the folder named as the other fixtures name it.

const cwd = "/tmp/aeriportal-cwd";

function messages(): Record<string, any>[] {
  return readFileSync(new URL("fixtures/claude/tasks.messages.jsonl", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function todoRows(events: ProviderEvent[]): Extract<ProviderEvent, { type: "tool.start" | "tool.end" }>[] {
  return events.filter((event): event is Extract<ProviderEvent, { type: "tool.start" | "tool.end" }> => (event.type === "tool.start" || event.type === "tool.end") && event.name === "todo");
}

test("the recorded turn has the task tools and no TodoWrite", () => {
  const init = messages().find((message) => message.type === "system" && message.subtype === "init")!;
  for (const tool of ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]) assert.ok(init.tools.includes(tool), tool);
  assert.ok(!init.tools.includes("TodoWrite"));
});

test("each TaskCreate and TaskUpdate is a to-do row with the whole list, as TodoWrite's are", () => {
  const stream = new ClaudeStream({ cwd, now: () => 0 });
  const events = messages().flatMap((message) => stream.map(message as Parameters<ClaudeStream["map"]>[0]));
  const ends = todoRows(events).filter((event) => event.type === "tool.end");
  // Two tasks made, then each marked in progress and done: six rows.
  assert.equal(ends.length, 6);
  const lists = ends.map((event) => (event.args.todos as { id: string; content: string; status: string }[]).map((todo) => `${todo.id}:${todo.status}`).join(" "));
  assert.deepEqual(lists, [
    "1:pending",
    "1:pending 2:pending",
    "1:in_progress 2:pending",
    "1:completed 2:pending",
    "1:completed 2:in_progress",
    "1:completed 2:completed",
  ]);
  // As TodoWrite's: `content`, `status`, the wording as it runs, a count for its label, a list for its result.
  assert.deepEqual(ends[2]!.args.todos, [
    { id: "1", content: "Read a.txt", status: "in_progress", activeForm: "Reading a.txt" },
    { id: "2", content: "Read b.txt", status: "pending", activeForm: "Reading b.txt" },
  ]);
  assert.equal(ends[3]!.context, "1 of 2 done");
  assert.deepEqual(ends[5]!.type === "tool.end" && ends[5]!.result, { output: "✓ Read a.txt\n✓ Read b.txt" });
  // The row starts with the list as the call will leave it: a task made has no id yet.
  const starts = todoRows(events).filter((event) => event.type === "tool.start");
  assert.deepEqual(starts[0]!.args.todos, [{ id: "", content: "Read a.txt", status: "pending", activeForm: "Reading a.txt" }]);
  assert.equal((starts[2]!.args.todos as { status: string }[])[0]!.status, "in_progress");
  // The other tools are rows of their own, as before.
  assert.ok(events.some((event) => event.type === "tool.start" && event.name === "read_file"));
});

test("history gives the same rows, and a session read back goes on with its list", () => {
  // As Claude Code stores a session: the same messages, with no structured results.
  const stored = historyFromSession(messages().filter((message) => message.type === "assistant" || message.type === "user").map(({ tool_use_result: _, ...message }) => message), cwd);
  const rows = stored.filter((message): message is Extract<StoredMessage, { role: "tool" }> => message.role === "tool" && message.name === "todo");
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[4]!.args, {
    todos: [
      { id: "1", content: "Read a.txt", status: "completed", activeForm: "Reading a.txt" },
      { id: "2", content: "Read b.txt", status: "in_progress", activeForm: "Reading b.txt" },
    ],
  });
  // The bridge loads the session again (a restart): the next update knows the tasks.
  const todos = ClaudeTodos.from(stored);
  const stream = new ClaudeStream({ cwd, now: () => 0, todos });
  stream.map({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "u", name: "TaskUpdate", input: { taskId: "2", status: "pending", activeForm: "Reading b.txt again" } }] } } as never);
  const [end] = stream.map({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u", content: "Updated task #2 status" }] } } as never);
  assert.deepEqual(end!.type === "tool.end" && end!.args.todos, [
    { id: "1", content: "Read a.txt", status: "completed", activeForm: "Reading a.txt" },
    { id: "2", content: "Read b.txt", status: "pending", activeForm: "Reading b.txt again" },
  ]);
});

test("Claude Code's summaries of its runs of calls are headlines, with the calls they sum up", () => {
  const stream = new ClaudeStream({ cwd, now: () => 0 });
  const events = messages().flatMap((message) => stream.map(message as Parameters<ClaudeStream["map"]>[0]));
  const headlines = events.filter((event): event is Extract<ProviderEvent, { type: "headline" }> => event.type === "headline");
  assert.deepEqual(headlines.map((event) => event.text), [
    "Loaded TaskCreate and TaskUpdate",
    "Created tasks for a.txt, b.txt",
    "Marked task #1 in progress",
    "Read a.txt",
    "Completed task #1, started #2",
    "Read b.txt",
    "Marked task #2 completed",
  ]);
  assert.deepEqual(headlines[1]!.toolIds, ["toolu_01RHu5YuVdYQpEJ9mAUbABqr", "toolu_015QXKZVVU7pTbY4pyqe3wMU"]);
  // One with nothing to say says nothing.
  assert.deepEqual(stream.map({ type: "tool_use_summary", summary: "  ", preceding_tool_use_ids: [] } as never), []);
});

test("a failed or denied call leaves the list, a deleted task goes, TaskList's answer is the list", () => {
  const todos = new ClaudeTodos();
  const ok = (structured: unknown, content = "ok") => ({ content, isError: false, structured });
  todos.finished("TaskCreate", { subject: "A" }, ok({ task: { id: "1", subject: "A" } }));
  todos.finished("TaskCreate", { subject: "B", activeForm: "Doing B" }, ok(undefined, "Task #2 created successfully: B"));
  assert.deepEqual(todos.list.map((todo) => todo.id), ["1", "2"]);
  const failed = todos.finished("TaskUpdate", { taskId: "1", status: "completed" }, ok({ success: false, error: "no such task" }, "Task not found"));
  assert.deepEqual(failed?.result, { error: "Task not found" });
  assert.equal(todos.list[0]!.status, "pending");
  todos.finished("TaskUpdate", { taskId: "1", status: "completed" }, { content: "Denied from Portals.", isError: true, denied: true });
  assert.equal(todos.list[0]!.status, "pending");
  todos.finished("TaskUpdate", { taskId: "1", status: "deleted" }, ok({ success: true }));
  assert.deepEqual(todos.list.map((todo) => todo.id), ["2"]);
  // TaskList's row stays its own; its answer replaces the list, keeping each one's wording.
  assert.equal(todos.finished("TaskList", {}, ok({ tasks: [{ id: "2", subject: "B", status: "in_progress", blockedBy: [] }, { id: "3", subject: "C", status: "pending", blockedBy: [] }] })), null);
  assert.deepEqual(todos.list, [
    { id: "2", content: "B", status: "in_progress", activeForm: "Doing B" },
    { id: "3", content: "C", status: "pending" },
  ]);
  // Not one of these tools: no row of the list's.
  assert.equal(todos.started("Read", { file_path: "/tmp/a" }), null);
  assert.equal(todos.finished("Read", { file_path: "/tmp/a" }, ok(undefined)), null);
  // In history, with no structured result: an update that did not take says so only in words.
  const read = new ClaudeTodos();
  const said = (content: string) => ({ content, isError: false });
  read.finished("TaskCreate", { subject: "A" }, said("Task #1 created successfully: A"));
  read.finished("TaskUpdate", { taskId: "99", status: "completed" }, said("Task #99 not found"));
  read.finished("TaskUpdate", { taskId: "1", status: "in_progress" }, said("Updated task #1 status"));
  assert.deepEqual(read.list, [{ id: "1", content: "A", status: "in_progress" }]);
  // TaskList's words: the list as Claude Code has it, a task made elsewhere with it.
  read.finished("TaskList", {}, said("#1 [completed] A\n#2 [pending] B made by a teammate [blocked by #1]"));
  assert.deepEqual(read.list, [
    { id: "1", content: "A", status: "completed" },
    { id: "2", content: "B made by a teammate", status: "pending" },
  ]);
  // A subject renamed longer is the new one, from either shape; an owner after it is not.
  read.finished("TaskUpdate", { taskId: "1", subject: "Run" }, said("Updated task #1 subject"));
  read.finished("TaskList", {}, said("#1 [completed] Run tests\n#2 [pending] B made by a teammate (agent-7) [blocked by #1]"));
  assert.deepEqual(read.list.map((todo) => todo.content), ["Run tests", "B made by a teammate"]);
  read.finished("TaskList", {}, { content: "", isError: false, structured: { tasks: [{ id: "1", subject: "Run tests well", status: "completed", blockedBy: [] }, { id: "2", subject: "B made by a teammate (v2)", status: "pending", blockedBy: [] }] } });
  assert.deepEqual(read.list.map((todo) => todo.content), ["Run tests well", "B made by a teammate (v2)"]);
  read.finished("TaskList", {}, said("Something else entirely"));
  assert.equal(read.list.length, 2);
  read.finished("TaskList", {}, said("No tasks found"));
  assert.deepEqual(read.list, []);
  // A session whose last list came from TodoWrite (no ids) starts the task tools' list anew.
  const stored: StoredMessage[] = [{ role: "tool", name: "todo", args: { todos: [{ content: "x", status: "pending" }] }, content: "{}", tool_call_id: "t", timestamp: 0 }];
  assert.deepEqual(ClaudeTodos.from(stored).list, []);
});
