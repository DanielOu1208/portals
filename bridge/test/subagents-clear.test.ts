import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderSession, StoredMessage, SubagentInfo } from "../src/providers/types.ts";
import type { LoggedEvent } from "../src/sessions/eventLog.ts";
import type { Registry, ThreadRecord } from "../src/sessions/registry.ts";
import { Session, type Peer } from "../src/sessions/session.ts";

// Ended subagents and workflows leave the line when the next message goes to the agent
// (feature subagents_clear), from whichever device: `subagent.cleared` names them, and
// `subagent.list` no longer lists them. Those still at work stay. A session on its own,
// with an agent that only starts turns and takes messages into them.

function session(): Session {
  const record: ThreadRecord = {
    id: "clear-thread", agent: "stand-in", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone",
  };
  return new Session(record, { has: () => false } as unknown as Registry);
}

function agent(options: { history?: StoredMessage[]; past?: { subagent: SubagentInfo; turn: number }[] } = {}): ProviderSession & { steered: string[] } {
  const steered: string[] = [];
  return {
    steered,
    history: async () => options.history ?? [],
    pastSubagents: () => options.past ?? [],
    settings: () => ({ model: "m", provider: "p", reasoningEffort: "" }),
    startTurn: () => {},
    steer: async (prompt: { text: string }) => {
      steered.push(prompt.text);
      return true;
    },
    interrupt: async () => false,
    close: async () => {},
  } as unknown as ProviderSession & { steered: string[] };
}

function follower(): { peer: Peer; events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  return { peer: { isOpen: true, takesRequests: false, sendRequest: () => {}, sendEvent: (event: LoggedEvent) => events.push(event) } as unknown as Peer, events };
}

function subagent(id: string, status: SubagentInfo["status"] = "running", more: Partial<SubagentInfo> = {}): SubagentInfo {
  const info: SubagentInfo = { id, kind: "agent", goal: `Goal ${id}`, status, startedAt: 1000, background: true, stoppable: status === "running", ...more };
  if (status !== "running" && info.endedAt === undefined) info.endedAt = 2000;
  return info;
}

const listed = (thread: Session) => thread.subagentList().map((entry) => [entry.subagent_id, entry.status]);
const cleared = (events: LoggedEvent[]) => events.filter((event) => event.type === "subagent.cleared").map((event) => event.payload?.subagent_ids);
const nextStep = () => new Promise((resolve) => setImmediate(resolve));

test("a message clears the ended subagents from the line on every device; one still at work stays until the message after it ends", async () => {
  const thread = session();
  await thread.attach(agent());
  const phone = follower();
  const mac = follower();
  thread.follow(phone.peer);
  thread.follow(mac.peer);
  thread.submit("start two").begin?.();
  thread.sink.emit({ type: "subagent", subagent: subagent("a") });
  thread.sink.emit({ type: "subagent", subagent: subagent("b") });
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed") });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  // Ended, it stays on the line while nothing more is said.
  assert.deepEqual(listed(thread), [["a", "completed"], ["b", "running"]]);

  // Sent from the phone: both devices are told, and the list leaves it out from then on.
  thread.submit("next").begin?.();
  assert.deepEqual(cleared(phone.events), [["a"]]);
  assert.deepEqual(cleared(mac.events), [["a"]]);
  assert.deepEqual(listed(thread), [["b", "running"]]);
  // In the log, for a device that catches up on what it missed.
  assert.deepEqual(cleared(thread.eventsSince(0).events), [["a"]]);
  // After the turn's start, which opens the turn with the message.
  const types = phone.events.map((event) => event.type);
  assert.ok(types.lastIndexOf("message.start") < types.indexOf("subagent.cleared"));

  // The one at work ends later: on the line until the next message.
  thread.sink.emit({ type: "subagent", subagent: subagent("b", "failed") });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.deepEqual(listed(thread), [["b", "failed"]]);
  thread.submit("and again").begin?.();
  assert.deepEqual(cleared(phone.events), [["a"], ["b"]]);
  assert.deepEqual(listed(thread), []);
  // Nothing ended to clear: nothing said.
  thread.sink.emit({ type: "turn.end", status: "complete" });
  thread.submit("once more").begin?.();
  assert.equal(cleared(phone.events).length, 2);
});

test("a message steered into the running turn clears the ended ones when it is handed over", async () => {
  const thread = session();
  const stand = agent();
  await thread.attach(stand);
  const phone = follower();
  thread.follow(phone.peer);
  thread.submit("start one").begin?.();
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed") });
  thread.sink.emit({ type: "subagent", subagent: subagent("b") });
  assert.equal(thread.submit("also this").status, "steered");
  assert.deepEqual(stand.steered, ["also this"]);
  assert.deepEqual(cleared(phone.events), [["a"]]);
  assert.deepEqual(listed(thread), [["b", "running"]]);
});

