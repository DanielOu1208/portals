import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";
import { JsonChild, type ChildExit } from "../src/providers/child.ts";
import { programVersion } from "../src/providers/program.ts";

// Records what Cursor really sends over the Agent Client Protocol, for the golden tests
// in test/cursor-*.test.ts. Each scenario starts `cursor-agent acp` itself in a scratch
// folder of its own under /tmp, speaks JSON-RPC 2.0 with it (one message per
// line), sends short harmless prompts on Cursor's Auto model, and writes every message
// both ways to test/fixtures/cursor/<scenario>.jsonl. Paths, names and ids are replaced
// before anything is written.
//
//   node scripts/record-cursor.ts [scenario…]     (all of them when none is named)
//   node scripts/record-cursor.ts --check          (says what Cursor is set to; changes nothing)
//   node scripts/record-cursor.ts --put-back       (after a run that died: Cursor's model back as it was)
//
// It uses the user's Cursor sign-in and plan, as the bridge does; keep runs rare. With
// RECORD_TURNS=<file> each model turn is also written there as a line, and no turn is
// sent once the file has RECORD_TURN_LIMIT lines. RECORD_ROOT is the scratch folder.
//
// What a run does to Cursor itself, because its protocol leaves no other way:
//
// - The model. One can only be chosen by selecting it in Cursor, which Cursor writes to
//   its own settings: the terminal's Cursor is on it too. So a run first notes what
//   Cursor is on (cursor-was-on.json in the scratch folder), selects Auto, and before it
//   ends selects the old model and its settings again, also when it is interrupted. One
//   `cursor-agent` runs at a time: two could each write those settings. (One scenario,
//   question-mini, selects another small model for its turn and Auto again after it.)
// - Sessions. Cursor has no call to delete one. Every session a run makes stays in
//   ~/.cursor/acp-sessions/; their ids are added to sessions.txt in the scratch folder.
// - A folder of Cursor's own for each scratch folder, in ~/.cursor/projects/ (its index
//   log, and a copy of any image a prompt carried). Nothing removes those either.
// - The allowlist is never touched: a permission request is never answered "always".
// - A plan is accepted with a place for it in the scratch folder, or Cursor would save
//   it in ~/.cursor/plans/.
//
// A line of a recording is one message, with `at` (milliseconds since the scenario
// began) and `kind`:
//
//   meta          the scenario, Cursor's version, the model
//   start         a `cursor-agent acp` process was started
//   send          from the recorder: a request (`id`, `method`, `params`) or, with no `id`, a notification
//   response      Cursor's answer to a request (`id`, its `method`, and `result` or `error`)
//   notification  from Cursor (`method`, `params`): a `session/update` for the most part
//   request       from Cursor (`id`, `method`, `params`): a permission, a question, a plan, to-dos
//   answer        the recorder's answer to it (`id`, its `method`, and `result` or `error`)
//   line          something Cursor printed that is not JSON
//   kill          the recorder killed the process
//   exit          the process ended (`code`, `signal`; `asked`: by the recorder's stop)

const cursorPath = join(homedir(), ".local", "bin", "cursor-agent");
const root = process.env.RECORD_ROOT ?? join(realpathSync("/tmp"), "portals-cursor-record");
const fixtures = resolve(import.meta.dirname, "../test/fixtures/cursor");
const wasPath = join(root, "cursor-was-on.json");
/** Cursor's "Auto", which every scenario runs on. */
const model = "default";
/** A turn that has not ended by then is stopped, and its scenario fails. */
const turnLimitMs = 240_000;

/** What the bridge says at hello: models come plain, with their settings as options of their own. */
const hello = {
  protocolVersion: 1,
  clientCapabilities: { _meta: { parameterizedModelPicker: true } },
  clientInfo: { name: "portals-bridge", title: "Portals (recording)", version: "0.1.0" },
};

type Line = Record<string, any>;
type Block = { type: string; [key: string]: unknown };
/** What a call came to: Cursor's answer, or `stopped` when the process ended first. */
interface Reply {
  result?: any;
  error?: { code: number; message: string; data?: unknown };
  stopped?: string;
}
type Answer = (params: any) => Reply | Promise<Reply>;

// MARK: Answers to Cursor's requests

const permission =
  (optionId: "allow-once" | "reject-once"): Answer =>
  () => ({ result: { outcome: { outcome: "selected", optionId } } });

/** A scenario changes the ones it is about. */
const standardAnswers: Record<string, Answer> = {
  "session/request_permission": permission("reject-once"),
  "cursor/ask_question": () => ({ result: { outcome: { outcome: "skipped" } } }),
  "cursor/create_plan": () => ({ result: { outcome: { outcome: "cancelled" } } }),
  // Cursor does not wait on these three.
  "cursor/update_todos": () => ({ result: {} }),
  "cursor/task": () => ({ result: {} }),
  "cursor/generate_image": () => ({ result: {} }),
};

/** As the bridge answers what it has no part in. */
const refuse =
  (method: string): Answer =>
  () => ({ error: { code: -32601, message: `Portals does not handle ${method}.` } });

/** Answers each question with its option whose label holds `label`. */
const pick =
  (label: string): Answer =>
  (params) => ({
    result: {
      outcome: {
        outcome: "answered",
        answers: (params.questions ?? []).map((question: { id: string; options: { id: string; label: string }[] }) => ({
          questionId: question.id,
          selectedOptionIds: [(question.options.find((option) => option.label.includes(label)) ?? question.options[0]!).id],
        })),
      },
    },
  });

// MARK: One process

/** The process a signal has to stop before Cursor's model is put back. */
let current: Agent | null = null;
/** The run was interrupted: nothing more is started. */
let ending = false;

