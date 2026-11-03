import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { betweenStates, CodexAgents } from "../src/providers/codex/agents.ts";
import { fixture, recordedHistory } from "./codex-fixtures.ts";

// Codex's sub-agents as the subagents line shows them: from a real recording (one
// sub-agent spawned and waited for, multi-agent v2), and from the shapes of v1's
// collabAgentToolCall items and a sub-agent's own thread.

const child = "01a13a21-3e05-7212-b29e-4fb66eb40f01";

test("v2: a recorded sub-agent starts with its path for a name and its model, and completes", () => {
  const agents = new CodexAgents(() => 1000);
  const news = fixture("subagent")
    .filter((entry) => entry.kind === "notification" && entry.method === "item/completed")
    .flatMap((entry) => agents.item(entry.params.item));
  assert.deepEqual(news[0], { id: child, kind: "agent", goal: "pear reply", status: "running", startedAt: 1000, background: true, stoppable: true, model: "gpt-6.1-sol" });
  assert.deepEqual(news.at(-1), { id: child, kind: "agent", goal: "pear reply", status: "completed", startedAt: 1000, endedAt: 1000, background: true, stoppable: false, model: "gpt-6.1-sol" });
  assert.equal(agents.isRunning, false);
  // Its own thread says what it was asked and answered.
  const described = agents.described(child, {
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "Reply with the single word pear.\nNothing else." }] },
          { type: "agentMessage", text: "pear" },
        ],
      },
    ],
  });
  assert.equal(described?.goal, "Reply with the single word pear.");
  assert.equal(described?.result, "pear");
  // Read again, nothing changes.
  assert.equal(agents.described(child, { turns: [] }), null);
});

test("v2: the turn a running sub-agent runs comes from its thread, and it can be stopped by it; interrupted, it is stopped", () => {
  const agents = new CodexAgents(() => 5);
  agents.item({ type: "subAgentActivity", kind: "started", agentThreadId: "c1", agentPath: "/root/look_around" });
  assert.equal(agents.runningTurn("c1"), undefined);
  agents.described("c1", { turns: [{ id: "t9", status: "inProgress", items: [] }] });
  assert.equal(agents.runningTurn("c1"), "t9");
  const [stopped] = agents.item({ type: "subAgentActivity", kind: "interrupted", agentThreadId: "c1", agentPath: "/root/look_around" });
  assert.equal(stopped.status, "stopped");
  assert.equal(agents.runningTurn("c1"), undefined);
  // A message alone does not restart it; its own new turn does.
  const [again] = agents.item({ type: "subAgentActivity", kind: "interacted", agentThreadId: "c1", agentPath: "/root/look_around" });
  assert.equal(again.status, "stopped");
  const restarted = agents.child("c1", "turn/started", { turn: { id: "t10" } });
  assert.equal(restarted?.status, "running");
  assert.equal(restarted?.endedAt, undefined);
});

test("v1: spawnAgent makes one per new thread with its prompt and model; wait's states end it with its message", () => {
  const agents = new CodexAgents(() => 7);
  const spawn = { type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: ["c2"], prompt: "Count the files here.\nThen stop.", model: "gpt-6-luna", agentsStates: { c2: { status: "pendingInit", message: null } } };
  assert.deepEqual(agents.item(spawn), [{ id: "c2", kind: "agent", goal: "Count the files here.", status: "running", startedAt: 7, background: true, stoppable: true, model: "gpt-6-luna" }]);
  // Another thread's agents, named by a call that spawned none of them, are not ours.
  assert.deepEqual(agents.item({ type: "collabAgentToolCall", tool: "wait", receiverThreadIds: ["other"], agentsStates: { other: { status: "running" } } }), []);
  // Its own thread: a tool, a message in passing, then the end of its turn.
  agents.child("c2", "turn/started", { turn: { id: "t1" } });
  assert.equal(agents.runningTurn("c2"), "t1");
  assert.equal(agents.child("c2", "item/started", { item: { type: "commandExecution", command: "ls" } })?.tool, "terminal");
  assert.equal(agents.child("c2", "item/completed", { item: { type: "agentMessage", text: "Two files." } })?.summary, "Two files.");
  const [done] = agents.item({ type: "collabAgentToolCall", tool: "wait", receiverThreadIds: ["c2"], agentsStates: { c2: { status: "completed", message: "Two files: a and b." } } });
  assert.equal(done.status, "completed");
  assert.equal(done.result, "Two files: a and b.");
  assert.equal(done.summary, undefined);
  // A failed one says why.
  agents.item({ ...spawn, receiverThreadIds: ["c3"], agentsStates: {} });
  agents.child("c3", "turn/started", { turn: { id: "t2" } });
  const failed = agents.child("c3", "turn/completed", { turn: { id: "t2", status: "failed", error: { message: "The model is overloaded." } } });
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.result, "The model is overloaded.");
});

