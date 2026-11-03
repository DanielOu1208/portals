import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import type { Totals } from "./device.ts";
import type { Counted } from "./lines.ts";
import { recipe, writeRegistry, type RegistryOptions, type WrittenRegistry } from "./registry.ts";
import type { BenchBridge, Sample, Scratch } from "./scratch.ts";

// What every scenario of the harness shares: the run's settings, a bridge started on a
// written list, the measuring of a piece of work between two edges, and a table.

export interface Run {
  scratch: Scratch;
  /** Whether the bridges run with their counters on: on, their own lines are read too. */
  counters: boolean;
  /** Small sizes and short waits, for the test suite. */
  quick: boolean;
  /** The registry sizes of the scenarios that take several. */
  sizes: number[];
  /** How long `idle` watches, in seconds. */
  idleSeconds: number;
  /** Seconds between the counters' lines in the bridges whose lines are read. */
  tick: number;
  /** Progress, to standard error. */
  say(message: string): void;
}

export type Cell = string | number | null;

/** One table of the report: a Markdown table when printed, rows in the JSON. */
export interface Table {
  scenario: string;
  title: string;
  /** When it was taken, and the Mac's one-minute load average then: other work on the Mac shows in it. */
  taken: string;
  load: number;
  columns: string[];
  rows: Cell[][];
  /** What the reader needs to know to read the numbers. */
  notes: string[];
}

export type Scenario = (run: Run) => Promise<Table[]>;

export function table(scenario: string, title: string, columns: string[], rows: Cell[][], notes: string[] = []): Table {
  return { scenario, title, taken: new Date().toISOString(), load: Math.round(loadavg()[0] * 100) / 100, columns, rows, notes };
}

/** A bridge started on a list of threads written for it, in a folder of its own. */
export async function bridgeWith(run: Run, name: string, registry: RegistryOptions, options: { counters?: boolean; tick?: number | null; delayMs?: number } = {}): Promise<{ bridge: BenchBridge; written: WrittenRegistry }> {
  const home = run.scratch.folder(name);
  const written = writeRegistry(home, run.scratch.folder("folders"), registry);
  // `tick: null` is the bridge's own minute.
  const tick = options.tick === null ? undefined : (options.tick ?? run.tick);
  // The scripted agent's pause between words: a scenario that needs turns as long as real ones gives a longer one.
  const bridge = await run.scratch.startBridge({ home, counters: options.counters ?? run.counters, tick, config: { fake: { delayMs: options.delayMs ?? recipe.delayMs } } });
  return { bridge, written };
}

export interface Measured {
  wallMs: number;
  /** The bridge's CPU time over the work, in milliseconds. With its counters on, their ticks in that time are in it. */
  cpuMs: number;
  before: Sample;
  after: Sample;
  /** What the bridge's own lines counted between the two edges; null with its counters off. */
  counted: Counted | null;
}

/**
 * Does `work` and says what it cost each of `bridges`. The setup comes before this: the
 * harness waits for a line of the counters, starts, finishes and waits for the next
 * line, so only the work is in the lines between; CPU and memory are read at the same
 * two moments.
 *
 * A bridge with its counters off has no line to wait for, and is given the same pause
 * before the work instead: a bridge that rested a second does the same work more slowly
 * than one that was just busy, so without the pause off and on could not be compared.
 */
export async function measured(run: Run, bridges: BenchBridge[], work: () => Promise<void>): Promise<Measured[]> {
  const from = await Promise.all(bridges.map((bridge) => (bridge.lines ? bridge.lines.edge() : sleep(run.tick * 1000).then(() => 0))));
  const before = await Promise.all(bridges.map((bridge) => bridge.sample()));
  const started = performance.now();
  await work();
  const wallMs = performance.now() - started;
  const after = await Promise.all(bridges.map((bridge) => bridge.sample()));
  const to = await Promise.all(bridges.map((bridge) => bridge.lines?.edge() ?? 0));
  return bridges.map((bridge, index) => ({
    wallMs,
    cpuMs: after[index].cpuMs - before[index].cpuMs,
    before: before[index],
    after: after[index],
    counted: bridge.lines ? bridge.lines.between(from[index], to[index]) : null,
  }));
}

// MARK: Numbers

export function median(values: number[]): number {
  return percentile(values, 0.5);
}

/** The value `share` of the way up the sorted values (0.99 for the 99th percentile); 0 for none. */
export function percentile(values: number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))];
}

export function longest(values: number[]): number {
  return values.reduce((most, value) => Math.max(most, value), 0);
}

/** A number for a table: whole when it is, else two or three figures. */
export function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (Number.isInteger(value)) return value;
  const places = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : Math.abs(value) >= 1 ? 2 : 3;
  return Number(value.toFixed(places));
}

/** `value` when the counters were on, else nothing: a number only the bridge's own lines give. */
export function inside(counted: Counted | null, value: number): Cell {
  return counted ? round(value) : null;
}

/** One kind of call in what a device counted: how many, bytes each way and the times. */
export function calls(totals: Totals, method: string): { n: number; up: number; down: number; ms: number[] } {
  return totals.calls.get(method) ?? { n: 0, up: 0, down: 0, ms: [] };
}

/** Every call and byte in what a device counted, events and `gateway.ready` among the bytes down. */
export function all(totals: Totals): { n: number; up: number; down: number } {
  const sum = { n: 0, up: 0, down: totals.events.bytes };
  for (const stats of totals.calls.values()) {
    sum.n += stats.n;
    sum.up += stats.up;
    sum.down += stats.down;
  }
  return sum;
}

// MARK: Printing

/** The table as Markdown, with its heading and notes. */
export function markdown(shown: Table): string {
  const cell = (value: Cell) => (value === null ? "–" : String(value).replaceAll("|", "\\|"));
  const lines = [
    `### ${shown.scenario}: ${shown.title}`,
    "",
    `Taken ${shown.taken}, load average ${shown.load}.`,
    "",
    `| ${shown.columns.join(" | ")} |`,
    `|${shown.columns.map(() => "---").join("|")}|`,
    ...shown.rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
  if (shown.notes.length > 0) lines.push("", ...shown.notes.map((note) => `- ${note}`));
  return lines.join("\n");
}