/** One `cursor-agent acp` process, and JSON-RPC with it. Every message goes to `add`. */
class Agent {
  readonly exited: Promise<ChildExit>;
  private readonly child: JsonChild;
  private readonly add: (line: Line) => void;
  private readonly answers: () => Record<string, Answer>;
  private nextID = 1;
  private readonly waiting = new Map<number, { method: string; settle(reply: Reply): void }>();

  constructor(cwd: string, add: (line: Line) => void, answers: () => Record<string, Answer>) {
    this.add = add;
    this.answers = answers;
    const gone = Promise.withResolvers<ChildExit>();
    this.exited = gone.promise;
    add({ kind: "start" });
    this.child = new JsonChild({
      name: "Cursor",
      command: cursorPath,
      args: ["acp"],
      env: process.env,
      cwd,
      listener: {
        message: (value) => this.receive(value as Line),
        notJSON: (text) => add({ kind: "line", text }),
        exited: (exit) => {
          add({ kind: "exit", code: exit.code, signal: exit.signal, asked: exit.asked, error: exit.error, last_words: exit.lastWords });
          for (const call of this.waiting.values()) call.settle({ stopped: exit.reason });
          this.waiting.clear();
          gone.resolve(exit);
        },
      },
    });
    current = this;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  call(method: string, params: unknown): Promise<Reply> {
    const id = this.nextID++;
    this.add({ kind: "send", id, method, params });
    return new Promise((settle) => {
      this.waiting.set(id, { method, settle });
      if (this.child.send({ jsonrpc: "2.0", id, method, params })) return;
      this.waiting.delete(id);
      settle({ stopped: "Cursor is not running." });
    });
  }

  notify(method: string, params: unknown): void {
    this.add({ kind: "send", method, params });
    this.child.send({ jsonrpc: "2.0", method, params });
  }

  async stop(): Promise<void> {
    await this.child.stop();
    if (current === this) current = null;
  }

  private receive(message: Line): void {
    if (typeof message.method === "string") {
      if (message.id === undefined || message.id === null) {
        this.add({ kind: "notification", method: message.method, params: message.params });
      } else {
        this.add({ kind: "request", id: message.id, method: message.method, params: message.params });
        void this.respond(message.id, message.method, message.params);
      }
      return;
    }
    const call = this.waiting.get(message.id);
    const reply: Reply = message.error ? { error: message.error } : { result: message.result };
    this.add({ kind: "response", id: message.id, method: call?.method, ...reply });
    this.waiting.delete(message.id);
    call?.settle(reply);
  }

  private async respond(id: string | number, method: string, params: unknown): Promise<void> {
    let reply = await (this.answers()[method] ?? refuse(method))(params);
    // "Always" would write Cursor's own allowlist.
    if (reply.result?.outcome?.optionId === "allow-always") reply = { result: { outcome: { outcome: "selected", optionId: "reject-once" } } };
    this.add({ kind: "answer", id, method, ...reply });
    this.child.send({ jsonrpc: "2.0", id, ...reply });
  }
}

interface Process {
  pid: number;
  /** Its process group. */
  group: number;
  command: string;
}

/** The processes whose command line holds `text`: what a stop or a kill left running. */
function running(text: string): Process[] {
  try {
    const pids = execFileSync("pgrep", ["-f", text], { encoding: "utf8" }).trim().split("\n");
    const listed = execFileSync("ps", ["-o", "pid=,pgid=,command=", "-p", pids.join(",")], { encoding: "utf8" });
    return [...listed.matchAll(/^\s*(\d+)\s+(\d+)\s+(.*)$/gm)].map((found) => ({ pid: Number(found[1]), group: Number(found[2]), command: found[3]! }));
  } catch {
    return []; // pgrep found none
  }
}

function shown(processes: Process[]): string {
  const short = (command: string) => (command.length > 60 ? `${command.slice(0, 28)} … ${command.slice(-24)}` : command);
  return processes.map(({ pid, group, command }) => `${pid} (group ${group}) ${short(command)}`).join("; ") || "nothing";
}

/** Ends what a scenario's command left running, and says what that was. */
function endLeftovers(scenario: string, text: string): void {
  const left = running(text);
  console.log(`${scenario}: left running once Cursor was gone: ${shown(left)}`);
  for (const { pid } of left) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone by itself
    }
  }
}

/** Whether any process of the group `pid` headed is left. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

// MARK: Cursor's own model

/** What Cursor is set to: its model, and that model's settings (its thinking level and the like). */
interface Selection {
  model: string;
  settings: Record<string, string>;
}

/** Read from what `session/new`, `session/load` and `session/set_config_option` answer. */
function selectionIn(state: any): Selection {
  const selection: Selection = { model: "", settings: {} };
  for (const option of state?.configOptions ?? []) {
    if (option.id === "model") selection.model = String(option.currentValue);
    else if (option.id !== "mode") selection.settings[option.id] = String(option.currentValue);
  }
  return selection;
}

function describe(selection: Selection): string {
  const settings = Object.entries(selection.settings).map(([id, value]) => `${id} ${value}`);
  return [selection.model, ...settings].join(", ");
}

function same(a: Selection, b: Selection): boolean {
  return a.model === b.model && Object.entries(b.settings).every(([id, value]) => a.settings[id] === value);
}

function noteSession(scenario: string, id: string): void {
  appendFileSync(join(root, "sessions.txt"), `${id} ${scenario}\n`);
}

/** A process with a session, for reading and setting Cursor's model outside any recording. */
async function control(): Promise<{ agent: Agent; session: string; on: Selection }> {
  mkdirSync(root, { recursive: true });
  const agent = new Agent(
    root,
    () => undefined,
    () => standardAnswers,
  );
  const started = await agent.call("initialize", hello);
  const made = started.result ? await agent.call("session/new", { cwd: root, mcpServers: [] }) : started;
  if (!made.result?.sessionId) {
    await agent.stop();
    throw new Error(`Cursor did not start a session: ${JSON.stringify(made)}`);
  }
  noteSession("(model)", made.result.sessionId);
  return { agent, session: made.result.sessionId, on: selectionIn(made.result) };
}

