import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setLogLevel } from "../src/log.ts";
import { machineWord } from "../src/platform.ts";
import type { CommandAccess } from "../src/portals/access.ts";
import { levelLeftToCursorText, notSignedInText, noSuchModeText, testedCursorVersion } from "../src/providers/cursor/options.ts";
import { ProcessNotes } from "../src/providers/cursor/leftovers.ts";
import { CursorProvider } from "../src/providers/cursor/provider.ts";
import { providerModeOptions } from "../src/providers/modes.ts";
import { commandLeftText } from "../src/providers/cursor/tools.ts";
import type { ProviderEvent, ProviderSession, RequestAnswer, SessionSettings, SessionSink } from "../src/providers/types.ts";
import { isEvent, RpcFailure, runTurn, startTestBridge, streamedText, temporaryHome, TestClient, type Frame, type TestBridge } from "./helpers.ts";
import { standin as piStandin } from "./pi-standin.ts";

// The Cursor provider through the whole bridge, as the app sees it, against a stand-in
// for `cursor-agent acp` (test/acp-agent.ts with the feature `cursor`), started the way
// the real one is: the process, the protocol, the sessions, turns, cards and rows are
// the real code. No test starts the real Cursor.
//
// The stand-in does what Cursor 2026.10.01 was recorded doing (test/fixtures/cursor).
// Four things were never recorded, and are tested here against the stand-in alone, in
// the shape Cursor's own code gives them: `cursor/ask_question` (no model ever sent
// one), a permission request for a command or an edit (those settings ask for neither), a
// permission allowed (it would have run a real web search), and the reply "Please sign
// in to continue".

const agentScript = fileURLToPath(new URL("./acp-agent.ts", import.meta.url));

/** A folder for the stand-in's own sessions, settings and its notes of what it got. */
function agentFolder(): string {
  return mkdtempSync(join(tmpdir(), "portals-cursor-agent-"));
}

function folder(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "portals-cursor-test-")));
}

interface Call {
  pid: number;
  cwd: string;
  method: string;
  params: any;
}

function lines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

/** Every call and notification the stand-in got, in order. */
function calls(agentDir: string): Call[] {
  return lines(join(agentDir, "calls.jsonl"));
}

/** The answers the stand-in got to its own requests, in order. */
function answers(agentDir: string): { method: string; toolCallId?: string; result?: any; error?: any }[] {
  return lines(join(agentDir, "answers.jsonl"));
}

/** When the stand-in got each call and when it answered it. */
function timeline(agentDir: string): { pid: number; event: "got" | "answered"; method: string; session?: string }[] {
  return lines(join(agentDir, "timeline.jsonl"));
}

function methods(list: Call[]): string[] {
  return list.map((call) => call.method);
}

interface StandinOptions {
  agentDir: string;
  stateDir: string;
  features?: string[];
  idleMs?: number;
  interruptGraceMs?: number;
  /** The `portals` command, as the bridge gives it to Cursor. */
  portals?: CommandAccess;
  /** Where Cursor keeps its sessions and chats, for the folders it worked in; none when absent. */
  cursorHome?: string | null;
  /** The bridge's temporary folders, never offered ([]: the test's own are). */
  temporaryFolders?: string[];
}

/** What the stand-in is started with. */
function standinEnv(options: StandinOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ACP_STANDIN_DIR: options.agentDir,
    ACP_STANDIN_FEATURES: ["cursor", ...(options.features ?? [])].join(","),
    ...(options.cursorHome ? { ACP_STANDIN_SESSIONS: join(options.cursorHome, "acp-sessions") } : {}),
  };
}

