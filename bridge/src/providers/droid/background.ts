import { basename, isAbsolute } from "node:path";
import { BackgroundCommands } from "../backgroundCommands.ts";
import type { ProviderEvent, SubagentStatus } from "../types.ts";

// The commands Droid runs in the background, as its own footer lists them (CLI 1.0's
// "remote background processes"): each a row of the subagents line (feature
// background_commands), with its output read from the file Droid writes it to, and a Stop
// that asks Droid to end that one (`droid.kill_background_process`). Droid lists them
// whole each time one starts or ends (`background_processes_changed`, which the SDK does
// not know and drops: `DroidTransport` passes it on). A row is the process's, by its pid:
// two commands under one Droid id (a model that numbers its calls afresh) are two rows.

/** A command Droid runs in the background, as it lists it. */
export interface BackgroundProcess {
  /** Droid's id for it, by which it is stopped: its call's id, else `<pid>:<start>`. */
  id: string;
  pid: number;
  command: string;
  startedAtMs?: number;
  outputFile?: string;
}

/** The processes of a `background_processes_changed`; undefined when it lists none it can read. */
export function backgroundProcesses(value: unknown): BackgroundProcess[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const process = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
    if (!process || typeof process.id !== "string" || !process.id || typeof process.pid !== "number" || !Number.isInteger(process.pid)
      || typeof process.command !== "string") return [];
    return [{
      id: process.id, pid: process.pid, command: process.command,
      ...(typeof process.startedAtMs === "number" && Number.isFinite(process.startedAtMs) ? { startedAtMs: process.startedAtMs } : {}),
      ...(typeof process.outputFile === "string" ? { outputFile: process.outputFile } : {}),
    }];
  });
}

/**
 * How long a row whose process left Droid's list waits for Droid's word on how it ended
 * (`DroidWork`'s completion) once Droid is idle; while Droid is at work it waits on, up to
 * `holdMs`: Droid tells it only after the tool it is running then (CLI 1.3).
 */
const waitMs = 30_000;
const holdMs = 15 * 60_000;

interface Row {
  /** The row's id: Droid's id with the pid, which no other command at work has. */
  id: string;
  droid: string;
  /** Asked to stop (`stopping`): it ends as stopped, whatever its exit status. */
  stopping: boolean;
  /** Since it left Droid's list, waiting for Droid's word on it (`waitMs`). */
  timer?: NodeJS.Timeout;
  leftAt?: number;
  /** Its place in the order rows left Droid's list, which is the order Droid tells their ends in. */
  leftOrder?: number;
}

export class DroidBackground {
  private readonly commands: BackgroundCommands;
  /** The rows of the commands at work, or waiting for Droid's word on their end, by pid. */
  private readonly rows = new Map<number, Row>();
  /** How commands under a Droid id ended, as Droid told it before their process left its list: the oldest first. */
  private readonly told: { droid: string; status: Exclude<SubagentStatus, "running">; at: number }[] = [];
  /** The Droid ids listed more than once at the last list: none of those can be stopped by itself. */
  private shared = new Set<string>();
  /** The next row to leave Droid's list gets this place (`Row.leftOrder`). */
  private leftCount = 0;
  private readonly now: () => number;
  private readonly wait: number;
  private readonly hold: number;
  /** Whether Droid is at work on the thread's session now. */
  private readonly atWork: () => boolean;

