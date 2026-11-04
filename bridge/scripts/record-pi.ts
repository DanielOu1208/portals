import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { JsonChild, type ChildExit } from "../src/providers/child.ts";
import { programVersion } from "../src/providers/program.ts";

// Records what Pi really sends in its RPC mode, for the golden tests in test/pi-*.test.ts.
// Each scenario starts `pi --mode rpc` in a scratch folder of its own under /tmp,
// with harmless prompts on a small OpenAI model, and writes every record both ways, in
// order, to test/fixtures/pi/<scenario>.jsonl, and Pi's session file as it was at the end
// to <scenario>.session.jsonl. Paths and personal fields are replaced before anything is
// written, and nothing is written while a search of the result still finds one.
//
//   node scripts/record-pi.ts [scenario…]          (all of them when none is named)
//   node scripts/record-pi.ts --again [scenario…]  (no Pi: cleans kept records again)
//
// It uses the user's ChatGPT sign-in in Pi and its quota; keep runs rare. A turn that ran
// on another provider or model stops the run. Unless a scenario says otherwise Pi runs
// bare (none of the user's extensions, skills, prompt templates or context files) and keeps its
// sessions in the scratch folder, so the user's own list of sessions stays as it was.
//
// From the environment:
//   PI_RECORD_PI         the program, when it is not `pi` on PATH
//   PI_RECORD_SCRATCH    the scratch folder, when not /tmp/portals-pi-record
//   PI_RECORD_RAW        a folder that keeps each scenario's records as they came
//                        (not cleaned: never commit it), which `--again` reads
//   PI_RECORD_TURNS      a file that gets one line per model turn
//   PI_RECORD_MAX_TURNS  the most model turns one run may take (25)

const piPath = process.env.PI_RECORD_PI ?? "pi";
const provider = "openai";
const model = "gpt-6-luna";
const scratchSetting = process.env.PI_RECORD_SCRATCH ?? join(realpathSync("/tmp"), "portals-pi-record");
const rawFolder = process.env.PI_RECORD_RAW;
const fixtures = resolve(import.meta.dirname, "../test/fixtures/pi");

/** Pi with nothing of the user's loaded. Extensions and skills a scenario names itself still load. */
const bare = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"];

type Rec = Record<string, any>;

/** One line of a recording. `at` is milliseconds since the scenario began. */
interface Line {
  kind: "meta" | "start" | "send" | "receive" | "exit";
  at: number;
  [field: string]: unknown;
}

interface Scenario {
  about: string;
  /** Files written into the scratch folder first. */
  files?: Record<string, string>;
  /** Pi's thinking level; "off" when absent. */
  thinking?: string;
  /** Pi as the user's settings make it, with their extensions, skills and context files. */
  own?: true;
  /** The session is kept where Pi keeps a thread's, under ~/.pi/agent/sessions, and removed afterwards. */
  ownSessions?: true;
  /** More arguments for `pi`; a relative path is taken from the scratch folder. */
  args?: string[];
  run(pi: Recording): Promise<void>;
}

// MARK: Turns

let turns = 0;
const maxTurns = Number(process.env.PI_RECORD_MAX_TURNS ?? 25);

/** Counts a message the model will answer, before it is sent. */
function countTurn(scenario: string): void {
  if (turns >= maxTurns) throw new Error(`the ${maxTurns} model turns this run may take are used up`);
  turns += 1;
  if (process.env.PI_RECORD_TURNS) appendFileSync(process.env.PI_RECORD_TURNS, `${new Date().toISOString()} record ${scenario}\n`);
}

// MARK: One scenario's Pi

const event = (type: string) => (record: Rec) => record.type === type;
const update = (type: string) => (record: Rec) => record.type === "message_update" && record.assistantMessageEvent?.type === type;
const dialog = (method: string) => (record: Rec) => record.type === "extension_ui_request" && record.method === method;
const compactionOrSettled = (record: Rec) => record.type === "compaction_start" || record.type === "agent_settled";