async function set(agent: Agent, session: string, id: string, value: string): Promise<Selection> {
  const reply = await agent.call("session/set_config_option", { sessionId: session, configId: id, value });
  if (!reply.result) throw new Error(`Cursor did not set ${id} to ${value}: ${JSON.stringify(reply)}`);
  return selectionIn(reply.result);
}

/** Notes what Cursor is on, and selects the recording's model. */
async function selectModel(): Promise<Selection> {
  const { agent, session, on } = await control();
  try {
    // A note left by a run that died says what Cursor was on before that run.
    const was: Selection = existsSync(wasPath) ? JSON.parse(readFileSync(wasPath, "utf8")) : on;
    writeFileSync(wasPath, JSON.stringify(was, null, 2) + "\n");
    console.log(`Cursor was on ${describe(was)}`);
    if (on.model !== model) await set(agent, session, "model", model);
    return was;
  } finally {
    await agent.stop();
  }
}

let puttingBack: Promise<void> | null = null;

/** Selects the model Cursor was on again, with its settings, and forgets the note. Once, however a run ends. */
function putBack(): Promise<void> {
  puttingBack ??= selectAgain();
  return puttingBack;
}

async function selectAgain(): Promise<void> {
  if (!existsSync(wasPath)) return;
  const was: Selection = JSON.parse(readFileSync(wasPath, "utf8"));
  const { agent, session, on } = await control();
  try {
    let now = on;
    if (now.model !== was.model) now = await set(agent, session, "model", was.model);
    for (const [id, value] of Object.entries(was.settings)) {
      if (now.settings[id] !== value) now = await set(agent, session, id, value);
    }
    if (!same(now, was)) throw new Error(`Cursor is on ${describe(now)}, not back on ${describe(was)}; ${wasPath} is kept.`);
    rmSync(wasPath);
    console.log(`Cursor is back on ${describe(now)}`);
  } finally {
    await agent.stop();
  }
}

// MARK: One scenario

let turns = 0;

/** Counts a model turn; refuses it when the file RECORD_TURNS names is full. */
function countTurn(scenario: string): void {
  const file = process.env.RECORD_TURNS;
  if (file) {
    const limit = Number(process.env.RECORD_TURN_LIMIT ?? Infinity);
    const used = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
    if (used >= limit) throw new Error(`${file} has ${used} turns, and the limit is ${limit}.`);
    appendFileSync(file, `${new Date().toISOString()} record ${scenario}\n`);
  }
  turns += 1;
}

/** What a scenario works with: its folder, its processes one after another, and the lines recorded. */
class Run {
  readonly name: string;
  readonly cwd: string;
  /** What Cursor was on before the run. */
  readonly was: Selection;
  readonly lines: Line[] = [];
  /** The sessions it made, in order. */
  readonly sessions: string[] = [];
  /** How Cursor's requests are answered. */
  answers: Record<string, Answer> = { ...standardAnswers };
  private agent: Agent | null = null;
  private readonly began = Date.now();
  private readonly watchers = new Set<() => void>();

  constructor(name: string, cwd: string, was: Selection) {
    this.name = name;
    this.cwd = cwd;
    this.was = was;
  }

  readonly add = (line: Line): void => {
    this.lines.push({ ...line, at: Date.now() - this.began });
    for (const look of [...this.watchers]) look();
  };

  /** Starts a process and says hello; `subagents` says the recorder takes Cursor's subagent sessions, as the bridge does. */
  async start(options: { subagents?: boolean } = {}): Promise<void> {
    if (ending) throw new Error("the run was interrupted");
    this.agent = new Agent(this.cwd, this.add, () => this.answers);
    // Under `_meta`: ACP's own schema leaves out a key of the client's capabilities it does not know.
    const said = options.subagents ? { ...hello, clientCapabilities: { _meta: { ...hello.clientCapabilities._meta, subagents: {} } } } : hello;
    const started = await this.call("initialize", said);
    if (!started.result) throw new Error(`Cursor did not start: ${JSON.stringify(started)}`);
  }

  async stop(): Promise<void> {
    await this.agent?.stop();
    this.agent = null;
  }

  /** Kills the process the way a crash would, then whatever it left running. */
  async kill(): Promise<void> {
    const agent = this.agent!;
    const pid = agent.pid!;
    console.log(`${this.name}: Cursor is process ${pid}, heading its group; running: ${shown(running(nap))}`);
    this.add({ kind: "kill", signal: "SIGKILL" });
    process.kill(pid, "SIGKILL");
    await agent.exited;
    const left = groupAlive(pid);
    console.log(`${this.name}: after the kill, ${left ? "something Cursor started was still running (killed now)" : "nothing was left in Cursor's process group"}`);
    if (left) process.kill(-pid, "SIGKILL");
    await agent.stop();
    this.agent = null;
    await sleep(500);
    endLeftovers(this.name, nap);
  }

  get pid(): number | undefined {
    return this.agent?.pid;
  }

  call(method: string, params: unknown): Promise<Reply> {
    return this.agent!.call(method, params);
  }

  notify(method: string, params: unknown): void {
    this.agent!.notify(method, params);
  }

  /** A new session in the scenario's folder. */
  async session(): Promise<string> {
    const made = await this.call("session/new", { cwd: this.cwd, mcpServers: [] });
    const id = made.result?.sessionId;
    if (typeof id !== "string") throw new Error(`Cursor made no session: ${JSON.stringify(made)}`);
    this.sessions.push(id);
    noteSession(this.name, id);
    this.onModel(made.result);
    return id;
  }

