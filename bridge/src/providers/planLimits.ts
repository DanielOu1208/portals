import { execFile } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostOS } from "../platform.ts";
import type { UsageLimit, UsageReport } from "./types.ts";

// How much of their plans Droid and Cursor have used (`/usage`, `usage.read`), which
// neither tells through what the bridge runs them with (Droid's SDK, Cursor's ACP), asked
// of their makers the way their own CLIs ask (2026-11-01: "yes, both"): Droid's
// `/limits` asks Factory's `/api/billing/limits`, and cursor-agent Cursor's
// `DashboardService`. With the sign-in each CLI keeps on this computer, only read: never
// refreshed or written, so the CLI's own stays as it was; an expired one says so until
// the CLI next runs and renews it. Neither interface is documented, so a change on their
// side shows as a sentence, not as wrong numbers.

/** How long a window is, by Factory's names for them. */
const factoryWindows: [key: string, name: string, seconds: number][] = [
  ["fiveHour", "5-hour", 5 * 3600],
  ["weekly", "weekly", 7 * 86400],
  ["monthly", "monthly", 30 * 86400],
];

export class PlanLimitsError extends Error {}

/** A share as a window can show it: past 100 is all of it; anything else not between 0 and 100 is none at all. */
function share(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, 100);
}

function cannotRead(service: string): string {
  return `This version of the host cannot read ${service}'s answer.`;
}

/**
 * What Factory's `/api/billing/limits` answers, as `/usage` reads it: the plan's own
 * windows, not Droid Core's (2026-11-01: "for droid dont show the core usage").
 * That no limits apply is said only when the answer shows it (`usesTokenRateLimitsBilling`
 * false): one with no windows this version can read may be one of another shape.
 */
export function factoryReport(body: unknown): UsageReport {
  const answer = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  const limits: UsageLimit[] = [];
  const group = answer.limits?.standard;
  for (const [key, name, seconds] of group && typeof group === "object" ? factoryWindows : []) {
    const window = group[key];
    const percent = share(window?.usedPercent);
    if (percent === null) continue;
    const end = typeof window.windowEnd === "string" ? Date.parse(window.windowEnd) : NaN;
    limits.push({
      name,
      percent,
      resetsAt: Number.isNaN(end) ? null : Math.floor(end / 1000),
      windowSeconds: seconds,
      ...(percent >= 100 ? { reached: true } : {}),
    });
  }
  const report: UsageReport = { limits };
  const noPlan = answer.hasActiveSubscription === false;
  const noLimits = answer.usesTokenRateLimitsBilling === false;
  const extra = typeof answer.extraUsageBalanceCents === "number" && Number.isFinite(answer.extraUsageBalanceCents) ? answer.extraUsageBalanceCents : 0;
  if (limits.length === 0 && !noPlan && !noLimits) report.note = cannotRead("Factory");
  else if (extra > 0) report.note = `Extra usage left: $${(extra / 100).toFixed(2)}.`;
  else if (limits.length === 0) report.note = noPlan ? "No Factory subscription on this sign-in." : "Factory says no limits apply.";
  return report;
}

/** What Cursor's `GetPlanInfo` and `GetCurrentPeriodUsage` answer, as `/usage` reads it. */
export function cursorReport(planInfo: unknown, period: unknown): UsageReport {
  const plan = (planInfo && typeof planInfo === "object" ? (planInfo as Record<string, any>).planInfo : undefined) as Record<string, any> | undefined;
  const readable = period !== null && typeof period === "object" && !Array.isArray(period);
  const usage = (readable ? period : {}) as Record<string, any>;
  const start = Number(usage.billingCycleStart);
  const end = Number(usage.billingCycleEnd);
  const resetsAt = Number.isFinite(end) && end > 0 ? Math.floor(end / 1000) : null;
  const windowSeconds = Number.isFinite(start) && start > 0 && resetsAt !== null && end > start ? Math.round((end - start) / 1000) : undefined;
  const window = (name: string, value: unknown): UsageLimit[] => {
    const percent = share(value);
    if (percent === null) return [];
    return [{ name, percent, resetsAt, ...(windowSeconds ? { windowSeconds } : {}), ...(percent >= 100 ? { reached: true } : {}) }];
  };
  const spent = usage.planUsage ?? {};
  // As Cursor says it ("You've used 7% of your included usage"): what was spent of what is included.
  const included = typeof spent.limit === "number" && spent.limit > 0 && typeof spent.includedSpend === "number" ? (spent.includedSpend / spent.limit) * 100 : spent.totalPercentUsed;
  const limits = [...window("included", included), ...window("Auto", spent.autoPercentUsed), ...window("API", spent.apiPercentUsed)];
  const report: UsageReport = { limits };
  if (typeof plan?.planName === "string" && plan.planName !== "") report.plan = plan.planName;
  if (limits.length === 0) report.note = !readable ? cannotRead("Cursor") : usage.enabled === false ? "Cursor keeps no count of usage on this plan." : "Cursor has not said yet.";
  return report;
}