class Recording {
  readonly lines: Line[] = [];
  readonly name: string;
  readonly cwd: string;
  readonly sessionId: string;
  /** Where Pi says it keeps the session; null until it has said. */
  sessionFile: string | null = null;
  /** Model turns this scenario took. */
  turns = 0;
  private readonly scenario: Scenario;
  private readonly sessionFolder: string;
  private readonly began = Date.now();
  private child: JsonChild | null = null;
  private ended = Promise.withResolvers<ChildExit>();
  private running = false;
  /** What Pi printed, in order; `next` reads on from `cursor`. */
  private readonly received: Rec[] = [];
  private cursor = 0;
  private readonly answers = new Map<string, (response: Rec) => void>();
  private readonly waiting = new Set<() => void>();
  private failure: Error | null = null;
  private nextId = 1;

  constructor(name: string, scenario: Scenario, cwd: string, sessionFolder: string, sessionId: string) {
    this.name = name;
    this.scenario = scenario;
    this.cwd = cwd;
    this.sessionFolder = sessionFolder;
    this.sessionId = sessionId;
  }

  /** Starts Pi on the scenario's session, and asks its state as the bridge does first. */
  async start(extra: string[] = []): Promise<Rec> {
    const args = [
      "--mode",
      "rpc",
      "--offline",
      "--provider",
      provider,
      "--model",
      model,
      "--thinking",
      this.scenario.thinking ?? "off",
      "--session-id",
      this.sessionId,
      ...(this.scenario.ownSessions ? [] : ["--session-dir", this.sessionFolder]),
      ...(this.scenario.own ? [] : bare),
      ...(this.scenario.args ?? []),
      ...extra,
    ];
    this.add({ kind: "start", args });
    this.ended = Promise.withResolvers<ChildExit>();
    this.running = true;
    this.child = new JsonChild({
      name: "Pi",
      command: piPath,
      args,
      env: process.env,
      cwd: this.cwd,
      listener: {
        message: (value) => this.receive(value as Rec),
        notJSON: (line) => this.add({ kind: "receive", text: line }),
        exited: (exit) => {
          this.running = false;
          this.add({ kind: "exit", code: exit.code, signal: exit.signal, asked: exit.asked, error: exit.error, last_words: exit.lastWords });
          this.ended.resolve(exit);
          this.wake();
        },
      },
    });
    const state = await this.call("get_state");
    const runs = state.data?.model;
    if (!state.success || runs?.provider !== provider || runs?.id !== model) {
      throw new Error(`Pi did not start on ${provider}/${model}: ${JSON.stringify(state.error ?? { provider: runs?.provider, model: runs?.id })}`);
    }
    this.sessionFile = state.data.sessionFile ?? null;
    return state.data;
  }

  /** Sends a command and gives its answer, whether Pi took it or refused it. */
  call(type: string, fields: Rec = {}, timeoutMs = 60_000): Promise<Rec> {
    const id = `r${this.nextId++}`;
    const answer = Promise.withResolvers<Rec>();
    this.answers.set(id, answer.resolve);
    this.send({ id, type, ...fields });
    return this.within(answer.promise, timeoutMs, `Pi did not answer ${type}`);
  }

  /** Writes a record that gets no answer of its own (a dialog's). */
  send(record: Rec): void {
    this.add({ kind: "send", record });
    if (!this.child?.send(record)) throw new Error(`Pi is not there to take ${record.type}`);
  }

  /** Sends a message the model will answer: one model turn. Resolves when Pi has taken it. */
  async prompt(message: string, fields: Rec = {}): Promise<Rec> {
    this.turn();
    const response = await this.call("prompt", { message, ...fields }, 120_000);
    if (!response.success) throw new Error(`Pi refused the prompt: ${response.error}`);
    return response;
  }

  /** A model turn that is not begun with `prompt`: a queued message, a compaction. */
  turn(): void {
    countTurn(this.name);
    this.turns += 1;
  }

