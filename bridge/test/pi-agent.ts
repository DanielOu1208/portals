import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type permissions from "../src/providers/pi/permission-extension.ts";

// A stand-in for `pi --mode rpc`, run as a real child process by the tests of the Pi
// client and provider. It speaks Pi's protocol on its standard input and output, keeps
// a session file where Pi would (`$PI_CODING_AGENT_DIR/sessions/--<folder>--/`), and
// plays the runs recorded from the real Pi (test/fixtures/pi). It never runs a command,
// reads a file or asks a model.
//
// It is as strict as Pi 1.1.0 where a forgiving stand-in would hide a bug in the bridge:
//
// - a `prompt` without `streamingBehavior` during a run is refused, with Pi's sentence;
// - a second `prompt` before the first one's run has begun is answered `started` too,
//   its message is lost, and a settle is reported at once (Pi reads its lines
//   concurrently and decides that it is busy only when the run begins);
// - an `abort` before a run has begun is answered and forgotten; one during a run is
//   answered only once the run has settled;
// - a run stays open while a dialog is unanswered, whatever else is asked of it;
// - a message queued behind an aborted run stays queued, and is delivered inside the next;
// - a message taken into a run keeps the time it was queued, which is before the time
//   anything written after it has (history tells one sent while Pi worked by that);
// - a prompt during a manual compaction is refused; `compact` aborts a run under way;
// - the first run of a session sends a system message before the user's;
// - `--fork <file> --session-id <id>` writes the copy as the process starts, under a
//   header that names the original, and fails when the folder has a session by that id
//   already or the original is not there.
//
// What a message does goes by its words:
//
//   play <recording> [n]   the nth run (1 if left out) of that recording, waiting where
//                          the recorder steered, stopped or answered a dialog
//   hold <gate>            a reply that waits for the gate before it finishes
//   slowstart <gate>       waits for the gate between `started` and `agent_start`
//   slowstop <gate>        after `abort`, waits for the gate before it stops
//   deaf                   ignores `abort`
//   settle-leaving         when the process is told to go during the run, the run settles
//                          first and the process goes a moment later, as when a run's
//                          end and the stop of its process cross
//   settle-first           a prompt that comes during the run is taken only once the run
//                          has settled, as when it arrives in that moment
//   refuse-steer           a prompt that comes during the run is refused
//   lose-late              a prompt that comes during the run is never answered, and nothing
//                          comes of it, as one that reaches Pi as the run settles and fails
//                          there (Pi's issue 10388)
//   die                    the process exits with code 1 while a command runs
//   anything else          a short reply that repeats the message
//
// and by these commands of its "extension": `/ask-confirm`, `/ask-select`, `/ask-input`,
// `/ask-editor`, `/ask-timed` (the recorded ones), `/say <words>` (says them with
// `notify`), `/tell <words>` (says them in a message of its own), `/own <message>`
// (begins a run by itself a moment later), `/ask-later` (asks outside any turn),
// `/quit` (exits with code 0) and, not listed among its commands, `/note <words>` (writes
// an entry of its own outside any run a moment later, and says so).
//
// A gate opens when the file `<agent dir>/release/<gate>` exists. While
// `<agent dir>/hold-start` exists, a thread's process answers nothing until the gate
// that file names has opened; while `<agent dir>/broken` exists, a process with no
// session fails to start. Everything a process is started with and is sent goes to
// `<agent dir>/standin.log`, one JSON value per line, for the tests to read. Asked for
// its version it says 1.1.0, or what `<agent dir>/version` holds.

type Json = any;

const args = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (args.includes("--version")) {
  const named = agentDir ? join(agentDir, "version") : "";
  console.log(named && existsSync(named) ? readFileSync(named, "utf8").trim() : "1.1.0");
  process.exit(0);
}
if (!agentDir) {
  // Never the real ~/.pi/agent.
  console.error("the stand-in for pi needs PI_CODING_AGENT_DIR");
  process.exit(2);
}
mkdirSync(agentDir, { recursive: true });