function cursor(options: StandinOptions): CursorProvider {
  return new CursorProvider({
    command: process.execPath,
    args: [agentScript],
    forceArgs: [agentScript, "--force"],
    env: standinEnv(options),
    directory: options.stateDir,
    idleMs: options.idleMs ?? 60_000,
    interruptGraceMs: options.interruptGraceMs,
    portals: options.portals,
    // The program here is node, whose version is not Cursor's.
    checkVersion: false,
    // Not the folders of this Mac's own Cursor.
    cursorHome: options.cursorHome ?? null,
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until `check` holds. */
async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await sleep(10);
  }
}

let agentDir: string;
/** Where the bridge keeps what Cursor said of itself, and its threads. */
let stateDir: string;
let cwd: string;
let provider: CursorProvider;
let bridge: TestBridge;
let client: TestClient;

before(async () => {
  agentDir = agentFolder();
  stateDir = temporaryHome();
  cwd = folder();
  provider = cursor({ agentDir, stateDir });
  // The thread folder is General: a temporary folder is never on the list of others.
  bridge = await startTestBridge({ providers: new Map([["cursor", provider]]), config: { generalFolder: cwd } });
  client = await TestClient.open(bridge);
});

after(async () => {
  await client.close();
  await bridge.dispose();
  for (const path of [agentDir, stateDir, cwd]) rmSync(path, { recursive: true, force: true });
});

async function createThread(params: Record<string, unknown> = {}, on = client): Promise<string> {
  return (await on.call("session.create", { profile: "cursor", source: "tui", ...params })).session_id;
}

function ofType(events: Frame[], type: string): Frame[] {
  return events.filter((event) => event.type === type);
}

function tools(events: Frame[]): Frame[] {
  return events.filter((event) => event.type.startsWith("tool.")).map((event) => ({ type: event.type, ...event.payload }));
}

/** The first event of `type` for `session` among the frames `on` got from `mark` on. */
function eventFrom(on: TestClient, mark: number, type: string, session: string): Promise<Frame> {
  return on.from(mark, (frame) => isEvent(frame, type, session)).then((frame) => frame.params);
}

/** What kept notices a run of events holds. */
function notices(events: Frame[]): string[] {
  return ofType(events, "status.update").map((event) => event.payload.text);
}

/** A bridge of its own, for a test that restarts it or needs another kind of stand-in. */
interface Rig {
  agentDir: string;
  stateDir: string;
  home: string;
  provider: CursorProvider;
  bridge: TestBridge;
  phone: TestClient;
  /** Stops the bridge and starts it again in the same folders, as a restart does; `meanwhile` runs with it stopped. */
  restart(meanwhile?: () => void): Promise<void>;
}

async function rig(t: { after(fn: () => Promise<void>): void }, options: Partial<StandinOptions> = {}): Promise<Rig> {
  const folders = { agentDir: options.agentDir ?? agentFolder(), stateDir: options.stateDir ?? temporaryHome() };
  const make = () => cursor({ ...options, ...folders });
  let made = make();
  let running = await startTestBridge({ keepHome: true, providers: new Map([["cursor", made]]), config: { generalFolder: cwd }, temporaryFolders: options.temporaryFolders });
  const home = running.home;
  const state: Rig = {
    ...folders,
    home,
    provider: made,
    bridge: running,
    phone: await TestClient.open(running),
    async restart(meanwhile) {
      await state.phone.close();
      await state.bridge.dispose();
      meanwhile?.();
      made = make();
      running = await startTestBridge({ home, keepHome: true, providers: new Map([["cursor", made]]) });
      state.provider = made;
      state.bridge = running;
      state.phone = await TestClient.open(running);
    },
  };
  t.after(async () => {
    await state.phone.close();
    await state.bridge.dispose();
    for (const path of [home, folders.agentDir, folders.stateDir]) rmSync(path, { recursive: true, force: true });
  });
  return state;
}

const models = ["default", "auto", "small", "large", "deep", "flat"];
const names = { default: "Cursor's own", auto: "Auto", small: "Small", large: "Large", deep: "Deep", flat: "Flat" };

// MARK: Listing

/** Cursor's modes, as the app is offered them (`mode_options`). */
const offered = [
  { id: "ask", label: "Ask", description: "Reads and answers: Cursor is told to edit no files and run no commands." },
  { id: "plan", label: "Plan", description: "Plans first, reading only, and waits for your go-ahead before carrying the plan out." },
  { id: "default", label: "Agent", description: "Cursor's agent mode: it asks before acting as your Cursor settings say (Allowlist, Auto-review or Run Everything)." },
  { id: "full", label: "Full access", description: "Cursor's agent mode with Run Everything: it edits, runs commands and searches the web without asking, unless your team does not allow it." },
];

test("Cursor is listed without being started; once a thread has run its models, their levels, its modes and its commands are known", async () => {
  const listed = await client.call("profiles.list");
  assert.deepEqual(listed.profiles, [
    { name: "cursor", kind: "cursor", display_name: "Cursor", description: `Cursor on this ${machineWord()}, with your own settings and sign-in.`, model: "default", provider: "cursor", is_default: true, adopt_modes: ["continue", "fork", "read"], mode_options: offered },
  ]);
  const early = await client.call("model.options", { profile: "cursor" });
  assert.deepEqual(early.providers, [{ slug: "cursor", name: "Cursor", models: ["default"], authenticated: true }]);
  assert.equal(early.model, "default");
  assert.deepEqual(early.model_names, { default: "Cursor's own" });
  assert.deepEqual(early.model_levels, { default: [] });
  // It has modes, and what `default` comes to is none of the app's four.
  assert.deepEqual(early.modes, {});
  assert.deepEqual((await client.call("commands.catalog", { profile: "cursor" })).pairs.map((pair: string[]) => pair[0]), ["/status", "/mode", "/usage"]);
  // Nothing so far started it.
  assert.deepEqual(calls(agentDir), []);

  const session = await createThread();
  assert.match(session, /^standin-/);
  // The model list is part of starting a process: no session call comes before it.
  assert.deepEqual(methods(calls(agentDir)), ["initialize", "cursor/list_available_models", "session/new"]);
  assert.equal(calls(agentDir)[0].cwd, cwd);
  assert.deepEqual(calls(agentDir)[0].params.clientCapabilities, { _meta: { parameterizedModelPicker: true, subagents: {} } });
  assert.deepEqual(calls(agentDir)[2].params, { cwd, mcpServers: [] });

  const options = await client.call("model.options", { profile: "cursor" });
  // Every model by Cursor's id, and its own "Auto", whose id is `default`, as `auto`.
  assert.deepEqual(options.providers, [{ slug: "cursor", name: "Cursor", models, authenticated: true }]);
  assert.deepEqual(options.model_names, names);
  // A model's level option is the one whose values are levels, not `thinking`, on or off;
  // `extra-high` is the app's xhigh; a model with none, and `default`, take none.
  assert.deepEqual(options.model_levels, {
    default: [],
    auto: [],
    small: ["low", "medium", "high"],
    large: ["low", "medium", "high", "xhigh", "max"],
    deep: ["none", "low", "medium", "high", "xhigh"],
    flat: [],
  });
  assert.equal(options.model_default_levels, undefined);
  assert.deepEqual(options.modes, {});

  // Its slash commands came with the session, without the one that writes the clipboard, and go to it as messages.
  await until(async () => (await client.call("commands.catalog", { profile: "cursor" })).pairs.length === 5, "the commands are known");
  const catalog = await client.call("commands.catalog", { profile: "cursor" });
  assert.deepEqual(catalog.pairs.slice(3), [
    ["/review", "Review the changes"],
    ["/explain", "Explain a file (usage: /explain <file>)"],
  ]);
  assert.deepEqual(await client.call("command.dispatch", { name: "review", session_id: session }), { type: "send", message: "/review" });
});

// Cursor has three modes; the app offered all five (its own list, with no mode_options), and
// full access or accept edits picked from it was refused (noSuchModeText).
test("a Cursor thread is offered Cursor's modes alone (its three, and Full access on a Cursor run with --force), and /mode says so", async () => {
  assert.deepEqual((await client.call("model.options", { profile: "cursor" })).mode_options, offered);
  const created = await client.call("session.create", { profile: "cursor", source: "tui" });
  assert.deepEqual(created.info.mode_options, offered);
  const mode = (await client.call("commands.catalog", { profile: "cursor" })).pairs.find((pair: string[]) => pair[0] === "/mode");
  assert.match(mode[1], /\(usage: \/mode \[ask\|plan\|default\|full\]\)$/);
});

test("when Cursor does not list its models, they are read from what a session can be set to", async (t) => {
  const { phone, agentDir: dir } = await rig(t, { features: ["nolist"] });
  const session = await createThread({}, phone);
  assert.deepEqual(methods(calls(dir)), ["initialize", "cursor/list_available_models", "session/new"]);
  const options = await phone.call("model.options", { profile: "cursor" });
  assert.deepEqual(options.providers[0].models, models);
  assert.deepEqual(options.model_names, names);
  // A session says the levels of the model Cursor is on (Auto: none), and of no other: the
  // others' are not known, so they are left out, which the app reads as any level, not none.
  assert.deepEqual(options.model_levels, { default: [], auto: [] });
  await phone.call("config.set", { key: "model", value: "small --provider cursor --session", session_id: session });
  await runTurn(phone, session, "hello");
  assert.deepEqual((await phone.call("model.options", { profile: "cursor" })).model_levels.small, ["low", "medium", "high"]);
});

// MARK: Turns

test("a reply streams between message.start and message.complete, without Cursor's own line after it and with no usage", async () => {
  const session = await createThread();
  const events = await runTurn(client, session, "hello there");
  assert.equal(events[0].type, "message.start");
  const complete = events.at(-1);
  assert.equal(complete.payload.status, "complete");
  // The line Cursor ends a turn with is not in the reply.
  assert.equal(complete.payload.text, "pong: hello there");
  assert.equal(streamedText(events), "pong: hello there");
  assert.equal(ofType(events, "message.delta").length, 2);
  // Cursor reports no token or context use: the turn's footer has the bridge's time alone.
  assert.equal(complete.payload.usage, undefined);
  assert.deepEqual(ofType(events, "session.usage"), []);
  assert.deepEqual(Object.keys(complete.payload.turn_usage), ["seconds"]);
  // An agent that says what a turn spent (ACP's prompt `usage`) has it said too.
  const spending = await runTurn(client, await createThread(), "spend tokens");
  assert.equal(spending.at(-1).payload.turn_usage.tokens, 4321);
  // The first line of the first message is the title, until Cursor names the session.
  assert.deepEqual(ofType(events, "session.title").map((event) => event.payload), [{ title: "hello there" }]);

  const resumed = await client.call("session.resume", { session_id: session });
  assert.deepEqual(
    resumed.messages.map((message: Frame) => [message.role, message.text]),
    [
      ["user", "hello there"],
      ["assistant", "pong: hello there"],
    ],
  );
  assert.equal(resumed.info.model, "default");
  assert.equal(resumed.info.profile_name, "cursor");
  // A thread on `default` leaves the model's level to Cursor.
  assert.equal(resumed.info.reasoning_effort, "");
  assert.equal(resumed.info.mode, "default");
  assert.equal(resumed.info.usage, undefined);
});

test("Cursor's title replaces the bridge's, until the user gives one", async () => {
  const session = await createThread();
  const events = await runTurn(client, session, "title this please");
  assert.deepEqual(
    ofType(events, "session.title").map((event) => event.payload.title),
    ["title this please", "A title from the stand-in"],
  );
  await client.call("session.rename", { session_id: session, title: "Mine" });
  const again = await runTurn(client, session, "title once more");
  assert.deepEqual(ofType(again, "session.title"), []);
});

test("a turn Cursor fails ends with what it said, and the next one runs", async () => {
  const session = await createThread();
  const failed = (await runTurn(client, session, "fail now")).at(-1).payload;
  assert.equal(failed.status, "error");
  assert.equal(failed.text, "Cursor stopped the turn: Internal error (The stand-in failed on purpose.)");
  assert.equal((await runTurn(client, session, "and now?")).at(-1).payload.text, "pong: and now?");
});

// MARK: Tool rows

test("thinking streams as reasoning; a new file told with scraps and a command with its exit code are rows the app styles", async () => {
  const session = await createThread();
  const events = await runTurn(client, session, "think then use a tool");
  assert.equal(streamedText(events, "reasoning.delta"), "Let me think. Done thinking.");
  const path = join(cwd, "notes.txt");
  const rows = tools(events);
  assert.deepEqual(
    rows.map((row) => [row.type, row.name]),
    [
      ["tool.start", "patch"],
      ["tool.complete", "patch"],
      ["tool.start", "terminal"],
      ["tool.complete", "terminal"],
    ],
  );
  // Cursor's tool call ids have a newline in them, and are kept as they are.
  assert.match(rows[0].tool_id, /^edit-\d+-\d+\nfc_\d+$/);
  assert.deepEqual(rows[0].args, { path });
  // Each side starts with a scrap of a diff header: a file made new is an all-added diff.
  assert.deepEqual(rows[1].result, { success: true, diff: "--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+hello\n" });
  assert.deepEqual(rows[2].args, { command: "ls no-such-file.txt" });
  // Never `failed`: a command that did not work says so by its exit code.
  assert.deepEqual(rows[3].result, { output: "ls: no-such-file.txt: No such file or directory\n", exit_code: 1 });
  // Only the text after the last row is the reply.
  assert.equal(events.at(-1).payload.text, "pong: think then use a tool");

  const stored = (await client.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(
    stored.map((message: Frame) => message.role),
    ["user", "assistant", "tool", "tool", "assistant"],
  );
  assert.equal(stored[1].reasoning, "Let me think. Done thinking.");
  assert.equal(stored[1].text, "I'll make notes.txt. ");
  assert.deepEqual(JSON.parse(stored[2].content), rows[1].result);
});

test("a tool that says it did not work ends as an error row, and one rejected or not permitted as a blocked one", async () => {
  const session = await createThread();
  const rows = tools(await runTurn(client, session, "toolerror")).filter((row) => row.type === "tool.complete");
  assert.deepEqual(
    rows.map((row) => [row.name, row.result]),
    [
      // The words are the error, not what a search found.
      ["search_files", { error: "ripgrep is not installed" }],
      // A tool of an MCP server goes by its own name.
      ["add_note", { status: "blocked", error: "Cursor did not allow this.", user_summary: "Cursor did not allow this — it did not run." }],
      ["web_extract", { status: "blocked", error: "Blocked by a rule", user_summary: "Cursor did not allow this — it did not run." }],
    ],
  );
  assert.deepEqual(rows[0].args, { pattern: "needle" });
  assert.equal(rows[1].context, "notes: add_note");
  assert.deepEqual(rows[1].args, { text: "x" });
  assert.deepEqual(rows[2].args, { url: "https://example.com/" });
});

test("the model's own switch of mode is a row; a Task is a delegate row, and one left running leaves a notice", async () => {
  const session = await createThread();
  const switched = tools(await runTurn(client, session, "switch"));
  assert.deepEqual(
    switched.map((row) => [row.type, row.name, row.context]),
    [
      ["tool.start", "switch_mode", "Switch Mode: plan"],
      ["tool.complete", "switch_mode", "Switch Mode: plan"],
    ],
  );
  assert.deepEqual(switched[0].args, { mode: "plan", explanation: "The user asked for a plan." });
  // The tool returned nothing, and the row shows nothing under it.
  assert.deepEqual(switched[1].result, {});
  // Cursor tells nobody of the switch, so the thread's mode stays its own.
  assert.equal((await client.call("session.resume", { session_id: session })).info.mode, "default");

  const before = answers(agentDir).length;
  const events = await runTurn(client, session, "task and picture");
  const rows = tools(events);
  assert.deepEqual(
    rows.map((row) => [row.type, row.name]),
    [
      ["tool.start", "delegate_task"],
      ["tool.complete", "delegate_task"],
      ["tool.start", "image_generate"],
      ["tool.complete", "image_generate"],
    ],
  );
  assert.equal(rows[0].context, "Look around");
  assert.deepEqual(rows[0].args, { task: "List the files.", agent: "explore" });
  assert.deepEqual(rows[2].args, { prompt: "A red square" });
  assert.deepEqual([rows[1].result, rows[3].result], [{}, {}]);
  assert.deepEqual(notices(events), []);
  // What Cursor tells of a subagent and an image beside their rows is answered, and adds nothing.
  assert.deepEqual(
    answers(agentDir).slice(before).map((answer) => [answer.method, answer.result]),
    [
      ["cursor/task", {}],
      ["cursor/generate_image", {}],
    ],
  );

  const background = await runTurn(client, session, "bgtask");
  assert.deepEqual(notices(background), [
    "Cursor left a subagent working in the background, which Portals cannot follow: the thread shows at rest while it works, and it ends when Cursor's process is stopped.",
  ]);
});

// MARK: Full access

test("Full access runs the thread on its folder's Cursor started with --force, which asks nothing; the thread takes its conversation along each way", async (t) => {
  const { phone } = await rig(t);
  const session = await createThread({}, phone);
  const pid = (text: string) => Number(/pid=(\d+)/.exec(text)?.[1]);
  const first = await reply(session, "where forced heard", phone);
  assert.match(first, /forced=false heard=1/);
  // Another thread in the same folder stays on the first process throughout.
  const other = await createThread({}, phone);
  assert.equal(pid(await reply(other, "where", phone)), pid(first));

  assert.deepEqual(await phone.call("slash.exec", { session_id: session, command: "/mode full" }), {
    type: "exec",
    output: "This thread now runs with Cursor's Run Everything: it edits files, runs commands and searches the web without asking, unless your team does not allow it.",
  });
  const forcedReply = await reply(session, "where forced heard", phone);
  assert.match(forcedReply, /forced=true heard=2/);
  assert.notEqual(pid(forcedReply), pid(first));
  // Nothing is asked: Cursor runs the command itself.
  const ran = await runTurn(phone, session, "approve this");
  assert.equal(ran.at(-1).payload.text, "It was allowed. pong: approve this");
  assert.ok(!phone.frames.some((frame: Frame) => frame.method === "approval" && frame.params?.session_id === session));
  assert.equal(pid(await reply(other, "where", phone)), pid(first));

  // Back to Agent: on the first process again, which takes the conversation up afresh, and asks again.
  await phone.call("session.set_mode", { session_id: session, mode: "default" });
  const back = await reply(session, "where forced heard", phone);
  assert.match(back, /forced=false heard=4/);
  assert.equal(pid(back), pid(first));
  await phone.call("prompt.submit", { session_id: session, text: "approve again" });
  const request = await phone.nextRequest();
  assert.equal(request.method, "approval");
  phone.answer(request.id, { choice: "deny" });
  await phone.nextEvent("message.complete", session);
});

test("a thread alone in its folder that moves to Full access stops the Cursor it left", async (t) => {
  const { phone } = await rig(t);
  const session = await createThread({}, phone);
  const before = Number(/pid=(\d+)/.exec(await reply(session, "where", phone))?.[1]);
  await phone.call("session.set_mode", { session_id: session, mode: "full" });
  const after = Number(/pid=(\d+)/.exec(await reply(session, "where", phone))?.[1]);
  assert.notEqual(after, before);
  await until(() => !alive(before), "the Cursor it left has stopped");
  assert.ok(alive(after));
});

// MARK: Permission requests

test("Cursor asks before a command: a card with once, always and deny, answered with Cursor's own options; a denied call is a blocked row", async () => {
  const session = await createThread();
  const before = answers(agentDir).length;
  await client.call("prompt.submit", { session_id: session, text: "approve this" });
  const request = await client.nextRequest();
  assert.equal(request.method, "approval");
  // The reason Cursor gives is the card's description.
  assert.deepEqual(request.params, { session_id: session, command: "rm -rf ./build", description: "It removes the build folder.", choices: ["once", "always", "deny"] });
  // The row is there before the card is answered.
  const row = tools(client.events(session)).at(-1);
  assert.deepEqual([row.type, row.name, row.args], ["tool.start", "terminal", { command: "rm -rf ./build" }]);
  assert.deepEqual((await client.call("sessions.activity")).sessions, [{ session_id: session, state: "waiting" }]);
  client.answer(request.id, { choice: "once" });
  const done = await client.nextEvent("message.complete", session);
  assert.equal(done.payload.text, "It was allowed. pong: approve this");
  assert.deepEqual(tools(client.events(session)).at(-1).result, { output: "ran with allow-once\n", exit_code: 0 });

  await client.call("prompt.submit", { session_id: session, text: "approve again" });
  client.answer((await client.nextRequest()).id, { choice: "always" });
  await client.nextEvent("message.complete", session);
  assert.deepEqual(tools(client.events(session)).at(-1).result, { output: "ran with allow-always\n", exit_code: 0 });

  await client.call("prompt.submit", { session_id: session, text: "approve one more" });
  client.answer((await client.nextRequest()).id, { choice: "deny" });
  const denied = await client.nextEvent("message.complete", session);
  assert.equal(denied.payload.status, "complete");
  assert.equal(denied.payload.text, "You said no. pong: approve one more");
  // Cursor says nothing of a rejected command but that it is done: the row is blocked all the same.
  assert.deepEqual(tools(client.events(session)).at(-1).result, { status: "blocked", error: "Denied from Portals.", user_summary: "You denied this command — it did not run." });
  assert.deepEqual(
    answers(agentDir).slice(before).map((answer) => answer.result.outcome),
    [
      { outcome: "selected", optionId: "allow-once" },
      { outcome: "selected", optionId: "allow-always" },
      { outcome: "selected", optionId: "reject-once" },
    ],
  );
});

test("Cursor asks before an edit: the card shows the change", async () => {
  const session = await createThread();
  await client.call("prompt.submit", { session_id: session, text: "editask" });
  const request = await client.nextRequest();
  const path = join(cwd, "hello.txt");
  assert.deepEqual(request.params, {
    session_id: session,
    command: `Edit ${path}\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n`,
    description: "Cursor wants to change a file",
    choices: ["once", "always", "deny"],
  });
  const row = tools(client.events(session)).at(-1);
  assert.deepEqual([row.type, row.name, row.args], ["tool.start", "patch", { path }]);
  client.answer(request.id, { choice: "once" });
  await client.nextEvent("message.complete", session);
  assert.deepEqual(tools(client.events(session)).at(-1).result, { success: true, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n" });
});

test("a permission request under an id no call announced shows the card with Cursor's title and makes no row of its own", async () => {
  const session = await createThread();
  await client.call("prompt.submit", { session_id: session, text: "websearch" });
  const request = await client.nextRequest();
  assert.deepEqual(request.params, {
    session_id: session,
    command: "Web search: agent client protocol",
    description: "Cursor wants to search the web",
    choices: ["once", "always", "deny"],
  });
  // No row yet: the request is not about the search's own tool call, which has not begun.
  assert.deepEqual(tools(client.events(session)), []);
  client.answer(request.id, { choice: "deny" });
  const denied = await client.nextEvent("message.complete", session);
  assert.equal(denied.payload.text, "The search was rejected. pong: websearch");
  // The search's row comes and ends by itself, blocked by what Cursor says of it.
  const rows = tools(client.events(session));
  assert.deepEqual(
    rows.map((row) => [row.type, row.name]),
    [
      ["tool.start", "web_search"],
      ["tool.complete", "web_search"],
    ],
  );
  assert.match(rows[0].tool_id, /^search-/);
  assert.deepEqual(rows[0].args, { query: "agent client protocol" });
  assert.deepEqual(rows[1].result, { status: "blocked", error: "User rejected", user_summary: "You denied this — it did not run." });

  await client.call("prompt.submit", { session_id: session, text: "websearch" });
  client.answer((await client.nextRequest()).id, { choice: "once" });
  const allowed = await client.nextEvent("message.complete", session);
  assert.equal(allowed.payload.text, "Searched with allow-once. pong: websearch");
  assert.deepEqual(tools(client.events(session)).at(-1).result, { output: "3 references" });
});

// MARK: Questions

/** Starts a turn that asks, answers the card, and returns what the stand-in was answered with. */
async function asked(session: string, prompt: string, answer: unknown): Promise<{ request: Frame; outcome: any; events: Frame[] }> {
  const from = client.events(session).length;
  const before = answers(agentDir).length;
  await client.call("prompt.submit", { session_id: session, text: prompt });
  const request = await client.nextRequest();
  client.answer(request.id, answer);
  await client.nextEvent("message.complete", session);
  return { request, outcome: answers(agentDir).slice(before)[0].result.outcome, events: client.events(session).slice(from) };
}

test("a question of Cursor's is a clarify card: the options chosen go back as their ids, the user's own words as the question skipped", async () => {
  const session = await createThread();
  const choices = ["Python", "Swift", "Rust, with macros"];
  const one = await asked(session, "ask1", { answers: { q0: "Swift" } });
  assert.equal(one.request.method, "clarify");
  assert.deepEqual(one.request.params, {
    session_id: session,
    questions: [{ qid: "q0", question: "Which language?", choices, multi_select: false, header: "Language" }],
  });
  assert.deepEqual(one.outcome, { outcome: "answered", answers: [{ questionId: "lang", selectedOptionIds: ["sw"] }] });
  // Cursor's own tool call for the question is a `clarify` row, which the app shows as
  // the question and not as a tool row; it ends with what was answered.
  assert.deepEqual(
    tools(one.events).map((row) => [row.type, row.name]),
    [
      ["tool.start", "clarify"],
      ["tool.complete", "clarify"],
    ],
  );
  assert.deepEqual(tools(one.events)[0].args, { questions: [{ question: "Which language?", choices }] });
  assert.deepEqual(tools(one.events)[1].result, { responses: [{ user_response: "Swift" }] });

  // A label with a comma in it is still one option.
  assert.deepEqual((await asked(session, "ask1", { answers: { q0: "Rust, with macros" } })).outcome.answers, [{ questionId: "lang", selectedOptionIds: ["rs"] }]);

  // Several picks come joined by ", ".
  const many = await asked(session, "askmany", { answers: { q0: "Python, Rust, with macros" } });
  assert.equal(many.request.params.questions[0].multi_select, true);
  assert.deepEqual(many.outcome, { outcome: "answered", answers: [{ questionId: "lang", selectedOptionIds: ["py", "rs"] }] });

  // Cursor takes option ids only: words of the user's own go back as why the question was skipped.
  const own = await asked(session, "ask1", { answers: { q0: "Neither, use Go" } });
  assert.deepEqual(own.outcome, {
    outcome: "skipped",
    reason: "The user answered in their own words, not with one of the options. Take this as the answer:\nWhich language? Neither, use Go",
  });
  assert.deepEqual(tools(own.events)[1].result, { responses: [{ user_response: "Neither, use Go" }] });

  // So does any answer to a question with no options.
  const open = await asked(session, "askopen", { answers: { q0: "Go" } });
  assert.deepEqual(open.request.params.questions[0].choices, []);
  assert.equal(open.outcome.outcome, "skipped");
  assert.match(open.outcome.reason, /\nWhich language\? Go$/);

  // A card dismissed is the question skipped.
  const dismissed = await asked(session, "ask1", { answers: null });
  assert.deepEqual(dismissed.outcome, { outcome: "skipped", reason: "The user dismissed the question without answering it." });
  assert.deepEqual(tools(dismissed.events)[1].result, { responses: [] });
});

test("a request with no question in it is answered skipped with no card; a stop withdraws a question's card and answers cancelled", async () => {
  const session = await createThread();
  const before = answers(agentDir).length;
  const frames = client.frames.length;
  const events = await runTurn(client, session, "asknone");
  assert.deepEqual(answers(agentDir).slice(before)[0].result, { outcome: { outcome: "skipped", reason: "The question had nothing to ask." } });
  assert.ok(!client.frames.slice(frames).some((frame) => frame.method === "clarify"));
  assert.equal(events.at(-1).payload.status, "complete");

  await client.call("prompt.submit", { session_id: session, text: "ask1" });
  const request = await client.nextRequest();
  await client.call("session.interrupt", { session_id: session });
  assert.deepEqual((await client.nextEvent("request.cancel", session)).payload, { id: request.id, reason: "interrupted" });
  assert.equal((await client.nextEvent("message.complete", session)).payload.status, "interrupted");
  assert.deepEqual(answers(agentDir).at(-1), { method: "cursor/ask_question", toolCallId: answers(agentDir).at(-1)?.toolCallId, result: { outcome: { outcome: "cancelled" } } });
});

// MARK: Plans and to-dos

const firstPlan = "Add notes.txt\n\nA file that says hello.\n\n# Add notes.txt\n\n1. Create the file.\n2. Write hello into it.";

test("a plan of Cursor's is a plan card; Start accepts it, the thread leaves plan mode, and Cursor is told to go ahead in the same turn", async () => {
  const session = await createThread();
  assert.deepEqual(await client.call("session.set_mode", { session_id: session, mode: "plan" }), { mode: "plan", mode_options: offered });
  const from = calls(agentDir).length;
  const before = answers(agentDir).length;
  await client.call("prompt.submit", { session_id: session, text: "makeplan" });
  const request = await client.nextRequest();
  assert.equal(request.method, "approval");
  assert.deepEqual(request.params, { session_id: session, command: firstPlan, description: "Cursor has a plan", choices: ["once", "deny"], plan: true, starts_in: "default" });
  // The plan's steps are a to-do row; the plan's own tool call is none.
  const rows = tools(client.events(session));
  assert.deepEqual(
    rows.map((row) => [row.type, row.name, row.context]),
    [
      ["tool.start", "todo", "0 of 2 done"],
      ["tool.complete", "todo", "0 of 2 done"],
    ],
  );
  assert.deepEqual(rows[1].result, { output: "○ Create the file\n○ Write hello into it" });

  client.answer(request.id, { choice: "once" });
  const mode = await client.nextEvent("session.mode", session);
  assert.deepEqual(mode.payload, { mode: "default", mode_options: offered });
  const done = await client.nextEvent("message.complete", session);
  // Accepted with no place for the plan: Cursor keeps it where it keeps its plans.
  assert.deepEqual(answers(agentDir).slice(before)[0].result, { outcome: { outcome: "accepted" } });
  // Cursor ended its turn on the accepted plan. The app's turn ends only when the go-ahead was answered.
  assert.equal(done.payload.status, "complete");
  assert.equal(done.payload.text, "pong: Go ahead with the plan.");
  const sent = calls(agentDir).slice(from).filter((call) => call.params?.sessionId === session);
  assert.deepEqual(
    sent.map((call) => [call.method, call.params.modeId ?? call.params.prompt?.[0]?.text]),
    [
      ["session/set_mode", "plan"],
      ["session/prompt", "makeplan"],
      ["session/set_mode", "agent"],
      ["session/prompt", "Go ahead with the plan."],
    ],
  );
  // One turn for the app, and the go-ahead is no message of the user's.
  const events = client.events(session);
  assert.equal(ofType(events, "message.start").length, 1);
  assert.equal(ofType(events, "message.complete").length, 1);
  const resumed = await client.call("session.resume", { session_id: session });
  assert.deepEqual(resumed.messages.filter((message: Frame) => message.role === "user").map((message: Frame) => message.text), ["makeplan"]);
  assert.equal(resumed.info.mode, "default");
});

for (const mode of ["default", "ask"] as const) {
  test(`an access-mode change on an open plan card sends no go-ahead to Cursor's stale Full-access process (${mode})`, async (t) => {
    const { phone, agentDir: dir } = await rig(t);
    const session = await createThread({}, phone);
    await phone.call("session.set_mode", { session_id: session, mode: "full" });
    assert.match(await reply(session, "where forced mode", phone), /forced=true mode=agent/);
    const from = calls(dir).length;
    await phone.call("prompt.submit", { session_id: session, text: "makeplan" });
    const plan = await phone.nextRequest();
    assert.equal(plan.params.plan, true);
    assert.equal(plan.params.starts_in, "default");
    await phone.call("session.set_mode", { session_id: session, mode });
    phone.answer(plan.id, { choice: "once" });
    const failed = await phone.nextEvent("message.complete", session);
    const inputs = () => calls(dir).slice(from).filter((call) => call.method === "session/prompt");
    assert.deepEqual(inputs().map((call) => call.params.prompt[0].text), ["makeplan"],
      "an accepted plan sent a go-ahead to the stale --force process");
    assert.equal(failed.payload.status, "error");
    assert.equal(failed.payload.text, "Cursor's access mode changed while the turn was starting, so the message was not sent. Send it again.");
    assert.deepEqual(answers(dir).at(-1)?.result, { outcome: { outcome: "accepted" } });
    const resumed = await phone.call("session.resume", { session_id: session });
    // Start explicitly leaves planning/Ask for Agent, as the card's starts_in says.
    assert.equal(resumed.info.mode, "default");
    assert.equal(resumed.messages.filter((message: Frame) => message.role === "user").at(-1).text, "makeplan");
    assert.match(await reply(session, "where forced mode", phone), /forced=false mode=agent/);
    assert.equal(inputs().length, 2);
  });
}

test("Keep planning sends the plan back with the user's note, and the second plan is a second card; a stop after Start sends no go-ahead", async () => {
  const session = await createThread({});
  await client.call("session.set_mode", { session_id: session, mode: "plan" });
  const before = answers(agentDir).length;
  await client.call("prompt.submit", { session_id: session, text: "makeplan" });
  const first = await client.nextRequest();
  client.answer(first.id, { choice: "deny", note: "Make it one step." });
  const second = await client.nextRequest();
  assert.deepEqual(answers(agentDir).slice(before)[0].result, { outcome: { outcome: "rejected", reason: "Make it one step." } });
  assert.equal(second.params.command, "Add notes.txt in one step\n\nA file that says hello.\n\n# Add notes.txt\n\n1. Create the file with hello in it.");
  assert.equal(second.params.plan, true);
  // Still planning: the thread's mode has not changed.
  assert.deepEqual(ofType(client.events(session), "session.mode").map((event) => event.payload), [{ mode: "plan", mode_options: offered }]);
  client.answer(second.id, { choice: "once" });
  const done = await client.nextEvent("message.complete", session);
  assert.equal(done.payload.text, "pong: Go ahead with the plan.");

  // Without a note, the reason says what to do.
  await client.call("session.set_mode", { session_id: session, mode: "plan" });
  const count = answers(agentDir).length;
  await client.call("prompt.submit", { session_id: session, text: "makeplan" });
  client.answer((await client.nextRequest()).id, { choice: "deny" });
  const again = await client.nextRequest();
  assert.deepEqual(answers(agentDir).slice(count)[0].result, { outcome: { outcome: "rejected", reason: "The plan was not approved in Portals. Keep planning, or ask what to change." } });

  // Stopped with the card open: the plan is answered cancelled.
  await client.call("session.interrupt", { session_id: session });
  assert.deepEqual((await client.nextEvent("request.cancel", session)).payload, { id: again.id, reason: "interrupted" });
  assert.equal((await client.nextEvent("message.complete", session)).payload.status, "interrupted");
  assert.deepEqual(answers(agentDir).at(-1)?.result, { outcome: { outcome: "cancelled" } });

  // Stopped after Start, while Cursor is still ending its turn: no go-ahead is sent.
  const from = calls(agentDir).length;
  await client.call("prompt.submit", { session_id: session, text: "makeplan and linger" });
  client.answer((await client.nextRequest()).id, { choice: "once" });
  await client.nextEvent("session.mode", session);
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  assert.equal((await client.nextEvent("message.complete", session)).payload.status, "interrupted");
  await sleep(50);
  const prompts = calls(agentDir).slice(from).filter((call) => call.method === "session/prompt" && call.params.sessionId === session);
  assert.deepEqual(prompts.map((call) => call.params.prompt[0].text), ["makeplan and linger"]);
});

test("Cursor's to-do list is a to-do row, and a change to some items shows the whole list", async () => {
  const session = await createThread();
  const before = answers(agentDir).length;
  const rows = tools(await runTurn(client, session, "todos"));
  // The to-do tool's own calls are no rows: these stand for them.
  assert.deepEqual(
    rows.map((row) => [row.type, row.name, row.context]),
    [
      ["tool.start", "todo", "0 of 3 done"],
      ["tool.complete", "todo", "0 of 3 done"],
      ["tool.start", "todo", "1 of 3 done"],
      ["tool.complete", "todo", "1 of 3 done"],
    ],
  );
  assert.deepEqual(rows[1].result, { output: "→ make a.txt\n○ make b.txt\n○ make c.txt" });
  // The second request held two items only.
  assert.deepEqual(rows[3].result, { output: "✓ make a.txt\n→ make b.txt\n○ make c.txt" });
  assert.deepEqual(rows[3].args.todos, [
    { content: "make a.txt", status: "completed" },
    { content: "make b.txt", status: "in_progress" },
    { content: "make c.txt", status: "pending" },
  ]);
  assert.deepEqual(answers(agentDir).slice(before).map((answer) => [answer.method, answer.result]), [
    ["cursor/update_todos", {}],
    ["cursor/update_todos", {}],
  ]);
});

test("Cursor's own requests name no session: each reaches the thread whose tool call it is, and one nobody can be shown is answered without an error", async () => {
  const [waiting, working, later] = [await createThread(), await createThread(), await createThread()];
  // One thread in a turn that stays open, on the same process as the other.
  await client.call("prompt.submit", { session_id: waiting, text: "sleep" });
  await client.nextEvent("tool.start", waiting);

  await client.call("prompt.submit", { session_id: working, text: "todos and makeplan" });
  const request = await client.nextRequest();
  assert.equal(request.params.session_id, working);
  assert.equal(request.params.plan, true);
  assert.deepEqual(
    tools(client.events(working)).filter((row) => row.type === "tool.start").map((row) => row.context),
    ["0 of 3 done", "1 of 3 done", "0 of 2 done"],
  );
  client.answer(request.id, { choice: "once" });
  await client.nextEvent("message.complete", working);
  // The thread that was only waiting saw none of it.
  assert.deepEqual(tools(client.events(waiting)).map((row) => row.name), ["terminal"]);

  // For tool calls nobody announced, with two threads in a turn: nobody is shown them.
  const frames = client.frames.length;
  const events = await runTurn(client, working, "orphan");
  assert.equal(events.at(-1).payload.text, 'plan={"outcome":{"outcome":"rejected","reason":"Portals could not show this plan."}} todos={} pong: orphan');
  assert.deepEqual(tools(events), []);
  assert.ok(!client.frames.slice(frames).some((frame) => frame.method === "approval"));

  // Sent once their turn is over: answered the same way, and nothing is shown.
  const before = answers(agentDir).length;
  const seen = client.frames.length;
  await runTurn(client, later, "late");
  await until(() => answers(agentDir).length >= before + 2, "the late requests are answered");
  assert.deepEqual(
    answers(agentDir).slice(before).map((answer) => [answer.method, answer.result, answer.error]),
    [
      ["cursor/create_plan", { outcome: { outcome: "rejected", reason: "Portals could not show this plan." } }, undefined],
      ["cursor/update_todos", {}, undefined],
    ],
  );
  assert.deepEqual(tools(client.events(later)), []);
  assert.ok(!client.frames.slice(seen).some((frame) => frame.method === "approval"));

  await client.call("session.interrupt", { session_id: waiting });
  await client.nextEvent("message.complete", waiting);

  // With one thread alone in a turn on the process, a request for a call nobody announced can only be that thread's.
  await client.call("prompt.submit", { session_id: working, text: "orphan" });
  const card = await client.nextRequest();
  assert.deepEqual([card.params.session_id, card.params.command, card.params.plan], [working, "Orphan\n\n# Orphan", true]);
  client.answer(card.id, { choice: "deny" });
  const alone = await client.nextEvent("message.complete", working);
  assert.match(alone.payload.text, /^plan=\{"outcome":\{"outcome":"rejected","reason":"The plan was not approved in Portals\. [^"]+"\}\} todos=\{\} pong: orphan$/);
  assert.deepEqual(tools(client.events(working)).at(-1).context, "0 of 1 done");
});

// MARK: Modes

/** The reply of a turn. */
async function reply(session: string, text: string, on = client): Promise<string> {
  return (await runTurn(on, session, text)).at(-1).payload.text;
}

test("a thread's mode is sent before every turn, as Cursor's; Full access is its agent mode, and edits is refused with a sentence", async () => {
  const session = await createThread();
  const sent = () => calls(agentDir).filter((call) => call.method === "session/set_mode" && call.params.sessionId === session).map((call) => call.params.modeId);
  // A new thread follows Cursor's own settings, which is its agent mode.
  assert.equal(await reply(session, "mode"), "mode=agent");
  assert.deepEqual(sent(), ["agent"]);

  assert.deepEqual(await client.call("session.set_mode", { session_id: session, mode: "plan" }), { mode: "plan", mode_options: offered });
  // Kept, and not sent before the thread's next message: Cursor reads the mode as it takes a prompt.
  assert.deepEqual(sent(), ["agent"]);
  assert.equal((await client.call("session.resume", { session_id: session })).info.mode, "plan");
  assert.equal(await reply(session, "mode"), "mode=plan");
  assert.deepEqual(await client.call("slash.exec", { session_id: session, command: "/mode ask" }), {
    type: "exec",
    output: "This thread now is in Cursor's Ask mode, for reading and answering: Cursor is told to edit no files and run no commands.",
  });
  assert.equal(await reply(session, "mode"), "mode=ask");
  assert.deepEqual(await client.call("slash.exec", { session_id: session, command: "/mode default" }), { type: "exec", output: "This thread now follows your Cursor settings." });
  assert.equal(await reply(session, "mode"), "mode=agent");
  assert.deepEqual(sent(), ["agent", "plan", "ask", "agent"]);

  // Full access is Cursor's agent mode too, on a Cursor run with --force (below).
  assert.deepEqual(await client.call("session.set_mode", { session_id: session, mode: "full" }), { mode: "full", mode_options: offered });
  assert.equal(await reply(session, "mode"), "mode=agent");
  assert.deepEqual(sent(), ["agent", "plan", "ask", "agent", "agent"]);
  await client.call("session.set_mode", { session_id: session, mode: "default" });

  // Cursor has nothing Accept edits could mean. `/mode` does not offer it, so it names the
  // modes it has, as for any mode it does not offer.
  await assert.rejects(client.call("session.set_mode", { session_id: session, mode: "edits" }), (error: RpcFailure) => error.code === -32602 && error.message === noSuchModeText);
  await assert.rejects(client.call("slash.exec", { session_id: session, command: "/mode edits" }), (error: RpcFailure) => error.code === -32602 && error.message === "Use /mode ask, plan, full or default.");
  assert.equal((await client.call("session.resume", { session_id: session })).info.mode, "default");
});

test("a mode chosen during a turn goes with the next; a switch the model made itself is put right by the next message", async () => {
  const session = await createThread();
  await client.call("prompt.submit", { session_id: session, text: "slow" });
  await client.nextEvent("message.delta", session);
  // The answer says the running turn goes on as it was.
  assert.deepEqual(await client.call("slash.exec", { session_id: session, command: "/mode plan" }), {
    type: "exec",
    output: "This thread now plans first, and asks before carrying the plan out. Cursor takes it with this thread's next message.",
  });
  await client.call("session.interrupt", { session_id: session });
  await client.nextEvent("message.complete", session);
  assert.equal(await reply(session, "mode"), "mode=plan");

  // The model leaves the thread's mode with its own tool; the session is in plan mode from there.
  await client.call("session.set_mode", { session_id: session, mode: "default" });
  assert.equal(await reply(session, "switch and say the mode"), "mode=plan");
  // The thread's own mode goes with its next message.
  assert.equal(await reply(session, "mode"), "mode=agent");
});

for (const phase of ["starting", "setting mode"] as const) {
  for (const [before, after] of [["full", "default"], ["full", "ask"], ["default", "full"]] as const) {
    test(`an access-mode change while ${phase} keeps a mismatched Cursor process from receiving input (${before} to ${after})`, async (t) => {
      const state = await rig(t);
      const session = await createThread({}, state.phone);
      await state.phone.call("session.set_mode", { session_id: session, mode: before });
      const release = Promise.withResolvers<void>();
      const open = state.provider.process.bind(state.provider);
      let held = false;
      state.provider.process = async (cwd, forced = false) => {
        const process = await open(cwd, forced);
        if (phase === "starting" && !held) {
          held = true;
          await release.promise;
        } else if (phase === "setting mode") {
          const call = process.client.call.bind(process.client);
          process.client.call = async <T = any>(method: string, params: unknown, timeoutMs?: number): Promise<T> => {
            const result = await call<T>(method, params, timeoutMs);
            if (method === "session/set_mode" && !held) {
              held = true;
              await release.promise;
            }
            return result;
          };
        }
        return process;
      };
      const text = "where forced mode";
      const turn = runTurn(state.phone, session, text);
      try {
        await until(() => held, `Cursor reached ${phase}`);
        assert.equal((await state.phone.call("session.set_mode", { session_id: session, mode: after })).mode, after);
      } finally {
        release.resolve();
      }
      const failed = (await turn).at(-1).payload;
      assert.deepEqual(calls(state.agentDir).filter((call) => call.method === "session/prompt"), [],
        `a stale process received input after ${after} was acknowledged: ${failed.text}`);
      assert.equal(failed.status, "error");
      assert.equal(failed.text, "Cursor's access mode changed while the turn was starting, so the message was not sent. Send it again.");
      const resumed = await state.phone.call("session.resume", { session_id: session });
      assert.equal(resumed.info.mode, after);
      assert.deepEqual(resumed.messages.filter((message: Frame) => message.role === "user").map((message: Frame) => message.text), [text]);
      // A manual retry, not an automatic resend, uses the right process and current native mode.
      const retried = await reply(session, text, state.phone);
      assert.match(retried, new RegExp(`forced=${after === "full"}`));
      assert.match(retried, new RegExp(`mode=${after === "ask" ? "ask" : "agent"}`));
      assert.equal(calls(state.agentDir).filter((call) => call.method === "session/prompt").length, 1);
    });
  }
}

test("a mode Cursor does not take fails the turn before the message is sent, and the thread's next message sets it again", async (t) => {
  const { phone, agentDir: dir } = await rig(t);
  const session = await createThread({}, phone);
  await phone.call("session.set_mode", { session_id: session, mode: "ask" });
  writeFileSync(join(dir, "no-modes"), "");
  const failed = (await runTurn(phone, session, "use a tool")).at(-1).payload;
  assert.equal(failed.status, "error");
  assert.equal(failed.text, "Cursor did not take the mode ask, so the message was not sent: Internal error (The stand-in takes no mode now.)");
  // Cursor never got the message: it would have run it in the mode the session was in, which edits.
  assert.deepEqual(methods(calls(dir)).slice(-2), ["session/new", "session/set_mode"]);
  assert.deepEqual(tools(phone.events(session)), []);
  assert.equal((await phone.call("session.resume", { session_id: session })).info.mode, "ask");

  rmSync(join(dir, "no-modes"));
  assert.equal(await reply(session, "mode", phone), "mode=ask");
});

// MARK: Stop

test("Stop cancels the turn at Cursor; a card open then closes, and rows Cursor left open are closed, a command's with what is not known of it", async () => {
  const session = await createThread();
  await client.call("prompt.submit", { session_id: session, text: "slow please" });
  await client.nextEvent("message.delta", session);
  assert.deepEqual(await client.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  const stopped = await client.nextEvent("message.complete", session);
  assert.equal(stopped.payload.status, "interrupted");
  assert.ok(calls(agentDir).some((call) => call.method === "session/cancel" && call.params.sessionId === session));

  await client.call("prompt.submit", { session_id: session, text: "approve this" });
  const request = await client.nextRequest();
  await client.call("session.interrupt", { session_id: session });
  assert.deepEqual((await client.nextEvent("request.cancel", session)).payload, { id: request.id, reason: "interrupted" });
  assert.equal((await client.nextEvent("message.complete", session)).payload.status, "interrupted");
  assert.deepEqual(answers(agentDir).at(-1)?.result, { outcome: { outcome: "cancelled" } });
  // The command was never allowed, so it never ran.
  assert.deepEqual(tools(client.events(session)).at(-1).result, { status: "error", error: "Stopped before it finished." });

  // Allowed, and stopped while it ran: Cursor does not say whether the command ended, and the row says so.
  const allowed = answers(agentDir).length;
  await client.call("prompt.submit", { session_id: session, text: "approve this long one" });
  client.answer((await client.nextRequest()).id, { choice: "once" });
  await until(() => answers(agentDir).length > allowed, "Cursor has the answer");
  await client.call("session.interrupt", { session_id: session });
  assert.equal((await client.nextEvent("message.complete", session)).payload.status, "interrupted");
  assert.deepEqual(tools(client.events(session)).at(-1).result, { status: "error", error: commandLeftText });

  // A stopped turn's running tool calls stay as they were: the bridge closes their rows.
  const from = client.events(session).length;
  await client.call("prompt.submit", { session_id: session, text: "sleep and hang" });
  await client.nextEvent("tool.start", session);
  await client.nextEvent("tool.start", session);
  await client.call("session.interrupt", { session_id: session });
  await client.nextEvent("message.complete", session);
  const closed = tools(client.events(session).slice(from)).filter((row) => row.type === "tool.complete");
  assert.deepEqual(
    closed.map((row) => [row.name, row.result]),
    [
      ["terminal", { status: "error", error: `Stopped. The command may still be running on the ${machineWord()}: Cursor does not say whether it ended.` }],
      ["read_file", { status: "error", error: "Stopped before it finished." }],
    ],
  );

  assert.equal(await reply(session, "still there?"), "pong: still there?");
});

test("a stop while Cursor is still starting or loading the session sends nothing and ends the turn at once", async (t) => {
  const state = await rig(t);
  const session = await createThread({}, state.phone);
  await runTurn(state.phone, session, "hello");
  await state.restart();
  await state.phone.call("session.resume", { session_id: session });
  const before = calls(state.agentDir).length;
  // The message has Cursor started and the session loaded, which takes it a moment.
  await state.phone.call("prompt.submit", { session_id: session, text: "never mind" });
  assert.deepEqual(await state.phone.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  assert.equal((await state.phone.nextEvent("message.complete", session)).payload.status, "interrupted");
  // Cursor loads the session all the same, and gets neither the message nor a cancel.
  await until(() => timeline(state.agentDir).some((entry) => entry.event === "answered" && entry.method === "session/load"), "the session is loaded");
  await sleep(50);
  assert.deepEqual(methods(calls(state.agentDir).slice(before)), ["initialize", "cursor/list_available_models", "session/load"]);
  // The thread goes on with its next message, on the session that is loaded by now.
  const next = state.phone.frames.length;
  await state.phone.call("prompt.submit", { session_id: session, text: "now then" });
  assert.equal((await eventFrom(state.phone, next, "message.complete", session)).payload.text, "pong: now then");
  assert.deepEqual(methods(calls(state.agentDir).slice(before + 3)), ["session/set_mode", "session/prompt"]);
  const stored = (await state.phone.call("session.resume", { session_id: session })).messages;
  assert.deepEqual(
    stored.map((message: Frame) => [message.role, message.text, message.display_metadata?.interrupted ?? false]),
    [
      ["user", "hello", false],
      ["assistant", "pong: hello", false],
      ["user", "never mind", false],
      ["assistant", "", true],
      ["user", "now then", false],
      ["assistant", "pong: now then", false],
    ],
  );
});

test("a Cursor that ignores a stop, alone on its process: the turn ends after the grace time, the process is stopped, and the next message starts another", async (t) => {
  const { phone, agentDir: dir } = await rig(t, { interruptGraceMs: 150 });
  const session = await createThread({}, phone);
  const pid = Number(/pid=(\d+)/.exec(await reply(session, "where", phone))?.[1]);
  const mark = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "stubborn" });
  await eventFrom(phone, mark, "message.delta", session);
  const stoppedAt = Date.now();
  assert.deepEqual(await phone.call("session.interrupt", { session_id: session }), { status: "interrupted" });
  const ended = await eventFrom(phone, mark, "message.complete", session);
  assert.equal(ended.payload.status, "interrupted");
  assert.ok(Date.now() - stoppedAt >= 140, "the turn ended before the grace time was up");
  assert.ok(calls(dir).some((call) => call.method === "session/cancel"));
  // Nothing else was at work on the process, so it is stopped, which ends the matter.
  await until(() => !alive(pid), "the stuck process has gone");
  const next = await reply(session, "where", phone);
  assert.notEqual(Number(/pid=(\d+)/.exec(next)?.[1]), pid);
  // Nothing is left of the turn that would not stop: the thread can be removed.
  assert.deepEqual(await phone.call("thread.delete", { thread: session }), {});
});

test("a Cursor that ignores a stop, with another thread at work on the process: the thread is at work until Cursor answers, and its next message runs", async (t) => {
  const { phone, agentDir: dir, provider: own } = await rig(t, { interruptGraceMs: 150 });
  const [stuck, other] = [await createThread({}, phone), await createThread({}, phone)];
  const pid = Number(/pid=(\d+)/.exec(await reply(stuck, "where", phone))?.[1]);
  const mark = phone.frames.length;
  await phone.call("prompt.submit", { session_id: other, text: "sleep" });
  await eventFrom(phone, mark, "tool.start", other);
  await phone.call("prompt.submit", { session_id: stuck, text: "stubborn" });
  await eventFrom(phone, mark, "message.delta", stuck);
  await phone.call("session.interrupt", { session_id: stuck });
  // Ended for the app after the grace time.
  assert.equal((await eventFrom(phone, mark, "message.complete", stuck)).payload.status, "interrupted");
  // The process stays: the other thread's turn is on it.
  await sleep(100);
  assert.ok(alive(pid));
  own.sweep();
  assert.ok(alive(pid));
  // Cursor has not answered the prompt: the thread is still at work, and is not removed.
  await assert.rejects(
    phone.call("thread.delete", { thread: stuck }),
    (error: RpcFailure) => error.code === -32602 && error.message === "Cursor is still working in this thread. Stop it, then remove it.",
  );
  const completed = ofType(phone.events(stuck), "message.complete").length;

  // Cursor answers at last. The late answer ends nothing a second time, and the thread goes on.
  writeFileSync(join(dir, "let-go"), "");
  await until(() => timeline(dir).filter((entry) => entry.event === "answered" && entry.method === "session/prompt" && entry.session === stuck).length === 2, "the late answer came");
  await sleep(30);
  assert.equal(ofType(phone.events(stuck), "message.complete").length, completed);
  assert.equal(await reply(stuck, "still there?", phone), "pong: still there?");
  assert.deepEqual(await phone.call("thread.delete", { thread: stuck }), {});

  await phone.call("session.interrupt", { session_id: other });
  await eventFrom(phone, mark, "message.complete", other);
});

test("a process that owes the answer to a stopped prompt is stopped by the sweep once nothing else is at work on it", async (t) => {
  const { phone, provider: own } = await rig(t, { interruptGraceMs: 150 });
  const [stuck, other] = [await createThread({}, phone), await createThread({}, phone)];
  const pid = Number(/pid=(\d+)/.exec(await reply(stuck, "where", phone))?.[1]);
  const mark = phone.frames.length;
  await phone.call("prompt.submit", { session_id: other, text: "sleep" });
  await eventFrom(phone, mark, "tool.start", other);
  await phone.call("prompt.submit", { session_id: stuck, text: "stubborn" });
  await eventFrom(phone, mark, "message.delta", stuck);
  await phone.call("session.interrupt", { session_id: stuck });
  assert.equal((await eventFrom(phone, mark, "message.complete", stuck)).payload.status, "interrupted");
  own.sweep();
  assert.ok(alive(pid));
  await phone.call("session.interrupt", { session_id: other });
  await eventFrom(phone, mark, "message.complete", other);
  own.sweep();
  await until(() => !alive(pid), "the stuck process has gone");
  assert.notEqual(Number(/pid=(\d+)/.exec(await reply(stuck, "where", phone))?.[1]), pid);
});

test("what a process that is being stopped still sends is shown in no turn: the thread's next one, on a new process, has only its own", async (t) => {
  const { phone } = await rig(t, { interruptGraceMs: 100 });
  const session = await createThread({}, phone);
  const pid = Number(/pid=(\d+)/.exec(await reply(session, "where", phone))?.[1]);
  const mark = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "babble" });
  await eventFrom(phone, mark, "message.delta", session);
  await phone.call("session.interrupt", { session_id: session });
  assert.equal((await eventFrom(phone, mark, "message.complete", session)).payload.status, "interrupted");
  // Being stopped, it ignores that too and writes on for the two seconds it is given.
  const before = phone.events(session).length;
  const from = phone.frames.length;
  await phone.call("prompt.submit", { session_id: session, text: "where" });
  // The next turn is open, a new process is starting for it, and the old one still writes.
  await sleep(100);
  assert.ok(alive(pid), "the old process had gone, so the test showed nothing");
  const again = Number(/pid=(\d+)/.exec((await eventFrom(phone, from, "message.complete", session)).payload.text)?.[1]);
  assert.notEqual(again, pid);
  assert.equal(streamedText(phone.events(session).slice(before)), `pid=${again} cwd=${cwd}`);
  await until(() => !alive(pid), "the old process is killed");
});

test("a message sent while a turn runs waits in the bridge: Cursor gets it only after it answered the first", async () => {
  const session = await createThread();
  await client.call("prompt.submit", { session_id: session, text: "slow first" });
  await client.nextEvent("message.delta", session);
  assert.deepEqual(await client.call("prompt.submit", { session_id: session, text: "second" }), { status: "queued", queue_id: "1" });
  const first = await client.nextEvent("message.complete", session);
  // Complete, not cancelled: a second prompt would have cancelled the first at Cursor.
  assert.equal(first.payload.status, "complete");
  const second = await client.nextEvent("message.complete", session);
  assert.equal(second.payload.text, "pong: second");
  const prompts = timeline(agentDir).filter((entry) => entry.method === "session/prompt" && entry.session === session);
  assert.deepEqual(prompts.map((entry) => entry.event), ["got", "answered", "got", "answered"]);
});

// MARK: Models and thinking levels

test("a model and a level chosen for a thread are set at Cursor before its next turn, the level as that model has it; a thread on default sets nothing", async (t) => {
  const { phone, agentDir: dir } = await rig(t);
  const session = await createThread({}, phone);
  const set = (of = session) => calls(dir).filter((call) => call.method === "session/set_config_option" && call.params.sessionId === of).map((call) => [call.params.configId, call.params.value]);
  assert.equal(await reply(session, "model", phone), "model=default");
  // A thread on `default` leaves the level to Cursor too. The app offers every level for
  // a model that lists none, so one chosen here is refused with why, not kept unused.
  await assert.rejects(
    phone.call("config.set", { key: "reasoning", value: "high", session_id: session }),
    (error: RpcFailure) => error.code === -32602 && error.message === levelLeftToCursorText,
  );
  assert.deepEqual(await phone.call("config.set", { key: "model", value: "small --provider cursor --session", session_id: session }), {});
  assert.deepEqual(await phone.call("config.set", { key: "reasoning", value: "high", session_id: session }), {});
  // Not before the turn: Cursor may not even be running.
  assert.deepEqual(set(), []);
  assert.equal(await reply(session, "model", phone), "model=small effort=high fast=true");
  assert.deepEqual(set(), [
    ["model", "small"],
    ["effort", "high"],
  ]);
  let info = (await phone.call("session.resume", { session_id: session })).info;
  assert.deepEqual([info.model, info.reasoning_effort], ["small", "high"]);
  // Nothing is set again while Cursor is still on it.
  assert.equal(await reply(session, "model", phone), "model=small effort=high fast=true");
  assert.equal(set().length, 2);

  // A level the model has not is set as the nearest it has.
  await phone.call("config.set", { key: "reasoning", value: "max", session_id: session });
  info = (await phone.call("session.resume", { session_id: session })).info;
  assert.equal(info.reasoning_effort, "high");
  await phone.call("config.set", { key: "reasoning", value: "minimal", session_id: session });
  assert.equal(await reply(session, "model", phone), "model=small effort=low fast=true");

  // On the option that model has, by the name Cursor has for the level: extra-high is the app's xhigh.
  await phone.call("config.set", { key: "model", value: "deep --session", session_id: session });
  await phone.call("config.set", { key: "reasoning", value: "xhigh", session_id: session });
  assert.equal(await reply(session, "model", phone), "model=deep reasoning=extra-high");
  assert.deepEqual(set().slice(-2), [
    ["model", "deep"],
    ["reasoning", "extra-high"],
  ]);
  info = (await phone.call("session.resume", { session_id: session })).info;
  assert.deepEqual([info.model, info.reasoning_effort], ["deep", "xhigh"]);

  // Where a model also has thinking on or off, the level goes on its effort.
  await phone.call("config.set", { key: "model", value: "large --session", session_id: session });
  await phone.call("config.set", { key: "reasoning", value: "max", session_id: session });
  assert.equal(await reply(session, "model", phone), "model=large thinking=true effort=max");
  // A model with no levels gets none.
  await phone.call("config.set", { key: "model", value: "flat --session", session_id: session });
  assert.equal(await reply(session, "model", phone), "model=flat");
  assert.equal((await phone.call("session.resume", { session_id: session })).info.reasoning_effort, "");
  await assert.rejects(
    phone.call("config.set", { key: "reasoning", value: "low", session_id: session }),
    (error: RpcFailure) => error.code === -32602 && error.message === "Cursor has no thinking levels for Flat.",
  );
  // The level chosen before is still the thread's, for a model that takes one.
  assert.deepEqual(await phone.call("config.set", { key: "reasoning", value: "", session_id: session }), {});
  await phone.call("config.set", { key: "model", value: "large --session", session_id: session });
  await phone.call("config.set", { key: "reasoning", value: "max", session_id: session });
  // Cursor's own Auto, listed as `auto`, is sent by its id there.
  await phone.call("config.set", { key: "model", value: "auto --session", session_id: session });
  assert.equal(await reply(session, "model", phone), "model=default");
  assert.deepEqual(set().at(-1), ["model", "default"]);

  // Another thread in the folder, on `default`: it runs on whatever Cursor is set to, and sets nothing.
  const other = await createThread({}, phone);
  await phone.call("config.set", { key: "model", value: "small --session", session_id: session });
  await phone.call("config.set", { key: "reasoning", value: "", session_id: session });
  assert.equal(await reply(session, "model", phone), "model=small effort=low fast=true");
  assert.equal(await reply(other, "model", phone), "model=small effort=low fast=true");
  assert.deepEqual(set(other), []);
  // With no level chosen, the thread shows the one Cursor is at for its model.
  assert.equal((await phone.call("session.resume", { session_id: session })).info.reasoning_effort, "low");

  // When another thread changed the model, this one's is set again before its turn.
  await phone.call("config.set", { key: "model", value: "large --session", session_id: other });
  assert.equal(await reply(other, "model", phone), "model=large thinking=true effort=max");
  const before = set().length;
  assert.equal(await reply(session, "model", phone), "model=small effort=low fast=true");
  assert.deepEqual(set().slice(before), [["model", "small"]]);
});

// MARK: The provider by itself

/** A thread's side of the bridge, for driving a provider without one. */
function collector(answer: RequestAnswer = { kind: "approval", choice: "once" }) {
  const events: ProviderEvent[] = [];
  let waiters: (() => void)[] = [];
  const sink: SessionSink = {
    emit(event) {
      events.push(event);
      for (const wake of waiters.splice(0)) wake();
    },
    ask: async () => answer,
  };
  return {
    sink,
    events,
    /** Sends a message and waits for its turn to end; returns the turn's events. */
    async turn(session: ProviderSession, text: string): Promise<ProviderEvent[]> {
      const from = events.length;
      session.startTurn({ text, images: [] });
      while (!events.slice(from).some((event) => event.type === "turn.end")) await new Promise<void>((resolve) => waiters.push(resolve));
      return events.slice(from);
    },
  };
}

function said(events: ProviderEvent[]): string {
  return events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");
}

const defaults: SessionSettings = { model: "default", provider: "cursor", reasoningEffort: "" };

async function thread(of: CursorProvider, where: string, sink: SessionSink, settings = defaults): Promise<ProviderSession & { id?: string }> {
  const id = await of.newThread({ cwd: where, settings });
  return Object.assign(await of.startSession({ id, cwd: where, settings, title: null }, sink), { id });
}

/** A provider with folders of its own, closed and cleaned up when the test ends. */
function standalone(t: { after(fn: () => Promise<void>): void }, options: Partial<StandinOptions> = {}): { provider: CursorProvider; agentDir: string; stateDir: string } {
  const folders = { agentDir: agentFolder(), stateDir: temporaryHome() };
  const made = cursor({ ...options, ...folders });
  t.after(async () => {
    await made.close();
    for (const path of Object.values(folders)) rmSync(path, { recursive: true, force: true });
  });
  return { provider: made, ...folders };
}

test("a process gets no session call before it answered the hello and the model list, and two threads' first calls on it do not overlap", async (t) => {
  const { provider: own, agentDir: dir } = standalone(t);
  const [a, b] = [collector(), collector()];
  // Both at once, on a process that is not running yet.
  const [first, second] = await Promise.all([thread(own, cwd, a.sink), thread(own, cwd, b.sink)]);
  assert.notEqual(first.id, second.id);
  // Every call was answered before the next was sent.
  assert.deepEqual(
    timeline(dir).map((entry) => [entry.event, entry.method]),
    [
      ["got", "initialize"],
      ["answered", "initialize"],
      ["got", "cursor/list_available_models"],
      ["answered", "cursor/list_available_models"],
      ["got", "session/new"],
      ["answered", "session/new"],
      ["got", "session/new"],
      ["answered", "session/new"],
    ],
  );
});

test("one thread's load does not come between another's model and its prompt", async (t) => {
  const { provider: own, agentDir: dir } = standalone(t);
  const phones = [collector(), collector(), collector()];
  const settings = (model: string) => ({ ...defaults, model });
  const threads = [await thread(own, cwd, phones[0].sink, settings("small")), await thread(own, cwd, phones[1].sink, settings("large")), await thread(own, cwd, phones[2].sink)];
  for (const [index, session] of threads.entries()) await phones[index].turn(session, "hello");
  // The process stops; each thread's next message has its session loaded, which selects the model that session last ran on.
  own.sweep(Date.now() + 120_000);
  const from = timeline(dir).length;
  const set = () => calls(dir).filter((call) => call.method === "session/set_config_option").length;
  const before = set();
  const turns = [phones[0].turn(threads[0], "model"), phones[1].turn(threads[1], "model")];
  // A third thread's message comes while the first's model is being set.
  await until(() => set() > before, "a model is being set");
  turns.push(phones[2].turn(threads[2], "model"));
  const replies = (await Promise.all(turns)).map(said);
  assert.equal(replies[0], "model=small effort=medium fast=true");
  assert.equal(replies[1], "model=large thinking=true effort=high");
  // Between a thread's model and its prompt Cursor got nothing that touches what it is set to.
  const got = timeline(dir).slice(from).filter((entry) => entry.event === "got");
  const shared = ["session/new", "session/load", "session/set_config_option", "session/prompt"];
  for (const [index, entry] of got.entries()) {
    if (entry.method !== "session/set_config_option") continue;
    const next = got.slice(index + 1).find((later) => shared.includes(later.method));
    assert.equal(next?.session, entry.session, `after ${entry.session} set something, ${next?.method} of ${next?.session} came first`);
  }
  assert.equal(got.filter((entry) => entry.method === "session/load").length, 3);
});

test("a model Cursor no longer offers leaves the thread where Cursor is, with a notice", async (t) => {
  const { provider: own, agentDir: dir } = standalone(t);
  const phone = collector();
  const session = await thread(own, cwd, phone.sink, { ...defaults, model: "vanished" });
  const events = await phone.turn(session, "model");
  assert.deepEqual(events.filter((event) => event.type === "notice"), [
    { type: "notice", level: "warn", text: "Cursor no longer offers the model vanished, so this turn runs on the one Cursor is set to." },
  ]);
  assert.equal(said(events), "model=default");
  assert.ok(!calls(dir).some((call) => call.method === "session/set_config_option"));
});

test("threads in one folder share a process of Cursor's; another folder gets its own, running there", async (t) => {
  const { provider: own } = standalone(t);
  const elsewhere = folder();
  t.after(async () => rmSync(elsewhere, { recursive: true, force: true }));
  const [a, b, c] = [collector(), collector(), collector()];
  const first = await thread(own, cwd, a.sink);
  const second = await thread(own, cwd, b.sink);
  const third = await thread(own, elsewhere, c.sink);
  // At the same time: one process serves both sessions.
  const [one, two, three] = await Promise.all([a.turn(first, "where"), b.turn(second, "where"), c.turn(third, "where")]);
  assert.equal(said(one), said(two));
  assert.match(said(one), new RegExp(`^pid=\\d+ cwd=${cwd}$`));
  assert.match(said(three), new RegExp(`^pid=\\d+ cwd=${elsewhere}$`));
  assert.notEqual(said(three).split(" ")[0], said(one).split(" ")[0]);
});

test("a process nothing has used for a while is stopped, and the next message starts one that loads the session", async (t) => {
  const { provider: own, agentDir: dir } = standalone(t, { idleMs: 60_000 });
  const phone = collector();
  const session = await thread(own, cwd, phone.sink);
  const pid = said(await phone.turn(session, "where")).split(" ")[0];

  // Not yet idle long enough.
  own.sweep(Date.now() + 30_000);
  assert.equal(said(await phone.turn(session, "where")).split(" ")[0], pid);

  own.sweep(Date.now() + 61_000);
  // The next message finds no process and starts one, which loads the session.
  const events = await phone.turn(session, "where");
  assert.notEqual(said(events).split(" ")[0], pid);
  assert.equal(calls(dir).filter((call) => call.method === "session/load").length, 1);
  // What Cursor sent again of the conversation is not shown a second time.
  assert.match(said(events), /^pid=\d+ cwd=\S+$/);
});

test("a process with a card open, or with a new session waiting for its thread, is left alone", async (t) => {
  const { provider: own, agentDir: dir } = standalone(t);
  // A new session whose thread the bridge has not started yet.
  const id = await own.newThread({ cwd, settings: defaults });
  own.sweep(Date.now() + 600_000);
  const phone = collector();
  const session = await own.startSession({ id, cwd, settings: defaults, title: null }, phone.sink);
  const pid = said(await phone.turn(session, "where")).split(" ")[0];
  assert.equal(calls(dir).filter((call) => call.method === "initialize").length, 1);

  // A card that is open: the sweep comes while the thread waits for its answer.
  let answer!: (answer: RequestAnswer) => void;
  const asking = collector();
  asking.sink.ask = () => new Promise<RequestAnswer>((resolve) => (answer = resolve));
  const waiting = await thread(own, cwd, asking.sink);
  const turn = asking.turn(waiting, "approve");
  await until(() => answer !== undefined, "the card is open");
  own.sweep(Date.now() + 600_000);
  answer({ kind: "approval", choice: "once" });
  assert.equal(said(await turn), "It was allowed. pong: approve");
  assert.equal(said(await phone.turn(session, "where")).split(" ")[0], pid);
});

test("a process is left alone while a new session is being made in it", async (t) => {
  const { provider: own, agentDir: dir } = standalone(t, { features: ["slownew"] });
  // A thread at rest, so that nothing else keeps its process.
  const first = await thread(own, cwd, collector().sink);
  const asked = () => timeline(dir).filter((entry) => entry.event === "got" && entry.method === "session/new").length;
  const making = own.newThread({ cwd, settings: defaults });
  await until(() => asked() === 2, "Cursor is making the session");
  own.sweep(Date.now() + 600_000);
  assert.notEqual(await making, first.id);
  assert.equal(calls(dir).filter((call) => call.method === "initialize").length, 1);
});

test("when Cursor's process dies the turn fails and its card closes, what it started is ended, and the next message starts another with the session", async () => {
  const session = await createThread();
  const first = await reply(session, "where are you");
  const pid = Number(/pid=(\d+)/.exec(first)?.[1]);
  assert.equal(first, `pid=${pid} cwd=${cwd}`);
  const helper = Number(/helper=(\d+)/.exec(await reply(session, "helper"))?.[1]);

  const events = await runTurn(client, session, "gasp, then crash");
  assert.equal(streamedText(events), "About to crash. ");
  const failed = events.at(-1).payload;
  assert.equal(failed.status, "error");
  // With the last thing Cursor wrote to its standard error.
  assert.equal(failed.text, "Cursor stopped (exit code 3): the stand-in fell over on purpose. Send the message again to start it.");
  // What it had started (an MCP server, say) does not stay behind.
  await until(() => !alive(helper), "what the dead process started has gone");

  const next = await runTurn(client, session, "where are you");
  const again = Number(/pid=(\d+)/.exec(next.at(-1).payload.text)?.[1]);
  assert.notEqual(again, pid);
  // The new process loaded the session; the conversation it sent again is not shown twice.
  const loaded = calls(agentDir).filter((call) => call.pid === again).map((call) => call.method);
  assert.deepEqual(loaded, ["initialize", "cursor/list_available_models", "session/load", "session/set_mode", "session/prompt"]);
  assert.equal(streamedText(next), `pid=${again} cwd=${cwd}`);
  assert.deepEqual(
    next.map((event) => event.type).filter((type) => type !== "message.delta"),
    ["message.start", "message.complete"],
  );

  // Killed with a card open: the card closes, and the command, which was never allowed, never ran.
  const mark = client.frames.length;
  await client.call("prompt.submit", { session_id: session, text: "approve this" });
  const request = await client.nextRequest();
  process.kill(again, "SIGKILL");
  assert.deepEqual((await eventFrom(client, mark, "request.cancel", session)).payload, { id: request.id, reason: "withdrawn" });
  const killed = await eventFrom(client, mark, "message.complete", session);
  assert.equal(killed.payload.status, "error");
  assert.equal(killed.payload.text, "Cursor stopped (SIGKILL). Send the message again to start it.");
  assert.deepEqual(tools(client.events(session)).at(-1).result, { status: "error", error: "Stopped before it finished." });
  assert.equal(await reply(session, "still there?"), "pong: still there?");
});

// MARK: Across restarts of the bridge

/** A thread's file, as the bridge keeps it. */
function threadFile(state: string, id: string): { messages: Frame[]; session?: string; told?: boolean; todos?: Frame[]; open?: boolean } {
  return JSON.parse(readFileSync(join(state, "threads", `${id}.json`), "utf8"));
}

test("after the bridge restarts a thread shows its conversation without starting Cursor, and goes on when it gets a message", async (t) => {
  const state = await rig(t);
  const session = await createThread({}, state.phone);
  await runTurn(state.phone, session, "use a tool");
  await state.phone.call("session.set_mode", { session_id: session, mode: "plan" });
  await state.restart();
  const before = calls(state.agentDir).length;

  // The models and commands are known at once, from what was kept.
  assert.deepEqual((await state.phone.call("model.options", { profile: "cursor" })).providers[0].models, models);
  assert.deepEqual((await state.phone.call("model.options", { profile: "cursor" })).model_levels.deep, ["none", "low", "medium", "high", "xhigh"]);
  assert.equal((await state.phone.call("commands.catalog", { profile: "cursor" })).pairs.length, 5);
  const resumed = await state.phone.call("session.resume", { session_id: session });
  assert.deepEqual(
    resumed.messages.map((message: Frame) => message.role),
    ["user", "assistant", "tool", "tool", "assistant"],
  );
  assert.equal(resumed.messages.at(-1).text, "pong: use a tool");
  assert.equal(resumed.running, false);
  // The mode is still the thread's.
  assert.equal(resumed.info.mode, "plan");
  assert.equal(calls(state.agentDir).length, before);

  const events = await runTurn(state.phone, session, "mode");
  assert.equal(events.at(-1).payload.text, "mode=plan");
  // What Cursor sends again of the conversation as it loads the session is not shown a second time.
  assert.equal(streamedText(events), "mode=plan");
  assert.deepEqual(tools(events), []);
  assert.deepEqual(methods(calls(state.agentDir).slice(before)), ["initialize", "cursor/list_available_models", "session/load", "session/set_mode", "session/prompt"]);
});

test("a thread whose file a power cut left empty comes back from the file its last save replaced, on the same Cursor session; the empty one is kept aside at the next save", async (t) => {
  const state = await rig(t);
  const session = await createThread({}, state.phone);
  await runTurn(state.phone, session, "use a tool");
  await runTurn(state.phone, session, "use a tool");
  const path = join(state.stateDir, "threads", `${session}.json`);
  const kept = threadFile(state.stateDir, session);
  // Nothing waits for a save to be on the disk: after a power cut the file can be empty.
  await state.restart(() => writeFileSync(path, ""));
  const resumed = await state.phone.call("session.resume", { session_id: session });
  // The save before the last: the first turn whole at least, never an empty thread.
  assert.ok(resumed.messages.length >= 5, `messages: ${resumed.messages.length}`);
  const shown = (message: Frame) => [message.role, message.text ?? message.name];
  assert.deepEqual(resumed.messages.slice(0, 5).map(shown), kept.messages.slice(0, 5).map(shown));
  await runTurn(state.phone, session, "use a tool");
  assert.ok(threadFile(state.stateDir, session).messages.length > kept.messages.length);
  assert.equal(readdirSync(join(state.stateDir, "threads")).filter((name) => name.startsWith(`${session}.json.corrupt-`)).length, 1);
  assert.notEqual(readFileSync(`${path}.bak`, "utf8"), "");
});

test("a thread's to-do list is kept with it: a change to one item after the bridge restarted, or after the thread was removed and taken up again, shows the whole list", async (t) => {
  const state = await rig(t);
  const session = await createThread({}, state.phone);
  await runTurn(state.phone, session, "todos");
  assert.deepEqual(threadFile(state.stateDir, session).todos, [
    { id: "a", content: "make a.txt", status: "completed" },
    { id: "b", content: "make b.txt", status: "in_progress" },
    { id: "c", content: "make c.txt", status: "pending" },
  ]);
  const whole = { output: "✓ make a.txt\n✓ make b.txt\n○ make c.txt" };

  await state.restart();
  await state.phone.call("session.resume", { session_id: session });
  // Cursor sends the one item that changed.
  const rows = tools(await runTurn(state.phone, session, "moretodos"));
  assert.deepEqual(
    rows.map((row) => [row.type, row.context]),
    [
      ["tool.start", "2 of 3 done"],
      ["tool.complete", "2 of 3 done"],
    ],
  );
  assert.deepEqual(rows[1].result, whole);

  // Removed and taken up again while its process still runs.
  assert.deepEqual(await state.phone.call("thread.delete", { thread: session }), {});
  await state.phone.call("session.adopt", { profile: "cursor", session_id: session, mode: "continue" });
  const again = tools(await runTurn(state.phone, session, "moretodos"));
  assert.deepEqual([again[1].context, again[1].result], ["2 of 3 done", whole]);
});

test("a thread's file is written when a turn starts and after each tool row, and a bridge stopped mid-turn keeps what was said, marked interrupted", async (t) => {
  const state = await rig(t);
  const session = await createThread({}, state.phone);
  await state.phone.call("prompt.submit", { session_id: session, text: "use a tool, then sleep" });
  // The turn is still running: Cursor is at its third tool call, which stays open.
  await until(() => tools(state.phone.events(session)).filter((row) => row.type === "tool.start").length === 3, "the third row has started");
  // As a bridge killed here would leave it: the message and the rows so far.
  const kept = threadFile(state.stateDir, session).messages;
  assert.deepEqual(
    kept.map((message) => [message.role, message.name ?? message.text]),
    [
      ["user", "use a tool, then sleep"],
      ["assistant", "I'll make notes.txt. "],
      ["tool", "patch"],
      ["tool", "terminal"],
    ],
  );

  // Stopped, not killed: the turn is first ended as interrupted, with its open row closed.
  await state.restart();
  const resumed = await state.phone.call("session.resume", { session_id: session });
  assert.equal(resumed.running, false);
  assert.deepEqual(
    resumed.messages.map((message: Frame) => message.role),
    ["user", "assistant", "tool", "tool", "tool", "assistant"],
  );
  assert.deepEqual(JSON.parse(resumed.messages[4].content), { status: "error", error: commandLeftText });
  assert.deepEqual(resumed.messages[5].display_metadata, { interrupted: true });

  // The same for text that was only streaming.
  const second = await createThread({}, state.phone);
  await state.phone.call("prompt.submit", { session_id: second, text: "slow" });
  await until(() => ofType(state.phone.events(second), "message.delta").length >= 3, "some of the reply has come");
  await state.restart();
  const last = (await state.phone.call("session.resume", { session_id: second })).messages.at(-1);
  assert.equal(last.role, "assistant");
  assert.match(last.text, /^word0 word1 word2 /);
  assert.deepEqual(last.display_metadata, { interrupted: true });
});

test("a session Cursor does not have gets a new one at the thread's next message, and the thread keeps its id", async (t) => {
  const state = await rig(t);
  // A thread that never got a message: Cursor keeps nothing of its session.
  const unused = await createThread({}, state.phone);
  const talked = await createThread({}, state.phone);
  await runTurn(state.phone, talked, "hello");
  await state.restart();
  // Opening the thread starts nothing.
  let before = calls(state.agentDir).length;
  await state.phone.call("session.resume", { session_id: unused });
  assert.equal(calls(state.agentDir).length, before);
  const events = await runTurn(state.phone, unused, "hello at last");
  assert.equal(events.at(-1).payload.text, "pong: hello at last");
  // Nothing is said of it: there was no conversation to lose.
  assert.deepEqual(notices(events), []);
  const made = calls(state.agentDir).slice(before);
  assert.deepEqual(methods(made), ["initialize", "cursor/list_available_models", "session/load", "session/new", "session/set_mode", "session/prompt"]);
  const fresh = made[5].params.sessionId;
  assert.notEqual(fresh, unused);
  assert.equal(made[2].params.sessionId, unused);
  // The thread's file notes the session it talks to now.
  assert.equal(threadFile(state.stateDir, unused).session, fresh);
  assert.equal(threadFile(state.stateDir, talked).session, undefined);

  // Also across another restart: the thread is routed by the new session.
  await state.restart();
  await state.phone.call("session.resume", { session_id: unused });
  before = calls(state.agentDir).length;
  assert.equal(await reply(unused, "and again", state.phone), "pong: and again");
  const loaded = calls(state.agentDir).slice(before);
  assert.deepEqual(methods(loaded), ["initialize", "cursor/list_available_models", "session/load", "session/set_mode", "session/prompt"]);
  assert.equal(loaded[2].params.sessionId, fresh);
  assert.deepEqual(
    (await state.phone.call("session.resume", { session_id: unused })).messages.map((message: Frame) => message.text),
    ["hello at last", "pong: hello at last", "and again", "pong: and again"],
  );

  // A thread that had a conversation which Cursor has lost says so.
  await state.restart();
  await state.phone.call("session.resume", { session_id: talked });
  rmSync(join(state.agentDir, `${talked}.json`));
  const lost = await runTurn(state.phone, talked, "are you there");
  assert.deepEqual(notices(lost), ["Cursor no longer has this conversation, so it starts afresh from here. What was said before is still shown above."]);
  assert.equal(lost.at(-1).payload.text, "pong: are you there");
  assert.equal((await state.phone.call("session.resume", { session_id: talked })).messages[0].text, "hello");
});

test("a command in a thread whose Cursor conversation was started afresh, which says the new conversation's id, is known as that thread (feature senders)", async (t) => {
  const state = await rig(t);
  const unused = await createThread({}, state.phone);
  const other = await createThread({}, state.phone);
  await state.restart();
  await state.phone.call("session.resume", { session_id: unused });
  await runTurn(state.phone, unused, "hello at last");
  const fresh = threadFile(state.stateDir, unused).session as string;
  assert.notEqual(fresh, unused);
  // What \`portals send\` in that thread passes as \`from\` (CURSOR_CONVERSATION_ID): Cursor's id for it now.
  await state.phone.call("session.resume", { session_id: other });
  await state.phone.call("thread.send", { thread: other, text: "from the afresh thread", from: fresh });
  await until(async () => (await state.phone.call("session.resume", { session_id: other })).messages.length > 0, "the message is in");
  const first = (await state.phone.call("session.resume", { session_id: other })).messages[0];
  assert.equal(first.text, `[Portals: from Cursor · "hello at last" (thread ${unused})]\nfrom the afresh thread`);
  assert.deepEqual(first.from, { agent: "cursor", agent_name: "Cursor", title: "hello at last", thread: unused });
});

test("any other error from loading a session fails the turn, and the next message tries again", async (t) => {
  const state = await rig(t, { features: ["loadfails"] });
  const session = await createThread({}, state.phone);
  await runTurn(state.phone, session, "hello");
  await state.restart();
  await state.phone.call("session.resume", { session_id: session });
  const failed = (await runTurn(state.phone, session, "and on")).at(-1).payload;
  assert.equal(failed.status, "error");
  assert.equal(failed.text, "Cursor could not take this conversation up again: Internal error (The stand-in could not read the session.)");
  // No new session was made in its place: the conversation is still Cursor's.
  assert.ok(!calls(state.agentDir).some((call) => call.method === "session/new" && call.pid !== calls(state.agentDir)[0].pid));
  assert.equal(await reply(session, "once more", state.phone), "pong: once more");
  assert.equal(threadFile(state.stateDir, session).session, undefined);
});

// MARK: Not signed in

test("a Cursor that is not signed in says so with what to do, and its process is stopped so that the next try sees a sign-in", async (t) => {
  const state = await rig(t);
  const session = await createThread({}, state.phone);
  await runTurn(state.phone, session, "hello");
  await state.restart();
  await state.phone.call("session.resume", { session_id: session });

  // Signed out since: a process that starts so stays so.
  writeFileSync(join(state.agentDir, "signed-out"), "");
  let before = calls(state.agentDir).length;
  await assert.rejects(createThread({}, state.phone), (error: RpcFailure) => error.message === notSignedInText);
  assert.equal(notSignedInText, `Cursor is not signed in on this ${machineWord()}. Run \`cursor-agent login\` in a terminal there.`);
  const refused = calls(state.agentDir).slice(before);
  assert.deepEqual(methods(refused), ["initialize", "cursor/list_available_models", "session/new"]);
  await until(() => !alive(refused[0].pid), "the signed-out process has gone");

  // The same from loading a session: the turn fails with the sentence.
  before = calls(state.agentDir).length;
  const failed = (await runTurn(state.phone, session, "and on")).at(-1).payload;
  assert.equal(failed.status, "error");
  assert.equal(failed.text, notSignedInText);
  const loading = calls(state.agentDir).slice(before);
  assert.deepEqual(methods(loading), ["initialize", "cursor/list_available_models", "session/load"]);
  await until(() => !alive(loading[0].pid), "the signed-out process has gone");

  // Signed in meanwhile: the next try starts a process that sees it.
  rmSync(join(state.agentDir, "signed-out"));
  assert.equal(await reply(session, "and now", state.phone), "pong: and now");
  assert.match(await createThread({}, state.phone), /^standin-/);
});

test("a reply that ends with Cursor's request to sign in fails the turn with the same sentence", async (t) => {
  const state = await rig(t);
  const session = await createThread({}, state.phone);
  const pid = Number(/pid=(\d+)/.exec(await reply(session, "where", state.phone))?.[1]);
  const failed = (await runTurn(state.phone, session, "signin")).at(-1).payload;
  assert.equal(failed.status, "error");
  assert.equal(failed.text, notSignedInText);
  // That process lost its sign-in for good: the next message starts another.
  await until(() => !alive(pid), "the process has gone");
  assert.notEqual(Number(/pid=(\d+)/.exec(await reply(session, "where", state.phone))?.[1]), pid);
});

test("a turn Cursor could not finish fails with what it said, not as a reply; its line after turns that worked, and one only like it, do not", async (t) => {
  const state = await rig(t);
  const session = await createThread({}, state.phone);
  const ended = async (word: string) => {
    const events = await runTurn(state.phone, session, word);
    return { end: events.at(-1).payload, said: events.filter((event: any) => event.type === "message.delta").map((event: any) => event.payload.text).join("") };
  };
  const limit = await ended("planlimit");
  assert.deepEqual([limit.end.status, limit.end.text, limit.said], ["error", "Cursor: Upgrade your plan to continue.", "Half an answer"]);
  const error = await ended("turnerror");
  assert.deepEqual([error.end.status, error.end.text, error.said], ["error", "Cursor stopped the turn: ConnectError: [unavailable] network is down", "Half an answer"]);
  const junk = await ended("junkend");
  assert.deepEqual([junk.end.status, junk.end.text], ["complete", "Half an answer"]);
  const word = await ended("errorword");
  assert.deepEqual([word.end.status, word.end.text], ["complete", "\n\nError: is a word in this reply."]);
  // The thread keeps what was said before each failure, and the failure itself.
  const kept = JSON.parse(readFileSync(join(state.stateDir, "threads", `${session}.json`), "utf8")).messages;
  assert.ok(kept.some((message: any) => message.role === "assistant" && String(message.text).includes("Half an answer")));
});

// MARK: Folders

test("the folders Cursor worked in, at the desk or through ACP, are offered for new threads", async (t) => {
  const cursorHome = temporaryHome();
  const project = temporaryHome();
  const session = join(cursorHome, "acp-sessions", "s-1");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "meta.json"), JSON.stringify({ schemaVersion: 1, cwd: project, title: "From the desk" }));
  t.after(() => {
    rmSync(cursorHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
  const state = await rig(t, { cursorHome, temporaryFolders: [] });
  await until(async () => ((await state.phone.call("folders.list")).folders ?? []).some((folder: { path: string }) => realpathSync(folder.path) === realpathSync(project)), "Cursor's folder on the list");
});

// MARK: Forks

const adoptionAliases = {
  relative: (id: string) => `./${id}`,
  parent: (id: string) => `unused/../${id}`,
  case: (id: string) => id.toUpperCase(),
  trailing: (id: string) => `${id}/`,
};

for (const [kind, alias] of Object.entries(adoptionAliases)) test(`Cursor adoption rejects the ${kind} alias instead of losing source policy`, async (t) => {
  const cursorHome = temporaryHome();
  t.after(() => rmSync(cursorHome, { recursive: true, force: true }));
  const state = await rig(t, { cursorHome });
  const source = await createThread({}, state.phone);
  await state.phone.call("session.set_mode", { session_id: source, mode: "ask" });
  assert.equal(await reply(source, "first words", state.phone), "pong: first words");
  for (const mode of ["fork", "read", "continue"]) {
    await assert.rejects(state.phone.call("session.adopt", { profile: "cursor", session_id: alias(source), mode }).then(async (result) => {
      if (mode === "fork") {
        await reply(result.session_id, "alias proof", state.phone);
        const native = calls(state.agentDir).filter((call) => call.method === "session/set_mode" && call.params.sessionId === result.session_id).at(-1);
        t.diagnostic(`unexpected alias fork: thread mode=${result.info.mode}, native mode=${native?.params.modeId}`);
      }
      return result;
    }), (error: RpcFailure) => error.code === -32602);
  }
});

test("Cursor adoption accepts an exact uppercase identity", async (t) => {
  const state = await rig(t);
  const source = await createThread({}, state.phone);
  assert.equal(await reply(source, "first words", state.phone), "pong: first words");
  const uppercase = `Upper-${source}`;
  writeFileSync(join(state.stateDir, "threads", `${uppercase}.json`), readFileSync(join(state.stateDir, "threads", `${source}.json`)));
  const adopted = await state.phone.call("session.adopt", { profile: "cursor", session_id: uppercase, mode: "read" });
  assert.equal(adopted.session_id, uppercase, "an opaque native identity is not required to be lowercase");
  assert.ok(JSON.stringify((await state.phone.call("session.resume", { session_id: uppercase })).messages).includes("first words"));
});

for (const mode of ["ask", "full"]) test(`Cursor canonical forks keep ${mode} for active and removed source threads`, async (t) => {
  const cursorHome = temporaryHome();
  t.after(() => rmSync(cursorHome, { recursive: true, force: true }));
  const state = await rig(t, { cursorHome });
  const source = await createThread({}, state.phone);
  await state.phone.call("session.set_mode", { session_id: source, mode });
  assert.equal(await reply(source, "first words", state.phone), "pong: first words");
  for (const removed of [false, true]) {
    if (removed) await state.phone.call("thread.delete", { thread: source });
    const fork = await state.phone.call("session.adopt", { profile: "cursor", session_id: source, mode: "fork" });
    assert.equal(fork.info.mode, mode);
    assert.equal(await reply(fork.session_id, "mode", state.phone), `mode=${mode === "ask" ? "ask" : "agent"}`);
    assert.match(await reply(fork.session_id, "where forced heard", state.phone), new RegExp(`forced=${mode === "full"} heard=3`));
  }
});

test("Cursor adoption rejects unsafe path components", async (t) => {
  const state = await rig(t);
  for (const unsafe of ["", ".", "..", "...", "/", "\\", "\0"]) await assert.rejects(state.provider.adopt(unsafe, "read"));
});

test("Cursor fork waits for an interrupted native prompt to answer before copying its store", async (t) => {
  const cursorHome = temporaryHome();
  t.after(() => rmSync(cursorHome, { recursive: true, force: true }));
  const state = await rig(t, { cursorHome, interruptGraceMs: 150 });
  const [source, other] = [await createThread({}, state.phone), await createThread({}, state.phone)];
  assert.equal(await reply(source, "first words", state.phone), "pong: first words");
  const mark = state.phone.frames.length;
  const answers = (session: string) => timeline(state.agentDir).filter((entry) => entry.event === "answered" && entry.method === "session/prompt" && entry.session === session).length;
  let sourceStarted = false, otherStarted = false;
  try {
    await state.phone.call("prompt.submit", { session_id: other, text: "sleep" });
    otherStarted = true;
    await eventFrom(state.phone, mark, "tool.start", other);
    await state.phone.call("prompt.submit", { session_id: source, text: "stubborn" });
    sourceStarted = true;
    await eventFrom(state.phone, mark, "message.delta", source);
    await state.phone.call("session.interrupt", { session_id: source });
    assert.equal((await eventFrom(state.phone, mark, "message.complete", source)).payload.status, "interrupted");
    assert.equal(timeline(state.agentDir).filter((entry) => entry.event === "got" && entry.method === "session/prompt" && entry.session === source).length, 2);
    assert.equal(answers(source), 1, "Cursor still owes the stopped prompt's answer");
    const native = readdirSync(join(cursorHome, "acp-sessions")).sort();
    const snapshots = () => readdirSync(join(state.stateDir, "threads")).filter((name) => name.endsWith(".json")).sort();
    const before = snapshots();
    await assert.rejects(state.phone.call("session.adopt", { profile: "cursor", session_id: source, mode: "fork" }), /at work/);
    assert.deepEqual(readdirSync(join(cursorHome, "acp-sessions")).sort(), native);
    assert.deepEqual(snapshots(), before);
    writeFileSync(join(state.agentDir, "let-go"), "");
    await until(() => answers(source) === 2, "Cursor answered the interrupted prompt");
    await until(async () => {
      try {
        const forked = await state.phone.call("session.adopt", { profile: "cursor", session_id: source, mode: "fork" });
        assert.notEqual(forked.session_id, source);
        return true;
      } catch (error) {
        if (error instanceof RpcFailure && error.code === -32602 && /at work/.test(error.message)) return false;
        throw error;
      }
    }, "the settled native store can be forked");
  } finally {
    writeFileSync(join(state.agentDir, "let-go"), "");
    try {
      if (sourceStarted) await until(() => answers(source) === 2, "Cursor answered before cleanup");
    } finally {
      if (otherStarted) {
        await state.phone.call("session.interrupt", { session_id: other });
        await eventFrom(state.phone, mark, "message.complete", other);
        await until(() => answers(other) === 1, "the other prompt answered before cleanup");
      }
    }
  }
});

test("Fork thread: a new thread with the conversation so far, on a copy of Cursor's session that goes on from it; the thread forked from is left as it was", async (t) => {
  const cursorHome = temporaryHome();
  t.after(() => rmSync(cursorHome, { recursive: true, force: true }));
  const state = await rig(t, { cursorHome });
  const agents = (await state.phone.call("profiles.list")).profiles;
  assert.deepEqual(agents.find((agent: { name: string }) => agent.name === "cursor")?.adopt_modes, ["continue", "fork", "read"]);
  const source = await createThread({}, state.phone);
  assert.equal(await reply(source, "first words", state.phone), "pong: first words");
  const forked = await state.phone.call("session.adopt", { profile: "cursor", session_id: source, mode: "fork" });
  const fork = forked.session_id;
  assert.notEqual(fork, source);
  // Cursor's session for it is a copy, under the fork's id, with the thread's folder.
  const meta = JSON.parse(readFileSync(join(cursorHome, "acp-sessions", fork, "meta.json"), "utf8"));
  assert.equal(realpathSync(meta.cwd), realpathSync(cwd));
  // The fork shows the conversation so far, and Cursor goes on from it: the stand-in says what it has heard.
  const history = await state.phone.call("session.resume", { session_id: fork });
  assert.ok(JSON.stringify(history.messages).includes("first words"));
  assert.equal(await reply(fork, "and then", state.phone), "pong: and then");
  const kept = JSON.parse(readFileSync(join(cursorHome, "acp-sessions", fork, "store.json"), "utf8"));
  assert.deepEqual(kept.said.map((entry: { text: string }) => entry.text).filter((text: string) => !text.startsWith("pong")), ["first words", "and then"]);
  // The thread forked from never heard the fork's message.
  const original = JSON.parse(readFileSync(join(cursorHome, "acp-sessions", source, "store.json"), "utf8"));
  assert.ok(!JSON.stringify(original.said).includes("and then"));
});

test("a fork of a thread taken off the list keeps its mode, and such a thread comes back as it was, even with nothing of Cursor's to say its folder", async (t) => {
  const cursorHome = temporaryHome();
  t.after(() => rmSync(cursorHome, { recursive: true, force: true }));
  const state = await rig(t, { cursorHome });
  const source = await createThread({}, state.phone);
  await state.phone.call("session.set_mode", { session_id: source, mode: "ask" });
  assert.equal(await reply(source, "first words", state.phone), "pong: first words");
  assert.deepEqual(await state.phone.call("thread.delete", { thread: source }), {});
  const forked = await state.phone.call("session.adopt", { profile: "cursor", session_id: source, mode: "fork" });
  assert.equal(forked.info.mode, "ask");

  // A thread from before the file kept its folder, whose session Cursor has no meta for: it comes back from its record.
  const old = await createThread({}, state.phone);
  assert.equal(await reply(old, "older words", state.phone), "pong: older words");
  assert.deepEqual(await state.phone.call("thread.delete", { thread: old }), {});
  const file = join(state.stateDir, "threads", `${old}.json`);
  const kept = JSON.parse(readFileSync(file, "utf8"));
  delete kept.cwd;
  writeFileSync(file, JSON.stringify(kept));
  rmSync(join(cursorHome, "acp-sessions", old), { recursive: true, force: true });
  const back = await state.phone.call("session.adopt", { profile: "cursor", session_id: old, mode: "continue" });
  assert.equal(back.session_id, old);
  assert.ok(JSON.stringify((await state.phone.call("session.resume", { session_id: old })).messages).includes("older words"));
});

test("a thread taken off the list that was only read is continued when it comes back", async (t) => {
  const state = await rig(t);
  const session = await createThread({}, state.phone);
  assert.equal(await reply(session, "first words", state.phone), "pong: first words");
  assert.deepEqual(await state.phone.call("thread.delete", { thread: session }), {});
  await state.restart(() => {
    const path = join(state.home, "state", "removed.json");
    const removed = JSON.parse(readFileSync(path, "utf8"));
    const entries = Array.isArray(removed) ? removed : (removed.threads ?? removed.removed ?? Object.values(removed));
    const entry = (Array.isArray(entries) ? entries : []).find((item: any) => (item.thread ?? item).id === session);
    (entry.thread ?? entry).readOnly = true;
    writeFileSync(path, JSON.stringify(removed));
  });
  await state.phone.call("session.adopt", { profile: "cursor", session_id: session, mode: "continue" });
  assert.equal(await reply(session, "and now", state.phone), "pong: and now");
});

test("a Cursor that does not list its models: a level chosen with a model whose levels were not known yet is set once selecting it says them", async (t) => {
  const { phone } = await rig(t, { features: ["nolist"] });
  const session = await createThread({}, phone);
  await phone.call("config.set", { key: "model", value: "small --provider cursor --session", session_id: session });
  await phone.call("config.set", { key: "reasoning", value: "high", session_id: session });
  assert.match(await reply(session, "model", phone), /^model=small effort=high\b/);
});

test("models kept by a bridge before levels not known were marked: one with none is taken as not known until Cursor lists them", async (t) => {
  const stateDir = temporaryHome();
  writeFileSync(join(stateDir, "agent.json"), JSON.stringify({ models: [{ id: "auto", name: "Auto" }, { id: "small", name: "Small" }, { id: "large", name: "Large", level: { option: "effort", values: { low: "low", high: "high" } } }], commands: [] }));
  const { phone } = await rig(t, { stateDir });
  const options = await phone.call("model.options", { profile: "cursor" });
  assert.deepEqual(options.model_levels, { default: [], large: ["low", "high"] });
});

test("a fork whose conversation cannot be written is refused, and leaves no copy of Cursor's session", async (t) => {
  const cursorHome = temporaryHome();
  t.after(() => rmSync(cursorHome, { recursive: true, force: true }));
  const state = await rig(t, { cursorHome });
  const source = await createThread({}, state.phone);
  assert.equal(await reply(source, "first words", state.phone), "pong: first words");
  const before = readdirSync(join(cursorHome, "acp-sessions")).sort();
  const threads = join(state.stateDir, "threads");
  chmodSync(threads, 0o500);
  try {
    await assert.rejects(state.phone.call("session.adopt", { profile: "cursor", session_id: source, mode: "fork" }), /could not be copied/);
  } finally {
    chmodSync(threads, 0o700);
  }
  assert.deepEqual(readdirSync(join(cursorHome, "acp-sessions")).sort(), before);
});

// MARK: Subagents

test("a subagent is on the subagents line, its card names it, and nothing it says is the thread's reply", async () => {
  const session = await createThread();
  await client.call("prompt.submit", { session_id: session, text: "subagent" });
  const request = await client.nextRequest();
  assert.equal(request.method, "approval");
  const started = client.events(session).find((event) => event.type === "subagent.start");
  assert.ok(started, "the subagent's start");
  assert.deepEqual(
    [started.payload.goal, started.payload.role, started.payload.status, started.payload.background, started.payload.can_stop],
    ["Count the files", "General purpose", "running", false, false],
  );
  assert.equal(request.params.subagent, started.payload.subagent_id);
  assert.equal(request.params.command, "ls");
  client.answer(request.id, { choice: "once" });
  const done = await client.nextEvent("message.complete", session);
  assert.equal(done.payload.text, "The subagent counted 3 files.");
  const complete = client.events(session).find((event) => event.type === "subagent.complete");
  assert.deepEqual([complete?.payload.status, complete?.payload.result, complete?.payload.tool_uses], ["completed", "There are 3 files.", 1]);
  // Its command is its own, not a row of the thread's.
  assert.ok(!tools(client.events(session)).some((row) => row.name === "terminal"));
});

test("a subagent's card is withdrawn when it ends, it asks nobody once ended, and one told of outside a turn is not on the line", async () => {
  const session = await createThread();
  await client.call("prompt.submit", { session_id: session, text: "subquit" });
  const request = await client.nextRequest();
  assert.equal(typeof request.params.subagent, "string");
  assert.deepEqual((await client.nextEvent("request.cancel", session)).payload, { id: request.id, reason: "withdrawn" });
  const done = await client.nextEvent("message.complete", session);
  // The open card answered Cursor cancelled, and the ended subagent's next question was too, with no card.
  assert.equal(done.payload.text, "first=cancelled again=cancelled grand=cancelled question=cancelled");
  assert.equal(client.events(session).filter((event) => event.type === "subagent.complete").at(-1)?.payload.status, "stopped");
  assert.equal(client.events(session).filter((event) => event.type === "subagent.start").length, 1);

  const late = await createThread();
  await runTurn(client, late, "latespawn");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!client.events(late).some((event) => event.type === "subagent.start"));
});

test("Stop with a subagent at work ends it with the turn", async () => {
  const session = await createThread();
  await client.call("prompt.submit", { session_id: session, text: "subagent long" });
  client.answer((await client.nextRequest()).id, { choice: "once" });
  await until(() => client.events(session).some((event) => event.type === "subagent.start"), "the subagent's start");
  await client.call("session.interrupt", { session_id: session });
  const ended = await client.nextEvent("message.complete", session);
  assert.equal(ended.payload.status, "interrupted");
  assert.equal(client.events(session).find((event) => event.type === "subagent.complete")?.payload.status, "stopped");
});

// MARK: Images

test("an image goes with the message; one Cursor cannot read is left out with a notice", async () => {
  const session = await createThread();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.deepEqual(await client.call("image.attach_bytes", { session_id: session, content_base64: png.toString("base64"), filename: "shot.png" }), { attached: true, name: "shot.png" });
  assert.equal(await reply(session, "look"), "pong: look (1 image)");
  const prompt = calls(agentDir).findLast((call) => call.method === "session/prompt" && call.params.sessionId === session);
  assert.deepEqual(prompt?.params.prompt, [
    { type: "text", text: "look" },
    { type: "image", mimeType: "image/png", data: png.toString("base64") },
  ]);

  await client.call("image.attach_bytes", { session_id: session, content_base64: Buffer.from("not an image the agents read").toString("base64"), filename: "photo.heic" });
  const events = await runTurn(client, session, "and this");
  assert.deepEqual(notices(events), ["An image was left out: Cursor reads JPEG, PNG, GIF and WebP images."]);
  assert.equal(events.at(-1).payload.text, "pong: and this");
});

// MARK: A bridge that was killed

/** The processes a bridge has noted as running. */
function noted(state: string): { pid: number; at: number; bridge: number }[] {
  return JSON.parse(readFileSync(join(state, "processes.json"), "utf8"));
}

test("a bridge killed in the middle of a turn: the next one ends the Cursor it left running, the turn is kept as interrupted, and the thread goes on", async (t) => {
  // As Cursor, the stand-in does not end when its input closes.
  const options = { agentDir: agentFolder(), stateDir: temporaryHome(), features: ["lingers"] };
  const script = fileURLToPath(new URL("./cursor-killed-bridge.ts", import.meta.url));
  const bridgeProcess = spawn(process.execPath, [script, agentScript, options.stateDir, cwd, "hello", "use a tool, then sleep"], { env: standinEnv(options), stdio: ["ignore", "pipe", "inherit"] });
  let left = 0;
  let own: CursorProvider | null = null;
  t.after(async () => {
    await own?.close();
    for (const pid of [bridgeProcess.pid ?? 0, left]) {
      try {
        if (pid > 1) process.kill(pid, "SIGKILL");
      } catch {
        // Gone already, as it should be.
      }
    }
    for (const path of [options.agentDir, options.stateDir]) rmSync(path, { recursive: true, force: true });
  });
  const [line] = await once(bridgeProcess.stdout.setEncoding("utf8"), "data");
  const id: string = JSON.parse(line).thread;
  // The turn is at its third tool call, a command that runs on.
  await until(() => existsSync(join(options.stateDir, "threads", `${id}.json`)) && threadFile(options.stateDir, id).messages.length === 6, "the turn's rows are kept");
  assert.equal(noted(options.stateDir).length, 1);
  left = noted(options.stateDir)[0].pid;

  bridgeProcess.kill("SIGKILL");
  await once(bridgeProcess, "exit");
  await sleep(200);
  assert.ok(alive(left), "the stand-in ended with its bridge, so the test showed nothing");

  // The next bridge, on the same folder.
  own = cursor(options);
  own.start();
  await until(() => !alive(left), "the Cursor that was left running has gone");
  await until(() => noted(options.stateDir).length === 0, "its note is struck");

  // The thread shows what was kept, with the turn that was cut marked.
  const phone = collector();
  const session = await own.resumeSession({ id, cwd, settings: defaults, title: null }, phone.sink);
  assert.deepEqual(
    (await session.history()).map((message: Frame) => [message.role, message.name ?? message.text, message.display_metadata?.interrupted ?? false]),
    [
      ["user", "hello", false],
      ["assistant", "pong: hello", false],
      ["user", "use a tool, then sleep", false],
      ["assistant", "I'll make notes.txt. ", false],
      ["tool", "patch", false],
      ["tool", "terminal", false],
      ["assistant", "", true],
    ],
  );
  assert.equal(threadFile(options.stateDir, id).open, undefined);
  // And goes on, on a process of this bridge's own.
  const events = await phone.turn(session, "where");
  assert.match(said(events), /^pid=\d+ cwd=\S+$/);
  assert.notEqual(Number(/pid=(\d+)/.exec(said(events))?.[1]), left);
  assert.deepEqual(noted(options.stateDir).map((note) => note.bridge), [process.pid]);
});

/** A process that heads a group of its own and whose parent has gone, as Cursor is once its bridge was killed. */
async function orphan(): Promise<number> {
  const start = 'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { detached: true, stdio: "ignore" }); child.unref(); console.log(child.pid);';
  return Number((await promisify(execFile)(process.execPath, ["-e", start])).stdout.trim());
}

test("a noted process is ended as left over only when its bridge is gone and it started when the note says", async (t) => {
  const state = temporaryHome();
  const file = join(state, "processes.json");
  const [left, another] = [await orphan(), await orphan()];
  const mine = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { detached: true, stdio: "ignore" });
  t.after(() => {
    for (const pid of [left, another, mine.pid ?? 0]) {
      try {
        if (pid > 1) process.kill(pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    }
    rmSync(state, { recursive: true, force: true });
  });
  assert.ok(left > 1 && another > 1 && mine.pid !== undefined);
  const now = Date.now();
  const kept = { pid: mine.pid, at: now, bridge: process.pid };
  writeFileSync(
    file,
    JSON.stringify([
      // Its bridge is gone: left over.
      { pid: left, at: now, bridge: 4_000_001 },
      // Started at another time than the note says: the id is another process's by now.
      { pid: another, at: now - 3_600_000, bridge: 4_000_001 },
      // Its bridge still runs (this process): a second bridge on the same folder leaves it alone.
      kept,
      // No such process any more.
      { pid: 4_000_002, at: now, bridge: 4_000_001 },
      // Not notes at all.
      "junk",
      { pid: "12", at: now, bridge: 3 },
    ]),
  );
  await new ProcessNotes(file).endLeftovers();
  assert.equal(alive(left), false);
  assert.equal(alive(another), true);
  assert.equal(alive(mine.pid), true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [kept]);
});

test("a noted process is known by its start even when the system and Node read the time zone differently", async (t) => {
  // A zone the system's ps follows and Node's own rules do not, as when one of them is
  // newer than the other about a place that changed its clocks.
  const zone = process.env.TZ;
  process.env.TZ = "<-0130>1:30";
  const state = temporaryHome();
  const file = join(state, "processes.json");
  const left = await orphan();
  t.after(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
    try {
      if (left > 1) process.kill(left, "SIGKILL");
    } catch {
      // Gone already.
    }
    rmSync(state, { recursive: true, force: true });
  });
  assert.ok(left > 1);
  writeFileSync(file, JSON.stringify([{ pid: left, at: Date.now(), bridge: 4_000_001 }]));
  await new ProcessNotes(file).endLeftovers();
  assert.equal(alive(left), false);
});

// MARK: Removed and taken up again

test("a thread at rest is removed, offered again, and taken up with its conversation, without a second load while its process still runs", async () => {
  const session = await createThread();
  await runTurn(client, session, "remember me");
  assert.deepEqual(await client.call("thread.delete", { thread: session }), {});
  const offered = (await client.call("desk.list", { profile: "cursor" })).sessions;
  assert.deepEqual(
    offered.filter((entry: Frame) => entry.id === session).map((entry: Frame) => [entry.title, entry.folder, entry.state]),
    [["remember me", cwd, "closed"]],
  );
  const adopted = await client.call("session.adopt", { profile: "cursor", session_id: session, mode: "continue" });
  assert.equal(adopted.session_id, session);
  const resumed = await client.call("session.resume", { session_id: session });
  assert.deepEqual(
    resumed.messages.map((message: Frame) => message.text),
    ["remember me", "pong: remember me"],
  );
  const before = calls(agentDir).length;
  assert.equal(await reply(session, "still you?"), "pong: still you?");
  // The process that had the session still has it: Cursor would open its store a second time.
  assert.deepEqual(methods(calls(agentDir).slice(before)), ["session/set_mode", "session/prompt"]);
});

// MARK: The portals command

/** The blocks of each prompt Cursor got for `session`, in order. */
function prompts(dir: string, session: string): Frame[][] {
  return calls(dir).filter((call) => call.method === "session/prompt" && call.params.sessionId === session).map((call) => call.params.prompt);
}

/** The note on the `portals` command, as Cursor gets it. */
function note(instructions: string): Frame {
  return { type: "resource", resource: { uri: "portals://guide", mimeType: "text/markdown", text: `A note from Portals, the app this conversation is shown in.\n\n${instructions}` } };
}

test("every process of Cursor's has the bridge's portals command first on its PATH; with agents not told, no note goes with a message", async (t) => {
  // Without the command (a provider given none), the PATH is the bridge's own.
  const plain = await createThread();
  assert.equal(await reply(plain, "path"), `path=${process.env.PATH}`);
  assert.deepEqual(prompts(agentDir, plain), [[{ type: "text", text: "path" }]]);

  // With it, and `fleet.tellAgents` off: the command is there for whoever is told of it.
  const state = await rig(t, { portals: { bin: "/bridge/bin", instructions: null } });
  const session = await createThread({}, state.phone);
  assert.equal(await reply(session, "path", state.phone), `path=/bridge/bin:${process.env.PATH}`);
  assert.deepEqual(prompts(state.agentDir, session), [[{ type: "text", text: "path" }]]);
  assert.equal(threadFile(state.stateDir, session).told, undefined);
  // Another folder's process too.
  const elsewhere = folder();
  t.after(async () => rmSync(elsewhere, { recursive: true, force: true }));
  const phone = collector();
  const other = await thread(state.provider, elsewhere, phone.sink);
  assert.equal(said(await phone.turn(other, "where is your path")).replace(/^pid=\d+ cwd=\S+ /, ""), `path=/bridge/bin:${process.env.PATH}`);
});

test("a thread's first message tells Cursor of the portals command in a note beside it, once, also across a restart of the bridge", async (t) => {
  const state = await rig(t, { portals: { bin: "/bridge/bin", instructions: "About portals." } });
  const session = await createThread({}, state.phone);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  await state.phone.call("image.attach_bytes", { session_id: session, content_base64: png.toString("base64"), filename: "shot.png" });
  const events = await runTurn(state.phone, session, "/review what is here");
  // The user's words are a block of their own, as written, and the note comes after the message.
  assert.deepEqual(prompts(state.agentDir, session), [
    [{ type: "text", text: "/review what is here" }, { type: "image", mimeType: "image/png", data: png.toString("base64") }, note("About portals.")],
  ]);
  // Nothing of the note is in the thread: not in the reply, the title or the conversation kept.
  assert.equal(events.at(-1).payload.text, "pong: /review what is here (1 image)");
  assert.deepEqual(
    ofType(events, "session.title").map((event) => event.payload.title),
    ["/review what is here"],
  );
  assert.deepEqual(
    (await state.phone.call("session.resume", { session_id: session })).messages.map((message: Frame) => message.text),
    ["/review what is here\n@image:shot.png", "pong: /review what is here (1 image)"],
  );
  // Noted once Cursor answered that prompt.
  assert.equal(threadFile(state.stateDir, session).told, true);

  await runTurn(state.phone, session, "and again");
  assert.deepEqual(prompts(state.agentDir, session)[1], [{ type: "text", text: "and again" }]);
  // A bridge restart does not send it again.
  await state.restart();
  await state.phone.call("session.resume", { session_id: session });
  await runTurn(state.phone, session, "after the restart");
  assert.deepEqual(prompts(state.agentDir, session)[2], [{ type: "text", text: "after the restart" }]);
  assert.equal(threadFile(state.stateDir, session).told, true);

  // A first turn that failed does: Cursor kept nothing of it.
  const failing = await createThread({}, state.phone);
  assert.equal((await runTurn(state.phone, failing, "fail now")).at(-1).payload.status, "error");
  assert.equal(threadFile(state.stateDir, failing).told, undefined);
  await runTurn(state.phone, failing, "now then");
  assert.deepEqual(prompts(state.agentDir, failing), [
    [{ type: "text", text: "fail now" }, note("About portals.")],
    [{ type: "text", text: "now then" }, note("About portals.")],
  ]);
  await runTurn(state.phone, failing, "and on");
  assert.deepEqual(prompts(state.agentDir, failing)[2], [{ type: "text", text: "and on" }]);

  // The go-ahead the bridge sends after an accepted plan is the same turn's second prompt, and carries none.
  const planning = await createThread({}, state.phone);
  await state.phone.call("session.set_mode", { session_id: planning, mode: "plan" });
  await state.phone.call("prompt.submit", { session_id: planning, text: "makeplan" });
  const card = await state.phone.nextRequest();
  state.phone.answer(card.id, { choice: "once" });
  await state.phone.nextEvent("message.complete", planning);
  assert.deepEqual(prompts(state.agentDir, planning), [[{ type: "text", text: "makeplan" }, note("About portals.")], [{ type: "text", text: "Go ahead with the plan." }]]);

  // A thread that gets a new session, Cursor having lost its first, tells the new one.
  await state.restart();
  await state.phone.call("session.resume", { session_id: session });
  rmSync(join(state.agentDir, `${session}.json`));
  await runTurn(state.phone, session, "are you there");
  const fresh = threadFile(state.stateDir, session).session!;
  assert.notEqual(fresh, session);
  assert.deepEqual(prompts(state.agentDir, fresh), [[{ type: "text", text: "are you there" }, note("About portals.")]]);
  assert.equal(threadFile(state.stateDir, session).told, true);
});

// MARK: The version check

/**
 * A program standing in for `cursor-agent` itself: `--version` prints what the file
 * `version` beside it holds, and anything else runs the stand-in agent. With `own`, it
 * says itself where the stand-in keeps its notes, for a bridge that starts it knowing
 * only its path.
 */
function dummyCursor(dir: string, version: string, own = false): string {
  const program = join(dir, "cursor-agent");
  writeFileSync(join(dir, "version"), `${version}\n`);
  const settings = own ? `export ACP_STANDIN_DIR="${dir}" ACP_STANDIN_FEATURES=cursor\n` : "";
  writeFileSync(program, `#!/bin/sh\nif [ "$1" = "--version" ]; then cat "${dir}/version"; exit 0; fi\n${settings}exec "${process.execPath}" "${agentScript}"\n`);
  chmodSync(program, 0o755);
  return program;
}

/** What the bridge logs of Cursor's version from here on, a line each, without the time each starts with. */
function versionLines(t: TestContext): () => string[] {
  const written = t.mock.method(process.stderr, "write", () => true);
  setLogLevel("info");
  t.after(() => setLogLevel("silent"));
  return () =>
    written.mock.calls
      .map((call) => String(call.arguments[0]).trimEnd().split(" ").slice(1).join(" "))
      .filter((line) => /Cursor (was not found|is \d+\.\d+\.\d+[;,]|\d+\.\d+\.\d+$)/.test(line));
}

const anotherRelease = (version: string) => `warn  Cursor is ${version}; this bridge was tested with ${testedCursorVersion}. Check a thread before relying on it.`;
const newerRelease = (version: string) => `warn  Cursor is ${version}, newer than this bridge was tested with (${testedCursorVersion}). Check a thread before relying on it.`;

test("at start the bridge logs Cursor's version: an error when the program does not run, a warning for another release, a line for the tested one", async (t) => {
  const dir = agentFolder();
  const program = dummyCursor(dir, "2026.10.09-0a1b2c3");
  const made: CursorProvider[] = [];
  t.after(async () => {
    for (const provider of made) await provider.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const start = (command: string, checkVersion?: boolean) => {
    made.push(new CursorProvider({ command, directory: join(dir, "state"), idleMs: 60_000, env: process.env, checkVersion, cursorHome: null }));
    made.at(-1)!.start();
  };
  const lines = versionLines(t);
  // Told not to (tests): nothing is run, and nothing said.
  start(join(dir, "missing"), false);
  start(join(dir, "missing"));
  await until(() => lines().length === 1, "the missing program was told of");
  start(program);
  await until(() => lines().length === 2, "the other release was told of");
  // The build's hash is no part of the version.
  writeFileSync(join(dir, "version"), `${testedCursorVersion}-e373342\n`);
  start(program);
  await until(() => lines().length === 3, "the tested release was told of");
  assert.deepEqual(lines(), [
    `error Cursor was not found or did not run at ${join(dir, "missing")}. Set cursor.path in config.json.`,
    anotherRelease("2026.10.09"),
    `info  Cursor ${testedCursorVersion}`,
  ]);
  // Starting the provider started no Cursor.
  assert.deepEqual(calls(dir), []);
});

test("a release of Cursor not seen since the bridge started is told of once, when a process starts on it", async (t) => {
  const dir = agentFolder();
  const state = temporaryHome();
  const program = dummyCursor(dir, `${testedCursorVersion}-e373342`);
  const own = new CursorProvider({ command: program, directory: state, idleMs: 60_000, env: standinEnv({ agentDir: dir, stateDir: state }), cursorHome: null });
  t.after(async () => {
    await own.close();
    for (const path of [dir, state]) rmSync(path, { recursive: true, force: true });
  });
  const lines = versionLines(t);
  own.start();
  await until(() => lines().length === 1, "the version at the bridge's start was told of");

  // A process starts on the same release: nothing more is said.
  const phone = collector();
  const session = await thread(own, cwd, phone.sink);
  assert.equal(said(await phone.turn(session, "hello")), "pong: hello");
  // Cursor's command replaced itself with a newer release, as it does when used in a terminal.
  // The process stops when idle, and the thread's next message starts one on the new release.
  const next = async (version: string | null, text: string) => {
    if (version) writeFileSync(join(dir, "version"), `${version}\n`);
    own.sweep(Date.now() + 120_000);
    assert.equal(said(await phone.turn(session, text)), `pong: ${text}`);
  };
  await next("2026.10.09-0a1b2c3", "hello again");
  await until(() => lines().length === 2, "the new release was told of");
  // Another process on that release says nothing; one on yet another does.
  await next(null, "and again");
  await next("2026.11.02-9f8e7d6", "once more");
  await until(() => lines().length === 3, "the third release was told of");
  assert.deepEqual(lines(), [`info  Cursor ${testedCursorVersion}`, anotherRelease("2026.10.09"), newerRelease("2026.11.02")]);
  // `/status` names the release found last.
  assert.equal(own.version.statusLine(), `Version: Cursor 2026.11.02, newer than the ${testedCursorVersion} Portals was tested with`);
  assert.equal(new Set(calls(dir).map((call) => call.pid)).size, 4);
});

// MARK: From config.json

test("a bridge whose config.json has Cursor on runs it from there: its program, the bridge's own portals command and its state folder", async (t) => {
  const dir = agentFolder();
  const program = dummyCursor(dir, `${testedCursorVersion}-e373342`, true);
  const lines = versionLines(t);
  // No provider is handed to this bridge: it makes its own from its settings.
  const running = await startTestBridge({
    config: { generalFolder: cwd, providers: { claude: false, codex: false, cursor: true, hermes: false, fake: false }, cursor: { path: program, idleMinutes: 5 } },
  });
  const phone = await TestClient.open(running);
  t.after(async () => {
    await phone.close();
    await running.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual((await phone.call("profiles.list")).profiles.map((profile: Frame) => profile.name), ["cursor"]);
  await until(() => lines().length === 1, "the version was told of");
  assert.deepEqual(lines(), [`info  Cursor ${testedCursorVersion}`]);
  setLogLevel("silent");

  const session = await createThread({}, phone);
  // This bridge's own `portals` is the first on Cursor's PATH, and the thread's first message says where it is.
  const bin = join(running.home, "bin");
  assert.equal(await reply(session, "path", phone), `path=${bin}:${process.env.PATH}`);
  const sent = prompts(dir, session);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][0], { type: "text", text: "path" });
  assert.equal(sent[0][1].resource.uri, "portals://guide");
  assert.ok(sent[0][1].resource.text.includes(`"${join(bin, "portals")}"`), sent[0][1].resource.text);
  assert.deepEqual(calls(dir)[0].params.clientInfo.name, "portals-bridge");
  // What Cursor said of itself and the thread's conversation are in the bridge's folder.
  assert.deepEqual(JSON.parse(readFileSync(join(running.home, "state", "cursor", "agent.json"), "utf8")).models.map((model: Frame) => model.id), models.slice(1));
  assert.equal(threadFile(join(running.home, "state", "cursor"), session).told, true);
});

test("a bridge whose config.json has Pi and Cursor both on runs both, Pi listed first, and each thread is answered by its own agent", async (t) => {
  const dir = agentFolder();
  const program = dummyCursor(dir, `${testedCursorVersion}-e373342`, true);
  // Pi's stand-in (test/pi-agent.ts), which keeps its sessions where the bridge's own environment says.
  const pi = piStandin();
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = pi.agentDir;
  const running = await startTestBridge({
    config: {
      generalFolder: cwd,
      providers: { claude: false, codex: false, pi: true, cursor: true, hermes: false, fake: true },
      pi: { path: pi.path },
      cursor: { path: program, idleMinutes: 5 },
    },
  });
  const phone = await TestClient.open(running);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await phone.close();
    await running.dispose();
  };
  t.after(async () => {
    await stop();
    pi.dispose();
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  });
  // The order of the sidebar: Pi, then Cursor, then the scripted agent.
  assert.deepEqual((await phone.call("profiles.list")).profiles.map((profile: Frame) => profile.name), ["pi", "cursor", "fake"]);

  const ofPi = (await phone.call("session.create", { profile: "pi", source: "tui" })).session_id as string;
  const ofCursor = await createThread({}, phone);
  assert.equal(streamedText(await runTurn(phone, ofPi, "hello")), "Working. You said: hello");
  assert.equal(await reply(ofCursor, "mode", phone), "mode=agent");
  // And once more the other way round, each beside the other's running process.
  assert.equal(await reply(ofCursor, "mode", phone), "mode=agent");
  assert.equal(streamedText(await runTurn(phone, ofPi, "again")), "Working. You said: again");

  // One Pi process for the Pi thread, one Cursor process for the folder, and neither was sent the other's thread.
  assert.equal(pi.starts(ofPi).length, 1);
  assert.equal(pi.starts(ofCursor).length, 0);
  const cursors = [...new Set(calls(dir).map((call) => call.pid))];
  assert.equal(cursors.length, 1);
  assert.deepEqual([...new Set(prompts(dir, ofCursor).flat().filter((part) => part.type === "text").map((part) => part.text))], ["mode"]);
  assert.deepEqual(prompts(dir, ofPi), []);
  assert.equal(pi.alive().length > 0 && alive(cursors[0]), true);

  // A bridge that stops takes both agents' processes with it.
  await stop();
  await until(() => pi.alive().length === 0 && !alive(cursors[0]), "both agents' processes had ended");
});

// MARK: A later Cursor

test("what a later Cursor might send that the bridge does not know leaves the turn running, or ended complete", async (t) => {
  const state = await rig(t, { features: ["future"] });
  // A new session in a mode nobody knows: the thread's own mode is sent, and nothing is read back.
  const session = await createThread({}, state.phone);
  // An update of a kind nobody knows, a tool call and a permission request that cannot be read
  // (passed over, and answered cancelled), a request nobody knows (refused), and a reason for
  // stopping nobody knows.
  const events = await runTurn(state.phone, session, "use the editor in the future");
  const done = events.at(-1).payload;
  assert.equal(done.status, "complete");
  assert.equal(done.text, 'odd={"outcome":{"outcome":"cancelled"}} The client answered -32601. pong: use the editor in the future');
  assert.deepEqual(notices(events), []);
  assert.deepEqual(tools(events), []);
  assert.equal((await state.phone.call("session.resume", { session_id: session })).info.mode, "default");
});

// MARK: Closing

test("when the bridge closes, no process of Cursor's is left, nor anything it started", async () => {
  const dir = agentFolder();
  const state = temporaryHome();
  const elsewhere = folder();
  const own = cursor({ agentDir: dir, stateDir: state });
  const running = await startTestBridge({ providers: new Map([["cursor", own]]), config: { generalFolder: cwd } });
  const phone = await TestClient.open(running);
  try {
    const here = await createThread({}, phone);
    const there = await createThread({ cwd: elsewhere }, phone).catch(() => null);
    const helper = Number(/helper=(\d+)/.exec(await reply(here, "helper", phone))?.[1]);
    // One mid-turn, as a bridge stopped while Cursor works.
    await phone.call("prompt.submit", { session_id: here, text: "sleep" });
    await phone.nextEvent("tool.start", here);
    const pids = [...new Set(calls(dir).map((call) => call.pid))];
    assert.equal(pids.length, there ? 2 : 1);
    assert.ok(pids.every(alive) && alive(helper));
    await phone.close();
    await running.dispose();
    await until(() => !pids.some(alive) && !alive(helper), "every process has gone");
  } finally {
    await phone.close();
    await running.dispose();
    for (const path of [dir, state, elsewhere]) rmSync(path, { recursive: true, force: true });
  }
});

test("files mentioned (feature file_mentions) reach Cursor as a resource_link each, after the text, never their contents", async () => {
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, "docs", "plan.md"), "# The plan\n");
  const session = await createThread();
  const from = calls(agentDir).length;
  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: session, text: "Read @docs/plan.md", mentions: ["docs/plan.md", "../elsewhere.txt"] });
  await client.from(start, (frame) => isEvent(frame, "message.complete", session));
  const prompt = calls(agentDir).slice(from).find((call) => call.method === "session/prompt" && call.params.sessionId === session);
  assert.deepEqual(prompt?.params.prompt, [
    { type: "text", text: "Read @docs/plan.md" },
    { type: "resource_link", uri: pathToFileURL(join(cwd, "docs", "plan.md")).href, name: "plan.md" },
  ]);
});
