import "./environment.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { textDiff } from "../src/providers/acp/diff.ts";
import { catalogFor, levelsOf, modelsOf } from "../src/providers/acp/models.ts";
import type { PermissionRequest, SessionUpdate } from "../src/providers/acp/protocol.ts";
import { AcpStream } from "../src/providers/acp/stream.ts";
import { approvalCommand, gatewayTool, merged, type Quirks } from "../src/providers/acp/tools.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

// Golden tests: turns of real agents (test/fixtures/acp, recorded from OpenCode 1.18.35
// and Cursor 2026.10.01 on 2026-10-10, their folders renamed) through the mapper, with
// no agent running. Each `<name>.events.json` is what the mapper made of `<name>.jsonl`
// when it was last checked by hand; UPDATE_GOLDEN=1 rewrites them after a deliberate
// change. A recording is the turn's `session/update` notifications in order, the
// questions the agent asked with how they were answered, and why the turn stopped.
// (Cursor's later recordings, test/fixtures/cursor, are whole exchanges in another
// format, for the tests of the Cursor provider.)

const cwd = "/private/tmp/portals-acp/work";

type Line = { update: SessionUpdate } | { permission: Omit<PermissionRequest, "sessionId">; answer: "once" | "deny" | "withdrawn" } | { stop: string };

/** What was asked for an approval, among the events, for the golden files. */
type Recorded = ProviderEvent | { type: "approval"; command: string };

/** What is put right for each of the two agents: nothing for OpenCode, two things for Cursor 2026.10.01. */
const quirksOf: Record<string, Quirks> = {
  opencode: {},
  // It ends a turn with this line, after the reply, and starts each side of a new file's diff with a scrap of a header.
  cursor: { junkText: /^\s*Error: RetriableError: WritableIterable is closed\s*$/, diffHeaderScraps: true },
};

