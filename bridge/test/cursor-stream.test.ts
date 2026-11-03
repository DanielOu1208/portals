import "./environment.ts";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { machineWord } from "../src/platform.ts";
import type { ConfigOption } from "../src/providers/acp/protocol.ts";
import { AcpStream } from "../src/providers/acp/stream.ts";
import type { ToolCall } from "../src/providers/acp/tools.ts";
import { cursorCatalog, cursorID, levelAt, levelSetting, levelsOf, listedModels, modelAt, sessionModels } from "../src/providers/cursor/models.ts";
import { cursorMode, cursorQuirks } from "../src/providers/cursor/options.ts";
import {
  chosenOptions,
  isCursorRequest,
  mergedTodos,
  permissionCard,
  permissionOutcome,
  planCard,
  planOutcome,
  questionCard,
  questionOutcome,
  todoRow,
  unplacedAnswer,
  type Todo,
} from "../src/providers/cursor/requests.ts";
import { CursorSubagents } from "../src/providers/cursor/subagents.ts";
import { commandLeftText, cursorTools } from "../src/providers/cursor/tools.ts";
import type { ProviderEvent, RequestAnswer, SubagentInfo } from "../src/providers/types.ts";

// Golden tests: what the real Cursor sent (test/fixtures/cursor, recorded from Cursor
// 2026.10.01 on 2026-10-12 by scripts/record-cursor.ts, its folders and ids replaced)
// through the mapper and the cards, with no Cursor running. Each `<name>.events.json` is
// what they made of `<name>.jsonl` when it was last checked by hand; UPDATE_GOLDEN=1
// rewrites them after a deliberate change.
//
// A recording holds every message both ways. Read from one here: the `session/update`
// notifications in order; each request of Cursor's with the answer the recorder gave
// it; and Cursor's answer to each `session/prompt`, as a turn's end. What Cursor sends
// again while it loads a session (between `session/load` and its answer) is let pass,
// as the provider does.
//
// The pieces the provider is made of are tested below the recordings: Cursor's tool
// table, the answers to a question each way, its models, and the to-do list.

const cwd = "/tmp/portals-cwd";
const fixtures = new URL("fixtures/cursor/", import.meta.url);

interface Line {
  kind: string;
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
  signal?: string;
}

function recording(name: string): Line[] {
  return readFileSync(new URL(`${name}.jsonl`, fixtures), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Line);
}

/** What a recording comes to, beside the events: the messages sent, the titles, and the cards with how they were answered. */
type Recorded =
  | ProviderEvent
  | { type: "prompt"; text: string }
  | { type: "approval"; command: string; description?: string; choices: string[]; answered: string }
  | { type: "plan card"; command: string; answered: string }
  | { type: "clarify"; questions: unknown; answered: string }
  | { type: "process ended" }
  | { type: "subagent line"; id: string; status: string; goal: string; role?: string; background: boolean; summary?: string; tool?: string; toolUses?: number; result?: string; parent?: string };