test("a message waiting behind the running turn clears the line when its turn starts, not when it is sent, and one taken off the list never does", async () => {
  const thread = session();
  await thread.attach(agent());
  const phone = follower();
  thread.follow(phone.peer);
  thread.submit("start").begin?.();
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed") });
  const kept = thread.submit("later", { queue: true });
  const dropped = thread.submit("never", { queue: true });
  assert.equal(kept.status, "queued");
  assert.deepEqual(cleared(phone.events), []);
  assert.ok(thread.removeQueued(dropped.queueID!));
  assert.deepEqual(cleared(phone.events), []);
  // One that ends while the message waits leaves with it too: it ended before the message reached the agent.
  thread.sink.emit({ type: "subagent", subagent: subagent("b", "completed") });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await nextStep();
  assert.deepEqual(cleared(phone.events), [["a", "b"]]);
  assert.deepEqual(listed(thread), []);
});

test("a message through the fleet (portals send) clears the line as one from a device does", async () => {
  const thread = session();
  await thread.attach(agent());
  const phone = follower();
  thread.follow(phone.peer);
  thread.submit("start").begin?.();
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed") });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  thread.submit("from another agent", { fleet: true }).begin?.();
  assert.deepEqual(cleared(phone.events), [["a"]]);
});

test("a command sent as a message (/compact) leaves the line as it is", async () => {
  const thread = session();
  await thread.attach(agent());
  const phone = follower();
  thread.follow(phone.peer);
  thread.submit("start").begin?.();
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed") });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  thread.submit("/compact").begin?.();
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.deepEqual(cleared(phone.events), []);
  assert.deepEqual(listed(thread), [["a", "completed"]]);
  // A message that only starts with a path is words.
  thread.submit("/usr/local is full, look").begin?.();
  assert.deepEqual(cleared(phone.events), [["a"]]);
});

test("a turn the agent began by itself leaves the line as it is; one typed at the desk clears it", async () => {
  const thread = session();
  await thread.attach(agent());
  const phone = follower();
  thread.follow(phone.peer);
  thread.submit("start").begin?.();
  thread.sink.emit({ type: "subagent", subagent: subagent("a") });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  // Claude Code reports the background subagent's end in a turn of its own.
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed") });
  thread.sink.emit({ type: "turn.begin", user: "Agent finished", host: { kind: "async_delegation_complete", text: "Agent finished" } });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.deepEqual(cleared(phone.events), []);
  assert.deepEqual(listed(thread), [["a", "completed"]]);
  // The user types at the terminal.
  thread.sink.emit({ type: "turn.begin", user: "thanks, now commit" });
  assert.deepEqual(cleared(phone.events), [["a"]]);
});

test("one cleared from the line stays off it while it has ended, and comes back once it is given more to do", async () => {
  const thread = session();
  await thread.attach(agent());
  const phone = follower();
  thread.follow(phone.peer);
  thread.submit("start").begin?.();
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed") });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  thread.submit("next").begin?.();
  const seen = phone.events.length;
  // A late word of how it ended (a Codex read that settles it): kept, not shown.
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed", { result: "Done." }) });
  assert.equal(phone.events.length, seen);
  assert.deepEqual(listed(thread), []);
  // A Codex sub-agent given more to do: at work again, and on the line.
  thread.sink.emit({ type: "subagent", subagent: subagent("a") });
  assert.deepEqual(phone.events.slice(seen).map((event) => [event.type, event.payload?.subagent_id, event.payload?.status]), [["subagent.progress", "a", "running"]]);
  assert.deepEqual(listed(thread), [["a", "running"]]);
});

test("after a restart, those that had left the line stay off it; one the bridge never took off stays until the next message", async () => {
  const record: ThreadRecord = {
    id: "clear-restart", agent: "stand-in", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone", subagentsCleared: [{ id: "before" }, { id: "back-at-work", run: "t1" }],
  };
  const thread = new Session(record, { has: () => false } as unknown as Registry);
  const history: StoredMessage[] = [
    { role: "user", text: "start two", timestamp: 1 },
    { role: "assistant", text: "Started.", timestamp: 2 },
    // Typed at the desk while the bridge was off: the bridge did not take anything off for it.
    { role: "user", text: "thanks", timestamp: 8 },
  ];
  const past = [
    { subagent: subagent("before", "completed"), turn: -1 },
    { subagent: subagent("unseen", "completed", { run: "u1" }), turn: -1 },
    // Given more to do while the bridge was off, and still at work: on the line.
    { subagent: subagent("back-at-work"), turn: -1 },
  ];
  await thread.attach(agent({ history, past }));
  assert.deepEqual(listed(thread), [["unseen", "completed"], ["back-at-work", "running"]]);
  // The next message clears the ended one, names only it, and keeps it with the thread, with its run.
  const phone = follower();
  thread.follow(phone.peer);
  thread.submit("go on").begin?.();
  assert.deepEqual(cleared(phone.events), [["unseen"]]);
  assert.deepEqual(record.subagentsCleared, [{ id: "before" }, { id: "back-at-work", run: "t1" }, { id: "unseen", run: "u1" }]);
  // Not sent to devices.
  assert.equal(thread.subagentList().some((entry) => "run" in entry), false);
});

