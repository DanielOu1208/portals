import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DroidTransport } from "../src/providers/droid/rpc.ts";
import {
  AutonomyLevel, CliRequestOrNotificationSchema, createSession, DroidInteractionMode, KillWorkerSessionRequestParamsSchema, listModels,
  ToolConfirmationOutcome, type DroidSession, type ModelInfo, type RequestPermissionRequestParams,
} from "@factory/droid-sdk/node";

// Records real SDK events AND raw onNotification payloads, in arrival order, and whole
// frames the pinned SDK cannot parse (`dropped`), which it would drop unseen.
// Uses the existing CLI login, never changes settings or skips permissions.
//
//   cd bridge && node scripts/record-droid.ts [scenario…]
//   node scripts/record-droid.ts --catalog     (no model turn)
//
// Every run creates a NEW scratch git repo under the system temporary directory.
// It leaves scratch files and CLI session history in place for inspection, but reads
// no history from other sessions. Fixtures contain sanitized scratch events only.
// DROID_RECORD_PATH selects the CLI; DROID_RECORD_MODEL defaults to the cheapest
// catalog Haiku (Haiku 5.5 on CLI 0.245.0). Built-in glm-5.3-flash is an explicit
// fallback for a scenario that the chosen Haiku fails.
// Task uses a project-local custom droid with the SAME fixed model, not tier
// routing (which could select a more expensive model).