export interface PlanLimitsOptions {
  /** The home folder the CLIs keep their sign-ins in. */
  home?: string;
  os?: typeof hostOS;
  /** A keychain item's secret, from the macOS login keychain; null where there is none. */
  keychain?: (service: string, account: string) => Promise<string | null>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** A sign-in fit for a header, or a sentence: what is wrong with it must not reach a message, and fetch's words about it would hold it. */
function usable(token: string, agent: string): string {
  if (!/^[\x21-\x7e]+$/.test(token)) throw new PlanLimitsError(`${agent}'s sign-in could not be read.`);
  return token;
}

/** `request`'s answer; whatever it throws, a fixed sentence: fetch's own words can hold what it was given. */
async function reached(service: string, request: () => Promise<Response>): Promise<Response> {
  try {
    return await request();
  } catch {
    throw new PlanLimitsError(`${service} could not be reached.`);
  }
}

/** How much of the plan Droid has used, from Factory, with Droid's own sign-in. */
export async function factoryUsage(options: PlanLimitsOptions = {}): Promise<UsageReport> {
  const env = options.env ?? process.env;
  const signIn = env.FACTORY_API_KEY?.trim() || (await droidAccessToken(options));
  if (!signIn) throw new PlanLimitsError("Droid is not signed in on this computer.");
  const token = usable(signIn, "Droid");
  const base = (env.FACTORY_API_BASE_URL?.trim() || "https://api.factory.ai").replace(/\/+$/, "");
  const response = await reached("Factory", () => (options.fetch ?? fetch)(`${base}/api/billing/limits`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  }));
  if (response.status === 401) throw new PlanLimitsError("Droid's sign-in has expired; it is renewed the next time Droid runs.");
  if (!response.ok) throw new PlanLimitsError(`Factory answered ${response.status}.`);
  return factoryReport(await response.json().catch(() => null));
}

/** How much of the plan Cursor has used, from Cursor, with cursor-agent's own sign-in. */
export async function cursorUsage(options: PlanLimitsOptions = {}): Promise<UsageReport> {
  const env = options.env ?? process.env;
  const signIn = env.CURSOR_API_KEY?.trim() ? null : await cursorAccessToken(options);
  if (!signIn) throw new PlanLimitsError(env.CURSOR_API_KEY?.trim() ? "Cursor says its usage only to a signed-in account, not to an API key." : "cursor-agent is not signed in on this computer.");
  const token = usable(signIn, "cursor-agent");
  const base = (env.CURSOR_API_ENDPOINT?.trim() || "https://api2.cursor.sh").replace(/\/+$/, "");
  const call = async (method: string): Promise<unknown> => {
    const response = await reached("Cursor", () => (options.fetch ?? fetch)(`${base}/aiserver.v1.DashboardService/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    }));
    if (response.status === 401) throw new PlanLimitsError("cursor-agent's sign-in has expired; it is renewed the next time Cursor runs.");
    if (!response.ok) throw new PlanLimitsError(`Cursor answered ${response.status}.`);
    return response.json().catch(() => null);
  };
  const [plan, period] = await Promise.all([call("GetPlanInfo").catch(() => null), call("GetCurrentPeriodUsage")]);
  return cursorReport(plan, period);
}

// MARK: The CLIs' sign-ins

/**
 * Droid's access token, as Droid keeps it: a file of `iv:tag:ciphertext` (AES-256-GCM, each
 * in base64), the key in the login keychain (`auth.v2.loginkeychain`, Factory CLI /
 * auth-encryption-key-security-cli, kept there with macOS's `security`, which therefore
 * reads it without asking) or in a key file beside it (`auth.v2.file`, `auth.v2.key`, where
 * there is no keychain). One kept by another key store is not read: reading it would ask.
 */
async function droidAccessToken(options: PlanLimitsOptions): Promise<string | null> {
  const folder = join(options.home ?? homedir(), ".factory");
  const os = options.os ?? hostOS;
  const keychain = options.keychain ?? readKeychain;
  const tries: (() => Promise<string | null>)[] = [];
  if (os === "macos") {
    tries.push(async () => {
      const sealed = await readFile(join(folder, "auth.v2.loginkeychain"), "utf8").catch(() => null);
      const key = sealed ? await keychain("Factory CLI", "auth-encryption-key-security-cli") : null;
      return sealed && key ? open(sealed, Buffer.from(key, "base64")) : null;
    });
  }
  tries.push(async () => {
    const [sealed, key] = await Promise.all([readFile(join(folder, "auth.v2.file"), "utf8").catch(() => null), readFile(join(folder, "auth.v2.key"), "utf8").catch(() => null)]);
    return sealed && key ? open(sealed, Buffer.from(key.trim(), "base64")) : null;
  });
  for (const attempt of tries) {
    const text = await attempt().catch(() => null);
    const token = text ? accessToken(text, "access_token") : null;
    if (token) return token;
  }
  return null;
}

/** cursor-agent's access token: in the login keychain (cursor-access-token / cursor-user) on a Mac, else its `auth.json`. */
async function cursorAccessToken(options: PlanLimitsOptions): Promise<string | null> {
  const home = options.home ?? homedir();
  const os = options.os ?? hostOS;
  if (os === "macos") {
    const token = await (options.keychain ?? readKeychain)("cursor-access-token", "cursor-user").catch(() => null);
    if (token) return token;
  }
  const env = options.env ?? process.env;
  const file = os === "macos" ? join(home, ".cursor", "auth.json") : join(env.XDG_CONFIG_HOME || join(home, ".config"), "cursor", "auth.json");
  const text = await readFile(file, "utf8").catch(() => null);
  return text ? accessToken(text, "accessToken") : null;
}

function accessToken(json: string, key: string): string | null {
  try {
    const value = (JSON.parse(json) as Record<string, unknown>)[key];
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

/** Opens Droid's `iv:tag:ciphertext`; null for a key or text that does not open it. */
export function open(sealed: string, key: Buffer): string | null {
  const parts = sealed.trim().split(":");
  if (parts.length !== 3 || key.length !== 32) return null;
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64"));
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** A generic password from the login keychain, through macOS's `security`; null where there is none. */
function readKeychain(service: string, account: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).replace(/\n$/, "") || null);
    });
  });
}
