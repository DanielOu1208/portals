import { execFile, type ChildProcess } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync, readSync, renameSync, writeSync, type Stats } from "node:fs";
import { basename, dirname } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { log, tallyLog } from "./log.ts";

// What the bridge costs, counted: calls, bytes, file writes, loads,
// memory, CPU. Off unless config.json says `"counters": { "enabled": true }`. On, one
// line of JSON a minute is appended to `counters.log` in the bridge's folder, which is
// rotated once at a size cap.
//
// Counts, sizes and timings only. Nothing here takes a title, a prompt, a reply, a path
// or a name, except to turn it into one of a fixed set of words first (`fileWord`,
// `agentWord`), and what is written is checked once more: `clean` keeps
// only plain keys with finite numbers under them.
//
// Every place that counts is `if (counters.on) counters.…(…)`, so off costs a branch.
// A bridge started with the switch off has nothing else of this: no timer, no file.
//
// Nothing here may stop the bridge, or keep it from stopping, whatever goes wrong: the
// LaunchAgent starts a stopped bridge again for ever. So starting, stopping, the tick
// and every counting function are each one `try`, and there is no `async` function and
// no promise in this file: a rejected promise nobody catches ends the process.

/** A table's rows: numbers by field. */
type Row = Record<string, number>;

export type ConnectionKind = "app" | "link" | "local";
export type FrameKind = "ready" | "answers" | "events" | "asks";
export type HttpRoute = "login" | "ticket" | "status" | "push" | "other";
export type SpawnKind = "claude" | "claude_cli" | "codex" | "pi" | "cursor" | "hermes" | "opencode" | "ps";
export type FleetRejection = "schema" | "position" | "digest" | "page";

export interface CountersOptions {
  /** config.json: the switch is read from it at the start and at every tick. */
  config: string;
  /** Where the lines go. */
  file: string;
  /** What is read at each tick for the line's `now`: how many of each thing there are. */
  gauges?: () => Record<string, number>;
  /** Seconds between lines, for tests and the harness; 60 otherwise. */
  seconds?: number;
  /** The size the file is rotated at, for tests; 5 MB otherwise. */
  capBytes?: number;
  /** The `ps` to run, for tests. */
  ps?: string;
  /** Milliseconds since 1970, for tests that move the clock. */
  clock?: () => number;
}

const megabyte = 1024 * 1024;
const defaultCapBytes = 5 * megabyte;
const defaultSeconds = 60;
/** The shortest tick taken: a test's. Node turns an interval that is not a number into 1 ms. */
const shortestSeconds = 0.02;
/** The longest a timer can be, about 24.8 days: Node turns a longer interval into 1 ms as well. */
const longestMs = 2 ** 31 - 1;
/** The event-loop monitor's period: one wake-up a second, and its values include it. */
const loopPeriodMs = 1000;
/** A `ps` is started at most this often, however short the tick. */
const psEveryMs = 10_000;
/** No table has more rows than this, `other` among them: a key that would be one more counts as `other`. */
const mostRows = 64;
/** A linked Mac past this place in links.json counts as `other`. */
const mostLinks = 16;
/** What a key in the file may look like. */
const keyPattern = /^[a-z0-9_.]{1,40}$/;

/** What config.json says of the counters: `unread` when it cannot be read just now, `bad` for a value that cannot be used. */
type Switch = "on" | "off" | "bad" | "unread";

/**
 * A `counters` value from config.json: true or false, or undefined when it is not one
 * that can be used (a string, a list, `enabled: "yes"`). Absent is false.
 */
export function countersSwitch(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return false;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const enabled = (value as { enabled?: unknown }).enabled;
  if (enabled === undefined) return false;
  return typeof enabled === "boolean" ? enabled : undefined;
}

/**
 * Opens `path` when it is a plain file, and only then. Anything else could hold the
 * bridge for good: opening a named pipe with nobody at its other end waits until
 * somebody is, and a bridge waiting there answers nobody and cannot be stopped.
 * O_NONBLOCK makes the open come back whatever is there, and it is what was opened that
 * is looked at, so nothing can take the file's place in between.
 */
