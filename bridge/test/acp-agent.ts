import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// A stand-in for an agent that speaks the Agent Client Protocol, version 1, for the
// bridge's tests (test/acp-client.test.ts starts it as the bridge would a real one). It
// runs nothing and touches no files but its own: its tool calls and their output are
// made up, in the shapes OpenCode and Cursor were seen to send.
//
// Words in the prompt (or words starting with them) add steps to its turn:
//   think    thinking first
//   tool     an edit told the way Cursor tells one, then a command
//   write    a whole file written, told the way OpenCode tells one
//   approve  asks before running a command
//   plan     a plan of two steps
//   slow     a long reply, slowly, to try stopping it
//   where    says its process id and the folder its process runs in
//   model    says the model and thinking level its session is set to
//   title    names the session
//   editor   asks the client to write a file, as agents do whatever was offered
//   helper   starts a process of its own that never ends by itself, and says its id
//   fail     the turn fails with an error
//   gasp     writes a line to standard error (its last words, when a crash follows)
//   crash    the process exits mid-turn
//
// ACP_STANDIN_DIR is where it keeps its sessions, so that another run of it can load
// them, and its notes for the tests: `calls.jsonl`, every call and notification it got;
// `timeline.jsonl`, when it got each call and when it answered it; `answers.jsonl`, the
// answer to each request of its own. ACP_STANDIN_FEATURES, comma separated:
//   resume     also takes `session/resume`
//   noload     cannot take a session up again at all
//   signedout  refuses new sessions until signed in
//   plain      lists its models by plain ids, not `vendor/model`
//   junk       ends each reply with a line of its own and scrapes its diffs, as Cursor does
//   version2   says it speaks version 2 of the protocol
//   noise      prints lines that are no messages before anything else: a banner, as a program
//              may have one, and JSON that is not an object
//   cursor     behaves as Cursor 2026.10.01 was recorded to (test/fixtures/cursor), for
//              test/cursor-bridge.test.ts; see "Cursor's ways" below
//   nolist     (with cursor) does not know `cursor/list_available_models`
//   loadfails  (with cursor) fails the first `session/load` of each run with an error of its own
//   future     (with cursor) says things a later Cursor might: a mode nobody knows in a new session
//   slownew    (with cursor) takes a third of a second to answer `session/new`
//   lingers    (with cursor) does not end when its input closes, as Cursor does not in the
//              middle of a turn: a bridge that is killed leaves it running

const directory = process.env.ACP_STANDIN_DIR ?? "";
const features = new Set((process.env.ACP_STANDIN_FEATURES ?? "").split(",").filter((feature) => feature !== ""));
/** As Cursor: see "Cursor's ways" below. */
const cursor = features.has("cursor");
mkdirSync(directory, { recursive: true });

interface Stored {
  id: string;
  cwd: string;
  /** As Cursor: the model the session last ran on. */
  model: string;
  level: string;
  /** As Cursor: the session's mode. */
  mode?: string;
  /** What was said, for sending again when the session is loaded. */
  said: { role: "user" | "agent"; text: string }[];
}

const sessions = new Map<string, Stored>();
/** Sessions whose running turn was asked to stop. */
const stopping = new Set<string>();
/** As Cursor: a session's running turn. */
interface Turn {
  cancelled: boolean;
  /** Another prompt came for the session. */
  superseded: boolean;
  done: Promise<void>;
}
const turns = new Map<string, Turn>();
// Cursor numbers its requests from 0.
let nextRequest = cursor ? 0 : 1;
const answers = new Map<number, (message: any) => void>();

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function update(sessionId: string, body: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId, update: body } });
}

/** A request to the client; resolves with its whole answer, which is also noted in `answers.jsonl`. */
function ask(method: string, params: any): Promise<any> {
  const id = nextRequest++;
  return new Promise((resolve) => {
    answers.set(id, (message) => {
      appendFileSync(join(directory, "answers.jsonl"), JSON.stringify({ method, toolCallId: params?.toolCallId ?? params?.toolCall?.toolCallId, result: message.result, error: message.error }) + "\n");
      resolve(message);
    });
    send({ id, method, params });
  });
}

/**
 * Where it keeps each session as Cursor does, when it is given one (ACP_STANDIN_SESSIONS:
 * a Cursor home's `acp-sessions`): a folder of the session's own, with its store and a
 * `meta.json` with its folder. A copy of such a folder under another id is loaded as
 * that id (the bridge's forks).
 */
const cursorSessions = process.env.ACP_STANDIN_SESSIONS ?? "";

function save(session: Stored): void {
  writeFileSync(join(directory, `${session.id}.json`), JSON.stringify(session));
  if (cursorSessions) {
    mkdirSync(join(cursorSessions, session.id), { recursive: true });
    writeFileSync(join(cursorSessions, session.id, "store.json"), JSON.stringify(session));
    const meta = join(cursorSessions, session.id, "meta.json");
    if (!existsSync(meta)) writeFileSync(meta, JSON.stringify({ schemaVersion: 1, cwd: session.cwd, title: "A stand-in session" }));
  }
}

function known(id: string): Stored | null {
  const live = sessions.get(id);
  if (live) return live;
  const file = join(directory, `${id}.json`);
  if (!existsSync(file)) return null;
  const session = JSON.parse(readFileSync(file, "utf8")) as Stored;
  sessions.set(id, session);
  return session;
}

const models = features.has("plain")
  ? [
      { value: "small[fast=true]", name: "small" },
      { value: "large[fast=false]", name: "large" },
    ]
  : [
      { value: "standin/small", name: "Stand-in/Small" },
      { value: "standin/large", name: "Stand-in/Large" },
      { value: "other/huge", name: "Other Lab/Huge" },
    ];

function configOptions(session: Stored): unknown[] {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model, options: models },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Build" }] },
    {
      id: "effort",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: session.level,
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
        { value: "turbo", name: "Turbo" },
      ],
    },
  ];
}

function text(sessionId: string, value: string, messageId?: string): void {
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value }, ...(messageId ? { messageId } : {}) });
}

