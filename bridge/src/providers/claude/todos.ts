import type { StoredMessage } from "../types.ts";
import { contentText, type GatewayTool, type ToolOutcome } from "./tools.ts";

// Claude Code's to-do list as its task tools keep it, as the `todo` rows TodoWrite gives:
// each TaskCreate and TaskUpdate call is a row with the whole list as that call leaves it
// (`content`, `status`, `activeForm`, and the task's `id`), so the app shows the same
// checklist and "Step 2 of 5" whichever tool Claude Code keeps its list with.
//
// Claude Code 2.1.299 gives a session to-do tools only for the models it lists (Claude 3,
// Opus 4.0 to 4.7, Sonnet 4.0 to 4.6, Haiku 4.5) or when its tools are named at launch,
// and then the task tools (TaskCreate, TaskGet, TaskUpdate, TaskList) unless
// CLAUDE_CODE_ENABLE_TASKS is false, which gives TodoWrite instead; Opus 5.5 has neither
// (read in its code and seen in a turn of each, 2026-10-26). A task's id comes in the
// result of the call that made it ("Task #1 created successfully: …"); an update names it,
// and says whether it took ("Updated task #1 status", else "Task #1 not found" or why, with
// no error flag: Claude Code 2.1.299's own words, read in its code). TaskList's answer says
// the list as Claude Code has it ("#1 [completed] Read a.txt", a line a task), which is
// taken as it is, live and in history alike.
// One list a session, read again from its history when the bridge loads it (`from`).

type Status = "pending" | "in_progress" | "completed";

export interface Todo {
  id: string;
  content: string;
  status: Status;
  activeForm?: string;
}