test("a stored thread's turns tell of its sub-agents, with their times and the turn that started each; one left at work is settled by its own thread", () => {
  const agents = new CodexAgents(() => 0);
  const past = agents.remember(recordedHistory("subagent").turns);
  assert.deepEqual(past, [
    {
      subagent: { id: child, kind: "agent", goal: "pear reply", status: "completed", startedAt: 1791976616000, endedAt: 1791976624000, background: true, stoppable: false, model: "gpt-6.1-sol" },
      turn: 0,
    },
  ]);
  // Known from then on.
  assert.equal(agents.has(child), true);

  const later = new CodexAgents(() => 0);
  const [left] = later.remember([
    { startedAt: 10, completedAt: 20, items: [{ type: "subAgentActivity", kind: "started", agentThreadId: "c9", agentPath: "/root/long_job" }] },
    { startedAt: 30, completedAt: 40, items: [] },
  ]);
  assert.deepEqual([left.subagent.status, left.subagent.startedAt, left.turn], ["running", 10_000, -1]);
  // Its own last turn says how it ended.
  assert.equal(later.described("c9", { turns: [{ id: "t1", status: "interrupted", items: [] }] })?.status, "stopped");
});

test("settled, one whose own thread Codex no longer runs is stopped, though its last turn was left in progress (Codex restarted)", () => {
  const agents = new CodexAgents(() => 0);
  agents.remember([{ startedAt: 10, completedAt: 20, items: [{ type: "subAgentActivity", kind: "started", agentThreadId: "c9", agentPath: "/root/long_job" }] }]);
  const cutOff = { status: { type: "notLoaded" }, turns: [{ id: "old-turn", status: "inProgress", items: [] }] };
  assert.equal(agents.described("c9", cutOff)?.status, "stopped");
  assert.equal(agents.isRunning, false);
  assert.equal(agents.runningTurn("c9"), undefined);
  // One Codex still runs stays running, and is stopped by its turn.
  const running = new CodexAgents(() => 0);
  running.remember([{ startedAt: 10, completedAt: 20, items: [{ type: "subAgentActivity", kind: "started", agentThreadId: "c9", agentPath: "/root/long_job" }] }]);
  // Still at work: the read names only the run it is in, which the bridge keeps (not shown).
  const read = running.described("c9", { status: { type: "active", activeFlags: [] }, turns: [{ id: "live-turn", status: "inProgress", items: [] }] });
  assert.deepEqual([read?.status, read?.run], ["running", "live-turn"]);
  assert.equal(running.runningTurn("c9"), "live-turn");
});

test("a read asked for before the sub-agent was set to work again tells nothing of its new run: not its answer, nor its end", () => {
  const agents = new CodexAgents(() => 0);
  agents.remember([{ startedAt: 10, completedAt: 20, items: [{ type: "subAgentActivity", kind: "started", agentThreadId: "c9", agentPath: "/root/worker" }] }]);
  const since = agents.revision("c9");
  // Meanwhile, live: a new turn, its answer, its end.
  agents.child("c9", "turn/started", { turn: { id: "new-turn" } });
  agents.child("c9", "item/completed", { item: { type: "agentMessage", text: "New answer" } });
  assert.equal(agents.child("c9", "turn/completed", { turn: { id: "new-turn", status: "completed" } })?.result, "New answer");
  // The old read comes back.
  const old = { status: { type: "idle" }, turns: [{ id: "old-turn", status: "completed", items: [{ type: "agentMessage", text: "Old answer" }] }] };
  assert.equal(agents.described("c9", old, since), null);
  // Nor between the new run's last message and its end.
  const again = agents.revision("c9");
  agents.child("c9", "turn/started", { turn: { id: "third-turn" } });
  agents.child("c9", "item/completed", { item: { type: "agentMessage", text: "Third answer" } });
  agents.described("c9", old, again);
  assert.equal(agents.child("c9", "turn/completed", { turn: { id: "third-turn", status: "completed" } })?.result, "Third answer");
});

test("messaging a finished agent preserves its completion and answer, live and in stored history", () => {
  const agents = new CodexAgents(() => 1000);
  const item = { type: "subAgentActivity", agentThreadId: "reviewer", agentPath: "/root/reviewer" };
  agents.item({ ...item, kind: "started" });
  agents.child("reviewer", "turn/started", { turn: { id: "r1" } });
  agents.child("reviewer", "item/completed", { turnId: "r1", item: { type: "agentMessage", text: "Review finished." } });
  const done = agents.child("reviewer", "turn/completed", { turn: { id: "r1", status: "completed" } });
  assert.deepEqual(agents.item({ ...item, kind: "interacted" }), [done]);
  assert.equal(agents.runningTurn("reviewer"), undefined);

  const stored = new CodexAgents();
  const [past] = stored.remember([{ startedAt: 1, completedAt: 2, items: [
    { ...item, kind: "started" }, { ...item, kind: "completed" }, { ...item, kind: "interacted" },
  ] }]);
  assert.equal(past.subagent.status, "completed");
  assert.equal(past.subagent.endedAt, 2000);
});