/** One turn; resolves with why it stopped. */
async function turn(session: Stored, prompt: { type: string; text?: string }[]): Promise<string> {
  const said = prompt.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
  const images = prompt.filter((block) => block.type === "image").length;
  const wants = (word: string) => new RegExp(`\\b${word}`, "i").test(said);
  const id = session.id;
  session.said.push({ role: "user", text: said });

  if (wants("fail")) throw { code: -32603, message: "Internal error", data: "The stand-in failed on purpose." };
  if (wants("title")) update(id, { sessionUpdate: "session_info_update", title: "A title from the stand-in" });
  if (wants("think")) {
    update(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me think. " } });
    update(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Done thinking." } });
  }
  if (wants("gasp")) process.stderr.write("some warning first\nthe stand-in fell over on purpose\n");
  if (wants("crash")) {
    text(id, "About to crash. ");
    await sleep(20);
    process.exit(3);
  }
  if (wants("plan")) {
    update(id, {
      sessionUpdate: "plan",
      entries: [
        { content: "Read the file", priority: "high", status: "completed" },
        { content: "Change it", priority: "medium", status: "in_progress" },
      ],
    });
  }
  if (wants("tool")) {
    text(id, "I'll change hi to hello. ");
    const path = join(session.cwd, "hello.txt");
    const junk = features.has("junk");
    update(id, { sessionUpdate: "tool_call", toolCallId: "edit-1", title: "Edit File", kind: "edit", status: "pending", rawInput: {} });
    update(id, { sessionUpdate: "tool_call_update", toolCallId: "edit-1", title: `Edit \`${path}\``, rawInput: { path }, locations: [{ path }] });
    update(id, { sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "in_progress" });
    const diff = junk
      ? { type: "diff", path, oldText: "-- a/hello.txt\nhi", newText: "++ b/hello.txt\nhello" }
      : { type: "diff", path, oldText: "first\nhi\nlast\n", newText: "first\nhello\nlast\n" };
    update(id, { sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed", content: [diff] });
    update(id, { sessionUpdate: "tool_call", toolCallId: "run-1", title: "`cat hello.txt`", kind: "execute", status: "pending", rawInput: { command: "cat hello.txt" } });
    update(id, { sessionUpdate: "tool_call_update", toolCallId: "run-1", status: "in_progress" });
    update(id, { sessionUpdate: "tool_call_update", toolCallId: "run-1", status: "completed", rawOutput: { exitCode: 0, stdout: "hello\n", stderr: "" } });
  }
  if (wants("write")) {
    const filePath = join(session.cwd, "new.txt");
    update(id, { sessionUpdate: "tool_call", toolCallId: "write-1", title: "write", kind: "edit", status: "pending", locations: [], rawInput: {} });
    update(id, { sessionUpdate: "tool_call_update", toolCallId: "write-1", title: "write", kind: "edit", status: "in_progress", locations: [{ path: filePath }], rawInput: { filePath, content: "one\ntwo" } });
    update(id, {
      sessionUpdate: "tool_call_update",
      toolCallId: "write-1",
      status: "completed",
      title: filePath.slice(1),
      content: [{ type: "content", content: { type: "text", text: "Wrote file successfully." } }],
      rawOutput: { output: "Wrote file successfully." },
    });
  }
  if (wants("approve")) {
    const command = "rm -rf ./build";
    update(id, { sessionUpdate: "tool_call", toolCallId: "ask-1", title: "bash", kind: "execute", status: "pending", locations: [{ path: session.cwd }], rawInput: {} });
    update(id, { sessionUpdate: "tool_call_update", toolCallId: "ask-1", title: command, kind: "execute", status: "in_progress", rawInput: { command } });
    const answer = await ask("session/request_permission", {
      sessionId: id,
      toolCall: { toolCallId: "ask-1", title: command, kind: "execute", status: "pending", rawInput: { command } },
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "always", kind: "allow_always", name: "Always allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    });
    const outcome = answer.result?.outcome;
    if (outcome?.outcome === "selected" && outcome.optionId !== "reject") {
      update(id, { sessionUpdate: "tool_call_update", toolCallId: "ask-1", status: "completed", content: [{ type: "content", content: { type: "text", text: `ran with ${outcome.optionId}` } }], rawOutput: { metadata: { exit: 0 } } });
      text(id, "The command ran. ");
    } else {
      const why = outcome?.outcome === "cancelled" ? "Tool execution aborted" : "The user rejected permission to use this specific tool call.";
      update(id, { sessionUpdate: "tool_call_update", toolCallId: "ask-1", status: "failed", content: [{ type: "content", content: { type: "text", text: why } }], rawOutput: { error: why } });
      if (outcome?.outcome === "cancelled") return "cancelled";
      text(id, "You said no. ");
    }
  }
  if (wants("editor")) {
    const answer = await ask("fs/write_text_file", { sessionId: id, path: join(session.cwd, "x.txt"), content: "x" });
    text(id, `The client answered ${answer.error?.code ?? "yes"}. `);
  }
  if (wants("slow")) {
    for (let index = 0; index < 60; index += 1) {
      if (stopping.has(id)) return "cancelled";
      text(id, `word${index} `);
      await sleep(25);
    }
  }

  let reply = `pong: ${said}`;
  if (wants("where")) reply = `pid=${process.pid} cwd=${process.cwd()}`;
  // In the stand-in's own process group, as what an agent starts is unless it says otherwise.
  if (wants("helper")) reply = `helper=${spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000);"], { stdio: "ignore" }).pid}`;
  if (wants("model")) reply = `model=${session.model} level=${session.level}`;
  if (images > 0) reply += ` (${images} image${images === 1 ? "" : "s"})`;
  const messageId = randomUUID();
  text(id, reply.slice(0, 5), messageId);
  text(id, reply.slice(5), messageId);
  if (features.has("junk")) text(id, "\n\nError: RetriableError: WritableIterable is closed");
  session.said.push({ role: "agent", text: reply });
  update(id, { sessionUpdate: "usage_update", used: 1000 + session.said.length, size: 100_000 });
  return stopping.has(id) ? "cancelled" : "end_turn";
}

async function handle(method: string, params: any): Promise<unknown> {
  appendFileSync(join(directory, "calls.jsonl"), JSON.stringify({ pid: process.pid, cwd: process.cwd(), method, params }) + "\n");
  if (cursor) return handleAsCursor(method, params);
  switch (method) {
    case "initialize":
      return {
        protocolVersion: features.has("version2") ? 2 : 1,
        agentInfo: { name: "standin", title: "Stand-in", version: "1.0.0" },
        agentCapabilities: {
          loadSession: !features.has("noload"),
          promptCapabilities: { image: true },
          sessionCapabilities: features.has("resume") ? { resume: {} } : {},
        },
        authMethods: [{ id: "standin-login", name: "Log in", description: "Run `standin login` in the terminal" }],
      };
    case "session/new": {
      if (features.has("signedout")) throw { code: -32000, message: "Authentication required" };
      const session: Stored = { id: `standin-${randomUUID()}`, cwd: params.cwd, model: models[0].value, level: "low", said: [] };
      sessions.set(session.id, session);
      save(session);
      setImmediate(() =>
        update(session.id, {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "review", description: "Review the changes" },
            { name: "explain", description: "Explain a file", input: { hint: "<file>" } },
          ],
        }),
      );
      return { sessionId: session.id, configOptions: configOptions(session) };
    }
    case "session/load":
    case "session/resume": {
      if (method === "session/resume" && !features.has("resume")) throw { code: -32601, message: "Method not found" };
      const session = known(params.sessionId);
      if (!session) throw { code: -32002, message: "Resource not found", data: `no session ${params.sessionId}` };
      if (method === "session/load") {
        for (const entry of session.said) {
          update(session.id, { sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: entry.text } });
        }
      }
      return { configOptions: configOptions(session) };
    }
    case "session/set_config_option": {
      const session = known(params.sessionId);
      if (!session) throw { code: -32002, message: "Resource not found" };
      if (params.configId === "model") session.model = params.value;
      else if (params.configId === "effort") session.level = params.value;
      else throw { code: -32602, message: "Invalid params", data: `no option ${params.configId}` };
      save(session);
      return { configOptions: configOptions(session) };
    }
    case "session/prompt": {
      const session = known(params.sessionId);
      if (!session) throw { code: -32002, message: "Resource not found" };
      stopping.delete(session.id);
      try {
        return { stopReason: await turn(session, params.prompt) };
      } finally {
        save(session);
      }
    }
    default:
      throw { code: -32601, message: "Method not found" };
  }
}

// MARK: Cursor's ways
//
// With the feature `cursor` the stand-in behaves as Cursor 2026.10.01 was recorded to
// (test/fixtures/cursor), as far as the bridge depends on it:
//
// - Its models are listed plainly, also without a session (`cursor/list_available_models`).
//   The model is the program's and not a session's: selecting one selects it for every
//   session, and it is kept in `settings.json` as Cursor keeps it in its own settings. A
//   session's options are its mode, the model, and that model's own settings.
// - A session is kept only once it got a message: loading one that never did is -32602,
//   as is a prompt for a session this run has not loaded. A load selects the model the
//   session last ran on, as Cursor's code has it. (The one live look at a load saw Cursor
//   stay on its model; the stand-in keeps the case that asks more of the bridge.)
// - A second prompt for a session cancels the one running, which is answered first.
// - A tool call is never `failed`, and a stopped turn says nothing more of a call that
//   was running. Tool call ids have a newline in them.
// - Its own requests (`cursor/…`) name a tool call and no session, and are numbered from 0.
// - A turn that ends by itself ends with a line of its own after the reply, except one
//   that ends on an accepted plan, which says nothing more at all.
// - It is signed out for the whole run when it starts with a file `signed-out` in
//   ACP_STANDIN_DIR (or the feature `signedout`).
// - It takes no mode (`session/set_mode` fails) while a file `no-modes` is in ACP_STANDIN_DIR.
//
// Words in the prompt, whole words only, beside think, title, tool, slow, where, helper,
// editor, fail, gasp and crash from above:
//   mode       says the session's mode
//   path       says the PATH its process runs with
//   model      says the model Cursor is on and that model's settings
//   switch     changes the session's mode to plan with its own tool, telling nobody
//   toolerror  three tools that did not work: one with an error, one not permitted, one rejected
//   task       a subagent's task; `bgtask` one whose subagent is left running
//   picture    an image generated
//   todos      a to-do list, then two of its items changed; `moretodos` one more item of
//              it changed, as Cursor sends it in a later turn
//   makeplan   a plan to accept or send back; sent back, it plans again. With `linger`
//              it takes a second to end its turn once the plan is accepted
//   ask1       a question to pick one answer to; `askmany` several, `askopen` one with no
//              options, `asknone` a request with no question in it
//   orphan     a plan and a to-do list for tool calls nobody announced
//   late       a plan and a to-do list sent once the turn is over
//   websearch  asks before a web search, under an id of the question's own
//   approve    asks before a command; `editask` before an edit. With `long` the command,
//              once allowed, runs until the turn is stopped
//   sleep      a command that runs until the turn is stopped; `hang` a read that does
//   stubborn   ignores a stop: goes on until a file `let-go` is in ACP_STANDIN_DIR, or a new prompt comes
//   babble     ignores a stop, SIGTERM and the end of its input, and writes a word every 20 ms until it is killed
//   signin     the reply of a session whose sign-in has gone; `refused` the error of one whose
//              sign-in Cursor's backend refuses
//   subagent   a Task whose subagent, in a session of its own, asks before a command, says
//              how many files there are, and ends; with `long` it waits for a stop instead.
//              (Told only to a client that said `_meta.subagents` at hello, as Cursor does.)
//   subquit    a subagent asks before a command, is cancelled while its card is open, and
//              asks again once it has ended; the turn then ends
//   latespawn  a turn that ends, then a subagent told of with no turn open
//   planlimit  a piece of reply, then Cursor's line for a plan that is used up; `turnerror` a
//              piece of reply, then its line for an error; `junkend` a reply, then the error
//              line it ends turns that worked with; `errorword` a reply whose first piece only
//              reads like the error line
//   future     an update of a kind nobody knows, a tool call and a permission request that
//              cannot be read, and a reason for stopping nobody knows

const signedOut = features.has("signedout") || existsSync(join(directory, "signed-out"));
/** It no longer ends when its input does (`babble`). */
let deaf = false;
const authRequired = () => ({ code: -32000, message: "Authentication required" });
const invalid = (message: string) => ({ code: -32602, message: "Invalid params", data: { message } });
let loadsTried = 0;
let toolCalls = 0;
/** The client takes subagent sessions (`subagent`). */
let subagentsSaid = false;
/** Started with `--force`, as Cursor's Run Everything: it asks before nothing. */
const forced = process.argv.includes("--force");
let webRequests = 0;

/** A tool call's id as Cursor makes them, with a newline in it. */
function callID(name: string): string {
  toolCalls += 1;
  return `${name}-${process.pid}-${toolCalls}\nfc_${toolCalls}`;
}

interface Setting {
  id: string;
  category: string;
  values: string[];
  initial: string;
}

/** Cursor's models as the stand-in has them: one with a level, one with thinking on or off before its level, one whose top level has Cursor's other name, one with nothing to set. */
const cursorModels: { value: string; name: string; settings: Setting[] }[] = [
  { value: "default", name: "Auto", settings: [] },
  {
    value: "small",
    name: "Small",
    settings: [
      { id: "effort", category: "thought_level", values: ["low", "medium", "high"], initial: "medium" },
      { id: "fast", category: "model_config", values: ["false", "true"], initial: "true" },
    ],
  },
  {
    value: "large",
    name: "Large",
    settings: [
      { id: "thinking", category: "thought_level", values: ["false", "true"], initial: "true" },
      { id: "effort", category: "thought_level", values: ["low", "medium", "high", "xhigh", "max"], initial: "high" },
    ],
  },
  { value: "deep", name: "Deep", settings: [{ id: "reasoning", category: "thought_level", values: ["none", "low", "medium", "high", "extra-high"], initial: "medium" }] },
  { value: "flat", name: "Flat", settings: [] },
];

const cursorModes = [
  { id: "agent", name: "Agent", description: "Full agent capabilities with tool access" },
  { id: "plan", name: "Plan", description: "Read-only mode for planning and designing before implementation" },
  { id: "ask", name: "Ask", description: "Q&A mode - no edits or command execution" },
];

const permissionOptions = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

/** What Cursor is set to: the model, and each model's settings where they were changed. */
const selected: { model: string; values: Record<string, Record<string, string>> } = existsSync(join(directory, "settings.json"))
  ? JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"))
  : { model: "default", values: {} };

function select(model: string): void {
  selected.model = model;
  writeFileSync(join(directory, "settings.json"), JSON.stringify(selected));
}

function option(setting: Setting, value: string): unknown {
  return { id: setting.id, name: setting.id, category: setting.category, type: "select", currentValue: value, options: setting.values.map((entry) => ({ value: entry, name: entry })) };
}

function currentModel(): (typeof cursorModels)[number] {
  return cursorModels.find((model) => model.value === selected.model) ?? cursorModels[0];
}

/** The settings of the model Cursor is on, as they are now. */
function currentSettings(): [Setting, string][] {
  const model = currentModel();
  return model.settings.map((setting) => [setting, selected.values[model.value]?.[setting.id] ?? setting.initial]);
}

function cursorOptions(session: Stored): unknown[] {
  return [
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: session.mode ?? "agent", options: cursorModes.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description })) },
    { id: "model", name: "Model", category: "model", type: "select", currentValue: selected.model, options: cursorModels.map((model) => ({ value: model.value, name: model.name })) },
    ...currentSettings().map(([setting, value]) => option(setting, value)),
  ];
}

