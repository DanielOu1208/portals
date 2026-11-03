import "./environment.ts";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiProvider, type PiProviderOptions, type PiSettings } from "../src/providers/pi/provider.ts";

// The stand-in for Pi (test/pi-agent.ts) as a program a test gives for `pi.path`: a
// small script that runs it, beside a folder that stands for `~/.pi/agent`, where the
// stand-in keeps its sessions, logs what it is sent and waits at its gates. No test
// starts the installed `pi`.

/** One line of the stand-in's log. */
export interface Logged {
  pid: number;
  /** `start`: a process and what it was started with; `got`: a line it was sent; `exit`: it left by itself. */
  kind: "start" | "got" | "exit";
  args?: string[];
  cwd?: string;
  env?: { PATH?: string; PORTALS_THREAD?: string };
  record?: any;
  code?: number;
}

export interface Standin {
  /** The program to run as `pi`. */
  path: string;
  /** The folder that stands for `~/.pi/agent`. */
  agentDir: string;
  /** The environment that points Pi, and the bridge's reading of its sessions, at that folder. */
  env: NodeJS.ProcessEnv;
  /** Everything every process was started with and sent, in order. */
  log(): Logged[];
  /** What the processes were sent from line `from` of the log on: every record, or those of one type. */
  got(type?: string, from?: number): any[];
  /** The processes started, each with its arguments and environment; with `thread`, those of that thread. */
  starts(thread?: string): Logged[];
  /** What the processes of one thread were sent, in order: every record, or those of one type. */
  sentTo(thread: string, type?: string): any[];
  /** The stand-in's processes that still run. */
  alive(): number[];
  /** Opens a gate a run, a compaction or a start waits at. */
  release(gate: string): void;
  /** Makes every thread's process answer nothing until `gate` opens; null lets them answer again. */
  holdStarts(gate: string | null): void;
  /** Makes a Pi with no session fail as it starts, or start again. */
  breakCatalog(broken: boolean): void;
  /** Takes the program away, as a `pi` that was uninstalled, or puts it back. */
  install(there: boolean): void;
  /** The release `--version` says it is; null for 1.1.0 again. */
  version(release: string | null): void;
  /** The stand-in's own settings, which a process reads as it starts (test/pi-agent.ts, `Settings`). */
  configure(settings: Record<string, unknown>): void;
  /** Every session file the stand-in keeps for a session id. */
  sessionFiles(id: string): string[];
  /** Stops what still runs and deletes the folders. */
  dispose(): void;
}

const agent = fileURLToPath(new URL("./pi-agent.ts", import.meta.url));

/** Every file under `folder`, by its whole path. */
function filesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(folder, entry.name)) : [join(folder, entry.name)]));
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function standin(settings?: Record<string, unknown>): Standin {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "portals-pi-standin-")));
  const agentDir = join(root, "agent");
  const path = join(root, "bin", "pi");
  mkdirSync(join(agentDir, "release"), { recursive: true });
  mkdirSync(join(root, "bin"));
  // The node that runs the tests, whatever PATH says.
  const script = `#!/bin/sh\nexec "${process.execPath}" "${agent}" "$@"\n`;
  writeFileSync(path, script, { mode: 0o755 });
  if (settings) writeFileSync(join(agentDir, "standin.json"), JSON.stringify(settings));

  const log = (): Logged[] => {
    const file = join(agentDir, "standin.log");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Logged);
  };
  const starts = (thread?: string) => log().filter((line) => line.kind === "start" && (thread === undefined || line.args?.includes(thread) === true));
  const alive = () => [...new Set(log().filter((line) => line.kind === "start").map((line) => line.pid))].filter(running);
  const flag = (name: string, content: string | null) => {
    if (content === null) rmSync(join(agentDir, name), { force: true });
    else writeFileSync(join(agentDir, name), content);
  };
  return {
    path,
    agentDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    log,
    got: (type, from = 0) =>
      log()
        .slice(from)
        .filter((line) => line.kind === "got" && (type === undefined || line.record?.type === type))
        .map((line) => line.record),
    starts,
    sentTo: (thread, type) => {
      const pids = new Set(starts(thread).map((line) => line.pid));
      return log()
        .filter((line) => line.kind === "got" && pids.has(line.pid) && (type === undefined || line.record?.type === type))
        .map((line) => line.record);
    },
    alive,
    release: (gate) => writeFileSync(join(agentDir, "release", gate), ""),
    holdStarts: (gate) => flag("hold-start", gate),
    breakCatalog: (broken) => flag("broken", broken ? "broken" : null),
    install: (there) => {
      if (there) writeFileSync(path, script, { mode: 0o755 });
      else rmSync(path, { force: true });
    },
    version: (release) => flag("version", release),
    configure: (value) => writeFileSync(join(agentDir, "standin.json"), JSON.stringify(value)),
    sessionFiles: (id) => {
      const sessions = join(agentDir, "sessions");
      if (!existsSync(sessions)) return [];
      return filesUnder(sessions).filter((file) => file.endsWith(`_${id}.jsonl`));
    },
    dispose: () => {
      for (const pid of alive()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone already, as it should be.
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A Pi provider that runs the stand-in, with no version check unless asked for, and
 * with no Pi in any terminal unless a test says where (the Mac the tests run on is
 * never asked). `folder` is where its short-lived Pi runs.
 */
export function piProvider(pi: Standin, options: { settings?: Partial<PiSettings>; folder?: string } & Omit<PiProviderOptions, "settings" | "env"> = {}): PiProvider {
  const { settings, folder, ...rest } = options;
  return new PiProvider({
    // No names made unless a test asks for them: one would come in the middle of what a turn is shown to say.
    settings: { path: pi.path, idleMinutes: 15, maxWarm: 6, folder: folder ?? tmpdir(), titleModel: null, ...settings },
    env: pi.env,
    checkVersion: false,
    terminals: async () => ({ folders: [], unread: [] }),
    ...rest,
  });
}

/** Waits until `check` holds. */
export async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