  /** The next record Pi prints, from where the last `next` stopped, that passes `test`. */
  async next(test: (record: Rec) => boolean, timeoutMs = 180_000): Promise<Rec> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.failure) throw this.failure;
      while (this.cursor < this.received.length) {
        const record = this.received[this.cursor++];
        if (test(record)) return record;
      }
      if (!this.running) throw new Error("Pi ended before the record that was waited for");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("the record that was waited for did not come");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, left);
        const waiting = this.waiting;
        function done(): void {
          clearTimeout(timer);
          waiting.delete(done);
          resolve();
        }
        waiting.add(done);
      });
    }
  }

  /** Pi has no more work of its own for the message: the turn is over. */
  settled(): Promise<Rec> {
    return this.next(event("agent_settled"));
  }

  /** Ends the process the way the bridge cools a thread: end of input and SIGTERM together. */
  async stop(): Promise<ChildExit | null> {
    if (!this.child) return null;
    await this.child.stop();
    return this.ended.promise;
  }

  /** Kills the process and what it started, with no warning. */
  kill(): Promise<ChildExit> {
    this.killNow();
    return this.ended.promise;
  }

  killNow(): void {
    const pid = this.child?.pid;
    if (pid === undefined || !this.running) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }

  private add(line: { kind: Line["kind"]; [field: string]: unknown }): void {
    const { kind, ...rest } = line;
    this.lines.push({ kind, at: Date.now() - this.began, ...rest });
  }

  private receive(record: Rec): void {
    this.add({ kind: "receive", record });
    this.received.push(record);
    if (record.type === "response" && typeof record.id === "string") {
      this.answers.get(record.id)?.(record);
      this.answers.delete(record.id);
    }
    // Every reply must come from the model the run was meant for.
    const message = record.type === "message_end" ? record.message : null;
    if (message?.role === "assistant" && (message.provider !== provider || message.model !== model)) {
      this.failure = new Error(`a reply came from ${message.provider}/${message.model}, not ${provider}/${model}`);
    }
    this.wake();
  }

  private wake(): void {
    for (const done of [...this.waiting]) done();
  }

  private async within<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} in ${timeoutMs / 1000} s`)), timeoutMs);
    });
    const gone = this.ended.promise.then((exit) => {
      throw new Error(`${what}: ${exit.reason}`);
    });
    try {
      return await Promise.race([promise, late, gone]);
    } finally {
      clearTimeout(timer);
    }
  }
}

// MARK: Scenarios

/** A dialog of each kind behind a command, and a question before every command the model runs. */
const askExtension = `export default function (pi) {
  pi.registerCommand("ask-confirm", {
    description: "Ask a yes or no question",
    handler: async (_args, ctx) => {
      const yes = await ctx.ui.confirm("Send the report?", "It goes to everyone on the list.");
      ctx.ui.notify(yes ? "Confirmed" : "Not confirmed", "info");
    },
  });
  pi.registerCommand("ask-select", {
    description: "Ask to pick one of three",
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select("Which fruit?", ["Apple", "Banana", "Cherry"]);
      ctx.ui.notify(choice ? "Picked " + choice : "Nothing picked", "info");
    },
  });
  pi.registerCommand("ask-input", {
    description: "Ask for a line of text",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.input("Your name", "type a name");
      ctx.ui.notify(value ? "Name: " + value : "No name", "info");
    },
  });
  pi.registerCommand("ask-editor", {
    description: "Ask to edit a note",
    handler: async (_args, ctx) => {
      const text = await ctx.ui.editor("Edit the note", "Line 1\\nLine 2");
      ctx.ui.notify(text ? "Note has " + text.split("\\n").length + " lines" : "Note left alone", "info");
    },
  });
  pi.registerCommand("ask-timed", {
    description: "Ask a question that answers itself after a second",
    handler: async (_args, ctx) => {
      const yes = await ctx.ui.confirm("Still there?", "This answers itself in one second.", { timeout: 1000 });
      ctx.ui.notify(yes ? "Still there" : "No answer in time", "warning");
    },
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const yes = await ctx.ui.confirm("Run this command?", String(event.input.command));
    return yes ? undefined : { block: true, reason: "Blocked by the user" };
  });
}
`;

const greetSkill = `---
name: greet
description: Greets someone by name. Use when asked to greet a person.
---

# Greet

