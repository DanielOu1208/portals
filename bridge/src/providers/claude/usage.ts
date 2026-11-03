import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageLimit, UsageReport } from "../types.ts";
import type { PlanUsage } from "./session.ts";

// `/usage` for Claude Code. A running Claude Code says it as its own `/usage` does: the
// plan and each of its windows (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`
// in the Agent SDK). Every turn also reports the windows it counted in
// (`rate_limit_event`), which the bridge keeps for when no Claude Code can be asked.

/** The windows by the names people give them; one not here goes by its own. */
export const windowNames: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_oauth_apps: "weekly, in other apps",
  seven_day_overage_included: "weekly, with extra usage",
  overage: "extra usage",
};

/** How long each window is, in seconds, by Claude Code's names for them. */
const windowSeconds: Record<string, number> = {
  five_hour: 5 * 3600,
  seven_day: 7 * 86400,
  seven_day_opus: 7 * 86400,
  seven_day_sonnet: 7 * 86400,
  seven_day_oauth_apps: 7 * 86400,
  seven_day_overage_included: 7 * 86400,
};

type Fields = Record<string, unknown>;

function record(value: unknown): Fields | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : undefined;
}

function seconds(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.floor(at / 1000);
}

function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * What a running Claude Code answers for `/usage`, as the report. Null when the plan has
 * limits Claude Code could not read just now (`rate_limits` null): the last ones read stand
 * then, or as the turns last reported them if none were.
 */
export function planUsageReport(usage: PlanUsage): UsageReport | null {
  const report: UsageReport = { limits: [] };
  if (typeof usage.subscription_type === "string" && usage.subscription_type !== "") report.plan = usage.subscription_type;
  if (usage.rate_limits_available === false) {
    report.note = "No plan limits apply: Claude Code is not using a Claude plan's sign-in here (an API key has none).";
    return report;
  }
  const limits = record(usage.rate_limits);
  if (!limits) return null;
  for (const [key, value] of Object.entries(limits)) {
    if (key === "model_scoped") {
      report.limits.push(...(modelWindows(usage) ?? []));
      continue;
    }
    const window = record(value);
    const used = percent(window?.utilization);
    // Only what is counted in a share: Claude Code adds other parts (spending, breakdowns).
    if (!window || used === null) continue;
    if (key === "extra_usage") {
      if (window.is_enabled === true) report.note = `Extra usage: ${Math.round(used)}% of this month's limit used.`;
      continue;
    }
    report.limits.push(limit(windowNames[key] ?? key.replaceAll("_", " "), used, seconds(window.resets_at), windowSeconds[key]));
  }
  return report;
}

/** Claude Code read the plan's limits for this answer: it has a window to show, not only that it could not say. */
export function hasLimits(usage: PlanUsage): boolean {
  return (planUsageReport(usage)?.limits.length ?? 0) > 0;
}

/**
 * The plan's weekly windows for one model (Fable's), as Claude Code's own `/usage` shows
 * them ("Current week (Fable): 0% used"): used or not, since the plan has them (2026-11-01: "if the plan has a fable limit it should show regardless of if it has been
 * used"). Null when the answer says nothing of them (`model_scoped` absent: an answer from
 * what Claude Code fetched before), which is not that there are none (an empty list).
 */
export function modelWindows(usage: PlanUsage): UsageLimit[] | null {
  const listed = record(usage.rate_limits)?.model_scoped;
  if (!Array.isArray(listed)) return null;
  return listed.map(record).flatMap((entry) => {
    const used = percent(entry?.utilization);
    // Without a share, nothing to show: an empty bar would read as used up.
    if (!entry || typeof entry.display_name !== "string" || used === null) return [];
    return [limit(`weekly ${entry.display_name}`, used, seconds(entry.resets_at), 7 * 86400)];
  });
}

/** How long a kept window with no time of its own to reset is kept. */
const keptWithoutResetMs = 7 * 86400_000;

/**
 * The model windows the last answer that said them gave, for an answer that does not: a
 * running Claude Code's often leaves them out, one started just to ask has them, and the
 * panel would show Fable's only now and then. Kept until they reset (a week for one that
 * says no reset time), each marked with when it was said, for its number may be old by
 * then; forgotten when the sign-in is one with no plan limits.
 */
export class KnownModelWindows {
  private kept: UsageLimit[] = [];
  private at = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** `report`, from `usage` as said at `at`, with the model windows last said where it says none. */
  fill(report: UsageReport, usage: PlanUsage, at: number = this.now()): UsageReport {
    if (usage.rate_limits_available === false) {
      this.kept = [];
      return report;
    }
    const said = modelWindows(usage);
    if (said) {
      this.kept = said;
      this.at = at;
      return report;
    }
    return this.add(report);
  }

  /** `report` with the model windows last said, for one no answer of Claude Code's is behind. */
  add(report: UsageReport): UsageReport {
    const now = this.now();
    this.kept = this.kept.filter((window) => (window.resetsAt === null ? now - this.at < keptWithoutResetMs : window.resetsAt > now / 1000));
    return this.kept.length > 0 ? { ...report, limits: [...report.limits, ...this.kept.map((window) => ({ ...window, heardAt: this.at }))] } : report;
  }
}

