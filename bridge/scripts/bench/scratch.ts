import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { pathsFor } from "../../src/config.ts";
import { hashPassword } from "../../src/http/auth.ts";
import { Lines } from "./lines.ts";

// Where the harness runs its bridges: one new folder, the scratch root, with a folder
// in it for each bridge. A bridge is a process of its own (`node src/main.ts`), so its
// CPU and memory are its own and not mixed with the harness's clients, on port 0, with
// the scripted agent only and no relay.
//
// Nothing here can reach an installed bridge: a bridge is started, and the `portals`
// command run, only with `PORTALS_BRIDGE_HOME` set to a folder inside the scratch root,
// and anything else is refused. Every bridge is stopped by its pid and checked gone,
// also when a scenario fails or the harness is interrupted.

const main = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const probe = new URL("./probe.ts", import.meta.url).href;

/** The sign-in every harness bridge takes. */
export interface Account {
  username: string;
  password: string;
}

export interface BridgeSetup {
  /** A folder inside the scratch root (`Scratch.home`). */
  home: string;
  /** `counters.enabled` in its config.json. */
  counters: boolean;
  /** Seconds between the counters' lines; left out, the bridge's own minute. */
  tick?: number;
  /** More for its config.json (the scripted agent's pace). The port, the agents, the relay, General and the counters are the harness's own, whatever is given here. */
  config?: Record<string, unknown>;
}

/** The bridge process's own CPU time and memory at one moment. */
export interface Sample {
  /** CPU milliseconds used since it started, user and system. */
  cpuMs: number;
  /** Resident memory and heap in use, in megabytes. */
  rss: number;
  heap: number;
}

export interface BenchBridge {
  readonly home: string;
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  readonly pid: number;
  readonly account: Account;
  /** Its counters' lines; null when its counters are off. */
  readonly lines: Lines | null;
  sample(): Promise<Sample>;
  /** Stops it by its pid and checks that it and every process it started are gone. */
  stop(): Promise<void>;
}

/** What one run of a command took, as `/usr/bin/time -l` reports it. */
export interface CommandRun {
  code: number;
  stdout: string;
  stderr: string;
  wallMs: number;
  /** User and system CPU, to a hundredth of a second. */
  cpuMs: number;
  /** The most memory it held, in megabytes. */
  peak: number;
}

export interface ScratchOptions {
  /** A folder to make the scratch root in; the system's temporary folder when left out. */
  parent?: string;
  /** A path each running bridge's pid is written beside, as `<notes><n>`, and removed from when it is gone. */
  notes?: string;
  /** How often a bridge's counters file is looked at, in milliseconds. */
  pollMs?: number;
}

export class Scratch {
  /** The folder everything of this run is in, as its real path. */
  readonly root: string;
  readonly account: Account = { username: "bench", password: randomBytes(12).toString("hex") };
  /** The pid of every bridge started, stopped or not. */
  readonly started: number[] = [];
  private readonly options: ScratchOptions;
  private readonly running = new Set<BenchBridge>();
  private readonly children = new Set<ChildProcess>();
  private passwordHash: Promise<string> | undefined;

  constructor(options: ScratchOptions = {}) {
    this.options = options;
    const parent = options.parent ?? tmpdir();
    mkdirSync(parent, { recursive: true });
    this.root = realpathSync(mkdtempSync(join(parent, "portals-bench-")));
  }