Reply with exactly one line, "Hello, NAME!", with the name from the request in place of NAME. Use no tools.
`;

const shoutTemplate = `---
description: Says a word in capital letters
argument-hint: "<word>"
---
Reply with only this word in capital letters and nothing else: $1
`;

/** The extension, the skill and the template above, as files in the scratch folder. */
const kit = { "kit/ask.ts": askExtension, "kit/greet/SKILL.md": greetSkill, "kit/shout.md": shoutTemplate };
const kitArgs = ["-e", "kit/ask.ts", "--skill", "kit/greet", "--prompt-template", "kit/shout.md"];

/** Answers a dialog the way a card's answer would. */
function answer(pi: Recording, request: Rec, fields: Rec): void {
  pi.send({ type: "extension_ui_response", id: request.id, ...fields });
}

/** Runs one of the extension's commands, which opens a dialog, and answers it. No model is called. */
async function ask(pi: Recording, command: string, method: string, fields: Rec): Promise<void> {
  const handled = runCommand(pi, command);
  answer(pi, await pi.next(dialog(method)), fields);
  await pi.next(dialog("notify"));
  await handled;
}

/** Sends one of the extension's commands. Pi answers only when the command has run to its end. */
function runCommand(pi: Recording, command: string): Promise<Rec> {
  const handled = pi.call("prompt", { message: command });
  // Awaited later; until then its failure must not count as one nobody handles.
  handled.catch(() => undefined);
  return handled;
}

/** Stop as Esc is in Pi's terminal: what is queued is taken back, then the run is aborted. */
async function stop(pi: Recording): Promise<void> {
  await pi.call("clear_queue");
  await pi.call("abort");
}

const scenarios: Record<string, Scenario> = {
  // No model turn: what Pi answers about itself, and what a change of model or level sends.
  models: {
    about: "the commands that ask about Pi or change a setting, with no message sent",
    files: kit,
    args: kitArgs,
    async run(pi) {
      await pi.start();
      await pi.call("get_available_models");
      await pi.call("get_available_thinking_levels");
      await pi.call("get_commands");
      await pi.call("get_session_stats");
      for (const level of ["high", "max", "minimal"]) {
        await pi.call("set_thinking_level", { level });
        await pi.call("get_state");
      }
      // A model that does not reason, one that is not there, and back.
      await pi.call("set_model", { provider, modelId: "gpt-4.1-nano" });
      await pi.call("get_available_thinking_levels");
      await pi.call("get_state");
      await pi.call("set_model", { provider, modelId: "no-such-model" });
      await pi.call("set_model", { provider, modelId: model });
      await pi.call("get_state");
      await pi.call("set_thinking_level", { level: "off" });
      await pi.call("set_session_name", { name: "Recorded for the bridge" });
      await pi.call("set_session_name", { name: "  " });
      await pi.call("get_state");
      await pi.call("get_messages");
      await pi.call("get_entries");
      // Refused before any model is asked: there is nothing to summarise.
      await pi.call("compact");
      await pi.call("clear_queue");
      await pi.call("abort");
      await pi.call("no_such_command");
    },
  },
  plain: {
    about: "a short answer with no tools",
    async run(pi) {
      await pi.start();
      await pi.prompt("In two short sentences, say what a JSON line is. Do not use any tools.");
      await pi.settled();
      await pi.call("get_session_stats");
    },
  },
  tools: {
    about: "a file read, a command, an edit, a command that fails and a file written",
    files: { "hello.txt": "hi\n" },
    args: ["--tools", "read,bash,edit,write"],
    async run(pi) {
      await pi.start();
      await pi.prompt(
        "Do these five steps in order, one tool call at a time, and do not retry a step that fails. " +
          "1. Read hello.txt with the read tool. 2. Run `wc -c hello.txt` with bash. 3. In hello.txt change hi to hello with the edit tool. " +
          "4. Run `ls no-such-file.txt` with bash. 5. Write the single word done to done.txt with the write tool. Then reply with one short sentence.",
      );
      await pi.settled();
      await pi.call("get_session_stats");
    },
  },
  stop: {
    about: "a reply stopped while it streams, with a message still queued",
    async run(pi) {
      await pi.start();
      await pi.prompt("Count from 1 to 400, one number per line, with no other text. Do not use any tools.");
      await pi.next(update("text_delta"));
      // Queued, taken back by the stop, and so never answered: no model turn.
      await pi.call("follow_up", { message: "Then say the word banana." });
      await stop(pi);
      await pi.settled();
      await pi.call("get_state");
    },
  },
  "stop-tool": {
    about: "a turn stopped while a command runs",
    args: ["--tools", "read,bash,edit,write"],
    async run(pi) {
      await pi.start();
      await pi.prompt("Run `sleep 30` with bash. Then reply with the single word done.");
      await pi.next(event("tool_execution_start"));
      await stop(pi);
      await pi.settled();
      await pi.call("get_state");
    },
  },
  steer: {
    about: "a message sent while Pi works, and one for when it has finished",
    args: ["--tools", "read,bash,edit,write"],
    async run(pi) {
      await pi.start();
      await pi.prompt("Run `sleep 4` with bash. Then reply with the single word done.");
      await pi.next(event("tool_execution_start"));
      pi.turn();
      await pi.call("prompt", { message: "Also add the word banana to your reply.", streamingBehavior: "steer" });
      pi.turn();
      await pi.call("follow_up", { message: "Now reply with only the word cherry." });
      await pi.settled();
      await pi.call("get_session_stats");
    },
  },
  resume: {
    about: "a thread whose process was stopped and started again on the same session",
    ownSessions: true,
    async run(pi) {
      await pi.start();
      await pi.prompt("Remember the word kiwi. Reply with only: ok");
      await pi.settled();
      await pi.stop();
      await pi.start();
      await pi.call("get_messages");
      await pi.call("get_entries");
      await pi.call("get_session_stats");
      await pi.prompt("Which word did I ask you to remember? Reply with only that word.");
      await pi.settled();
    },
  },
  image: {
    about: "a message with an image",
    async run(pi) {
      await pi.start();
      const images = [{ type: "image", data: png(32, [220, 30, 30]).toString("base64"), mimeType: "image/png" }];
      await pi.prompt("What colour is this square? Reply with one word.", { images });
      await pi.settled();
    },
  },
  compact: {
    about: "a conversation compacted by hand, and the turn after it",
    // The project's own settings, trusted for this process: keep only the last exchange,
    // so that two short turns are already enough to summarise.
    files: { ".pi/settings.json": JSON.stringify({ compaction: { keepRecentTokens: 10 } }) + "\n" },
    args: ["--approve"],
    async run(pi) {
      await pi.start();
      await pi.prompt("Reply with a four-line poem about the sea. Do not use any tools.");
      await pi.settled();
      await pi.prompt("Thank you. Now reply with the single word hello and nothing else at all, please.");
      await pi.settled();
      await pi.call("get_session_stats");
      pi.turn();
      const compacted = await pi.call("compact", {}, 180_000);
      if (!compacted.success) throw new Error(`Pi did not compact: ${compacted.error}`);
      await pi.call("get_session_stats");
      await pi.call("compact");
      await pi.prompt("Reply with the single word bye.");
      await pi.settled();
      await pi.call("get_session_stats");
    },
  },
  dialog: {
    about: "an extension's dialogs answered, dismissed and left to time out, and a command it asks about first",
    files: kit,
    args: [...kitArgs, "--tools", "read,bash,edit,write"],
    async run(pi) {
      await pi.start();
      await ask(pi, "/ask-confirm", "confirm", { confirmed: true });
      await ask(pi, "/ask-confirm", "confirm", { cancelled: true });
      await ask(pi, "/ask-select", "select", { value: "Banana" });
      await ask(pi, "/ask-input", "input", { value: "Ada" });
      await ask(pi, "/ask-editor", "editor", { value: "Line 1\nLine 2\nLine 3" });
      // Left alone: Pi settles it after its second, and an answer that comes later is too late.
      const handled = runCommand(pi, "/ask-timed");
      const timed = await pi.next(dialog("confirm"));
      await pi.next(dialog("notify"));
      await handled;
      answer(pi, timed, { confirmed: true });
      // The model's two commands, asked for in one message so that they run at once: the first allowed, the second not.
      await pi.prompt("Run `echo first` and `echo second` with bash, as two tool calls in the same message. Then say in one short sentence which of the two ran.");
      for (let asked = 0; ; asked += 1) {
        const record = await pi.next((candidate) => dialog("confirm")(candidate) || candidate.type === "agent_settled");
        if (record.type === "agent_settled") break;
        answer(pi, record, { confirmed: asked === 0 });
      }
    },
  },
  killed: {
    about: "a process killed while a reply streams, and what the session holds afterwards",
    async run(pi) {
      await pi.start();
      await pi.prompt("Count from 1 to 400, one number per line, with no other text. Do not use any tools.");
      await pi.next(update("text_delta"));
      await pi.kill();
      await pi.start();
      await pi.call("get_messages");
      await pi.call("get_entries");
    },
  },
  // At "low" this model answers such a question with no thinking at all, and Pi then sends no thinking records.
  thinking: {
    about: "a reply the model thinks about first",
    thinking: "high",
    async run(pi) {
      await pi.start();
      await pi.prompt("Without using any tools: how many integers from 1 to 200 are divisible by neither 3 nor 7? Check your answer a second way, then reply with the number and one short sentence saying how you got it.");
      await pi.settled();
    },
  },
  // Not a model turn: the key is refused before any model runs. It is counted as one all the same.
  error: {
    about: "a turn the provider refuses",
    args: ["--api-key", "not-a-real-key"],
    async run(pi) {
      await pi.start();
      await pi.prompt("Reply with the single word hello.");
      await pi.settled();
      await pi.call("get_state");
    },
  },
  commands: {
    about: "a skill and a prompt template run as slash commands",
    files: kit,
    args: kitArgs,
    async run(pi) {
      await pi.start();
      await pi.call("get_commands");
      await pi.prompt("/skill:greet Ada");
      await pi.settled();
      await pi.prompt("/shout kiwi");
      await pi.settled();
    },
  },
  // His settings turn the codemode tool on, so this is also where a script of tool calls shows.
  own: {
    about: "Pi as its user's settings make it, with their extensions and context files, running a script of tool calls",
    own: true,
    files: { "one.txt": "first file\n", "two.txt": "second file\n" },
    async run(pi) {
      await pi.start();
      await pi.prompt("With one codemode script, read one.txt and two.txt in parallel and return the number of characters in each. Then reply with one short sentence.");
      await pi.settled();
      await pi.call("get_session_stats");
    },
  },
  "compact-auto": {
    about: "a conversation Pi compacts by itself, when a reply leaves it over the limit",
    // The project's own settings, trusted for this process: nearly the whole context
    // window is to stay free, so the first reply already crosses the limit.
    files: { ".pi/settings.json": JSON.stringify({ compaction: { reserveTokens: 271_000, keepRecentTokens: 10 } }) + "\n" },
    args: ["--approve"],
    async run(pi) {
      await pi.start();
      await pi.prompt("Reply with a four-line poem about the sea. Do not use any tools.");
      // The summary is a model turn of its own. One is expected; a second would be a loop.
      let summaries = 0;
      const summary = (record: Rec) => {
        if (record.type !== "compaction_start") return;
        summaries += 1;
        if (summaries > 1) {
          pi.killNow();
          throw new Error("Pi began a second compaction");
        }
        pi.turn();
      };
      for (let record = await pi.next(compactionOrSettled); record.type !== "agent_settled"; record = await pi.next(compactionOrSettled)) summary(record);
      // Should Pi compact only once the run has settled, that is waited for a moment.
      if (summaries === 0) {
        const late = await pi.next(event("compaction_start"), 5000).catch(() => null);
        if (late) {
          summary(late);
          await pi.next(event("compaction_end"));
        }
      }
      await pi.call("get_session_stats");
    },
  },
};

/** A square of one colour as a PNG file. */
function png(size: number, colour: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // eight bits a channel, red green blue
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from(colour))]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

// MARK: Cleaning

/** What a scenario's run left, before cleaning. */
interface Raw {
  name: string;
  /** The scratch folder of the run, the scenario's own folder in it, and where its sessions went. */
  scratch: string;
  cwd: string;
  sessionFolder: string;
  meta: Rec;
  lines: Line[];
  /** The lines of Pi's session file; null when it never wrote one. */
  session: string[] | null;
}

const home = homedir();
const user = userInfo().username;
const hosts = [...new Set([hostname(), hostname().split(".")[0]])];

/** Pi's name for a folder in its sessions folder, without the dashes around it. */
const sessionsName = (path: string) => path.replace(/^\//, "").replace(/[/:]/g, "-");
/** A name wherever it stands by itself, in any case: not inside a longer word. */
const alone = (text: string) => new RegExp(`(?<![A-Za-z])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "gi");

