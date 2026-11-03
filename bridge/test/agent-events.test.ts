import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setLogLevel } from "../src/log.ts";
import type { Prompt, ProviderEvent, ProviderSession } from "../src/providers/types.ts";
import type { LoggedEvent } from "../src/sessions/eventLog.ts";
import type { Registry, ThreadRecord } from "../src/sessions/registry.ts";
import { Session, type Peer, type SessionListener } from "../src/sessions/session.ts";
import type { Transcript } from "../src/sessions/transcript.ts";
import { unspent } from "./helpers.ts";

// An event from the agent's side that the session fails to take in (a bug of the
// bridge's, or of the agent's side as the session asks it something): the failure is
// logged as an error and the event lost, and the agent's side never hears of it. Codex,
// Hermes and Cursor hand events in from their connections' handlers, where a throw ends
// the bridge. A turn's end that fails still leaves the thread at rest. A device an event
// cannot be sent to costs only that device the event. A session on its own, with an
// agent that only starts turns.

setLogLevel("silent");

/** `record`: more of the thread's record; `listener`: what hears of its turns (the fleet's waits, notifications). */
function session(record: Partial<ThreadRecord> = {}, listener?: SessionListener): Session {
  const full: ThreadRecord = {
    id: "events-thread", agent: "stand-in", cwd: "/w", title: null, model: "m", provider: "p", reasoningEffort: "",
    createdAt: 0, updatedAt: 0, origin: "phone", ...record,
  };
  // Not in the registry: the session keeps its record itself.
  return new Session(full, { has: () => false } as unknown as Registry, { listener });
}

/**
 * An agent that only starts turns; `started` has what each was opened with. With
 * `failsAtEnd`, it cannot say whether it still has a mode's policy to undo, which the
 * session asks once a turn has ended in a thread that left a mode (`modeReset`): once.
 */
function agent(failsAtEnd = false): { agent: ProviderSession; started: string[] } {
  const started: string[] = [];
  let failed = !failsAtEnd;
  const agent = {
    history: async () => [],
    settings: () => ({ model: "m", provider: "p", reasoningEffort: "" }),
    startTurn: (prompt: Prompt) => started.push(prompt.text),
    interrupt: async () => false,
    modeResetPending: () => {
      if (failed) return false;
      failed = true;
      throw new Error("the agent's side could not say");
    },
    close: async () => {},
  } as unknown as ProviderSession;
  return { agent, started };
}

/** A bug of the bridge's: the thread's conversation cannot take in the first event of `type`. Once attached. */
function failingToKeep(thread: Session, type: ProviderEvent["type"]): void {
  const transcript = (thread as unknown as { transcript: Transcript }).transcript;
  const apply = transcript.apply.bind(transcript);
  let failed = false;
  transcript.apply = (event: ProviderEvent) => {
    if (event.type === type && !failed) {
      failed = true;
      throw new Error("the conversation could not take it in");
    }
    apply(event);
  };
}

function follower(): { peer: Peer; events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  return { peer: { isOpen: true, takesRequests: false, sendRequest: () => {}, sendEvent: (event: LoggedEvent) => events.push(event) } as unknown as Peer, events };
}

/** A device the first event of `type` cannot be sent to. */
function failing(type: string): Peer {
  let failed = false;
  const sendEvent = (event: LoggedEvent) => {
    if (event.type !== type || failed) return;
    failed = true;
    throw new Error("the device could not be sent it");
  };
  return { isOpen: true, takesRequests: false, sendRequest: () => {}, sendEvent } as unknown as Peer;
}

/** What the bridge logs while the test runs, a line each. */
function logLines(t: TestContext): string[] {
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  setLogLevel("info");
  t.after(() => {
    process.stderr.write = write;
    setLogLevel("silent");
  });
  return lines;
}

const nextStep = () => new Promise((resolve) => setImmediate(resolve));