function option(name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function note(kind: string, more: Record<string, Json> = {}): void {
  appendFileSync(join(agentDir!, "standin.log"), JSON.stringify({ pid: process.pid, kind, ...more }) + "\n");
}

function say(record: Json): void {
  process.stdout.write(JSON.stringify(record) + "\n");
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastTime = 0;
/** The time in milliseconds, never the same twice: in Pi a tool takes its time, here a whole run can fit in one millisecond. */
function now(): number {
  lastTime = Math.max(Date.now(), lastTime + 1);
  return lastTime;
}

/** Resolves once the gate is open. */
async function released(gate: string): Promise<void> {
  while (!existsSync(join(agentDir!, "release", gate))) await sleep(4);
}

/** A file's JSON value; with `firstLine`, the value on its first line. Undefined when there is none. */
function readJSON(path: string, firstLine = false): Json {
  try {
    const text = readFileSync(path, "utf8");
    return JSON.parse(firstLine ? text.slice(0, text.indexOf("\n") < 0 ? undefined : text.indexOf("\n")) : text);
  } catch {
    return undefined;
  }
}

// MARK: The recordings

interface Entry {
  kind: "meta" | "start" | "send" | "receive" | "exit";
  record?: Json;
}

const recordedCwd = "/tmp/portals-cwd";

function fixture(name: string): Entry[] {
  return readFileSync(new URL(`fixtures/pi/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Entry);
}

/** The data of the first answer the `models` recording has to `command`. */
function recordedAnswer(command: string): Json {
  return fixture("models").find((entry) => entry.kind === "receive" && entry.record?.type === "response" && entry.record.command === command)?.record.data;
}

/** The entries of the nth run of a recording: from behind the `prompt` that began it to its `agent_settled`. */
function recordedRun(name: string, nth: number): Entry[] {
  const entries = fixture(name);
  let seen = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const sent = entries[index];
    if (sent.kind !== "send" || sent.record?.type !== "prompt") continue;
    const answer = entries.find((entry) => entry.kind === "receive" && entry.record?.type === "response" && entry.record.id === sent.record.id);
    if (answer?.record.data?.disposition !== "started") continue;
    seen += 1;
    if (seen !== nth) continue;
    const end = entries.findIndex((entry, at) => at > index && entry.kind === "receive" && entry.record?.type === "agent_settled");
    return entries.slice(index + 1, end + 1);
  }
  throw new Error(`the recording ${name} has no run ${nth}`);
}

/** A recorded record with the recorder's folder replaced by this process's. */
function here(record: Json): Json {
  return JSON.parse(JSON.stringify(record).replaceAll(recordedCwd, process.cwd()));
}

// MARK: The models and commands

interface Settings {
  missingPermissions?: boolean;
  refusePermissionMode?: boolean;
  permissionModeGate?: string;
  permissionModeGateWhen?: string;
  /** Models besides the built-in ones. */
  models?: Json[];
  /** `provider/id` of the model a new session runs on. */
  default?: string;
  /** The level a new session runs at. */
  level?: string;
  /** `provider/id` of models `set_model` and `prompt` refuse for want of a key. */
  noKey?: string[];
  /** What `pi --print` answers (the bridge's naming of a thread); a line of the stand-in's own unless set. */
  title?: string;
  /** What `pi --print` fails with instead, on stderr, leaving with 1. */
  titleFails?: string;
  /** A gate `pi --print` waits at before it answers. */
  titleGate?: string;
}

const settings: Settings = readJSON(join(agentDir, "standin.json")) ?? {};
const builtIn = ["gpt-6-luna", "gpt-5", "gpt-4.1-nano", "o3-mini"];
const recordedModels: Json[] = recordedAnswer("get_available_models").models;
const models: Json[] = [...builtIn.map((id) => recordedModels.find((model) => model.id === id)), ...(settings.models ?? [])];
const key = (model: Json) => `${model.provider}/${model.id}`;
const defaultModel = models.find((model) => key(model) === (settings.default ?? "openai/gpt-6-luna")) ?? models[0];

const piLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The levels a model takes, by Pi's own rule. */
function levelsOf(model: Json): string[] {
  if (model.reasoning !== true) return ["off"];
  const map = model.thinkingLevelMap ?? {};
  return piLevels.filter((level) => map[level] !== null && (map[level] !== undefined || (level !== "xhigh" && level !== "max")));
}

/** A level as the model takes it: itself, else the next one up, else its strongest. */
function clamp(level: string, model: Json): string {
  const taken = levelsOf(model);
  if (taken.includes(level)) return level;
  return piLevels.slice(piLevels.indexOf(level) + 1).find((candidate) => taken.includes(candidate)) ?? taken.at(-1)!;
}

const commands: Json[] = [
  ...recordedAnswer("get_commands").commands.map(here),
  ...["say", "tell", "own", "ask-later", "quit"].map((name) => ({ name, description: `The stand-in's ${name}`, source: "extension" })),
  // The app sends names in lower case: this one cannot be offered.
  { name: "Loud", description: "A command with a capital letter", source: "extension" },
];

// MARK: The session file

const sessionId = args.includes("--no-session") ? null : (option("--session-id") ?? randomUUID());
const sessionFolder = join(agentDir, "sessions", `--${process.cwd().replace(/^\//, "").replace(/[/:]/g, "-")}--`);
let sessionFile: string | null = null;
let fileWritten = false;
const entries: Json[] = [];

function entryId(): string {
  return randomBytes(4).toString("hex");
}

/** Adds an entry to the session, and returns it as written. The file is written from the first message of the user's on, as Pi's is. */
function append(entry: Json): Json {
  const { type, ...rest } = entry;
  const whole = { type, id: entryId(), parentId: entries.at(-1)?.id ?? null, timestamp: new Date(now()).toISOString(), ...rest };
  entries.push(whole);
  if (sessionFile === null) return whole;
  if (fileWritten) {
    appendFileSync(sessionFile, JSON.stringify(whole) + "\n");
  } else if (whole.type === "message" && whole.message?.role === "user") {
    mkdirSync(sessionFolder, { recursive: true });
    const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() };
    writeFileSync(sessionFile, [header, ...entries].map((line) => JSON.stringify(line)).join("\n") + "\n");
    fileWritten = true;
  }
  return whole;
}

function lastEntry(type: string): Json {
  return entries.findLast((entry) => entry.type === type);
}

function messageCount(): number {
  return entries.filter((entry) => entry.type === "message").length;
}

// MARK: State

const state = {
  model: defaultModel as Json,
  level: clamp(settings.level ?? "off", defaultModel),
  name: undefined as string | undefined,
  /** A run is under way: Pi's `isStreaming`. */
  running: false,
  /** A `prompt` was answered `started` and its run has not begun. */
  beginning: false,
  /** A second `prompt` came in that moment. */
  collided: false,
  /** `abort` was asked of the run under way. */
  aborted: false,
  /** The `abort`s to answer once the run has settled. */
  aborts: [] as string[],
  /** Messages taken into the run and not delivered yet. */
  queue: [] as { text: string; images: Json[]; at: number }[],
  /** A manual compaction is under way; calling it cancels the compaction. */
  compacting: null as (() => void) | null,
  /** The dialogs waiting for an answer. */
  dialogs: new Map<string, (response: Json) => void>(),
  /** The words of the message the run under way goes by. */
  script: "",
  /** How full the context is; null right after a compaction. */
  tokens: 0 as number | null,
  settled: [] as (() => void)[],
};

/** The file the folder has for a session id: as in Pi, the one whose first line names that id, whatever the file is called. */
function fileOf(id: string): string | undefined {
  if (!existsSync(sessionFolder)) return undefined;
  const named = (name: string) => readJSON(join(sessionFolder, name), true)?.id === id;
  return readdirSync(sessionFolder).filter((name) => name.endsWith(".jsonl") && named(name)).sort().at(-1);
}

const forkOf = option("--fork");
if (sessionId !== null && forkOf !== undefined) {
  // As Pi's `SessionManager.forkFrom`: a new header that names the original, then every entry of it.
  if (fileOf(sessionId)) {
    console.error(`Session already exists with id '${sessionId}'`);
    process.exit(1);
  }
  if (!existsSync(forkOf)) {
    console.error(`No session found matching '${forkOf}'`);
    process.exit(1);
  }
  const copied = readFileSync(forkOf, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type !== "session");
  const made = new Date().toISOString();
  const header = { type: "session", version: 3, id: sessionId, timestamp: made, cwd: process.cwd(), parentSession: forkOf };
  mkdirSync(sessionFolder, { recursive: true });
  writeFileSync(join(sessionFolder, `${made.replace(/[:.]/g, "-")}_${sessionId}.jsonl`), [header, ...copied].map((line) => JSON.stringify(line)).join("\n") + "\n");
}

if (sessionId !== null) {
  const existing = fileOf(sessionId);
  if (existing) {
    sessionFile = join(sessionFolder, existing);
    fileWritten = true;
    for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line);
      if (typeof entry.id === "string") entries.push(entry);
    }
    // A session comes back on the model, level and name it had.
    const model = lastEntry("model_change");
    state.model = models.find((candidate) => candidate.provider === model?.provider && candidate.id === model?.modelId) ?? state.model;
    state.level = lastEntry("thinking_level_change")?.thinkingLevel ?? state.level;
    state.name = lastEntry("session_info")?.name;
    // Right after a compaction Pi does not know how full the context is.
    state.tokens = entries.at(-1)?.type === "compaction" ? null : 900 + 100 * messageCount();
  } else {
    console.error(`Warning: No project session found with id '${sessionId}'; creating a new session with that id.`);
    sessionFile = join(sessionFolder, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
    append({ type: "model_change", provider: state.model.provider, modelId: state.model.id });
    append({ type: "thinking_level_change", thinkingLevel: state.level });
  }
}

function answer(id: Json, command: string, data?: Json): void {
  say(data === undefined ? { id, type: "response", command, success: true } : { id, type: "response", command, success: true, data });
}

function refuse(id: Json, command: string, error: string): void {
  say({ id, type: "response", command, success: false, error });
}

function word(script: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name} (\\S+)`).exec(script)?.[1];
}

function has(script: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`).test(script);
}