const mail = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g;
const webToken = /eyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+)*/g;
const bearer = /Bearer\s+\S+/g;
const secretKey = /sk-[A-Za-z0-9_-]{8,}/g;
/** The model's thinking as the provider encrypted it, which Pi keeps inside a thinking block's signature. */
const sealedThinking = /("encrypted_content":")[^"]*"/g;

/** Replaces the scratch paths, the home folder, the user and the Mac by fixed stand-ins, everywhere in a value. */
function cleaner({ scratch, cwd, sessionFolder }: Raw): (value: unknown) => unknown {
  const both = (path: string, standIn: string): [string, string][] => [
    [path, standIn],
    [path.replace(/^\/private/, ""), standIn],
  ];
  const paths: [string, string][] = [
    ...both(sessionFolder, "/tmp/portals-sessions"),
    ...both(cwd, "/tmp/portals-cwd"),
    [sessionsName(cwd), "tmp-portals-cwd"],
    ...both(scratch, "/tmp/portals-scratch"),
    [home, "/home/dev"],
  ];
  paths.sort((a, b) => b[0].length - a[0].length);
  const text = (value: string): string => {
    let cleaned = value;
    for (const [path, standIn] of paths) cleaned = cleaned.split(path).join(standIn);
    for (const host of hosts) cleaned = cleaned.replace(alone(host), "mac");
    return cleaned.replace(sealedThinking, '$1redacted"').replace(alone(user), "dev").replace(webToken, "redacted").replace(bearer, "redacted").replace(secretKey, "redacted").replace(mail, "redacted");
  };
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [text(key), clean(inner)]));
    return value;
  };
  return clean;
}