function replay(name: string): Recorded[] {
  const answers = new Map<string, string[]>();
  const quirks = { ...cursorQuirks, own: cursorTools(answers) };
  let id = 0;
  const stream = new AcpStream({ cwd, quirks, newID: () => String(++id), now: () => 0 });
  // As the provider does: a subagent's session is its thread's, and none of it is reply.
  const subagents = new CursorSubagents(quirks.own, () => 0);
  const children = new Set<string>();
  const subagent = (info: SubagentInfo | null) => {
    if (!info) return;
    const { id: agent, status, goal, role, background, summary, tool, toolUses, result, parent } = info;
    events.push({ type: "subagent line", id: agent, status, goal, background, ...(role ? { role } : {}), ...(summary ? { summary } : {}), ...(tool ? { tool } : {}), ...(toolUses ? { toolUses } : {}), ...(result ? { result } : {}), ...(parent ? { parent } : {}) });
  };
  const events: Recorded[] = [];
  const lines = recording(name);
  let todos: Todo[] = [];
  let loading = false;
  /** Prompts Cursor has not answered. */
  let open = 0;
  const endTurn = (status: "complete" | "interrupted" | "error") => {
    events.push(...stream.endTurn());
    for (const info of subagents.stopAll()) subagent(info);
    events.push({ type: "turn.end", status });
  };
  for (const [index, line] of lines.entries()) {
    switch (line.kind) {
      case "send":
        if (line.method === "session/load") loading = true;
        if (line.method === "session/prompt") {
          open += 1;
          events.push({ type: "prompt", text: line.params.prompt.map((block: { type: string; text?: string }) => (block.type === "text" ? block.text : `[${block.type}]`)).join(" ") });
        }
        break;
      case "response":
        if (line.method === "session/load") loading = false;
        if (line.method === "session/prompt") {
          open -= 1;
          endTurn(line.result?.stopReason === "cancelled" ? "interrupted" : "complete");
        }
        break;
      case "notification": {
        const update = line.params?.update;
        if (line.method !== "session/update" || loading || !update) break;
        const from: string = line.params.sessionId;
        if (update.sessionUpdate === "subagent_spawned") {
          children.add(update.subagentSessionId);
          subagent(subagents.spawned(update, from));
        } else if (update.sessionUpdate === "subagent_state_update") subagent(subagents.state(update));
        else if (children.has(from)) {
          subagent(subagents.update(from, update));
          subagent(subagents.parentCall(update));
        } else if (update.sessionUpdate === "session_info_update") events.push({ type: "title", title: update.title });
        else {
          subagent(subagents.parentCall(update));
          events.push(...stream.map(update));
        }
        break;
      }
      case "request": {
        // Cursor numbers its requests from 0 in each process: the answer is the next one with that number.
        const answer = lines.slice(index).find((later) => later.kind === "answer" && later.id === line.id);
        const outcome = answer?.result?.outcome;
        if (line.method === "session/request_permission") {
          const options = line.params.options;
          const asked = stream.asked(line.params.toolCall);
          const card = permissionCard(line.params.toolCall, options, asked.call, asked.tool, asked.announced, cwd, quirks);
          assert.equal(card.kind, "approval");
          if (card.kind !== "approval") break;
          // The recorder allows only in permission-allowed (once, never always); elsewhere it denies.
          const choice = outcome?.outcome !== "selected" ? "withdrawn" : outcome.optionId === "allow-once" ? "once" : "deny";
          assert.deepEqual(permissionOutcome(options, choice === "withdrawn" ? { kind: "withdrawn", reason: "interrupted" } : { kind: "approval", choice }), answer?.result);
          if (choice === "deny") stream.denied(asked.call.toolCallId);
          if (choice === "once") stream.allowed(asked.call.toolCallId);
          events.push(...asked.events, { type: "approval", command: card.command, description: card.description, choices: card.choices, answered: choice });
        } else if (line.method === "cursor/create_plan") {
          const card = planCard(line.params);
          if (card.kind === "approval") events.push({ type: "plan card", command: card.command, answered: outcome?.outcome === "rejected" ? `rejected: ${outcome.reason}` : String(outcome?.outcome) });
        } else if (line.method === "cursor/update_todos") {
          todos = mergedTodos(todos, line.params);
          const { tool, result } = todoRow(todos);
          const row = { id: line.params.toolCallId, name: tool.name, args: tool.args, context: tool.context };
          events.push({ type: "tool.start", ...row }, { type: "tool.end", ...row, result });
        } else if (line.method !== "cursor/task") {
          // cursor/task tells of a Task the line already shows.
          assert.fail(`${name}: a request the test does not know, ${line.method}`);
        }
        break;
      }
      case "exit":
        // The process ended with a turn open: the recorder stopped or killed it.
        if (open > 0) {
          open = 0;
          events.push({ type: "process ended" });
          endTurn("error");
        }
        break;
      default:
        break;
    }
  }
  return events;
}

/** Runs of text and reasoning joined, so the golden files read as sentences. */
function joined(events: Recorded[]): Recorded[] {
  const out: Recorded[] = [];
  for (const event of events) {
    const last = out.at(-1);
    if ((event.type === "text" || event.type === "reasoning") && last?.type === event.type) out[out.length - 1] = { ...last, text: last.text + event.text };
    else out.push(event);
  }
  return out;
}

const names = readdirSync(fixtures)
  .filter((file) => file.endsWith(".jsonl"))
  .map((file) => file.slice(0, -".jsonl".length))
  .sort();
/** The recordings that hold no turn: tested for what they do hold, further down. */
const noTurn = ["load-unused", "models"];

test("every recording is one this test knows", () => {
  assert.equal(names.length, 27);
  for (const name of noTurn) assert.ok(names.includes(name));
});

for (const name of names.filter((entry) => !noTurn.includes(entry))) {
  test(`${name}: the recording maps to its golden events`, () => {
    const events = joined(replay(name));
    assert.ok(events.some((event) => event.type === "turn.end"), "the recording holds no turn");
    const golden = new URL(`${name}.events.json`, fixtures);
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) writeFileSync(golden, JSON.stringify(events, null, 1) + "\n");
    // Recorded on a Mac: what the bridge says of the machine, as this one says it.
    assert.deepEqual(JSON.parse(JSON.stringify(events)), JSON.parse(readFileSync(golden, "utf8").replaceAll("on the Mac", `on the ${machineWord()}`)));
  });
}

function ends(events: Recorded[]): Extract<ProviderEvent, { type: "tool.end" }>[] {
  return events.filter((event): event is Extract<ProviderEvent, { type: "tool.end" }> => event.type === "tool.end");
}

function said(events: Recorded[]): string {
  return events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");
}

// MARK: What the recordings show

test("plain: the reply without the line Cursor ends a turn with, and Cursor's title for the session", () => {
  const events = replay("plain");
  assert.equal(said(events), "17 times 3 is 51.");
  assert.deepEqual(events.filter((event) => event.type === "title"), [{ type: "title", title: "Math Problem Solver" }]);
  assert.deepEqual(events.at(-1), { type: "turn.end", status: "complete" });
});