/** The tools that change the list. */
const changing = new Set(["TaskCreate", "TaskUpdate"]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function status(value: unknown): Status | undefined {
  return value === "pending" || value === "in_progress" || value === "completed" ? value : undefined;
}

export class ClaudeTodos {
  private tasks: Todo[] = [];

  /** The list as the last `todo` row the bridge made of these tools left it, in a session read back. */
  static from(stored: readonly StoredMessage[]): ClaudeTodos {
    const todos = new ClaudeTodos();
    for (let index = stored.length - 1; index >= 0; index -= 1) {
      const message = stored[index]!;
      if (message.role !== "tool" || message.name !== "todo") continue;
      const items = Array.isArray(message.args?.todos) ? (message.args.todos as unknown[]) : [];
      // TodoWrite's rows have no ids: nothing of the task tools' list to take up.
      if (!items.every((item) => text(record(item)?.id) !== undefined)) return todos;
      todos.tasks = items.map((item) => {
        const entry = record(item)!;
        const active = text(entry.activeForm);
        return { id: text(entry.id)!, content: text(entry.content) ?? "", status: status(entry.status) ?? "pending", ...(active ? { activeForm: active } : {}) };
      });
      return todos;
    }
    return todos;
  }

  /** The list now. */
  get list(): readonly Todo[] {
    return this.tasks;
  }

  /** A call of `name` starts: the row for one that changes the list, with the list as it would leave it; null for any other tool. */
  started(name: string, input: Record<string, unknown>): GatewayTool | null {
    if (!changing.has(name)) return null;
    return row(name === "TaskCreate" ? [...this.tasks, created(input, "")] : updated(this.tasks, input));
  }

  /**
   * The call's result: its row with the list as it left it, and the result the app reads
   * for a to-do row. Null for a tool that is not one of these; TaskList's answer is taken
   * as the list (when Claude Code's structured result says it), its row left as it is.
   */
  finished(name: string, input: Record<string, unknown>, outcome: ToolOutcome): { tool: GatewayTool; result: unknown } | null {
    if (name === "TaskList") {
      this.listed(outcome);
      return null;
    }
    if (!changing.has(name)) return null;
    const said = contentText(outcome.content);
    const structured = record(outcome.structured);
    // An update that did not take says so in words only (history keeps no structured result).
    const refused = name === "TaskUpdate" && (structured ? structured.success === false : !/^Updated task #/.test(said));
    const failed = outcome.isError || outcome.denied === true || refused;
    if (!failed) {
      if (name === "TaskCreate") {
        const id = text(record(structured?.task)?.id) ?? /Task #(\S+) created/.exec(said)?.[1];
        if (id !== undefined) this.tasks = [...this.tasks, created(input, id)];
      } else {
        this.tasks = updated(this.tasks, input);
      }
    }
    const tool = row(this.tasks);
    if (failed) return { tool, result: { error: said || "The task list was not changed." } };
    return { tool, result: { output: this.tasks.map((todo) => `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "→" : "○"} ${todo.content}`).join("\n") } };
  }

  /**
   * TaskList's answer, the whole list as Claude Code keeps it: from its structured result
   * live, else from its words ("#2 [in_progress] Read b.txt", with " [blocked by #1]" after
   * a blocked one; "No tasks found"). What each task is worded as running is kept from before.
   */
  private listed(outcome: ToolOutcome): void {
    if (outcome.isError) return;
    const structured = record(outcome.structured)?.tasks;
    const said = contentText(outcome.content).trim();
    // `worded`: read from the words, where an owner may follow the subject ("A (agent)").
    let tasks: { id: string; subject?: string; status?: Status; worded?: true }[];
    if (Array.isArray(structured)) {
      tasks = structured.flatMap((task) => {
        const entry = record(task);
        const id = text(entry?.id);
        return entry && id !== undefined ? [{ id, subject: text(entry.subject), status: status(entry.status) }] : [];
      });
    } else if (said === "No tasks found") {
      tasks = [];
    } else {
      const lines = said.split("\n").filter((line) => line.trim() !== "");
      const read = lines.map((line) => /^#(\S+) \[(pending|in_progress|completed)\] (.*?)(?: \[blocked by [^\]]*\])?$/.exec(line.trim()));
      // Words that are not the list (another version's) leave the list as it was.
      if (read.length === 0 || read.some((match) => match === null)) return;
      tasks = read.map((match) => ({ id: match![1]!, subject: text(match![3]), status: status(match![2]), worded: true as const }));
    }
    const known = new Map(this.tasks.map((todo) => [todo.id, todo]));
    this.tasks = tasks.map(({ id, subject, status: now, worded }) => {
      const before = known.get(id);
      const active = before?.activeForm;
      // The subject as Claude Code has it now; from its words, the one known where they only
      // add an owner after it ("A (agent)"), not a subject renamed longer ("Run" to "Run tests").
      const owned = worded && before && subject !== undefined && /^ \([^()]*\)$/.test(subject.slice(before.content.length)) && subject.startsWith(before.content);
      const content = owned ? before.content : (subject ?? before?.content ?? `Task #${id}`);
      return { id, content, status: now ?? "pending", ...(active ? { activeForm: active } : {}) };
    });
  }
}

function created(input: Record<string, unknown>, id: string): Todo {
  const active = text(input.activeForm);
  return { id, content: text(input.subject) ?? "A task", status: "pending", ...(active ? { activeForm: active } : {}) };
}

/** The list with a TaskUpdate's changes: its subject, status and wording as it runs; `deleted` takes the task off. */
function updated(tasks: readonly Todo[], input: Record<string, unknown>): Todo[] {
  const id = text(input.taskId);
  if (id === undefined) return [...tasks];
  if (input.status === "deleted") return tasks.filter((todo) => todo.id !== id);
  const subject = text(input.subject);
  const active = text(input.activeForm);
  const next = status(input.status);
  const change = (todo: Todo): Todo => ({
    ...todo,
    ...(subject ? { content: subject } : {}),
    ...(next ? { status: next } : {}),
    ...(active ? { activeForm: active } : {}),
  });
  // One the list does not know yet (made before what the bridge has read of the session).
  if (!tasks.some((todo) => todo.id === id)) return [...tasks, change({ id, content: subject ?? `Task #${id}`, status: "pending" })];
  return tasks.map((todo) => (todo.id === id ? change(todo) : todo));
}

/** The `todo` row of a list: as TodoWrite's, with each task's id. */
function row(tasks: readonly Todo[]): GatewayTool {
  const done = tasks.filter((todo) => todo.status === "completed").length;
  return { name: "todo", args: { todos: tasks.map((todo) => ({ ...todo })) }, context: `${done} of ${tasks.length} done` };
}