function replay(name: string): Recorded[] {
  const quirks = quirksOf[name.split("-")[0]];
  let id = 0;
  const stream = new AcpStream({ cwd, quirks, newID: () => String(++id), now: () => 0 });
  const events: Recorded[] = [];
  const lines = readFileSync(new URL(`fixtures/acp/${name}.jsonl`, import.meta.url), "utf8").trim().split("\n");
  for (const line of lines.map((text) => JSON.parse(text) as Line)) {
    if ("update" in line) {
      events.push(...stream.map(line.update));
    } else if ("permission" in line) {
      const asked = stream.asked(line.permission.toolCall);
      events.push(...asked.events, { type: "approval", command: approvalCommand(asked.call, asked.tool, cwd, quirks) });
      if (line.answer === "deny") stream.denied(asked.call.toolCallId);
    } else {
      events.push(...stream.endTurn(), { type: "turn.end", status: line.stop === "cancelled" ? "interrupted" : "complete" });
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

for (const name of ["opencode-tools", "opencode-approval", "opencode-denied", "opencode-interrupted", "cursor-tools"]) {
  test(`${name}: the recording maps to its golden events`, () => {
    const events = joined(replay(name));
    const golden = new URL(`fixtures/acp/${name}.events.json`, import.meta.url);
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) writeFileSync(golden, JSON.stringify(events, null, 1) + "\n");
    assert.deepEqual(events, JSON.parse(readFileSync(golden, "utf8")));
  });
}

function ends(events: Recorded[]): Extract<ProviderEvent, { type: "tool.end" }>[] {
  return events.filter((event): event is Extract<ProviderEvent, { type: "tool.end" }> => event.type === "tool.end");
}

function text(events: Recorded[]): string {
  return events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");
}

test("OpenCode: a file written is a write row from what the tool was given; a command a terminal row with its exit code", () => {
  const events = replay("opencode-tools");
  // A row starts when the agent runs the tool, not when the model starts writing its input.
  const starts = events.filter((event) => event.type === "tool.start");
  assert.deepEqual(starts, [
    { type: "tool.start", id: "call_00_gsm8veqwjsm63mdmx5xjadww", name: "write_file", args: { path: `${cwd}/hello.txt`, content: "hi" } },
    { type: "tool.start", id: "call_00_hvvlhz3b6e3eaiqg2ngxcvzc", name: "terminal", args: { command: "cat hello.txt" } },
  ]);
  const [write, run] = ends(events);
  assert.deepEqual(write.result, { diff: "--- a/hello.txt\n+++ b/hello.txt\n+hi\n" });
  assert.deepEqual(run.result, { output: "hi", exit_code: 0 });
  assert.equal(text(events), "hi");
  assert.deepEqual(events.at(-2), { type: "usage", usage: { used: 53521, max: 200_000 } });
});

test("OpenCode: the change comes with the question, and stays with the row when the agent only says it wrote", () => {
  const events = replay("opencode-approval");
  const approvals = events.flatMap((event) => (event.type === "approval" ? [event.command] : []));
  // The agent's own diff: the file was empty before.
  const diff = "--- a/hello.txt\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+hi\n";
  assert.deepEqual(approvals, [`Edit ${cwd}/hello.txt\n${diff}`, "cat hello.txt"]);
  const [write] = ends(events);
  // What the tool was given is still what the call said, not what the question carried in its place.
  assert.deepEqual(write.args, { path: `${cwd}/hello.txt`, content: "hi" });
  assert.deepEqual(write.result, { diff });
});

test("OpenCode: a call the person denied is blocked; one cut short by a stop ends as the agent says", () => {
  const [denied] = ends(replay("opencode-denied"));
  assert.deepEqual(denied.result, {
    status: "blocked",
    error: "The user rejected permission to use this specific tool call.",
    user_summary: "You denied this command — it did not run.",
  });
  const interrupted = replay("opencode-interrupted");
  assert.deepEqual(ends(interrupted)[0].result, { output: "Tool execution aborted", exit_code: 1 });
  assert.deepEqual(interrupted.at(-1), { type: "turn.end", status: "interrupted" });
});

test("Cursor: its line after the reply is dropped, its diff read past the scraps, a failed command told by its exit code", () => {
  const events = replay("cursor-tools");
  assert.ok(!text(events).includes("RetriableError"));
  assert.match(text(events), /Output of `cat hello.txt`:\n\n```\nhi\n```$/);
  const [edit, failed, worked] = ends(events);
  assert.equal(edit.name, "patch");
  // The model mistyped the folder, so the file is outside the thread's and keeps its whole path.
  assert.deepEqual(edit.args, { path: "/private/tmp/portals-acp-work/hello.txt" });
  assert.deepEqual(edit.result, { success: true, diff: "--- /dev/null\n+++ b//private/tmp/portals-acp-work/hello.txt\n@@ -0,0 +1 @@\n+hi\n" });
  assert.deepEqual(failed.args, { command: "cat hello.txt" });
  // The agent calls the call completed; the command's own exit code says it failed.
  assert.deepEqual(failed.result, { output: "cat: hello.txt: No such file or directory\n", exit_code: 1 });
  assert.deepEqual(worked.result, { output: "hi\n", exit_code: 0 });
  // Without the quirk the scraps would show as file text.
  const plain = new AcpStream({ cwd, now: () => 0 });
  const raw = readFileSync(new URL("fixtures/acp/cursor-tools.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Line);
  const unfixed = raw.flatMap((line) => ("update" in line ? plain.map(line.update) : []));
  assert.match(JSON.stringify(ends(unfixed)[0].result), /dev\/null/);
  assert.ok(text(unfixed).includes("RetriableError"));
});

// MARK: The pieces

test("a tool call's updates lay over each other; a diff told once is kept when later content has none", () => {
  let call = merged(undefined, { toolCallId: "t", title: "write", kind: "edit", status: "pending", rawInput: {} });
  call = merged(call, { toolCallId: "t", content: [{ type: "diff", path: "/w/a.txt", oldText: "a\n", newText: "b\n" }], status: null, title: undefined });
  call = merged(call, { toolCallId: "t", status: "completed", content: [{ type: "content", content: { type: "text", text: "done" } }] });
  assert.equal(call.title, "write");
  assert.equal(call.status, "completed");
  assert.deepEqual(call.diffs, [{ type: "diff", path: "/w/a.txt", oldText: "a\n", newText: "b\n" }]);
  assert.deepEqual(gatewayTool(call), { name: "patch", args: { path: "/w/a.txt" } });
});

test("tool kinds become the app's tool names, with a label from what the agent gives", () => {
  const tool = (fields: Record<string, unknown>) => gatewayTool(merged(undefined, { toolCallId: "t", ...fields }));
  assert.deepEqual(tool({ kind: "execute", title: "`ls -la`" }), { name: "terminal", args: { command: "ls -la" } });
  assert.deepEqual(tool({ kind: "execute", rawInput: { command: ["git", "status"] } }), { name: "terminal", args: { command: "git status" } });
  assert.deepEqual(tool({ kind: "read", locations: [{ path: "/w/a.txt" }] }), { name: "read_file", args: { path: "/w/a.txt" } });
  assert.deepEqual(tool({ kind: "read", title: "Read a file" }), { name: "read_file", args: {}, context: "Read a file" });
  assert.deepEqual(tool({ kind: "search", rawInput: { pattern: "TODO" } }), { name: "search_files", args: { pattern: "TODO" } });
  assert.deepEqual(tool({ kind: "fetch", rawInput: { url: "https://example.com" } }), { name: "web_extract", args: { url: "https://example.com" } });
  assert.deepEqual(tool({ kind: "fetch", rawInput: { query: "weather" } }), { name: "web_search", args: { query: "weather" } });
  assert.deepEqual(tool({ kind: "delete", locations: [{ path: "/w/a.txt" }] }), { name: "delete_file", args: { path: "/w/a.txt" } });
  // Anything else goes by the agent's own name for it, labelled by its title.
  assert.deepEqual(tool({ kind: "other", name: "mcp_lookup", title: "Look it up", rawInput: { id: 3 } }), { name: "mcp_lookup", args: { id: 3 }, context: "Look it up" });
  assert.deepEqual(tool({ title: "Something" }), { name: "tool", args: {}, context: "Something" });
});

test("a long output, a large file written and its diff are cut where the app would stop showing them anyway", () => {
  const stream = new AcpStream({ cwd, now: () => 0 });
  const long = "x".repeat(100_000);
  stream.map({ sessionUpdate: "tool_call", toolCallId: "run", kind: "execute", status: "in_progress", rawInput: { command: "yes" } });
  const [run] = ends(stream.map({ sessionUpdate: "tool_call_update", toolCallId: "run", status: "completed", content: [{ type: "content", content: { type: "text", text: long } }] }));
  assert.equal((run.result as { output: string }).output, `${"x".repeat(40_000)}\n…`);
  const [start, written] = stream.map({ sessionUpdate: "tool_call", toolCallId: "w", kind: "edit", status: "completed", rawInput: { path: `${cwd}/big.txt`, content: long } });
  assert.equal(start.type === "tool.start" && (start.args.content as string).length, 40_002);
  assert.ok(written.type === "tool.end" && (written.result as { diff: string }).diff.length < 40_100);
});

test("a tool call that never ran before the turn ended closes as stopped; one never started shows nothing", () => {
  const stream = new AcpStream({ cwd, now: () => 0 });
  stream.map({ sessionUpdate: "tool_call", toolCallId: "a", kind: "execute", status: "pending", rawInput: {} });
  const started = stream.map({ sessionUpdate: "tool_call", toolCallId: "b", kind: "execute", status: "in_progress", rawInput: { command: "sleep 100" } });
  assert.deepEqual(started, [{ type: "tool.start", id: "b", name: "terminal", args: { command: "sleep 100" } }]);
  assert.deepEqual(stream.endTurn(), [{ type: "tool.end", id: "b", name: "terminal", args: { command: "sleep 100" }, result: { status: "error", error: "Stopped before it finished." } }]);
  // Nothing of the turn is left for the next.
  assert.deepEqual(stream.endTurn(), []);
});

test("a call that returned nothing ends with an empty result, which the app shows as nothing", () => {
  const stream = new AcpStream({ cwd, now: () => 0 });
  const done = (fields: Record<string, unknown>) => ends(stream.map({ sessionUpdate: "tool_call", toolCallId: "t", status: "completed", ...fields }))[0].result;
  // `{content: ""}` or `{output: ""}` would be printed as they are, as JSON.
  assert.deepEqual(done({ toolCallId: "read", kind: "read", rawInput: { path: "/w/a.png" }, rawOutput: { content: "" } }), {});
  assert.deepEqual(done({ toolCallId: "other", kind: "other", name: "lookup", rawOutput: { durationMs: 12 } }), {});
  assert.deepEqual(done({ toolCallId: "delete", kind: "delete", locations: [{ path: "/w/a.txt" }] }), {});
  // A command's row is its exit code even then.
  assert.deepEqual(done({ toolCallId: "run", kind: "execute", rawInput: { command: "true" }, rawOutput: { exitCode: 0 } }), { output: "", exit_code: 0 });
});

test("a call the agent was still asking about when the turn ended never ran: its row closes plainly, whatever a provider says of a call cut short", () => {
  const stream = new AcpStream({ cwd, quirks: { own: { stopped: () => "It may still be running." } }, now: () => 0 });
  const told = (id: string, status: string) => stream.map({ sessionUpdate: "tool_call", toolCallId: id, kind: "execute", status, rawInput: { command: `run ${id}` } });
  // Asked about and never answered; asked about and allowed; never asked about.
  told("waiting", "pending");
  stream.asked({ toolCallId: "waiting", kind: "execute", status: "pending" });
  told("allowed", "pending");
  stream.asked({ toolCallId: "allowed", kind: "execute", status: "pending" });
  stream.allowed("allowed");
  told("unasked", "in_progress");
  assert.deepEqual(
    ends(stream.endTurn()).map((row) => [row.id, row.result]),
    [
      ["waiting", { status: "error", error: "Stopped before it finished." }],
      ["allowed", { status: "error", error: "It may still be running." }],
      ["unasked", { status: "error", error: "It may still be running." }],
    ],
  );
});

test("a question about a call the agent never told of gives the card its text and starts no row", () => {
  const stream = new AcpStream({ cwd, now: () => 0 });
  // As Cursor 2026.10.01 asks before a web search: under an id of the question's own,
  // while it tells of the search itself under another (test/fixtures/cursor/permission.jsonl).
  stream.map({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "Web Search", kind: "search", status: "pending", rawInput: {} });
  const asked = stream.asked({ toolCallId: "web_search_0", title: "Web search: agent client protocol", kind: "search", status: "pending" });
  assert.deepEqual(asked.events, []);
  assert.equal(asked.call.toolCallId, "web_search_0");
  assert.equal(approvalCommand(asked.call, asked.tool, cwd), "Web search: agent client protocol");
  // A no to it marks no row: the search's own row starts and ends as the agent tells it.
  stream.denied("web_search_0");
  const told = stream.map({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawInput: { searchTerm: "agent client protocol" } });
  assert.deepEqual(
    told.map((event) => [event.type, "id" in event ? event.id : ""]),
    [
      ["tool.start", "call-1"],
      ["tool.end", "call-1"],
    ],
  );
  // Nothing of the question is left to close when the turn ends.
  assert.deepEqual(stream.endTurn(), []);

  // A call the agent did tell of gets its row with the question, before it runs.
  stream.map({ sessionUpdate: "tool_call", toolCallId: "run", title: "bash", kind: "execute", status: "pending", rawInput: {} });
  const known = stream.asked({ toolCallId: "run", title: "ls -la", kind: "execute", status: "pending", rawInput: { command: "ls -la" } });
  assert.deepEqual(known.events, [{ type: "tool.start", id: "run", name: "terminal", args: { command: "ls -la" } }]);
  assert.equal(approvalCommand(known.call, known.tool, cwd), "ls -la");
  stream.denied("run");
  assert.deepEqual(ends(stream.endTurn())[0].result, { status: "blocked", error: "Denied from Portals.", user_summary: "You denied this command — it did not run." });
});

test("an agent's own tools are asked before the call's kind: a row of its own, no row at all, how a completed call went, what a stop left open", () => {
  // What a provider says of its agent's tools (`OwnTools`), as Cursor's provider does.
  const quirks: Quirks = {
    own: {
      hidden: (call) => (call.rawInput as { secret?: boolean } | undefined)?.secret === true,
      tool: (call) => (call.kind === "other" && call.title === "Teleport" ? { name: "teleport", args: { to: "Mars" } } : undefined),
      result: (call, tool) => (tool.name === "teleport" || (call.rawOutput as { failed?: boolean } | undefined)?.failed ? { error: "It did not work." } : undefined),
      stopped: (tool) => (tool.name === "terminal" ? "Stopped, and nobody knows how far it got." : undefined),
    },
  };
  const stream = new AcpStream({ cwd, quirks, now: () => 0 });
  // A row under the name and args the provider gives, with the result it gives.
  assert.deepEqual(stream.map({ sessionUpdate: "tool_call", toolCallId: "t", title: "Teleport", kind: "other", status: "completed", rawOutput: { ok: true } }), [
    { type: "tool.start", id: "t", name: "teleport", args: { to: "Mars" } },
    { type: "tool.end", id: "t", name: "teleport", args: { to: "Mars" }, result: { error: "It did not work." } },
  ]);
  // A call left to its kind, whose result the provider reads all the same: completed, but it failed.
  const read = stream.map({ sessionUpdate: "tool_call", toolCallId: "r", kind: "read", status: "completed", rawInput: { path: "/a" }, rawOutput: { failed: true } });
  assert.deepEqual(ends(read)[0], { type: "tool.end", id: "r", name: "read_file", args: { path: "/a" }, result: { error: "It did not work." } });
  // And one left to its kind altogether.
  const run = stream.map({ sessionUpdate: "tool_call", toolCallId: "c", kind: "execute", status: "completed", rawInput: { command: "ls" }, rawOutput: { exitCode: 0, stdout: "a\n" } });
  assert.deepEqual(ends(run)[0].result, { output: "a\n", exit_code: 0 });
  // A call that gets no row makes no events, however it goes on, and leaves nothing to close.
  assert.deepEqual(stream.map({ sessionUpdate: "tool_call", toolCallId: "h", kind: "other", status: "in_progress", rawInput: { secret: true } }), []);
  assert.deepEqual(stream.asked({ toolCallId: "h", title: "Hidden", status: "pending" }).events, []);
  assert.deepEqual(stream.map({ sessionUpdate: "tool_call_update", toolCallId: "h", status: "completed" }), []);
  // What a stop left open closes with the provider's words where it has some.
  stream.map({ sessionUpdate: "tool_call", toolCallId: "s", kind: "execute", status: "in_progress", rawInput: { command: "sleep 100" } });
  stream.map({ sessionUpdate: "tool_call", toolCallId: "f", kind: "read", status: "in_progress", rawInput: { path: "/b" } });
  assert.deepEqual(
    ends(stream.endTurn()).map((row) => [row.id, row.result]),
    [
      ["s", { status: "error", error: "Stopped, and nobody knows how far it got." }],
      ["f", { status: "error", error: "Stopped before it finished." }],
    ],
  );
});

test("a question about a call keeps the kind the call was told with, and says whether the call was told of", () => {
  const stream = new AcpStream({ cwd, now: () => 0 });
  // As Cursor asks about a delete: as an edit, with a title of the request's own.
  stream.map({ sessionUpdate: "tool_call", toolCallId: "d", title: "Delete File", kind: "delete", status: "pending", rawInput: { path: `${cwd}/old.txt` } });
  const asked = stream.asked({ toolCallId: "d", title: `Delete \`${cwd}/old.txt\``, kind: "edit", status: "pending" });
  assert.equal(asked.announced, true);
  assert.deepEqual(asked.events, [{ type: "tool.start", id: "d", name: "delete_file", args: { path: `${cwd}/old.txt` } }]);
  assert.equal(approvalCommand(asked.call, asked.tool, cwd), `Delete ${cwd}/old.txt`);
  assert.equal(stream.asked({ toolCallId: "nobody", title: "Fetch a page", kind: "fetch", status: "pending" }).announced, false);
});

test("updates the stream has no use for are passed over: a change of mode, a kind it does not know", () => {
  const stream = new AcpStream({ cwd });
  assert.deepEqual(stream.map({ sessionUpdate: "current_mode_update", currentModeId: "plan" }), []);
  assert.deepEqual(stream.map({ sessionUpdate: "session_info_update", title: "A title" }), []);
  assert.deepEqual(stream.map({ sessionUpdate: "something_a_later_agent_sends", detail: 1 } as unknown as SessionUpdate), []);
  // A tool call with no id cannot be a row.
  assert.deepEqual(stream.map({ sessionUpdate: "tool_call", status: "in_progress" } as unknown as SessionUpdate), []);
  assert.deepEqual(stream.endTurn(), []);
});

test("agents that number their messages get each closed off when the next begins", () => {
  const stream = new AcpStream({ cwd });
  const chunk = (text: string, messageId?: string): SessionUpdate => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId });
  assert.deepEqual(stream.map(chunk("One. ", "m1")), [{ type: "text", text: "One. " }]);
  assert.deepEqual(stream.map(chunk("Still one.", "m1")), [{ type: "text", text: "Still one." }]);
  assert.deepEqual(stream.map(chunk("Two.", "m2")), [
    { type: "commentary", text: "One. Still one.", alreadyStreamed: true },
    { type: "text", text: "Two." },
  ]);
});

test("a diff of two whole texts shows the lines that changed with those around them, apart when far apart", () => {
  const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  const after = [...before];
  after[1] = "second";
  after.splice(20, 1);
  after.push("added");
  assert.equal(
    textDiff("/w/src/a.txt", before.join("\n") + "\n", after.join("\n") + "\n", "/w"),
    [
      "--- a/src/a.txt",
      "+++ b/src/a.txt",
      "@@ -1,5 +1,5 @@",
      " line 1",
      "-line 2",
      "+second",
      " line 3",
      " line 4",
      " line 5",
      "@@ -18,7 +18,6 @@",
      " line 18",
      " line 19",
      " line 20",
      "-line 21",
      " line 22",
      " line 23",
      " line 24",
      "@@ -28,3 +27,4 @@",
      " line 28",
      " line 29",
      " line 30",
      "+added",
      "",
    ].join("\n"),
  );
  assert.equal(textDiff("/w/a.txt", "same\n", "same\n", "/w"), "");
  assert.equal(textDiff("/w/a.txt", "", "new\n", "/w"), "--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+new\n");
  assert.equal(textDiff("/w/a.txt", "old\n", "", "/w"), "--- a/a.txt\n+++ b/a.txt\n@@ -1 +0,0 @@\n-old\n");
});

test("models are read from a session's options, under the agent's own headings where it has them", () => {
  const options = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "a-1",
      options: [
        { group: "lab-a", name: "Lab A", options: [{ value: "a-1", name: "A One" }, { value: "a 2", name: "has a space" }] },
        { group: "lab-b", name: "Lab B", options: [{ value: "b-1", name: "b-1" }] },
      ],
    },
    { id: "level", name: "Thinking", category: "thought_level", currentValue: "high", options: [{ value: "off", name: "Off" }, { value: "high", name: "High" }, { value: "low", name: "Low" }] },
  ];
  const models = modelsOf(options);
  assert.deepEqual(models.map((model) => model.id), ["a-1", "b-1"]);
  const catalog = catalogFor({ id: "agent", name: "Agent" }, { models, own: "a-1" });
  assert.deepEqual(catalog.providers, [
    { slug: "agent", name: "Agent", models: ["default"] },
    { slug: "lab-b", name: "Lab B", models: ["b-1"] },
  ]);
  assert.deepEqual(catalog.names, { "a-1": "A One", default: "A One" });
  assert.equal(catalog.model, "default");
  assert.equal(catalog.reasoning, "");
  // Only levels the app knows by the same name, weakest first.
  assert.deepEqual(levelsOf(options), { current: "high", levels: ["low", "high"] });
  assert.deepEqual(levelsOf(null), { current: "", levels: [] });
});