test("tools: a read, an edit of an existing file as a real diff, a command, and a command that failed by its exit code", () => {
  const rows = ends(replay("tools"));
  assert.deepEqual(
    rows.map((row) => [row.name, row.result]),
    [
      ["read_file", { content: "hi\n" }],
      ["patch", { success: true, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n" }],
      ["terminal", { output: "       6 hello.txt\n", exit_code: 0 }],
      ["terminal", { output: "ls: no-such-file.txt: No such file or directory\n", exit_code: 1 }],
    ],
  );
  // Tool call ids as Cursor makes them, with a newline in them.
  assert.ok(rows.every((row) => /^call-[0-9a-f-]+-\d\nfc_/.test(row.id)));
});

test("cancel-command, stopped and killed: a command Cursor says nothing more of closes with what is not known of it", () => {
  for (const name of ["cancel-command", "stopped", "killed"]) {
    const rows = ends(replay(name));
    assert.deepEqual(
      rows.map((row) => [row.name, row.args, row.result]),
      [["terminal", { command: "sleep 47" }, { status: "error", error: commandLeftText }]],
      name,
    );
  }
  assert.deepEqual(replay("cancel-command").at(-1), { type: "turn.end", status: "interrupted" });
});

test("second-prompt: Cursor answers the running prompt cancelled when another comes, then runs the other", () => {
  const events = replay("second-prompt");
  assert.deepEqual(
    events.filter((event) => event.type === "prompt" || event.type === "turn.end").map((event) => (event.type === "turn.end" ? event.status : event.type)),
    ["prompt", "prompt", "interrupted", "complete"],
  );
  assert.ok(said(events).endsWith("banana"));
});

test("load: what Cursor sends again as it loads a session is let pass, and the next turn is mapped", () => {
  const events = replay("load");
  // The first turn's two rows once, not a second time under their replay ids.
  assert.deepEqual(ends(events).map((row) => row.name), ["read_file", "terminal"]);
  assert.ok(!events.some((event) => (event.type === "tool.start" || event.type === "tool.end") && event.id.startsWith("replay-")));
  assert.ok(said(events).endsWith("The file had 3 bytes."));
});

test("plan and plan-rejected: the plan's steps as a to-do row, the plan as a card, and its own tool call as no row", () => {
  const events = replay("plan");
  const first = events.findIndex((event) => event.type === "plan card");
  assert.deepEqual(events[first], {
    type: "plan card",
    command:
      "Add notes.txt\n\nAdd a new file notes.txt in the workspace root containing the single word hello.\n\n# Add notes.txt with hello\n\n1. Create [`notes.txt`](/tmp/portals-cwd/notes.txt) at the workspace root.\n2. Write the contents as exactly `hello` (no extra lines or wording).",
    answered: "accepted",
  });
  const todo = events[first - 1];
  assert.equal(todo.type, "tool.end");
  assert.deepEqual(todo.type === "tool.end" && [todo.name, todo.context, todo.result], ["todo", "0 of 2 done", { output: "○ Create notes.txt at workspace root\n○ Write exactly hello into notes.txt" }]);
  // The turn ends on the accepted plan with nothing more said; the next prompt carries it out.
  assert.deepEqual(events.slice(first + 1, first + 3), [
    { type: "turn.end", status: "complete" },
    { type: "prompt", text: "Go ahead with the plan." },
  ]);
  // A file made new, told with the scraps of a diff's header lines.
  assert.deepEqual(ends(events).at(-1)?.result, { success: true, diff: "--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+hello\n" });
  assert.ok(!events.some((event) => (event.type === "tool.start" || event.type === "tool.end") && event.name === "tool"));

  const cards = replay("plan-rejected").filter((event) => event.type === "plan card");
  assert.deepEqual(cards.map((card) => card.type === "plan card" && card.answered), ["rejected: Make it one step, not two.", "accepted"]);
});

test("todos: the to-do tool's own calls are no rows, and each of its four requests shows the whole list", () => {
  const rows = ends(replay("todos")).filter((row) => row.name === "todo");
  assert.deepEqual(
    rows.map((row) => [row.context, (row.result as { output: string }).output]),
    [
      ["0 of 3 done", "→ make a.txt\n○ make b.txt\n○ make c.txt"],
      ["1 of 3 done", "✓ make a.txt\n→ make b.txt\n○ make c.txt"],
      ["2 of 3 done", "✓ make a.txt\n✓ make b.txt\n→ make c.txt"],
      ["3 of 3 done", "✓ make a.txt\n✓ make b.txt\n✓ make c.txt"],
    ],
  );
  // Besides them, the three files made: nothing for "Update TODOs". (The model marks an
  // item done while its file's edit is still open, so each edit ends after its to-do.)
  assert.deepEqual(ends(replay("todos")).map((row) => row.name), ["todo", "todo", "patch", "todo", "patch", "todo", "patch"]);
});

test("permission: a web search asked about under an id of its own is a card with Cursor's title and no row; refused, the search's row is blocked", () => {
  const events = replay("permission");
  const card = events.find((event) => event.type === "approval");
  assert.deepEqual(card, {
    type: "approval",
    command: "Web search: agent client protocol",
    description: "Cursor wants to search the web",
    choices: ["once", "always", "deny"],
    answered: "deny",
  });
  assert.ok(!events.some((event) => (event.type === "tool.start" || event.type === "tool.end") && event.id.startsWith("web_search")));
  const search = ends(events).find((row) => row.name === "web_search");
  assert.deepEqual([search?.args, search?.result], [{ query: "agent client protocol" }, { status: "blocked", error: "User rejected", user_summary: "You denied this — it did not run." }]);
  // The command beside it ran without a question.
  assert.deepEqual(ends(events).find((row) => row.name === "terminal")?.result, { output: "", exit_code: 0 });

  // Stopped while the card is open. Cursor 2026.10.22 tells of the search first, under the
  // call's own id (2026.10.01 asked before telling of it); the row ends as stopped.
  const stopped = replay("permission-stopped");
  assert.deepEqual(stopped.filter((event) => event.type === "approval" || event.type === "tool.start").map((event) => event.type), ["tool.start", "approval"]);
  assert.equal((ends(stopped).find((row) => row.name === "web_search")?.result as { status?: string } | undefined)?.status, "error");
  assert.deepEqual(stopped.at(-1), { type: "turn.end", status: "interrupted" });
});

test("image, switch-mode: the model reads an image with its read tool, and its own switch of mode is a row", () => {
  const read = ends(replay("image"))[0];
  assert.equal(read.name, "read_file");
  assert.match(String(read.args.path), /\/assets\/[0-9a-f-]+\.png$/);
  const switched = ends(replay("switch-mode"))[0];
  assert.deepEqual([switched.name, switched.context, switched.args], ["switch_mode", "Switch Mode: plan", { mode: "plan", explanation: "User asked to switch this session to plan mode." }]);
});

test("subagent, subagent-background, subagent-cancel: each subagent on the line by its Task's description, none of what it says in the reply", () => {
  const lines = (name: string) => replay(name).flatMap((event) => (event.type === "subagent line" ? [event] : []));
  const waited = lines("subagent");
  assert.deepEqual([waited[0]?.goal, waited[0]?.role, waited[0]?.status, waited[0]?.background], ["Count folder files", "General purpose", "running", false]);
  const end = waited.at(-1);
  assert.deepEqual([end?.status, end?.tool, end?.toolUses], ["completed", "terminal", 1]);
  assert.match(String(end?.result), /3/);
  // Its command and its words are its own.
  assert.ok(!ends(replay("subagent")).some((row) => row.name === "terminal"));
  assert.ok(!said(replay("subagent")).includes("File paths"));

  // Its Task completes while it is still at work: it was left in the background, and the turn ends after it.
  const left = lines("subagent-background");
  assert.deepEqual(left.map((event) => [event.status, event.background]), [["running", false], ["running", true], ["running", true], ["completed", true]]);
  assert.equal(left.at(-1)?.result, "finished");
  assert.deepEqual(replay("subagent-background").at(-1), { type: "turn.end", status: "complete" });

  // Stopped with the turn: Cursor says it was cancelled.
  assert.deepEqual(lines("subagent-cancel").at(-1)?.status, "stopped");
  assert.deepEqual(replay("subagent-cancel").at(-1), { type: "turn.end", status: "interrupted" });
});

test("fork-copy: a copy of a session's folder under a new id is loaded as that session, and goes on from its conversation", () => {
  const lines = recording("fork-copy");
  const load = lines.find((line) => line.kind === "send" && line.method === "session/load");
  const loaded = lines.find((line) => line.kind === "response" && line.method === "session/load");
  assert.ok(load && loaded?.result, "the copy loads");
  const original = lines.find((line) => line.kind === "response" && line.method === "session/new")?.result.sessionId;
  assert.notEqual(load.params.sessionId, original);
  assert.ok(said(replay("fork-copy")).toLowerCase().includes("kumquat"));
});

test("mention: Cursor reads a file sent as a resource_link itself, with no read of its own", () => {
  const events = replay("mention");
  assert.equal(said(events), "quince");
  assert.deepEqual(ends(events), []);
});

test("a subagent's line keeps only the start of what it says, and lets go of its calls once it has ended", () => {
  let now = 0;
  const board = new CursorSubagents(undefined, () => now);
  board.spawned({ sessionUpdate: "subagent_spawned", subagentSessionId: "s", name: "explore", task: "Look" }, "parent");
  board.update("s", { sessionUpdate: "tool_call", toolCallId: "c", kind: "execute", title: "`ls`", rawInput: { command: "ls" }, rawOutput: { stdout: "x".repeat(1_000_000) } });
  assert.ok(board.call("s", "c"));
  // A long answer, a piece at a time: what is kept stops growing, and each piece costs the same.
  const piece = "word ".repeat(200);
  const started = performance.now();
  for (let index = 0; index < 2000; index += 1) {
    now += 10;
    board.update("s", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } });
  }
  assert.ok(performance.now() - started < 1000, "2 MB of reply in under a second");
  const ended = board.state({ sessionUpdate: "subagent_state_update", subagentSessionId: "s", state: "completed" });
  assert.equal(ended?.status, "completed");
  assert.ok((ended?.result?.length ?? 0) <= 2001);
  assert.equal(ended?.role, "Explore");
  assert.equal(board.call("s", "c"), undefined);
  assert.equal(board.running("s"), false);
});

