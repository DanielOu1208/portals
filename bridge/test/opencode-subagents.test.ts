import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, SessionSink } from "../src/providers/types.ts";
import type { OpenCodeApi } from "../src/providers/opencode/client.ts";
import type { Message, SessionInfo } from "../src/providers/opencode/protocol.ts";
import { OpenCodeSubagents } from "../src/providers/opencode/subagents.ts";

function rig(messages: Message[] = [], children: SessionInfo[] = []) {
  const events: ProviderEvent[] = [];
  const sink: SessionSink = { emit: (event) => events.push(event), ask: async () => ({ kind: "withdrawn", reason: "" }) };
  let interrupts = 0;
  const api = {
    session: async (id: string) => ({ id, parentID: "unrelated" }),
    interrupt: async () => { interrupts += 1; return true; },
    active: async () => new Set(),
    sessions: async () => [],
  } as unknown as OpenCodeApi;
  const subagents = new OpenCodeSubagents("ses_parent", async () => api, sink, () => {}, messages, children, new Set());
  return { subagents, events, interrupts: () => interrupts };
}

test("native backgrounded tool results stay running; a failure and interruption have distinct row outcomes", () => {
  const r = rig();
  const input = { description: "Explore", agent: "explore", background: true };
  r.subagents.tool("tool", "subagent", input, { sessionID: "ses_child", status: "running" });
  r.subagents.tool("tool", "subagent", input, { sessionID: "ses_child", status: "backgrounded" }, { ok: true, content: [] });
  assert.equal(r.subagents.hasRunning(), true);
  assert.equal(r.subagents.history().length, 0);
  r.subagents.tool("tool", "subagent", input, undefined, { ok: false, error: { type: "provider.error", message: "Failed" } });
  const failed = r.events.at(-1);
  assert.equal(failed?.type, "subagent");
  if (failed?.type === "subagent") assert.equal(failed.subagent.status, "failed");
  r.subagents.tool("tool2", "task", {}, { sessionID: "ses_stopped" }, { ok: false, error: { type: "aborted", message: "Stopped" } });
  const stopped = r.events.at(-1);
  if (stopped?.type === "subagent") assert.equal(stopped.subagent.status, "stopped");
});

test("ended rows recover from stored native tools with their original turns, not an invented live run", () => {
  const messages: Message[] = [
    { type: "user", id: "u1", text: "First", time: { created: 1 } },
    { type: "assistant", id: "a1", time: { created: 2 }, content: [{ type: "tool", id: "call1", name: "subagent", state: { status: "completed", input: { description: "One", agent: "explore" }, metadata: { sessionID: "ses_one", status: "completed" }, content: [{ type: "text", text: "Result one" }] } }] },
    { type: "idle", id: "i1", outcome: "succeeded", time: { created: 3 } },
    { type: "user", id: "u2", text: "Second", time: { created: 4 } },
    { type: "assistant", id: "a2", time: { created: 5 }, content: [{ type: "tool", id: "call2", name: "subagent", state: { status: "error", input: { description: "Two" }, metadata: { sessionID: "ses_two" }, error: { type: "failure", message: "Failed two" } } }] },
    { type: "idle", id: "i2", outcome: "succeeded", time: { created: 6 } },
  ];
  const r = rig(messages);
  assert.equal(r.events.length, 0);
  assert.deepEqual(r.subagents.history().map((entry) => [entry.subagent.id, entry.subagent.status, entry.turn, entry.subagent.stoppable]), [["ses_one", "completed", -1, false], ["ses_two", "failed", 0, false]]);
});

test("nested native child events preserve parentage, never stream child text as the parent's reply, and ignore unrelated sessions", () => {
  const r = rig();
  r.subagents.event({ id: "1", type: "session.created", data: { sessionID: "ses_child", parentID: "ses_parent", title: "Child" } });
  r.subagents.event({ id: "2", type: "session.created", data: { sessionID: "ses_nested", parentID: "ses_child", title: "Nested" } });
  r.subagents.event({ id: "3", type: "session.text.delta", data: { sessionID: "ses_nested", delta: "Nested answer" } });
  r.subagents.event({ id: "4", type: "session.execution.failed", data: { sessionID: "ses_nested", error: { message: "Failed nested" } } });
  assert.equal(r.subagents.event({ id: "5", type: "session.text.delta", data: { sessionID: "ses_unrelated", delta: "Never show" } }), false);
  assert.ok(r.events.every((event) => event.type === "subagent"));
  const last = r.events.at(-1);
  if (last?.type === "subagent") {
    assert.equal(last.subagent.parent, "ses_child");
    assert.equal(last.subagent.status, "failed");
    assert.equal(last.subagent.result, "Failed nested");
  }
  r.subagents.event({ id: "6", type: "session.execution.started", data: { sessionID: "ses_nested" } });
  r.subagents.event({ id: "7", type: "session.text.delta", data: { sessionID: "ses_nested", delta: "Fresh run" } });
  const fresh = r.events.at(-1);
  if (fresh?.type === "subagent") {
    assert.equal(fresh.subagent.result, "Fresh run");
    assert.equal(fresh.subagent.endedAt, undefined);
  }
});

test("a forged tool metadata ID cannot make Stop interrupt an unrelated native session", async () => {
  const r = rig();
  r.subagents.tool("tool", "subagent", {}, { sessionID: "ses_unrelated", status: "running" });
  assert.equal(await r.subagents.stop("ses_unrelated"), false);
  assert.equal(r.interrupts(), 0);
});
