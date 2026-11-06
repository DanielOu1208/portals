import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../log.ts";
import type { Provider, UsageReport } from "../providers/types.ts";
import { ensureDirectory, writeBytes } from "../store/jsonFile.ts";
import { usageAgent } from "./sessions.ts";
import type { LimitReading, UsageAgent } from "./types.ts";

// The plans' limits over time (docs/plans/2026-11-06-token-analytics.md, section 3): every
// reading of a window the host gets anyway, kept with its time in
// `state/usage/limits.jsonl`, a line a reading, for 90 days. The app works out the pace
// from them: how much of a window is used against how much of it has passed.
//
// The readings are those the host already has: each answer an agent gives to `usage()`
// (the panel's `usage.read`, a person's `/usage`), what the agents say by themselves as
// their turns run (Claude Code's `rate_limit_event`, Codex's `account/rateLimits/updated`:
// `Provider.onLimits`), and one asked every 15 minutes while a thread runs, through the
// same once-a-minute path `usage.read` takes (`LimitSampler`), so no agent is started for
// it that the panel would not start. A reading the same as the last one of its window is
// not kept: most say nothing new, and a quiet week is then a few lines.
//
// Nothing here may stop the host: a file that cannot be read or written costs the
// readings, and the host goes on.

const dayMs = 24 * 60 * 60_000;

/** How long readings are kept. */
export const limitsKeptMs = 90 * dayMs;

/** At most this many readings are held, whatever the file says: about four months of a reading a minute of four windows. */
const mostReadings = 500_000;

export interface LimitLogOptions {
  /** `state/usage`. */
  folder: string;
  clock?: () => number;
}

export class LimitLog {
  readonly path: string;
  private readonly clock: () => number;
  /** Oldest first. */
  private readings: LimitReading[] = [];
  /** The last reading kept of each window, by agent and name. */
  private readonly last = new Map<string, LimitReading>();

  constructor(options: LimitLogOptions) {
    this.path = join(options.folder, "limits.jsonl");
    this.clock = options.clock ?? Date.now;
    let text = "";
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("usage: the limit readings could not be read; new ones are kept", { why: (error as Error).message });
    }
    const since = this.clock() - limitsKeptMs;
    let dropped = false;
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const reading = parseReading(line);
      if (!reading || reading.at < since) {
        dropped = true;
        continue;
      }
      this.readings.push(reading);
    }
    // Lines are appended as they come, so a reading heard late can be out of order.
    this.readings.sort((a, b) => a.at - b.at);
    if (this.readings.length > mostReadings) {
      this.readings = this.readings.slice(-mostReadings);
      dropped = true;
    }
    for (const reading of this.readings) this.last.set(windowKey(reading.agent, reading.name), reading);
    if (dropped) this.rewrite();
  }

  /** Every reading kept, oldest first. */
  all(): LimitReading[] {
    return [...this.readings];
  }

  /** The readings from `from` to `to` (milliseconds, inclusive), oldest first. */
  between(from: number, to: number): LimitReading[] {
    return this.readings.filter((reading) => reading.at >= from && reading.at <= to);
  }

  /**
   * An agent's answer, or what it said by itself: each window with a share used, at the
   * time it was said (`heardAt`, for a window kept from an earlier answer) or now. Answers
   * how many readings were kept. Never throws.
   */
  heard(agent: UsageAgent, report: UsageReport): number {
    try {
      const now = this.clock();
      const fresh: LimitReading[] = [];
      for (const limit of report.limits ?? []) {
        if (typeof limit.percent !== "number" || !Number.isFinite(limit.percent) || typeof limit.name !== "string" || limit.name === "") continue;
        const at = limit.heardAt ?? report.heardAt ?? now;
        const reading: LimitReading = { at: Math.min(at, now), agent, name: limit.name, percent: limit.percent, resetsAt: typeof limit.resetsAt === "number" ? limit.resetsAt : null };
        if (limit.windowSeconds) reading.windowSeconds = limit.windowSeconds;
        const name = windowKey(agent, limit.name);
        const before = this.last.get(name);
        // Older than the last one kept, or the same as it: nothing new about the window.
        if (before && (reading.at < before.at || sameReading(before, reading))) continue;
        this.last.set(name, reading);
        fresh.push(reading);
      }
      if (fresh.length === 0) return 0;
      const latest = this.readings.at(-1)?.at ?? Number.NEGATIVE_INFINITY;
      const ordered = fresh.every((reading, index) => reading.at >= (index === 0 ? latest : fresh[index - 1].at));
      this.readings.push(...fresh);
      // A window kept from an earlier answer can be older than another window's last reading.
      if (!ordered) this.readings.sort((a, b) => a.at - b.at);
      // Once the oldest is a day past what is kept: a rewrite a day at most.
      if (this.readings[0].at < now - limitsKeptMs - dayMs || this.readings.length > mostReadings) {
        this.trim(now);
        this.rewrite();
      } else {
        this.append(fresh);
      }
      return fresh.length;
    } catch (error) {
      log.warn("usage: a limit reading could not be kept", { why: (error as Error).message });
      return 0;
    }
  }

  private trim(now: number): void {
    const since = now - limitsKeptMs;
    this.readings = this.readings.filter((reading) => reading.at >= since).slice(-mostReadings);
  }

  private append(readings: LimitReading[]): void {
    try {
      ensureDirectory(dirname(this.path));
      appendFileSync(this.path, readings.map((reading) => JSON.stringify(reading) + "\n").join(""), { mode: 0o600 });
    } catch (error) {
      log.warn("usage: limit readings could not be written", { why: (error as Error).message });
    }
  }

  private rewrite(): void {
    try {
      writeBytes(this.path, () => Buffer.from(this.readings.map((reading) => JSON.stringify(reading) + "\n").join("")));
    } catch (error) {
      log.warn("usage: the limit readings could not be written", { why: (error as Error).message });
    }
  }
}