// MARK: Dialogs and the extension's commands

type PermissionAPI = Parameters<typeof permissions>[0];
const permissionHandlers = new Map<string, { handler(args: string): Promise<void> }>();
let toolGate: Parameters<PermissionAPI["on"]>[1] | undefined;

// The permission tests run the shipped extension itself, with Pi's select UI played
// by the same RPC dialogs as the recorded extensions.
const extensionPath = option("-e");
if (extensionPath && !settings.missingPermissions) {
  const extension = (await import(pathToFileURL(extensionPath).href)).default as typeof permissions;
  extension({
    registerCommand(name, command) {
      permissionHandlers.set(name, command);
      commands.push({ name, description: command.description, source: "extension" });
    },
    on(event: string, handler: any) {
      if (event === "tool_call") toolGate = handler;
    },
  });
}

/** Asks, and resolves with the answer; undefined when its time ran out. */
function ask(request: Json): Promise<Json> {
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = typeof request.timeout === "number" ? setTimeout(() => state.dialogs.get(id)?.(undefined), request.timeout) : null;
    state.dialogs.set(id, (response) => {
      state.dialogs.delete(id);
      if (timer) clearTimeout(timer);
      resolve(response);
    });
    say({ type: "extension_ui_request", id, ...request });
  });
}

function notify(message: string, notifyType = "info"): void {
  say({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType });
}