test("after a restart, one cleared by a message steered into the turn it ended in stays off the line, though the stored message bears the turn's start", async () => {
  const record: ThreadRecord = {
    id: "clear-steer", agent: "stand-in", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone",
  };
  const registry = { has: () => false } as unknown as Registry;
  const live = new Session(record, registry);
  await live.attach(agent());
  live.submit("start").begin?.();
  live.sink.emit({ type: "subagent", subagent: subagent("child") });
  live.sink.emit({ type: "subagent", subagent: subagent("child", "completed", { endedAt: 130_000 }) });
  assert.equal(live.submit("and this").status, "steered");
  assert.deepEqual(live.subagentList(), []);
  live.sink.emit({ type: "turn.end", status: "complete" });

  // The bridge restarts. Codex keeps no time for a message steered in: its history gives it the turn's start.
  const again = new Session(record, registry);
  const history: StoredMessage[] = [
    { role: "user", text: "start", timestamp: 100 },
    { role: "user", text: "and this", timestamp: 100, display_kind: "steer" },
    { role: "assistant", text: "Done.", timestamp: 200 },
  ];
  await again.attach(agent({ history, past: [{ subagent: subagent("child", "completed", { endedAt: 130_000 }), turn: 0 }] }));
  assert.deepEqual(listed(again), []);
});

test("after a restart, a closer look at one that had left the line keeps it off while it is the run that left, and brings back another run", async () => {
  const record: ThreadRecord = {
    id: "clear-look", agent: "stand-in", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone",
    subagentsCleared: [{ id: "stale", run: "s1" }, { id: "again", run: "a1" }, { id: "nested" }, { id: "rerun", run: "r1" }],
  };
  const thread = new Session(record, { has: () => false } as unknown as Registry);
  const past = [
    // The stored thread left these at work (it does not say their runs); one had in fact ended in the run that left the line.
    { subagent: subagent("stale"), turn: 0 },
    { subagent: subagent("again"), turn: 0 },
    // Ended again while the bridge was off, in another run: off the line at first, as the stored thread does not say which run.
    { subagent: subagent("rerun", "completed"), turn: 0 },
  ];
  await thread.attach(agent({ past }));
  const phone = follower();
  thread.follow(phone.peer);
  assert.deepEqual(listed(thread), [["stale", "running"], ["again", "running"]]);
  // Its own thread says it ended in the run that left: shown ended, then off the line.
  thread.sink.emit({ type: "subagent", subagent: subagent("stale", "completed", { run: "s1" }) });
  // A sub-agent's own, found after the restart, that had left the line: never on it.
  thread.sink.emit({ type: "subagent", subagent: subagent("nested", "completed") });
  // At work in a new run, which ends now: on the line until the next message.
  thread.sink.emit({ type: "subagent", subagent: subagent("again", "running", { run: "a2" }) });
  thread.sink.emit({ type: "subagent", subagent: subagent("again", "completed", { run: "a2" }) });
  // Its own thread says which run it ended in: another, so on the line again.
  thread.sink.emit({ type: "subagent", subagent: subagent("rerun", "completed", { run: "r2", result: "Again." }) });
  // A late word of the run that left, timed when it was heard: still off.
  thread.sink.emit({ type: "subagent", subagent: subagent("stale", "completed", { run: "s1", endedAt: Date.now() }) });
  assert.deepEqual(
    phone.events.map((event) => [event.type, event.payload?.subagent_id ?? event.payload?.subagent_ids]),
    [
      ["subagent.complete", "stale"],
      ["subagent.cleared", ["stale"]],
      ["subagent.progress", "again"],
      ["subagent.complete", "again"],
      ["subagent.complete", "rerun"],
    ],
  );
  assert.deepEqual(listed(thread), [["again", "completed"], ["rerun", "completed"]]);
});