/** The models of the run's provider only: which other providers Pi is signed in to is nobody's business. */
function trimmed(line: Line): Line {
  const record = line.record as Rec | undefined;
  if (record?.type !== "response" || record.command !== "get_available_models" || !Array.isArray(record.data?.models)) return line;
  const models = record.data.models.filter((entry: Rec) => entry.provider === provider);
  return { ...line, record: { ...record, data: { ...record.data, models } } };
}

/**
 * A system message without its text: on the user's settings it holds their context files and
 * the descriptions of their skills and tools. The names of the sections and tools stay.
 */
function withoutPrompt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPrompt);
  if (!value || typeof value !== "object") return value;
  const fields = value as Rec;
  if (fields.role !== "system") return Object.fromEntries(Object.entries(fields).map(([key, inner]) => [key, withoutPrompt(inner)]));
  const leftOut = (list: unknown) => (Array.isArray(list) ? list.map((tool: Rec) => ({ name: tool.name })) : list);
  return {
    ...fields,
    content: typeof fields.content === "string" && fields.content !== "" ? "(left out)" : fields.content,
    ...(fields.sections ? { sections: Object.fromEntries(Object.entries(fields.sections).map(([section, text]) => [section, text === null ? null : "(left out)"])) } : {}),
    ...(fields.toolsAdded ? { toolsAdded: leftOut(fields.toolsAdded) } : {}),
    ...(fields.toolsRemoved ? { toolsRemoved: leftOut(fields.toolsRemoved) } : {}),
  };
}