test("a current read discovers a missed restart, without borrowing the previous turn's answer", () => {
  const agents = new CodexAgents();
  agents.adopt("worker");
  agents.child("worker", "turn/started", { turn: { id: "old" } });
  agents.child("worker", "item/completed", { turnId: "old", item: { type: "agentMessage", text: "Old answer" } });
  agents.child("worker", "turn/completed", { turn: { id: "old", status: "completed" } });
  agents.item({ type: "subAgentActivity", kind: "interacted", agentThreadId: "worker" });
  const read = { status: { type: "active", activeFlags: ["waitingOnApproval"] }, turns: [
    { id: "old", status: "completed", items: [{ type: "agentMessage", text: "Old answer" }] },
    { id: "new", status: "inProgress", items: [] },
  ] };
  const restarted = agents.described("worker", read, agents.revision("worker"));
  assert.equal(restarted?.status, "running");
  assert.equal(restarted?.result, undefined);
  assert.equal(agents.runningTurn("worker"), "new");
  assert.equal(agents.child("worker", "turn/completed", { turn: { id: "new", status: "completed" } })?.result, undefined);
});

test("a child's final message arriving before its first read still belongs to its completed turn", () => {
  const agents = new CodexAgents();
  agents.adopt("worker");
  agents.child("worker", "item/completed", { turnId: "t1", item: { type: "agentMessage", text: "Fast answer" } });
  assert.equal(agents.child("worker", "turn/completed", { turn: { id: "t1", status: "completed" } })?.result, "Fast answer");
});

test("a current terminal read reconciles a whole missed follow-up, even when it produced no answer", () => {
  for (const wasRunning of [false, true]) {
    for (const [status, expected] of [["completed", "completed"], ["failed", "failed"], ["interrupted", "stopped"]]) {
      const agents = new CodexAgents();
      agents.adopt("worker");
      agents.child("worker", "turn/started", { turn: { id: "old" } });
      agents.child("worker", "item/completed", { turnId: "old", item: { type: "agentMessage", text: "Old success" } });
      if (!wasRunning) agents.child("worker", "turn/completed", { turn: { id: "old", status: "completed" } });
      const ended = agents.described("worker", {
        status: { type: "idle" }, turns: [{ id: "new", status, completedAt: 50, items: [] }],
      }, agents.revision("worker"));
      assert.equal(ended?.status, expected);
      assert.equal(ended?.result, undefined);
      assert.equal(ended?.endedAt, 50_000);
      assert.equal(agents.runningTurn("worker"), undefined);
    }
  }
});

test("a read begun before completion cannot revive the agent or replace its final answer", () => {
  const agents = new CodexAgents();
  agents.adopt("worker");
  agents.child("worker", "turn/started", { turn: { id: "t1" } });
  const since = agents.revision("worker");
  agents.child("worker", "item/completed", { turnId: "t1", item: { type: "agentMessage", text: "Final answer" } });
  const done = agents.child("worker", "turn/completed", { turn: { id: "t1", status: "completed" } });
  const stale = { status: { type: "active" }, turns: [{ id: "t1", status: "inProgress", items: [{ type: "agentMessage", text: "Still working" }] }] };
  assert.equal(agents.described("worker", stale, since), null);
  assert.equal(agents.described("worker", stale, agents.revision("worker")), null);
  assert.deepEqual(agents.item({ type: "subAgentActivity", kind: "interacted", agentThreadId: "worker" }), [done]);
});

test("a restarted agent ignores late messages and completion of its previous turn, and duplicate starts", () => {
  const agents = new CodexAgents();
  agents.adopt("worker");
  agents.child("worker", "turn/started", { turn: { id: "old" } });
  agents.child("worker", "turn/completed", { turn: { id: "old", status: "completed" } });
  agents.child("worker", "turn/started", { turn: { id: "new" } });
  agents.child("worker", "item/completed", { turnId: "new", item: { type: "agentMessage", text: "New answer" } });
  assert.equal(agents.child("worker", "turn/started", { turn: { id: "new" } }), null);
  assert.equal(agents.child("worker", "item/completed", { turnId: "old", item: { type: "agentMessage", text: "Old answer" } }), null);
  assert.equal(agents.child("worker", "turn/completed", { turn: { id: "old", status: "completed" } }), null);
  const done = agents.child("worker", "turn/completed", { turn: { id: "new", status: "completed" } });
  assert.equal(done?.result, "New answer");
  assert.equal(agents.child("worker", "turn/completed", { turn: { id: "old", status: "failed" } }), null);
  assert.equal(agents.child("worker", "turn/started", { turn: { id: "new" } }), null);
  assert.equal(agents.isRunning, false);
});