const executable = process.env.DROID_RECORD_PATH ?? join(homedir(), ".local/bin/droid");
const fixtures = resolve(import.meta.dirname, "../test/fixtures/droid");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "portals-droid-record-")));
const env = Object.fromEntries(Object.entries({ ...process.env, FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" })
  .filter((entry): entry is [string, string] => entry[1] !== undefined));
const command = "printf 'first\\n'; sleep 1; printf 'second\\n'";
/** The only commands a recording may run (`safePermission`): the two-line print, a listing, and waits. */
const commands = new Set([command, "ls", "sleep 30; echo slept", "sleep 20; echo done"]);
const sdkVersion = (JSON.parse(readFileSync(resolve(import.meta.dirname, "../node_modules/@factory/droid-sdk/package.json"), "utf8")) as { version: string }).version;

interface Scenario {
  prompt: string;
  file?: string;
  spec?: true;
  compact?: true;
  interrupt?: true;
  /** Probe the mission worker-kill RPC against a scratch Task; 1.0 interrupts the parent instead. */
  stopTask?: true;
  stopTaskByTool?: true;
  stopTaskAtRest?: true;
  /**
   * Droid calls its tools through Script: only on a model Droid runs that way (its session's
   * toolExecutionMode is script_only; Droid 0.247 chooses it by model, and ignores
   * `--tool-execution-mode` in an SDK session), named by DROID_RECORD_SCRIPT_MODEL (see
   * --probe-script). The scenario stops before any model call on another.
   */
  script?: true;
  /** After the turn, record on until Droid ends a turn whose id starts so (a background completion's), or 150 s. */
  wait?: string;
  /** The meter's sources (get_context_stats, get_context_breakdown) after each step, and the session's name awaited before compacting. */
  meter?: true;
  /** R4: submit an oversized message while Droid answers background work by itself. */
  oversized?: true;
}

const scenarios: Record<string, Scenario> = {
  plain: { prompt: "Reply only: hello. No tools." },
  execute: { prompt: `Use Execute once: \`${command}\`. Summary: Print two lines. riskLevel: low. Then say done.` },
  edit: { file: "hi\n", prompt: "Read hello.txt then use Edit to change hi to hello. Say done. No other tools." },
  todo: { prompt: "Use TodoWrite once: 1. [completed] Read the note\\n2. [in_progress] Check the note\\n3. [pending] Finish. Then say done. No other tools." },
  subagent: { prompt: "Use Task once with subagent_type record-helper and await true. Task: Read hello.txt in this scratch repo and reply with its single word. Do not use another droid type. Then say done.", file: "pear\n" },
  ask: { prompt: "Use AskUser once with TWO questions: Language (Python or Swift), and Color (Red or Blue). Then name the answers. No other tools." },
  spec: { spec: true, prompt: "Propose a one-step plan to change hi to hello in hello.txt with ExitSpecMode, then implement it after approval. No questions.", file: "hi\n" },
  compact: { compact: true, prompt: "Remember the word pear. Reply only: remembered. No tools." },
  interrupt: { interrupt: true, prompt: "Count from 1 to 1000, one number per line. No tools." },
  "oversized-background": { oversized: true, wait: "execute-completion", prompt: "Run Execute once with command `sleep 20; echo done`, summary: wait, riskLevel: low, fireAndForget: true. End this turn immediately saying started. When its completion arrives later, count from 1 to 200, one per line. No other tools." },
  // n14: R1, R2, R5, R3.
  script: { script: true, prompt: "Use Execute once: `ls`. Summary: list files. riskLevel: low. Then say done." },
  meter: { meter: true, compact: true, prompt: "Remember the word pear. Reply only: remembered. No tools." },
  "script-background": { script: true, wait: "script-completion", prompt: "Make one Script call that runs Execute with command `sleep 30; echo slept` (Summary: wait. riskLevel: low). Do not wait for the Script to finish and do not call WaitForScript: end your turn as soon as the Script call returns, saying only: started." },
  "task-background": { wait: "task-completion", file: "pear\n", prompt: "Use Task once with subagent_type record-sleeper and await false, so it runs in the background. Task: run Execute with command `sleep 20; echo done` (Summary: wait. riskLevel: low), then read hello.txt in this scratch repo and reply with its single word. Do not wait for the Task: end your turn right after launching it, saying only: launched." },
  "task-stop-background": { stopTask: true, wait: "task-completion", file: "pear\n", prompt: "Use Task once with subagent_type record-sleeper and await false. Task: run Execute with command `sleep 20; echo done` (Summary: wait. riskLevel: low), then read hello.txt and reply with its word. End your turn right after launching it, saying only: launched. If the Task is stopped later, acknowledge that and do not launch another." },
  "task-stop-foreground": { stopTask: true, wait: "task-completion", file: "pear\n", prompt: "Use Task once with subagent_type record-sleeper and await true. Task: run Execute with command `sleep 20; echo done` (Summary: wait. riskLevel: low), then read hello.txt and reply with its word. If the Task is stopped, acknowledge that and do not launch another." },
  "task-stop-tool-id": { stopTask: true, stopTaskByTool: true, wait: "task-completion", file: "pear\n", prompt: "Use Task once with subagent_type record-sleeper. Task: run Execute with command `sleep 20; echo done` (Summary: wait. riskLevel: low), then read hello.txt and reply with its word. After launching it, count from 1 to 1000, one number per line, so your turn stays active during the recording. Do not launch another Task." },
  "task-stop-idle": { stopTask: true, stopTaskAtRest: true, wait: "task-completion", file: "pear\n", prompt: "Use Task once with subagent_type record-sleeper. Task: run Execute with command `sleep 20; echo done` (Summary: wait. riskLevel: low), then read hello.txt and reply with its word. End your turn immediately after launching it, saying only: launched. Do not launch another Task." },
};

async function connect(cwd: string): Promise<DroidTransport> {
  const transport = new DroidTransport({ droidExecPath: executable, cwd, env });
  try {
    await transport.connect();
    return transport;
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}

async function catalog(): Promise<ModelInfo[]> {
  const transport = await connect(scratch);
  try { return await listModels({ transport, includeDisabled: true }); }
  finally { await transport.close(); }
}

function inside(cwd: string, path: string): boolean {
  const distance = relative(cwd, resolve(cwd, path));
  return distance !== "" && distance !== ".." && !distance.startsWith("../") && !isAbsolute(distance);
}

type Confirmation = RequestPermissionRequestParams["toolUses"][number]["details"];

/** Fail closed: only the exact harmless commands, or this repo's hello.txt edit, also inside a Script. */
function safeDetails(cwd: string, details: Confirmation, spec: boolean): boolean {
  switch (details.type) {
    case "exec": return commands.has(details.fullCommand);
    case "edit":
    case "create": return inside(cwd, details.filePath) && resolve(cwd, details.filePath) === join(cwd, "hello.txt");
    case "exit_spec_mode": return spec;
    case "script": return details.calls.length > 0 && details.calls.every((call) => safeDetails(cwd, call.confirmation, spec));
    default: return false;
  }
}

function safePermission(cwd: string, params: RequestPermissionRequestParams, spec: boolean): boolean {
  return params.toolUses.length > 0 && params.toolUses.every(({ details }) => safeDetails(cwd, details, spec));
}

function cleaner(cwd: string): (value: unknown, key?: string) => unknown {
  // The system's temporary folder holds the scratch repos and Droid's background output files.
  const temporary = realpathSync(tmpdir());
  const both = (path: string) => [path, path.replace(/^\/private/, "")];
  const paths: [string, string][] = [
    ...[cwd, scratch].flatMap(both).map((path): [string, string] => [path, "/tmp/portals-droid-cwd"]),
    ...both(temporary).map((path): [string, string] => [path, "/tmp"]),
    [homedir(), "/home/recorder"] as [string, string],
  ];
  paths.sort(([a], [b]) => b.length - a.length);
  const clean = (value: unknown, key = ""): unknown => {
    if (/^(email|organization|accountId|userId|apiKey|accessToken|authorization|signature)$/i.test(key)) return "redacted";
    // The person's own MCP servers (`mcp_status_changed`): their state, not their names.
    if (key === "servers" && Array.isArray(value)) {
      return value.map((server, index) => clean({ ...server, name: index === 0 ? "recorded-local-server" : `recorded-local-server-${index + 1}` }));
    }
    // The person's own hooks (`hook_execution_started`, `…_completed`): that they ran, not what they run or print.
    if ((key === "hookCommands" || key === "hookResults") && Array.isArray(value)) {
      return value.map((hook: Record<string, unknown>) => clean({ ...hook, command: "recorded-hook",
        ...(hook.stdout ? { stdout: "recorded hook output" } : {}), ...(hook.stderr ? { stderr: "recorded hook output" } : {}) }));
    }
    // CLI-injected system context can contain personal skills/settings. Preserve the
    // envelope, not that unrelated context. Model/tool output is otherwise untouched.
    if (typeof value === "string") {
      if (value.length > 100_000) return `[recording omitted ${value.length} generated characters]`;
      let text = value.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "<system-reminder>redacted environment context</system-reminder>");
      for (const [path, stand] of paths) text = text.split(path).join(stand);
      return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "redacted@example.invalid");
    }
    if (Array.isArray(value)) return value.map((item) => clean(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clean(item, name)]));
    return value;
  };
  return clean;
}