test("a command's output told in its call's updates while it runs is its row's live output", async () => {
  const progress: ProviderEvent[] = [];
  const stream = new AcpStream({ cwd: "/w", now: () => 0, progress: (event) => progress.push(event) });
  stream.map({ sessionUpdate: "tool_call", toolCallId: "t1", title: "npm test", kind: "execute", status: "in_progress", rawInput: { command: "npm test" } } as never);
  stream.map({ sessionUpdate: "tool_call_update", toolCallId: "t1", content: [{ type: "content", content: { type: "text", text: "1 passed\n" } }] } as never);
  assert.deepEqual(progress, [{ type: "tool.progress", id: "t1", output: "1 passed\n", outputTruncated: false }]);
  // A call whose first word already carries output: its start goes out before that output.
  const order: string[] = [];
  const first = new AcpStream({ cwd: "/w", now: () => 0, progress: (event) => order.push(event.type) });
  order.push(...first.map({ sessionUpdate: "tool_call", toolCallId: "t2", title: "ls", kind: "execute", status: "in_progress", rawInput: { command: "ls" }, content: [{ type: "content", content: { type: "text", text: "a.txt\n" } }] } as never).map((event) => event.type));
  await Promise.resolve();
  assert.deepEqual(order, ["tool.start", "tool.progress"]);
  const end = stream.map({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "1 passed\n2 passed\n" } }] } as never);
  assert.equal(end.filter((event) => event.type === "tool.end").length, 1);
  assert.equal(progress.length, 1, "the final result is the row's, not live output");
});