  constructor(emit: (event: ProviderEvent) => void,
    options: { now?: () => number; atWork?: () => boolean; waitMs?: number; holdMs?: number; intervalMs?: number; pollMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.atWork = options.atWork ?? (() => false);
    this.wait = options.waitMs ?? waitMs;
    this.hold = options.holdMs ?? holdMs;
    this.commands = new BackgroundCommands(emit, { now: this.now, intervalMs: options.intervalMs, pollMs: options.pollMs });
  }

  /** Droid's list of the commands it runs in the background, whole. */
  list(processes: readonly BackgroundProcess[]): void {
    const counts = new Map<string, number>();
    for (const process of processes) counts.set(process.id, (counts.get(process.id) ?? 0) + 1);
    this.shared = new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
    const listed = new Set(processes.map((process) => process.pid));
    for (const [pid, row] of this.rows) if (!listed.has(pid) && !row.timer) this.left(pid, row);
    for (const process of processes) {
      const row = this.rows.get(process.pid);
      if (row && row.droid === process.id && !row.timer) {
        this.commands.stoppable(row.id, !this.shared.has(row.droid) && !row.stopping);
        continue;
      }
      if (row) this.end(process.pid, row, "completed");
      const id = `${process.id}#${process.pid}`;
      this.rows.set(process.pid, { id, droid: process.id, stopping: false });
      this.commands.start(id, { goal: process.command || "A command", startedAt: process.startedAtMs, stoppable: !this.shared.has(process.id) });
      if (process.outputFile && outputFile(process.outputFile, process.startedAtMs)) this.commands.follow(id, process.outputFile);
    }
  }

  /** Droid told how a command under its id `droid` ended (its completion): the row of the one that left its list is ended so, or the next to. */
  finished(droid: string, status: Exclude<SubagentStatus, "running">): void {
    // Of those that left the list waiting for it, the one that left first: Droid tells
    // their ends in the order they ended, which need not be the order they started.
    let first: [number, Row] | undefined;
    for (const [pid, row] of this.rows) {
      if (row.droid === droid && row.timer && (!first || row.leftOrder! < first[1].leftOrder!)) first = [pid, row];
    }
    if (first) { this.end(first[0], first[1], status); return; }
    // Droid tells it just before its list (CLI 1.3): kept for the one that leaves it next.
    const now = this.now();
    while (this.told.length > 0 && (now - this.told[0].at > this.hold || this.told.length >= 64)) this.told.shift();
    this.told.push({ droid, status, at: now });
  }

  /** Droid's id to stop row `id` by, when it names that command alone; undefined for none such at work. */
  target(id: string): string | undefined {
    const row = [...this.rows.values()].find((row) => row.id === id);
    return row && !row.timer && !this.shared.has(row.droid) && this.commands.running(id) ? row.droid : undefined;
  }

  /** Droid took the Stop of row `id`: it ends as stopped. */
  stopping(id: string): void {
    const row = [...this.rows.values()].find((row) => row.id === id);
    if (!row) return;
    row.stopping = true;
    this.commands.stoppable(id, false);
  }

  /** Droid's process went away: no row is followed any longer. */
  close(): void {
    for (const row of this.rows.values()) if (row.timer) clearTimeout(row.timer);
    this.rows.clear();
    this.told.length = 0;
    this.shared.clear();
    this.commands.close();
  }

  /** The process of `row` left Droid's list: it ended as Droid told, or tells soon (`waitMs`). */
  private left(pid: number, row: Row): void {
    const now = this.now();
    const index = this.told.findIndex((told) => told.droid === row.droid && now - told.at <= this.hold);
    if (index !== -1) {
      const [told] = this.told.splice(index, 1);
      this.end(pid, row, told.status);
      return;
    }
    row.leftAt = now;
    row.leftOrder = this.leftCount++;
    this.commands.stoppable(row.id, false);
    this.await(pid, row);
  }

  private await(pid: number, row: Row): void {
    row.timer = setTimeout(() => {
      if (this.rows.get(pid) !== row) return;
      if (this.atWork() && this.now() - row.leftAt! < this.hold) { this.await(pid, row); return; }
      // No word from Droid: it ended all the same, how is not known.
      this.end(pid, row, "completed");
    }, this.wait);
    row.timer.unref();
  }

  private end(pid: number, row: Row, status: Exclude<SubagentStatus, "running">): void {
    if (row.timer) clearTimeout(row.timer);
    if (this.rows.get(pid) === row) this.rows.delete(pid);
    this.commands.end(row.id, row.stopping ? "stopped" : status);
  }
}

/**
 * Whether `path` is a background command's output file as Droid names it: an absolute
 * path, `droid-bg-<its start>-<uuid>.out` in Droid's temporary folder.
 */
function outputFile(path: string, startedAtMs: number | undefined): boolean {
  if (!isAbsolute(path) || path.split("/").includes("..")) return false;
  const name = /^droid-bg-(\d+)-[0-9a-f-]{36}\.out$/.exec(basename(path));
  return !!name && (startedAtMs === undefined || Number(name[1]) === startedAtMs);
}
