import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { after, afterEach, test } from "node:test";
import { setLogLevel } from "../src/log.ts";
import type { ChildExit } from "../src/providers/child.ts";
import { PiClient, PiGone, PiRefused, PiSilent } from "../src/providers/pi/client.ts";
import type { PiEvent, PiUiRequest } from "../src/providers/pi/protocol.ts";
import { standin, until } from "./pi-standin.ts";

// The bridge's end of one Pi process in its RPC mode, against the stand-in for Pi run as
// a child process (test/pi-agent.ts): which answer goes to which caller, what a refusal
// and a silence are, the order of what Pi prints, dialogs, and the process's end.

setLogLevel("silent");

const pi = standin();
const clients: PiClient[] = [];

after(() => pi.dispose());

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  pi.holdStarts(null);
  // No test leaves a process of the stand-in behind.
  await until(() => pi.alive().length === 0);
});

interface Run {
  client: PiClient;
  /** What reached the listener and what a caller was answered, in the order it happened. */
  seen: string[];
  events: PiEvent[];
  dialogs: PiUiRequest[];
  exits: ChildExit[];
}

function run(options: { command?: string; session?: string; timeoutMs?: number } = {}): Run {
  const seen: string[] = [];
  const events: PiEvent[] = [];
  const dialogs: PiUiRequest[] = [];
  const exits: ChildExit[] = [];
  const client = new PiClient({
    command: options.command ?? pi.path,
    args: ["--mode", "rpc", "--session-id", options.session ?? "client-test"],
    env: pi.env,
    cwd: tmpdir(),
    timeoutMs: options.timeoutMs,
    listener: {
      event: (record) => {
        events.push(record);
        seen.push(String(record.type));
      },
      dialog: (request) => {
        dialogs.push(request);
        seen.push(`dialog ${request.method}`);
      },
      exited: (exit) => {
        exits.push(exit);
        seen.push("exited");
      },
    },
  });
  clients.push(client);
  return { client, seen, events, dialogs, exits };
}

/** A call whose answer is noted in `seen` when its caller gets it. */
function noted<T>(seen: string[], name: string, call: Promise<T>): Promise<T> {
  return call.then(
    (data) => {
      seen.push(`answer ${name}`);
      return data;
    },
    (error) => {
      seen.push(`refusal ${name}`);
      throw error;
    },
  );
}

test("each answer goes to the caller of its command, in whatever order Pi gives them, and a prompt has no time limit", async () => {
  // Any other command has 150 ms here; the prompt is answered after 400.
  const { client, seen, dialogs } = run({ timeoutMs: 150 });
  // Pi answers a prompt that an extension's command took only when the command has run,
  // and this one waits for its dialog.
  const prompt = noted(seen, "prompt", client.call({ type: "prompt", message: "/ask-confirm" }));
  await until(() => dialogs.length === 1);
  const state = await noted(seen, "get_state", client.call({ type: "get_state" }));
  assert.equal(state.sessionId, "client-test");
  assert.equal(state.model.id, "gpt-6-luna");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(seen, ["dialog confirm", "answer get_state"]);

  // The dialog's answer is no command: it gets no answer of its own, and settles the prompt.
  assert.deepEqual({ method: dialogs[0].method, title: dialogs[0].title, message: dialogs[0].message }, { method: "confirm", title: "Send the report?", message: "It goes to everyone on the list." });
  client.answer({ type: "extension_ui_response", id: dialogs[0].id!, confirmed: true });
  assert.deepEqual(await prompt, { disposition: "handled" });
  // What the command said came before its answer.
  assert.deepEqual(seen, ["dialog confirm", "answer get_state", "extension_ui_request", "answer prompt"]);
  // The commands went out numbered, each with its own id; the dialog's answer carries the dialog's.
  assert.deepEqual(pi.got().map((record) => [record.id, record.type]), [["b1", "prompt"], ["b2", "get_state"], [dialogs[0].id, "extension_ui_response"]]);
});