/** What must not be in a recording. The stand-ins pass. */
const personal = new RegExp(["/Users/", alone(user).source, ...hosts.map((host) => alone(host).source), mail.source, "eyJ[A-Za-z0-9_-]{10,}", "Bearer ", "sk-[A-Za-z0-9]{8,}"].join("|"), "i");

/** Cleans a scenario's records and writes its fixtures. Throws, writing nothing, when something personal is left. */
function write(raw: Raw): void {
  const cleanText = cleaner(raw);
  const clean = (value: unknown) => cleanText(raw.meta.own ? withoutPrompt(value) : value);
  const meta: Line = { kind: "meta", at: 0, ...raw.meta };
  const records = [meta, ...raw.lines.map(trimmed)].map(({ kind, at, ...rest }) => JSON.stringify(clean({ kind, at, ...rest })));
  const session = raw.session?.map((line) => JSON.stringify(clean(JSON.parse(line)))) ?? null;
  for (const [what, lines] of [["records", records], ["session", session ?? []]] as const) {
    const at = lines.findIndex((line) => personal.test(line));
    if (at >= 0) throw new Error(`${raw.name}: line ${at + 1} of the ${what} still holds "${personal.exec(lines[at])![0]}"; nothing was written`);
  }
  mkdirSync(fixtures, { recursive: true });
  const path = join(fixtures, `${raw.name}.jsonl`);
  writeFileSync(path, records.join("\n") + "\n");
  const sessionPath = join(fixtures, `${raw.name}.session.jsonl`);
  if (session) writeFileSync(sessionPath, session.join("\n") + "\n");
  else rmSync(sessionPath, { force: true });
  console.log(`${raw.name}: ${records.length} lines${session ? `, a session of ${session.length}` : ", no session file"} -> ${path}`);
}

