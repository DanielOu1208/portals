import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { counters } from "../counters.ts";
import { wellFormedJSON } from "../json.ts";
import { log } from "../log.ts";
import { redacted } from "../push/notifier.ts";

// An agent's program run as a child process that speaks one JSON value per line on its
// standard input and output, the way Pi's RPC mode and the Agent Client Protocol do.
// What the values mean is the caller's business: this file starts the process, cuts its
// output into lines, and ends it.
//
// A line ends with LF and nothing else (one CR before it is dropped). U+2028 and U+2029
// are legal inside a JSON string and agents print them, so `node:readline`, which cuts
// a line there too, is not used.
//
// The process heads a process group of its own, so that what it starts (a command's
// shell, an MCP server, itself again) ends with it. A stop closes its input, sends
// SIGTERM to the group, and two seconds later SIGKILL to whatever is left of the group.
// A process that ends by itself (a crash) has the rest of its group ended the same way.
//
// A child is one process. When that has ended, for whatever reason, the listener is
// told once, after the last line it printed, and the child is done: the caller makes
// another when the agent is next needed.

/** How a process ended, or why there never was one. */
export interface ChildExit {
  /** Its exit code; null when a signal ended it or it never started. */
  code: number | null;
  /** The signal that ended it. */
  signal: NodeJS.Signals | null;
  /** Why it could not be started; null when it was. */
  error: string | null;
  /** It was running when `stop` was called. */
  asked: boolean;
  /** The last line it wrote to standard error; often the real reason. */
  lastWords: string | null;
  /** The above in words: "Pi stopped (exit code 1): No API key found". */
  reason: string;
}

export interface ChildListener {
  /** One line of its output, as the JSON value it is. */
  message(value: unknown): void;
  /** A line of its output that is not JSON. It is in the debug log either way. */
  notJSON?(line: string): void;
  /** The process has ended, or could not be started. Called once, after its last line. */
  exited(exit: ChildExit): void;
}

export interface ChildOptions {
  /** What to call the program in messages and in the log: "Pi". */
  name: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** The folder the process runs in. */
  cwd: string;
  listener: ChildListener;
}

/** How long the group has to end after SIGTERM before it is killed. */
const stopGraceMs = 2000;
/** How often a stop looks whether the group has gone. */
const stopPollMs = 20;
/**
 * How long the last of its output is waited for once the process has ended: something
 * it started may hold that output open for as long as it runs.
 */
const lastOutputMs = 1000;
/** How much of one line of standard error is logged, and how much is kept as its last words. */
const stderrLogged = 500;
const lastWordsKept = 300;

export class JsonChild {
  private readonly options: ChildOptions;
  private readonly child: ChildProcess | null = null;
  private exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private lastWords: string | null = null;
  private asked = false;
  private stopping: Promise<void> | null = null;
  /** The end of what a process that ended by itself left of its group. */
  private rest: Promise<void> = Promise.resolve();
  /** The listener has been told the process is gone. */
  private told = false;
  private readonly gone = Promise.withResolvers<void>();