test("a command the turn ended under keeps the output its updates told, with that it was stopped", () => {
  const stream = new AcpStream({ cwd: "/w", now: () => 0, progress: () => {} });
  stream.map({ sessionUpdate: "tool_call", toolCallId: "t1", title: "npm run build", kind: "execute", status: "in_progress", rawInput: { command: "npm run build" } } as never);
  stream.map({ sessionUpdate: "tool_call_update", toolCallId: "t1", content: [{ type: "content", content: { type: "text", text: "compiling 1 of 40\n" } }] } as never);
  const [stopped] = ends(stream.endTurn());
  assert.deepEqual(stopped.result, { status: "error", error: "Stopped before it finished.", output: "compiling 1 of 40\n" });
});

test("a command whose first call already told output, and whose update told more in the same step, shows and keeps the newer output, not the first", async () => {
  const progress: ProviderEvent[] = [];
  const stream = new AcpStream({ cwd: "/w", now: () => 0, progress: (event) => progress.push(event) });
  stream.map({ sessionUpdate: "tool_call", toolCallId: "t1", title: "npm run build", kind: "execute", status: "in_progress", rawInput: { command: "npm run build" }, content: [{ type: "content", content: { type: "text", text: "first\n" } }] } as never);
  stream.map({ sessionUpdate: "tool_call_update", toolCallId: "t1", content: [{ type: "content", content: { type: "text", text: "first\nsecond\n" } }] } as never);
  await Promise.resolve();
  const outputs = progress.filter((event) => event.type === "tool.progress").map((event) => (event as { output?: string }).output);
  assert.equal(outputs.at(-1), "first\nsecond\n", "the row's live output goes back to the first call's");
  const [stopped] = ends(stream.endTurn());
  assert.deepEqual(stopped.result, { status: "error", error: "Stopped before it finished.", output: "first\nsecond\n" });
});