/** Runs one of the extension's commands. False when the message is none of them. */
async function extensionCommand(text: string): Promise<boolean> {
  const space = text.indexOf(" ");
  const name = space < 0 ? text.slice(1) : text.slice(1, space);
  const rest = space < 0 ? "" : text.slice(space + 1);
  const permission = permissionHandlers.get(name);
  if (permission) {
    if (settings.refusePermissionMode) {
      // Pi reports the handler error and still answers the prompt as handled.
      say({ type: "extension_error", extensionPath: `command:${name}`, event: "command", error: "The stand-in refused the permission mode." });
      return true;
    }
    await permission.handler(rest);
    if (settings.permissionModeGate && rest === (settings.permissionModeGateWhen ?? "full")) await released(settings.permissionModeGate);
    return true;
  }
  switch (name) {
    case "ask-confirm": {
      const reply = await ask({ method: "confirm", title: "Send the report?", message: "It goes to everyone on the list." });
      notify(reply?.confirmed === true ? "Confirmed" : "Not confirmed");
      return true;
    }
    case "ask-select": {
      const reply = await ask({ method: "select", title: "Which fruit?", options: ["Apple", "Banana", "Cherry"] });
      notify(typeof reply?.value === "string" ? `Picked ${reply.value}` : "Nothing picked");
      return true;
    }
    case "ask-input": {
      const reply = await ask({ method: "input", title: "Your name", placeholder: "type a name" });
      notify(typeof reply?.value === "string" ? `Name: ${reply.value}` : "No name");
      return true;
    }
    case "ask-editor": {
      const reply = await ask({ method: "editor", title: "Edit the note", prefill: "Line 1\nLine 2" });
      notify(typeof reply?.value === "string" ? `Note has ${reply.value.split("\n").length} lines` : "Note left alone");
      return true;
    }
    case "ask-timed": {
      const reply = await ask({ method: "confirm", title: "Still there?", message: "This answers itself in a moment.", timeout: 300 });
      if (reply?.confirmed === true) notify("Confirmed");
      else notify("No answer in time", "warning");
      return true;
    }
    case "say":
      for (const line of rest.split("|")) notify(line.trim());
      return true;
    case "tell": {
      const message = { role: "custom", customType: "standin", content: [{ type: "text", text: rest }], display: true, timestamp: now() };
      say({ type: "message_start", message });
      say({ type: "message_end", message });
      return true;
    }
    case "own":
      // As an extension does that sends Pi a message from a timer.
      setTimeout(() => void run(rest, []), 20);
      return true;
    case "ask-later":
      setTimeout(() => void ask({ method: "confirm", title: "Later", message: "Asked outside any turn." }), 20);
      return true;
    case "note":
      // As an extension's `appendEntry` from a timer: an entry written outside any run, and announced.
      setTimeout(() => say({ type: "entry_appended", entry: append({ type: "custom", customType: "standin-note", data: { words: rest } }) }), 20);
      return true;
    case "quit":
      setTimeout(() => leave(0), 20);
      return true;
    default:
      return false;
  }
}

