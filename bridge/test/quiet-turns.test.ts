import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setLogLevel } from "../src/log.ts";
import type { Prompt, ProviderSession } from "../src/providers/types.ts";
import type { LoggedEvent } from "../src/sessions/eventLog.ts";
import type { Registry, ThreadRecord } from "../src/sessions/registry.ts";
import { quietLimitMs, Session, stopWaitMs, type Peer } from "../src/sessions/session.ts";

// A turn that goes quiet, and a Stop the agent does not take. Five minutes without a word
// from the agent put a line on the turn's status saying so, and that Stop ends it; the
// agent's next word takes it down. Nothing is stopped and nothing fails: the agent may be
// running a command that prints nothing. A Stop the agent has not taken in `stopWaitMs`
// (it cannot be reached, a call to it hangs) ends the turn here, what the agent still
// says of that turn is let go of, and a message sent before the agent ends that turn waits
// for its end. A session on its own, with an agent that only starts
// turns, on mocked timers.

setLogLevel("silent");

const quietLine = "No word from Codex for 5 minutes. It may still be working; Stop ends it.";

function session(): Session {
  const record: ThreadRecord = {
    id: "quiet-thread", agent: "stand-in", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone",
  };
  return new Session(record, { has: () => false } as unknown as Registry, { agentName: "Codex" });
}

/** An agent that only starts turns. Its Stop is `stop`: by default one that is never answered. */
function agent(stop: () => Promise<boolean> = () => new Promise(() => {})): { agent: ProviderSession; started: string[] } {
  const started: string[] = [];
  const agent = {
    history: async () => [],
    settings: () => ({ model: "m", provider: "p", reasoningEffort: "" }),
    startTurn: (prompt: Prompt) => started.push(prompt.text),
    interrupt: stop,
    close: async () => {},
  } as unknown as ProviderSession;
  return { agent, started };
}

function follower(): { peer: Peer; events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  return { peer: { isOpen: true, takesRequests: false, sendRequest: () => {}, sendEvent: (event: LoggedEvent) => events.push(event) } as unknown as Peer, events };
}

/** The status lines a device was told, in order. */
function lines(events: LoggedEvent[]): unknown[] {
  return events.filter((event) => event.type === "thinking.delta").map((event) => event.payload?.text);
}

const nextStep = () => new Promise<void>((resolve) => setImmediate(resolve));

async function running(t: TestContext, stop?: () => Promise<boolean>) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const thread = session();
  const { agent: stub, started } = agent(stop);
  await thread.attach(stub);
  const device = follower();
  thread.follow(device.peer);
  thread.submit("run the build").begin?.();
  return { thread, device, started };
}

test("a turn with no word from the agent for five minutes says so on its status line, and the agent's next word takes the line down", async (t) => {
  const { thread, device } = await running(t);
  t.mock.timers.tick(quietLimitMs - 1);
  assert.deepEqual(lines(device.events), []);
  t.mock.timers.tick(1);
  assert.deepEqual(lines(device.events), [quietLine]);
  // Nothing is stopped or failed, and a device that opens the thread now is shown the line too.
  assert.equal(thread.isRunning, true);
  assert.equal(thread.snapshot().status_line, quietLine);
  // Said once, however long the quiet lasts.
  t.mock.timers.tick(3 * quietLimitMs);
  assert.deepEqual(lines(device.events), [quietLine]);

  // The agent's next word puts back the line it had before (none), and the quiet is counted again from it.
  thread.sink.emit({ type: "tool.progress", id: "t1", output: "compiling" });
  assert.deepEqual(lines(device.events), [quietLine, ""]);
  assert.equal(thread.snapshot().status_line, undefined);
  t.mock.timers.tick(quietLimitMs);
  assert.deepEqual(lines(device.events), [quietLine, "", quietLine]);

  // Its end takes the line down, and nothing more is said of a thread at rest.
  thread.sink.emit({ type: "turn.end", status: "complete" });
  t.mock.timers.tick(3 * quietLimitMs);
  assert.deepEqual(lines(device.events), [quietLine, "", quietLine]);
  assert.equal(device.events.filter((event) => event.type === "message.complete").length, 1);
});