  /** Throws unless Cursor says it is on the recording's model: no turn runs on another. */
  onModel(state: unknown): void {
    const on = selectionIn(state).model;
    if (on !== model) throw new Error(`Cursor is on ${on}, not ${model}.`);
  }

  /** Sends a prompt, which is one model turn, and does not wait for the turn to end. */
  send(session: string, prompt: string | Block[]): Promise<Reply> {
    countTurn(this.name);
    return this.call("session/prompt", { sessionId: session, prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt });
  }

  /** Waits for a turn to end; one that does not is stopped. */
  async finish(session: string, turn: Promise<Reply>): Promise<Reply> {
    const late = (ms: number) => sleep(ms, null, { ref: false });
    const reply = await Promise.race([turn, late(turnLimitMs)]);
    if (reply) return reply;
    this.notify("session/cancel", { sessionId: session });
    await Promise.race([turn, late(30_000)]);
    throw new Error(`a turn did not end within ${turnLimitMs / 1000} seconds`);
  }

  turn(session: string, prompt: string | Block[]): Promise<Reply> {
    return this.finish(session, this.send(session, prompt));
  }

  /** Lets what Cursor sends just after a turn arrive (the session's name, for one). */
  settle(ms = 3000): Promise<void> {
    return sleep(ms);
  }

  /** Where the recording is now, for `seen`. */
  get mark(): number {
    return this.lines.length;
  }

  /** Whether a line for which `test` holds comes within `ms`, among those from `from` on. */
  seen(test: (line: Line) => boolean, ms: number, from = this.lines.length): Promise<boolean> {
    return new Promise((resolve) => {
      let next = from;
      const done = (found: boolean) => {
        clearTimeout(timer);
        this.watchers.delete(look);
        resolve(found);
      };
      const look = () => {
        for (; next < this.lines.length; next++) {
          if (test(this.lines[next]!)) return done(true);
        }
      };
      const timer = setTimeout(() => done(false), ms);
      this.watchers.add(look);
      look();
    });
  }

  /** As `seen`, for something the scenario cannot go on without. */
  async expect(what: string, test: (line: Line) => boolean, ms: number, from?: number): Promise<void> {
    if (!(await this.seen(test, ms, from))) throw new Error(`${what} did not come within ${ms / 1000} seconds`);
  }
}

/** A `session/update` of one kind, or null. */
function update(line: Line, kind: string): any {
  return line.kind === "notification" && line.method === "session/update" && line.params?.update?.sessionUpdate === kind ? line.params.update : null;
}

const replyText = (line: Line) => update(line, "agent_message_chunk") !== null;
const toolRunning = (line: Line) => update(line, "tool_call_update")?.status === "in_progress";
const asked = (method: string) => (line: Line) => line.kind === "request" && line.method === method;

/** A square of one colour, as a PNG. */
function square(size: number, colour: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const whole = Buffer.alloc(body.length + 8);
    whole.writeUInt32BE(data.length, 0);
    body.copy(whole, 4);
    whole.writeUInt32BE(crc32(body), body.length + 4);
    return whole;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // eight bits a channel, red green blue
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).fill(Buffer.from(colour))]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

// MARK: The scenarios

interface Scenario {
  /** What it shows; the recording's first line says it. */
  about: string;
  /** Files written into the scratch folder first. */
  files?: Record<string, string>;
  /** The model its turns run on, when the scenario selects another than Auto itself. */
  model?: string;
  run(r: Run): Promise<void>;
}

const count = "Count from 1 to 300, one number per line, with no other text. Do not use any tools.";
/** A command that takes long enough to be stopped, and that nothing else on this Mac runs. */
const nap = "sleep 47";
const sleeps = `Run the command \`${nap}\`, then reply with the single word done.`;

/** Waits until the command itself runs: Cursor starts it through a login shell, which takes a few seconds. */
async function napping(): Promise<void> {
  for (let tries = 0; tries < 120; tries++) {
    if (running(nap).some((process) => process.command === nap)) return;
    await sleep(250);
  }
  throw new Error(`${nap} did not start`);
}
// In agent mode the model said it had no question tool; in plan mode too, on Auto.
const language =
  "Before anything else, ask me one multiple-choice question with your AskQuestion tool: which language I prefer, with the options Python and Swift. Then reply with one short sentence that names my answer. Make no plan, run no commands and edit no files.";
/** Another small model, for the one scenario that does not run on Auto. */
const mini = "gpt-5-mini";
const planning =
  "Plan how to add a file notes.txt that holds the word hello, in two short steps. Present the plan with your create-plan tool. Do not ask me any questions.";

/** In the scratch folder, beside the session's own. */
const outside = join(root, "outside.txt");
const asking = `Do these two things, and if one is not allowed do not try it another way. 1. Run the command \`touch ${outside}\`. 2. Search the web once for: agent client protocol. Then say in one short sentence what happened with each.`;

/** Accepts a plan the way the bridge's Start would: with a place the plan is kept, so that Cursor saves none of its own. */
function acceptPlan(r: Run): Answer {
  return (params) => {
    const path = join(r.cwd, "plan.md");
    writeFileSync(path, String(params.plan ?? ""));
    return { result: { outcome: { outcome: "accepted", planUri: `file://${path}` } } };
  };
}

/** A subagent's start, and its state, in the parent's session. */
const subagentSpawned = (line: Line) => update(line, "subagent_spawned") !== null;
const subagentEnded = (line: Line) => update(line, "subagent_state_update") !== null;