// MARK: Runs

function usageOf(tokens: number): Json {
  return { input: tokens - 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: tokens };
}

function userMessage(text: string, images: Json[], at = now()): Json {
  return { role: "user", content: [{ type: "text", text }, ...images], timestamp: at };
}

/** A whole message: its start, its end, and its place in the session file. */
function whole(message: Json): void {
  say({ type: "message_start", message });
  ended(message);
}

function ended(message: Json): void {
  say({ type: "message_end", message });
  append({ type: "message", message });
  if (message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error") {
    state.tokens = typeof message.usage?.totalTokens === "number" && message.usage.totalTokens > 0 ? message.usage.totalTokens : 1000;
  }
}

function assistant(text: string, stopReason: string): Json {
  return {
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    api: "standin",
    provider: state.model.provider,
    model: state.model.id,
    usage: usageOf(1000 + 100 * messageCount()),
    stopReason,
    timestamp: now(),
  };
}

/** A reply said in pieces. */
function reply(pieces: string[]): void {
  const pending = { ...assistant("", "pending"), usage: usageOf(0) };
  say({ type: "message_start", message: pending });
  say({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  for (const piece of pieces) say({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: piece } });
  say({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: pieces.join("") } });
  ended(assistant(pieces.join(""), "stop"));
}

/** Delivers the next queued message as Pi does, between two answers of a run. False when none waits. */
function deliver(): boolean {
  const next = state.queue.shift();
  if (!next) return false;
  say({ type: "queue_update", steering: state.queue.map((queued) => queued.text), followUp: [] });
  whole(userMessage(next.text, next.images, next.at));
  return true;
}

/** The run is over: Pi is idle again, and says so to whoever waited. */
function settle(aborted: boolean): void {
  say({ type: "agent_end", messages: [], willRetry: false });
  state.running = false;
  state.aborted = false;
  state.script = "";
  say({ type: "agent_settled", aborted });
  for (const id of state.aborts.splice(0)) answer(id, "abort");
  for (const wake of state.settled.splice(0)) wake();
}

/** A run: what Pi does with one message until it is idle again. */
async function run(text: string, images: Json[]): Promise<void> {
  state.beginning = true;
  state.script = text;
  const gate = word(text, "slowstart");
  if (gate) await released(gate);
  else await tick();
  state.beginning = false;
  state.running = true;
  say({ type: "agent_start" });
  if (state.collided) {
    // The prompt that came before the run began: Pi reports a settle for it at once.
    state.collided = false;
    say({ type: "agent_settled", aborted: false });
  }
  say({ type: "turn_start" });
  if (messageCount() === 0) whole({ role: "system", content: "", timestamp: now() });
  whole(userMessage(text, images));
  // A message queued behind an aborted run comes out here, inside this one.
  while (deliver()) await tick();
  const recorded = /(?:^|\s)play (\S+)(?: (\d+))?/.exec(text);
  const aborted = recorded ? await play(recordedRun(recorded[1], Number(recorded[2] ?? 1))) : await improvise(text);
  settle(aborted);
}

/** True once `abort` was asked and the run is one that hears it. */
function stopping(): boolean {
  return state.aborted && !has(state.script, "deaf");
}