test("a read of an older terminal turn cannot end the current turn or supply its answer", () => {
  const agents = new CodexAgents();
  agents.adopt("worker");
  const since = agents.revision("worker");
  agents.child("worker", "turn/started", { turn: { id: "new" } });
  assert.equal(agents.described("worker", { status: { type: "idle" }, turns: [{ id: "old", status: "completed", items: [{ type: "agentMessage", text: "Old answer" }] }] }, since), null);
  assert.equal(agents.runningTurn("worker"), "new");
  assert.equal(agents.child("worker", "turn/completed", { turn: { id: "new", status: "completed" } })?.result, undefined);
});

test("active status between turns does not take an old answer; terminal reads retain failure and interruption", () => {
  const agents = new CodexAgents();
  agents.adopt("worker");
  const pending = { status: { type: "active", activeFlags: [] }, turns: [{ id: "old", status: "completed", items: [{ type: "agentMessage", text: "Old answer" }] }] };
  assert.equal(agents.described("worker", pending), null);
  assert.equal(agents.isRunning, true);
  assert.equal(agents.child("worker", "turn/completed", { turn: { id: "new", status: "completed" } })?.result, undefined);

  for (const [threadStatus, turnStatus, expected] of [["idle", "failed", "failed"], ["idle", "interrupted", "stopped"], ["notLoaded", "inProgress", "stopped"], ["systemError", "inProgress", "failed"]]) {
    const one = new CodexAgents();
    one.adopt("worker");
    const ended = one.described("worker", { status: { type: threadStatus }, turns: [{ id: "t1", status: turnStatus, items: [], error: { message: "Provider unavailable" } }] });
    assert.equal(ended?.status, expected);
    assert.equal(ended?.result, "Provider unavailable");
    assert.equal(one.runningTurn("worker"), undefined);
  }
});

test("at rest with its last turn still in progress, a sub-agent is left running until the last look, then counts as cut off; one Codex unloaded is cut off at once", () => {
  const agents = new CodexAgents();
  agents.adopt("worker");
  const atRest = { status: { type: "idle" }, turns: [{ id: "t1", status: "inProgress", items: [] }] };
  // Just finished: its turn's end is not in its thread yet.
  assert.equal(agents.described("worker", atRest, undefined, false), null);
  assert.equal(agents.isRunning, true);
  // Still so at the last look: it was cut off with its thread loaded.
  assert.equal(agents.described("worker", atRest, undefined, true)?.status, "stopped");

  const unloaded = new CodexAgents();
  unloaded.adopt("worker");
  assert.equal(unloaded.described("worker", { status: { type: "notLoaded" }, turns: [{ id: "t1", status: "inProgress", items: [] }] }, undefined, false)?.status, "stopped");
});

test("a read caught between two states is told apart: at work with no turn listed, or at rest with its turn in progress", () => {
  const turn = (status: string) => [{ id: "t1", status, items: [] }];
  assert.equal(betweenStates({ status: { type: "active" }, turns: turn("completed") }), true);
  assert.equal(betweenStates({ status: { type: "active" }, turns: [] }), true);
  assert.equal(betweenStates({ status: { type: "idle" }, turns: turn("inProgress") }), true);
  assert.equal(betweenStates({ status: { type: "active" }, turns: turn("inProgress") }), false);
  assert.equal(betweenStates({ status: { type: "idle" }, turns: turn("completed") }), false);
  assert.equal(betweenStates({ status: { type: "notLoaded" }, turns: turn("inProgress") }), false);
});

test("the turn a read says a sub-agent runs, for Stop: only one in progress in a thread at work, and not one known to have ended", () => {
  const agents = new CodexAgents();
  agents.adopt("worker");
  const active = { status: { type: "active" }, turns: [{ id: "t2", status: "inProgress", items: [] }] };
  assert.equal(agents.turnIn("worker", active), "t2");
  assert.equal(agents.turnIn("worker", { status: { type: "idle" }, turns: [{ id: "t2", status: "inProgress", items: [] }] }), undefined);
  assert.equal(agents.turnIn("worker", { status: { type: "active" }, turns: [{ id: "t2", status: "completed", items: [] }] }), undefined);
  assert.equal(agents.turnIn("worker", null), undefined);
  agents.child("worker", "turn/started", { turn: { id: "t2" } });
  agents.child("worker", "turn/completed", { turn: { id: "t2", status: "completed" } });
  assert.equal(agents.turnIn("worker", active), undefined);
});