test("load-unused: a session that never got a message cannot be loaded, which Cursor says with -32602", () => {
  const answer = recording("load-unused").find((line) => line.kind === "response" && line.method === "session/load");
  assert.equal(answer?.error?.code, -32602);
  assert.deepEqual(answer?.error?.data, { message: 'Session "00000000-0000-4000-8000-000000000001" not found' });
});

// MARK: Cursor's tool table

function tool(fields: Partial<ToolCall>) {
  const own = cursorTools(new Map());
  const call: ToolCall = { toolCallId: "t", status: "completed", ...fields };
  return { hidden: own.hidden!(call), tool: own.tool!(call), call, own };
}

test("Cursor's tools are told apart by what they were given, where their kind does not say", () => {
  assert.deepEqual(tool({ kind: "search", title: 'Web Search: "acp"', rawInput: { searchTerm: "acp" } }).tool, { name: "web_search", args: { query: "acp" } });
  // Before the search term is known the title says it is one.
  assert.deepEqual(tool({ kind: "search", title: "Web Search", rawInput: {} }).tool, { name: "web_search", args: {}, context: "Web Search" });
  assert.deepEqual(tool({ kind: "other", title: "Task: Look around", rawInput: { _toolName: "task", prompt: "List the files.", description: "Look around", subagentType: "explore" } }).tool, {
    name: "delegate_task",
    args: { task: "List the files.", agent: "explore" },
    context: "Look around",
  });
  assert.deepEqual(tool({ kind: "other", title: "Generate Image: A red square...", rawInput: { _toolName: "generateImage", description: "A red square", filename: "x.png" } }).tool, {
    name: "image_generate",
    args: { prompt: "A red square" },
  });
  assert.deepEqual(tool({ kind: "switch_mode", title: "Switch Mode: ask", rawInput: { targetModeId: "ask" } }).tool, { name: "switch_mode", args: { mode: "ask" }, context: "Switch Mode: ask" });
  assert.deepEqual(tool({ kind: "other", title: "notes: add_note", rawInput: { providerIdentifier: "notes", toolName: "add_note", args: { text: "x" } } }).tool, {
    name: "add_note",
    args: { text: "x" },
    context: "notes: add_note",
  });
  const questions = [{ id: "q", prompt: "Which language?", options: [{ id: "py", label: "Python" }], allowMultiple: false }];
  assert.deepEqual(tool({ kind: "think", title: "Language", rawInput: { _toolName: "askQuestion", title: "Language", questions } }).tool, {
    name: "clarify",
    args: { questions: [{ question: "Which language?", choices: ["Python"] }] },
  });
  // The rest is left to the call's kind: a grep, a read, a command.
  for (const fields of [{ kind: "search", rawInput: { pattern: "x" } }, { kind: "read", rawInput: { path: "/a" } }, { kind: "execute", rawInput: { command: "ls" } }, { kind: "other", title: "Record Screen", rawInput: {} }]) {
    assert.equal(tool(fields).tool, undefined);
  }
  // The to-do tool and the plan tool get no row: the to-do row and the plan card stand for them.
  assert.equal(tool({ kind: "other", rawInput: { _toolName: "updateTodos" } }).hidden, true);
  assert.equal(tool({ kind: "other", rawInput: { _toolName: "createPlan" } }).hidden, true);
  assert.equal(tool({ kind: "other", rawInput: { _toolName: "task" } }).hidden, false);
  assert.equal(tool({ kind: "execute", rawInput: { command: "ls" } }).hidden, false);
});