function openPlain(path: string, flags: number, mode?: number): { fd: number; found: Stats } {
  const fd = openSync(path, flags | constants.O_NONBLOCK, mode);
  let found: Stats | undefined;
  try {
    found = fstatSync(fd);
  } finally {
    if (!found?.isFile()) closeSync(fd);
  }
  if (!found.isFile()) throw new Error("it is not a plain file");
  return { fd, found };
}

/** For the counters' file: appended to, made when it is not there, and its last byte read back. */
const appending = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT;
const newline = 0x0a;

/** The last byte of an open file of `size` bytes; a line's end when there is none to read. */
function lastByte(fd: number, size: number): number {
  const byte = Buffer.alloc(1);
  return readSync(fd, byte, 0, 1, size - 1) === 1 ? byte[0] : newline;
}

/** Writes all of `data`, or throws. */
function writeAll(fd: number, data: Buffer): void {
  let written = 0;
  while (written < data.length) {
    const more = writeSync(fd, data, written);
    // Never a loop that cannot end.
    if (more <= 0) throw new Error("nothing more could be written");
    written += more;
  }
}

/** The switch as the file has it now. Never throws, never waits, and never says what the file holds. */
function readSwitch(path: string): Switch {
  let raw: unknown;
  try {
    const { fd } = openPlain(path, constants.O_RDONLY);
    try {
      raw = JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    return "unread";
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "unread";
  const wanted = countersSwitch((raw as { counters?: unknown }).counters);
  return wanted === undefined ? "bad" : wanted ? "on" : "off";
}

/** A tick length that can be used, in milliseconds: the one given when a timer can be that short and that long, else a minute. */
function tickLength(seconds: unknown): number {
  const given = typeof seconds === "string" && seconds.trim() !== "" ? Number(seconds) : seconds;
  return typeof given === "number" && given >= shortestSeconds && given * 1000 <= longestMs ? given * 1000 : defaultSeconds * 1000;
}

const fileWords = new Map([
  ["threads.json", "threads"],
  ["removed.json", "removed"],
  ["push.json", "push"],
  ["folders.json", "folders"],
  ["links.json", "links"],
  ["config.json", "config"],
  ["setup.json", "setup"],
  ["hermes.json", "hermes"],
]);

/** Which state file a path is, as one of a few words. The path itself goes no further. */
function fileWord(path: string): string {
  return fileWords.get(basename(path)) ?? (basename(dirname(path)) === "fake" ? "fake" : "other");
}

const agentWords = new Map([
  ["ClaudeProvider", "claude"],
  ["CodexProvider", "codex"],
  ["HermesProvider", "hermes"],
  ["FakeProvider", "fake"],
  ["PiProvider", "pi"],
  ["CursorProvider", "cursor"],
]);

/** An agent's kind, from its class: a profile's name is the user's to choose (Hermes), so it is never used. */
function agentWord(provider: unknown): string {
  const name: unknown = (provider as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name;
  return (typeof name === "string" ? agentWords.get(name) : undefined) ?? "other";
}

function add(row: Row, field: string, amount = 1): void {
  row[field] = (row[field] ?? 0) + amount;
}

function most(row: Row, field: string, value: number): void {
  if (value > (row[field] ?? 0)) row[field] = value;
}

/**
 * What goes into the file, from what was counted: only keys of lower-case letters,
 * digits, dots and underscores, and finite numbers under them, to one decimal. A number
 * that is 0 and a section with nothing in it are left out.
 */
function clean(value: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keyPattern.test(key)) continue;
    if (typeof item === "number") {
      const rounded = Number.isFinite(item) ? Math.round(item * 10) / 10 : 0;
      if (rounded !== 0) kept[key] = rounded;
    } else if (typeof item === "object" && item !== null && !Array.isArray(item) && depth < 2) {
      const inner = clean(item as Record<string, unknown>, depth + 1);
      if (Object.keys(inner).length > 0) kept[key] = inner;
    }
  }
  return kept;
}

/**
 * The processes that descend from `root` in a `ps -A -o pid=,ppid=,rss=` listing, and
 * their resident memory in megabytes (`ps` gives kilobytes). `except` is the `ps` itself.
 */
function descendants(listing: string, root: number, except: number | undefined): Row {
  const children = new Map<number, number[]>();
  const memory = new Map<number, number>();
  for (const line of listing.split("\n")) {
    const [pid, parent, kilobytes] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(parent) || pid === except) continue;
    memory.set(pid, Number.isFinite(kilobytes) ? kilobytes : 0);
    const siblings = children.get(parent);
    if (siblings) siblings.push(pid);
    else children.set(parent, [pid]);
  }
  const seen = new Set<number>();
  const queue = [...(children.get(root) ?? [])];
  let total = 0;
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += memory.get(pid) ?? 0;
    queue.push(...(children.get(pid) ?? []));
  }
  return { n: seen.size, rss: total / 1024 };
}