const scenarios: Record<string, Scenario> = {
  subagent: {
    about: "A subagent (Task) the turn waits for, with the subagents capability said: its start, its own updates under its own session, its end.",
    files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" },
    async run(r) {
      r.answers["session/request_permission"] = permission("allow-once");
      await r.start({ subagents: true });
      const session = await r.session();
      await r.turn(
        session,
        "Use your Task tool exactly once: start one explore subagent that lists the files in this folder and says how many there are. Wait for its answer, then reply with that number in one short sentence. Do not list the files yourself.",
      );
      await r.settle(5000);
    },
  },

  "subagent-background": {
    about: "A subagent left running in the background when the turn ends, with the subagents capability said: whether the prompt waits for it, and what comes once it ends.",
    async run(r) {
      r.answers["session/request_permission"] = permission("allow-once");
      await r.start({ subagents: true });
      const session = await r.session();
      const mark = r.mark;
      await r.turn(
        session,
        "Use your Task tool exactly once, in the background (run_in_background true): start one subagent that runs the shell command `sleep 25` and then replies with the single word finished. Do not wait for it: as soon as it has started, reply with the single word started and end your turn.",
      );
      // What Cursor does once the subagent ends: a state update, maybe a turn of its own.
      await r.expect("the subagent's end", subagentEnded, 120_000, mark);
      await r.settle(15_000);
    },
  },

  "subagent-cancel": {
    about: "A turn stopped while its subagent runs a command, with the subagents capability said.",
    async run(r) {
      r.answers["session/request_permission"] = permission("allow-once");
      await r.start({ subagents: true });
      const session = await r.session();
      const mark = r.mark;
      const turn = r.send(session, `Use your Task tool exactly once: start one subagent that runs the shell command \`${nap}\` and then replies with the single word done. Wait for it, then reply with the single word done.`);
      await r.expect("the subagent", subagentSpawned, 120_000, mark);
      await napping();
      await sleep(1000);
      r.notify("session/cancel", { sessionId: session });
      await r.finish(session, turn);
      await r.settle(5000);
      endLeftovers(r.name, nap);
    },
  },

  "fork-copy": {
    about: "A session's store copied to a new session of Cursor's (its acp-sessions folder, with a meta.json), loaded and given a message: whether the copy goes on from the conversation, as a fork would.",
    async run(r) {
      await r.start();
      const session = await r.session();
      await r.turn(session, "Remember the word kumquat. Reply with OK only.");
      await r.settle(1000);
      await r.stop();
      const fork = randomUUID();
      const from = join(homedir(), ".cursor", "acp-sessions", session);
      const to = join(homedir(), ".cursor", "acp-sessions", fork);
      cpSync(from, to, { recursive: true });
      writeFileSync(join(to, "meta.json"), JSON.stringify({ schemaVersion: 1, cwd: r.cwd, title: "Fork" }));
      noteSession(r.name, fork);
      await r.start();
      const loaded = await r.call("session/load", { sessionId: fork, cwd: r.cwd, mcpServers: [] });
      if (!loaded.result) throw new Error(`Cursor did not load the copy: ${JSON.stringify(loaded).slice(0, 300)}`);
      r.onModel(loaded.result);
      await r.turn(fork, "What word did I ask you to remember? Answer with the word only.");
      await r.settle(1000);
    },
  },

  mention: {
    about: "A file mentioned in the app, as the bridge sends one: a resource_link beside the text (feature file_mentions).",
    files: { "notes.txt": "The word of the day is quince.\n" },
    async run(r) {
      r.answers["session/request_permission"] = permission("allow-once");
      await r.start();
      const session = await r.session();
      await r.turn(session, [
        { type: "text", text: "What is the word of the day in the file I mention? Answer with the word only." },
        { type: "resource_link", uri: `file://${join(r.cwd, "notes.txt")}`, name: "notes.txt" },
      ]);
      await r.settle();
    },
  },

  plain: {
    about: "A reply with no tools.",
    async run(r) {
      await r.start();
      const session = await r.session();
      await r.turn(session, "What is 17 times 3? Answer in one short sentence.");
      await r.settle();
    },
  },

  tools: {
    about: "A file read, an edit, a command, and a command that fails (exit code 1).",
    files: { "hello.txt": "hi\n" },
    async run(r) {
      r.answers["session/request_permission"] = permission("allow-once");
      await r.start();
      const session = await r.session();
      await r.turn(
        session,
        "Do these steps in order, and do not retry a step that fails. 1. Read hello.txt with your read tool. 2. Edit hello.txt so that it says hello instead of hi. 3. Run `wc -c hello.txt`. 4. Run `ls no-such-file.txt`. Finish with one short sentence that gives the exit code of the last command.",
      );
      await r.settle();
    },
  },

  cancel: {
    about: "Stop while the reply streams (session/cancel), what Cursor sends after it, and the session's next turn.",
    async run(r) {
      await r.start();
      const session = await r.session();
      const from = r.mark;
      const turn = r.send(session, count);
      await r.expect("the reply", replyText, 90_000, from);
      await sleep(500);
      r.notify("session/cancel", { sessionId: session });
      await r.finish(session, turn);
      await r.settle();
      await r.turn(session, "Reply with the single word done. Do not use any tools.");
      await r.settle();
    },
  },

  "cancel-command": {
    about: "Stop while a command runs.",
    async run(r) {
      r.answers["session/request_permission"] = permission("allow-once");
      await r.start();
      const session = await r.session();
      const from = r.mark;
      const turn = r.send(session, sleeps);
      await r.expect("the command", toolRunning, 90_000, from);
      await napping();
      await sleep(1000);
      console.log(`cancel-command: Cursor is process ${r.pid}, heading its group; running: ${shown(running(nap))}`);
      r.notify("session/cancel", { sessionId: session });
      await r.finish(session, turn);
      await r.settle();
      console.log(`cancel-command: three seconds after the stop, running: ${shown(running(nap))}`);
      await r.stop();
      endLeftovers(r.name, nap);
    },
  },

  "second-prompt": {
    about: "A second session/prompt while a turn runs: Cursor cancels the first.",
    async run(r) {
      await r.start();
      const session = await r.session();
      const from = r.mark;
      const first = r.send(session, count);
      await r.expect("the reply", replyText, 90_000, from);
      await sleep(500);
      const second = r.send(session, "Reply with the single word banana. Do not use any tools.");
      await r.finish(session, first);
      await r.finish(session, second);
      await r.settle();
    },
  },

  load: {
    about: "A session taken up by a new process (session/load): its conversation sent again, the model it comes back on, and one more turn. session/list too.",
    files: { "hello.txt": "hi\n" },
    async run(r) {
      r.answers["session/request_permission"] = permission("allow-once");
      await r.start();
      const session = await r.session();
      await r.turn(session, "Read hello.txt with your read tool, run `wc -c hello.txt`, then say in one short sentence what the file holds.");
      await r.settle();
      await r.stop();

      await r.start();
      await r.call("session/list", { cwd: r.cwd });
      const loaded = await r.call("session/load", { sessionId: session, cwd: r.cwd, mcpServers: [] });
      r.onModel(loaded.result);
      await r.settle();
      await r.turn(session, "Now say in one short sentence how many bytes the file had.");
      await r.settle();
    },
  },

  "load-unused": {
    about: "A session that never ran a turn cannot be loaded by a new process. No model turn.",
    async run(r) {
      await r.start();
      const session = await r.session();
      await r.settle(1000);
      await r.stop();

      await r.start();
      await r.call("session/load", { sessionId: session, cwd: r.cwd, mcpServers: [] });
      await r.call("session/list", { cwd: r.cwd });
    },
  },

  models: {
    about: "Cursor's models and their settings listed, and a model, a thinking level and the three modes set on a session. No model turn.",
    async run(r) {
      await r.start();
      const listed = await r.call("cursor/list_available_models", {});
      const session = await r.session();
      const other = await r.session();
      await r.settle(1500);

      for (const modeId of ["plan", "ask", "agent", "full"]) {
        await r.call("session/set_mode", { sessionId: session, modeId });
        await r.settle(300);
      }
      // The same through the session's options, which answers with all of them.
      for (const value of ["ask", "agent"]) {
        await r.call("session/set_config_option", { sessionId: session, configId: "mode", value });
        await r.settle(300);
      }

      // A model with a thinking level: the one Cursor was on before the run when it has
      // one, so that nothing new is written to Cursor's settings.
      const levelOf = (options: any[]) => options?.find((option) => option.category === "thought_level" && option.options?.length > 2);
      const withLevel = (listed.result?.models ?? []).filter((entry: any) => levelOf(entry.configOptions));
      const choice = withLevel.find((entry: any) => entry.value === r.was.model) ?? withLevel[0];
      if (!choice) throw new Error("Cursor lists no model with a thinking level");
      const set = await r.call("session/set_config_option", { sessionId: session, configId: "model", value: choice.value });
      const level = levelOf(set.result?.configOptions);
      if (!level) throw new Error(`Cursor is not on ${choice.value}: ${JSON.stringify(set).slice(0, 300)}`);
      const lower = level.options.find((option: any) => option.value !== level.currentValue).value;
      await r.call("session/set_config_option", { sessionId: session, configId: level.id, value: lower });
      await r.call("session/set_config_option", { sessionId: session, configId: level.id, value: level.currentValue });
      // The other session, asked for its options: the model is the process's, not a session's.
      await r.call("session/set_config_option", { sessionId: other, configId: "mode", value: "agent" });
      await r.call("session/set_config_option", { sessionId: session, configId: "model", value: "no-such-model" });
      await r.call("session/set_config_option", { sessionId: session, configId: level.id, value: "no-such-level" });
      await r.call("session/set_model", { sessionId: session, modelId: model });
      const back = await r.call("session/set_config_option", { sessionId: session, configId: "mode", value: "agent" });
      r.onModel(back.result);
    },
  },

  plan: {
    about: "Plan mode: the plan comes as a cursor/create_plan request; it is accepted and the session set to agent mode, as Start in the app does.",
    async run(r) {
      await r.start();
      const session = await r.session();
      const accept = acceptPlan(r);
      r.answers["cursor/create_plan"] = (params) => {
        setImmediate(() => void r.call("session/set_mode", { sessionId: session, modeId: "agent" }));
        return accept(params);
      };
      r.answers["session/request_permission"] = permission("allow-once");
      await r.call("session/set_mode", { sessionId: session, modeId: "plan" });
      await r.turn(session, planning);
      await r.settle();
      // Whether the plan was carried out in that turn; if not, a word starts it.
      if (!existsSync(join(r.cwd, "notes.txt"))) {
        await r.turn(session, "Go ahead with the plan.");
        await r.settle();
      }
    },
  },

  "plan-rejected": {
    about: "A plan sent back with a note (Keep planning), and the next one accepted with the session left in plan mode.",
    async run(r) {
      await r.start();
      const session = await r.session();
      const accept = acceptPlan(r);
      let plans = 0;
      r.answers["cursor/create_plan"] = (params) => {
        plans += 1;
        return plans === 1 ? { result: { outcome: { outcome: "rejected", reason: "Make it one step, not two." } } } : accept(params);
      };
      await r.call("session/set_mode", { sessionId: session, modeId: "plan" });
      await r.turn(session, planning);
      await r.settle();
    },
  },

  question: {
    about: "Asked in plan mode to put a question with its question tool. On Auto the model has no such tool (2026-10-12) and asks in its reply; with the tool this records cursor/ask_question, answered with an option.",
    async run(r) {
      r.answers["cursor/ask_question"] = pick("Swift");
      await r.start();
      const session = await r.session();
      await r.call("session/set_mode", { sessionId: session, modeId: "plan" });
      await r.turn(session, language);
      await r.settle();
    },
  },

  "question-skipped": {
    about: "A question answered in the user's own words, which Cursor takes only as the reason the question was skipped.",
    async run(r) {
      r.answers["cursor/ask_question"] = () => ({
        result: { outcome: { outcome: "skipped", reason: "The user chose none of the options and typed an answer instead: Rust." } },
      });
      await r.start();
      const session = await r.session();
      await r.call("session/set_mode", { sessionId: session, modeId: "plan" });
      await r.turn(session, language);
      await r.settle();
    },
  },

  "question-mini": {
    about: "The same question on another small model, GPT-5 Mini, which has no question tool either (2026-10-12). It thinks in many small pieces, under headings.",
    model: mini,
    async run(r) {
      r.answers["cursor/ask_question"] = pick("Swift");
      await r.start();
      const session = await r.session();
      const set = await r.call("session/set_config_option", { sessionId: session, configId: "model", value: mini });
      if (selectionIn(set.result).model !== mini) throw new Error(`Cursor is not on ${mini}: ${JSON.stringify(set).slice(0, 300)}`);
      await r.call("session/set_mode", { sessionId: session, modeId: "plan" });
      try {
        await r.turn(session, language);
        await r.settle();
      } finally {
        await r.call("session/set_config_option", { sessionId: session, configId: "model", value: model });
      }
    },
  },

  todos: {
    about: "A to-do list kept through a turn (cursor/update_todos).",
    async run(r) {
      r.answers["session/request_permission"] = permission("allow-once");
      await r.start();
      const session = await r.session();
      await r.turn(
        session,
        "First write a to-do list with your to-do tool: make a.txt, make b.txt, make c.txt. Then make the three files, each holding its own letter, and mark each item done as you go. Finish with one short sentence.",
      );
      await r.settle();
    },
  },

  permission: {
    about: "A web search, which Cursor asks about first (session/request_permission), refused; and a file made outside the session's folder, which it does not ask about.",
    async run(r) {
      await r.start();
      const session = await r.session();
      await r.turn(session, asking);
      await r.settle();
    },
  },

  "permission-allowed": {
    about: "The same, allowed once.",
    async run(r) {
      r.answers["session/request_permission"] = permission("allow-once");
      await r.start();
      const session = await r.session();
      await r.turn(session, asking);
      await r.settle();
      rmSync(outside, { force: true });
    },
  },

  "permission-stopped": {
    about: "Stop while Cursor waits for the answer to a permission request: the request is answered cancelled, then session/cancel is sent, as the bridge's Stop does.",
    async run(r) {
      const open = Promise.withResolvers<Reply>();
      r.answers["session/request_permission"] = () => open.promise;
      await r.start();
      const session = await r.session();
      const from = r.mark;
      const turn = r.send(session, "Search the web once for: agent client protocol. If you are not allowed to, say so in one short sentence.");
      await r.expect("the permission request", asked("session/request_permission"), 90_000, from);
      await sleep(1000);
      open.resolve({ result: { outcome: { outcome: "cancelled" } } });
      await sleep(0);
      r.notify("session/cancel", { sessionId: session });
      await r.finish(session, turn);
      await r.settle();
    },
  },

  image: {
    about: "A prompt with an image.",
    async run(r) {
      await r.start();
      const session = await r.session();
      await r.turn(session, [
        { type: "text", text: "What colour is this square? Answer with one word." },
        { type: "image", mimeType: "image/png", data: square(48, [220, 30, 30]).toString("base64") },
      ]);
      await r.settle();
    },
  },

  killed: {
    about: "The process killed while a command runs, and what the next process sends when it loads the session. One model turn.",
    async run(r) {
      r.answers["session/request_permission"] = permission("allow-once");
      await r.start();
      const session = await r.session();
      const from = r.mark;
      const turn = r.send(session, sleeps);
      await r.expect("the command", toolRunning, 90_000, from);
      await napping();
      await sleep(1000);
      await r.kill();
      await turn;

      await r.start();
      await r.call("session/load", { sessionId: session, cwd: r.cwd, mcpServers: [] });
      await r.settle();
    },
  },

  stopped: {
    about: "The process stopped the way the bridge stops it (its input closed, then SIGTERM) while a command runs.",
    async run(r) {
      r.answers["session/request_permission"] = permission("allow-once");
      await r.start();
      const session = await r.session();
      const from = r.mark;
      const turn = r.send(session, sleeps);
      await r.expect("the command", toolRunning, 90_000, from);
      await napping();
      await sleep(1000);
      console.log(`stopped: Cursor is process ${r.pid}, heading its group; running: ${shown(running(nap))}`);
      await r.stop();
      await turn;
      await sleep(500);
      endLeftovers(r.name, nap);
    },
  },

  note: {
    about: "A note beside a thread's first message (an embedded resource), the way the bridge tells Cursor of the portals command.",
    async run(r) {
      await r.start();
      const session = await r.session();
      await r.turn(session, [
        { type: "text", text: "What is the word of the day? Answer with that one word." },
        {
          type: "resource",
          resource: { uri: "portals://guide", mimeType: "text/markdown", text: "A note from Portals, the app this conversation is shown in.\n\nThe word of the day is plum." },
        },
      ]);
      await r.settle();
    },
  },

  "switch-mode": {
    about: "The model changes the session's mode with its own tool.",
    async run(r) {
      await r.start();
      const session = await r.session();
      await r.turn(session, "Switch this session to plan mode with your switch-mode tool, then reply with the single word done. Do nothing else.");
      await r.settle();
      // The session's options, to see the mode Cursor has it in now.
      await r.call("session/set_config_option", { sessionId: session, configId: "model", value: model });
    },
  },
};