test("a call Cursor reports as completed says in what it returned that it did not work", () => {
  const result = (name: string, rawOutput: unknown) => {
    const own = cursorTools(new Map([["answered", ["Swift"]]]));
    return own.result!({ toolCallId: name === "clarify" ? "answered" : "t", rawOutput }, { name, args: {} });
  };
  assert.deepEqual(result("search_files", { error: "ripgrep is not installed" }), { error: "ripgrep is not installed" });
  assert.deepEqual(result("patch", { error: "The file changed meanwhile" }), { success: false, error: "The file changed meanwhile" });
  assert.deepEqual(result("web_search", { rejected: true, reason: "User rejected" }), { status: "blocked", error: "User rejected", user_summary: "You denied this — it did not run." });
  assert.deepEqual(result("add_note", { permissionDenied: true }), { status: "blocked", error: "Cursor did not allow this.", user_summary: "Cursor did not allow this — it did not run." });
  // A command says how it went by its exit code, which the library reads.
  assert.equal(result("terminal", { exitCode: 1, stdout: "", stderr: "no" }), undefined);
  assert.equal(result("read_file", { content: "hi\n" }), undefined);
  // A search tells only how much it found.
  assert.deepEqual(result("search_files", { totalMatches: 1, truncated: false }), { output: "1 match" });
  assert.deepEqual(result("search_files", { totalFiles: 12, truncated: true }), { output: "12 files (cut short)" });
  assert.deepEqual(result("web_search", { referenceCount: 3 }), { output: "3 references" });
  // A question's row ends with what was answered, as the app's history reads it.
  assert.deepEqual(result("clarify", undefined), { responses: [{ user_response: "Swift" }] });

  const own = cursorTools(new Map());
  assert.equal(own.stopped!({ name: "terminal", args: {} }), commandLeftText);
  assert.equal(own.stopped!({ name: "read_file", args: {} }), undefined);
});