test("settling reads the sub-agents at work and those that ended lately, not every one the thread ever spawned", () => {
  let now = 0;
  const agents = new CodexAgents(() => now);
  for (const id of ["old", "recent", "busy"]) agents.adopt(id);
  agents.child("old", "turn/started", { turn: { id: "o1" } });
  agents.child("old", "turn/completed", { turn: { id: "o1", status: "completed" } });
  now = 40 * 60_000;
  agents.child("recent", "turn/started", { turn: { id: "r1" } });
  agents.child("recent", "turn/completed", { turn: { id: "r1", status: "completed" } });
  now = 50 * 60_000;
  assert.deepEqual(agents.toSettle(30 * 60_000), ["recent", "busy"]);
});

test("v1: a late running state after it completed keeps its answer, so the completed state after it, with no message, still ends with it", () => {
  const agents = new CodexAgents();
  agents.item({ type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["v1"], prompt: "Count the files.", model: "gpt-6-luna" });
  agents.item({ type: "collabAgentToolCall", tool: "wait", agentsStates: { v1: { status: "completed", message: "There are 12 files." } } });
  const late = agents.item({ type: "collabAgentToolCall", tool: "wait", agentsStates: { v1: { status: "running" } } });
  assert.equal(late[0]?.status, "running");
  const done = agents.item({ type: "collabAgentToolCall", tool: "closeAgent", agentsStates: { v1: { status: "completed" } } });
  assert.deepEqual([done[0]?.status, done[0]?.result], ["completed", "There are 12 files."]);
  // A turn of its own clears it: what it says next is a new answer.
  agents.child("v1", "turn/started", { turn: { id: "v1-2" } });
  agents.child("v1", "turn/completed", { turn: { id: "v1-2", status: "completed" } });
  assert.equal(agents.described("v1", { status: { type: "idle" }, turns: [{ id: "v1-2", status: "completed", items: [] }] }), null);
  assert.equal(agents.item({ type: "collabAgentToolCall", tool: "wait", agentsStates: { v1: { status: "completed" } } })[0]?.result, undefined);
});

test("a sub-agent's nickname and role come from its thread: as it started, or as read later (after a restart)", () => {
  const agents = new CodexAgents(() => 1000);
  // Read from its thread, for one the stored thread told of.
  agents.item({ type: "subAgentActivity", id: "s", kind: "started", agentThreadId: child, agentPath: "/root/pear_reply" });
  const read = agents.described(child, { agentNickname: "Darwin", agentRole: "worker", status: { type: "idle" }, turns: [] });
  assert.equal(read?.nickname, "Darwin");
  assert.equal(read?.role, "worker");
  // Its path is still its goal; a read without them keeps them.
  assert.equal(read?.goal, "pear reply");
  assert.equal(agents.described(child, { agentNickname: null, agentRole: null, status: { type: "idle" }, turns: [] }), null);
  // From `thread/started`, which may say them only in its source.
  const started = agents.adopt("other", { source: { subAgent: { thread_spawn: { agent_path: "/root/fig_check", agent_nickname: "Hopper", agent_role: null } } } });
  assert.deepEqual([started?.nickname, started?.role, started?.goal], ["Hopper", undefined, "fig check"]);
  // Known from the spawn's item, which Codex sends before the thread's start: the start still names it.
  agents.item({ type: "subAgentActivity", id: "s2", kind: "started", agentThreadId: "fourth", agentPath: "/root/plum" });
  const named = agents.adopt("fourth", { agentNickname: "Noether", agentRole: "worker" });
  assert.deepEqual([named?.goal, named?.nickname, named?.role, named?.status], ["plum", "Noether", "worker", "running"]);
  assert.equal(agents.adopt("fourth", { agentNickname: "Noether", agentRole: "worker" }), null);
  // One spawned with no role has Codex's `default`, which says nothing: "Euclid", not "Euclid · default".
  const plain = agents.adopt("third", { agentNickname: "Euclid", agentRole: "default" });
  assert.deepEqual([plain?.nickname, plain?.role], ["Euclid", undefined]);
});