function windowKey(agent: UsageAgent, name: string): string {
  return `${agent}\u0000${name}`;
}

function sameReading(a: LimitReading, b: LimitReading): boolean {
  return a.percent === b.percent && a.resetsAt === b.resetsAt && a.windowSeconds === b.windowSeconds;
}

/** One line of limits.jsonl; undefined for one that is not a reading. */
function parseReading(line: string): LimitReading | undefined {
  let value: Partial<LimitReading>;
  try {
    value = JSON.parse(line) as Partial<LimitReading>;
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const agent = usageAgent(value.agent);
  if (!agent || typeof value.at !== "number" || !Number.isFinite(value.at) || typeof value.name !== "string" || value.name === "") return undefined;
  if (typeof value.percent !== "number" || !Number.isFinite(value.percent)) return undefined;
  const reading: LimitReading = { at: value.at, agent, name: value.name, percent: value.percent, resetsAt: typeof value.resetsAt === "number" ? value.resetsAt : null };
  if (typeof value.windowSeconds === "number" && value.windowSeconds > 0) reading.windowSeconds = value.windowSeconds;
  return reading;
}

/**
 * Keeps every answer `provider` gives to `usage()` in `limits`, whoever asked: the panel,
 * a person's `/usage`, the sampler. And what it says by itself (`onLimits`).
 */
export function watchLimits(provider: Provider, limits: LimitLog): void {
  const agent = usageAgent(provider.profile.kind);
  if (!agent) return;
  provider.onLimits = (report) => void limits.heard(agent, report);
  const ask = provider.usage;
  if (!ask) return;
  provider.usage = async (thread, options) => {
    const report = await ask.call(provider, thread, options);
    limits.heard(agent, report);
    return report;
  };
}

export interface LimitSamplerOptions {
  /** The threads with a turn running now, each with its agent. */
  running: () => { thread: string; provider: Provider }[];
  /** How the panel asks an agent (gateway/methods.ts `recentUsage`): at most once a minute, whoever asks. */
  ask: (provider: Provider, thread: string) => Promise<UsageReport>;
  clock?: () => number;
  /** How far apart readings are asked for (15 minutes). */
  everyMs?: number;
  /** How often it looks whether a thread runs (a minute). */
  checkMs?: number;
}

/**
 * One reading every 15 minutes while a thread runs, of each agent with a thread running:
 * asked through `ask`, and kept by `watchLimits` as any answer is. Nothing is asked while
 * nothing runs.
 */
export class LimitSampler {
  private readonly options: LimitSamplerOptions;
  private readonly clock: () => number;
  private readonly everyMs: number;
  private timer: NodeJS.Timeout | undefined;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(options: LimitSamplerOptions) {
    this.options = options;
    this.clock = options.clock ?? Date.now;
    this.everyMs = options.everyMs ?? 15 * 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.options.checkMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Asks now if a thread runs and the last reading asked for is 15 minutes old. Answers how many agents were asked. Never throws. */
  check(): number {
    try {
      const now = this.clock();
      if (now - this.lastAt < this.everyMs) return 0;
      const agents = new Map<Provider, string>();
      for (const { thread, provider } of this.options.running()) if (provider.usage && !agents.has(provider)) agents.set(provider, thread);
      if (agents.size === 0) return 0;
      this.lastAt = now;
      for (const [provider, thread] of agents) {
        void this.options.ask(provider, thread).catch((error: Error) => log.debug("usage: an agent did not say its limits", { agent: provider.profile.name, why: error?.message }));
      }
      return agents.size;
    } catch (error) {
      log.warn("usage: the limits could not be asked for", { why: (error as Error).message });
      return 0;
    }
  }
}