/** A /context breakdown names the person's own skills, droids and MCP servers: kept as counts only. */
function unnamed(line: unknown): unknown {
  const entry = line as { kind?: unknown; breakdown?: Record<string, unknown> };
  if (entry?.kind !== "breakdown" || !entry.breakdown || typeof entry.breakdown !== "object") return line;
  const breakdown = { ...entry.breakdown };
  for (const key of ["skills", "droids", "mcpServers"]) {
    if (Array.isArray(breakdown[key])) breakdown[key] = (breakdown[key] as Record<string, unknown>[]).map((item, index) => ({ ...item, name: `${key}-${index + 1}` }));
  }
  return { ...entry, breakdown };
}

function write(name: string, cwd: string, lines: unknown[]): void {
  const clean = cleaner(cwd);
  lines = lines.map(unnamed);
  const body = lines.map((line) => JSON.stringify(clean(line))).join("\n") + "\n";
  if (/\/Users\/|Bearer\s|sk-[A-Za-z0-9]{12,}|eyJ[A-Za-z0-9_-]{20,}/i.test(body)) {
    throw new Error(`${name}: privacy scan failed; no fixture written`);
  }
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, `${name}.jsonl`), body);
  console.log(`${name}: ${lines.length} records -> test/fixtures/droid/${name}.jsonl`);
}