test("each word from the agent counts the quiet again, with one timer, and a status line of the agent's is put back after the quiet", async (t) => {
  const { thread, device } = await running(t);
  thread.sink.emit({ type: "status", text: "Compacting the conversation…" });
  t.mock.timers.tick(quietLimitMs - 60_000);
  thread.sink.emit({ type: "turn.usage", usage: { tokens: 10 } });
  t.mock.timers.tick(quietLimitMs - 60_000);
  assert.deepEqual(lines(device.events), ["Compacting the conversation…"]);
  t.mock.timers.tick(60_000);
  assert.deepEqual(lines(device.events), ["Compacting the conversation…", quietLine]);
  thread.sink.emit({ type: "turn.usage", usage: { tokens: 20 } });
  assert.deepEqual(lines(device.events), ["Compacting the conversation…", quietLine, "Compacting the conversation…"]);
  assert.equal(thread.snapshot().status_line, "Compacting the conversation…");
  thread.sink.emit({ type: "turn.end", status: "complete" });
});

test("a turn waiting on a card is not quiet: the agent waits for the person, and the quiet is counted from the answer", async (t) => {
  const { thread, device } = await running(t);
  const asked = thread.sink.ask({ kind: "approval", command: "make build", choices: ["once", "deny"] });
  t.mock.timers.tick(3 * quietLimitMs);
  assert.deepEqual(lines(device.events), []);
  const [open] = thread.requests.list();
  thread.requests.withdraw(open.id, "withdrawn");
  await asked;
  t.mock.timers.tick(quietLimitMs - 1);
  assert.deepEqual(lines(device.events), []);
  t.mock.timers.tick(1);
  assert.deepEqual(lines(device.events), [quietLine]);
  thread.sink.emit({ type: "turn.end", status: "complete" });
});

test("a Stop the agent does not take in time ends the turn here, and what the agent still says of that turn is let go of", async (t) => {
  const { thread, device, started } = await running(t);
  thread.sink.emit({ type: "text", text: "Building" });
  const stopping = thread.interrupt();
  t.mock.timers.tick(stopWaitMs - 1);
  await nextStep();
  assert.equal(thread.isRunning, true);
  t.mock.timers.tick(1);
  assert.equal(await stopping, true);
  assert.equal(thread.isRunning, false);
  assert.deepEqual(device.events.filter((event) => event.type === "message.complete").map((event) => event.payload?.status), ["interrupted"]);

  // The agent goes on with the stopped turn, then ends it: none of it shows, and the thread stays at rest.
  const before = device.events.length;
  thread.sink.emit({ type: "text", text: "… still building" });
  thread.sink.emit({ type: "tool.start", id: "t9", name: "terminal", args: { command: "make" } });
  thread.sink.emit({ type: "turn.end", status: "interrupted" });
  assert.equal(device.events.length, before);
  assert.equal(thread.isRunning, false);
  assert.deepEqual(thread.messages.map((message) => [message.role, "text" in message ? message.text : ""]), [["user", "run the build"], ["assistant", "Building"]]);

  // The next turn is the agent's again.
  thread.submit("try again").begin?.();
  thread.sink.emit({ type: "text", text: "Done." });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.deepEqual(started, ["run the build", "try again"]);
  assert.equal(device.events.filter((event) => event.type === "message.complete").at(-1)?.payload?.text, "Done.");
});

test("a Stop the agent fails to take ends the turn here as well; one it takes leaves the turn to the agent", async (t) => {
  const failing = await running(t, async () => {
    throw new Error("Hermes is not reachable.");
  });
  assert.equal(await failing.thread.interrupt(), true);
  assert.equal(failing.thread.isRunning, false);
  assert.deepEqual(failing.device.events.filter((event) => event.type === "message.complete").map((event) => event.payload?.status), ["interrupted"]);
  t.mock.timers.reset();

  const taking = await running(t, async () => true);
  assert.equal(await taking.thread.interrupt(), true);
  t.mock.timers.tick(stopWaitMs);
  // The agent ends it, with its end.
  assert.equal(taking.thread.isRunning, true);
  taking.thread.sink.emit({ type: "turn.end", status: "interrupted" });
  assert.equal(taking.thread.isRunning, false);
});