test("one given more to do after it left the line is no longer kept as cleared, so a restart does not hide its new run", async () => {
  const record: ThreadRecord = {
    id: "clear-again", agent: "stand-in", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone",
  };
  const registry = { has: () => false } as unknown as Registry;
  const live = new Session(record, registry);
  await live.attach(agent());
  live.submit("start").begin?.();
  live.sink.emit({ type: "subagent", subagent: subagent("worker", "completed", { run: "w1" }) });
  live.sink.emit({ type: "turn.end", status: "complete" });
  live.submit("next").begin?.();
  assert.deepEqual(record.subagentsCleared, [{ id: "worker", run: "w1" }]);
  // A late word of that run, heard now: still off the line.
  live.sink.emit({ type: "subagent", subagent: subagent("worker", "completed", { run: "w1", endedAt: Date.now() }) });
  assert.deepEqual(live.subagentList(), []);
  // Given more to do: at work again, and no longer kept as cleared.
  live.sink.emit({ type: "subagent", subagent: subagent("worker", "running", { run: "w2" }) });
  assert.equal(record.subagentsCleared, undefined);
  live.sink.emit({ type: "subagent", subagent: subagent("worker", "completed", { run: "w2" }) });
  live.sink.emit({ type: "turn.end", status: "complete" });

  // After a restart, long after, its new run is on the line until the next message, as the stored thread tells of it.
  const again = new Session(record, registry);
  await again.attach(agent({ past: [{ subagent: subagent("worker", "completed"), turn: 0 }] }));
  assert.deepEqual(listed(again), [["worker", "completed"]]);
});

test("after a restart, one left at work in the stored thread whose own thread names a new run is no longer kept as cleared, so the next restart shows that run", async () => {
  const record: ThreadRecord = {
    id: "clear-named", agent: "stand-in", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone", subagentsCleared: [{ id: "worker", run: "t1" }],
  };
  const registry = { has: () => false } as unknown as Registry;
  const thread = new Session(record, registry);
  // The stored thread left it at work, and does not say in which run.
  await thread.attach(agent({ past: [{ subagent: subagent("worker"), turn: 0 }] }));
  // That alone keeps the record as it is.
  thread.sink.emit({ type: "subagent", subagent: subagent("worker", "running", { summary: "Reading" }) });
  assert.deepEqual(record.subagentsCleared, [{ id: "worker", run: "t1" }]);
  // Its own thread says it is at work in t2: another run.
  thread.sink.emit({ type: "subagent", subagent: subagent("worker", "running", { run: "t2" }) });
  assert.equal(record.subagentsCleared, undefined);
  thread.sink.emit({ type: "subagent", subagent: subagent("worker", "completed", { run: "t2" }) });
  assert.deepEqual(listed(thread), [["worker", "completed"]]);
  const again = new Session(record, registry);
  await again.attach(agent({ past: [{ subagent: subagent("worker", "completed"), turn: 0 }] }));
  assert.deepEqual(listed(again), [["worker", "completed"]]);
});

test("a message whose record cannot be written leaves the line as it was, and the next one clears it", async () => {
  const record: ThreadRecord = {
    id: "clear-disk", agent: "stand-in", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone",
  };
  let full = false;
  const registry = {
    has: () => true,
    update: () => {
      if (full) throw new Error("disk full");
    },
    set: () => {
      if (full) throw new Error("disk full");
    },
  } as unknown as Registry;
  const thread = new Session(record, registry);
  const stand = agent();
  await thread.attach(stand);
  const phone = follower();
  thread.follow(phone.peer);
  thread.submit("start").begin?.();
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed") });
  // Steered in while the disk is full: the write fails, and nothing leaves the line. The
  // message still goes to the agent.
  full = true;
  assert.equal(thread.submit("also this").status, "steered");
  assert.deepEqual(stand.steered, ["also this"]);
  assert.deepEqual(listed(thread), [["a", "completed"]]);
  assert.deepEqual(cleared(phone.events), []);
  full = false;
  thread.sink.emit({ type: "turn.end", status: "complete" });
  thread.submit("now").begin?.();
  assert.deepEqual(cleared(phone.events), [["a"]]);
});

test("a turn whose start cannot be written in the record opens all the same and leaves the line as it was, from a device or typed at the desk, and the next one clears it", async () => {
  const record: ThreadRecord = {
    id: "clear-disk-start", agent: "stand-in", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone",
  };
  let full = false;
  const registry = {
    has: () => true,
    update: () => {
      if (full) throw new Error("disk full");
    },
    set: () => {
      if (full) throw new Error("disk full");
    },
  } as unknown as Registry;
  const thread = new Session(record, registry);
  await thread.attach(agent());
  const phone = follower();
  thread.follow(phone.peer);
  thread.submit("start").begin?.();
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed") });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  full = true;
  thread.submit("from the phone").begin?.();
  assert.equal(thread.isRunning, true);
  assert.deepEqual(listed(thread), [["a", "completed"]]);
  thread.sink.emit({ type: "turn.end", status: "complete" });
  thread.sink.emit({ type: "turn.begin", user: "typed at the desk" });
  assert.equal(thread.isRunning, true);
  assert.deepEqual(listed(thread), [["a", "completed"]]);
  assert.deepEqual(cleared(phone.events), []);
  full = false;
  thread.sink.emit({ type: "turn.end", status: "complete" });
  thread.submit("now").begin?.();
  assert.deepEqual(cleared(phone.events), [["a"]]);
});