test("an event the session fails to take in is logged as an error, with what kind it was and the stack, and lost; the agent is not thrown at, and what comes next is taken in", async (t) => {
  const thread = session();
  await thread.attach(agent().agent);
  const device = follower();
  thread.follow(device.peer);
  failingToKeep(thread, "text");
  const lines = logLines(t);
  thread.submit("first").begin?.();
  assert.doesNotThrow(() => thread.sink.emit({ type: "text", text: "Private words" }));
  thread.sink.emit({ type: "text", text: ", and more." });
  thread.sink.emit({ type: "turn.end", status: "complete" });

  assert.deepEqual(
    device.events.filter((event) => event.type === "message.delta").map((event) => event.payload?.text),
    ["Private words", ", and more."],
  );
  assert.equal(device.events.at(-1)?.type, "message.complete");
  assert.equal(thread.isRunning, false);
  const errors = lines.filter((line) => / error /.test(line));
  assert.equal(errors.length, 1);
  assert.match(errors[0], / error could not take in an event from the agent \{/);
  const fields = JSON.parse(errors[0].slice(errors[0].indexOf("{")));
  assert.equal(fields.session, "events-thread");
  assert.equal(fields.event, "text");
  assert.match(fields.error, /^Error: the conversation could not take it in\n\s+at /);
  // Never what the thread says.
  assert.doesNotMatch(errors[0], /Private/);
});

test("a turn's end that fails before the turn has ended ends it as failed: the thread is not left running", async (t) => {
  const thread = session();
  await thread.attach(agent().agent);
  const device = follower();
  thread.follow(device.peer);
  logLines(t);
  thread.submit("first").begin?.();
  void thread.sink.ask({ kind: "approval", command: "make build", choices: ["once", "deny"] });
  // Its end takes back the question still open, then fails.
  failingToKeep(thread, "turn.end");
  thread.sink.emit({ type: "turn.end", status: "complete" });

  assert.equal(thread.isRunning, false);
  assert.deepEqual(
    device.events.slice(-2).map((event) => [event.type, event.payload]),
    [
      ["request.cancel", { id: device.events.at(-2)?.payload?.id, reason: "withdrawn" }],
      ["message.complete", { status: "error", text: "Portals could not take in the end of this turn.", error_surface: { retryable: false } }],
    ],
  );
  // And the thread keeps it so, for a device that opens it later.
  assert.equal(thread.snapshot().running, false);
  assert.deepEqual(thread.messages.at(-1), { role: "assistant", text: "Portals could not take in the end of this turn.", timestamp: thread.messages.at(-1)?.timestamp, display_kind: "failed_turn" });
});

test("a turn's end that fails after the turn has ended still opens the next turn for the message waiting", async (t) => {
  const thread = session({ modeReset: true });
  const { agent: stub, started } = agent(true);
  await thread.attach(stub);
  const device = follower();
  thread.follow(device.peer);
  logLines(t);
  thread.submit("first").begin?.();
  assert.equal(thread.submit("second", { queue: true }).status, "queued");
  thread.sink.emit({ type: "turn.end", status: "complete" });
  await nextStep();

  assert.deepEqual(started, ["first", "second"]);
  assert.equal(thread.isRunning, true);
  assert.deepEqual(thread.queuedMessages(), []);
});

test("a turn's end that fails after the turn has ended is still heard by what waits for it: a wait through the fleet, a notification", async (t) => {
  const ended: [string, string, string][] = [];
  const thread = session({ modeReset: true }, { turnEnded: (id, status, text) => ended.push([id, status, text]) });
  await thread.attach(agent(true).agent);
  logLines(t);
  thread.submit("first").begin?.();
  thread.sink.emit({ type: "text", text: "Done." });
  thread.sink.emit({ type: "turn.end", status: "complete" });

  assert.equal(thread.isRunning, false);
  assert.deepEqual(ended, [["events-thread", "complete", "Done."]]);
});

test("an agent that cannot start a turn whose failed end the session then fails to take in is logged, not thrown at the caller, and the thread is left at rest", async (t) => {
  const thread = session({ modeReset: true });
  const { agent: stub } = agent(true);
  stub.startTurn = () => {
    throw new Error("no agent to start");
  };
  await thread.attach(stub);
  const device = follower();
  thread.follow(device.peer);
  const lines = logLines(t);
  const outcome = thread.submit("first");
  assert.doesNotThrow(() => outcome.begin?.());

  assert.equal(thread.isRunning, false);
  assert.deepEqual(unspent(device.events.at(-1)?.payload ?? {}), { status: "error", text: "The agent could not start: no agent to start", error_surface: { retryable: true } });
  const errors = lines.filter((line) => / error /.test(line));
  assert.equal(errors.length, 1);
  const fields = JSON.parse(errors[0].slice(errors[0].indexOf("{")));
  assert.deepEqual([fields.session, fields.event], ["events-thread", "turn.end"]);
  assert.match(fields.error, /^Error: the agent's side could not say\n\s+at /);
});

test("a device an event cannot be sent to keeps none after it from having it live: the failure is logged as an error, with the kind of event and the stack", async (t) => {
  const thread = session();
  await thread.attach(agent().agent);
  thread.follow(failing("message.delta"));
  const device = follower();
  thread.follow(device.peer);
  const lines = logLines(t);
  thread.submit("first").begin?.();
  thread.sink.emit({ type: "text", text: "Private words" });
  thread.sink.emit({ type: "turn.end", status: "complete" });

  // Every event, the one the other device could not be sent too.
  assert.deepEqual(device.events, thread.eventsSince(0).events);
  assert.deepEqual(device.events.filter((event) => event.type === "message.delta").map((event) => event.payload?.text), ["Private words"]);
  assert.equal(device.events.at(-1)?.type, "message.complete");
  assert.equal(thread.isRunning, false);
  const errors = lines.filter((line) => / error /.test(line));
  assert.equal(errors.length, 1);
  assert.match(errors[0], / error could not send an event to a device \{/);
  const fields = JSON.parse(errors[0].slice(errors[0].indexOf("{")));
  assert.deepEqual([fields.session, fields.event], ["events-thread", "message.delta"]);
  assert.match(fields.error, /^Error: the device could not be sent it\n\s+at /);
  assert.doesNotMatch(errors[0], /Private/);
});