test("a command Pi refuses rejects with Pi's sentence, and the next one is answered", async () => {
  const { client } = run();
  await assert.rejects(client.call({ type: "set_model", provider: "openai", modelId: "no-such-model" }), (error: Error) => error instanceof PiRefused && error.message === "Model not found: openai/no-such-model");
  await assert.rejects(client.call({ type: "set_session_name", name: "  " }), (error: Error) => error instanceof PiRefused && error.message === "Session name cannot be empty");
  assert.equal((await client.call({ type: "set_model", provider: "openai", modelId: "gpt-5" })).id, "gpt-5");
});

test("a command Pi does not answer in time fails, and its late answer is nobody's", async () => {
  // The process answers nothing until its gate opens.
  pi.holdStarts("late-answer");
  const { client, seen } = run({ timeoutMs: 100 });
  await assert.rejects(client.call({ type: "get_state" }), (error: Error) => error instanceof PiSilent && error.message === "Pi did not answer get_state in 0.1 seconds.");
  pi.release("late-answer");
  // The next answer is the next command's, not the one that came late.
  const stats = await client.call({ type: "get_session_stats" }, 5000);
  assert.equal(stats.contextUsage.contextWindow, 272_000);
  assert.deepEqual(seen, []);
});

test("a call given up on fails with the reason given, and its late answer is nobody's", async () => {
  pi.holdStarts("given-up");
  const { client } = run();
  const lost = new AbortController();
  const prompt = client.call({ type: "prompt", message: "hello" }, null, lost.signal);
  lost.abort(new Error("Pi never answered this message."));
  await assert.rejects(prompt, (error: Error) => error.message === "Pi never answered this message.");
  pi.release("given-up");
  // The next answer is the next command's, not the prompt's that came late.
  assert.equal((await client.call({ type: "get_state" }, 5000)).sessionId, "client-test");
});

test("events and answers reach their takers in the order Pi printed them", async () => {
  const { client, seen } = run();
  // Pi says the level changed, then answers.
  await noted(seen, "level", client.call({ type: "set_thinking_level", level: "high" }));
  assert.deepEqual(seen, ["thinking_level_changed", "answer level"]);
  seen.length = 0;
  // Pi answers `started`, and the whole run follows in the same breath.
  const answer = await noted(seen, "prompt", client.call({ type: "prompt", message: "hello" }));
  assert.deepEqual(answer, { disposition: "started" });
  // Whoever asked has heard before the first event of the run arrives.
  assert.deepEqual(seen, ["answer prompt"]);
  await until(() => seen.includes("agent_settled"));
  assert.deepEqual(seen.slice(0, 3), ["answer prompt", "agent_start", "turn_start"]);
  assert.deepEqual(seen.slice(-2), ["agent_end", "agent_settled"]);
});

test("a line with U+2028 and U+2029 in a string arrives whole, both ways", async () => {
  const { client, events } = run();
  const said = "one two three";
  await client.call({ type: "prompt", message: said });
  await until(() => events.some((event) => event.type === "agent_settled"));
  // The stand-in read it whole, and says it back in one record.
  assert.equal(pi.got("prompt").at(-1).message, said);
  const end = events.find((event) => event.type === "message_end" && event.message?.role === "assistant");
  assert.deepEqual(end?.message?.content, [{ type: "text", text: `Working. You said: ${said}` }]);
});

test("the process's end rejects what still waits and is told once; a call after it fails at once", async () => {
  const { client, seen, exits, events } = run();
  const waiting = client.call({ type: "prompt", message: "/ask-confirm" });
  const failed = assert.rejects(waiting, (error: Error) => error instanceof PiGone && error.message === "Pi stopped (exit code 1): Error: the stand-in was told to die");
  // A run in which the stand-in exits with code 1, with a last word.
  await client.call({ type: "prompt", message: "die loudly" });
  await failed;
  assert.equal(exits.length, 1);
  assert.deepEqual([exits[0].code, exits[0].signal, exits[0].asked], [1, null, false]);
  // Told after the last record it printed.
  assert.equal(seen.at(-1), "exited");
  assert.equal(events.at(-1)?.type, "tool_execution_start");
  assert.equal(client.running, false);
  await assert.rejects(client.call({ type: "get_state" }), (error: Error) => error instanceof PiGone && error.message === exits[0].reason);
  await client.stop();
  assert.equal(exits.length, 1);
});