/** An error in a few words for the bridge's log: its code, else its own first words. Never what a file holds. */
function reason(error: unknown): string {
  const failure = error as { code?: unknown; name?: unknown; message?: unknown } | null | undefined;
  if (typeof failure?.code === "string") return failure.code;
  return `${typeof failure?.name === "string" ? failure.name : "Error"}: ${typeof failure?.message === "string" ? failure.message.slice(0, 200) : ""}`;
}

/** A line in the bridge's log. The log failing (its pipe closed) is not the counters' to pass on. */
function say(level: "info" | "warn", message: string, fields?: Record<string, unknown>): void {
  try {
    log[level](message, fields);
  } catch {
    // Nowhere to say it.
  }
}

const unusable = 'counters in config.json is not {"enabled": true} or {"enabled": false}, so the counters are off';

class Counters {
  /** Read at every place that counts: `if (counters.on) counters.…`. */
  on = false;

  /** By section, then by key: what was counted since the last line. A section of one row has the key "". */
  private readonly tables = new Map<string, Map<string, Row>>();
  /** Set while a bridge holds the counters, on or off. */
  private options: CountersOptions | null = null;
  private timer: NodeJS.Timeout | null = null;
  private monitor: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private monitoring = false;
  private ps: ChildProcess | null = null;
  private psAt = 0;
  /** What the last `ps` found; in the next line. */
  private kids: Row | null = null;
  private tickMs = defaultSeconds * 1000;
  private capBytes = defaultCapBytes;
  private startedAt = 0;
  private lineAt = 0;
  private cpu: NodeJS.CpuUsage = { user: 0, system: 0 };
  /** What the file said at the last tick that could read it. */
  private wanted: Switch = "off";
  /** Off after a fault of the counters' own, until the switch is turned off and on. */
  private faulted = false;
  private dropped = 0;
  /** The last write failed: said once, and said once more when a line is written again. */
  private failing = false;
  private lastTickMs = 0;

  // MARK: Starting and stopping

  /**
   * Starts the counters for a bridge when its config.json has them on. True when this
   * bridge now holds them and is the one to `stop` them; false when they are off, or
   * another bridge in this process holds them (tests), or they could not start. Never
   * throws.
   */
  start(options: CountersOptions): boolean {
    try {
      if (this.options) return false;
      const wanted = readSwitch(options.config);
      if (wanted === "bad") say("warn", unusable);
      if (wanted !== "on") return false;
      this.options = options;
      this.wanted = wanted;
      this.tickMs = tickLength(options.seconds ?? process.env.PORTALS_BRIDGE_COUNTERS_SECONDS);
      this.capBytes = typeof options.capBytes === "number" && options.capBytes > 0 ? options.capBytes : defaultCapBytes;
      this.startedAt = this.clock();
      this.faulted = false;
      this.dropped = 0;
      this.failing = false;
      this.lastTickMs = 0;
      this.kids = null;
      this.psAt = 0;
      this.turnOn();
      this.timer = setInterval(() => this.tick(), this.tickMs);
      // Never what keeps the process running.
      this.timer.unref();
      return true;
    } catch (error) {
      this.letGo();
      say("warn", "the counters could not start; the bridge runs without them", { error: reason(error) });
      return false;
    }
  }

