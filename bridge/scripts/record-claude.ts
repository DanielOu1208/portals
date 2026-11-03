import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  deleteSession,
  getSessionInfo,
  getSessionMessages,
  query,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { InputQueue } from "../src/providers/claude/input.ts";
import { childEnvironment, claudeVersion, queryOptions, thinkingBudget } from "../src/providers/claude/options.ts";

// Records what Claude Code really sends, for the golden tests in test/claude-*.test.ts.
// Each scenario runs Haiku in a scratch folder of its own under /tmp, with
// harmless prompts, then the session is deleted again. Paths and personal fields are
// replaced before anything is written. Haiku thinks as the bridge has it think: adaptive
// thinking when Claude Code lists the model with it (Haiku 5.5 on 2.1.299), else a
// budget (Haiku 4.5).
//
//   node scripts/record-claude.ts [scenario…]     (all of them when none is named)
//
// It uses the user's Claude login and settings, as the bridge does; keep runs rare.
// RECORD_SCRATCH is another scratch folder, for a run beside another.

const scratchRoot = process.env.RECORD_SCRATCH ?? join(realpathSync("/tmp"), "portals-claude-record");
const fixtures = resolve(import.meta.dirname, "../test/fixtures/claude");
const claudePath = join(homedir(), ".local", "bin", "claude");

type Answer = (tool: string, input: Record<string, unknown>) => PermissionResult;

interface Scenario {
  /** Files written into the scratch folder first. */
  files?: Record<string, string>;
  /** null: The user's own default mode. */
  mode: PermissionMode | null;
  prompts: string[];
  /** What the person on the phone answers, question by question (the last one repeats). */
  answers?: Answer[];
  /** After the first piece of text of the first prompt. */
  midTurn?: { interrupt?: true; steer?: string };
  /** Each prompt starts background work: after its turn, the turn Claude starts by itself when the work ends is waited for too. */
  background?: true;
  /** After the prompts (and the turns background work begins), how long to go on listening, in milliseconds: for work still running. */
  linger?: number;
  /** Once a workflow has started and run this many milliseconds, it is stopped on its own (`stopTask`), and the turn is interrupted. */
  stopWorkflow?: number;
  /**
   * After the prompts, the process is closed the way the bridge cools a thread, then a new
   * one resumes the session and this message is sent at once. A `restart` entry marks it.
   */
  resume?: string;
}

const allow: Answer = (_tool, input) => ({ behavior: "allow", updatedInput: input });
const deny: Answer = () => ({ behavior: "deny", message: "Denied from AeriPortal." });
const pickSwift: Answer = (_tool, input) => {
  const questions = (input.questions as { question: string }[]) ?? [];
  return { behavior: "allow", updatedInput: { ...input, answers: Object.fromEntries(questions.map((question) => [question.question, "Swift"])) } };
};

const scenarios: Record<string, Scenario> = {
  plain: {
    mode: null,
    prompts: ["Think about it briefly, then reply with one short sentence that says hello. Do not use any tools."],
  },
  tools: {
    mode: "acceptEdits",
    files: { "hello.txt": "hi\n" },
    prompts: ["In hello.txt, use the Edit tool to change hi to hello. Then run `cat hello.txt` with the Bash tool. Finish with one short sentence."],
    answers: [allow],
  },
  approval: {
    mode: "default",
    prompts: [
      "Use the Write tool to create note.txt containing the single word note. If you are not allowed, stop and say so in one sentence.",
      "Please try once more: create note.txt with the Write tool, then reply in one short sentence.",
    ],
    answers: [deny, allow],
  },
  clarify: {
    mode: null,
    prompts: [
      "Use the AskUserQuestion tool to ask me one question: which language I prefer, with the options Python and Swift. Then reply in one short sentence naming my answer. Do not use other tools.",
    ],
    answers: [pickSwift],
  },
  plan: {
    mode: "plan",
    prompts: ["Make a plan to create plan.txt containing the word planned. Keep the plan to two short steps and present it for approval, then carry it out."],
    answers: [allow],
  },
  interrupt: {
    mode: null,
    prompts: ["Count from 1 to 60, one number per line, with no other text. Do not use any tools."],
    midTurn: { interrupt: true },
  },
  steer: {
    mode: null,
    prompts: ["Count from 1 to 25, one number per line. Do not use any tools."],
    midTurn: { steer: "When you have finished counting, also say the word banana." },
  },
  background: {
    mode: null,
    prompts: ["Run `sleep 3` with the Bash tool in the background (run_in_background: true), then end your turn with one short sentence. Do not wait for it."],
    background: true,
  },
  resumed: {
    mode: null,
    prompts: ["Run `sleep 600` with the Bash tool in the background (run_in_background: true), then end your turn with one short sentence. Do not wait for it."],
    resume: "Is that command still running? Answer in one short sentence without using any tools.",
  },
  // A background subagent and a workflow of two agents, both started in one turn and
  // left to run on after it.
  subagents: {
    mode: null,
    prompts: [
      "Start these two, without waiting for either, then end your turn with one short sentence. 1: a background subagent (Agent tool, run_in_background: true, model haiku, description \"Count the files\") that runs `ls` here and replies with how many entries it saw. 2: a tiny workflow (Workflow tool) whose meta name is tiny-check, with one phase titled Check that runs two agents in parallel, each with model haiku: one labelled apple that replies with the word apple, one labelled pear that replies with the word pear.",
    ],
    background: true,
    linger: 60_000,
  },
  // A workflow stopped on its own while it runs.
  "workflow-stop": {
    mode: null,
    prompts: [
      "Start a workflow (Workflow tool) whose meta name is slow-check, with one phase titled Wait that runs one agent with model haiku, labelled sleeper, which runs `sleep 45` with the Bash tool and then replies with the word done. Do not wait for it: end your turn with one short sentence.",
    ],
    background: true,
    stopWorkflow: 8000,
    linger: 20_000,
  },
  // /compact with nothing to compact yet, then after a turn.
  compact: {
    mode: null,
    prompts: ["/compact", "Reply with the single word hello. Do not use any tools.", "/compact"],
  },
  // Only a /compact that fails, for how Claude Code stores a command that failed (a
  // compaction leaves nothing before it in the session's messages).
  "compact-failed": {
    mode: null,
    prompts: ["/compact"],
  },
};