// MARK: Cleaning

const home = homedir();
const user = userInfo().username;
const host = hostname().split(".")[0]!;
const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * What a recording must not hold once it is cleaned. A word like "ask-question" is taken
 * for a key too (the check a commit of recordings has to pass does the same), so the
 * prompts are worded around such words.
 */
const personal = new RegExp(`/Users/|${escaped(user)}|${escaped(host)}|${email.source}|eyJ[A-Za-z0-9_-]{10,}|Bearer |sk-[A-Za-z0-9]{8,}`, "i");

/**
 * Text comes in pieces, and a piece can end in the middle of a path or a name, which
 * then would not be replaced. Such a one is moved whole into the piece it begins in.
 */
function mend(lines: Line[], needles: string[]): void {
  const piece = (line: Line) => {
    const said = line.kind === "notification" && line.method === "session/update" ? line.params?.update : null;
    return typeof said?.content?.text === "string" && /_chunk$/.test(said.sessionUpdate) ? said : null;
  };
  for (let from = 0; from < lines.length; from++) {
    const first = piece(lines[from]!);
    if (!first) continue;
    // The pieces that follow one another, of one kind.
    const pieces: { text: string }[] = [first.content];
    while (from + 1 < lines.length && piece(lines[from + 1]!)?.sessionUpdate === first.sessionUpdate) pieces.push(piece(lines[++from]!).content);
    const whole = pieces.map((each) => each.text).join("").toLowerCase();
    for (const needle of needles.map((each) => each.toLowerCase())) {
      for (let at = whole.indexOf(needle); at >= 0; at = whole.indexOf(needle, at + needle.length)) {
        let n = 0;
        let start = 0;
        while (start + pieces[n]!.text.length <= at) start += pieces[n++]!.text.length;
        let missing = at + needle.length - (start + pieces[n]!.text.length);
        for (let next = n + 1; missing > 0; next++) {
          const moved = pieces[next]!.text.slice(0, missing);
          pieces[n]!.text += moved;
          pieces[next]!.text = pieces[next]!.text.slice(moved.length);
          missing -= moved.length;
        }
      }
    }
  }
}