function modesOf(session: Stored): unknown {
  if (features.has("future")) return { currentModeId: "dream", availableModes: [...cursorModes, { id: "dream", name: "Dream" }] };
  return { currentModeId: session.mode ?? "agent", availableModes: cursorModes };
}

function setMode(session: Stored, mode: unknown): void {
  if (!cursorModes.some((known) => known.id === mode)) throw { code: -32603, message: "Internal error", data: { details: `Invalid mode ID: ${String(mode)}. Valid modes: agent, plan, ask` } };
  session.mode = mode as string;
  update(session.id, { sessionUpdate: "current_mode_update", currentModeId: mode });
}

/** A session this run has: made in it, or loaded. */
function live(id: string): Stored {
  const session = sessions.get(id);
  if (!session) throw invalid(`Session "${id}" not found`);
  return session;
}

async function handleAsCursor(method: string, params: any): Promise<unknown> {
  switch (method) {
    case "initialize": {
      // As Cursor reads it, at the top or under `_meta`.
      const said = params?.clientCapabilities;
      subagentsSaid = !!(said?.subagents ?? said?._meta?.subagents);
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { audio: false, embeddedContext: false, image: true }, sessionCapabilities: { list: {}, ...(subagentsSaid ? { subagents: {} } : {}) } },
        authMethods: [{ id: "cursor_login", name: "Cursor Login", description: "Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in." }],
      };
    }
    case "cursor/list_available_models":
      if (features.has("nolist")) throw { code: -32601, message: "Method not found" };
      if (signedOut) throw authRequired();
      await sleep(15);
      return { models: cursorModels.map((model) => ({ value: model.value, name: model.name, configOptions: model.settings.map((setting) => option(setting, selected.values[model.value]?.[setting.id] ?? setting.initial)) })) };
    case "session/new": {
      if (signedOut) throw authRequired();
      await sleep(features.has("slownew") ? 300 : 15);
      const session: Stored = { id: `standin-${randomUUID()}`, cwd: params.cwd, model: selected.model, level: "", mode: "agent", said: [] };
      sessions.set(session.id, session);
      setImmediate(() =>
        update(session.id, {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "copy-request-id", description: "Copy the last request ID to clipboard" },
            { name: "review", description: "Review the changes" },
            { name: "explain", description: "Explain a file", input: { hint: "<file>" } },
          ],
        }),
      );
      return { sessionId: session.id, modes: modesOf(session), configOptions: cursorOptions(session) };
    }
    case "session/load": {
      if (signedOut) throw authRequired();
      await sleep(15);
      if (features.has("loadfails") && loadsTried++ === 0) throw { code: -32603, message: "Internal error", data: { details: "The stand-in could not read the session." } };
      const own = join(directory, `${params.sessionId}.json`);
      const copied = cursorSessions ? join(cursorSessions, params.sessionId, "store.json") : "";
      const file = existsSync(own) ? own : copied && existsSync(copied) ? copied : null;
      // Nothing is kept of a session that never got a message.
      if (!file) throw invalid(`Session "${params.sessionId}" not found`);
      // A copy keeps the id it was made under: it is the requested one's from now on.
      const session = { ...(JSON.parse(readFileSync(file, "utf8")) as Stored), id: params.sessionId };
      sessions.set(session.id, session);
      for (const entry of session.said) {
        update(session.id, { sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: entry.text } });
      }
      select(session.model);
      return { modes: modesOf(session), configOptions: cursorOptions(session) };
    }
    case "session/set_mode":
      if (existsSync(join(directory, "no-modes"))) throw { code: -32603, message: "Internal error", data: { details: "The stand-in takes no mode now." } };
      setMode(live(params.sessionId), params.modeId);
      return {};
    case "session/set_config_option": {
      const session = live(params.sessionId);
      await sleep(30);
      if (params.configId === "mode") {
        setMode(session, params.value);
      } else if (params.configId === "model") {
        if (!cursorModels.some((model) => model.value === params.value)) throw invalid(`Invalid model value: ${params.value}`);
        select(params.value);
      } else {
        const model = currentModel();
        const setting = model.settings.find((entry) => entry.id === params.configId);
        if (!setting?.values.includes(params.value)) throw invalid(`Invalid value for ${params.configId}: ${params.value}`);
        selected.values[model.value] = { ...selected.values[model.value], [setting.id]: params.value };
        select(model.value);
      }
      return { configOptions: cursorOptions(session) };
    }
    case "session/prompt": {
      const session = live(params.sessionId);
      // A second prompt cancels the one running, which is answered first.
      const running = turns.get(session.id);
      if (running) {
        running.cancelled = true;
        running.superseded = true;
        await running.done;
        await sleep(2);
      }
      const ended = Promise.withResolvers<void>();
      const turn: Turn = { cancelled: false, superseded: false, done: ended.promise };
      turns.set(session.id, turn);
      session.model = selected.model;
      try {
        const stopReason = await turnAsCursor(session, params.prompt, turn);
        // An agent that tells what a turn spent (ACP's `usage`), as Cursor does not.
        return JSON.stringify(params.prompt).includes("spend tokens") ? { stopReason, usage: { totalTokens: 4321, inputTokens: 4000, outputTokens: 321 } } : { stopReason };
      } finally {
        if (turns.get(session.id) === turn) turns.delete(session.id);
        save(session);
        ended.resolve();
      }
    }
    default:
      throw { code: -32601, message: "Method not found" };
  }
}