  /** Starts the process. A failure to start is told to the listener like any other end. */
  constructor(options: ChildOptions) {
    this.options = options;
    const { name, command, args, env, cwd } = options;
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (error) {
      // Not before the caller has the child in hand.
      setImmediate(() => this.finish((error as Error).message));
      return;
    }
    this.child = child;
    child.on("error", (error) => {
      // Without a process id it never started. With one, only a signal could not be
      // sent: the process is still there, and its exit says the rest.
      if (child.pid === undefined) this.finish(error.message);
      else log.debug(`${name}: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      this.exit = { code, signal };
      // It ended by itself: what it started is not left running. (A stop is already at that.)
      if (!this.asked && child.pid !== undefined) this.rest = endGroup(child.pid);
      // Its last lines may still be on their way ("close" follows them).
      setTimeout(() => this.finish(), lastOutputMs).unref();
    });
    child.once("close", () => this.finish());
    // A write to a process that has just gone, or a read from one, is not worth a crash:
    // its exit says it.
    for (const stream of [child.stdin!, child.stdout!, child.stderr!]) stream.on("error", () => undefined);
    eachLine(child.stdout!, (line) => this.receive(line));
    eachLine(child.stderr!, (raw) => {
      const line = redacted(raw);
      if (line.trim() === "") return;
      this.lastWords = line.trim().slice(0, lastWordsKept);
      log.debug(`${name} standard error`, { line: line.slice(0, stderrLogged) });
    });
  }

  /** The process's id; undefined when it could not be started. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** The process is there and was not asked to stop. */
  get running(): boolean {
    return this.alive && this.stopping === null;
  }

  /** Sends one value as a line. False when there is no process to take it. */
  send(value: unknown): boolean {
    const stdin = this.child?.stdin;
    if (!this.alive || !stdin?.writable) return false;
    stdin.write(wellFormedJSON(value) + "\n");
    return true;
  }

  /** Ends the process and whatever it started. Resolves once they are gone and the listener was told. */
  stop(): Promise<void> {
    this.stopping ??= this.end();
    return this.stopping;
  }

  private get alive(): boolean {
    return this.child?.pid !== undefined && this.exit === null;
  }

  private async end(): Promise<void> {
    const child = this.child;
    // One that has ended by itself is not signalled: its id may be another's by now. What
    // it left of its group was signalled as it ended (`rest`).
    if (child?.pid !== undefined && this.exit === null) {
      this.asked = true;
      child.stdin?.end();
      this.signal(child, "SIGTERM");
      // The process may go at once and leave behind something it started that does not:
      // the stop is over when the whole group is gone.
      const deadline = Date.now() + stopGraceMs;
      while (groupAlive(child.pid)) {
        if (Date.now() >= deadline) {
          this.signal(child, "SIGKILL");
          break;
        }
        await sleep(stopPollMs);
      }
    }
    await this.rest;
    await this.gone.promise;
  }

  /** To the process's whole group, else to the process. */
  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      child.kill(signal);
    }
  }

  private receive(line: string): void {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      log.debug(`${this.options.name} printed a line that is not JSON`, { line: line.slice(0, 200) });
      this.options.listener.notJSON?.(line);
      return;
    }
    this.options.listener.message(value);
  }

  /** The process is gone (`failure`: it never started). Tells the listener, once. */
  private finish(failure: string | null = null): void {
    if (this.told) return;
    this.told = true;
    // Nothing it started may say more in its name, or keep the bridge's end of its output open.
    this.child?.stdout?.destroy();
    this.child?.stderr?.destroy();
    const { name, command, cwd } = this.options;
    const code = this.exit?.code ?? null;
    const signal = this.exit?.signal ?? null;
    // Its last words say why, as far as anything does; not after a stop that was asked for.
    const said = this.asked ? null : this.lastWords;
    const reason =
      failure !== null ? `${name} could not be started (${failure})` : `${name} stopped (${signal ?? `exit code ${code}`})${said ? `: ${said}` : ""}`;
    log.debug(reason, { command, cwd });
    this.options.listener.exited({ code, signal, error: failure, asked: this.asked, lastWords: this.lastWords, reason });
    this.gone.resolve();
  }
}

/** Who a process is: its number and when it started, which together are never another's, and its group. */
export interface ProcessIdentity { pid: number; start: string; group: number }

/** The process `pid` as the system says it now; null for none, a zombie, or one that cannot be read. */
export function processOf(pid: number, timeout = 5000): ProcessIdentity | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return null;
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return { pid, group: Number(fields[2]), start: `proc:${boot}:${fields[19]}` };
    }
    if (counters.on) counters.spawned("ps");
    const output = execFileSync("/bin/ps", ["-o", "stat=,pgid=,lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    const match = /^\s*(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(output);
    return match && !match[1].startsWith("Z") ? { pid, group: Number(match[2]), start: `ps-utc:${match[3]}` } : null;
  } catch { return null; }
}

/** Whether any process of the group `pid` heads is left. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signals the group `pid` heads. False when none of it is left. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ends the process group `pid` heads, or what is left of it once that process has gone:
 * SIGTERM, and SIGKILL two seconds later to whatever is still there. Resolves when
 * nothing is. Only the group is signalled, never the id itself, which may be another
 * process's once its own has ended; while one of the group is left, the id is no other
 * group's.
 */
export async function endGroup(pid: number): Promise<void> {
  if (!signalGroup(pid, "SIGTERM")) return;
  const deadline = Date.now() + stopGraceMs;
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) {
      signalGroup(pid, "SIGKILL");
      return;
    }
    await sleep(stopPollMs);
  }
}

/**
 * Calls `take` with each line of `stream`: what comes before an LF, without one CR at
 * its end. What follows the last LF is a line too once the stream ends.
 */
function eachLine(stream: Readable, take: (line: string) => void): void {
  let rest = "";
  const whole = (line: string) => take(line.endsWith("\r") ? line.slice(0, -1) : line);
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    let from = 0;
    for (let at = chunk.indexOf("\n"); at >= 0; at = chunk.indexOf("\n", from)) {
      whole(rest + chunk.slice(from, at));
      rest = "";
      from = at + 1;
    }
    rest += chunk.slice(from);
  });
  stream.on("end", () => {
    if (rest !== "") whole(rest);
    rest = "";
  });
}