function cleaner(run: Run): (value: unknown, key?: string) => unknown {
  const bare = (path: string) => path.replace(/^\/private/, "");
  const swaps: [string, string][] = [
    [run.cwd, "/tmp/portals-cwd"],
    [bare(run.cwd), "/tmp/portals-cwd"],
    [root, "/tmp/portals-record"],
    [bare(root), "/tmp/portals-record"],
    [home, "/home/dev"],
    ...run.sessions.map((id, n): [string, string] => [id, `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`]),
  ];
  const names = new RegExp(`${escaped(user)}|${escaped(host)}`, "gi");
  mend(run.lines, [...swaps.map(([from]) => from), user, host]);
  const text = (value: string) => {
    for (const [from, to] of swaps) value = value.split(from).join(to);
    return value.replace(email, "redacted").replace(names, "dev");
  };
  const clean = (value: unknown, key?: string): unknown => {
    // The user's own commands and skills, by name and description: only Cursor's own stays.
    if (key === "availableCommands" && Array.isArray(value)) {
      return [
        ...value.filter((command) => command?.name === "copy-request-id"),
        { name: "example-skill", description: "Stands for the user's own commands and skills, which a recording leaves out." },
      ];
    }
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map((item) => clean(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [text(k), clean(v, k)]));
    return value;
  };
  return clean;
}