  /** Stops them for good, with a last line for the part of the minute that passed. Never throws, and waits for nothing. */
  stop(): void {
    try {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (this.on) this.writeLine(false);
    } catch (error) {
      say("warn", "the counters' last line could not be made", { error: reason(error) });
    }
    this.letGo();
  }

  /** What is running, for tests. */
  state(): { on: boolean; ticking: boolean; monitoring: boolean; sampling: boolean; rows: number } {
    let rows = 0;
    for (const table of this.tables.values()) rows += table.size;
    return { on: this.on, ticking: this.timer !== null, monitoring: this.monitoring, sampling: this.ps !== null, rows };
  }

  /** Everything off and nothing held, step by step: one step failing does not keep the next from being taken. */
  private letGo(): void {
    try {
      if (this.timer) clearInterval(this.timer);
    } catch {
      // Gone already.
    }
    this.timer = null;
    this.turnOff();
    this.options = null;
  }

  private turnOn(): void {
    this.tables.clear();
    this.cpu = process.cpuUsage();
    this.lineAt = this.clock();
    this.monitor ??= monitorEventLoopDelay({ resolution: loopPeriodMs });
    this.monitor.reset();
    this.monitor.enable();
    this.monitoring = true;
    tallyLog(this.logged);
    this.on = true;
    this.sample();
    const every = this.tickMs === defaultSeconds * 1000 ? "a minute" : `every ${this.tickMs / 1000} s`;
    say("info", `counters on: a line ${every} in ${this.options?.file}`);
  }

  /** Nothing counted, sampled or spawned from here on. Never throws. */
  private turnOff(): void {
    this.on = false;
    try {
      tallyLog(null);
      this.tables.clear();
      this.monitoring = false;
      this.monitor?.disable();
      this.ps?.kill();
    } catch {
      // Off all the same.
    }
    this.ps = null;
  }

  /** A fault of the counters' own: they turn off, say so once, and the bridge runs on. */
  private fault(error: unknown): void {
    const first = !this.faulted;
    this.faulted = true;
    this.turnOff();
    if (first) say("warn", "the counters stopped after a fault of their own; the bridge runs on. Turn counters off and on again in config.json to start them again", { error: reason(error) });
  }

  private clock(): number {
    return this.options?.clock ? this.options.clock() : Date.now();
  }

  // MARK: The tick

  private tick(): void {
    const began = performance.now();
    try {
      const options = this.options;
      if (!options) return;
      const wanted = readSwitch(options.config);
      if (wanted === "unread") {
        // Being edited: as they were.
        if (this.on) this.writeLine();
      } else {
        const changed = wanted !== this.wanted;
        this.wanted = wanted;
        if (wanted !== "on") {
          if (this.on) {
            this.writeLine(false);
            this.turnOff();
            say("info", "counters off");
          }
          if (changed && wanted === "bad") say("warn", unusable);
          this.faulted = false;
        } else if (this.on) {
          this.writeLine();
        } else if (!this.faulted) {
          this.turnOn();
        }
      }
    } catch (error) {
      this.fault(error);
    }
    this.lastTickMs = performance.now() - began;
  }