test("a stop ends the process, fails what waits, and tells the listener before it returns", async () => {
  const { client, exits, dialogs } = run();
  const waiting = client.call({ type: "prompt", message: "/ask-confirm" });
  const failed = assert.rejects(waiting, (error: Error) => error instanceof PiGone);
  await until(() => dialogs.length === 1);
  const pid = client.pid!;
  assert.deepEqual(pi.alive(), [pid]);
  await client.stop();
  await failed;
  assert.equal(exits.length, 1);
  assert.equal(exits[0].asked, true);
  assert.deepEqual(pi.alive(), []);
});

test("a pi that is not there is told as one that could not be started", async () => {
  const { client, exits } = run({ command: "/nonexistent/pi" });
  await assert.rejects(client.call({ type: "get_state" }), (error: Error) => error instanceof PiGone);
  await client.stop();
  assert.equal(exits.length, 1);
  assert.match(exits[0].error ?? "", /ENOENT/);
});

test("the stand-in keeps Pi's rules: a bare prompt in a run is refused, an early abort forgotten, two early prompts collide, a message behind a stop comes out later with the time it was queued", async () => {
  const { client, seen, events } = run({ session: "client-rules" });
  const texts = () => events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").map((event) => (event.message!.content as any[])[0]?.text);
  const settles = () => events.filter((event) => event.type === "agent_settled").map((event) => event.aborted);

  // Two prompts before the first one's run has begun: both count as new, the second is
  // lost, and a settle is reported at once while the first run goes on.
  const first = client.call({ type: "prompt", message: "slowstart rules-1 hold rules-2 slowstop rules-3 one", streamingBehavior: "steer" });
  const second = client.call({ type: "prompt", message: "two", streamingBehavior: "steer" });
  assert.deepEqual([await first, await second], [{ disposition: "started" }, { disposition: "started" }]);
  // An abort now is answered, and forgotten.
  await client.call({ type: "abort" }, 2000);
  pi.release("rules-1");
  await until(() => seen.includes("message_update"));
  assert.deepEqual(settles(), [false]);
  assert.equal(seen.indexOf("agent_settled"), seen.indexOf("agent_start") + 1);

  // In the run: without `streamingBehavior` a prompt is refused; with it, queued.
  await assert.rejects(client.call({ type: "prompt", message: "bare" }), (error: Error) => error instanceof PiRefused && error.message === "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
  // An abort in the run is answered only once the run has settled.
  let aborted = false;
  const abort = client.call({ type: "abort" }).then(() => (aborted = true));
  assert.deepEqual(await client.call({ type: "prompt", message: "behind the stop", streamingBehavior: "steer" }), { disposition: "queued" });
  assert.equal(aborted, false);
  pi.release("rules-3");
  await abort;
  assert.deepEqual(settles(), [false, true]);
  // The message queued behind the stop is still there, and is delivered inside the next run.
  assert.equal((await client.call({ type: "get_state" })).pendingMessageCount, 1);
  events.length = 0;
  await client.call({ type: "prompt", message: "three", streamingBehavior: "steer" });
  await until(() => settles().length === 1);
  const users = events.filter((event) => event.type === "message_end" && event.message?.role === "user").map((event) => event.message!);
  assert.deepEqual(users.map((message) => (message.content as any[])[0].text), ["three", "behind the stop"]);
  // It keeps the time it was queued, which is before the message it comes out behind.
  assert.ok(users[1].timestamp! < users[0].timestamp!);
  assert.deepEqual(texts(), ["Working. You said: three"]);
});
