import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, test, type TestContext } from "node:test";
import { parseConfig, pathsFor } from "../src/config.ts";
import { setLogLevel } from "../src/log.ts";
import { machineWord } from "../src/platform.ts";
import { WaitingStore } from "../src/sessions/waiting.ts";
import { agentInstructions, mathInstructions, visualInstructions } from "../src/portals/guide.ts";
import { makeProviders } from "../src/providers/index.ts";
import type { PiProvider } from "../src/providers/pi/provider.ts";
import { isEvent, RpcFailure, startTestBridge, streamedText, TestClient, unspent, type Frame, type TestBridge } from "./helpers.ts";
import { piProvider, standin, until, type Standin } from "./pi-standin.ts";

// Pi threads through the whole bridge, as the app sees them, against a stand-in for
// `pi --mode rpc` run as a real child process (test/pi-agent.ts) that plays the runs
// recorded from the real Pi: the provider, the sessions, the client and the processes
// are the real code; only Pi is played.

/** What the stand-in is set up with: its four models, and one more that it has no key for. */
const standinSettings = {
  models: [{ id: "gpt-locked", name: "Locked", provider: "openai", reasoning: false, input: ["text"], contextWindow: 8192 }],
  noKey: ["openai/gpt-locked"],
};

let pi: Standin;
let provider: PiProvider;
let bridge: TestBridge;
let client: TestClient;
let cwd: string;
/** The threads a test made on the shared bridge, removed when it ends. */
const made: string[] = [];

before(async () => {
  pi = standin(standinSettings);
  // The thread folder is General: a temporary folder is never on the list of others.
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "portals-pi-test-")));
  writeFileSync(join(cwd, "hello.txt"), "hi\n");
  provider = piProvider(pi, { folder: cwd });
  bridge = await startTestBridge({ providers: new Map([["pi", provider]]), config: { generalFolder: cwd } });
  client = await TestClient.open(bridge);
});

after(async () => {
  await client.close();
  await bridge.dispose();
  pi.dispose();
  rmSync(cwd, { recursive: true, force: true });
});

afterEach(async () => {
  pi.holdStarts(null);
  pi.breakCatalog(false);
  pi.install(true);
  pi.version(null);
  // Removing a thread stops its process, and no test leaves one of the stand-in's behind.
  for (const thread of made.splice(0)) await client.call("thread.delete", { thread });
  await until(() => pi.alive().length === 0);
});

async function createThread(params: Record<string, unknown> = {}, on = client): Promise<string> {
  const id = (await on.call("session.create", { profile: "pi", source: "tui", cwd, ...params })).session_id;
  if (on === client) made.push(id);
  return id;
}

/** Sends a message that begins a turn, and returns where the turn's frames start. */
async function send(session: string, text: string, on = client): Promise<number> {
  const start = on.frames.length;
  const reply = await on.call("prompt.submit", { session_id: session, text, profile: "pi" });
  assert.equal(reply.status, "streaming");
  return start;
}

function turnEvents(session: string, start: number, on = client): Frame[] {
  return on.frames.slice(start).filter((frame) => frame.method === "event" && frame.params.session_id === session).map((frame) => frame.params);
}

/** The kinds of a turn's events, each run of one kind once, without the context ring's (which comes whenever Pi answers). */
function kinds(events: Frame[]): string[] {
  return events
    .map((event) => event.type as string)
    .filter((type) => type !== "session.usage")
    .filter((type, index, all) => type !== all[index - 1]);
}

async function completed(session: string, start: number, on = client, timeoutMs = 5000): Promise<Frame> {
  return (await on.from(start, (frame) => isEvent(frame, "message.complete", session), timeoutMs)).params;
}

/** A whole turn: the message, and its events up to its end. (The ring's may come after it.) */
async function turn(session: string, text: string, on = client): Promise<Frame[]> {
  const start = await send(session, text, on);
  await completed(session, start, on);
  const events = turnEvents(session, start, on);
  return events.slice(0, events.findIndex((entry) => entry.type === "message.complete") + 1);
}

/** The next event of one kind for a thread, from `start` on. */
async function event(session: string, start: number, type: string, on = client): Promise<Frame> {
  return (await on.from(start, (frame) => isEvent(frame, type, session))).params;
}

/** Waits for the ring to say `used`: Pi is asked after each answer, and answers when it does. */
async function ring(session: string, used: number, on = client): Promise<void> {
  await on.find((frame) => isEvent(frame, "session.usage", session) && frame.params.payload.usage.context_used === used);
}

function notices(events: Frame[]): string[] {
  return events.filter((entry) => entry.type === "status.update").map((entry) => entry.payload.text);
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4IydHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAJI2YD1ZaHIvAAAAAElFTkSuQmCC", "base64");

test("profiles.list, model.options and the commands describe Pi from what a short-lived Pi says", async () => {
  assert.deepEqual(await client.call("model.options", { profile: "pi" }), {
    providers: [{ slug: "openai", name: "openai", models: ["gpt-6-luna", "gpt-5", "gpt-4.1-nano", "o3-mini", "gpt-locked"], authenticated: true }],
    model: "gpt-6-luna",
    provider: "openai",
    // Pi's own rule for each model: none for one that does not think, the rest by its map.
    model_levels: {
      "gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
      "gpt-5": ["minimal", "low", "medium", "high"],
      "gpt-4.1-nano": ["none"],
      "o3-mini": ["low", "medium", "high"],
      "gpt-locked": ["none"],
    },
    model_names: { "gpt-6-luna": "GPT-6 Luna", "gpt-5": "GPT-5", "gpt-4.1-nano": "GPT-4.1 nano", "o3-mini": "o3-mini", "gpt-locked": "Locked" },
  });
  assert.deepEqual((await client.call("profiles.list")).profiles, [
    { name: "pi", kind: "pi", display_name: "Pi", description: `Pi on this ${machineWord()}, with your own settings, extensions and sign-ins. It does not ask before it acts.`, model: "gpt-6-luna", provider: "openai", is_default: true, adopt_modes: ["continue", "fork", "read"] },
  ]);
  // Pi's own default level, `off`, in the app's word.
  assert.deepEqual(await client.call("config.get", { key: "reasoning", profile: "pi" }), { value: "none" });

  const catalog = await client.call("commands.catalog", { profile: "pi" });
  assert.deepEqual(
    catalog.categories.map((category: Frame) => [category.name, category.pairs.map((pair: string[]) => pair[0])]),
    [
      ["Bridge", ["/status"]],
      // The bridge's own `/compact`, then the extension's commands. One with a capital letter is left out.
      ["Pi", ["/compact", "/ask-confirm", "/ask-select", "/ask-input", "/ask-editor", "/ask-timed", "/say", "/tell", "/own", "/ask-later", "/quit"]],
    ],
  );
  // A prompt template and a skill are skills.
  assert.deepEqual(Object.keys(catalog.skills), ["/shout", "/skill:greet"]);
  assert.deepEqual(catalog.pairs.find((pair: string[]) => pair[0] === "/compact"), ["/compact", "Summarise the conversation so far, to free up context (usage: /compact [what to keep])"]);
  assert.deepEqual(catalog.pairs.find((pair: string[]) => pair[0] === "/skill:greet"), ["/skill:greet", "Greets someone by name. Use when asked to greet a person."]);

  // One Pi with no session was asked, in the General folder, and is gone.
  const asked = pi.starts().filter((line) => line.args?.includes("--no-session"));
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].args, ["--mode", "rpc", "--no-session", "--offline"]);
  assert.equal(asked[0].cwd, cwd);
  assert.deepEqual(pi.log().filter((line) => line.pid === asked[0].pid && line.kind === "got").map((line) => line.record.type), ["get_state", "get_available_models", "get_commands"]);
  await until(() => pi.alive().length === 0);
});

test("a thread starts no process; its first message starts Pi on the thread's id, streams the reply and names the session", async () => {
  const created = await client.call("session.create", { profile: "pi", source: "tui", cwd });
  const session = created.session_id as string;
  made.push(session);
  assert.match(session, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ model: created.info.model, provider: created.info.provider, level: created.info.reasoning_effort, cwd: created.info.cwd }, { model: "gpt-6-luna", provider: "openai", level: "none", cwd });
  assert.deepEqual(pi.starts(session), []);
  await assert.rejects(client.call("session.create", { profile: "pi", cwd: "/no/such/folder" }), (error: RpcFailure) => error.code === -32602);

  const start = await send(session, "play plain\nand a second line");
  const done = await completed(session, start);
  const events = turnEvents(session, start);
  assert.deepEqual(kinds(events), ["message.start", "session.title", "message.delta", "message.complete"]);
  assert.deepEqual(events.find((entry) => entry.type === "session.title").payload, { title: "play plain" });
  const said = "A JSON line is a single line of text containing one valid JSON value. It’s commonly used in newline-delimited JSON files, where each line is a separate record.";
  assert.equal(streamedText(events), said);
  assert.ok(events.filter((entry) => entry.type === "message.delta").length > 10);
  assert.equal(done.payload.status, "complete");
  assert.equal(done.payload.text, said);

  // One process, in the thread's folder, on the session whose id is the thread's.
  const processes = pi.starts(session);
  assert.equal(processes.length, 1);
  assert.deepEqual(processes[0].args, ["--mode", "rpc", "--session-id", session]);
  assert.equal(processes[0].cwd, cwd);
  // One `get_state`, the ring, the name, then the prompt, which says what to do if a run is under way.
  assert.deepEqual(pi.sentTo(session).slice(0, 4), [
    { id: "b1", type: "get_state" },
    { id: "b2", type: "get_session_stats" },
    { id: "b3", type: "set_session_name", name: "play plain" },
    { id: "b4", type: "prompt", message: "play plain\nand a second line", streamingBehavior: "steer" },
  ]);
  // Pi's default model and level are the thread's: nothing was set.
  assert.deepEqual(pi.sentTo(session, "set_model"), []);
  assert.deepEqual(pi.sentTo(session, "set_thinking_level"), []);
  // The ring, from what Pi says of the session after the answer.
  const usage = await event(session, start, "session.usage");
  assert.deepEqual(usage.payload, { usage: { context_used: 1214, context_max: 272_000 } });

  const resumed = await client.call("session.resume", { session_id: session });
  assert.deepEqual(resumed.messages.map((message: Frame) => [message.role, message.text]), [["user", "play plain\nand a second line"], ["assistant", said]]);
  assert.equal(resumed.info.title, "play plain");
  assert.deepEqual(resumed.info.usage, { context_used: 1214, context_max: 272_000 });
  // The process stays for the next message.
  assert.equal(pi.alive().length, 1);
  const second = await turn(session, "and again");
  assert.equal(streamedText(second), "Working. You said: and again");
  assert.equal(pi.starts(session).length, 1);
  // The name was given once.
  assert.equal(pi.sentTo(session, "set_session_name").length, 1);
});