test("a sub-agent's item makes a row only for a sub-agent it started, not for the thread it messages", () => {
  const agents = new CodexAgents(() => 1000);
  agents.item({ type: "subAgentActivity", id: "s", kind: "started", agentThreadId: child, agentPath: "/root/pear_reply" });
  // The worker messages the thread it works for (`send_message`), which is no sub-agent.
  assert.deepEqual(agents.item({ type: "subAgentActivity", id: "m", kind: "interacted", agentThreadId: "root-thread", agentPath: "/root" }, child), []);
  assert.deepEqual(agents.item({ type: "subAgentActivity", id: "c", kind: "completed", agentThreadId: "root-thread", agentPath: "/root" }, child), []);
  assert.equal(agents.has("root-thread"), false);
  // One it starts is its own, set in under it.
  const [helper] = agents.item({ type: "subAgentActivity", id: "h", kind: "started", agentThreadId: "helper", agentPath: "/root/pear_reply/fig" }, child);
  assert.deepEqual([helper?.id, helper?.parent], ["helper", child]);
  // News of it through the worker's items after that is taken in.
  const [done] = agents.item({ type: "subAgentActivity", id: "h2", kind: "completed", agentThreadId: "helper", agentPath: "/root/pear_reply/fig" }, child);
  assert.equal(done?.status, "completed");
});

test("a sub-agent's news says which run of it it is, its turn, so that one that left the line is told apart from a new run of it", () => {
  const agents = new CodexAgents(() => 1000);
  agents.item({ type: "subAgentActivity", id: "s", kind: "started", agentThreadId: child, agentPath: "/root/worker" });
  assert.equal(agents.child(child, "turn/started", { turn: { id: "t1" } })?.run, "t1");
  const ended = agents.child(child, "turn/completed", { turn: { id: "t1", status: "completed" } });
  assert.deepEqual([ended?.status, ended?.run], ["completed", "t1"]);
  // A read of the same turn: the same run, and nothing shown changes.
  assert.equal(agents.described(child, { status: { type: "idle" }, turns: [{ id: "t1", status: "completed", items: [] }] }), null);
  // Given more to do: a new run.
  assert.equal(agents.child(child, "turn/started", { turn: { id: "t2" } })?.run, "t2");
  // A stored thread's sub-agent, whose turn the parent's items do not say: no run known.
  const stored = new CodexAgents(() => 0);
  const [past] = stored.remember([{ startedAt: 10, completedAt: 20, items: [{ type: "subAgentActivity", kind: "started", agentThreadId: "c9", agentPath: "/root/job" }] }]);
  assert.equal(past?.subagent.run, undefined);
});

// Feature subagent_calls: a call about the sub-agents other than a spawn names those it
// was about, as the line calls them, for its row.

test("v2: the recorded wait is about the sub-agent at work as it started, and still as it ended; by nickname once its thread names it", () => {
  const agents = new CodexAgents(() => 1000);
  const items = fixture("subagent").filter((entry) => entry.kind === "notification" && (entry.method === "item/started" || entry.method === "item/completed"));
  const said: (string[] | undefined)[] = [];
  for (const entry of items) {
    const item = entry.params.item;
    // As the session hands them over: a sub-agent's activity once it completes, a call as it starts and ends.
    if (entry.method === "item/completed" || item.type !== "subAgentActivity") agents.item(item);
    if (item.type === "collabAgentToolCall") said.push(agents.calledAbout(item));
  }
  assert.deepEqual(said, [["pear reply"], ["pear reply"]]);
  const wait = items.find((entry) => entry.params.item.type === "collabAgentToolCall")!.params.item;
  agents.adopt(child, { agentNickname: "Darwin", agentRole: "worker" });
  assert.deepEqual(agents.calledAbout(wait), ["Darwin"]);
  // A row that is no such call has none.
  assert.equal(agents.calledAbout({ type: "commandExecution", id: "x" }), undefined);
});

test("v2: a wait that comes back as one of two ends is about both; the next wait only the other; a wait with none left at work is about none", () => {
  const agents = new CodexAgents(() => 0);
  const started = (id: string, path: string) => agents.item({ type: "subAgentActivity", id: `start-${id}`, kind: "started", agentThreadId: id, agentPath: path });
  const ended = (id: string, path: string) => agents.item({ type: "subAgentActivity", id: `end-${id}`, kind: "completed", agentThreadId: id, agentPath: path });
  const wait = (id: string, status: string) => ({ type: "collabAgentToolCall", id, tool: "wait", status, receiverThreadIds: [], agentsStates: {} });
  started("d", "/root/count_files");
  started("e", "/root/read_readme");
  agents.adopt("d", { agentNickname: "Darwin" });
  agents.adopt("e", { agentNickname: "Euclid" });
  agents.item(wait("w1", "inProgress"));
  assert.deepEqual(agents.calledAbout(wait("w1", "inProgress")), ["Darwin", "Euclid"]);
  ended("d", "/root/count_files");
  agents.item(wait("w1", "completed"));
  assert.deepEqual(agents.calledAbout(wait("w1", "completed")), ["Darwin", "Euclid"]);
  agents.item(wait("w2", "inProgress"));
  ended("e", "/root/read_readme");
  agents.item(wait("w2", "completed"));
  assert.deepEqual(agents.calledAbout(wait("w2", "completed")), ["Euclid"]);
  // Both waited for to their end: a wait now is about nobody.
  agents.item(wait("w3", "completed"));
  assert.deepEqual(agents.calledAbout(wait("w3", "completed")), []);
  // One that ended while the agent did something else is what the next wait takes in.
  started("f", "/root/fig_check");
  ended("f", "/root/fig_check");
  agents.item(wait("w4", "completed"));
  assert.deepEqual(agents.calledAbout(wait("w4", "completed")), ["fig check"]);
});