/** Waits until `ready`, or until the run is to stop. */
async function until(ready: () => boolean): Promise<void> {
  while (!ready() && !stopping()) await sleep(2);
}

/** After `abort`: waits for the gate a slow stop names. */
async function wind(): Promise<void> {
  const gate = word(state.script, "slowstop");
  if (gate) await released(gate);
}

/** A reply made up here. True when it was aborted. */
async function improvise(text: string): Promise<boolean> {
  const tool = /^permission (\w+)( nested)?$/.exec(text);
  if (tool) {
    const name = tool[1];
    const input = name === "bash" ? { command: "echo harmless" } : { path: "note.txt", content: "hello" };
    const call = { toolName: name, input, ...(tool[2] ? { parentToolCallId: "call_script" } : {}) };
    const blocked = await (toolGate as any)?.(call, {
      hasUI: true,
      ui: { select: async (title: string, options: string[]) => (await ask({ method: "select", title, options }))?.value },
    });
    note("permission", { call, blocked: blocked?.block === true });
    reply([blocked ? "Tool blocked." : "Tool allowed."]);
    return state.aborted;
  }
  const pending = { ...assistant("", "pending"), usage: usageOf(0) };
  say({ type: "message_start", message: pending });
  say({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  say({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working." } });
  if (has(text, "die")) {
    say({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Working." } });
    ended({ ...assistant("Working.", "toolUse"), content: [{ type: "text", text: "Working." }, { type: "toolCall", id: "call_die|fc_die", name: "bash", arguments: { command: "sleep 30" } }] });
    say({ type: "tool_execution_start", toolCallId: "call_die|fc_die", toolName: "bash", args: { command: "sleep 30", timeout: null } });
    await tick();
    if (has(text, "loudly")) console.error("Error: the stand-in was told to die");
    leave(1);
    return new Promise(() => {});
  }
  const gate = word(text, "hold");
  if (gate) {
    let open = false;
    void released(gate).then(() => (open = true));
    await until(() => open);
  } else {
    await tick();
  }
  if (stopping()) {
    await wind();
    say({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Working." } });
    ended(assistant("Working.", "aborted"));
    say({ type: "turn_end", message: {}, toolResults: [] });
    return true;
  }
  const rest = ` You said: ${text}`;
  say({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: rest } });
  say({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: `Working.${rest}` } });
  ended(assistant(`Working.${rest}`, "stop"));
  say({ type: "turn_end", message: {}, toolResults: [] });
  // What was sent meanwhile is answered before the run settles.
  while (deliver()) {
    await tick();
    say({ type: "turn_start" });
    reply(["Also", " noted."]);
    say({ type: "turn_end", message: {}, toolResults: [] });
  }
  return false;
}

/**
 * A recorded run, record by record. Where the recorder wrote a message into the run, it
 * waits for the bridge's; where it stopped the run, for the bridge's `abort`; where it
 * answered a dialog, for the bridge's answer. True when it was aborted.
 */
async function play(recorded: Entry[]): Promise<boolean> {
  let opened = false;
  let abortPlayed = false;
  for (let index = 0; index < recorded.length; index += 1) {
    const { kind, record } = recorded[index];
    if (stopping() && !abortPlayed) {
      // Stopped where the recorder did not stop it.
      await wind();
      return true;
    }
    if (kind === "send") {
      // A message for the run: the bridge must have written one too.
      if (record.type === "prompt" || record.type === "steer") await until(() => state.queue.length > 0);
      if (record.type === "abort") {
        await until(() => false);
        await wind();
        abortPlayed = true;
      }
      continue;
    }
    if (kind !== "receive" || record.type === "response" || record.type === "queue_update" || record.type === "agent_start") continue;
    if (!opened) {
      // Up to the user's message the run was opened here, with the message as sent.
      if (record.type === "message_end" && record.message?.role === "user") opened = true;
      continue;
    }
    await tick();
    switch (record.type) {
      case "agent_end":
        break;
      case "agent_settled":
        return record.aborted === true;
      case "extension_ui_request":
        if (["select", "confirm", "input", "editor"].includes(record.method)) {
          const { id: _id, type: _type, ...request } = record;
          await ask(request);
        } else {
          say({ ...record, id: randomUUID() });
        }
        break;
      case "message_start":
        if (record.message?.role === "user") {
          // A message the recorder had queued: the bridge's own takes its place, and
          // without one the run ends before it.
          if (!deliver()) return false;
          index += 1;
        } else {
          say(here(record));
        }
        break;
      case "message_end":
        ended(here(record).message);
        break;
      case "compaction_end":
        if (record.result) {
          append({ type: "compaction", summary: record.result.summary, firstKeptEntryId: entries.at(-1)?.id, tokensBefore: record.result.tokensBefore });
          state.tokens = null;
        }
        say(record);
        break;
      default:
        say(here(record));
    }
  }
  return false;
}

// MARK: Commands

async function prompt(command: Json): Promise<void> {
  const text = String(command.message ?? "");
  const images = Array.isArray(command.images) ? command.images : [];
  // The extension's commands run at once, even during a run.
  if (text.startsWith("/")) {
    try {
      if (await extensionCommand(text)) {
        answer(command.id, "prompt", { disposition: "handled" });
        return;
      }
    } catch (error) {
      refuse(command.id, "prompt", (error as Error).message);
      return;
    }
  }
  if (state.compacting) {
    refuse(command.id, "prompt", "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.");
    return;
  }
  if (state.running && has(state.script, "settle-first")) {
    await new Promise<void>((resolve) => state.settled.push(resolve));
    return prompt(command);
  }
  if (state.running) {
    if (has(state.script, "refuse-steer")) return refuse(command.id, "prompt", "The stand-in was told to refuse this message.");
    if (has(state.script, "lose-late")) return;
    if (command.streamingBehavior !== "steer" && command.streamingBehavior !== "followUp") {
      return refuse(command.id, "prompt", "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    }
    state.queue.push({ text, images, at: now() });
    say({ type: "queue_update", steering: state.queue.map((queued) => queued.text), followUp: [] });
    answer(command.id, "prompt", { disposition: "queued" });
    return;
  }
  if (settings.noKey?.includes(key(state.model))) return refuse(command.id, "prompt", `No API key found for ${state.model.provider}.`);
  answer(command.id, "prompt", { disposition: "started" });
  if (state.beginning) {
    // Pi does not know yet that it is busy: this one counts as new too, and is lost.
    state.collided = true;
    return;
  }
  void run(text, images);
}

async function compact(command: Json): Promise<void> {
  if (state.running) {
    // Pi aborts whatever runs before it compacts.
    state.aborted = true;
    await new Promise<void>((resolve) => state.settled.push(resolve));
  }
  say({ type: "compaction_start", reason: "manual" });
  const fail = (message: string, aborted: boolean) => {
    say({ type: "compaction_end", reason: "manual", aborted, willRetry: false, ...(aborted ? {} : { errorMessage: `Compaction failed: ${message}` }) });
    refuse(command.id, "compact", message);
  };
  if (entries.at(-1)?.type === "compaction") return fail("Already compacted", false);
  if (entries.filter((entry) => entry.type === "message" && entry.message?.role === "user").length < 2) return fail("Nothing to compact (session too small)", false);
  let cancelled = false;
  const stopped = new Promise<void>((resolve) => {
    state.compacting = () => {
      cancelled = true;
      resolve();
    };
  });
  const gate = word(String(command.customInstructions ?? ""), "hold");
  await Promise.race([gate ? released(gate) : tick(), stopped]);
  state.compacting = null;
  if (cancelled) {
    fail("Compaction cancelled", true);
    for (const id of state.aborts.splice(0)) answer(id, "abort");
    return;
  }
  const before = state.tokens ?? 2000;
  const result = { summary: "## Goal\nWhat was asked so far.", firstKeptEntryId: entries.at(-1)?.id, tokensBefore: before, estimatedTokensAfter: Math.round(before * 0.4) };
  append({ type: "compaction", summary: result.summary, firstKeptEntryId: result.firstKeptEntryId, tokensBefore: before });
  // Pi does not know the context's size again until the next reply.
  state.tokens = null;
  say({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
  answer(command.id, "compact", result);
}

async function handle(command: Json): Promise<void> {
  const id = command.id;
  switch (command.type) {
    case "extension_ui_response":
      // A late answer to a dialog already settled is ignored.
      state.dialogs.get(command.id)?.(command);
      return;
    case "prompt":
      return prompt(command);
    case "abort":
      if (state.compacting) {
        state.aborts.push(id);
        state.compacting();
      } else if (state.running) {
        // Answered once the run has settled.
        state.aborted = true;
        state.aborts.push(id);
      } else {
        // Nothing runs (not even a run about to begin): answered, and forgotten.
        answer(id, "abort");
      }
      return;
    case "clear_queue": {
      const steering = state.queue.splice(0).map((queued) => queued.text);
      say({ type: "queue_update", steering: [], followUp: [] });
      return answer(id, "clear_queue", { steering, followUp: [] });
    }
    case "compact":
      return compact(command);
    case "get_state":
      return answer(id, "get_state", {
        model: state.model,
        thinkingLevel: state.level,
        isStreaming: state.running,
        isCompacting: state.compacting !== null,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        ...(sessionFile ? { sessionFile } : {}),
        sessionId: sessionId ?? randomUUID(),
        ...(state.name ? { sessionName: state.name } : {}),
        autoCompactionEnabled: true,
        messageCount: messageCount(),
        pendingMessageCount: state.queue.length,
      });
    case "get_available_models":
      return answer(id, "get_available_models", { models });
    case "get_commands":
      return answer(id, "get_commands", { commands });
    case "get_session_stats": {
      const contextWindow = state.model.contextWindow;
      return answer(id, "get_session_stats", { sessionId, contextUsage: { tokens: state.tokens, contextWindow, percent: state.tokens === null ? null : (state.tokens / contextWindow) * 100 } });
    }
    case "set_model": {
      const model = models.find((candidate) => candidate.provider === command.provider && candidate.id === command.modelId);
      if (!model) return refuse(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
      if (settings.noKey?.includes(key(model))) return refuse(id, "set_model", `No API key for ${key(model)}`);
      state.model = model;
      append({ type: "model_change", provider: model.provider, modelId: model.id });
      setLevel(state.level);
      return answer(id, "set_model", model);
    }
    case "set_thinking_level":
      setLevel(String(command.level));
      return answer(id, "set_thinking_level");
    case "set_session_name": {
      const name = String(command.name ?? "").trim();
      if (name === "") return refuse(id, "set_session_name", "Session name cannot be empty");
      state.name = name;
      append({ type: "session_info", name });
      say({ type: "session_info_changed", name });
      return answer(id, "set_session_name");
    }
    default:
      return refuse(id, String(command.type), `Unknown command: ${command.type}`);
  }
}

/** Sets the level as the model takes it, and says so when that is another than before. */
function setLevel(level: string): void {
  const taken = clamp(level, state.model);
  if (taken === state.level) return;
  state.level = taken;
  append({ type: "thinking_level_change", thinkingLevel: taken });
  say({ type: "thinking_level_changed", level: taken });
}

// MARK: The process

function leave(code: number): void {
  note("exit", { code });
  // Once what it printed has gone out.
  process.stdout.write("", () => process.exit(code));
}

let going = false;

/** Told to go: at once, or with `settle-leaving` in a run under way, once that run has settled and its settle has gone out. */
function told(code: number): void {
  if (going) return;
  if (state.running && has(state.script, "settle-leaving")) {
    going = true;
    settle(true);
    setTimeout(() => leave(code), 100);
    return;
  }
  leave(code);
}

note("start", { args, cwd: process.cwd(), env: { PATH: process.env.PATH, PORTALS_THREAD: process.env.PORTALS_THREAD } });

if (args.includes("--print")) {
  // One message, answered on stdout, and gone.
  void (settings.titleGate ? released(settings.titleGate) : Promise.resolve()).then(() => {
    if (settings.titleFails) {
      console.error(settings.titleFails);
      process.exit(1);
    }
    process.stdout.write(`${settings.title ?? "Answer the stand-in"}\n`);
    process.exit(0);
  });
} else if (sessionId === null && existsSync(join(agentDir, "broken"))) {
  console.error('Error: Failed to load extension "broken.ts": it threw as it loaded');
  leave(1);
} else {
  const startGate = sessionId !== null && existsSync(join(agentDir, "hold-start")) ? readFileSync(join(agentDir, "hold-start"), "utf8").trim() : "";
  const up = startGate === "" ? Promise.resolve() : released(startGate);
  let rest = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      let command: Json;
      try {
        command = JSON.parse(line);
      } catch (error) {
        say({ type: "response", command: "parse", success: false, error: `Failed to parse command: ${(error as Error).message}` });
        continue;
      }
      note("got", { record: command });
      void up.then(() => handle(command));
    }
  });
  // Pi exits when its input closes, and with 143 on SIGTERM.
  process.stdin.on("end", () => told(0));
  process.on("SIGTERM", () => told(143));
}