async function record(name: string, scenario: Scenario, model: ModelInfo, version: string): Promise<void> {
  const cwd = join(scratch, name);
  mkdirSync(join(cwd, ".factory", "droids"), { recursive: true });
  execFileSync("git", ["init", "--quiet", cwd]);
  if (scenario.file) writeFileSync(join(cwd, "hello.txt"), scenario.file);
  writeFileSync(join(cwd, ".factory", "droids", "record-helper.md"),
    `---\nname: record-helper\ndescription: Scratch recording helper\nmodel: ${model.id}\ntools: ["Read"]\n---\nRead only hello.txt in the supplied scratch working directory. Reply with its word. No other actions.\n`);
  writeFileSync(join(cwd, ".factory", "droids", "record-sleeper.md"),
    `---\nname: record-sleeper\ndescription: Scratch recording helper that waits\nmodel: ${model.id}\ntools: ["Read", "Execute"]\n---\nRun only the one Execute command you are given, then read hello.txt in the supplied scratch working directory and reply with its word. No other actions.\n`);

  const began = Date.now();
  const lines: unknown[] = [];
  const add = (entry: Record<string, unknown>) => lines.push({ ...entry, at: Date.now() - began });
  add({ kind: "meta", scenario: name, cli: version, sdk: sdkVersion, model: model.id, modelName: model.displayName, tokenMultiplier: model.tokenMultiplier, cwd });
  const transport = await connect(cwd);
  // What Droid sent that the pinned SDK cannot parse, and so drops before any handler sees it.
  const listen = transport.onMessage.bind(transport);
  transport.onMessage = (handler) => listen((message) => {
    if ((message as { type?: unknown }).type !== "response" && !CliRequestOrNotificationSchema.safeParse(message).success) add({ kind: "dropped", frame: message });
    handler(message);
  });
  let session: DroidSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let interrupted = false;
  let stoppingTask = false;
  let stopTask: (() => Promise<void>) | undefined;

  let oversized: Promise<void> | undefined;
  const controls: Promise<unknown>[] = [];
  try {
    session = await createSession({
      transport, cwd, modelId: model.id, reasoningEffort: model.defaultReasoningEffort,
      specModeModelId: model.id, specModeReasoningEffort: model.defaultReasoningEffort,
      autonomyLevel: AutonomyLevel.Off,
      interactionMode: scenario.spec ? DroidInteractionMode.Spec : DroidInteractionMode.Auto,
      disableBuiltinSkills: true,
      abortSignal: AbortSignal.timeout(scenario.wait || scenario.meter ? 300_000 : 120_000),
      systemPrompt: { type: "preset", preset: "droid", append: `This is a tiny SDK recording in ${cwd}. Stay inside this directory. No network tools or user settings. Follow the requested tool exactly; no unrelated tasks. Keep replies tiny. Task may ONLY use record-helper or record-sleeper, both fixed to ${model.id}.` },
      permissionHandler(params) {
        const selectedOption = safePermission(cwd, params, scenario.spec === true)
          && params.options.some((option) => option.value === ToolConfirmationOutcome.ProceedOnce)
          ? ToolConfirmationOutcome.ProceedOnce : ToolConfirmationOutcome.Cancel;
        add({ kind: "permission", params, answer: { selectedOption } });
        return { selectedOption };
      },
      askUserHandler(params) {
        const answer = { answers: params.questions.map((question) => ({
          index: question.index, question: question.question,
          answer: ["Swift", "Blue"].find((option) => question.options.includes(option)) ?? question.options[0] ?? "Recorder",
        })) };
        add({ kind: "ask", params, answer });
        return answer;
      },
    });
    add({ kind: "session", sessionId: session.id, settings: session.settings });
    if (scenario.script && (session.settings as { toolExecutionMode?: unknown }).toolExecutionMode !== "script_only") {
      throw new Error(`${model.id} does not call its tools through Script here (toolExecutionMode ${(session.settings as { toolExecutionMode?: unknown }).toolExecutionMode}); no model call was made.`);
    }
    const heard: Record<string, unknown>[] = [];
    const subscribe = () => session!.onNotification((notification) => {
      add({ kind: "notification", notification });
      const inner = (notification.params as { notification?: Record<string, unknown> } | undefined)?.notification;
      if (inner) heard.push(inner);
      if (scenario.stopTask && !stoppingTask && inner?.type === "child_session_available" && typeof inner.childSessionId === "string") {
        stoppingTask = true;
        const childSessionId = inner.childSessionId;
        const params = KillWorkerSessionRequestParamsSchema.parse({ workerSessionId: scenario.stopTaskByTool ? inner.toolUseId : childSessionId });
        stopTask = async () => {
          add({ kind: "control", call: "kill_worker_session", params });
          const result = await transport.request("droid.kill_worker_session", params).catch((error: Error) => ({ error: error.message }));
          add({ kind: "response", call: "kill_worker_session", result });
          if (scenario.stopTaskAtRest) {
            const params = { processId: childSessionId };
            add({ kind: "control", call: "kill_background_process", params });
            const result = await transport.request("droid.kill_background_process", params).catch((error: Error) => ({ error: error.message }));
            add({ kind: "response", call: "kill_background_process", result });
          }
        };
        if (!scenario.stopTaskAtRest) controls.push(new Promise<void>((done) => setTimeout(done, 2000)).then(stopTask));
      }
      if (scenario.oversized && !oversized && inner?.type === "assistant_text_delta" && heard.some((entry) => entry.type === "create_message" && String((entry.message as { id?: string })?.id).startsWith("execute-completion:"))) {
        // A real model turn is now under way. The generated paste must be refused
        // locally, not sent to the model; keep its size, not megabytes of filler.
        oversized = turn("quartz ".repeat(2_000_000), true);
      }
    });
    unsubscribe = subscribe();
    /** Records on until `done` says so of what was heard, or `ms` pass. */
    const hearUntil = async (what: string, done: () => boolean, ms: number) => {
      const until = Date.now() + ms;
      while (!done() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 250));
      add({ kind: "control", call: "wait", what, met: done() });
    };
    /** The meter's two sources, as the bridge reads them. */
    const meter = async (step: string) => {
      if (!scenario.meter) return;
      add({ kind: "context", step, stats: await session!.getContextStats() });
      add({ kind: "breakdown", step, breakdown: await transport.request("droid.get_context_breakdown").catch((error: Error) => ({ error: error.message })) });
    };
    const turn = async (prompt: string, oversized = false) => {
      add({ kind: "send", ...(oversized ? { generated: "quartz repeated 2000000 times", characters: prompt.length } : { prompt }) });
      for await (const event of session!.stream(prompt, { includePartialMessages: true })) {
        add({ kind: "event", event });
        if (scenario.interrupt && !interrupted && event.type === "assistant_text_delta") {
          interrupted = true;
          add({ kind: "control", call: "interrupt" });
          controls.push(session!.interrupt().then(() => add({ kind: "response", call: "interrupt" })));
        }
      }
      await Promise.all(controls);
    };
    await turn(scenario.prompt);
    if (scenario.stopTask && !stoppingTask) throw new Error("Droid did not start a Task to stop.");
    if (scenario.stopTaskAtRest) await stopTask!();
    if (scenario.wait) {
      const prefix = scenario.wait;
      await hearUntil(`${prefix} turn end`, () => heard.some((inner) => inner.type === "agent_turn_completed" && typeof inner.turnId === "string" && inner.turnId.startsWith(prefix)), 150_000);
      // And the idle after it.
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (scenario.oversized) {
      if (!oversized) throw new Error("Droid did not start the background completion turn; R4 was not staged.");
      await oversized;
    }
    if (scenario.meter) await hearUntil("session name", () => heard.some((inner) => inner.type === "session_title_updated"), 30_000);
    add({ kind: "context", stats: await session.getContextStats() });
    await meter("after the first turn");
    if (scenario.compact) {
      const oldSessionId = session.id;
      add({ kind: "control", call: "compact", oldSessionId });
      const { session: successor, ...result } = await session.compact({ customInstructions: "Keep the remembered word." });
      add({ kind: "response", call: "compact", result, oldSessionId, newSessionId: successor.id });
      unsubscribe();
      session = successor;
      unsubscribe = subscribe();
      await meter("after compacting");
      await turn("What word did I ask you to remember? Reply with only it. No tools.");
      add({ kind: "context", stats: await session.getContextStats() });
      await meter("after the turn after compacting");
    }
  } catch (error) {
    add({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    unsubscribe?.();
    await session?.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    write(name, cwd, lines);
  }
}

const wanted = process.argv.slice(2);
if (!wanted.includes("--catalog") && !wanted.includes("--probe-script")) {
  for (const name of wanted) if (!scenarios[name]) throw new Error(`No scenario called ${name}`);
}
const models = await catalog();
/** Each enabled built-in model's tool execution mode, from a session made on it and closed at once: no model call. */
async function probeScript(): Promise<void> {
  const cwd = join(scratch, "probe-script");
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "--quiet", cwd]);
  for (const model of models.filter((item) => !item.disabled && !item.isCustom)) {
    const transport = await connect(cwd);
    try {
      const session = await createSession({ transport, cwd, modelId: model.id, autonomyLevel: AutonomyLevel.Off, abortSignal: AbortSignal.timeout(60_000) });
      console.log(JSON.stringify({ id: model.id, tokenMultiplier: model.tokenMultiplier, toolExecutionMode: (session.settings as { toolExecutionMode?: unknown }).toolExecutionMode }));
      await session.close().catch(() => undefined);
    } catch (error) {
      console.log(JSON.stringify({ id: model.id, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      await transport.close().catch(() => undefined);
    }
  }
}
const haiku = models.filter((model) => !model.disabled && !model.isCustom && /haiku/i.test(model.displayName));
haiku.sort((a, b) => (a.tokenMultiplier ?? Infinity) - (b.tokenMultiplier ?? Infinity));
if (wanted.includes("--probe-script")) {
  await probeScript();
} else if (wanted.includes("--catalog")) {
  console.log(JSON.stringify(models.filter((model) => !model.isCustom).map(({ id, displayName, tokenMultiplier, disabled, disabledReason }) =>
    ({ id, displayName, tokenMultiplier, disabled, disabledReason })), null, 2));
} else {
  const model = models.find((item) => item.id === (process.env.DROID_RECORD_MODEL ?? haiku[0]?.id));
  if (!model || model.disabled || model.isCustom || (model.tokenMultiplier ?? Infinity) > 0.4
    || (model.id !== "glm-5.3-flash" && model.id !== haiku[0]?.id)) {
    throw new Error("Recording requires built-in GLM-5.3-Flash or the cheapest available Haiku, at multiplier <=0.4.");
  }
  // A Script scenario runs on the model DROID_RECORD_SCRIPT_MODEL names, one Droid runs through Script, at multiplier 2 at most.
  const scriptModel = process.env.DROID_RECORD_SCRIPT_MODEL ? models.find((item) => item.id === process.env.DROID_RECORD_SCRIPT_MODEL) : undefined;
  if (process.env.DROID_RECORD_SCRIPT_MODEL && (!scriptModel || scriptModel.disabled || scriptModel.isCustom || (scriptModel.tokenMultiplier ?? Infinity) > 2)) {
    throw new Error("DROID_RECORD_SCRIPT_MODEL must name an enabled built-in model at multiplier <=2.");
  }
  const version = execFileSync(executable, ["--version"], { encoding: "utf8", env }).trim();
  console.log(`Droid ${version}; ${model.displayName} (${model.id})${scriptModel ? `, Scripts on ${scriptModel.id}` : ""}; scratch ${scratch}`);
  for (const name of wanted.length ? wanted : Object.keys(scenarios)) {
    if (scenarios[name].script && !scriptModel) throw new Error(`${name} needs DROID_RECORD_SCRIPT_MODEL (see --probe-script).`);
    await record(name, scenarios[name], scenarios[name].script ? scriptModel! : model, version);
  }
}