// MARK: Questions, plans, permissions

const question = {
  toolCallId: "q",
  title: "Language",
  questions: [
    { id: "lang", prompt: "Which language?", options: [{ id: "py", label: "Python" }, { id: "sw", label: "Swift" }, { id: "rs", label: "Rust, with macros" }, { id: "r", label: "Rust" }], allowMultiple: true },
    { id: "size", prompt: "How big?", options: [{ id: "s", label: "Small" }, { id: "l", label: "Large" }], allowMultiple: false },
  ],
};

function clarify(answers: Record<string, string | null> | null): RequestAnswer {
  return { kind: "clarify", answers };
}

test("a question's card and its answers each way", () => {
  assert.deepEqual(questionCard(question), {
    kind: "clarify",
    questions: [
      { qid: "q0", question: "Which language?", choices: ["Python", "Swift", "Rust, with macros", "Rust"], multiSelect: true, header: "Language" },
      { qid: "q1", question: "How big?", choices: ["Small", "Large"], multiSelect: false, header: "Language" },
    ],
  });
  assert.equal(questionCard({ toolCallId: "q", questions: [] }), null);
  assert.equal(questionCard({}), null);

  const options = question.questions[0].options;
  assert.deepEqual(chosenOptions("Swift", options), ["sw"]);
  // Whole labels, the longest first: a label with a comma in it, and one that begins another.
  assert.deepEqual(chosenOptions("Rust, with macros", options), ["rs"]);
  assert.deepEqual(chosenOptions("Rust, Python", options), ["r", "py"]);
  assert.deepEqual(chosenOptions("Python, Rust, with macros, Swift", options), ["py", "rs", "sw"]);
  assert.equal(chosenOptions("Rust, with", options), null);
  assert.equal(chosenOptions("Go", options), null);
  assert.equal(chosenOptions("", options), null);

  assert.deepEqual(questionOutcome(question, clarify({ q0: "Python, Rust", q1: "Large" })), {
    response: { outcome: { outcome: "answered", answers: [{ questionId: "lang", selectedOptionIds: ["py", "r"] }, { questionId: "size", selectedOptionIds: ["l"] }] } },
    said: ["Python, Rust", "Large"],
  });
  // One question left open: the others still count.
  assert.deepEqual(questionOutcome(question, clarify({ q0: null, q1: "Small" })).response, { outcome: { outcome: "answered", answers: [{ questionId: "size", selectedOptionIds: ["s"] }] } });
  // Words of the user's own in any answer: the whole of it goes back in words, so nothing said is lost.
  assert.deepEqual(questionOutcome(question, clarify({ q0: "Python", q1: "Tiny" })), {
    response: { outcome: { outcome: "skipped", reason: "The user answered in their own words, not with one of the options. Take this as the answer:\nWhich language? Python\nHow big? Tiny" } },
    said: ["Python", "Tiny"],
  });
  // Two picks where the question takes one are words too.
  assert.equal((questionOutcome(question, clarify({ q1: "Small, Large" })).response as any).outcome.outcome, "skipped");
  assert.deepEqual(questionOutcome(question, clarify({ q0: " ", q1: null })).response, { outcome: { outcome: "skipped", reason: "The user skipped the question." } });
  assert.deepEqual(questionOutcome(question, clarify(null)).response, { outcome: { outcome: "skipped", reason: "The user dismissed the question without answering it." } });
  assert.deepEqual(questionOutcome(question, { kind: "withdrawn", reason: "interrupted" }), { response: { outcome: { outcome: "cancelled" } }, said: [] });
});

test("a plan's card and its answers; a request nobody can be shown is never answered with an error", () => {
  assert.deepEqual(planCard({ name: "Add a file", overview: "One file.", plan: "# Steps\n\n1. Make it.\n" }), {
    kind: "approval",
    command: "Add a file\n\nOne file.\n\n# Steps\n\n1. Make it.",
    description: "Cursor has a plan",
    choices: ["once", "deny"],
    plan: { startsIn: "default" },
  });
  assert.equal((planCard({}) as { command: string }).command, "Cursor has finished planning.");
  // Accepted with no `planUri`: Cursor keeps the plan where it keeps its plans.
  assert.deepEqual(planOutcome({ kind: "approval", choice: "once" }), { response: { outcome: { outcome: "accepted" } }, accepted: true });
  assert.deepEqual(planOutcome({ kind: "approval", choice: "deny", note: "Fewer steps." }).response, { outcome: { outcome: "rejected", reason: "Fewer steps." } });
  assert.deepEqual(planOutcome({ kind: "approval", choice: "deny" }).response, { outcome: { outcome: "rejected", reason: "The plan was not approved in Portals. Keep planning, or ask what to change." } });
  assert.deepEqual(planOutcome({ kind: "withdrawn", reason: "interrupted" }), { response: { outcome: { outcome: "cancelled" } }, accepted: false });

  // Cursor takes an error for consent to a plan, and asks a question again as permission cards.
  assert.deepEqual(unplacedAnswer("cursor/create_plan"), { outcome: { outcome: "rejected", reason: "Portals could not show this plan." } });
  assert.deepEqual(unplacedAnswer("cursor/ask_question"), { outcome: { outcome: "cancelled" } });
  for (const method of ["cursor/update_todos", "cursor/task", "cursor/generate_image"]) assert.deepEqual(unplacedAnswer(method), {});
  assert.ok(["cursor/ask_question", "cursor/create_plan", "cursor/update_todos", "cursor/task", "cursor/generate_image"].every(isCursorRequest));
  assert.ok(!["cursor/teleport", "fs/write_text_file", "session/request_permission"].some(isCursorRequest));
});