// MARK: Cleaning

const home = homedir();

function cleaner(cwd: string): (value: unknown, key?: string) => unknown {
  const bare = cwd.replace(/^\/private/, "");
  const paths = [cwd, bare].sort((a, b) => b.length - a.length);
  const clean = (value: unknown, key?: string): unknown => {
    // Lists that describe the user's setup, not the stream.
    if (["tools", "mcp_servers", "slash_commands", "skills", "plugins", "agents", "plugin_errors", "terminal_slash_commands", "betas"].includes(key ?? "") && Array.isArray(value)) return [];
    if (key === "signature" && typeof value === "string") return "signature";
    if (key === "email" || key === "organization") return "redacted";
    if (typeof value === "string") {
      let text = value;
      for (const path of paths) text = text.split(path).join("/tmp/aeriportal-cwd");
      return text.split(home).join("/Users/dev");
    }
    if (Array.isArray(value)) return value.map((item) => clean(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
    return value;
  };
  return clean;
}

// MARK: Running one

async function record(name: string, scenario: Scenario): Promise<void> {
  const cwd = join(scratchRoot, name);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  for (const [file, text] of Object.entries(scenario.files ?? {})) writeFileSync(join(cwd, file), text);

  const started = Date.now();
  const lines: unknown[] = [];
  const add = (entry: Record<string, unknown>) => lines.push({ ...entry, at: Date.now() - started });
  const sessionId = randomUUID();
  let asked = 0;

  const canUseTool: CanUseTool = async (tool, input, options) => {
    const answers = scenario.answers ?? [deny];
    const answer = answers[Math.min(asked, answers.length - 1)](tool, input);
    asked += 1;
    add({
      kind: "permission",
      tool,
      input,
      options: {
        toolUseID: options.toolUseID,
        suggestions: options.suggestions,
        decisionReason: options.decisionReason,
        title: options.title,
        description: options.description,
        displayName: options.displayName,
        blockedPath: options.blockedPath,
      },
      answer,
    });
    return answer;
  };

  const env = childEnvironment(process.env, { clientApp: "portals-bridge/record", apiKey: null });
  add({ kind: "meta", scenario: name, model: "haiku", adaptive_thinking: adaptive, mode: scenario.mode, claude: await claudeVersion(claudePath, env), session_id: sessionId });

  const turn: { over: (() => void) | null } = { over: null };
  /** Waiting for the next result, and for the result that answers a given send. */
  const nextResult: (() => void)[] = [];
  const answeredBy = new Map<string, () => void>();
  let midTurnDone = false;

  /** A `claude` process for the session: the first, or one that resumes it. */
  async function start(resume: boolean) {
    const input = new InputQueue();
    const q = query({
      prompt: input,
      options: queryOptions({
        claudePath,
        cwd,
        env,
        ...(resume ? { resume: sessionId } : { sessionId }),
        model: "haiku",
        permissionMode: scenario.mode,
        effort: null,
        adaptiveThinking: adaptive,
        canUseTool,
      }),
    });
    if (!adaptive) await q.setMaxThinkingTokens(thinkingBudget(null), "summarized");
    const reading = (async () => {
      try {
        await read(q, input);
      } catch (error) {
        // After an interrupt the SDK throws the last error result once the process exits.
        add({ kind: "error", message: (error as Error).message });
      }
    })();
    return { q, input, reading };
  }
  let { q, input, reading } = await start(false);

  async function read(q: ReturnType<typeof query>, input: InputQueue): Promise<void> {
    for await (const message of q as AsyncIterable<SDKMessage>) {
      add({ kind: "message", message });
      const task = message as { type: string; subtype?: string; task_type?: string; task_id?: string };
      if (scenario.stopWorkflow && task.subtype === "task_started" && task.task_type === "local_workflow" && task.task_id) {
        const id = task.task_id;
        setTimeout(() => {
          add({ kind: "control", call: "stopTask", task_id: id });
          void q.stopTask(id);
        }, scenario.stopWorkflow);
      }
      const event = message as { type: string; event?: { type: string; delta?: { type: string } }; queued_turn_count?: number };
      if (!midTurnDone && scenario.midTurn && event.type === "stream_event" && event.event?.delta?.type === "text_delta") {
        midTurnDone = true;
        if (scenario.midTurn.interrupt) {
          add({ kind: "control", call: "interrupt" });
          void q.interrupt();
        }
        if (scenario.midTurn.steer) {
          const message = userMessage(scenario.midTurn.steer);
          add({ kind: "send", text: scenario.midTurn.steer, uuid: message.uuid, steer: true });
          input.push(message);
        }
      }
      // Results name the sends they answered; the turn is over when every send is answered.
      if (event.type === "result") {
        const answered = (message as { user_message_uuids?: string[] }).user_message_uuids ?? [];
        for (const uuid of answered) unanswered.delete(uuid);
        if (answered.length === 0 || scenario.midTurn?.interrupt) unanswered.clear();
        if (unanswered.size === 0) turn.over?.();
        for (const uuid of answered) answeredBy.get(uuid)?.();
        for (const wake of nextResult.splice(0)) wake();
      }
    }
  }

  for (const prompt of scenario.prompts) {
    const over = new Promise<void>((resolve) => {
      turn.over = resolve;
    });
    const message = userMessage(prompt);
    add({ kind: "send", text: prompt, uuid: message.uuid });
    input.push(message);
    await Promise.race([over, wait(180_000)]);
    if (scenario.background) await Promise.race([new Promise<void>((resolve) => nextResult.push(resolve)), wait(120_000)]);
  }
  if (scenario.linger) await wait(scenario.linger);
  input.end();
  await Promise.race([reading, wait(scenario.resume ? 5000 : 15_000)]);
  q.close();

  if (scenario.resume) {
    add({ kind: "restart" });
    ({ q, input, reading } = await start(true));
    const message = userMessage(scenario.resume);
    const answered = new Promise<void>((resolve) => answeredBy.set(message.uuid, resolve));
    add({ kind: "send", text: scenario.resume, uuid: message.uuid });
    input.push(message);
    await Promise.race([answered, wait(180_000)]);
    input.end();
    await Promise.race([reading, wait(15_000)]);
    q.close();
  }

  add({ kind: "history", messages: await getSessionMessages(sessionId, { dir: cwd }) });
  add({ kind: "info", info: await getSessionInfo(sessionId, { dir: cwd }) });
  await deleteSession(sessionId, { dir: cwd }).catch(() => undefined);
  rmSync(cwd, { recursive: true, force: true });
  // Claude Code's project folder for the scratch folder (with an empty memory folder in it).
  rmSync(join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-")), { recursive: true, force: true });

  const clean = cleaner(cwd);
  mkdirSync(fixtures, { recursive: true });
  const path = join(fixtures, `${name}.jsonl`);
  writeFileSync(path, lines.map((line) => JSON.stringify(clean(line))).join("\n") + "\n");
  console.log(`${name}: ${lines.length} lines, ${asked} permission request(s) -> ${path}`);
}

function userMessage(text: string) {
  const uuid = randomUUID();
  unanswered.add(uuid);
  return { type: "user" as const, message: { role: "user" as const, content: text }, parent_tool_use_id: null, session_id: "", uuid };
}

const unanswered = new Set<string>();

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether Claude Code lists Haiku with adaptive thinking, asked of a process that is sent nothing. */
async function haikuThinksAdaptively(): Promise<boolean> {
  const input = new InputQueue();
  const env = childEnvironment(process.env, { clientApp: "portals-bridge/record", apiKey: null });
  mkdirSync(scratchRoot, { recursive: true });
  const q = query({ prompt: input, options: queryOptions({ claudePath, cwd: scratchRoot, env, model: "haiku", permissionMode: null, effort: null, adaptiveThinking: false, canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }) }) });
  try {
    return (await q.supportedModels()).find((model) => model.value === "haiku")?.supportsAdaptiveThinking === true;
  } finally {
    input.end();
    q.close();
  }
}

const adaptive = await haikuThinksAdaptively();
const wanted = process.argv.slice(2);
for (const name of wanted.length ? wanted : Object.keys(scenarios)) {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`no scenario called ${name}`);
  await record(name, scenario);
}