test("a stored thread read back names who each wait was about as it did live: items stored as they completed", () => {
  const agents = new CodexAgents(() => 0);
  // How Codex keeps them: one sub-agent's end before the wait that took it in, the other's after.
  const turn = {
    id: "t1",
    status: "completed",
    items: [
      { type: "subAgentActivity", id: "s-d", kind: "started", agentThreadId: "d", agentPath: "/root/count_files" },
      { type: "subAgentActivity", id: "s-e", kind: "started", agentThreadId: "e", agentPath: "/root/read_readme" },
      { type: "subAgentActivity", id: "c-d", kind: "completed", agentThreadId: "d", agentPath: "/root/count_files" },
      { type: "collabAgentToolCall", id: "w1", tool: "wait", status: "completed", receiverThreadIds: [], agentsStates: {} },
      { type: "subAgentActivity", id: "c-e", kind: "completed", agentThreadId: "e", agentPath: "/root/read_readme" },
      { type: "collabAgentToolCall", id: "w2", tool: "wait", status: "completed", receiverThreadIds: [], agentsStates: {} },
    ],
  };
  agents.remember([turn]);
  assert.deepEqual(agents.calledAbout(turn.items[3]), ["count files", "read readme"]);
  assert.deepEqual(agents.calledAbout(turn.items[5]), ["read readme"]);
});

test("v1: a wait, a close and a message name those they name; a spawn's row carries its task instead; a sub-agent's own calls are not the thread's", () => {
  const agents = new CodexAgents(() => 0);
  const spawn = (id: string, prompt: string) => ({ type: "collabAgentToolCall", id: `spawn-${id}`, tool: "spawnAgent", status: "completed", receiverThreadIds: [id], prompt, agentsStates: { [id]: { status: "pendingInit" } } });
  agents.item(spawn("c1", "Count the files in this folder and in every folder under it.\nThen stop."));
  agents.item(spawn("c2", "Read the README."));
  agents.adopt("c2", { agentNickname: "Euclid" });
  assert.equal(agents.calledAbout(spawn("c1", "Count")), undefined);
  const call = (id: string, tool: string, named: string[], extra: Record<string, unknown> = {}) => ({ type: "collabAgentToolCall", id, tool, status: "completed", receiverThreadIds: named, agentsStates: {}, ...extra });
  agents.item(call("w", "wait", ["c1", "c2"]));
  // A long ask is cut short.
  assert.deepEqual(agents.calledAbout(call("w", "wait", [])), ["Count the files in this folder and in ev…", "Euclid"]);
  agents.item(call("m", "sendInput", ["c2"], { prompt: "Also the LICENSE." }));
  assert.deepEqual(agents.calledAbout(call("m", "sendInput", [])), ["Euclid"]);
  agents.item(call("x", "closeAgent", ["c1"]));
  assert.deepEqual(agents.calledAbout(call("x", "closeAgent", [])), ["Count the files in this folder and in ev…"]);
  // One of another thread's, which this thread never spawned, is not named.
  agents.item(call("o", "closeAgent", ["elsewhere"]));
  assert.deepEqual(agents.calledAbout(call("o", "closeAgent", [])), []);
  // A sub-agent's own wait is its own row, not the thread's.
  agents.item(call("nested", "wait", ["c2"]), "c1");
  assert.deepEqual(agents.calledAbout(call("nested", "wait", [])), []);
});

test("a wait's end told again (a reconnect, a read) changes nothing: a sub-agent that ended since is still what the next wait is about", () => {
  const agents = new CodexAgents(() => 0);
  agents.item({ type: "subAgentActivity", id: "s-d", kind: "started", agentThreadId: "d", agentPath: "/root/count_files" });
  agents.adopt("d", { agentNickname: "Darwin" });
  const wait = (id: string) => ({ type: "collabAgentToolCall", id, tool: "wait", status: "completed", receiverThreadIds: [], agentsStates: {} });
  // The first wait runs out of time while Darwin works.
  agents.item(wait("w1"));
  assert.deepEqual(agents.calledAbout(wait("w1")), ["Darwin"]);
  agents.item({ type: "subAgentActivity", id: "c-d", kind: "completed", agentThreadId: "d", agentPath: "/root/count_files" });
  // Its end comes again.
  agents.item(wait("w1"));
  assert.deepEqual(agents.calledAbout(wait("w1")), ["Darwin"]);
  agents.item(wait("w2"));
  assert.deepEqual(agents.calledAbout(wait("w2")), ["Darwin"]);
});