  /** A folder of that name inside the scratch root, made when it is not there. */
  folder(name: string): string {
    const path = join(this.root, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  /** Whether `path` is inside the scratch root, by its real path. */
  owns(path: string): boolean {
    let real = resolve(path);
    // The part of it that exists is read through its links; the rest cannot be one.
    for (let existing = real; existing !== dirname(existing); existing = dirname(existing)) {
      if (!existsSync(existing)) continue;
      real = join(realpathSync(existing), real.slice(existing.length));
      break;
    }
    return real.startsWith(this.root + sep);
  }

  /** Starts a bridge in `setup.home`, which must be inside the scratch root, and waits until it listens. */
  async startBridge(setup: BridgeSetup): Promise<BenchBridge> {
    const home = this.mine(setup.home);
    mkdirSync(home, { recursive: true });
    this.passwordHash ??= hashPassword(this.account.password);
    const paths = pathsFor(home);
    // The scripted agent only, no relay and no check for a later version: nothing is run
    // and nothing leaves this Mac.
    // General is a folder of the scratch root: the default would make ~/Portals. These
    // come after what a scenario asks for, so no scenario can ask for anything else.
    const config = {
      ...setup.config,
      port: 0,
      auth: { username: this.account.username, passwordHash: await this.passwordHash },
      generalFolder: this.folder("general"),
      providers: { claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, fake: true },
      // A file in place of the relay: without either the bridge makes no notifier, and
      // an installed bridge has one.
      push: { relay: null, dryRun: join(home, "notifications.jsonl") },
      relay: { enabled: false },
      updates: { check: false },
      counters: { enabled: setup.counters },
    };
    writeFileSync(paths.config, JSON.stringify(config, null, 1), { mode: 0o600 });

    const env: NodeJS.ProcessEnv = { ...process.env, PORTALS_BRIDGE_HOME: home, PORTALS_BRIDGE_LOG: "info" };
    for (const key of ["AERIPORTAL_BRIDGE_HOME", "AERIPORTAL_BRIDGE_LOG", "PORTALS_THREAD", "PORTALS_BRIDGE_COUNTERS_SECONDS", "NODE_TEST_CONTEXT"]) delete env[key];
    if (setup.tick !== undefined) env.PORTALS_BRIDGE_COUNTERS_SECONDS = String(setup.tick);
    // Its log goes to a file, as an installed bridge's does.
    const logPath = join(home, "bridge.log");
    const log = openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, ["--import", probe, main], { env, stdio: ["ignore", "ignore", log, "ipc"] });
    } finally {
      closeSync(log);
    }
    this.children.add(child);
    // A process that could not be started says so here too; the missing pid below is what is acted on.
    child.on("error", () => undefined);
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    void exited.then(() => this.children.delete(child));
    if (child.pid === undefined) throw new Error("the bridge's process could not be started");
    const pid = child.pid;
    this.started.push(pid);
    const note = this.options.notes ? `${this.options.notes}${this.started.length}` : undefined;
    if (note) writeFileSync(note, `${pid}\n`);

    let asked = 0;
    const waiting = new Map<number, (sample: Sample) => void>();
    child.on("message", (message: { answer?: number; cpu?: NodeJS.CpuUsage; memory?: NodeJS.MemoryUsage }) => {
      if (typeof message?.answer !== "number" || !message.cpu || !message.memory) return;
      waiting.get(message.answer)?.({
        cpuMs: (message.cpu.user + message.cpu.system) / 1000,
        rss: message.memory.rss / 1024 / 1024,
        heap: message.memory.heapUsed / 1024 / 1024,
      });
      waiting.delete(message.answer);
    });

    let stopping: Promise<void> | undefined;
    const bridge: BenchBridge = {
      home,
      url: "",
      pid,
      account: this.account,
      lines: setup.counters ? new Lines(paths.counters, this.options.pollMs) : null,
      sample: () =>
        new Promise<Sample>((done, failed) => {
          const id = ++asked;
          const timer = setTimeout(() => failed(new Error(`the bridge (pid ${pid}) did not answer the harness`)), 10_000);
          waiting.set(id, (sample) => {
            clearTimeout(timer);
            done(sample);
          });
          child.send({ ask: id }, (error) => {
            if (!error) return;
            clearTimeout(timer);
            failed(error);
          });
        }),
      stop: () => {
        stopping ??= (async () => {
          const kids = await descendants(pid);
          child.kill("SIGTERM");
          if (!(await within(exited, 5000))) {
            child.kill("SIGKILL");
            await exited;
          }
          const left = await stillRunning([pid, ...kids]);
          this.running.delete(bridge);
          if (left.length > 0) throw new Error(`the bridge (pid ${pid}) left processes running: ${left.join(", ")}`);
          if (note) rmSync(note, { force: true });
        })();
        return stopping;
      },
    };
    this.running.add(bridge);

    // The port is the system's choice: read from the line the bridge logs once it listens.
    const ends = Date.now() + 30_000;
    for (;;) {
      const listening = / listening on (http:\/\/\S+)/.exec(readFileSync(logPath, "utf8"));
      if (listening) {
        (bridge as { url: string }).url = listening[1];
        return bridge;
      }
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > ends) {
        await bridge.stop().catch(() => undefined);
        throw new Error(`the bridge in ${home} did not start:\n${readFileSync(logPath, "utf8").split("\n").slice(-8).join("\n")}`);
      }
      await sleep(10);
    }
  }

  /** Runs the `portals` command of the bridge in `home`, as the launcher the bridge wrote there. */
  async portals(home: string, args: string[]): Promise<CommandRun> {
    const folder = this.mine(home);
    const env: NodeJS.ProcessEnv = { ...process.env, PORTALS_BRIDGE_HOME: folder };
    for (const key of ["AERIPORTAL_BRIDGE_HOME", "PORTALS_THREAD", "NODE_TEST_CONTEXT"]) delete env[key];
    const started = performance.now();
    // macOS's `time -l`; GNU time told to print the same lines, its memory in KB; on a
    // Linux machine without it, the command alone, timed by the clock only.
    const command = pathsFor(folder).command;
    const mac = process.platform === "darwin";
    const kilobytes = !mac && existsSync("/usr/bin/time");
    const program = mac || kilobytes ? "/usr/bin/time" : command;
    const timed = mac ? ["-l", command, ...args] : kilobytes ? ["-f", "%e real %U user %S sys\n%M maximum resident set size", command, ...args] : args;
    return new Promise((done) => {
      execFile(program, timed, { env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        // `time` writes its own lines after the command's: seconds, then the most memory in bytes.
        const times = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(stderr);
        const peak = /(\d+)\s+maximum resident set size/.exec(stderr);
        done({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr: times ? stderr.slice(0, times.index).trimEnd() : stderr,
          wallMs: performance.now() - started,
          cpuMs: times ? (Number(times[2]) + Number(times[3])) * 1000 : 0,
          peak: peak ? (Number(peak[1]) * (kilobytes ? 1024 : 1)) / 1024 / 1024 : 0,
        });
      });
    });
  }

  /** Stops every bridge still running and removes the scratch root. Throws when a bridge left a process behind. */
  async dispose(): Promise<void> {
    const failures: Error[] = [];
    for (const bridge of [...this.running]) {
      await bridge.stop().catch((error: Error) => failures.push(error));
    }
    rmSync(this.root, { recursive: true, force: true });
    if (failures.length > 0) throw failures[0];
  }

  /** For the moment the harness itself is ending with no time to wait: every bridge is killed at once. */
  killAll(): void {
    for (const child of this.children) child.kill("SIGKILL");
  }

  /** `path` as given, or an error: the harness touches no folder outside its scratch root. */
  private mine(path: string): string {
    if (!this.owns(path)) throw new Error(`refused: ${path} is not inside the harness's scratch folder ${this.root}`);
    return resolve(path);
  }
}

/** Whether `promise` settles within `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((done) => {
    timer = setTimeout(() => done(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The processes that descend from `root` now. */
function descendants(root: number): Promise<number[]> {
  return new Promise((done) => {
    execFile("/bin/ps", ["-A", "-o", "pid=,ppid="], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) return done([]);
      const children = new Map<number, number[]>();
      for (const line of stdout.split("\n")) {
        const [pid, parent] = line.trim().split(/\s+/).map(Number);
        if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
        children.set(parent, [...(children.get(parent) ?? []), pid]);
      }
      const found: number[] = [];
      const queue = [...(children.get(root) ?? [])];
      while (queue.length > 0) {
        const pid = queue.pop()!;
        if (found.includes(pid)) continue;
        found.push(pid);
        queue.push(...(children.get(pid) ?? []));
      }
      done(found);
    });
  });
}

/** Those of `pids` that are still there two seconds on. */
async function stillRunning(pids: number[]): Promise<number[]> {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const ends = Date.now() + 2000;
  let left = pids.filter(alive);
  while (left.length > 0 && Date.now() < ends) {
    await sleep(20);
    left = left.filter(alive);
  }
  return left;
}