test("a permission's answers are Cursor's own options, and a no with no option for it is cancelled", () => {
  const options = [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];
  const chosen = (choice: "once" | "always" | "deny", from = options) => permissionOutcome(from, { kind: "approval", choice });
  assert.deepEqual(chosen("once"), { outcome: { outcome: "selected", optionId: "allow-once" } });
  assert.deepEqual(chosen("always"), { outcome: { outcome: "selected", optionId: "allow-always" } });
  assert.deepEqual(chosen("deny"), { outcome: { outcome: "selected", optionId: "reject-once" } });
  assert.deepEqual(chosen("deny", options.slice(0, 2)), { outcome: { outcome: "cancelled" } });
  assert.deepEqual(permissionOutcome(options, { kind: "withdrawn", reason: "interrupted" }), { outcome: { outcome: "cancelled" } });
  // A request with one way to say yes offers no "always".
  const call: ToolCall = { toolCallId: "c", title: "`ls`", kind: "execute", rawInput: { command: "ls" } };
  const card = permissionCard(call, [options[0], options[2]], call, { name: "terminal", args: { command: "ls" } }, true, cwd, cursorQuirks);
  assert.deepEqual(card, { kind: "approval", command: "ls", description: "Cursor wants to run a command", choices: ["once", "deny"] });
});

// MARK: Models

/** What Cursor answered `cursor/list_available_models` with, and a session's options with a model selected. */
function recordedModels(): { listed: unknown; onGrok: ConfigOption[]; fresh: ConfigOption[] } {
  const lines = recording("models");
  const listed = lines.find((line) => line.kind === "response" && line.method === "cursor/list_available_models")?.result;
  const set = lines.filter((line) => line.kind === "response" && line.method === "session/set_config_option" && line.result);
  const onGrok = set.find((line) => line.result.configOptions.some((option: ConfigOption) => option.id === "model" && option.currentValue === "grok-4.6"))?.result.configOptions;
  const fresh = lines.find((line) => line.kind === "response" && line.method === "session/new")?.result.configOptions;
  return { listed, onGrok, fresh };
}

