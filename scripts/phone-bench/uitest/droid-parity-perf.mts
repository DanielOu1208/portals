import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Prompt, ProviderEvent, SessionOptions, SessionSink } from "../../../bridge/src/providers/types.ts";
import type { FakeOptions } from "../../../bridge/src/providers/fake.ts";

// One isolated run of docs/perf-mac-scroll.md. Run builds interleaved, not concurrently.
// --app <Release+DEBUG .app> --label baseline|current --out <scratch dir> --turns 45|1 --round 1 [--launch-probe]
// PORTALS_PARITY_SOURCE optionally selects a clean source snapshot for BOTH apps' bridge.
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("droid-parity-perf.mts --app <Release+DEBUG .app> --label baseline|current --out <scratch dir> --turns 45|1 --round <n> [--launch-probe]");
  process.exit(0);
}
function argument(name: string): string {
  const at = args.indexOf(name);
  if (at < 0 || !args[at + 1]) throw new Error(`missing ${name}`);
  return args[at + 1];
}
const app = resolve(argument("--app"));
const label = argument("--label");
const out = resolve(argument("--out"));
const turns = Number(argument("--turns"));
const round = Number(argument("--round"));
const launchProbe = args.includes("--launch-probe");
if (!["baseline", "current"].includes(label) || ![1, 45].includes(turns) || !Number.isInteger(round) || round < 1) {
  throw new Error("expected baseline/current, 1/45 turns, and a positive round");
}
if (!app.endsWith(".app") || !out.startsWith("/private/tmp/portals-droid-perf-")) {
  throw new Error("use a built app and an isolated /private/tmp/portals-droid-perf-* output directory");
}
const run = join(out, `r${round}-${label}-${turns}`);
mkdirSync(run, { recursive: false });
const source = process.env.PORTALS_PARITY_SOURCE ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const load = (path: string) => import(pathToFileURL(join(source, path)).href);
const [{ startBridge }, { hashPassword }, { FakeProvider }, { Device }] = await Promise.all([
  load("bridge/src/bridge.ts"), load("bridge/src/http/auth.ts"),
  load("bridge/src/providers/fake.ts"), load("bridge/scripts/bench/device.ts"),
]);
const execute = promisify(execFile);
async function command(binary: string, arguments_: string[]) {
  return (await execute(binary, arguments_, { maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}
const session = `parity-${launchProbe ? "crash-probe" : "perf"}-${label}-${turns}-${round}-${Date.now()}`;
async function cua(name: string, parameters: Record<string, unknown>) {
  const result = JSON.parse(await command("cua-driver", [name, JSON.stringify({ ...parameters, session })]));
  if (result.refusal || result.error || result.isError) throw new Error(JSON.stringify(result));
  return result;
}

// The ordinary deterministic fakeBench reply plus representative Phase 2 updates.
// This wrapper runs no commands. It never changes the product fakeBench workload.
class ActivityBenchProvider extends FakeProvider {
  constructor(options: FakeOptions) { super(options); }

  async startSession(options: SessionOptions, sink: SessionSink) {
    let live = false;
    let sequence = 0;
    let active: { id: string; output: string; tick: number; timer: NodeJS.Timeout } | undefined;
    const args = { command: "printf 'scripted benchmark output'", summary: "Scripted 5 Hz output", riskLevel: "low", fireAndForget: false };
    const todo = (complete: boolean) => {
      const id = `perf-todo-${++sequence}`;
      const items = [
        { text: "Inspect bridge", status: "completed" },
        { text: "Stream benchmark", status: complete ? "completed" : "in_progress" },
        { text: "Check frames", status: complete ? "completed" : "pending" },
      ];
      const args = { items, todos: items.map((item, i) => `${i + 1}. [${item.status}] ${item.text}`).join("\n") };
      sink.emit({ type: "tool.start", id, name: "todo", args });
      sink.emit({ type: "tool.end", id, name: "todo", args, result: "TODO List Updated" });
    };
    const finish = () => {
      if (!active) return;
      clearInterval(active.timer);
      sink.emit({ type: "tool.end", id: active.id, name: "terminal", args, result: { output: active.output, exit_code: 0 } });
      active = undefined;
      todo(true);
    };
    const wrapped: SessionSink = {
      ...sink,
      emit(event: ProviderEvent) {
        if (live && event.type === "text" && !active) {
          todo(false);
          const id = `perf-output-${++sequence}`;
          sink.emit({ type: "working", state: "executing_tool", text: "Running scripted benchmark" });
          sink.emit({ type: "tool.start", id, name: "terminal", args });
          active = { id, output: "", tick: 0, timer: setInterval(() => {
            if (!active) return;
            active.tick += 1;
            active.output += `benchmark-line ${String(active.tick).padStart(5, "0")}\n`;
            sink.emit({ type: "tool.progress", id, output: active.output, progress: `Output line ${active.tick}` });
            if (active.tick % 5 === 0) sink.emit({ type: "turn.usage", usage: { tokens: 1000 + active.tick * 20 } });
          }, 200) };
        }
        if (event.type === "turn.end") finish();
        sink.emit(event);
      },
    };
    const providerSession = await super.startSession(options, wrapped);
    const start = providerSession.startTurn.bind(providerSession);
    providerSession.startTurn = (prompt: Prompt) => {
      live = !/\binstant\b/.test(prompt.text);
      start(prompt);
    };
    const close = providerSession.close.bind(providerSession);
    providerSession.close = async () => { finish(); await close(); };
    return providerSession;
  }
}

const home = mkdtempSync(join(run, "bridge-"));
const work = join(home, "work");
mkdirSync(work);
const username = "parity-perf";
const password = randomBytes(24).toString("base64url");
writeFileSync(join(home, "config.json"), JSON.stringify({
  host: "127.0.0.1", port: 0,
  auth: { username, passwordHash: await hashPassword(password) },
  allowedHosts: ["127.0.0.1", "localhost", "::1"], generalFolder: work,
  providers: { claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, fake: true },
  apns: null, push: { relay: null, dryRun: join(home, "push.jsonl") },
  // No standby link to the deployed relay: the relay is on unless set off.
  relay: { enabled: false },
  aeri: { enabled: false }, counters: { enabled: false }, fleet: { tellAgents: false }, visuals: { tellAgents: false },
}), { mode: 0o600, flag: "wx" });
const bridge = await startBridge({
  home, temporaryFolders: [],
  providers: new Map([["fake", new ActivityBenchProvider({ directory: join(home, "fake"), delayMs: 0 })]]),
});
const device = await Device.open({ url: bridge.url, account: { username, password } });
let appPID: number | undefined;
let target: { pid: number; window_id: number } | undefined;
function trace(phase: string, fields: Record<string, unknown> = {}) {
  appendFileSync(join(run, "trace.jsonl"), JSON.stringify({ at: new Date().toISOString(), phase, session, pid: appPID, ...fields }) + "\n");
}
const framePath = join(run, "frames.txt");
const prepared = join(homedir(), "Applications", `PortalsParityPerf-${label}.app`);
const bundle = `com.danielou.portals.parity.perf.${label}`;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (appPID) {
    try { process.kill(appPID, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  await device.disconnect();
  await bridge.close();
  await cua("end_session", {});
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });

type FrameRow = [number, number, number, number, number];
function rows(): FrameRow[] {
  if (!existsSync(framePath)) return [];
  return readFileSync(framePath, "utf8").trim().split("\n").map(line => line.split(/\s+/).map(Number) as FrameRow).filter(row => row.length === 5 && row.every(Number.isFinite));
}
function frames(mark: number) {
  const all = rows();
  const selected = all.slice(mark);
  if (selected.length < 2) throw new Error("FrameMeter produced insufficient data");
  const seconds = selected.at(-1)![0] - (mark ? all[mark - 1][0] : 0);
  return {
    seconds,
    hitchMsPerSecond: selected.reduce((n, row) => n + row[3], 0) / seconds,
    hitchesPerSecond: selected.reduce((n, row) => n + row[2], 0) / seconds,
    fps: selected.reduce((n, row) => n + row[1], 0) / seconds,
    longestMs: Math.max(...selected.map(row => row[4])),
  };
}
async function cpuSeconds() {
  return (await command("ps", ["-p", String(appPID), "-o", "cputime="])).replace("-", ":").split(":").reduce((n, part) => n * 60 + Number(part), 0);
}
async function snapshot(name: string) {
  const state = await cua("get_window_state", { ...target, max_elements: 45, screenshot_out_file: join(run, `${name}.png`) });
  writeFileSync(join(run, `${name}.json`), JSON.stringify(state, null, 2));
  if (state.screenshot_frame_valid !== true ||
      state.background_input?.exact_window?.status !== "matched" ||
      state.background_input?.routes?.find((route: { route: string }) => route.route === "window_pointer")?.status !== "available") {
    throw new Error(`target unavailable at ${name}: ${state.degraded_reason ?? JSON.stringify(state.background_input)}`);
  }
  return state;
}
async function scrollFor(seconds: number) {
  const before = await snapshot(`scroll-before-${rows().length}`);
  if (!before.screenshot_width || !before.screenshot_height) throw new Error("no current target screenshot for wheel coordinates");
  const x = Math.round(before.screenshot_width * 0.62);
  const y = Math.round(before.screenshot_height * 0.45);
  const until = performance.now() + seconds * 1000;
  let step = 0;
  while (performance.now() < until) {
    await cua("scroll", { ...target, x, y, direction: Math.floor(step / 2) % 2 === 0 ? "up" : "down", amount: 6, by: "line" });
    step += 1;
  }
  await cua("scroll", { ...target, x, y, direction: "down", amount: 30, by: "page" });
  return step;
}
async function waitForTurn(thread: string) {
  for (;;) {
    try { await device.event("message.complete", thread); return; }
    catch (error) { if (!/no message.complete event/.test(String(error))) throw error; }
  }
}

try {
  const thread = (await device.call("session.create", { profile: "fake", source: "tui" })).session_id;
  for (let index = 0; index < turns; index += 1) {
    const ended = device.event("message.complete", thread);
    await device.call("prompt.submit", { session_id: thread, text: `bench instant, turn ${index + 1}`, profile: "fake" });
    await ended;
  }
  const hosts = JSON.stringify([{ name: "Parity performance", url: bridge.url, user: username, password }]);
  const appHome = join(run, "app-home");
  mkdirSync(appHome);
  const environment = { CFFIXED_USER_HOME: appHome, PORTALS_DEBUG_HOSTS: hosts, PORTALS_DEBUG_OPEN_LATEST: "1", PORTALS_DEBUG_FRAMES: framePath };
  const settings = join(run, "private-launch.json");
  writeFileSync(settings, JSON.stringify({ app, prepared, bundle, environment }), { mode: 0o600, flag: "wx" });
  // Python only prepares this owned copy. App discovery, launch and input use Cua.
  await command("python3", ["-c", [
    "import json,pathlib,plistlib,shutil,sys",
    "s=json.load(open(sys.argv[1])); p=pathlib.Path(s['prepared'])",
    "shutil.copytree(s['app'],p,dirs_exist_ok=True,ignore=shutil.ignore_patterns('PlugIns','Extensions'))",
    "i=p/'Contents/Info.plist'; d=plistlib.loads(i.read_bytes())",
    "d['CFBundleIdentifier']=s['bundle']; d['CFBundleDisplayName']='Portals Parity Perf'; d.pop('CFBundleURLTypes',None)",
    "d['LSEnvironment']=s['environment']; i.write_bytes(plistlib.dumps(d)); i.chmod(0o600)",
  ].join("\n"), settings]);
  await command("codesign", ["--force", "--deep", "--sign", "-", prepared]);
  await command("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", prepared]);
  const launched = await cua("launch_app", { bundle_id: bundle, creates_new_application_instance: true });
  appPID = launched.pid;
  trace("launched");
  let window = launched.windows?.find((item: Record<string, unknown>) => item.window_id);
  for (let attempt = 0; appPID && !window && attempt < 5; attempt += 1) {
    await sleep(500);
    window = (await cua("list_windows", { pid: appPID })).windows?.find((item: Record<string, unknown>) => item.window_id && item.on_current_space);
  }
  if (!appPID || !window) throw new Error(`no exact app window: ${JSON.stringify(launched)}`);
  if (launched.self_activation_suppressed === false) throw new Error("app stole foreground; run invalid");
  target = { pid: appPID, window_id: window.window_id };
  await sleep(6000);
  const seeded = await snapshot("seeded");
  trace("seeded", { window_id: target.window_id, bounds: seeded.window_bounds });
  if (launchProbe && (!(seeded.window_bounds?.width >= 1100) || !seeded.elements?.some((item: { label?: string }) => item.label === "Search threads"))) {
    throw new Error("launch probe requires a wide window with visible sidebar");
  }
  const load = await command("uptime", []);
  const started = performance.now();
  let finished = false;
  let turnError: unknown;
  // Observe rejection immediately, including when cleanup closes an unfinished turn.
  const ended = waitForTurn(thread).then(() => { finished = true; }, error => { turnError = error; });
  trace("prompt.submit.begin", { thread });
  await device.call("prompt.submit", { session_id: thread, text: "bench", profile: "fake" });
  trace("prompt.submit.ack");
  if (launchProbe) {
    await sleep(5000);
    await snapshot("launch-probe");
    trace("five-second-window-alive");
    const result = { launchProbe: true, label, turns, round, pid: appPID, window_id: target.window_id, source };
    writeFileSync(join(run, "launch-probe.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } else {
    await sleep(3000);
    await snapshot("streaming");
    let mark = rows().length;
    const cpu0 = await cpuSeconds();
    const time0 = performance.now();
    await sleep(12000);
    const cpu = 100 * ((await cpuSeconds()) - cpu0) / ((performance.now() - time0) / 1000);
    await sleep(1200);
    const streaming = frames(mark);
    mark = rows().length;
    const streamScrolls = await scrollFor(12);
    await sleep(1200);
    const streamingScrolling = frames(mark);
    if (finished) throw new Error("reply ended before streaming measurements finished");
    await ended;
    if (turnError) throw turnError;
    const streamSeconds = (performance.now() - started) / 1000;
    await sleep(2000);
    mark = rows().length;
    const restScrolls = await scrollFor(12);
    await sleep(1200);
    const restScrolling = frames(mark);
    await snapshot("rest");
    const result = {
      label, turns, round, cpu, streaming, streamingScrolling, restScrolling,
      streamSeconds, streamScrolls, restScrolls, load,
      source, overlay: "5 Hz cumulative stdout, 1 Hz turn usage, initial/final todo", valid: cpu >= 15,
    };
    writeFileSync(join(run, "result.json"), JSON.stringify(result, null, 2));
    appendFileSync(join(out, "results.jsonl"), JSON.stringify(result) + "\n");
    console.log(JSON.stringify(result));
  }
} catch (error) {
  trace("failure", { error: String(error) });
  throw error;
} finally {
  await cleanup();
}