/**
 * `report`, said at `at`, as it stands at `now`: of a window past its reset, or a week on for
 * one that says no reset time, nothing said holds, used up or not. It is a new window then,
 * whose number and reset nobody has said.
 */
export function stillStanding(report: UsageReport, at: number, now: number): UsageReport {
  const limits = report.limits.map((window) => {
    const over = window.resetsAt === null ? now - (window.heardAt ?? at) >= keptWithoutResetMs : window.resetsAt <= now / 1000;
    if (!over) return window;
    const { reached: _reached, ...rest } = window;
    return { ...rest, percent: null, resetsAt: null };
  });
  return { ...report, limits };
}

function limit(name: string, used: number | null, resetsAt: number | null, length?: number): UsageLimit {
  return { name, percent: used, resetsAt, ...(used !== null && used >= 100 ? { reached: true } : {}), ...(length ? { windowSeconds: length } : {}) };
}

/** What the turns have reported of each window, kept by window, newest last. */
export class HeardLimits {
  private readonly windows = new Map<string, UsageLimit>();
  /** When each of `windows` was last heard. */
  private readonly times = new Map<string, number>();
  private at: number | null = null;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * A `rate_limit_event`'s `rate_limit_info`: one window (`rateLimitType`), or several at
   * once (`unifiedWindows`). Its status is the one window's it names: a turn turned away
   * by the 5-hour window has not used up the week.
   */
  heard(info: Fields): void {
    const named = typeof info.rateLimitType === "string" ? info.rateLimitType : null;
    const windows: [string, Fields][] = Object.entries(record(info.unifiedWindows) ?? {}).flatMap(([key, value]) => (record(value) ? [[key, record(value)!]] : []));
    if (named && !windows.some(([key]) => key === named)) windows.push([named, info]);
    for (const [key, window] of windows) {
      const utilization = percent(window.utilization);
      // A fraction; some reports give a percentage.
      const used = utilization === null ? null : utilization > 1 ? utilization : utilization * 100;
      const resetsAt = typeof window.resetsAt === "number" ? window.resetsAt : null;
      const entry: UsageLimit = { name: windowNames[key] ?? key.replaceAll("_", " "), percent: used, resetsAt, ...(windowSeconds[key] ? { windowSeconds: windowSeconds[key] } : {}) };
      if ((window.status ?? (key === named ? info.status : undefined)) === "rejected") entry.reached = true;
      this.windows.set(key, entry);
      this.times.set(key, this.now());
    }
    if (windows.length > 0) this.at = this.now();
  }

  /** As last heard; no limits when nothing was. */
  report(): UsageReport {
    if (this.at === null) return { limits: [], note: "Claude Code says how much is used with each turn, and no turn has run since the bridge started." };
    return { limits: [...this.windows.values()], heardAt: this.at };
  }

  /** A turn has reported something since `at`. */
  heardSince(at: number): boolean {
    return this.at !== null && this.at >= at;
  }

  /**
   * `report`, an answer Claude Code gave at `at`, with what the turns have said since: the
   * newer word on each window, whichever way it goes, marked with when it was said. A report
   * with no share and no change to whether the window is used up (most say only "allowed")
   * tells nothing new.
   */
  over(report: UsageReport, at: number): UsageReport {
    const limits = [...report.limits];
    for (const [key, heard] of this.windows) {
      const heardAt = this.times.get(key)!;
      if (heardAt < at) continue;
      const index = limits.findIndex((limit) => limit.name === heard.name);
      const was = limits[index];
      if (heard.percent === null && Boolean(heard.reached) === Boolean(was?.reached)) continue;
      const { reached: _reached, ...rest } = was ?? heard;
      // An older word's reset time only while it is to come: past it this is a new window's number.
      const resetsAt = heard.resetsAt ?? (rest.resetsAt !== null && rest.resetsAt > heardAt / 1000 ? rest.resetsAt : null);
      const newer: UsageLimit = { ...rest, percent: heard.percent, resetsAt, ...(heard.reached ? { reached: true } : {}), heardAt };
      if (was) limits[index] = newer;
      else limits.push(newer);
    }
    return { ...report, limits };
  }
}

/**
 * The plan as Claude Code names it to the person (2026-11-01: "the claude 200
 * dollar plan is now called ultra and not max"): the name Anthropic's profile gives it
 * (`oauthAccount.planDisplayName`, "Ultra" for what `subscription_type` still calls
 * "max"), which Claude Code keeps in its own settings file and titles its plan with
 * (`Claude ${planDisplayName}`); null without one.
 */
export async function planDisplayName(env: NodeJS.ProcessEnv): Promise<string | null> {
  const folder = env.CLAUDE_CONFIG_DIR?.trim() || env.HOME?.trim() || homedir();
  const text = await readFile(join(folder, ".claude.json"), "utf8").catch(() => null);
  if (!text) return null;
  try {
    const name = (JSON.parse(text) as { oauthAccount?: { planDisplayName?: unknown } }).oauthAccount?.planDisplayName;
    return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
  } catch {
    return null;
  }
}