test("models: Cursor's list as the app's catalogue, with each model's levels from the option that holds levels", () => {
  const { listed } = recordedModels();
  const models = listedModels(listed);
  assert.equal(models?.length, 47);
  const byID = new Map(models!.map((model) => [model.id, model]));
  // Cursor's own "Auto" has the id `default` there, which the app keeps for "leave it to Cursor".
  assert.deepEqual(models![0], { id: "auto", name: "Auto" });
  assert.equal(cursorID("auto"), "default");
  assert.equal(cursorID("grok-4.6"), "grok-4.6");
  // The level option goes by three names.
  assert.deepEqual(byID.get("grok-4.6")?.level, { option: "effort", values: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" } });
  assert.equal(byID.get("grok-4.7")?.level?.option, "reasoning_effort");
  assert.equal(byID.get("gpt-5.6-sol")?.level?.option, "reasoning");
  // `thinking`, on or off, comes before the level on some models, and is not it.
  assert.equal(byID.get("claude-opus-5")?.level?.option, "effort");
  assert.deepEqual(levelsOf(byID.get("claude-opus-5")), ["low", "medium", "high", "xhigh", "max"]);
  // A model with only thinking on or off, and one with nothing to set, take no level.
  assert.equal(byID.get("claude-opus-4-5")?.level, undefined);
  assert.equal(byID.get("gemini-3.1-pro")?.level, undefined);
  // `extra-high` is the app's xhigh, and is written back as Cursor has it.
  assert.deepEqual(levelsOf(byID.get("gpt-5.5")), ["none", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(levelSetting(byID.get("gpt-5.5"), "xhigh"), { option: "reasoning", value: "extra-high", level: "xhigh" });
  // A level the model has not is the nearest it has; none chosen, and a model with none, set nothing.
  assert.deepEqual(levelSetting(byID.get("grok-4.5"), "max"), { option: "effort", value: "high", level: "high" });
  assert.deepEqual(levelSetting(byID.get("glm-5.2"), "low"), { option: "reasoning", value: "high", level: "high" });
  assert.equal(levelSetting(byID.get("grok-4.6"), ""), null);
  assert.equal(levelSetting(byID.get("gemini-3.1-pro"), "high"), null);
  assert.equal(levelSetting(undefined, "high"), null);

  const catalog = cursorCatalog({ id: "cursor", name: "Cursor" }, models);
  assert.equal(catalog.providers.length, 1);
  assert.deepEqual(catalog.providers[0].models.slice(0, 4), ["default", "auto", "grok-4.7", "grok-4.6"]);
  assert.equal(catalog.providers[0].models.length, 48);
  assert.equal(catalog.model, "default");
  assert.equal(catalog.reasoning, "");
  // `default` takes no level, and is not named after whatever Cursor is on.
  assert.deepEqual(catalog.levels?.default, []);
  assert.deepEqual(catalog.levels?.["gemini-3.1-pro"], []);
  assert.deepEqual(catalog.levels?.["kimi-k3"], ["low", "high", "max"]);
  assert.equal(catalog.names?.default, "Cursor's own");
  assert.equal(catalog.names?.["gpt-5.3-codex"], "Codex 5.3");
  assert.equal(catalog.defaultLevels, undefined);
  // No model's id has a space: the app writes a model change as words.
  assert.ok(models!.every((model) => !/\s/.test(model.id)));
  // Until Cursor has said, `default` alone.
  assert.deepEqual(cursorCatalog({ id: "cursor", name: "Cursor" }, null).providers[0].models, ["default"]);
});

test("models: what Cursor is on is read from a session's options, and they stand in for the list when Cursor gives none", () => {
  const { listed, onGrok, fresh } = recordedModels();
  const models = listedModels(listed)!;
  const grok = models.find((model) => model.id === "grok-4.6");
  assert.equal(modelAt(fresh), "auto");
  assert.equal(modelAt(onGrok), "grok-4.6");
  assert.equal(modelAt(null), null);
  assert.equal(levelAt(grok, onGrok), "high");
  assert.equal(levelAt(grok, fresh), "");
  assert.equal(levelAt(undefined, onGrok), "");

  // From a session alone: every model by name, and the levels of the one Cursor is on.
  const fromSession = sessionModels(onGrok, null)!;
  assert.deepEqual(fromSession.map((model) => model.id), models.map((model) => model.id));
  assert.deepEqual(fromSession.find((model) => model.id === "grok-4.6"), grok);
  assert.equal(fromSession.find((model) => model.id === "grok-4.7")?.level, undefined);
  // What was known of the other models before is kept.
  assert.deepEqual(sessionModels(fresh, fromSession)?.find((model) => model.id === "grok-4.6"), grok);
  assert.equal(sessionModels([], null), null);
});

test("models: the modes Cursor has, and what it answers for one it has not", () => {
  // Full access is the agent mode, on a Cursor run with --force: Cursor has no mode of its own for it (below).
  assert.deepEqual([cursorMode("default"), cursorMode("plan"), cursorMode("ask"), cursorMode("full"), cursorMode("edits")], ["agent", "plan", "ask", "agent", null]);
  const lines = recording("models");
  const sent = lines.filter((line) => line.kind === "send" && line.method === "session/set_mode").map((line) => line.params.modeId);
  assert.deepEqual(sent, ["plan", "ask", "agent", "full"]);
  const refused = lines.find((line) => line.kind === "response" && line.method === "session/set_mode" && line.error);
  assert.deepEqual(refused?.error, { code: -32603, message: "Internal error", data: { details: "Invalid mode ID: full. Valid modes: agent, plan, ask" } });
  // A model or a level Cursor has not is -32602.
  const bad = lines.filter((line) => line.kind === "response" && line.method === "session/set_config_option" && line.error).map((line) => line.error?.code);
  assert.deepEqual(bad, [-32602, -32602]);
});

// MARK: To-dos

test("the to-do list is kept by id: the first request holds it whole, later ones the items that changed", () => {
  const requests = recording("todos").filter((line) => line.kind === "request" && line.method === "cursor/update_todos").map((line) => line.params);
  assert.deepEqual(requests.map((params) => [params.merge, params.todos.length]), [[false, 3], [true, 2], [true, 2], [true, 1]]);
  let todos: Todo[] = [];
  const statuses: string[][] = [];
  for (const params of requests) {
    todos = mergedTodos(todos, params);
    statuses.push(todos.map((todo) => todo.status));
  }
  assert.deepEqual(statuses, [
    ["in_progress", "pending", "pending"],
    ["completed", "in_progress", "pending"],
    ["completed", "completed", "in_progress"],
    ["completed", "completed", "completed"],
  ]);
  assert.deepEqual(todos.map((todo) => todo.id), ["1", "2", "3"]);
  // An item not seen before is added; a list sent whole replaces the one kept.
  assert.deepEqual(mergedTodos(todos, { merge: true, todos: [{ id: "4", content: "make d.txt", status: "pending" }] }).map((todo) => todo.id), ["1", "2", "3", "4"]);
  assert.deepEqual(mergedTodos(todos, { merge: false, todos: [{ id: "z", content: "start over", status: "pending" }] }), [{ id: "z", content: "start over", status: "pending" }]);
  assert.deepEqual(mergedTodos(todos, {}), []);
  const row = todoRow(todos);
  assert.deepEqual([row.tool.name, row.tool.context], ["todo", "3 of 3 done"]);
});