  /** Makes the line for what was counted since the last one, clears the tables and appends it. */
  private writeLine(sampleAgain = true): void {
    const options = this.options;
    if (!options) return;
    const now = this.clock();
    const seconds = Math.max(now - this.lineAt, 0) / 1000;
    this.lineAt = now;
    // The Mac slept, or the process was held: the delay would be the length of that.
    const late = seconds * 1000 > this.tickMs * 1.5;

    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const proc: Row = {
      rss: memory.rss / megabyte,
      heap: memory.heapUsed / megabyte,
      ext: memory.external / megabyte,
      cpu_user: (cpu.user - this.cpu.user) / 1000,
      cpu_sys: (cpu.system - this.cpu.system) / 1000,
    };
    this.cpu = cpu;
    if (this.monitor) {
      if (!late) proc.loop_max = Math.max(this.monitor.max / 1e6 - loopPeriodMs, 0);
      this.monitor.reset();
    }

    const sections: Record<string, unknown> = { proc };
    if (this.kids) sections.kids = this.kids;
    if (options.gauges) sections.now = options.gauges();
    for (const [section, table] of this.tables) {
      const only = table.size === 1 ? table.get("") : undefined;
      sections[section] = only ?? Object.fromEntries(table);
    }
    // Whether or not the line can be written: nothing piles up.
    this.tables.clear();

    const round = (value: number) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : 0);
    const line = {
      v: 1,
      t: new Date().toISOString(),
      s: round(seconds),
      ...(late ? { late: 1 } : {}),
      up: round(Math.max(now - this.startedAt, 0) / 1000),
      ...(this.dropped > 0 ? { dropped: this.dropped } : {}),
      tick_ms: round(this.lastTickMs),
      ...clean(sections),
    };
    if (sampleAgain) this.sample();
    this.append(`${JSON.stringify(line)}\n`);
  }

  /**
   * Appends a line, rotating the file first when the line would take it past the cap. A
   * line that cannot be written is dropped: the file is not a plain file, cannot be
   * opened or written, the line is longer than a whole file may be, or somebody put a
   * file in the place of the one just rotated.
   */
  private append(text: string): void {
    const file = this.options?.file;
    if (!file) return;
    let fd: number | undefined;
    try {
      const line = Buffer.from(text);
      // Only with a test's cap: a line is a few kilobytes at its longest.
      if (line.length > this.capBytes) throw new Error("the line is longer than the file may be");
      let found: Stats;
      ({ fd, found } = openPlain(file, appending, 0o600));
      // The mode given at an open only applies to a file it makes; this one may be older.
      if ((found.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
      // Half a line at the end, from a write that failed part way, in this run or one
      // before it: this line starts on a line of its own.
      let ragged = found.size > 0 && lastByte(fd, found.size) !== newline;
      if (found.size > 0 && found.size + (ragged ? 1 : 0) + line.length > this.capBytes) {
        const full = fd;
        fd = undefined;
        closeSync(full);
        renameSync(file, `${file}.1`);
        // A new file, made by this open and by nothing else: one already in its place
        // was put there since the rename, and none of what was looked at above (its
        // mode, its size, its last byte) is known of it. Then this line is dropped, and
        // the next one finds that file as it would any other.
        ({ fd } = openPlain(file, appending | constants.O_EXCL, 0o600));
        ragged = false;
      }
      writeAll(fd, ragged ? Buffer.concat([Buffer.from("\n"), line]) : line);
      if (this.failing) say("info", "the counters' file is written again");
      this.failing = false;
      this.dropped = 0;
    } catch (error) {
      this.dropped += 1;
      if (!this.failing) say("warn", "a line of the counters could not be written; lines are dropped until one can", { error: reason(error) });
      this.failing = true;
    } finally {
      try {
        if (fd !== undefined) closeSync(fd);
      } catch {
        // Closed already.
      }
    }
  }

  /**
   * Starts a `ps` for the bridge's child processes and their memory, which the next
   * line carries: never two at once, and at most one in ten seconds. As the bridge's
   * other `ps` (providers/claude/options.ts): a time limit, a limit on its output, and
   * every failure is no answer. With its answer goes how long the answer took to come
   * (`ps_ms`): by the clock, from the `ps` having been started to the bridge taking its
   * answer, so a bridge that was busy just then makes it longer. It is not what the `ps`
   * cost: that is its own process's CPU time, which is in none of the bridge's figures
   * and which nothing here measures.
   */
  private sample(): void {
    const at = performance.now();
    if (this.ps || (this.psAt !== 0 && at - this.psAt < psEveryMs)) return;
    this.psAt = at;
    const child = execFile(this.options?.ps ?? "/bin/ps", ["-A", "-o", "pid=,ppid=,rss="], { timeout: 5000, maxBuffer: 4 * megabyte }, (error, stdout) => {
      try {
        if (this.ps === child) this.ps = null;
        this.kids = error || !this.on ? null : { ...descendants(stdout, process.pid, child.pid), ps_ms: performance.now() - running };
      } catch (failure) {
        this.fault(failure);
      }
    });
    // From here on it runs by itself; starting it was the tick's own time.
    const running = performance.now();
    this.ps = child;
  }

  // MARK: Counting

  private row(section: string, key = ""): Row {
    let table = this.tables.get(section);
    if (!table) {
      table = new Map();
      this.tables.set(section, table);
    }
    let row = table.get(key);
    if (!row) {
      // Bounded whatever the callers pass.
      if (table.size >= mostRows - 1 && key !== "other") return this.row(section, "other");
      row = {};
      table.set(key, row);
    }
    return row;
  }

  /** A connection was taken: through the HTTP server, or on the `portals` command's socket. */
  opened(from: "net" | "local"): void {
    if (!this.on) return;
    try {
      add(this.row("conn", "opened"), from);
    } catch (error) {
      this.fault(error);
    }
  }

  /** A connection closed, and what it turned out to be. */
  closed(kind: ConnectionKind): void {
    if (!this.on) return;
    try {
      add(this.row("conn", "closed"), kind);
    } catch (error) {
      this.fault(error);
    }
  }

  /** A frame was handed to a socket, with what the socket then had waiting. */
  sent(kind: FrameKind, bytes: number, buffered: number): void {
    if (!this.on) return;
    try {
      const row = this.row("out", kind);
      add(row, "n");
      add(row, "bytes", bytes);
      most(row, "buffered_max", buffered);
    } catch (error) {
      this.fault(error);
    }
  }

  /**
   * A gateway call was answered. `method` is one of the bridge's own, or "other": the
   * caller, which has the table of methods, says which. `waited` for a call that waits
   * for a thread on purpose, whose time is kept apart.
   */
  rpc(method: string, kind: ConnectionKind, ms: number, bytesIn: number, bytesOut: number, failed: boolean, waited: boolean): void {
    if (!this.on) return;
    try {
      const row = this.row("rpc", method);
      add(row, "n");
      if (waited) {
        add(row, "wait_ms", ms);
      } else {
        add(row, "ms", ms);
        most(row, "max", ms);
      }
      add(row, "in", bytesIn);
      add(row, "out", bytesOut);
      most(row, "out_max", bytesOut);
      if (failed) add(row, "err");
      const by = this.row("rpc_by", kind);
      add(by, "n");
      add(by, "in", bytesIn);
      add(by, "out", bytesOut);
    } catch (error) {
      this.fault(error);
    }
  }

  /** A session gave out an event, and how long handing it to its followers took. */
  emitted(ms: number): void {
    if (!this.on) return;
    try {
      const row = this.row("emit");
      add(row, "n");
      add(row, "ms", ms);
      most(row, "max", ms);
    } catch (error) {
      this.fault(error);
    }
  }

  /** A turn started or ended, however it began. */
  turn(what: "started" | "ended"): void {
    if (!this.on) return;
    try {
      add(this.row("turns"), what);
    } catch (error) {
      this.fault(error);
    }
  }

  /** A thread was put on the list or taken off it. */
  thread(what: "added" | "removed"): void {
    if (!this.on) return;
    try {
      add(this.row("threads"), what);
    } catch (error) {
      this.fault(error);
    }
  }

  /** A `threads.changes` answer, and how many threads it listed. */
  changes(kind: "empty" | "delta" | "full", threads: number): void {
    if (!this.on) return;
    try {
      const row = this.row("changes");
      add(row, kind);
      add(row, "threads", threads);
    } catch (error) {
      this.fault(error);
    }
  }

  /** A new fleet reply failed validation; fixed reasons only, never payload details. */
  fleetRejected(reason: FleetRejection): void {
    if (!this.on) return;
    try {
      add(this.row("fleet_rejected"), reason);
    } catch (error) {
      this.fault(error);
    }
  }

  /** Paging progress, fixed fields only; no peer or snapshot identifiers. */
  fleetPaging(event: "started" | "pages" | "rows" | "seals" | "resets" | "background" | "completed" | "expired", count = 1): void {
    if (!this.on) return;
    try {
      add(this.row("fleet_paging"), event, count);
    } catch (error) {
      this.fault(error);
    }
  }

  /** A state file was written whole. */
  wrote(path: string, bytes: number, ms: number): void {
    if (!this.on) return;
    try {
      const row = this.row("files", fileWord(path));
      add(row, "w");
      add(row, "w_bytes", bytes);
      add(row, "w_ms", ms);
      most(row, "w_max", ms);
    } catch (error) {
      this.fault(error);
    }
  }

  /** A state file was read whole. */
  read(path: string, bytes: number, ms: number): void {
    if (!this.on) return;
    try {
      const row = this.row("files", fileWord(path));
      add(row, "r");
      add(row, "r_bytes", bytes);
      add(row, "r_ms", ms);
    } catch (error) {
      this.fault(error);
    }
  }

  /** A session was loaded from the registry, by `provider`. */
  loaded(provider: unknown, ms: number): void {
    if (!this.on) return;
    try {
      const row = this.row("load", agentWord(provider));
      add(row, "n");
      add(row, "ms", ms);
      most(row, "max", ms);
    } catch (error) {
      this.fault(error);
    }
  }

  /** A call to the linked Mac at place `index` of links.json ended. `bytesOut` and `bytesIn` hold its sign-in and ticket too. */
  linked(index: number, ms: number, bytesOut: number, bytesIn: number, signins: number, failed: boolean, waited: boolean): void {
    if (!this.on) return;
    try {
      const row = this.row("links", Number.isInteger(index) && index >= 0 && index < mostLinks ? String(index) : "other");
      add(row, "n");
      if (waited) {
        add(row, "wait_ms", ms);
      } else {
        add(row, "ms", ms);
        most(row, "max", ms);
      }
      add(row, "out", bytesOut);
      add(row, "in", bytesIn);
      add(row, "signins", signins);
      if (failed) add(row, "err");
    } catch (error) {
      this.fault(error);
    }
  }

  /** An HTTP request was answered, with the bytes of its body and of the answer's. */
  http(route: HttpRoute, ms: number, bytesIn: number, bytesOut: number): void {
    if (!this.on) return;
    try {
      const row = this.row("http", route);
      add(row, "n");
      add(row, "ms", ms);
      add(row, "in", bytesIn);
      add(row, "out", bytesOut);
    } catch (error) {
      this.fault(error);
    }
  }

  /** The bridge started a process. */
  spawned(kind: SpawnKind): void {
    if (!this.on) return;
    try {
      add(this.row("spawn"), kind);
    } catch (error) {
      this.fault(error);
    }
  }

  /** Codex was asked where its threads ran: how many it listed, or that it failed. */
  codexFolders(rows: number, ms: number, failed: boolean): void {
    if (!this.on) return;
    try {
      const row = this.row("codex_folders");
      add(row, "n");
      add(row, "rows", rows);
      add(row, "ms", ms);
      if (failed) add(row, "err");
    } catch (error) {
      this.fault(error);
    }
  }

  /** Claude Code was asked for its models and commands, which starts a process. */
  claudeChecked(ms: number): void {
    if (!this.on) return;
    try {
      const row = this.row("claude_checks");
      add(row, "n");
      add(row, "ms", ms);
    } catch (error) {
      this.fault(error);
    }
  }

  /** A line went to the bridge's own log (log.ts is told to call this while the counters are on). */
  private readonly logged = (bytes: number): void => {
    if (!this.on) return;
    try {
      const row = this.row("log");
      add(row, "n");
      add(row, "bytes", bytes);
    } catch (error) {
      this.fault(error);
    }
  };
}

export const counters = new Counters();