// A Codex desk turn missed while the bridge's connection to Codex was down is told once it
// is back (feature turn_messages), after the bridge has heard what ended meanwhile: its
// message came before those ends, so telling it takes nothing off the line.
test("a Codex desk turn told once the connection is back leaves on the line a sub-agent that ended after it", async () => {
  const { CodexSession } = await import("../src/providers/codex/session.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = await mkdtemp(join(tmpdir(), "portals-clear-missed-"));
  const spawned = { type: "subAgentActivity", id: "spawn-worker", kind: "started", agentThreadId: "worker", agentPath: "/root/worker" };
  const first = { id: "p1", status: "completed", startedAt: 10, completedAt: 20, items: [{ type: "userMessage", id: "u1", content: [{ type: "text", text: "Start a worker in the background." }] }, spawned] };
  const missed = { id: "p2", status: "completed", startedAt: 30, completedAt: 40, items: [{ type: "userMessage", id: "u2", content: [{ type: "text", text: "Typed at the desk while the worker runs." }] }, { type: "agentMessage", id: "a2", text: "Noted." }] };
  const run = { id: "worker-run", status: "inProgress", startedAt: 15, items: [] };
  let parent: Record<string, unknown> = { status: { type: "idle" }, turns: [first] };
  let child: Record<string, unknown> = { status: { type: "active" }, turns: [run] };
  const host = {
    client: {
      call: async (method: string, params: { threadId: string }) => {
        if (method === "thread/read") return { thread: structuredClone(params.threadId === "parent" ? parent : child) };
        if (method === "thread/resume") return { thread: structuredClone(parent) };
        throw new Error(`unexpected ${method}`);
      },
    },
    defaults: () => null, defaultsFor: async () => null, efforts: () => [], imagesDir: folder, interruptGraceMs: 100, forget() {},
  };
  const record: ThreadRecord = {
    id: "parent", agent: "codex", cwd: folder, title: "Missed", model: "m", provider: "p", reasoningEffort: "low", createdAt: 1, updatedAt: 1, origin: "phone",
  };
  const thread = new Session(record, { has: () => false, set() {}, update() {} } as unknown as Registry);
  const phone = follower();
  thread.follow(phone.peer);
  const codex = new CodexSession({ id: "parent", cwd: folder, settings: { model: "m", provider: "p", reasoningEffort: "low" } } as never, thread.sink, host as never, { applied: null, subscribed: true });
  try {
    await codex.load();
    await thread.attach(codex);
    await nextStep();
    assert.deepEqual(listed(thread), [["worker", "running"]]);
    codex.connectionLost();
    // Meanwhile: a message typed at the desk, and after it the worker's end.
    parent = { status: { type: "idle" }, turns: [first, missed] };
    child = { status: { type: "idle" }, turns: [{ ...run, status: "completed", completedAt: 50, items: [{ type: "agentMessage", id: "answer", text: "Done." }] }] };
    let loaded!: (threads: Set<string>) => void;
    const back = codex.reconnected(new Promise<Set<string>>((resolve) => (loaded = resolve)));
    await nextStep();
    // The worker's end is heard first; then the desk turn is told.
    assert.deepEqual(listed(thread), [["worker", "completed"]]);
    loaded(new Set(["parent"]));
    await back;
    await nextStep();
    assert.ok(phone.events.some((event) => event.type === "message.start" && event.payload?.text === "Typed at the desk while the worker runs."));
    assert.deepEqual(listed(thread), [["worker", "completed"]]);
    assert.deepEqual(cleared(phone.events), []);
    assert.equal(record.subagentsCleared, undefined);
  } finally {
    await codex.close();
    await rm(folder, { recursive: true, force: true });
  }
});

// A desk message Codex sends while the bridge, back on its connection, reads the thread
// for the turns it missed is held until those are told; when the read has its turn too,
// the turn is told from the read, and its message takes off the line what had ended
// when it came, as it would have had it come a moment later.
async function recovering(child: Record<string, unknown>) {
  const { CodexSession } = await import("../src/providers/codex/session.ts");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = await mkdtemp(join(tmpdir(), "portals-clear-held-"));
  const first = { id: "p1", status: "completed", startedAt: 10, completedAt: 20, items: [{ type: "userMessage", id: "u1", content: [{ type: "text", text: "Start a worker." }] }, { type: "subAgentActivity", id: "spawn", kind: "started", agentThreadId: "worker", agentPath: "/root/worker" }] };
  const state = { parent: { status: { type: "idle" }, turns: [first] } as Record<string, unknown>, child, gate: null as Promise<unknown> | null };
  const host = {
    client: {
      call: async (method: string, params: { threadId: string }) => {
        if (method === "thread/read") return params.threadId === "parent" ? (state.gate ?? { thread: structuredClone(state.parent) }) : { thread: structuredClone(state.child) };
        if (method === "thread/resume") return { thread: structuredClone(state.parent) };
        throw new Error(`unexpected ${method}`);
      },
    },
    defaults: () => null, defaultsFor: async () => null, efforts: () => [], imagesDir: folder, interruptGraceMs: 100, forget() {},
  };
  const record: ThreadRecord = { id: "parent", agent: "codex", cwd: folder, title: "Held", model: "m", provider: "p", reasoningEffort: "low", createdAt: 1, updatedAt: 1, origin: "phone" };
  const thread = new Session(record, { has: () => false, set() {}, update() {} } as unknown as Registry);
  const codex = new CodexSession({ id: "parent", cwd: folder, settings: { model: "m", provider: "p", reasoningEffort: "low" } } as never, thread.sink, host as never, { applied: null, subscribed: true });
  await codex.load();
  await thread.attach(codex);
  await nextStep();
  return { thread, codex, record, state, first, folder };
}

const deskMessage = (turn: string, text: string) => ({ type: "userMessage", id: `m-${turn}`, content: [{ type: "text", text }] });

for (const status of ["completed", "inProgress"] as const) {
  test(`a desk message heard while the bridge reads the thread again clears what had ended then, its turn ${status === "completed" ? "ended" : "running"} when told`, async () => {
    const ended = { status: { type: "idle" }, turns: [{ id: "worker-run", status: "completed", startedAt: 15, completedAt: 25, items: [{ type: "agentMessage", id: "a", text: "Done." }] }] };
    const { thread, codex, record, state, first, folder } = await recovering(ended);
    try {
      assert.deepEqual(listed(thread), [["worker", "completed"]]);
      codex.connectionLost();
      let read!: (value: unknown) => void;
      state.gate = new Promise((resolve) => (read = resolve));
      const back = codex.reconnected(Promise.resolve(new Set(["parent"])));
      await nextStep();
      const turn = { id: "p2", status, startedAt: 30, completedAt: status === "completed" ? 40 : null, items: [deskMessage("p2", "Typed as the bridge came back.")] };
      codex.notification("turn/started", { threadId: "parent", turn: { ...turn, items: [] } });
      codex.notification("item/completed", { threadId: "parent", turnId: "p2", item: turn.items[0] });
      if (status === "completed") codex.notification("turn/completed", { threadId: "parent", turn });
      read({ thread: { status: { type: status === "completed" ? "idle" : "active" }, turns: [first, turn] } });
      await back;
      await nextStep();
      assert.deepEqual(listed(thread), []);
      assert.deepEqual(record.subagentsCleared, [{ id: "worker", run: "worker-run" }]);
    } finally {
      await codex.close();
      const { rm } = await import("node:fs/promises");
      await rm(folder, { recursive: true, force: true });
    }
  });
}

test("a desk message heard while the bridge reads the thread again leaves on the line a sub-agent whose end came after it", async () => {
  const running = { status: { type: "active" }, turns: [{ id: "worker-run", status: "inProgress", startedAt: 15, items: [] }] };
  const { thread, codex, record, state, first, folder } = await recovering(running);
  try {
    assert.deepEqual(listed(thread), [["worker", "running"]]);
    codex.connectionLost();
    let read!: (value: unknown) => void;
    state.gate = new Promise((resolve) => (read = resolve));
    const back = codex.reconnected(Promise.resolve(new Set(["parent"])));
    await nextStep();
    const turn = { id: "p2", status: "completed", startedAt: 30, completedAt: 40, items: [deskMessage("p2", "Typed while the worker runs.")] };
    codex.notification("turn/started", { threadId: "parent", turn: { ...turn, items: [] } });
    codex.notification("item/completed", { threadId: "parent", turnId: "p2", item: turn.items[0] });
    codex.notification("turn/completed", { threadId: "parent", turn });
    // The worker ends after the message, before the read comes back.
    state.child = { status: { type: "idle" }, turns: [{ id: "worker-run", status: "completed", startedAt: 15, completedAt: 50, items: [{ type: "agentMessage", id: "a", text: "Done." }] }] };
    codex.agentNotification("worker", "turn/completed", { threadId: "worker", turn: { id: "worker-run", status: "completed", completedAt: 50 } });
    await nextStep();
    read({ thread: { status: { type: "idle" }, turns: [first, turn] } });
    await back;
    await nextStep();
    assert.deepEqual(listed(thread), [["worker", "completed"]]);
    assert.equal(record.subagentsCleared, undefined);
  } finally {
    await codex.close();
    const { rm } = await import("node:fs/promises");
    await rm(folder, { recursive: true, force: true });
  }
});

test("a desk message heard while the bridge reads the thread again leaves on the line a sub-agent's later run that ended after it", async () => {
  const ended = { status: { type: "idle" }, turns: [{ id: "worker-run", status: "completed", startedAt: 15, completedAt: 25, items: [{ type: "agentMessage", id: "a", text: "Done." }] }] };
  const { thread, codex, record, state, first, folder } = await recovering(ended);
  try {
    codex.connectionLost();
    let read!: (value: unknown) => void;
    state.gate = new Promise((resolve) => (read = resolve));
    const back = codex.reconnected(Promise.resolve(new Set(["parent"])));
    await nextStep();
    const turn = { id: "p2", status: "completed", startedAt: 30, completedAt: 40, items: [deskMessage("p2", "Typed as the bridge came back.")] };
    codex.notification("turn/started", { threadId: "parent", turn: { ...turn, items: [] } });
    codex.notification("item/completed", { threadId: "parent", turnId: "p2", item: turn.items[0] });
    codex.notification("turn/completed", { threadId: "parent", turn });
    // After the message, the worker is given more to do and ends again: a run of its own.
    codex.agentNotification("worker", "turn/started", { threadId: "worker", turn: { id: "worker-run-2", status: "inProgress", items: [] } });
    codex.agentNotification("worker", "turn/completed", { threadId: "worker", turn: { id: "worker-run-2", status: "completed" } });
    await nextStep();
    assert.equal(thread.subagentList()[0]?.status, "completed");
    read({ thread: { status: { type: "idle" }, turns: [first, turn] } });
    await back;
    await nextStep();
    assert.deepEqual(listed(thread), [["worker", "completed"]]);
    assert.equal(record.subagentsCleared, undefined);
  } finally {
    await codex.close();
    const { rm } = await import("node:fs/promises");
    await rm(folder, { recursive: true, force: true });
  }
});

for (const read of ["leaves the turn out", "fails"] as const) {
  test(`a desk message heard while the bridge reads the thread again, told from what was held when the read ${read}, leaves on the line a sub-agent whose end came after it`, async () => {
    const running = { status: { type: "active" }, turns: [{ id: "worker-run", status: "inProgress", startedAt: 15, items: [] }] };
    const { thread, codex, record, state, first, folder } = await recovering(running);
    try {
      codex.connectionLost();
      let answer!: (value: unknown) => void;
      let fail!: (error: Error) => void;
      state.gate = new Promise((resolve, reject) => {
        answer = resolve;
        fail = reject;
      });
      const back = codex.reconnected(Promise.resolve(new Set(["parent"])));
      await nextStep();
      const turn = { id: "p2", status: "completed", startedAt: 30, completedAt: 40, items: [deskMessage("p2", "Typed while the worker runs.")] };
      codex.notification("turn/started", { threadId: "parent", turn: { ...turn, items: [] } });
      codex.notification("item/completed", { threadId: "parent", turnId: "p2", item: turn.items[0] });
      codex.notification("turn/completed", { threadId: "parent", turn });
      state.child = { status: { type: "idle" }, turns: [{ id: "worker-run", status: "completed", startedAt: 15, completedAt: 50, items: [] }] };
      codex.agentNotification("worker", "turn/completed", { threadId: "worker", turn: { id: "worker-run", status: "completed" } });
      await nextStep();
      assert.equal(thread.subagentList()[0]?.status, "completed");
      if (read === "fails") fail(new Error("the read failed"));
      else answer({ thread: { status: { type: "idle" }, turns: [first] } });
      await back;
      await nextStep();
      assert.ok(thread.subagentList().length === 1, "the message came before the worker's end");
      assert.equal(record.subagentsCleared, undefined);
    } finally {
      await codex.close();
      const { rm } = await import("node:fs/promises");
      await rm(folder, { recursive: true, force: true });
    }
  });
}

test("a desk message heard while the bridge reads the thread again keeps what it may clear across another drop of the connection", async () => {
  const running = { status: { type: "active" }, turns: [{ id: "worker-run", status: "inProgress", startedAt: 15, items: [] }] };
  const { thread, codex, record, state, folder } = await recovering(running);
  try {
    codex.connectionLost();
    let fail!: (error: Error) => void;
    state.gate = new Promise((_, reject) => (fail = reject));
    const back = codex.reconnected(Promise.resolve(new Set(["parent"])));
    await nextStep();
    const turn = { id: "p2", status: "completed", startedAt: 30, completedAt: 40, items: [deskMessage("p2", "Typed while the worker runs.")] };
    codex.notification("turn/started", { threadId: "parent", turn: { ...turn, items: [] } });
    codex.notification("item/completed", { threadId: "parent", turnId: "p2", item: turn.items[0] });
    codex.notification("turn/completed", { threadId: "parent", turn });
    state.child = { status: { type: "idle" }, turns: [{ id: "worker-run", status: "completed", startedAt: 15, completedAt: 50, items: [] }] };
    codex.agentNotification("worker", "turn/completed", { threadId: "worker", turn: { id: "worker-run", status: "completed" } });
    await nextStep();
    // The connection drops again before the read answers; what was held is told then.
    codex.connectionLost();
    fail(new Error("the connection dropped"));
    await back;
    await nextStep();
    assert.deepEqual(listed(thread), [["worker", "completed"]]);
    assert.equal(record.subagentsCleared, undefined);
  } finally {
    await codex.close();
    const { rm } = await import("node:fs/promises");
    await rm(folder, { recursive: true, force: true });
  }
});

test("many desk messages heard while the bridge reads the thread again each keep what they may clear until they are told", async () => {
  const running = { status: { type: "active" }, turns: [{ id: "worker-run", status: "inProgress", startedAt: 15, items: [] }] };
  const { thread, codex, record, state, folder } = await recovering(running);
  try {
    codex.connectionLost();
    let fail!: (error: Error) => void;
    state.gate = new Promise((_, reject) => (fail = reject));
    const back = codex.reconnected(Promise.resolve(new Set(["parent"])));
    await nextStep();
    for (let index = 2; index <= 20; index += 1) {
      const turn = { id: `p${index}`, status: "completed", items: [deskMessage(`p${index}`, `Desk message ${index}.`)] };
      codex.notification("turn/started", { threadId: "parent", turn: { ...turn, items: [] } });
      codex.notification("item/completed", { threadId: "parent", turnId: turn.id, item: turn.items[0] });
      codex.notification("turn/completed", { threadId: "parent", turn });
    }
    state.child = { status: { type: "idle" }, turns: [{ id: "worker-run", status: "completed", startedAt: 15, completedAt: 50, items: [] }] };
    codex.agentNotification("worker", "turn/completed", { threadId: "worker", turn: { id: "worker-run", status: "completed" } });
    await nextStep();
    fail(new Error("the read failed"));
    await back;
    await nextStep();
    assert.deepEqual(listed(thread), [["worker", "completed"]]);
    assert.equal(record.subagentsCleared, undefined);
  } finally {
    await codex.close();
    const { rm } = await import("node:fs/promises");
    await rm(folder, { recursive: true, force: true });
  }
});

test("late news of a subagent's older run changes nothing once its agent began another run of it (recent-19)", async () => {
  const thread = session();
  await thread.attach(agent());
  const phone = follower();
  thread.follow(phone.peer);
  thread.submit("start one").begin?.();
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "running", { run: "t1" }) });
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed", { run: "t1" }) });
  // Given more to do: a new run of it.
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "running", { run: "t2", summary: "second" }) });
  const before = phone.events.length;
  // The first run's end told again late (a delayed read, a reconnect's catch-up).
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed", { run: "t1", result: "first answer" }) });
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "running", { run: "t1" }) });
  assert.deepEqual(listed(thread), [["a", "running"]]);
  assert.equal(thread.subagentList()[0].summary, "second");
  assert.equal(phone.events.length, before);
  // The current run's own news still goes through, and a newer run after it.
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed", { run: "t2", result: "second answer" }) });
  assert.deepEqual(listed(thread), [["a", "completed"]]);
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "running", { run: "t3" }) });
  assert.deepEqual(listed(thread), [["a", "running"]]);
  // News naming no run is taken as before.
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed") });
  assert.deepEqual(listed(thread), [["a", "completed"]]);
});

test("a run the agent's history told of as the thread was loaded comes before one it tells of after, whose place its late news does not take (recent-19)", async () => {
  const thread = session();
  await thread.attach(agent({ past: [{ subagent: subagent("a", "completed", { run: "loaded" }), turn: 0 }] }));
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "running", { run: "live" }) });
  thread.sink.emit({ type: "subagent", subagent: subagent("a", "completed", { run: "loaded" }) });
  assert.deepEqual(listed(thread), [["a", "running"]]);
});