test("a turn with tools: the rows, their results and a diff, as the app reads them", async () => {
  const session = await createThread();
  const events = await turn(session, "play tools");
  // The two commands' output as they ran (Pi's `tool_execution_update`), as their rows' live output.
  assert.deepEqual(kinds(events), ["message.start", "session.title", "tool.start", "tool.complete", "tool.start", "tool.progress", "tool.complete", "tool.start", "tool.complete", "tool.start", "tool.progress", "tool.complete", "tool.start", "tool.complete", "message.delta", "message.complete"]);
  assert.deepEqual(events.filter((entry) => entry.type === "tool.progress").map((entry) => entry.payload.output), ["       3 hello.txt\n", "ls: no-such-file.txt: No such file or directory\n"]);
  const rows = events.filter((entry) => entry.type === "tool.complete").map((entry) => entry.payload);
  assert.deepEqual(
    rows.map((row) => [row.name, row.args, row.result]),
    [
      ["read_file", { path: "hello.txt" }, { content: "hi\n" }],
      ["terminal", { command: "wc -c hello.txt" }, { output: "       3 hello.txt\n", exit_code: 0 }],
      ["patch", { path: "hello.txt", old_string: "hi", new_string: "hello" }, { success: true, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1,1 +1,1 @@\n-hi\n+hello\n" }],
      // A command that failed: its exit code, and its output without Pi's last line about it.
      ["terminal", { command: "ls no-such-file.txt" }, { output: "ls: no-such-file.txt: No such file or directory\n", exit_code: 1 }],
      ["write_file", { path: "done.txt", content: "done" }, { diff: "--- a/done.txt\n+++ b/done.txt\n+done\n" }],
    ],
  );
  assert.equal(rows[1].duration_s, 0.016);
  assert.equal(events.at(-1).payload.text, "Completed the five steps in order; `ls no-such-file.txt` failed as expected.");
  // The ring was asked for after each answer of the run.
  assert.ok(pi.sentTo(session, "get_session_stats").length >= 6);
});

test("other recorded runs: thinking streams as reasoning, a provider's refusal fails the turn, Pi's own compaction is marked, a script is one row", async () => {
  const thinking = await createThread();
  const thought = await turn(thinking, "play thinking");
  assert.deepEqual(kinds(thought), ["message.start", "session.title", "reasoning.delta", "message.delta", "message.complete"]);
  // The summary's trailing blank line is not said.
  assert.equal(streamedText(thought, "reasoning.delta"), "**Checking the count two ways**");
  assert.match(thought.at(-1).payload.text, /^115 — inclusion–exclusion/);

  // The model's provider refused the request: its sentence, without the JSON around it.
  const refused = await turn(await createThread(), "play error");
  assert.deepEqual(kinds(refused), ["message.start", "session.title", "message.complete"]);
  assert.deepEqual(unspent(refused.at(-1).payload), {
    status: "error",
    text: "OpenAI API error (401): Incorrect API key provided: not-a-re**-key. You can find your API key at https://platform.openai.com/account/api-keys.",
    error_surface: { retryable: true },
  });

  // Pi compacts by itself after `agent_end` and before it settles: the turn ends only then.
  const compacted = await turn(await createThread(), "play compact-auto");
  assert.deepEqual(kinds(compacted), ["message.start", "session.title", "message.delta", "thinking.delta", "session.compacted", "message.complete"]);
  assert.deepEqual(compacted.find((entry) => entry.type === "session.compacted").payload, { trigger: "auto", tokens_before: 1213 });

  // His own Pi runs a `codemode` script that reads two files: one row, not three.
  const script = await turn(await createThread(), "play own");
  assert.deepEqual(script.filter((entry) => entry.type === "tool.complete").map((entry) => entry.payload.name), ["execute_code"]);
  assert.equal(script.at(-1).payload.text, "one.txt has 11 characters; two.txt has 12 characters.");
});

test("images go to Pi as base64 with their type; one Pi cannot read is left out, and a model that takes none gets the text only", async () => {
  const session = await createThread();
  const attach = (filename: string, data: Buffer) => client.call("image.attach_bytes", { session_id: session, filename, content_base64: data.toString("base64") });
  assert.deepEqual(await attach("square.png", png), { attached: true, name: "square.png" });
  assert.deepEqual(await attach("photo.heic", Buffer.from("not an image the agents read")), { attached: true, name: "photo.heic" });
  const first = await turn(session, "What colour is this square?");
  const prompt = pi.sentTo(session, "prompt")[0];
  assert.equal(prompt.message, "What colour is this square?");
  assert.deepEqual(prompt.images, [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
  assert.deepEqual(notices(first), ["An image was left out: Pi reads JPEG, PNG, GIF and WebP images."]);

  // o3-mini takes text only.
  await client.call("config.set", { session_id: session, key: "model", value: "o3-mini --session" });
  await attach("square.png", png);
  const second = await turn(session, "And this one?");
  const later = pi.sentTo(session, "prompt")[1];
  assert.equal(later.message, "And this one?");
  assert.equal(later.images, undefined);
  assert.deepEqual(notices(second), ["An image was left out: o3-mini takes no images."]);
  // What was sent is what the thread shows.
  const resumed = await client.call("session.resume", { session_id: session });
  assert.deepEqual(resumed.messages.filter((message: Frame) => message.role === "user").map((message: Frame) => message.text), ["What colour is this square?\n@image:square.png\n@image:photo.heic", "And this one?\n@image:square.png"]);
});

// MARK: Stop

/** The commands a thread's processes were sent that begin, stop or clear something, in order. */
function control(session: string): string[] {
  return pi.sentTo(session).map((record) => record.type as string).filter((type) => ["prompt", "clear_queue", "abort", "compact", "extension_ui_response"].includes(type));
}

test("Stop is clear_queue then abort; the turn ends interrupted, and a message Pi had queued and not read is named", async () => {
  const session = await createThread();
  const start = await send(session, "play stop");
  await event(session, start, "message.delta");
  // A message while it works, which Pi queues behind the reply it is writing.
  assert.deepEqual(await client.call("prompt.submit", { session_id: session, text: "Then say the word banana." }), { status: "steered" });
  await until(() => pi.sentTo(session, "prompt").length === 2);
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  const done = await completed(session, start);
  assert.deepEqual(done.payload.status, "interrupted");
  const events = turnEvents(session, start);
  assert.equal(events.filter((entry) => entry.type === "message.complete").length, 1);
  // Once more when the stopped turn has settled, for a message that slipped in behind the stop.
  await until(() => control(session).length === 5);
  assert.deepEqual(control(session), ["prompt", "prompt", "clear_queue", "abort", "clear_queue"]);
  const said = await client.from(start, (frame) => isEvent(frame, "status.update", session));
  assert.deepEqual(said.params.payload, { kind: "warn", text: 'A message was not sent, because Pi was stopped before it read it: "Then say the word banana."' });

  // Nothing is left in Pi's queue to come out inside the next turn.
  const next = await turn(session, "and now?");
  assert.equal(streamedText(next), "Working. You said: and now?");
  const resumed = await client.call("session.resume", { session_id: session });
  assert.deepEqual(
    resumed.messages.map((message: Frame) => [message.role, message.text, message.display_kind ?? message.display_metadata?.interrupted ?? null]),
    [
      ["user", "play stop", null],
      ["assistant", "1", null],
      ["user", "Then say the word banana.", "steer"],
      // Nothing more was said before the stop.
      ["assistant", "", true],
      ["user", "and now?", null],
      ["assistant", "Working. You said: and now?", null],
    ],
  );
});

test("a Pi that does not stop is ended after the grace time, and the turn still ends once", async () => {
  const quick = piProvider(pi, { folder: cwd, interruptGraceMs: 150 });
  const own = await startTestBridge({ providers: new Map([["pi", quick]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  try {
    const session = await createThread({}, phone);
    const start = await send(session, "hold never-deaf deaf", phone);
    await event(session, start, "message.delta", phone);
    const began = Date.now();
    assert.deepEqual(await phone.call("session.interrupt", { session_id: session }), { status: "interrupted" });
    const done = await completed(session, start, phone);
    assert.ok(Date.now() - began >= 140);
    assert.equal(done.payload.status, "interrupted");
    await until(() => pi.alive().length === 0);
    // The next message starts Pi again, on the same session.
    const next = await turn(session, "still there?", phone);
    assert.equal(streamedText(next), "Working. You said: still there?");
    assert.equal(pi.starts(session).length, 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(turnEvents(session, start, phone).filter((entry) => entry.type === "message.complete").length, 2);
  } finally {
    await phone.close();
    await own.dispose();
  }
});

test("Stop while Pi starts writes no prompt and ends the turn; Stop right behind the prompt is said again when the run begins", async () => {
  const session = await createThread();
  pi.holdStarts("boot-1");
  const start = await send(session, "never sent");
  await until(() => pi.starts(session).length === 1);
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  assert.equal((await completed(session, start)).payload.status, "interrupted");
  pi.release("boot-1");
  pi.holdStarts(null);
  // The process is up, and was sent nothing of the stopped turn.
  const second = await send(session, "slowstart go-1 hold never-1");
  await until(() => pi.sentTo(session, "prompt").length === 1);
  assert.deepEqual(pi.sentTo(session, "prompt")[0].message, "slowstart go-1 hold never-1");
  assert.equal(pi.starts(session).length, 1);

  // Pi has answered `started` and not begun its run: an `abort` now is answered and forgotten.
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  await until(() => control(session).length === 3);
  pi.release("go-1");
  assert.equal((await completed(session, second)).payload.status, "interrupted");
  // Stop as a whole once more as the run begins, and the queue once more when it has settled.
  await until(() => control(session).length === 6);
  assert.deepEqual(control(session), ["prompt", "clear_queue", "abort", "clear_queue", "abort", "clear_queue"]);
});

test("Stop with a dialog open cancels the dialog first, returns at once, and the turn ends interrupted", async () => {
  const session = await createThread();
  // An extension asks before a command runs: the row is open, the card follows.
  const start = await send(session, "play dialog");
  const card = await client.nextRequest();
  assert.equal(card.method, "clarify");
  assert.deepEqual(card.params.questions.map((question: Frame) => [question.question, question.choices]), [["Run this command?\n\necho first", ["Yes", "No"]]]);
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  const done = await completed(session, start);
  assert.equal(done.payload.status, "interrupted");
  const events = turnEvents(session, start);
  assert.deepEqual(events.find((entry) => entry.type === "request.cancel").payload, { id: card.id, reason: "interrupted" });
  // The command that waited for the answer never ran. (Whether Pi got as far as asking
  // about the second one depends on when it read the stop; that one is cancelled unasked.)
  const rows = events.filter((entry) => entry.type === "tool.complete").map((entry) => entry.payload);
  assert.deepEqual(rows[0].args, { command: "echo first" });
  assert.ok(rows.every((row) => row.result.status === "error" && row.result.error === "Stopped before it finished."));
  assert.equal(events.filter((entry) => entry.type === "request.cancel").length, 1);
  await until(() => control(session).at(-1) === "clear_queue" && control(session).length >= 5);
  assert.deepEqual(control(session).slice(0, 4), ["prompt", "extension_ui_response", "clear_queue", "abort"]);
  assert.ok(pi.sentTo(session, "extension_ui_response").every((record) => record.cancelled === true));
  const answered = pi.sentTo(session, "extension_ui_response").length;

  // The same for a dialog an extension's command opened, which no run follows.
  const second = await send(session, "/ask-confirm");
  const asked = await client.nextRequest();
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  const ended = await completed(session, second);
  assert.equal(ended.payload.status, "interrupted");
  assert.deepEqual(turnEvents(session, second).find((entry) => entry.type === "request.cancel").payload, { id: asked.id, reason: "interrupted" });
  assert.equal(pi.sentTo(session, "extension_ui_response").length, answered + 1);
  assert.equal(pi.sentTo(session, "extension_ui_response").at(-1).cancelled, true);
});

// MARK: A message while it works

/** The status `prompt.submit` gives a message sent while a turn runs. */
async function submit(session: string, text: string, on = client): Promise<string> {
  return (await on.call("prompt.submit", { session_id: session, text, profile: "pi" })).status;
}

/** The turns' ends from `start` on, once there are `count` of them. */
async function ends(session: string, start: number, count: number, on = client): Promise<Frame[]> {
  await on.from(start, () => turnEvents(session, start, on).filter((entry) => entry.type === "message.complete").length >= count || undefined!);
  return turnEvents(session, start, on).filter((entry) => entry.type === "message.complete").map((entry) => entry.payload);
}

/** A thread's stored messages, each as its role (a tool's name for a row), its text and what kind of line it is. */
async function stored(session: string, on = client): Promise<unknown[][]> {
  const resumed = await on.call("session.resume", { session_id: session });
  return resumed.messages.map((message: Frame) => [message.role === "tool" ? message.name : message.role, message.text ?? "", message.display_kind ?? (message.display_metadata?.interrupted ? "interrupted" : "")]);
}

test("a message sent while Pi works is steered: Pi takes it into the run, and answers it before the turn ends", async () => {
  const session = await createThread();
  const start = await send(session, "play steer");
  await event(session, start, "tool.start");
  // The run waits here, as the recorded one did, for the message.
  assert.equal(await submit(session, "Also add the word banana to your reply."), "steered");
  const done = await completed(session, start);
  assert.deepEqual({ status: done.payload.status, text: done.payload.text }, { status: "complete", text: "done" });
  // Every device following the thread is told the message joined the turn (feature turn_messages).
  assert.deepEqual(kinds(turnEvents(session, start)), ["message.start", "session.title", "tool.start", "message.steered", "tool.complete", "message.delta", "message.complete"]);
  assert.deepEqual(pi.sentTo(session, "prompt").map((record) => [record.message, record.streamingBehavior]), [
    ["play steer", "steer"],
    ["Also add the word banana to your reply.", "steer"],
  ]);
  assert.deepEqual(await stored(session), [
    ["user", "play steer", ""],
    ["user", "Also add the word banana to your reply.", "steer"],
    ["terminal", "", ""],
    ["assistant", "done", ""],
  ]);
  // Pi's own file has it where Pi delivered it: after the command, before the answer.
  const file = readFileSync(pi.sessionFiles(session)[0], "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
  assert.deepEqual(file.filter((entry) => entry.type === "message" && entry.message.role !== "system").map((entry) => entry.message.role), ["user", "assistant", "toolResult", "user", "assistant"]);
});

test("a message sent to be queued waits though Pi could take it in, and Steer now hands it to the run", async () => {
  const session = await createThread();
  const start = await send(session, "play steer");
  await event(session, start, "tool.start");
  const text = "Also add the word banana to your reply.";
  assert.deepEqual(await client.call("prompt.submit", { session_id: session, text, profile: "pi", when_busy: "queue" }), { status: "queued", queue_id: "1" });
  assert.deepEqual((await event(session, start, "queue.changed")).payload, { queued: [{ id: "1", text }], can_steer: true });
  assert.deepEqual((await client.call("session.resume", { session_id: session })).queued, [{ id: "1", text }]);
  assert.deepEqual(pi.sentTo(session, "prompt").map((record) => record.message), ["play steer"]);
  // The run waits for the message, as the recorded one did: Steer now gives it.
  assert.deepEqual(await client.call("prompt.queue.steer", { session_id: session, queue_id: "1" }), { status: "steered" });
  const done = await completed(session, start);
  assert.equal(done.payload.text, "done");
  assert.deepEqual(pi.sentTo(session, "prompt").map((record) => [record.message, record.streamingBehavior]), [
    ["play steer", "steer"],
    [text, "steer"],
  ]);
  assert.deepEqual(
    turnEvents(session, start).filter((entry) => entry.type === "queue.changed").map((entry) => entry.payload),
    [{ queued: [{ id: "1", text }], can_steer: true }, { queued: [], can_steer: true, steered: "1" }],
  );
  assert.deepEqual((await stored(session)).slice(0, 2), [
    ["user", "play steer", ""],
    ["user", text, "steer"],
  ]);
  // Not waiting any more.
  assert.deepEqual(await client.call("prompt.queue.steer", { session_id: session, queue_id: "1" }), { status: "gone" });
  assert.equal((await client.call("session.resume", { session_id: session })).queued, undefined);
});

test("a message that reaches Pi as its run settles begins a run of Pi's own, shown as a turn with no second copy of the message", async () => {
  const session = await createThread();
  const start = await send(session, "hold late-1 settle-first");
  await event(session, start, "message.delta");
  assert.equal(await submit(session, "the late one"), "steered");
  await until(() => pi.sentTo(session, "prompt").length === 2);
  pi.release("late-1");
  const [first, second] = await ends(session, start, 2);
  assert.deepEqual([first.status, first.text], ["complete", "Working. You said: hold late-1 settle-first"]);
  assert.deepEqual([second.status, second.text], ["complete", "Working. You said: the late one"]);
  // Pi was sent the message once, and it shows once: the turn Pi began opens with nothing.
  assert.equal(pi.sentTo(session, "prompt").length, 2);
  assert.deepEqual(await stored(session), [
    ["user", "hold late-1 settle-first", ""],
    ["assistant", "Working.", ""],
    ["user", "the late one", "steer"],
    ["assistant", " You said: hold late-1 settle-first", ""],
    ["user", "", "hidden"],
    ["assistant", "Working. You said: the late one", ""],
  ]);
  assert.deepEqual(kinds(turnEvents(session, start)).filter((type) => type === "message.start").length, 2);
});

test("a message Pi refuses to take into the run is answered in a turn of its own, and waits on disk as one Pi surely never had", async () => {
  const session = await createThread();
  const start = await send(session, "hold refused-1 refuse-steer");
  await event(session, start, "message.delta");
  assert.equal(await submit(session, "take this"), "steered");
  await until(() => pi.sentTo(session, "prompt").length === 2);
  // Pi's error answer is given before it queues anything (recent-14): after a restart its
  // turn would open with its words, not with nothing.
  const kept = () => (existsSync(join(bridge.home, "state", "waiting", `${session}.json`)) ? new WaitingStore(join(bridge.home, "state", "waiting")).read(session) : []);
  await until(() => kept().length === 1);
  assert.deepEqual(kept().map((message) => [message.text, message.resent, message.refused]), [["take this", true, true]]);
  pi.release("refused-1");
  const [first, second] = await ends(session, start, 2);
  assert.equal(first.text, "Working. You said: hold refused-1 refuse-steer");
  assert.deepEqual([second.status, second.text], ["complete", "Working. You said: take this"]);
  // Offered once, refused, and sent again once the run had settled.
  assert.deepEqual(pi.sentTo(session, "prompt").map((record) => record.message), ["hold refused-1 refuse-steer", "take this", "take this"]);
});

test("two messages sent before Pi's first run has begun are two turns, both answered", async () => {
  const session = await createThread();
  const start = await send(session, "slowstart begin-1 first");
  await until(() => pi.sentTo(session, "prompt").length === 1);
  // Pi has answered `started` and not said `agent_start`: a prompt now would be lost in Pi.
  assert.equal(await submit(session, "second"), "queued");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pi.sentTo(session, "prompt").length, 1);
  pi.release("begin-1");
  const [first, second] = await ends(session, start, 2);
  assert.deepEqual([first.status, first.text], ["complete", "Working. You said: slowstart begin-1 first"]);
  assert.deepEqual([second.status, second.text], ["complete", "Working. You said: second"]);
});

test("a message sent between Stop and the turn's end is a turn of its own, after the stopped one", async () => {
  const session = await createThread();
  const start = await send(session, "hold never-2 slowstop stopped-1");
  await event(session, start, "message.delta");
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  // Queued behind an abort, Pi would deliver it inside the next turn.
  assert.equal(await submit(session, "after the stop"), "queued");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pi.sentTo(session, "prompt").length, 1);
  pi.release("stopped-1");
  const [first, second] = await ends(session, start, 2);
  assert.equal(first.status, "interrupted");
  assert.deepEqual([second.status, second.text], ["complete", "Working. You said: after the stop"]);
  assert.deepEqual(control(session), ["prompt", "clear_queue", "abort", "clear_queue", "prompt"]);
});

test("Stop is for every message handed over before it: one Pi then takes as a run of its own is stopped as that run begins, and one not written yet is never written", async () => {
  const session = await createThread();
  const start = await send(session, "hold never-5 settle-first");
  await event(session, start, "message.delta");
  // Pi takes this one only once its run has settled, and then takes its time to begin a run for it.
  // (`hold`: a run that lasts, as one that asks a model does. The stand-in's shortest run is over
  // within a tick of its start, before anything the bridge writes then can be read.)
  assert.equal(await submit(session, "slowstart stray-1 hold never-7 the first"), "steered");
  // This one waits in the bridge until Pi has said what became of the first.
  assert.equal(await submit(session, "the second"), "steered");
  await until(() => pi.sentTo(session, "prompt").length === 2);
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  const [stopped] = await ends(session, start, 1);
  assert.equal(stopped.status, "interrupted");
  await until(() => control(session).length === 5);
  // The stopped run has settled, and Pi has answered the first message `started`: its run is still to begin.
  pi.release("stray-1");
  const [, stray] = await ends(session, start, 2);
  // Stopped as it began: Pi answered neither message.
  assert.equal(stray.status, "interrupted");
  await until(() => control(session).length === 8);
  assert.deepEqual(control(session), ["prompt", "prompt", "clear_queue", "abort", "clear_queue", "clear_queue", "abort", "clear_queue"]);
  assert.deepEqual(pi.sentTo(session, "prompt").map((record) => record.message), ["hold never-5 settle-first", "slowstart stray-1 hold never-7 the first"]);
  const said = await client.from(start, (frame) => isEvent(frame, "status.update", session));
  assert.deepEqual(said.params.payload, { kind: "warn", text: 'A message was not sent, because Pi was stopped before it read it: "the second"' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(turnEvents(session, start).filter((entry) => entry.type === "message.complete").length, 2);
  assert.equal(pi.sentTo(session, "prompt").length, 2);
  assert.deepEqual((await client.call("sessions.activity")).sessions, []);
  // A message sent after the Stop is answered as usual.
  assert.equal(streamedText(await turn(session, "and now?")), "Working. You said: and now?");
});

test("a message sent after Stop still gets its turn when a message from before the Stop begins a run first: that run is stopped, and the turn goes on", async () => {
  const session = await createThread();
  const start = await send(session, "hold never-6 slowstop stopped-after-queue settle-first");
  await event(session, start, "message.delta");
  assert.equal(await submit(session, "slowstart stray-2 hold never-8 before the stop"), "steered");
  await until(() => pi.sentTo(session, "prompt").length === 2);
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  // Sent after the Stop, so meant: the bridge keeps it for a turn of its own.
  assert.equal(await submit(session, "after the stop"), "queued");
  pi.release("stopped-after-queue");
  await ends(session, start, 1);
  await client.from(start, () => (turnEvents(session, start).filter((entry) => entry.type === "message.start").length === 2 ? true : undefined)!);
  pi.release("stray-2");
  const [first, second] = await ends(session, start, 2);
  assert.equal(first.status, "interrupted");
  // (The stand-in had begun to answer the stopped run; the real Pi is stopped before its model says a word.)
  assert.equal(second.status, "complete");
  assert.match(second.text, /Working\. You said: after the stop$/);
  assert.deepEqual(pi.sentTo(session, "prompt").map((record) => record.message), ["hold never-6 slowstop stopped-after-queue settle-first", "slowstart stray-2 hold never-8 before the stop", "after the stop"]);
  // The run for the message from before the Stop was stopped before the turn's own message was written.
  assert.deepEqual(control(session), ["prompt", "prompt", "clear_queue", "abort", "clear_queue", "clear_queue", "abort", "prompt"]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(turnEvents(session, start).filter((entry) => entry.type === "message.complete").length, 2);
});

test("a run begun for a message from before a Stop that does not stop, with a message sent after the Stop waiting behind it: its process is stopped after the grace time, and that message is answered by a new one", async () => {
  const quick = piProvider(pi, { folder: cwd, interruptGraceMs: 60_000 });
  const own = await startTestBridge({ providers: new Map([["pi", quick]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  try {
    const session = await createThread({}, phone);
    // (`slowstop`: the stopped run winds down until the message after the Stop has been sent.)
    const start = await send(session, "hold never-9 slowstop stopped-2 settle-first", phone);
    await event(session, start, "message.delta", phone);
    // Pi takes this one only once its run has settled, and the run it then begins for it does not hear `abort`.
    assert.equal(await submit(session, "slowstart stray-3 hold never-10 deaf before the stop", phone), "steered");
    await until(() => pi.sentTo(session, "prompt").length === 2);
    assert.deepEqual(await phone.call("session.interrupt", { session_id: session }), { status: "interrupted" });
    assert.equal(await submit(session, "after the stop", phone), "queued");
    pi.release("stopped-2");
    const [first] = await ends(session, start, 1, phone);
    assert.equal(first.status, "interrupted");
    // The turn of the message sent after the Stop is open, and waits for Pi to say what became of the one before it.
    await phone.from(start, () => (turnEvents(session, start, phone).filter((entry) => entry.type === "message.start").length === 2 ? true : undefined)!);
    // Only the run that ignores Stop gets the short grace, not the gated setup above.
    (quick as { interruptGraceMs: number }).interruptGraceMs = 150;
    const began = Date.now();
    pi.release("stray-3");
    const [, second] = await ends(session, start, 2, phone);
    assert.ok(Date.now() - began >= 140);
    // Not stopped with the run it waited behind: answered, by a process started for it.
    assert.equal(second.status, "complete");
    assert.match(second.text, /Working\. You said: after the stop$/);
    assert.equal(pi.starts(session).length, 2);
    assert.deepEqual(pi.sentTo(session, "prompt").map((record) => record.message), ["hold never-9 slowstop stopped-2 settle-first", "slowstart stray-3 hold never-10 deaf before the stop", "after the stop"]);
    assert.deepEqual(control(session), ["prompt", "prompt", "clear_queue", "abort", "clear_queue", "clear_queue", "abort", "prompt"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(turnEvents(session, start, phone).filter((entry) => entry.type === "message.complete").length, 2);
    assert.equal(pi.alive().length, 1);
  } finally {
    await phone.close();
    await own.dispose();
  }
});

test("the same, with that run settling just as its process is stopped: the message sent after the Stop is not written to the process on its way out, and is answered by a new one", async () => {
  const quick = piProvider(pi, { folder: cwd, interruptGraceMs: 60_000 });
  const own = await startTestBridge({ providers: new Map([["pi", quick]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  try {
    const session = await createThread({}, phone);
    const start = await send(session, "hold never-31 slowstop stopped-32 settle-first", phone);
    await event(session, start, "message.delta", phone);
    // (`settle-leaving`: told to go, this run settles first, and its settle reaches the bridge before the end of its process does.)
    assert.equal(await submit(session, "slowstart stray-33 hold never-34 deaf settle-leaving before the stop", phone), "steered");
    await until(() => pi.sentTo(session, "prompt").length === 2);
    assert.deepEqual(await phone.call("session.interrupt", { session_id: session }), { status: "interrupted" });
    assert.equal(await submit(session, "after the stop", phone), "queued");
    pi.release("stopped-32");
    const [first] = await ends(session, start, 1, phone);
    assert.equal(first.status, "interrupted");
    await phone.from(start, () => (turnEvents(session, start, phone).filter((entry) => entry.type === "message.start").length === 2 ? true : undefined)!);
    (quick as { interruptGraceMs: number }).interruptGraceMs = 150;
    pi.release("stray-33");
    const [, second] = await ends(session, start, 2, phone);
    // Not lost with the process that was stopped: written once, to the one started for it, and answered.
    assert.equal(second.status, "complete");
    assert.match(second.text, /Working\. You said: after the stop$/);
    assert.equal(pi.starts(session).length, 2);
    assert.deepEqual(pi.sentTo(session, "prompt").map((record) => record.message), ["hold never-31 slowstop stopped-32 settle-first", "slowstart stray-33 hold never-34 deaf settle-leaving before the stop", "after the stop"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(turnEvents(session, start, phone).filter((entry) => entry.type === "message.complete").length, 2);
    assert.equal(pi.alive().length, 1);
  } finally {
    await phone.close();
    await own.dispose();
  }
});

test("Stop while a message Pi took as a run of its own has not begun that run: nothing can be told to Pi yet, the run is stopped as it begins, and the thread can then be removed", async () => {
  const session = await createThread();
  const start = await send(session, "hold late-4 settle-first");
  await event(session, start, "message.delta");
  assert.equal(await submit(session, "slowstart late-5 hold never-11 the pending one"), "steered");
  await until(() => pi.sentTo(session, "prompt").length === 2);
  pi.release("late-4");
  const [first] = await ends(session, start, 1);
  assert.equal(first.status, "complete");
  // Pi has answered `started` and not begun the run: no turn is running, and the thread is at work.
  await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(client.call("thread.delete", { thread: session }), (error: RpcFailure) => error.message === "Pi is still working in this thread. Stop it, then remove it.");
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  // An `abort` now would be answered and forgotten.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(control(session), ["prompt", "prompt"]);
  pi.release("late-5");
  const [, second] = await ends(session, start, 2);
  assert.equal(second.status, "interrupted");
  await until(() => control(session).length === 5);
  assert.deepEqual(control(session), ["prompt", "prompt", "clear_queue", "abort", "clear_queue"]);
  // At rest once the stopped run has settled: there is nothing more to stop, and the thread goes.
  assert.equal((await client.call("thread.wait", { thread: session, timeout_ms: 2000 })).state, "idle");
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "not_interrupted" });
  assert.deepEqual(await client.call("thread.delete", { thread: session }), {});
  made.splice(made.indexOf(session), 1);
  await until(() => pi.alive().length === 0);
  assert.equal(turnEvents(session, start).filter((entry) => entry.type === "message.complete").length, 2);
});

test("Stop while two such messages are on their way, the second not written yet: the second is never written and is named, and the first one's run is stopped as it begins", async () => {
  const session = await createThread();
  const start = await send(session, "hold late-6 settle-first");
  await event(session, start, "message.delta");
  assert.equal(await submit(session, "slowstart late-7 hold never-12 the first"), "steered");
  assert.equal(await submit(session, "the second"), "steered");
  await until(() => pi.sentTo(session, "prompt").length === 2);
  pi.release("late-6");
  const [first] = await ends(session, start, 1);
  assert.equal(first.status, "complete");
  await new Promise((resolve) => setTimeout(resolve, 40));
  const stopped = client.frames.length;
  // As `portals stop THREAD` does.
  assert.deepEqual(await client.call("thread.stop", { thread: session }), { stopped: true });
  pi.release("late-7");
  const [, second] = await ends(session, start, 2);
  assert.equal(second.status, "interrupted");
  const said = await client.from(stopped, (frame) => isEvent(frame, "status.update", session));
  assert.deepEqual(said.params.payload, { kind: "warn", text: 'A message was not sent, because Pi was stopped before it read it: "the second"' });
  assert.equal((await client.call("thread.wait", { thread: session, timeout_ms: 2000 })).state, "idle");
  assert.deepEqual(pi.sentTo(session, "prompt").map((record) => record.message), ["hold late-6 settle-first", "slowstart late-7 hold never-12 the first"]);
  assert.equal(turnEvents(session, start).filter((entry) => entry.type === "message.complete").length, 2);
  // A message sent after the Stop is answered as usual.
  assert.equal(streamedText(await turn(session, "and now?")), "Working. You said: and now?");
});

test("a message Pi takes as a run of its own keeps the thread at work until that run has begun: a send that waits gets that run's reply, and the thread is not removed meanwhile", async () => {
  const session = await createThread();
  const start = await send(session, "hold late-2 settle-first");
  await event(session, start, "message.delta");
  // As `portals send THREAD "text" --wait` does.
  const sending = client.call("thread.send", { thread: session, text: "slowstart late-3 what is the answer", wait: true, timeout_ms: 4000 });
  await until(() => pi.sentTo(session, "prompt").length === 2);
  pi.release("late-2");
  await ends(session, start, 1);
  // Pi has answered `started` and not begun the run.
  await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(client.call("thread.delete", { thread: session }), (error: RpcFailure) => error.message === "Pi is still working in this thread. Stop it, then remove it.");
  pi.release("late-3");
  const answer = await sending;
  assert.deepEqual([answer.status, answer.state, answer.reply], ["steered", "idle", "Working. You said: [Portals: from the command line]\nslowstart late-3 what is the answer"]);
});

test("a run Pi begins by itself is a turn with no opening line, and a message sent meanwhile joins it", async () => {
  const session = await createThread();
  // An extension's command that Pi handles, and that sends Pi a message of its own a moment later.
  const start = await send(session, "/own hold own-1");
  const first = await completed(session, start);
  assert.deepEqual([first.payload.status, first.payload.text], ["complete", ""]);
  const begun = client.frames.length;
  await event(session, start + 1, "message.delta");
  assert.deepEqual((await client.call("sessions.activity")).sessions, [{ session_id: session, state: "running" }]);
  assert.equal(await submit(session, "join in"), "steered");
  await until(() => pi.sentTo(session, "prompt").length === 2);
  pi.release("own-1");
  const [, second] = await ends(session, start, 2);
  assert.deepEqual([second.status, second.text], ["complete", "Also noted."]);
  assert.ok(begun > start);
  assert.deepEqual(await stored(session), [
    ["user", "/own hold own-1", ""],
    ["user", "", "hidden"],
    ["assistant", "Working.", ""],
    ["user", "join in", "steer"],
    ["assistant", " You said: hold own-1", ""],
    ["assistant", "Also noted.", ""],
  ]);
});

test("a message handed over as the run settles, with a command waiting behind it: the command's turn waits for Pi's run to begin and joins it", async () => {
  const session = await createThread();
  const start = await send(session, "hold join-1 settle-first");
  await event(session, start, "message.delta");
  // Pi answers this one `started` once its run has settled, and takes its time to begin the
  // run; the run then holds until the command has joined it, as a model's run would last
  // that long (a run that ended first would leave the command a run of its own).
  assert.equal(await submit(session, "slowstart join-2 hold join-3 the late one"), "steered");
  // A command is never steered: it waits for a turn of its own.
  assert.equal(await submit(session, "/shout kiwi"), "queued");
  await until(() => pi.sentTo(session, "prompt").length === 2);
  pi.release("join-1");
  await ends(session, start, 1);
  // The command's turn has begun, and its prompt is not written: before `agent_start` Pi
  // would take it for a new one, lose it and report a settle.
  await client.from(start, () => (turnEvents(session, start).filter((entry) => entry.type === "message.start").length === 2 ? true : undefined)!);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(pi.sentTo(session, "prompt").length, 2);
  pi.release("join-2");
  // Written once Pi's run has begun.
  await until(() => pi.sentTo(session, "prompt").length === 3);
  pi.release("join-3");
  const [, second] = await ends(session, start, 2);
  // One turn for both: the late message's answer, then the command's.
  assert.deepEqual([second.status, second.text], ["complete", "Also noted."]);
  assert.deepEqual(pi.sentTo(session, "prompt").map((record) => record.message), ["hold join-1 settle-first", "slowstart join-2 hold join-3 the late one", "/shout kiwi"]);
  assert.deepEqual((await stored(session)).slice(-3), [
    ["user", "/shout kiwi", ""],
    ["assistant", "Working. You said: slowstart join-2 hold join-3 the late one", ""],
    ["assistant", "Also noted.", ""],
  ]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(turnEvents(session, start).filter((entry) => entry.type === "message.complete").length, 2);
});

test("a message Pi takes and then never begins to answer fails its turn, when the time a command has is up", async () => {
  const impatient = piProvider(pi, { folder: cwd, callTimeoutMs: 1500 });
  const own = await startTestBridge({ providers: new Map([["pi", impatient]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  try {
    const session = await createThread({}, phone);
    // Pi answers `started`; its run does not begin until the gate opens.
    const start = await send(session, "slowstart stuck-1 hello", phone);
    const done = await completed(session, start, phone);
    assert.deepEqual([done.payload.status, done.payload.text], ["error", "Pi took the message and then did not begin to answer it. Send it again."]);
    // Should it begin after all, that is a run of Pi's own.
    pi.release("stuck-1");
    const [, late] = await ends(session, start, 2, phone);
    assert.deepEqual([late.status, late.text], ["complete", "Working. You said: slowstart stuck-1 hello"]);
  } finally {
    await phone.close();
    await own.dispose();
  }
});

test("a message Pi never answers, and is not at work on, is said again in a turn of its own, and the messages after it are not held up", async () => {
  const impatient = piProvider(pi, { folder: cwd, callTimeoutMs: 1000 });
  const own = await startTestBridge({ providers: new Map([["pi", impatient]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  try {
    const session = await createThread({}, phone);
    const start = await send(session, "hold lost-1 lose-late", phone);
    await event(session, start, "message.delta", phone);
    // Handed to the run as it settles, Pi takes it and never answers (an extension compacting at `agent_settled`).
    assert.equal(await submit(session, "the lost one", phone), "steered");
    await until(() => pi.sentTo(session, "prompt").length === 2);
    pi.release("lost-1");
    const [first] = await ends(session, start, 1, phone);
    assert.equal(first.text, "Working. You said: hold lost-1 lose-late");
    // Before, the next message waited for that answer for good.
    await submit(session, "the next one", phone);
    const [, second, third] = await ends(session, start, 3, phone);
    assert.deepEqual([second.status, second.text], ["complete", "Working. You said: the next one"]);
    assert.deepEqual([third.status, third.text], ["complete", "Working. You said: the lost one"]);
    // Pi was asked how it was, twice at rest, before the message was taken as not sent.
    assert.ok(pi.sentTo(session, "get_state").length >= 3);
    assert.deepEqual(pi.sentTo(session, "prompt").map((record) => record.message), ["hold lost-1 lose-late", "the lost one", "the next one", "the lost one"]);
  } finally {
    await phone.close();
    await own.dispose();
  }
});

// MARK: /compact

test("/compact is carried out with Pi's compact: a status line, the mark, the ring, and a message sent meanwhile waits", async () => {
  const session = await createThread();
  await turn(session, "one");
  await turn(session, "two");
  await ring(session, 1400);
  assert.deepEqual((await client.call("session.resume", { session_id: session })).info.usage, { context_used: 1400, context_max: 272_000 });
  // The app asks what the command stands for, and sends it as a message.
  assert.deepEqual(await client.call("command.dispatch", { session_id: session, name: "compact", arg: "hold compact-1 keep the names" }), { type: "send", message: "/compact hold compact-1 keep the names" });
  const start = await send(session, "/compact hold compact-1 keep the names");
  const status = await event(session, start, "thinking.delta");
  assert.deepEqual(status.payload, { text: "Compacting the conversation…" });
  // Pi refuses a prompt during a compaction: the message waits for the turn to end.
  assert.equal(await submit(session, "three"), "queued");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(control(session), ["prompt", "prompt", "compact"]);
  assert.deepEqual(pi.sentTo(session, "compact")[0], { id: pi.sentTo(session, "compact")[0].id, type: "compact", customInstructions: "hold compact-1 keep the names" });
  pi.release("compact-1");
  const [compacted, after] = await ends(session, start, 2);
  assert.deepEqual([compacted.status, compacted.text], ["complete", ""]);
  assert.deepEqual([after.status, after.text], ["complete", "Working. You said: three"]);
  const events = turnEvents(session, start);
  assert.deepEqual(kinds(events.filter((entry) => entry.type !== "queue.changed")).slice(0, 4), ["message.start", "thinking.delta", "session.compacted", "message.complete"]);
  assert.deepEqual(events.filter((entry) => entry.type === "thinking.delta").map((entry) => entry.payload.text), ["Compacting the conversation…", ""]);
  assert.deepEqual(events.find((entry) => entry.type === "session.compacted").payload, { trigger: "manual", tokens_before: 1400 });
  // Pi's own estimate of what is left, until the next answer says how full the context is.
  const rings = events.filter((entry) => entry.type === "session.usage").map((entry) => entry.payload.usage.context_used);
  assert.equal(rings[0], 560);
  assert.deepEqual(await stored(session), [
    ["user", "one", ""],
    ["assistant", "Working. You said: one", ""],
    ["user", "two", ""],
    ["assistant", "Working. You said: two", ""],
    ["user", "/compact hold compact-1 keep the names", ""],
    ["compaction", "", ""],
    ["user", "three", ""],
    ["assistant", "Working. You said: three", ""],
  ]);

  // Compacted already, with nothing said since: Pi's sentence ends the turn.
  await turn(session, "/compact");
  const again = await turn(session, "/compact");
  assert.deepEqual([again.at(-1).payload.status, again.at(-1).payload.text], ["error", "Already compacted"]);
});

test("/compact on a thread too short fails with Pi's sentence, and Stop cancels one under way", async () => {
  const session = await createThread();
  // The first message of a thread: the process starts for it.
  const short = await turn(session, "/compact");
  assert.deepEqual([short.at(-1).payload.status, short.at(-1).payload.text], ["error", "Nothing to compact (session too small)"]);
  assert.deepEqual(short.filter((entry) => entry.type === "thinking.delta").map((entry) => entry.payload.text), ["Compacting the conversation…", ""]);
  assert.deepEqual(pi.sentTo(session, "compact").map(({ id: _id, ...command }) => command), [{ type: "compact" }]);

  await turn(session, "one");
  await turn(session, "two");
  const start = await send(session, "/compact hold never-3");
  await event(session, start, "thinking.delta");
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  const done = await completed(session, start);
  assert.equal(done.payload.status, "interrupted");
  const events = turnEvents(session, start);
  assert.equal(events.some((entry) => entry.type === "session.compacted"), false);
  assert.deepEqual(notices(events), []);
  // The thread goes on as it was.
  assert.equal(streamedText(await turn(session, "three")), "Working. You said: three");
});

test("/compact with a file attached is words for Pi, as with an image: the message and the file go in a prompt, and nothing is compacted", async () => {
  const session = await createThread();
  const attached = await client.call("file.attach_bytes", { session_id: session, content_base64: Buffer.from("notes").toString("base64"), filename: "notes.txt", profile: "pi" });
  assert.equal(attached.attached, true);
  const events = await turn(session, "/compact this file into three lines");
  assert.equal(events.at(-1).payload.status, "complete");
  assert.deepEqual(control(session), ["prompt"]);
  assert.equal(pi.sentTo(session, "prompt")[0].message, `/compact this file into three lines\n\nFiles attached in Portals (saved on this Mac):\n- ${attached.path}`);
});

// MARK: Commands and dialogs

test("a command of an extension's is a turn Pi handles itself, and what the command says is the reply", async () => {
  const session = await createThread();
  assert.deepEqual(await client.call("command.dispatch", { session_id: session, name: "say", arg: "first line | second line" }), { type: "send", message: "/say first line | second line" });
  const said = await turn(session, "/say first line | second line");
  assert.deepEqual(kinds(said), ["message.start", "session.title", "message.delta", "message.complete"]);
  assert.deepEqual(unspent(said.at(-1).payload), { status: "complete", text: "first line\nsecond line" });
  // A message of the extension's own is a reply too.
  const told = await turn(session, "/tell All done.");
  assert.equal(told.at(-1).payload.text, "All done.");
  // A skill is sent as it is typed; Pi expands it.
  assert.deepEqual(await client.call("command.dispatch", { session_id: session, name: "skill:greet", arg: "Ada" }), { type: "send", message: "/skill:greet Ada" });
  await assert.rejects(client.call("command.dispatch", { session_id: session, name: "loud" }), (error: RpcFailure) => error.code === -32602);
  // No run was begun for any of them, and Pi wrote no session file.
  assert.deepEqual(pi.sessionFiles(session), []);
});

test("each of an extension's four dialogs is a card, and the card's answer goes back to Pi", async () => {
  const session = await createThread();
  const ask = async (command: string, answer: (card: Frame) => unknown): Promise<{ card: Frame; reply: string; back: Frame }> => {
    const before = pi.sentTo(session, "extension_ui_response").length;
    const start = await send(session, command);
    const card = await client.nextRequest();
    assert.equal(card.method, "clarify");
    assert.equal(card.params.questions.length, 1);
    client.answer(card.id, answer(card));
    const done = await completed(session, start);
    assert.equal(done.payload.status, "complete");
    const { type: _type, id: _id, ...back } = pi.sentTo(session, "extension_ui_response")[before];
    return { card: card.params.questions[0], reply: done.payload.text, back };
  };
  const one = (value: string | null) => (card: Frame) => ({ answers: { [card.params.questions[0].qid]: value } });

  const confirm = await ask("/ask-confirm", one("Yes"));
  assert.deepEqual([confirm.card.question, confirm.card.choices, confirm.card.multi_select], ["Send the report?\n\nIt goes to everyone on the list.", ["Yes", "No"], false]);
  assert.deepEqual([confirm.back, confirm.reply], [{ confirmed: true }, "Confirmed"]);
  assert.deepEqual((await ask("/ask-confirm", one("No"))).back, { confirmed: false });
  // A card dismissed cancels the dialog.
  assert.deepEqual((await ask("/ask-confirm", () => ({ answers: null }))).back, { cancelled: true });

  const select = await ask("/ask-select", one("Banana"));
  assert.deepEqual([select.card.question, select.card.choices], ["Which fruit?", ["Apple", "Banana", "Cherry"]]);
  assert.deepEqual([select.back, select.reply], [{ value: "Banana" }, "Picked Banana"]);
  // Something typed is none of Pi's options.
  assert.deepEqual((await ask("/ask-select", one("Durian"))).back, { cancelled: true });

  const input = await ask("/ask-input", one("Ada"));
  assert.deepEqual([input.card.question, input.card.choices], ["Your name", []]);
  assert.deepEqual([input.back, input.reply], [{ value: "Ada" }, "Name: Ada"]);

  const editor = await ask("/ask-editor", one("Line 1\nLine 2\nLine 3"));
  assert.deepEqual([editor.card.question, editor.card.choices], ["Edit the note\n\nLine 1\nLine 2", []]);
  assert.deepEqual([editor.back, editor.reply], [{ value: "Line 1\nLine 2\nLine 3" }, "Note has 3 lines"]);
});

test("a card answered on one device closes on the other; one Pi stops waiting for is withdrawn when its time is up", async () => {
  const session = await createThread();
  await turn(session, "hello");
  const other = await TestClient.open(bridge);
  try {
    await other.call("session.resume", { session_id: session });
    const start = await send(session, "/ask-confirm");
    const [mine, theirs] = await Promise.all([client.nextRequest(), other.nextRequest()]);
    assert.equal(mine.id, theirs.id);
    assert.deepEqual((await client.call("sessions.activity")).sessions, [{ session_id: session, state: "waiting" }]);
    other.answer(theirs.id, { answers: { [theirs.params.questions[0].qid]: "Yes" } });
    const closed = await event(session, start, "request.cancel");
    assert.deepEqual(closed.payload, { id: mine.id, reason: "resolved" });
    assert.equal((await completed(session, start)).payload.text, "Confirmed");

    // Pi gives this one 300 ms, settles it itself and says nothing: the card goes when the time is up.
    const answered = pi.sentTo(session, "extension_ui_response").length;
    const timed = await send(session, "/ask-timed");
    const card = await client.nextRequest();
    assert.equal(card.params.questions[0].question, "Still there?\n\nThis answers itself in a moment.");
    const withdrawn = await event(session, timed, "request.cancel");
    assert.deepEqual(withdrawn.payload, { id: card.id, reason: "timeout" });
    const done = await completed(session, timed);
    assert.deepEqual([done.payload.status, done.payload.text], ["complete", "No answer in time"]);
    // An answer that comes now is nobody's, and Pi was sent none.
    client.answer(card.id, { answers: { [card.params.questions[0].qid]: "Yes" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(pi.sentTo(session, "extension_ui_response").length, answered);
  } finally {
    await other.close();
  }
});

test("a dialog outside any turn is a card too, and a thread with a card open is not cooled", async () => {
  const session = await createThread();
  // The extension answers the command at once and asks a moment later.
  await turn(session, "/ask-later");
  const card = await client.nextRequest();
  assert.equal(card.params.questions[0].question, "Later\n\nAsked outside any turn.");
  assert.deepEqual((await client.call("sessions.activity")).sessions, [{ session_id: session, state: "waiting" }]);
  provider.pool.sweep(Date.now() + 16 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pi.alive().length, 1);
  client.answer(card.id, { answers: { [card.params.questions[0].qid]: "Yes" } });
  await until(() => pi.sentTo(session, "extension_ui_response").length === 1);
  assert.equal(pi.sentTo(session, "extension_ui_response")[0].confirmed, true);
  // Idle from now on: cooled once it has been for long enough.
  provider.pool.sweep(Date.now() + 40 * 60_000);
  await until(() => pi.alive().length === 0);
});

test("Stop takes back a card an extension opened outside any turn, and the thread can then be removed", async () => {
  const session = await createThread();
  await turn(session, "/ask-later");
  const card = await client.nextRequest();
  // The thread waits on the card, and no turn is running that Stop could end.
  await assert.rejects(client.call("thread.delete", { thread: session }), (error: RpcFailure) => error.message === "Pi is still working in this thread. Stop it, then remove it.");
  const start = client.frames.length;
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  assert.deepEqual((await event(session, start, "request.cancel")).payload, { id: card.id, reason: "interrupted" });
  // Pi's extension is told nobody answered.
  await until(() => pi.sentTo(session, "extension_ui_response").length === 1);
  assert.equal(pi.sentTo(session, "extension_ui_response")[0].cancelled, true);
  assert.deepEqual((await client.call("sessions.activity")).sessions, []);
  // With nothing open and nothing running there is nothing to stop.
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "not_interrupted" });
  assert.deepEqual(await client.call("thread.delete", { thread: session }), {});
  made.splice(made.indexOf(session), 1);
});

// MARK: Titles

test("renaming a thread gives Pi the new name: when its process next starts, or at once when one runs, also in the middle of a turn", async () => {
  const session = await createThread();
  const names = () => pi.sentTo(session, "set_session_name").map((record) => record.name);
  // Before any message there is no process to tell.
  assert.deepEqual(await client.call("session.rename", { session_id: session, title: "Named first" }), {});
  assert.deepEqual(pi.starts(session), []);
  const first = await turn(session, "hello");
  // The thread keeps the name it was given: its first message names nothing.
  assert.equal(first.some((entry) => entry.type === "session.title"), false);
  assert.deepEqual(names(), ["Named first"]);

  await client.call("session.rename", { session_id: session, title: "Named again" });
  assert.deepEqual(names(), ["Named first", "Named again"]);
  // The model and the level wait for a turn's end; the name does not.
  const start = await send(session, "hold rename-1");
  await event(session, start, "message.delta");
  await client.call("session.rename", { session_id: session, title: "Named mid-turn" });
  assert.deepEqual(names(), ["Named first", "Named again", "Named mid-turn"]);
  pi.release("rename-1");
  await completed(session, start);

  // Renamed while its process is stopped: Pi hears of it when the next one starts.
  provider.pool.sweep(Date.now() + 16 * 60_000);
  await until(() => pi.alive().length === 0);
  await client.call("session.rename", { session_id: session, title: "Named cold" });
  assert.equal(names().length, 3);
  await turn(session, "hello again");
  assert.deepEqual(names(), ["Named first", "Named again", "Named mid-turn", "Named cold"]);
  assert.equal((await client.call("session.resume", { session_id: session })).info.title, "Named cold");
});

test("a new Pi thread is named after its first message by a one-shot pi --print with nothing of the user's Pi but its sign-ins, on the thread's model; a thread renamed meanwhile keeps its name, and one Pi gives no name keeps the first line", async () => {
  const naming = standin({ title: '"Plan the header spacing."', titleGate: "title-1" });
  const own = await startTestBridge({ providers: new Map([["pi", piProvider(naming, { folder: cwd, settings: { titleModel: undefined } })]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  const titles = (session: string) => phone.frames.filter((frame) => isEvent(frame, "session.title", session)).map((frame) => frame.params.payload.title);
  const printers = () => naming.starts().filter((line) => line.args?.includes("--print"));
  const printed = async (count: number) => {
    await until(() => printers().length === count && printers().every((line) => !naming.alive().includes(line.pid)));
    // What the name's answer sets off runs a moment after the process is gone.
    await new Promise((resolve) => setTimeout(resolve, 100));
  };
  try {
    const session = (await phone.call("session.create", { profile: "pi", cwd })).session_id as string;
    await turn(session, "please plan the header spacing\nwith the pill", phone);
    // The first line at once; the name when Pi gives it (here after the turn).
    assert.deepEqual(titles(session), ["please plan the header spacing"]);
    await until(() => printers().length === 1);
    const [{ args, cwd: where, env }] = printers();
    for (const flag of ["--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files"]) assert.ok(args!.includes(flag), flag);
    assert.equal(args![args!.indexOf("--model") + 1], "openai/gpt-6-luna");
    assert.equal(args![args!.indexOf("--thinking") + 1], "off");
    assert.match(args!.at(-1)!, /^Generate a concise[\s\S]*User: please plan the header spacing\nwith the pill\n<\/conversation>$/);
    assert.notEqual(where, cwd);
    assert.equal(env!.PORTALS_THREAD, undefined);
    naming.release("title-1");
    await printed(1);
    // Without the quotes and the full stop it was told to leave out; Pi's session takes it too.
    assert.deepEqual(titles(session), ["please plan the header spacing", "Plan the header spacing"]);
    assert.deepEqual(naming.sentTo(session, "set_session_name").map((record) => record.name), ["please plan the header spacing", "Plan the header spacing"]);
    assert.equal((await phone.call("session.resume", { session_id: session })).info.title, "Plan the header spacing");
    // Its next message names nothing.
    await turn(session, "and the avatar", phone);
    await printed(1);

    naming.configure({ title: "Made name", titleGate: "title-2" });
    const renamed = (await phone.call("session.create", { profile: "pi", cwd })).session_id as string;
    await turn(renamed, "first words", phone);
    await phone.call("session.rename", { session_id: renamed, title: "Mine" });
    naming.release("title-2");
    await printed(2);
    assert.deepEqual(titles(renamed), ["first words", "Mine"]);
    assert.equal((await phone.call("session.resume", { session_id: renamed })).info.title, "Mine");

    naming.configure({ titleFails: "Error: No API key found for openai." });
    const failed = (await phone.call("session.create", { profile: "pi", cwd })).session_id as string;
    await turn(failed, "more words", phone);
    await printed(3);
    assert.deepEqual(titles(failed), ["more words"]);

    // Started with a title (portals start --title): never named.
    const titled = (await phone.call("session.create", { profile: "pi", cwd, title: "Given" })).session_id as string;
    await turn(titled, "other words", phone);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(printers().length, 3);
  } finally {
    await phone.close();
    await own.dispose();
    await until(() => naming.alive().length === 0);
    naming.dispose();
  }
});

test("pi.titleModel names the model a Pi thread's name is made with, and null makes none", async () => {
  const naming = standin({ title: "Fix the login" });
  try {
    const settings = { model: "gpt-5", provider: "openai", reasoningEffort: "high" };
    const chosen = piProvider(naming, { settings: { titleModel: "plan/mimo-v2" } });
    assert.equal(await chosen.name("[Portals: from Codex in Fix login]\nthe login fails", settings), "Fix the login");
    const [{ args }] = naming.starts();
    assert.equal(args![args!.indexOf("--model") + 1], "plan/mimo-v2");
    // Who sent it is not what the message says.
    assert.match(args!.at(-1)!, /User: the login fails\n/);
    await chosen.close();
    const none = piProvider(naming);
    assert.equal(await none.name("the login fails", settings), null);
    assert.equal(naming.starts().length, 1);
    await none.close();
  } finally {
    naming.dispose();
  }
});

// MARK: Models and levels

test("a model and a level are set in Pi where they differ: at once at rest, at the turn's end during one, and the thread reports the level Pi runs at", async () => {
  const session = await createThread();
  await turn(session, "hello");
  const settings = () => pi.sentTo(session).filter((record) => record.type === "set_model" || record.type === "set_thinking_level").map(({ id: _id, ...command }) => command);
  const info = async () => {
    const resumed = (await client.call("session.resume", { session_id: session })).info;
    return [resumed.model, resumed.provider, resumed.reasoning_effort];
  };
  assert.deepEqual(settings(), []);
  assert.deepEqual(await info(), ["gpt-6-luna", "openai", "none"]);

  assert.deepEqual(await client.call("config.set", { session_id: session, key: "reasoning", value: "high" }), {});
  assert.deepEqual(settings(), [{ type: "set_thinking_level", level: "high" }]);
  assert.deepEqual(await info(), ["gpt-6-luna", "openai", "high"]);

  // At rest the model changes at once, and the thread's level is given again: Pi may move it with the model.
  assert.deepEqual(await client.call("config.set", { session_id: session, key: "model", value: "gpt-5 --provider openai --session" }), {});
  assert.deepEqual(settings().slice(1), [
    { type: "set_model", provider: "openai", modelId: "gpt-5" },
    { type: "set_thinking_level", level: "high" },
  ]);
  assert.deepEqual(await info(), ["gpt-5", "openai", "high"]);

  // GPT-5 has no `off`: the nearest level it has is asked for, and Pi's word for what it runs at is the thread's.
  await client.call("config.set", { session_id: session, key: "reasoning", value: "none" });
  assert.deepEqual(settings().at(-1), { type: "set_thinking_level", level: "minimal" });
  assert.deepEqual(await info(), ["gpt-5", "openai", "minimal"]);
  // `ultra` is the strongest the model has.
  await client.call("config.set", { session_id: session, key: "reasoning", value: "ultra" });
  assert.deepEqual(settings().at(-1), { type: "set_thinking_level", level: "high" });
  assert.deepEqual(await info(), ["gpt-5", "openai", "high"]);

  // The ring is said again against the new model's window, with no reply needed for it.
  assert.deepEqual((await client.find((frame) => isEvent(frame, "session.usage", session) && frame.params.payload.usage.context_max === 400_000)).params.payload, { usage: { context_used: 1200, context_max: 400_000 } });

  // During a turn the change waits for the turn's end.
  const before = settings().length;
  const start = await send(session, "hold model-1");
  await event(session, start, "message.delta");
  assert.deepEqual(await client.call("config.set", { session_id: session, key: "model", value: "gpt-4.1-nano --session" }), { deferred: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settings().length, before);
  pi.release("model-1");
  await completed(session, start);
  await until(() => settings().length === before + 2);
  // A model that does not think: `off` is the only level it has.
  assert.deepEqual(settings().slice(before), [
    { type: "set_model", provider: "openai", modelId: "gpt-4.1-nano" },
    { type: "set_thinking_level", level: "off" },
  ]);
  assert.deepEqual(await info(), ["gpt-4.1-nano", "openai", "none"]);

  // A model Pi refuses fails the change with Pi's sentence, and the thread stays on the one it had.
  await assert.rejects(client.call("config.set", { session_id: session, key: "model", value: "gpt-locked --session" }), (error: RpcFailure) => error.message === "No API key for openai/gpt-locked");
  assert.deepEqual(await info(), ["gpt-4.1-nano", "openai", "none"]);
  await assert.rejects(client.call("config.set", { session_id: session, key: "model", value: "no-such-model --session" }), (error: RpcFailure) => error.code === -32602);
  assert.equal(streamedText(await turn(session, "still here")), "Working. You said: still here");
});

test("a thread's model and level are kept until its process starts; a model Pi then refuses fails the turn with Pi's sentence", async () => {
  const session = await createThread({ model: "gpt-5", reasoning_effort: "low" });
  await client.call("config.set", { session_id: session, key: "reasoning", value: "medium" });
  assert.deepEqual(pi.starts(session), []);
  await turn(session, "hello");
  assert.deepEqual(pi.sentTo(session).slice(0, 6).map(({ id: _id, ...command }) => command), [
    { type: "get_state" },
    { type: "get_session_stats" },
    { type: "set_model", provider: "openai", modelId: "gpt-5" },
    // The ring again, against the new model's window.
    { type: "get_session_stats" },
    { type: "set_thinking_level", level: "medium" },
    { type: "set_session_name", name: "hello" },
  ]);

  const locked = await createThread({ model: "gpt-locked" });
  const failed = await turn(locked, "hello");
  assert.deepEqual([failed.at(-1).payload.status, failed.at(-1).payload.text], ["error", "No API key for openai/gpt-locked"]);
  assert.deepEqual(pi.sentTo(locked, "prompt"), []);
  // Another model, and the thread works.
  await client.call("config.set", { session_id: locked, key: "model", value: "gpt-6-luna --session" });
  assert.equal(streamedText(await turn(locked, "hello again")), "Working. You said: hello again");
});

test("one model id under two of Pi's providers: the default's provider is listed first, and a thread that names none runs on it", async () => {
  const mimo = { id: "mimo-v2", name: "MiMo v2", reasoning: true, input: ["text"], contextWindow: 1_000_000 };
  const twice = standin({ models: [{ ...mimo, provider: "paid" }, { ...mimo, provider: "plan" }], default: "plan/mimo-v2", level: "medium" });
  const own = await startTestBridge({ providers: new Map([["pi", piProvider(twice, { folder: cwd })]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  try {
    const options = await phone.call("model.options", { profile: "pi" });
    assert.deepEqual(options.providers.map((entry: Frame) => [entry.slug, entry.models]), [
      ["plan", ["mimo-v2"]],
      ["openai", ["gpt-6-luna", "gpt-5", "gpt-4.1-nano", "o3-mini"]],
      ["paid", ["mimo-v2"]],
    ]);
    assert.deepEqual([options.model, options.provider], ["mimo-v2", "plan"]);
    assert.deepEqual(options.model_levels["mimo-v2"], ["none", "minimal", "low", "medium", "high"]);
    assert.deepEqual(await phone.call("config.get", { key: "reasoning", profile: "pi" }), { value: "medium" });

    const created = await phone.call("session.create", { profile: "pi", cwd });
    const session = created.session_id as string;
    assert.deepEqual([created.info.model, created.info.provider, created.info.reasoning_effort], ["mimo-v2", "plan", "medium"]);
    await turn(session, "hello", phone);
    // Pi's own default already: nothing was set.
    assert.deepEqual(twice.sentTo(session, "set_model"), []);
    // The same id from the other provider is another model to Pi.
    await phone.call("config.set", { session_id: session, key: "model", value: "mimo-v2 --provider paid --session" });
    assert.deepEqual(twice.sentTo(session, "set_model").map(({ id: _id, ...command }) => command), [{ type: "set_model", provider: "paid", modelId: "mimo-v2" }]);
    assert.deepEqual((await phone.call("session.resume", { session_id: session })).info.provider, "paid");
  } finally {
    await phone.close();
    await own.dispose();
    await until(() => twice.alive().length === 0);
    twice.dispose();
  }
});

test("pi.model names the model a new Pi thread starts on, whatever Pi's own default is, and one Pi does not list is passed over", async () => {
  const mimo = { id: "mimo-v2", name: "MiMo v2", reasoning: true, input: ["text"], contextWindow: 1_000_000 };
  // Pi's own default is another provider's model, as under launchd without the keys a terminal has.
  const named = standin({ models: [{ ...mimo, provider: "plan" }], default: "plan/mimo-v2", level: "medium" });
  const own = await startTestBridge({ providers: new Map([["pi", piProvider(named, { folder: cwd, settings: { model: "openai/gpt-5" } })]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  try {
    const options = await phone.call("model.options", { profile: "pi" });
    assert.deepEqual([options.model, options.provider], ["gpt-5", "openai"]);
    // Its provider is listed first; Pi's own default stays on the list.
    assert.deepEqual(options.providers.map((entry: Frame) => entry.slug), ["openai", "plan"]);
    assert.equal((await phone.call("profiles.list", {})).profiles.find((profile: Frame) => profile.name === "pi").model, "gpt-5");

    const created = await phone.call("session.create", { profile: "pi", cwd });
    const session = created.session_id as string;
    assert.deepEqual([created.info.model, created.info.provider], ["gpt-5", "openai"]);
    await turn(session, "hello", phone);
    // Pi came up on its own default and was moved before the message was written.
    assert.deepEqual(named.sentTo(session, "set_model").map(({ id: _id, ...command }) => command), [{ type: "set_model", provider: "openai", modelId: "gpt-5" }]);
    const sent = named.sentTo(session).map((record) => record.type);
    assert.ok(sent.indexOf("set_model") < sent.indexOf("prompt"));
    // Another model chosen in the app is the thread's from then on.
    await phone.call("config.set", { session_id: session, key: "model", value: "mimo-v2 --provider plan --session" });
    assert.deepEqual((await phone.call("session.resume", { session_id: session })).info.provider, "plan");
  } finally {
    await phone.close();
    await own.dispose();
    await until(() => named.alive().length === 0);
    named.dispose();
  }

  const unlisted = standin();
  const other = await startTestBridge({ providers: new Map([["pi", piProvider(unlisted, { folder: cwd, settings: { model: "openai/no-such-model" } })]]), config: { generalFolder: cwd } });
  const second = await TestClient.open(other);
  try {
    const options = await second.call("model.options", { profile: "pi" });
    assert.deepEqual([options.model, options.provider], ["gpt-6-luna", "openai"]);
  } finally {
    await second.close();
    await other.dispose();
    await until(() => unlisted.alive().length === 0);
    unlisted.dispose();
  }

  // A named model that does not have the level Pi's own is on: the default level is the one it takes.
  const plain = standin({ level: "medium" });
  const third = await startTestBridge({ providers: new Map([["pi", piProvider(plain, { folder: cwd, settings: { model: "openai/gpt-4.1-nano" } })]]), config: { generalFolder: cwd } });
  const last = await TestClient.open(third);
  try {
    const options = await last.call("model.options", { profile: "pi" });
    assert.deepEqual([options.model, options.model_levels["gpt-4.1-nano"]], ["gpt-4.1-nano", ["none"]]);
    assert.deepEqual(await last.call("config.get", { key: "reasoning", profile: "pi" }), { value: "none" });
    assert.equal((await last.call("session.create", { profile: "pi", cwd })).info.reasoning_effort, "none");
  } finally {
    await last.close();
    await third.dispose();
    await until(() => plain.alive().length === 0);
    plain.dispose();
  }
});

test("a short-lived Pi that cannot start: the models fail with its sentence, /compact is the only command, and the next call asks again", async () => {
  const broken = standin();
  broken.breakCatalog(true);
  const own = await startTestBridge({ providers: new Map([["pi", piProvider(broken, { folder: cwd })]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  try {
    const sentence = 'Pi did not say which models it has: Pi stopped (exit code 1): Error: Failed to load extension "broken.ts": it threw as it loaded';
    await assert.rejects(phone.call("model.options", { profile: "pi" }), (error: RpcFailure) => error.message === sentence);
    const catalog = await phone.call("commands.catalog", { profile: "pi" });
    assert.deepEqual(catalog.pairs.map((pair: string[]) => pair[0]), ["/status", "/compact"]);
    await assert.rejects(phone.call("session.create", { profile: "pi", cwd }), (error: RpcFailure) => error.message === sentence);
    // Nothing of the failure is kept.
    broken.breakCatalog(false);
    // No program at pi.path at all (uninstalled, or the Node it was installed under is gone): the sentence says where, and which setting.
    broken.install(false);
    const missing = `Pi did not say which models it has: Pi could not be started at ${broken.path} (spawn ${broken.path} ENOENT). Check pi.path in config.json.`;
    await assert.rejects(phone.call("model.options", { profile: "pi" }), (error: RpcFailure) => error.message === missing);
    await assert.rejects(phone.call("session.create", { profile: "pi", cwd }), (error: RpcFailure) => error.message === missing);
    // Asked with nothing in between, the call fails before the process's end is told: the sentence is the same.
    const asked = piProvider(broken, { folder: cwd });
    await assert.rejects(asked.models(), (error: Error) => error.message === missing);
    await asked.close();
    broken.install(true);
    assert.equal((await phone.call("model.options", { profile: "pi" })).model, "gpt-6-luna");
    assert.equal((await phone.call("commands.catalog", { profile: "pi" })).pairs.length, 14);
  } finally {
    await phone.close();
    await own.dispose();
    await until(() => broken.alive().length === 0);
    broken.dispose();
  }
});

test("the models and the commands are asked for again once the answer is ten minutes old, behind the call; after an asking that failed the old answer serves another minute", async () => {
  const own = standin();
  let clock = 1_000_000;
  const timed = piProvider(own, { folder: cwd, now: () => clock });
  const asked = () => own.starts().filter((line) => line.args?.includes("--no-session")).length;
  try {
    assert.equal((await timed.models()).model, "gpt-6-luna");
    await timed.models();
    assert.equal((await timed.commands()).length, 13);
    assert.equal(asked(), 1);

    // Ten minutes old: what is known is answered at once, and Pi is asked again behind it.
    clock += 10 * 60_000 + 1;
    assert.equal((await timed.models()).model, "gpt-6-luna");
    await until(() => asked() === 2);
    await until(() => own.alive().length === 0);
    await timed.models();
    assert.equal(asked(), 2);

    // Old again, and Pi cannot start now: the answer in hand serves, and Pi is not started at every call.
    clock += 10 * 60_000 + 1;
    own.breakCatalog(true);
    assert.equal((await timed.models()).model, "gpt-6-luna");
    await until(() => asked() === 3);
    await until(() => own.alive().length === 0);
    for (let call = 0; call < 5; call += 1) assert.equal((await timed.commands()).length, 13);
    assert.equal(asked(), 3);
    // A minute after that failure it is tried once more, each minute, until it answers.
    clock += 60_000 + 1;
    await until(() => (void timed.commands(), asked() === 4));
    await until(() => own.alive().length === 0);
    own.breakCatalog(false);
    clock += 60_000 + 1;
    await until(() => (void timed.commands(), asked() === 5));
    await until(() => own.alive().length === 0);
    assert.equal((await timed.models()).model, "gpt-6-luna");
    assert.equal(asked(), 5);
  } finally {
    await timed.close();
    await until(() => own.alive().length === 0);
    own.dispose();
  }
});

// MARK: Cooling, resuming and the bridge's restart

test("an idle thread's process is stopped, and the next message starts one on the same session, which has the earlier turns", async () => {
  const session = await createThread();
  await turn(session, "play resume");
  const start = await send(session, "hold cool-1");
  await event(session, start, "message.delta");
  // A busy one is never cooled.
  provider.pool.sweep(Date.now() + 16 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pi.alive().length, 1);
  pi.release("cool-1");
  await completed(session, start);
  provider.pool.sweep(Date.now() + 30 * 60_000);
  assert.equal(pi.alive().length, 1);
  provider.pool.sweep(Date.now() + 32 * 60_000);
  await until(() => pi.alive().length === 0);
  assert.equal(provider.pool.size, 0);

  // The recorded second half: the process started again on the same id, and Pi knows the word.
  const again = await turn(session, "play resume 2");
  assert.equal(again.at(-1).payload.text, "kiwi");
  const processes = pi.starts(session);
  assert.equal(processes.length, 2);
  assert.deepEqual(processes[1].args, ["--mode", "rpc", "--session-id", session]);
  // One file for the session, with every turn in it; and the name is not given again: Pi kept it.
  const files = pi.sessionFiles(session);
  assert.equal(files.length, 1);
  const users = readFileSync(files[0], "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)).filter((entry) => entry.message?.role === "user");
  assert.deepEqual(users.map((entry) => entry.message.content[0].text), ["play resume", "hold cool-1", "play resume 2"]);
  assert.equal(pi.sentTo(session, "set_session_name").length, 1);
  assert.deepEqual(notices(again), []);
});

test("at most maxWarm processes: the least recently used idle one is stopped first", async () => {
  const small = piProvider(pi, { folder: cwd, settings: { maxWarm: 1 } });
  const own = await startTestBridge({ providers: new Map([["pi", small]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  try {
    const first = await createThread({}, phone);
    const second = await createThread({}, phone);
    await turn(first, "one", phone);
    assert.equal(pi.alive().length, 1);
    await turn(second, "two", phone);
    await until(() => pi.alive().length === 1);
    assert.equal(small.pool.size, 1);
    assert.deepEqual([pi.starts(first).length, pi.starts(second).length], [1, 1]);
    // The first one starts again, and the second goes cold.
    assert.equal(streamedText(await turn(first, "one again", phone)), "Working. You said: one again");
    await until(() => pi.alive().length === 1);
    assert.deepEqual([pi.starts(first).length, pi.starts(second).length], [2, 1]);
  } finally {
    await phone.close();
    await own.dispose();
  }
  // Closing the bridge left none.
  await until(() => pi.alive().length === 0);
});

test("after a restart of the bridge a thread's history is read from Pi's session file, rows and all, and the next message goes on in it", async () => {
  const first = await startTestBridge({ keepHome: true, providers: new Map([["pi", piProvider(pi, { folder: cwd })]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(first);
  const session = await createThread({}, phone);
  await turn(session, "play tools", phone);
  // A turn stopped while a command ran, which Pi stores as an empty answer with an error.
  const stopped = await createThread({}, phone);
  const start = await send(stopped, "play stop-tool", phone);
  await event(stopped, start, "tool.start", phone);
  await phone.call("session.interrupt", { session_id: stopped });
  assert.equal((await completed(stopped, start, phone)).payload.status, "interrupted");
  // A message taken into a run, which Pi stores where it delivered it, with the time it was sent.
  const steered = await createThread({}, phone);
  const run = await send(steered, "play steer", phone);
  await event(steered, run, "tool.start", phone);
  assert.equal(await submit(steered, "Also add the word banana to your reply.", phone), "steered");
  await completed(steered, run, phone);
  await phone.close();
  // A bridge that stops takes its Pi processes with it.
  await first.dispose();
  await until(() => pi.alive().length === 0);

  const second = await startTestBridge({ home: first.home, providers: new Map([["pi", piProvider(pi, { folder: cwd })]]) });
  const again = await TestClient.open(second);
  try {
    assert.deepEqual(await stored(session, again), [
      ["user", "play tools", ""],
      ["read_file", "", ""],
      ["terminal", "", ""],
      ["patch", "", ""],
      ["terminal", "", ""],
      ["write_file", "", ""],
      ["assistant", "Completed the five steps in order; `ls no-such-file.txt` failed as expected.", ""],
    ]);
    const resumed = await again.call("session.resume", { session_id: session });
    assert.equal(resumed.info.title, "play tools");
    const patch = resumed.messages.find((message: Frame) => message.name === "patch");
    assert.deepEqual(JSON.parse(patch.content), { success: true, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1,1 +1,1 @@\n-hi\n+hello\n" });
    assert.deepEqual(JSON.parse(resumed.messages.filter((message: Frame) => message.name === "terminal")[1].content), { output: "ls: no-such-file.txt: No such file or directory\n", exit_code: 1 });
    // Read from the file: no process was started for it.
    assert.equal(pi.starts(session).length, 1);
    // The stopped turn reads as stopped, not as failed.
    assert.deepEqual(await stored(stopped, again), [
      ["user", "play stop-tool", ""],
      ["terminal", "", ""],
      ["assistant", "", "interrupted"],
    ]);

    // The message sent while Pi worked reads as one, where Pi delivered it.
    assert.deepEqual(await stored(steered, again), [
      ["user", "play steer", ""],
      ["terminal", "", ""],
      ["user", "Also add the word banana to your reply.", "steer"],
      ["assistant", "done", ""],
    ]);

    // The next message starts Pi on the same session, which has the turn from before.
    const next = await turn(session, "play resume 2", again);
    assert.equal(next.at(-1).payload.text, "kiwi");
    assert.equal(pi.starts(session).length, 2);
    assert.deepEqual(notices(next), []);
    assert.equal(pi.sessionFiles(session).length, 1);
  } finally {
    await again.close();
    await second.dispose();
    await until(() => pi.alive().length === 0);
  }
});

test("a bridge closed in the middle of a Pi turn stops the turn as Stop does and takes Pi with it; after its restart the thread is at rest, the turn shown stopped with what Pi had said, and goes on", async () => {
  const first = await startTestBridge({ keepHome: true, providers: new Map([["pi", piProvider(pi, { folder: cwd })]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(first);
  const session = await createThread({}, phone);
  const start = await send(session, "hold never-9 the cut one", phone);
  await event(session, start, "message.delta", phone);
  await phone.close();
  await first.dispose();
  await until(() => pi.alive().length === 0);

  const second = await startTestBridge({ home: first.home, providers: new Map([["pi", piProvider(pi, { folder: cwd })]]) });
  const again = await TestClient.open(second);
  try {
    // Nothing to follow: the turn was cut, and the thread is at rest.
    assert.equal((await again.call("session.resume", { session_id: session })).running, false);
    assert.deepEqual((await again.call("sessions.activity")).sessions, []);
    // Stopped before its process was, Pi stored the reply it was writing as stopped; killed
    // without, it stored only the message, and nothing showed the turn had been cut.
    assert.deepEqual(await stored(session, again), [
      ["user", "hold never-9 the cut one", ""],
      ["assistant", "Working.", "interrupted"],
    ]);
    const next = await turn(session, "and now?", again);
    assert.equal(streamedText(next), "Working. You said: and now?");
    assert.deepEqual(notices(next), []);
    // A new process, on the same session.
    assert.deepEqual(pi.starts(session).map((line) => line.args), [["--mode", "rpc", "--session-id", session], ["--mode", "rpc", "--session-id", session]]);
    assert.equal(pi.sessionFiles(session).length, 1);
  } finally {
    await again.close();
    await second.dispose();
    await until(() => pi.alive().length === 0);
  }
});

// MARK: The process's end

test("Pi dying mid-turn ends the turn once with what it was doing closed, and the next message starts it again", async () => {
  const session = await createThread();
  const start = await send(session, "die");
  const done = await completed(session, start);
  const events = turnEvents(session, start);
  // A new session's process always prints a warning as it starts: that is not why it died.
  const sentence = "Pi stopped unexpectedly (exit code 1). A command it was running may still be running.";
  assert.deepEqual(unspent(done.payload), { status: "error", text: sentence, error_surface: { retryable: true } });
  assert.deepEqual(kinds(events), ["message.start", "session.title", "message.delta", "message.interim", "tool.start", "tool.complete", "error", "message.complete"]);
  assert.deepEqual(events.find((entry) => entry.type === "tool.complete").payload.result, { status: "error", error: "Stopped before it finished." });
  assert.deepEqual(events.find((entry) => entry.type === "error").payload, { message: sentence });
  await until(() => pi.alive().length === 0);
  assert.equal(provider.pool.size, 0);

  // With its last words when it has any.
  const loud = await turn(session, "die loudly");
  assert.equal(loud.at(-1).payload.text, "Pi stopped unexpectedly (exit code 1): Error: the stand-in was told to die. A command it was running may still be running.");
  const next = await turn(session, "are you back?");
  assert.equal(streamedText(next), "Working. You said: are you back?");
  assert.equal(pi.starts(session).length, 3);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(turnEvents(session, start).filter((entry) => entry.type === "message.complete").length, 3);
});

test("a pi that cannot be started fails the turn with a sentence that names pi.path; one that exits between turns is only cold", async () => {
  const session = await createThread();
  // Uninstalled since the bridge asked it for its models.
  pi.install(false);
  const failed = await turn(session, "hello");
  assert.deepEqual([failed.at(-1).payload.status, failed.at(-1).payload.text], ["error", `Pi could not be started at ${pi.path} (spawn ${pi.path} ENOENT). Check pi.path in config.json.`]);
  assert.equal(failed.some((entry) => entry.type === "error"), false);
  pi.install(true);
  assert.equal(streamedText(await turn(session, "hello again")), "Working. You said: hello again");

  // An extension asks Pi to shut down: it exits with code 0, and nothing is said of it.
  const start = await send(session, "/quit");
  assert.equal((await completed(session, start)).payload.status, "complete");
  await until(() => pi.alive().length === 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(kinds(turnEvents(session, start)), ["message.start", "message.complete"]);
  assert.equal(provider.pool.size, 0);
  assert.equal(streamedText(await turn(session, "and again")), "Working. You said: and again");
  assert.equal(pi.starts(session).length, 2);
});

test("a thread whose folder is gone fails its turn the same way, and the sentence says it was the folder", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "portals-pi-gone-")));
  const own = await startTestBridge({ providers: new Map([["pi", piProvider(pi, { folder })]]), config: { generalFolder: folder } });
  const phone = await TestClient.open(own);
  try {
    const session = await createThread({ cwd: folder }, phone);
    rmSync(folder, { recursive: true });
    const gone = await turn(session, "hello", phone);
    assert.deepEqual([gone.at(-1).payload.status, gone.at(-1).payload.text], ["error", `Pi could not be started at ${pi.path} (spawn ${pi.path} ENOENT). The thread's folder, ${folder}, is no longer there.`]);
  } finally {
    await phone.close();
    await own.dispose();
  }
});

test("a thread whose session Pi no longer has is told so, and goes on from there", async () => {
  const session = await createThread();
  await turn(session, "remember kiwi");
  provider.pool.sweep(Date.now() + 16 * 60_000);
  await until(() => pi.alive().length === 0);
  // Deleted at the desk.
  for (const file of pi.sessionFiles(session)) rmSync(file);
  const next = await turn(session, "which word?");
  assert.deepEqual(notices(next), ["Pi no longer has this thread's earlier conversation (its session file is gone), so it starts again from here."]);
  assert.equal(next.at(-1).payload.status, "complete");
  // Said once.
  assert.deepEqual(notices(await turn(session, "and now?")), []);
});

test("the ring follows what Pi says of the context, and says nothing while Pi does not know", async () => {
  const session = await createThread();
  await turn(session, "one");
  await ring(session, 1200);
  await turn(session, "two");
  await ring(session, 1400);
  const compacting = await send(session, "/compact");
  await completed(session, compacting);
  // Pi's estimate of what is left.
  assert.deepEqual(turnEvents(session, compacting).filter((entry) => entry.type === "session.usage").map((entry) => entry.payload.usage.context_used), [560]);
  provider.pool.sweep(Date.now() + 16 * 60_000);
  await until(() => pi.alive().length === 0);

  // Started again right after a compaction, Pi answers null until its next reply.
  const held = await send(session, "hold ring-1");
  await event(session, held, "message.delta");
  await until(() => pi.sentTo(session, "get_session_stats").length >= 4);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(turnEvents(session, held).filter((entry) => entry.type === "session.usage"), []);
  pi.release("ring-1");
  const done = await completed(session, held);
  const said = await event(session, held, "session.usage");
  assert.equal(said.payload.usage.context_max, 272_000);
  assert.ok(said.payload.usage.context_used > 560);
  assert.equal(done.payload.status, "complete");
});

// MARK: Offered by the bridge

test("Pi is built from config.json when it turns Pi on, after Codex and before the scripted agent and Hermes", () => {
  const paths = pathsFor(join(cwd, "no-bridge-here"));
  // Cursor and Hermes are off, so that this Mac's own do not count. (Where Cursor comes is in config.test.ts.)
  const all = parseConfig({ providers: { claude: true, codex: true, pi: true, cursor: false, droid: false, hermes: false, fake: true }, aeri: { enabled: true }, pi: { path: pi.path } });
  // Built, and none of them started; an `aeri` section left from a bridge that ran Aeri starts nothing.
  assert.deepEqual([...makeProviders(all, paths).keys()], ["claude", "codex", "pi", "fake"]);
  // A config.json that says nothing of Pi does not offer it.
  assert.deepEqual([...makeProviders(parseConfig({ providers: { claude: false, codex: false, cursor: false, droid: false, hermes: false, fake: true } }), paths).keys()], ["fake"]);
});

test("a bridge with providers.pi on runs the pi at pi.path, and gives its threads the portals command, which thread they are and a few lines about it", async (t) => {
  // The bridge's own environment is Pi's: the stand-in keeps its sessions where this says.
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = pi.agentDir;
  const ownLines = join(pi.agentDir, "APPEND_SYSTEM.md");
  t.after(() => {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
    rmSync(ownLines, { force: true });
  });
  const offering = (more: Record<string, unknown> = {}) =>
    startTestBridge({ config: { generalFolder: cwd, providers: { claude: false, codex: false, pi: true, cursor: false, hermes: false, fake: true }, pi: { path: pi.path, idleMinutes: 15, maxWarm: 6 }, ...more } });

  const own = await offering();
  const phone = await TestClient.open(own);
  try {
    assert.deepEqual((await phone.call("profiles.list")).profiles.map((profile: Frame) => profile.name), ["pi", "fake"]);
    const session = await createThread({}, phone);
    assert.equal(streamedText(await turn(session, "hello", phone)), "Working. You said: hello");
    const [started] = pi.starts(session);
    const portals = pathsFor(own.home);
    // The `portals` folder first, so the command is this bridge's; then Pi's own, for the `node` that runs it.
    assert.deepEqual(started.env!.PATH!.split(":").slice(0, 2), [portals.bin, dirname(pi.path)]);
    assert.equal(started.env!.PORTALS_THREAD, session);
    const lines = `${agentInstructions(portals.command)}\n\n${mathInstructions}\n\n${visualInstructions(portals.command)}`;
    assert.deepEqual(started.args, ["--mode", "rpc", "--session-id", session, "--append-system-prompt", lines]);
    // The Pi asked for the models and the commands has no session, and is told nothing.
    // The one that asked for the models; not the one that named the thread (`--print`).
    const asked = pi.starts().filter((line) => line.args?.includes("--no-session") && !line.args.includes("--print") && line.env?.PATH?.startsWith(`${portals.bin}:`));
    assert.deepEqual(asked.map((line) => line.args), [["--mode", "rpc", "--no-session", "--offline"]]);
    await phone.call("thread.delete", { thread: session });

    // Pi takes the flag in place of the lines it would append by itself, so the user's own file is named before the bridge's.
    writeFileSync(ownLines, "Answer in Dutch.\n");
    const second = await createThread({}, phone);
    await turn(second, "hello", phone);
    assert.deepEqual(pi.starts(second)[0].args, ["--mode", "rpc", "--session-id", second, "--append-system-prompt", ownLines, "--append-system-prompt", lines]);
    await phone.call("thread.delete", { thread: second });
  } finally {
    await phone.close();
    await own.dispose();
  }

  // With fleet.tellAgents and visuals.tellAgents off only the line on math is appended; the command is still on its PATH.
  const quiet = await offering({ fleet: { tellAgents: false }, visuals: { tellAgents: false } });
  const other = await TestClient.open(quiet);
  try {
    const session = await createThread({}, other);
    await turn(session, "hello", other);
    const [started] = pi.starts(session);
    // The user's own file is still there from above, so it is named first.
    assert.deepEqual(started.args, ["--mode", "rpc", "--session-id", session, "--append-system-prompt", ownLines, "--append-system-prompt", mathInstructions]);
    assert.equal(started.env!.PATH!.split(":")[0], pathsFor(quiet.home).bin);
    assert.equal(started.env!.PORTALS_THREAD, session);
    await other.call("thread.delete", { thread: session });
  } finally {
    await other.close();
    await quiet.dispose();
  }
});

// MARK: The installed version

/** What a provider logs of the installed Pi when it starts, without the time each line begins with. */
async function versionLines(t: TestContext): Promise<string[]> {
  const written = t.mock.method(process.stderr, "write", () => true);
  // The check's own lines: what the short-lived Pi said of its models is logged too.
  const lines = () =>
    written.mock.calls
      .map((call) => String(call.arguments[0]).trimEnd().split(" ").slice(1).join(" "))
      .filter((line) => /^(error|warn |info ) Pi (is |was |\d)/.test(line));
  setLogLevel("info");
  const checking = piProvider(pi, { folder: cwd, checkVersion: true });
  try {
    checking.start();
    await until(() => lines().length > 0);
  } finally {
    setLogLevel("silent");
    await checking.close();
    written.mock.restore();
  }
  return lines();
}

test("at start the bridge logs which Pi is installed: an error for none or one too old, a warning for another release, a line for the tested one", async (t) => {
  assert.deepEqual(await versionLines(t), ["info  Pi 1.1.0"]);
  pi.version("1.2.0");
  assert.deepEqual(await versionLines(t), ["warn  Pi is 1.2.0; this bridge was tested with 1.1.0. Check a thread before relying on it."]);
  pi.version("0.99.2");
  assert.deepEqual(await versionLines(t), ["error Pi is 0.99.2, which is too old for this bridge: it needs 1.1.0 or newer. No Pi thread runs until it is updated (pi update)."]);
  pi.install(false);
  assert.deepEqual(await versionLines(t), [`error Pi was not found or did not run at ${pi.path}. Set pi.path in config.json.`]);
});

test("a turn on a Pi older than the tested release fails at once with a sentence naming the release it needs, and runs once Pi is updated", async () => {
  pi.version("0.99.2");
  const own = await startTestBridge({ providers: new Map([["pi", piProvider(pi, { folder: cwd, checkVersion: true })]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  try {
    const session = await createThread({}, phone);
    const refused = await turn(session, "hello", phone);
    assert.deepEqual(
      [refused.at(-1).payload.status, refused.at(-1).payload.text],
      ["error", `Pi 0.99.2 is too old for the bridge, which needs 1.1.0 or newer. Update it on the ${machineWord()} (pi update), then send the message again.`],
    );
    // No process was started for the thread: a turn on such a Pi might never end.
    assert.deepEqual(pi.starts(session), []);
    assert.deepEqual(await turn(session, "/compact", phone).then((events) => events.at(-1).payload.status), "error");
    assert.deepEqual(pi.starts(session), []);

    // Updated at the desk: the next message finds that out by itself.
    pi.version("1.1.1");
    assert.equal(streamedText(await turn(session, "hello again", phone)), "Working. You said: hello again");
    assert.equal(pi.starts(session).length, 1);
    await phone.call("thread.delete", { thread: session });
  } finally {
    await phone.close();
    await own.dispose();
  }
});

test("a thread removed while Pi's version is still being checked starts no process", async () => {
  const checking = piProvider(pi, { folder: cwd, checkVersion: true });
  const events: string[] = [];
  try {
    checking.start();
    const session = await checking.startSession({ id: "closed-early", cwd, settings: { model: "", provider: "", reasoningEffort: "" } }, { emit: (event) => events.push(event.type), ask: () => new Promise(() => undefined) });
    session.startTurn({ text: "hello", images: [] });
    await session.close?.();
    await checking.refusal();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(pi.starts("closed-early"), []);
  } finally {
    await checking.close();
  }
});

// MARK: Removing and closing

test("a thread at work is not removed; removing one at rest stops its process, and closing the bridge leaves none", async () => {
  const own = await startTestBridge({ providers: new Map([["pi", piProvider(pi, { folder: cwd })]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(own);
  try {
    const session = await createThread({}, phone);
    const start = await send(session, "hold remove-1", phone);
    await event(session, start, "message.delta", phone);
    await assert.rejects(phone.call("thread.delete", { thread: session }), (error: RpcFailure) => error.message === "Pi is still working in this thread. Stop it, then remove it.");
    pi.release("remove-1");
    await completed(session, start, phone);
    assert.equal(pi.alive().length, 1);
    assert.deepEqual(await phone.call("thread.delete", { thread: session }), {});
    await until(() => pi.alive().length === 0);
    // Pi's session file stays: the thread can be taken up at the desk.
    assert.equal(pi.sessionFiles(session).length, 1);

    // One at rest and one in the middle of a turn, when the bridge closes.
    const idle = await createThread({}, phone);
    await turn(idle, "hello", phone);
    const busy = await createThread({}, phone);
    const running = await send(busy, "hold never-4", phone);
    await event(busy, running, "message.delta", phone);
    assert.equal(pi.alive().length, 2);
  } finally {
    await phone.close();
    await own.dispose();
  }
  assert.deepEqual(pi.alive(), []);
});