/** One turn, as Cursor runs one; resolves with why it stopped. */
async function turnAsCursor(session: Stored, prompt: { type: string; text?: string }[], turn: Turn): Promise<string> {
  const said = prompt.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
  const images = prompt.filter((block) => block.type === "image").length;
  const has = (word: string) => new RegExp(`\\b${word}\\b`, "i").test(said);
  const id = session.id;
  const cwd = session.cwd;
  session.said.push({ role: "user", text: said });
  const call = (toolCallId: string, fields: Record<string, unknown>) => update(id, { sessionUpdate: "tool_call", toolCallId, status: "pending", ...fields });
  const change = (toolCallId: string, fields: Record<string, unknown>) => update(id, { sessionUpdate: "tool_call_update", toolCallId, ...fields });
  const stopped = (answer: any) => answer.result?.outcome?.outcome === "cancelled" || turn.cancelled;

  if (has("fail")) throw { code: -32603, message: "Internal error", data: { details: "The stand-in failed on purpose." } };
  if (has("title")) update(id, { sessionUpdate: "session_info_update", title: "A title from the stand-in" });
  if (has("think")) {
    update(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me think. " } });
    update(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Done thinking." } });
  }
  if (has("gasp")) process.stderr.write("some warning first\nthe stand-in fell over on purpose\n");
  if (has("crash")) {
    text(id, "About to crash. ");
    await sleep(20);
    process.exit(3);
  }
  if (has("future")) {
    update(id, { sessionUpdate: "hologram_update", light: 1 });
    // A tool call and a permission request in a shape nobody expected.
    update(id, { sessionUpdate: "tool_call", toolCallId: callID("odd"), kind: "read", status: "in_progress", locations: 7 });
    const odd = await ask("session/request_permission", { sessionId: id, toolCall: { toolCallId: callID("odd"), kind: "read", locations: 7 }, options: 5 });
    text(id, `odd=${JSON.stringify(odd.result ?? odd.error)} `);
  }
  if (has("tool")) {
    text(id, "I'll make notes.txt. ");
    const path = join(cwd, "notes.txt");
    const edit = callID("edit");
    call(edit, { title: "Edit File", kind: "edit", rawInput: {} });
    change(edit, { title: `Edit \`${path}\``, rawInput: { path }, locations: [{ path }] });
    change(edit, { status: "in_progress" });
    // A file made new, told with the scraps of a diff's header lines.
    change(edit, { status: "completed", content: [{ type: "diff", path, oldText: "-- /dev/null", newText: `++ b/${path}\nhello` }] });
    const run = callID("run");
    call(run, { title: "`ls no-such-file.txt`", kind: "execute", rawInput: { command: "ls no-such-file.txt" } });
    change(run, { status: "in_progress" });
    change(run, { status: "completed", rawOutput: { exitCode: 1, stdout: "", stderr: "ls: no-such-file.txt: No such file or directory\n" } });
  }
  if (has("toolerror")) {
    const grep = callID("grep");
    call(grep, { title: 'grep "needle"', kind: "search", rawInput: { pattern: "needle" } });
    change(grep, { status: "in_progress" });
    change(grep, { status: "completed", rawOutput: { error: "ripgrep is not installed" } });
    const mcp = callID("mcp");
    call(mcp, { title: "notes: add_note", kind: "other", rawInput: { providerIdentifier: "notes", toolName: "add_note", args: { text: "x" } } });
    change(mcp, { status: "in_progress" });
    change(mcp, { status: "completed", rawOutput: { permissionDenied: true } });
    const fetch = callID("fetch");
    call(fetch, { title: "Web Fetch: https://example.com/", kind: "fetch", rawInput: { url: "https://example.com/" } });
    change(fetch, { status: "in_progress" });
    change(fetch, { status: "completed", rawOutput: { rejected: true, reason: "Blocked by a rule" } });
  }
  if (has("switch")) {
    const switched = callID("switch");
    call(switched, { title: "Switch Mode: unknown", kind: "switch_mode", rawInput: {} });
    change(switched, { title: "Switch Mode: plan", rawInput: { targetModeId: "plan", explanation: "The user asked for a plan." } });
    change(switched, { status: "in_progress" });
    // Told to nobody: no `current_mode_update` follows.
    session.mode = "plan";
    change(switched, { status: "completed" });
  }
  if (has("task") || has("bgtask")) {
    const task = callID("task");
    const input = { _toolName: "task", prompt: "List the files.", description: "Look around", subagentType: "explore" };
    call(task, { title: "Task: Look around", kind: "other", rawInput: input });
    change(task, { status: "in_progress" });
    change(task, { status: "completed", rawOutput: { durationMs: 12, isBackground: has("bgtask") } });
    await ask("cursor/task", { toolCallId: task, description: input.description, prompt: input.prompt, subagentType: input.subagentType, durationMs: 12 });
  }
  if (has("picture")) {
    const image = callID("image");
    call(image, { title: "Generate Image: A red square...", kind: "other", rawInput: { _toolName: "generateImage", description: "A red square", filename: "square.png" } });
    change(image, { status: "in_progress" });
    change(image, { status: "completed" });
    await ask("cursor/generate_image", { toolCallId: image, description: "A red square", filePath: join(cwd, "square.png") });
  }
  if (has("todos") || has("moretodos")) {
    const todo = (letter: string, status: string) => ({ id: letter, content: `make ${letter}.txt`, status });
    const lists = has("todos")
      ? [
          { todos: [todo("a", "in_progress"), todo("b", "pending"), todo("c", "pending")], merge: false },
          { todos: [todo("a", "completed"), todo("b", "in_progress")], merge: true },
        ]
      : [{ todos: [todo("b", "completed")], merge: true }];
    for (const list of lists) {
      const todos = callID("todos");
      call(todos, { title: "Update TODOs", kind: "other", rawInput: { _toolName: "updateTodos" } });
      change(todos, { title: `Update TODOs: ${list.todos.map((entry) => entry.content).join(", ")}`, rawInput: { _toolName: "updateTodos", todos: list.todos } });
      change(todos, { status: "in_progress" });
      change(todos, { status: "completed" });
      // Right after its tool call completed, and with no session named.
      await ask("cursor/update_todos", { toolCallId: todos, ...list });
    }
  }
  if (has("makeplan")) {
    let reason = "";
    for (let round = 1; ; round += 1) {
      const first = round === 1;
      const plan = callID("plan");
      const name = first ? "Add notes.txt" : "Add notes.txt in one step";
      const body = first ? "# Add notes.txt\n\n1. Create the file.\n2. Write hello into it.\n" : "# Add notes.txt\n\n1. Create the file with hello in it.\n";
      const todos = (first ? ["Create the file", "Write hello into it"] : ["Create the file with hello in it"]).map((content, index) => ({ id: `step-${index}`, content, status: "pending" }));
      text(id, first ? "Here is a plan. " : `Planning again: ${reason} `);
      call(plan, { title: "Create Plan", kind: "other", rawInput: { _toolName: "createPlan" } });
      change(plan, { title: `Create Plan: ${name}`, rawInput: { _toolName: "createPlan", name, plan: body } });
      change(plan, { status: "in_progress", content: [{ type: "content", content: { type: "text", text: "Processing plan..." } }] });
      update(id, { sessionUpdate: "plan", entries: todos.map((entry) => ({ content: entry.content, priority: "medium", status: "pending" })) });
      const answer = await ask("cursor/create_plan", { toolCallId: plan, name, overview: "A file that says hello.", plan: body, todos, isProject: false, phases: [] });
      if (stopped(answer)) return "cancelled";
      change(plan, { status: "completed" });
      // An accepted plan ends the turn there, with no more said: Cursor waits for the next
      // message. An error from the client is taken as consent.
      if (answer.error || answer.result?.outcome?.outcome === "accepted") {
        for (let waited = 0; has("linger") && waited < 100 && !turn.cancelled; waited += 1) await sleep(10);
        return turn.cancelled ? "cancelled" : "end_turn";
      }
      reason = answer.result?.outcome?.reason ?? "";
    }
  }
  const asking = ["ask1", "askmany", "askopen", "asknone"].find((word) => has(word));
  if (asking) {
    const options = [
      { id: "py", label: "Python" },
      { id: "sw", label: "Swift" },
      { id: "rs", label: "Rust, with macros" },
    ];
    const questions = asking === "asknone" ? [] : [{ id: "lang", prompt: "Which language?", options: asking === "askopen" ? [] : options, allowMultiple: asking === "askmany" }];
    const question = callID("question");
    call(question, { title: "Language", kind: "think", rawInput: { _toolName: "askQuestion", title: "Language", questions } });
    change(question, { status: "in_progress" });
    const answer = await ask("cursor/ask_question", { toolCallId: question, title: "Language", questions });
    if (stopped(answer)) return "cancelled";
    change(question, { status: "completed" });
    text(id, `answer=${JSON.stringify(answer.result ?? answer.error)} `);
  }
  if (has("orphan")) {
    const plan = await ask("cursor/create_plan", { toolCallId: "nobody-1", name: "Orphan", overview: "", plan: "# Orphan", todos: [], isProject: false, phases: [] });
    const todos = await ask("cursor/update_todos", { toolCallId: "nobody-2", todos: [{ id: "x", content: "an orphan", status: "pending" }], merge: false });
    text(id, `plan=${JSON.stringify(plan.result ?? plan.error)} todos=${JSON.stringify(todos.result ?? todos.error)} `);
  }
  if (has("late")) {
    const plan = callID("plan");
    call(plan, { title: "Create Plan", kind: "other", rawInput: { _toolName: "createPlan" } });
    change(plan, { status: "in_progress" });
    change(plan, { status: "completed" });
    // Once the turn is over, about a tool call of that turn.
    setTimeout(() => {
      void ask("cursor/create_plan", { toolCallId: plan, name: "Late", overview: "", plan: "# Late", todos: [], isProject: false, phases: [] });
      void ask("cursor/update_todos", { toolCallId: plan, todos: [{ id: "x", content: "late", status: "pending" }], merge: false });
    }, 60);
  }
  if (has("websearch")) {
    const search = callID("search");
    call(search, { title: "Web Search", kind: "search", rawInput: {} });
    change(search, { title: 'Web Search: "agent client protocol"', rawInput: { searchTerm: "agent client protocol" } });
    // Under an id of the question's own, not the search's.
    const answer = await ask("session/request_permission", {
      sessionId: id,
      toolCall: { toolCallId: `web_search_${webRequests++}`, title: "Web search: agent client protocol", kind: "search", status: "pending" },
      options: permissionOptions,
    });
    if (stopped(answer)) return "cancelled";
    const outcome = answer.result?.outcome;
    const allowed = outcome?.outcome === "selected" && outcome.optionId !== "reject-once";
    change(search, { status: "in_progress" });
    change(search, { status: "completed", rawOutput: allowed ? { referenceCount: 3 } : { rejected: true, reason: "User rejected" } });
    text(id, allowed ? `Searched with ${outcome.optionId}. ` : "The search was rejected. ");
  }
  if (has("approve") || has("editask")) {
    const edit = has("editask");
    const path = join(cwd, "hello.txt");
    const command = "rm -rf ./build";
    const diff = { type: "diff", path, oldText: "hi\n", newText: "hello\n" };
    const asked = callID(edit ? "edit" : "run");
    if (edit) {
      call(asked, { title: "Edit File", kind: "edit", rawInput: {} });
      change(asked, { title: `Edit \`${path}\``, rawInput: { path }, locations: [{ path }] });
    } else {
      call(asked, { title: `\`${command}\``, kind: "execute", rawInput: { command } });
    }
    const toolCall = edit
      ? { toolCallId: asked, title: `Edit \`${path}\``, kind: "edit", status: "pending", content: [diff] }
      : { toolCallId: asked, title: `\`${command}\``, kind: "execute", status: "pending", content: [{ type: "content", content: { type: "text", text: "It removes the build folder." } }] };
    // Run with --force, Cursor asks nothing and runs it.
    const answer = forced ? { result: { outcome: { outcome: "selected", optionId: "run-everything" } } } : await ask("session/request_permission", { sessionId: id, toolCall, options: permissionOptions });
    if (stopped(answer)) return "cancelled";
    const outcome = answer.result?.outcome;
    change(asked, { status: "in_progress" });
    if (outcome?.outcome === "selected" && outcome.optionId !== "reject-once") {
      if (has("long")) {
        // A stopped turn says nothing more of a call that was running.
        while (!turn.cancelled) await sleep(10);
        return "cancelled";
      }
      change(asked, { status: "completed", ...(edit ? { content: [diff] } : { rawOutput: { exitCode: 0, stdout: `ran with ${outcome.optionId}\n`, stderr: "" } }) });
      text(id, "It was allowed. ");
    } else {
      // Never `failed`, and nothing is said of what a rejected call returned.
      change(asked, { status: "completed" });
      text(id, "You said no. ");
    }
  }
  if (has("editor")) {
    const answer = await ask("fs/write_text_file", { sessionId: id, path: join(cwd, "x.txt"), content: "x" });
    text(id, `The client answered ${answer.error?.code ?? "yes"}. `);
  }
  if (has("sleep") || has("hang")) {
    if (has("sleep")) {
      const run = callID("run");
      call(run, { title: "`sleep 47`", kind: "execute", rawInput: { command: "sleep 47" } });
      change(run, { status: "in_progress" });
    }
    if (has("hang")) {
      const path = join(cwd, "big.txt");
      const read = callID("read");
      call(read, { title: "Read big.txt", kind: "read", rawInput: { path }, locations: [{ path }] });
      change(read, { status: "in_progress" });
    }
    // A stopped turn says nothing more of a call that was running.
    while (!turn.cancelled) await sleep(10);
    return "cancelled";
  }
  if (has("stubborn")) {
    text(id, "Working on. ");
    // A stop is ignored; only a new prompt for the session ends it early.
    while (!existsSync(join(directory, "let-go")) && !turn.superseded) await sleep(10);
    if (turn.superseded) return "cancelled";
  }
  if (has("babble")) {
    deaf = true;
    process.on("SIGTERM", () => undefined);
    for (;;) {
      text(id, "old ");
      await sleep(20);
    }
  }
  if (has("slow")) {
    for (let index = 0; index < 60; index += 1) {
      if (turn.cancelled) return "cancelled";
      text(id, `word${index} `);
      await sleep(25);
    }
  }
  if (has("signin")) {
    text(id, "Please sign in to continue");
    return "end_turn";
  }
  if (has("refused")) {
    text(id, "\n\nError: [unauthenticated] Backend rejected authentication. Verify this is a User API Key for the same endpoint/environment, then rerun with --debug for request-level auth logs.");
    return "end_turn";
  }
  if (has("subagent") && subagentsSaid) {
    const task = callID("task");
    const child = randomUUID();
    const meta = { cursor: { toolCallId: task, agentId: child, model: "default" } };
    call(task, { title: "Task: Count the files", kind: "other", rawInput: { _toolName: "task", description: "Count the files", prompt: "List the files here and count them." } });
    change(task, { status: "in_progress" });
    update(id, { sessionUpdate: "subagent_spawned", subagentSessionId: child, name: "generalPurpose", task: "List the files here and count them.", capabilities: {}, _meta: meta });
    text(child, "Listing them. ");
    const run = callID("run");
    update(child, { sessionUpdate: "tool_call", toolCallId: run, status: "pending", title: "`ls`", kind: "execute", rawInput: { command: "ls" } });
    const answer = await ask("session/request_permission", { sessionId: child, toolCall: { toolCallId: run, title: "`ls`", kind: "execute", status: "pending" }, options: permissionOptions });
    if (!stopped(answer) && has("long")) while (!turn.cancelled) await sleep(10);
    if (stopped(answer) || turn.cancelled) {
      update(id, { sessionUpdate: "subagent_state_update", subagentSessionId: child, state: "cancelled", _meta: meta });
      return "cancelled";
    }
    update(child, { sessionUpdate: "tool_call_update", toolCallId: run, status: "completed", rawOutput: { exitCode: 0, stdout: "a\nb\nc\n", stderr: "" } });
    text(child, "There are 3 files.");
    update(id, { sessionUpdate: "subagent_state_update", subagentSessionId: child, state: "completed", _meta: meta });
    change(task, { status: "completed" });
    text(id, "The subagent counted 3 files.");
    return "end_turn";
  }
  if (has("subquit") && subagentsSaid) {
    const child = randomUUID();
    const meta = { cursor: { toolCallId: "none", agentId: child, model: "default" } };
    update(id, { sessionUpdate: "subagent_spawned", subagentSessionId: child, name: "generalPurpose", task: "Run a command.", capabilities: {}, _meta: meta });
    const run = callID("run");
    update(child, { sessionUpdate: "tool_call", toolCallId: run, status: "pending", title: "`ls`", kind: "execute", rawInput: { command: "ls" } });
    const first = ask("session/request_permission", { sessionId: child, toolCall: { toolCallId: run, title: "`ls`", kind: "execute", status: "pending" }, options: permissionOptions });
    await sleep(100);
    update(id, { sessionUpdate: "subagent_state_update", subagentSessionId: child, state: "cancelled", _meta: meta });
    const firstAnswer = await first;
    const again = await ask("session/request_permission", { sessionId: child, toolCall: { toolCallId: callID("run"), title: "`pwd`", kind: "execute", status: "pending" }, options: permissionOptions });
    // An ended subagent's own subagent: not on the line, and its question goes to nobody.
    const grandchild = randomUUID();
    update(child, { sessionUpdate: "subagent_spawned", subagentSessionId: grandchild, name: "explore", task: "Too late.", capabilities: {}, _meta: {} });
    const grand = await ask("session/request_permission", { sessionId: grandchild, toolCall: { toolCallId: callID("run"), title: "`date`", kind: "execute", status: "pending" }, options: permissionOptions });
    // And a question of its, which names its tool call and no session.
    const asking = callID("ask");
    update(grandchild, { sessionUpdate: "tool_call", toolCallId: asking, status: "pending", title: "Ask Question", kind: "other", rawInput: {} });
    const question = await ask("cursor/ask_question", { toolCallId: asking, title: "Which?", questions: [{ id: "q", prompt: "Which one?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], allowMultiple: false }] });
    text(id, `first=${firstAnswer.result?.outcome?.outcome} again=${again.result?.outcome?.outcome} grand=${grand.result?.outcome?.outcome} question=${question.result?.outcome?.outcome}`);
    return "end_turn";
  }
  if (has("latespawn") && subagentsSaid) {
    setTimeout(() => update(id, { sessionUpdate: "subagent_spawned", subagentSessionId: randomUUID(), name: "generalPurpose", task: "Too late.", capabilities: {}, _meta: {} }), 50);
    text(id, "done");
    return "end_turn";
  }
  if (has("planlimit") || has("turnerror") || has("junkend")) {
    text(id, "Half an answer");
    await sleep(20);
    text(id, has("planlimit") ? "\n\nUpgrade your plan to continue" : has("turnerror") ? "\n\nError: ConnectError: [unavailable] network is down" : "\n\nError: RetriableError: WritableIterable is closed");
    return "end_turn";
  }
  if (has("errorword")) {
    text(id, "\n\nError: is a word");
    await sleep(20);
    text(id, " in this reply.");
    return "end_turn";
  }

  const parts: string[] = [];
  if (has("where")) parts.push(`pid=${process.pid} cwd=${process.cwd()}`);
  if (has("forced")) parts.push(`forced=${forced}`);
  // How much of the conversation this process has of the session: the user's messages up to this one.
  if (has("heard")) parts.push(`heard=${session.said.filter((entry) => entry.role === "user").length}`);
  // In the stand-in's own process group, as what an agent starts is unless it says otherwise.
  if (has("helper")) parts.push(`helper=${spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000);"], { stdio: "ignore" }).pid}`);
  if (has("model")) parts.push([`model=${selected.model}`, ...currentSettings().map(([setting, value]) => `${setting.id}=${value}`)].join(" "));
  if (has("mode")) parts.push(`mode=${session.mode}`);
  if (has("path")) parts.push(`path=${process.env.PATH}`);
  let reply = parts.length > 0 ? parts.join(" ") : `pong: ${said}`;
  if (images > 0) reply += ` (${images} image${images === 1 ? "" : "s"})`;
  text(id, reply.slice(0, 5));
  text(id, reply.slice(5));
  session.said.push({ role: "agent", text: reply });
  if (turn.cancelled && !has("stubborn")) return "cancelled";
  text(id, "\n\nError: RetriableError: WritableIterable is closed");
  // ACP's own reason for a reply the model declined, which Cursor has not been seen to send.
  if (has("decline")) return "refusal";
  return has("future") ? "enlightened" : "end_turn";
}

function receive(line: string): void {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    answers.get(message.id)?.(message);
    answers.delete(message.id);
    return;
  }
  if (message.id === undefined) {
    appendFileSync(join(directory, "calls.jsonl"), JSON.stringify({ pid: process.pid, cwd: process.cwd(), method: message.method, params: message.params }) + "\n");
    if (message.method === "session/cancel") {
      stopping.add(message.params.sessionId);
      const turn = turns.get(message.params.sessionId);
      if (turn) turn.cancelled = true;
      // The questions it has open are answered by the client; nothing more to do here.
    }
    return;
  }
  const session = message.params?.sessionId;
  const mark = (event: string) => appendFileSync(join(directory, "timeline.jsonl"), JSON.stringify({ pid: process.pid, event, method: message.method, session }) + "\n");
  mark("got");
  handle(message.method, message.params ?? {}).then(
    (result) => {
      mark("answered");
      send({ id: message.id, result });
    },
    (error) => {
      mark("answered");
      send({ id: message.id, error: typeof error?.code === "number" ? error : { code: -32603, message: String(error?.message ?? error) } });
    },
  );
}

if (features.has("noise")) process.stdout.write('Stand-in 1.0.0, starting up\n42\n["not", "a", "message"]\n');

// One message per line, and a line ends at LF only: U+2028 is legal inside a JSON string.
let rest = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  const lines = (rest + chunk).split("\n");
  rest = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() !== "") receive(line);
  }
});

// The client closed its end: the bridge is gone.
process.stdin.on("end", () => {
  if (!deaf && !features.has("lingers")) process.exit(0);
});
