import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CodexClient, processConnector, socketConnector } from "../src/providers/codex/client.ts";
import { codexVersion, defaultSocketPath, policyFor } from "../src/providers/codex/options.ts";
import type { RequestId } from "../src/providers/codex/types/index.ts";

// Records what Codex really sends, for the golden tests in test/codex-*.test.ts. Each
// scenario starts a thread on the shared app-server daemon in a scratch folder of its
// own under /tmp, with harmless prompts and the default model (at low effort
// unless the scenario says otherwise), then the thread is deleted again. Paths and
// personal fields are replaced before anything is written.
//
//   node scripts/record-codex.ts [scenario…]     (all of them when none is named)
//
// It uses the user's ChatGPT login and quota, as the bridge does; keep runs rare.
// RECORD_MODEL and RECORD_EFFORT record on another model and effort (a cheap one, low,
// for every scenario); RECORD_SCRATCH is another scratch folder, for a run beside another.
// With RECORD_OWN=1 it runs a `codex app-server` of its own instead of joining the daemon.

const scratchRoot = process.env.RECORD_SCRATCH ?? join(realpathSync("/tmp"), "portals-codex-record");
const recordModel = process.env.RECORD_MODEL ?? null;
const recordEffort = process.env.RECORD_EFFORT ?? null;
const fixtures = resolve(import.meta.dirname, "../test/fixtures/codex");

type Answer = (method: string, params: any) => unknown;

interface Scenario {
  files?: Record<string, string>;
  /** `/mode ask` and so on; absent: The user's own settings. */
  mode?: "ask";
  prompts: string[];
  /** The answers to Codex's requests, in order (the last one repeats). */
  answers?: Answer[];
  /** After the first piece of the reply to the first prompt. */
  midTurn?: { interrupt?: true; steer?: string };
  /** Turn settings beyond the effort (Codex's plan mode, to get questions). */
  turn?: Record<string, unknown>;
  effort?: string;
  /** The sub-agents it spawns are recorded too: the notifications of their own threads. */
  agents?: true;
}

const accept: Answer = () => ({ decision: "accept" });
const decline: Answer = () => ({ decision: "decline" });
const pickSwift: Answer = (_method, params) => ({
  answers: Object.fromEntries((params.questions ?? []).map((question: { id: string }) => [question.id, { answers: ["Swift"] }])),
});

const scenarios: Record<string, Scenario> = {
  plain: {
    effort: "high",
    turn: { summary: "auto" },
    files: { "hello.txt": "hi\n" },
    prompts: [
      "First say in one short sentence what you are about to do. Then run `ls` in this folder. Then reply with one short sentence that names the file you saw and says whether 221 is a prime number (work it out before you answer).",
    ],
  },
  tools: {
    mode: "ask",
    files: { "hello.txt": "hi\n" },
    prompts: ["In hello.txt, change hi to hello by editing the file with a patch. Then run `wc -c hello.txt`. Finish with one short sentence."],
    answers: [accept],
  },
  approval: {
    mode: "ask",
    prompts: [
      "Create note.txt containing the single word note, with a patch. Then run `touch done.txt`. Then create other.txt containing the word other, with a patch. If a step is not allowed, do not retry it: go on to the next step. Finish with one short sentence saying what happened.",
    ],
    // The edit and the command are declined (a command's choices may not list
    // "decline"), the second edit is accepted.
    answers: [decline, decline, accept],
  },
  clarify: {
    turn: { collaborationMode: { mode: "plan", settings: { model: recordModel ?? "gpt-6.1-sol", reasoning_effort: "low", developer_instructions: null } } },
    prompts: [
      "Use the request_user_input tool to ask me one question: which language I prefer, with the options Python and Swift. Then reply in one short sentence naming my answer. Do not run commands or edit files.",
    ],
    answers: [pickSwift],
  },
  // Codex's plan mode ends its turn with a plan (a `plan` item), which the bridge puts to
  // the person as a plan card.
  plan: {
    files: { "hello.txt": "hi\n" },
    turn: { model: "gpt-6-luna", collaborationMode: { mode: "plan", settings: { model: "gpt-6-luna", reasoning_effort: "low", developer_instructions: null } } },
    prompts: ["Plan how to change hi to hello in hello.txt, in two short steps. Do not ask me anything."],
  },
  reasoning: {
    effort: "high",
    turn: { summary: "auto" },
    prompts: [
      "Without using any tools: what is the smallest positive integer n for which n*n + n + 41 is not a prime number? Check your answer, then reply with the number and one short sentence saying why.",
    ],
  },
  steer: {
    prompts: ["Count from 1 to 40, one number per line, with no other text. Do not use any tools."],
    midTurn: { steer: "When you have finished counting, also say the word banana." },
  },
  interrupt: {
    prompts: ["Count from 1 to 300, one number per line, with no other text. Do not use any tools."],
    midTurn: { interrupt: true },
  },
  // One sub-agent, spawned and waited for, on the smallest model.
  subagent: {
    agents: true,
    turn: { model: "gpt-6-luna" },
    prompts: [
      "Spawn one sub-agent (spawn_agent) whose whole task is to reply with the single word pear. Wait for it to finish, then reply with one short sentence saying what it answered. Do not run commands or edit files yourself.",
    ],
  },
  // "/compact" is sent the way the bridge sends it: `thread/compact/start`.
  compact: {
    prompts: ["Reply with the single word hello. Do not use any tools.", "/compact"],
  },
};

// MARK: Cleaning

const home = homedir();