// MARK: Running one

/**
 * A session id of the shape the bridge gives a thread, the same for a scenario at every
 * run: its place in the list above, so a new scenario goes at the end.
 */
function sessionIdFor(name: string): string {
  const number = Object.keys(scenarios).indexOf(name) + 1;
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

/** The scenario under way: an interrupted run must not leave its Pi behind. */
let current: Recording | null = null;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    current?.killNow();
    console.error(`stopped by ${signal}; scratch folders under ${scratchSetting} may be left`);
    process.exit(130);
  });
}

async function record(name: string, scenario: Scenario, version: string, scratch: string): Promise<Raw> {
  const cwd = join(scratch, name);
  const sessionFolder = join(scratch, `${name}-sessions`);
  // Where Pi keeps this folder's sessions when it is not told another place.
  const ownFolder = join(home, ".pi", "agent", "sessions", `--${sessionsName(cwd)}--`);
  const forget = () => {
    for (const folder of [cwd, sessionFolder]) rmSync(folder, { recursive: true, force: true });
    if (scenario.ownSessions) rmSync(ownFolder, { recursive: true, force: true });
  };
  forget();
  for (const [file, text] of Object.entries(scenario.files ?? {})) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  mkdirSync(cwd, { recursive: true });

  const pi = new Recording(name, scenario, cwd, sessionFolder, sessionIdFor(name));
  current = pi;
  let failure: Error | null = null;
  try {
    await scenario.run(pi);
  } catch (error) {
    failure = error as Error;
  }
  await pi.stop().catch(() => undefined);
  let session: string[] | null = null;
  try {
    const file = pi.sessionFile;
    // Only a file where this run's sessions go is read.
    if (file && existsSync(file) && [sessionFolder, ownFolder].includes(dirname(file))) session = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
    else if (file && existsSync(file)) console.error(`${name}: the session file is at ${file}, which is not where this run keeps sessions; it was left alone`);
  } finally {
    forget();
  }
  const raw: Raw = {
    name,
    scratch,
    cwd,
    sessionFolder,
    meta: {
      scenario: name,
      about: scenario.about,
      pi: version,
      provider,
      model,
      thinking: scenario.thinking ?? "off",
      ...(scenario.own ? { own: true } : {}),
      session_id: pi.sessionId,
      session_file: session && pi.sessionFile ? basename(pi.sessionFile) : null,
      model_turns: pi.turns,
    },
    lines: pi.lines,
    session,
  };
  if (rawFolder) {
    mkdirSync(rawFolder, { recursive: true });
    writeFileSync(join(rawFolder, `${name}${failure ? ".failed" : ""}.raw.json`), JSON.stringify(raw));
  }
  if (failure) throw new Error(`${name}: ${failure.message}`);
  return raw;
}

const again = process.argv[2] === "--again";
const wanted = process.argv.slice(again ? 3 : 2);
const names = wanted.length ? wanted : Object.keys(scenarios);
for (const name of names) if (!scenarios[name]) throw new Error(`no scenario called ${name}`);

if (again) {
  if (!rawFolder) throw new Error("--again reads the records PI_RECORD_RAW names");
  for (const name of names) write(JSON.parse(readFileSync(join(rawFolder, `${name}.raw.json`), "utf8")) as Raw);
} else {
  const version = await programVersion(piPath, process.env);
  if (version === null) throw new Error(`${piPath} did not run`);
  mkdirSync(scratchSetting, { recursive: true });
  // As Pi sees it: Pi names a folder's sessions by the folder's real path.
  const scratch = realpathSync(scratchSetting);
  try {
    for (const name of names) write(await record(name, scenarios[name], version, scratch));
  } finally {
    // Each scenario removed its own folders; the root goes only when nothing else is in it.
    try {
      rmdirSync(scratch);
    } catch {
      // Not empty, or not ours to remove.
    }
    console.log(`${turns} model turn(s)`);
  }
}