test("after a Stop the agent answers late, a message sent before the agent ends the stopped turn waits for that end: the stopped turn's words and end never reach it", async (t) => {
  let answer!: (stopped: boolean) => void;
  const { thread, device, started } = await running(t, () => new Promise((resolve) => { answer = resolve; }));
  thread.sink.emit({ type: "text", text: "Building" });
  const stopping = thread.interrupt();
  await nextStep();
  t.mock.timers.tick(stopWaitMs);
  assert.equal(await stopping, true);
  assert.equal(thread.isRunning, false);
  // The agent may still run the stopped turn: the thread is still at work, and is not let go of.
  assert.equal(await thread.stopping(), true);
  assert.equal(thread.atRest, false);

  // The next message waits on the list; the agent is sent nothing yet.
  assert.equal(thread.submit("try again").status, "queued");
  await nextStep();
  assert.deepEqual(started, ["run the build"]);
  assert.equal(thread.isRunning, false);

  // The agent takes the Stop late, says more of the stopped turn and ends it: none of it shows.
  answer(true);
  await nextStep();
  thread.sink.emit({ type: "text", text: "… still building" });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.equal(device.events.filter((event) => event.type === "message.complete").length, 1);
  assert.ok(!device.events.some((event) => event.type === "message.delta" && String(event.payload?.text).includes("still building")));

  // Only then does the message go, as a turn of its own that only the agent's next end ends.
  await nextStep();
  assert.deepEqual(started, ["run the build", "try again"]);
  assert.equal(thread.isRunning, true);
  assert.equal(await thread.stopping(), false);
  thread.sink.emit({ type: "text", text: "Done." });
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.equal(thread.isRunning, false);
  assert.deepEqual(device.events.filter((event) => event.type === "message.complete").map((event) => [event.payload?.status, event.payload?.text]), [["interrupted", undefined], ["complete", "Done."]]);
  assert.deepEqual(thread.messages.map((message) => [message.role, "text" in message ? message.text : ""]), [["user", "run the build"], ["assistant", "Building"], ["user", "try again"], ["assistant", "Done."]]);
});

test("a message already waiting when the Stop deadline ends the turn waits for the agent's end of the stopped turn as well", async (t) => {
  const { thread, started } = await running(t);
  assert.equal(thread.submit("next one", { queue: true }).status, "queued");
  const stopping = thread.interrupt();
  await nextStep();
  t.mock.timers.tick(stopWaitMs);
  assert.equal(await stopping, true);
  await nextStep();
  assert.deepEqual(started, ["run the build"]);
  assert.equal(thread.isRunning, false);
  // The agent's late words and end of the stopped turn do not touch the waiting message.
  thread.sink.emit({ type: "text", text: "late" });
  thread.sink.emit({ type: "turn.end", status: "interrupted" });
  await nextStep();
  assert.deepEqual(started, ["run the build", "next one"]);
  assert.equal(thread.isRunning, true);
  thread.sink.emit({ type: "turn.end", status: "complete" });
  assert.equal(thread.isRunning, false);
  assert.ok(!thread.messages.some((message) => "text" in message && message.text === "late"));
});

test("an agent that answers a Stop late that nothing was running lets the next message go without an end", async (t) => {
  let answer!: (stopped: boolean) => void;
  const { thread, started } = await running(t, () => new Promise((resolve) => { answer = resolve; }));
  const stopping = thread.interrupt();
  await nextStep();
  t.mock.timers.tick(stopWaitMs);
  assert.equal(await stopping, true);
  thread.submit("try again");
  await nextStep();
  assert.deepEqual(started, ["run the build"]);
  answer(false);
  await nextStep();
  await nextStep();
  assert.deepEqual(started, ["run the build", "try again"]);
  assert.equal(await thread.stopping(), false);
  thread.sink.emit({ type: "turn.end", status: "complete" });
});