function cleaner(cwd: string): (value: unknown, key?: string) => unknown {
  const bare = cwd.replace(/^\/private/, "");
  const paths = [cwd, bare].sort((a, b) => b.length - a.length);
  const clean = (value: unknown, key?: string): unknown => {
    if (key === "instructionSources" && Array.isArray(value)) return [];
    if (key === "email" || key === "accountId" || key === "userId") return "redacted";
    if (key === "balance" && typeof value === "string") return "0";
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

const client = new CodexClient({
  connect: process.env.RECORD_OWN === "1" ? processConnector("codex", process.env) : socketConnector(defaultSocketPath()),
  clientInfo: { name: "portals-bridge", title: "Portals (recording)", version: "0.1.0" },
});

async function record(name: string, scenario: Scenario): Promise<void> {
  const cwd = join(scratchRoot, name);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  for (const [file, text] of Object.entries(scenario.files ?? {})) writeFileSync(join(cwd, file), text);

  const started = Date.now();
  const lines: unknown[] = [];
  const add = (entry: Record<string, unknown>) => lines.push({ ...entry, at: Date.now() - started });
  let threadId = "";
  let asked = 0;
  let turnId = "";
  let midTurnDone = false;
  let turnOver: (() => void) | null = null;

  const mine = (params: any) => params?.threadId === threadId || params?.thread?.id === threadId;
  // The scenario's sub-agents: threads started with this one as their parent.
  const agents = new Set<string>();
  const ofAgent = (params: any) => {
    if (!scenario.agents) return false;
    if (params?.thread?.parentThreadId === threadId && typeof params.thread.id === "string") agents.add(params.thread.id);
    return agents.has(params?.threadId) || agents.has(params?.thread?.id);
  };
  const stop = client.listen({
    notification(method, params) {
      if (!threadId) return;
      if (method === "account/rateLimits/updated" || mine(params) || ofAgent(params)) add({ kind: "notification", method, params });
      if (!mine(params)) return;
      if (method === "turn/started") turnId = params.turn.id;
      if (!midTurnDone && scenario.midTurn && method === "item/agentMessage/delta") {
        midTurnDone = true;
        if (scenario.midTurn.interrupt) {
          const call = { threadId, turnId };
          add({ kind: "send", method: "turn/interrupt", params: call });
          void client.call("turn/interrupt", call).then((result) => add({ kind: "response", method: "turn/interrupt", result }));
        }
        if (scenario.midTurn.steer) {
          const call = { threadId, input: [{ type: "text", text: scenario.midTurn.steer, text_elements: [] }], expectedTurnId: turnId };
          add({ kind: "send", method: "turn/steer", params: call });
          void client.call("turn/steer", call).then(
            (result) => add({ kind: "response", method: "turn/steer", result }),
            (error: Error) => add({ kind: "response", method: "turn/steer", error: error.message }),
          );
        }
      }
      if (method === "turn/completed") turnOver?.();
    },
    request(id: RequestId, method, params) {
      if (!mine(params)) return;
      add({ kind: "request", id, method, params });
      const answers = scenario.answers ?? [decline];
      const answer = answers[Math.min(asked, answers.length - 1)](method, params);
      asked += 1;
      add({ kind: "answer", id, method, result: answer });
      client.respond(id, answer);
    },
    connected() {},
    disconnected(reason) {
      add({ kind: "disconnected", reason });
    },
  });

  try {
    const thread = await client.call("thread/start", recordModel ? { cwd, model: recordModel } : { cwd });
    threadId = thread.thread.id;
    const effort = recordEffort ?? scenario.effort ?? "low";
    add({ kind: "meta", scenario: name, codex: await codexVersion("codex", process.env), mode: scenario.mode ?? "default", effort, thread_id: threadId, model: thread.model });
    const policy = scenario.mode ? policyFor(scenario.mode, null) : null;
    for (const prompt of scenario.prompts) {
      const over = new Promise<void>((resolve) => {
        turnOver = resolve;
      });
      const compacting = prompt === "/compact";
      const method = compacting ? "thread/compact/start" : "turn/start";
      const params = compacting
        ? { threadId }
        : {
            threadId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            effort,
            ...(policy ?? {}),
            ...scenario.turn,
          };
      add({ kind: "send", method, params });
      const result = await client.call(method, params);
      add({ kind: "response", method, result });
      const late = await Promise.race([over.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 150_000))]);
      if (late) {
        // Stuck (an answer Codex did not take): stop the turn rather than leave it running.
        add({ kind: "send", method: "turn/interrupt", params: { threadId, turnId } });
        await client.call("turn/interrupt", { threadId, turnId }).catch(() => undefined);
        await Promise.race([over, new Promise((resolve) => setTimeout(resolve, 20_000))]);
      }
    }
    // Late notifications (usage, the name) come just after the turn.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (const agent of agents) await client.call("thread/delete", { threadId: agent }).catch(() => undefined);
    add({ kind: "history", thread: (await client.call("thread/read", { threadId, includeTurns: true })).thread });
  } finally {
    stop();
    if (threadId) await client.call("thread/delete", { threadId }).catch((error: Error) => console.error(`could not delete ${threadId}: ${error.message}`));
    rmSync(cwd, { recursive: true, force: true });
  }

  const clean = cleaner(cwd);
  mkdirSync(fixtures, { recursive: true });
  const path = join(fixtures, `${name}.jsonl`);
  writeFileSync(path, lines.map((line) => JSON.stringify(clean(line))).join("\n") + "\n");
  console.log(`${name}: ${lines.length} lines, ${asked} request(s) -> ${path}`);
}

await client.start();
try {
  const wanted = process.argv.slice(2);
  for (const name of wanted.length ? wanted : Object.keys(scenarios)) {
    const scenario = scenarios[name];
    if (!scenario) throw new Error(`no scenario called ${name}`);
    await record(name, scenario);
  }
} finally {
  client.close();
  rmSync(scratchRoot, { recursive: true, force: true });
}