test("v1: a wait that names only threads that are not this thread's sub-agents names nobody, not the thread's own", () => {
  const agents = new CodexAgents(() => 0);
  agents.item({ type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed", receiverThreadIds: ["d"], prompt: "Count the files.", agentsStates: {} });
  agents.adopt("d", { agentNickname: "Darwin" });
  const elsewhere = { type: "collabAgentToolCall", id: "w", tool: "wait", status: "completed", receiverThreadIds: ["elsewhere"], agentsStates: { elsewhere: { status: "running" } } };
  agents.item(elsewhere);
  assert.deepEqual(agents.calledAbout(elsewhere), []);
});

test("a sub-agent's end told again after a wait took it in, or a start told again, does not make the next wait about it again", () => {
  const agents = new CodexAgents(() => 0);
  const started = { type: "subAgentActivity", id: "s-d", kind: "started", agentThreadId: "d", agentPath: "/root/count_files" };
  const ended = { type: "subAgentActivity", id: "c-d", kind: "completed", agentThreadId: "d", agentPath: "/root/count_files" };
  const wait = (id: string) => ({ type: "collabAgentToolCall", id, tool: "wait", status: "completed", receiverThreadIds: [], agentsStates: {} });
  agents.item(started);
  agents.item(ended);
  agents.item(wait("w1"));
  assert.deepEqual(agents.calledAbout(wait("w1")), ["count files"]);
  agents.item(started);
  agents.item(ended);
  agents.item(wait("w2"));
  assert.deepEqual(agents.calledAbout(wait("w2")), []);
});

test("v1: a message or more to do that fails does not make a later wait about a sub-agent that has ended; one its state says took it does", () => {
  const agents = new CodexAgents(() => 0);
  const call = (id: string, tool: string, named: string[], extra: Record<string, unknown> = {}) => ({ type: "collabAgentToolCall", id, tool, status: "completed", receiverThreadIds: named, agentsStates: {}, ...extra });
  agents.item(call("spawn", "spawnAgent", ["d"], { prompt: "Count the files.", agentsStates: { d: { status: "pendingInit" } } }));
  agents.item(call("w1", "wait", ["d"], { agentsStates: { d: { status: "completed", message: "12" } } }));
  for (const tool of ["followupTask", "sendInput", "resumeAgent"]) agents.item(call(`${tool}-failed`, tool, ["d"], { status: "failed", prompt: "And the folders." }));
  agents.item(call("w2", "wait", []));
  assert.deepEqual(agents.calledAbout(call("w2", "wait", [])), []);
  agents.item(call("again", "sendInput", ["d"], { prompt: "And the folders.", agentsStates: { d: { status: "running" } } }));
  agents.item(call("w3", "wait", []));
  assert.deepEqual(agents.calledAbout(call("w3", "wait", [])), ["Count the files."]);
});

test("v1: a spawn and a wait told again once their ends were taken in change nothing: the sub-agent is not at work again, and a later v2 wait is not about it", () => {
  const agents = new CodexAgents(() => 0);
  const spawn = { type: "collabAgentToolCall", id: "spawn-d", tool: "spawnAgent", status: "completed", receiverThreadIds: ["d"], prompt: "Count the files.", agentsStates: { d: { status: "pendingInit" } } };
  const waited = { type: "collabAgentToolCall", id: "w1", tool: "wait", status: "completed", receiverThreadIds: ["d"], agentsStates: { d: { status: "completed", message: "12" } } };
  agents.adopt("d", { agentNickname: "Darwin" });
  agents.item(spawn);
  agents.item(waited);
  assert.deepEqual(agents.calledAbout(waited), ["Darwin"]);
  // Told again, as a read that overlaps what came live tells them.
  assert.deepEqual(agents.item(spawn), []);
  assert.deepEqual(agents.item(waited), []);
  assert.equal(agents.isRunning, false);
  // Later work on v2.
  agents.item({ type: "subAgentActivity", id: "s-e", kind: "started", agentThreadId: "e", agentPath: "/root/euclid" });
  const wait = { type: "collabAgentToolCall", id: "w2", tool: "wait", status: "completed", receiverThreadIds: [], agentsStates: {} };
  agents.item(wait);
  assert.deepEqual(agents.calledAbout(wait), ["euclid"]);
});