// MARK: Running

async function record(name: string, scenario: Scenario, was: Selection, version: string | null): Promise<void> {
  const cwd = join(root, name);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  for (const [file, text] of Object.entries(scenario.files ?? {})) writeFileSync(join(cwd, file), text);

  const run = new Run(name, cwd, was);
  run.add({ kind: "meta", scenario: name, about: scenario.about, cursor: version, model: scenario.model ?? model });
  const before = turns;
  let failure: Error | null = null;
  try {
    await scenario.run(run);
  } catch (error) {
    failure = error as Error;
  } finally {
    await run.stop();
  }
  const left = readdirSync(cwd).sort();
  rmSync(cwd, { recursive: true, force: true });

  const clean = cleaner(run);
  const text = run.lines.map((line) => JSON.stringify(clean(line))).join("\n") + "\n";
  const found = personal.exec(text);
  // A scenario that failed is kept beside the scratch folders, to see how far it got.
  const folder = failure || found ? join(root, "failed") : fixtures;
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${name}.jsonl`);
  writeFileSync(path, text);
  const requests = run.lines.filter((line) => line.kind === "request").length;
  console.log(`${name}: ${run.lines.length} lines, ${turns - before} turn(s), ${requests} request(s), files left: ${left.join(" ") || "none"} -> ${path}`);
  if (found) throw new Error(`${name}: the cleaned recording still holds "${found[0]}"`);
  if (failure) throw new Error(`${name}: ${failure.message}`);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    ending = true;
    void (async () => {
      await current?.stop();
      await putBack().catch((error: Error) => console.error(error.message));
      process.exit(1);
    })();
  });
}

const wanted = process.argv.slice(2);
if (wanted[0] === "--put-back") {
  await putBack();
} else if (wanted[0] === "--check") {
  const { agent, on } = await control();
  await agent.stop();
  console.log(`Cursor is on ${describe(on)}`);
} else {
  const names = wanted.length ? wanted : Object.keys(scenarios);
  for (const name of names) {
    if (!scenarios[name]) throw new Error(`no scenario called ${name}`);
  }
  const version = await programVersion(cursorPath, process.env);
  const was = await selectModel();
  try {
    for (const name of names) await record(name, scenarios[name]!, was, version);
  } finally {
    await putBack();
    // Anything else here was written beside a scenario's folder by a model.
    console.log(`${turns} model turn(s). In ${root}: ${readdirSync(root).join(" ")}`);
  }
}
