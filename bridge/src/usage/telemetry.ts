import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { log } from "../log.ts";
import type { SignedIn } from "../net/net.ts";
import { readJSON, writeJSON } from "../store/jsonFile.ts";
import { Calendar } from "./store.ts";
import type { DayRow, ScanState, TokenCounts, UsageAgent } from "./types.ts";

// The anonymous daily totals (docs/plans/2026-11-06-token-analytics.md, section 6): once
// a day the host sends each finished day it has not sent yet, at most the last 7, to the
// stats Worker (stats/), which only the maintainer can read. Only days the host was
// active (a Portals turn started, or a device connected), and only what went through
// Portals: how many turns started, how many devices of each kind connected, and the
// tokens and API-equivalent dollars by agent and model. No prompt, reply, title, path,
// folder, account or device name, and no model name the price table does not know (a
// custom name could say something about its user): those go as "other".
//
// On by default (2026-11-06: "anonymous totals to my server should be automatically on by
// default, but people can turn it off if they want"). Off with `"telemetry": false` in
// config.json (which `portals-host telemetry off` and the app's switch write), or with
// DO_NOT_TRACK or PORTALS_TELEMETRY=0 in the host's environment, which keep it off
// whatever config.json says (`locked: "env"`). While it is off nothing is counted for it
// either, and what was counted is let go of, so turning it on again never sends a day
// from before.
//
// Nothing here may stop the host, or keep it from stopping (the rule at the top of
// counters.ts): the timers are unref'd, every timer's and hook's work is one `try`, the
// send is bounded in time, and a send that fails waits an hour, then longer each time, up
// to a day, so a host offline never tries more than once an hour. Nothing is logged but
// the day and the status the server answered.

/** Where the days go: the stats Worker. `PORTALS_STATS_URL` names another. */
export const statsURL = "https://portals-stats.danielou1208.workers.dev/v1/day";

/** How long after the host starts it first looks for a day to send: the first scan of history ends meanwhile. */
const firstMs = 10 * 60_000;
/** How often it looks again: a day is sent within about an hour of ending. */
const everyMs = 60 * 60_000;
/** How long the server may take to answer. */
const answerMs = 20_000;
/** The wait after a send that failed, doubled each time up to a day. */
const backoffMs = 60 * 60_000;
const longestBackoffMs = 24 * 60 * 60_000;
/** How many finished days back are sent: the server takes a day up to 14 days old. */
const daysBack = 7;
/** How long a day's counts and whether it was sent are kept. */
const keptDays = 14;
/** How long config.json's switch is taken as read before it is read again. */
const switchMs = 60_000;
/** How long after a count changes it is saved at most. */
const saveMs = 60_000;
/** The server's caps (stats/src/day.ts). */
const usageRowLimit = 64;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,63}$/;

export type DeviceKind = "iphone" | "ipad" | "mac" | "other";

/** One agent's and model's through-Portals totals for a day, as sent. */
export interface TelemetryUsage {
  agent: UsageAgent;
  /** The price table's name for it, else "other". */
  model: string;
  requests: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  /** API-equivalent US dollars; null when no model of the row has a price. */
  usd: number | null;
}

/** The body of `POST /v1/day`, exactly. */
export interface TelemetryDay {
  v: 1;
  install: string;
  owner: string;
  day: string;
  version: string;
  os: string;
  turns: number;
  portals: Record<DeviceKind, number>;
  usage: TelemetryUsage[];
}

/** What `usage.telemetry` answers. */
export interface TelemetryAnswer {
  enabled: boolean;
  locked: "env" | null;
  last_sent_day: string | null;
}

/** Whether the totals are sent, and why. */
export interface TelemetrySwitch {
  enabled: boolean;
  /** "env" when the environment keeps it off whatever config.json says. */
  locked: "env" | null;
  /** The variable that keeps it off, or config.json's word, or the default. */
  why: "DO_NOT_TRACK" | "PORTALS_TELEMETRY" | "config" | "default";
}

/** The model prices the dollars and the names come from (prices.ts `Prices`). */
export interface PriceBook {
  known(model: string): string | null;
  cost(model: string, counts: Pick<TokenCounts, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h">): number | null;
}

/** Every key sent, with what it holds: for `portals-host telemetry status` and the README. */
export const sentFields: readonly [key: string, what: string][] = [
  ["v", "the format's version, 1"],
  ["install", "a random id made once on this host (state/usage/install.json), not from the hardware"],
  ["owner", "the first 32 hex digits of a SHA-256 of your net's id, the same on every host of your net; the install id when there is no net"],
  ["day", "the host's date the totals are for"],
  ["version", "the version of portals-host"],
  ["os", "darwin or linux"],
  ["turns", "how many Portals turns started that day"],
  ["portals", "how many devices connected that day, by kind: iphone, ipad, mac, other"],
  ["usage", "for each agent and model, through Portals only: requests, input, output, cache_read, cache_write, reasoning tokens and API-equivalent usd; a model the price table does not know goes as \"other\""],
];

/** The variable that keeps the totals off, if any: `DO_NOT_TRACK` set to anything but "" or "0", or `PORTALS_TELEMETRY=0`. */
export function envLock(env: NodeJS.ProcessEnv): "DO_NOT_TRACK" | "PORTALS_TELEMETRY" | undefined {
  const dnt = env.DO_NOT_TRACK?.trim();
  if (dnt !== undefined && dnt !== "" && dnt !== "0") return "DO_NOT_TRACK";
  const own = env.PORTALS_TELEMETRY?.trim().toLowerCase();
  if (own !== undefined && ["0", "false", "off", "no"].includes(own)) return "PORTALS_TELEMETRY";
  return undefined;
}

/**
 * Whether config.json's `telemetry` and the environment let the totals be sent. On when
 * the key is missing or true; any other value someone wrote there (false, "off", 0) is off.
 */
export function telemetrySwitch(env: NodeJS.ProcessEnv, setting: unknown): TelemetrySwitch {
  const lock = envLock(env);
  if (lock) return { enabled: false, locked: "env", why: lock };
  if (setting === undefined || setting === null) return { enabled: true, locked: null, why: "default" };
  return { enabled: setting === true, locked: null, why: "config" };
}

/** The switch as config.json at `configPath` and `env` say. A config.json that cannot be read leaves it as the default says. */
export function readSwitch(configPath: string, env: NodeJS.ProcessEnv): TelemetrySwitch {
  const raw = readJSON<unknown>(configPath, undefined);
  const setting = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).telemetry : undefined;
  return telemetrySwitch(env, setting);
}

/**
 * Sets config.json's `telemetry`, every other key kept, as setup writes it. Throws with a
 * sentence when there is no config.json or it cannot be read, and then leaves it as it is.
 */
export function writeSwitch(configPath: string, enabled: boolean): void {
  const raw = readJSON<unknown>(
    configPath,
    undefined,
    (error) => {
      throw new Error(`${configPath} can't be read (${error.message}), so it was left as it is.`);
    },
    () => {
      throw new Error(`${configPath} isn't JSON, so it was left as it is.`);
    },
  );
  if (raw === undefined) throw new Error(`There is no ${configPath}: Portals host isn't set up here.`);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${configPath} isn't a JSON object, so it was left as it is.`);
  writeJSON(configPath, { ...(raw as Record<string, unknown>), telemetry: enabled });
}

/** Who the day is from: a hash of the net's id, so every host of one net gives one owner and the id itself is never sent; the install id with no net. */
export function ownerOf(netID: string | undefined, install: string): string {
  if (!netID) return install;
  return createHash("sha256").update(`portals-stats owner v1:${netID}`).digest("hex").slice(0, 32);
}

const netIDPattern = /^[0-9a-f]{16}$/;

/** The net's id as `state/net.json` (or its `.bak`) has it; none when neither says (net.ts). */
export function readNetID(stateDir: string): string | undefined {
  for (const path of [join(stateDir, "net.json"), join(stateDir, "net.json.bak")]) {
    const file = readJSON<unknown>(path, undefined);
    const net = file !== null && typeof file === "object" ? (file as Record<string, unknown>).net : undefined;
    if (typeof net === "string" && netIDPattern.test(net)) return net;
  }
  return undefined;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** This host's install id, from `state/usage/install.json`, made there the first time. */
export function installID(stateDir: string): string {
  const path = join(stateDir, "usage", "install.json");
  const file = readJSON<unknown>(path, undefined);
  const found = file !== null && typeof file === "object" ? (file as Record<string, unknown>).install : undefined;
  if (typeof found === "string" && uuidPattern.test(found)) return found;
  const made = randomUUID();
  writeJSON(path, { install: made });
  return made;
}

/** The address days are sent to. */
export function statsAddress(env: NodeJS.ProcessEnv): string {
  return env.PORTALS_STATS_URL?.trim() || statsURL;
}

/**
 * A day's through-Portals rows as sent: added up by agent and model, the folder dropped,
 * a model the price table does not know as "other". At most the server's 64 rows: past
 * that, the smallest go into their agent's "other".
 */
export function usageRows(rows: readonly DayRow[], day: string, prices: PriceBook): TelemetryUsage[] {
  const added = new Map<string, TelemetryUsage>();
  const tokens = new Map<string, number>();
  const add = (key: string, row: TelemetryUsage, weight: number) => {
    const before = added.get(key);
    added.set(key, before ? addUsage(before, row) : row);
    tokens.set(key, (tokens.get(key) ?? 0) + weight);
  };
  for (const row of rows) {
    if (row.day !== day || row.via !== "portals") continue;
    if (row.requests === 0 && row.input + row.output + row.cacheRead + row.cacheWrite === 0) continue;
    const known = prices.known(row.model);
    const model = known !== null && modelPattern.test(known) ? known : "other";
    const usd = known !== null ? prices.cost(row.model, row) : null;
    const sent: TelemetryUsage = {
      agent: row.agent,
      model,
      requests: row.requests,
      input: row.input,
      output: row.output,
      cache_read: row.cacheRead,
      cache_write: row.cacheWrite,
      reasoning: row.reasoning,
      usd: usd === null || !Number.isFinite(usd) ? null : usd,
    };
    add(`${row.agent}\n${model}`, sent, row.input + row.output + row.cacheRead + row.cacheWrite);
  }
  let keys = [...added.keys()];
  if (keys.length > usageRowLimit) {
    // Room for one "other" for each agent there can be.
    keys.sort((a, b) => tokens.get(b)! - tokens.get(a)!);
    const folded = new Map<string, TelemetryUsage>();
    for (const key of keys.slice(0, usageRowLimit - 8)) folded.set(key, added.get(key)!);
    for (const key of keys.slice(usageRowLimit - 8)) {
      const row = { ...added.get(key)!, model: "other" };
      const into = `${row.agent}\nother`;
      const before = folded.get(into);
      folded.set(into, before ? addUsage(before, row) : row);
    }
    added.clear();
    for (const [key, row] of folded) added.set(key, row);
    keys = [...added.keys()];
  }
  return keys.sort().map((key) => {
    const row = added.get(key)!;
    return { ...row, usd: row.usd === null ? null : Math.round(row.usd * 1e6) / 1e6 };
  });
}

function addUsage(a: TelemetryUsage, b: TelemetryUsage): TelemetryUsage {
  return {
    agent: a.agent,
    model: a.model,
    requests: a.requests + b.requests,
    input: a.input + b.input,
    output: a.output + b.output,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
    reasoning: a.reasoning + b.reasoning,
    usd: a.usd === null && b.usd === null ? null : (a.usd ?? 0) + (b.usd ?? 0),
  };
}

/** "YYYY-MM-DD" `count` days after `day`. */
export function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10);
}

/** The kind of device a net member's platform is (net/members.ts `platforms`). */
function kindOf(platform: string | undefined): DeviceKind {
  return platform === "ios" ? "iphone" : platform === "ipados" ? "ipad" : platform === "macos" ? "mac" : "other";
}

/** A day's counts, as kept: turns started, and the devices that connected by a hash of their id. */
interface DayCounts {
  turns: number;
  devices: Record<string, DeviceKind>;
}

/** What was sent last, for `portals-host telemetry status`. */
export interface LastSend {
  day: string;
  status: number;
  at: number;
  body: TelemetryDay;
}

/** `state/usage/telemetry.json`. */
interface Saved {
  v: 1;
  lastSentDay: string | null;
  /** Each day sent, or refused for good, with the status the server answered. */
  sent: Record<string, number>;
  days: Record<string, DayCounts>;
  last?: LastSend;
}

/** What `state/usage/telemetry.json` says was sent last; nothing when it has not sent. */
export function readSent(stateDir: string): { lastSentDay: string | null; last?: LastSend } {
  const saved = readSaved(join(stateDir, "usage", "telemetry.json"));
  return { lastSentDay: saved.lastSentDay, last: saved.last };
}

function readSaved(path: string): Saved {
  const empty: Saved = { v: 1, lastSentDay: null, sent: {}, days: {} };
  const file = readJSON<unknown>(path, undefined);
  if (file === null || typeof file !== "object" || Array.isArray(file)) return empty;
  const raw = file as Record<string, unknown>;
  const saved = empty;
  if (typeof raw.lastSentDay === "string" && isDay(raw.lastSentDay)) saved.lastSentDay = raw.lastSentDay;
  if (raw.sent !== null && typeof raw.sent === "object") {
    for (const [day, status] of Object.entries(raw.sent)) if (isDay(day) && Number.isInteger(status)) saved.sent[day] = status as number;
  }
  if (raw.days !== null && typeof raw.days === "object") {
    for (const [day, counts] of Object.entries(raw.days as Record<string, unknown>)) {
      if (!isDay(day) || counts === null || typeof counts !== "object") continue;
      const { turns, devices } = counts as Record<string, unknown>;
      const kept: DayCounts = { turns: Number.isSafeInteger(turns) && (turns as number) >= 0 ? (turns as number) : 0, devices: {} };
      if (devices !== null && typeof devices === "object") {
        for (const [id, kind] of Object.entries(devices)) if (["iphone", "ipad", "mac", "other"].includes(kind as string)) kept.devices[id] = kind as DeviceKind;
      }
      saved.days[day] = kept;
    }
  }
  if (raw.last !== null && typeof raw.last === "object") {
    const last = raw.last as Partial<LastSend>;
    if (typeof last.day === "string" && Number.isInteger(last.status) && Number.isFinite(last.at) && last.body !== null && typeof last.body === "object") saved.last = last as LastSend;
  }
  return saved;
}

function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export interface TelemetryOptions {
  /** The host's state folder: `usage/install.json` and `usage/telemetry.json` are kept in it. */
  stateDir: string;
  /** config.json, whose `telemetry` is read about once a minute and written by `set`. */
  configPath: string;
  /** The host's environment: `DO_NOT_TRACK`, `PORTALS_TELEMETRY`, `PORTALS_STATS_URL`. */
  env: NodeJS.ProcessEnv;
  /**
   * The usage book (book.ts): a day's rows, and whether a scan has read past the day's end;
   * and the prices. Without them (a host whose usage could not start) nothing is sent, and
   * the switch still works.
   */
  book?: { days(from: string, to: string): DayRow[]; scan(): ScanState };
  prices?: PriceBook;
  /** The time zone the book's days are in. */
  timeZone: string;
  version: string;
  /** `process.platform` when not given. */
  os?: string;
  /** The net's id; none when the host is in no net. */
  netID?: () => string | undefined;
  /** A net member's platform ("ios", "ipados", "macos"), for the kind of device it is. */
  platformOf?: (member: string) => string | undefined;
  clock?: () => number;
  fetch?: typeof fetch;
  /** How long after `start` it first looks for a day to send (10 minutes). */
  firstMs?: number;
  /** How often it looks again (an hour). */
  everyMs?: number;
  /** How long the server may take (20 seconds). */
  answerMs?: number;
  /** The first wait after a failed send (an hour; doubled each time, up to a day). */
  backoffMs?: number;
}

/** The sender, and the counts of turns and devices it sends. One per host, started by bridge.ts. */
export class Telemetry {
  private readonly options: TelemetryOptions;
  private readonly path: string;
  private readonly clock: () => number;
  private readonly calendar: Calendar;
  private readonly saved: Saved;
  private setting: { at: number; value: TelemetrySwitch } | undefined;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | undefined;
  private firstTimer: NodeJS.Timeout | undefined;
  private everyTimer: NodeJS.Timeout | undefined;
  private sending: Promise<void> | undefined;
  private failures = 0;
  private retryAt = 0;
  private stopped = false;

  constructor(options: TelemetryOptions) {
    this.options = options;
    this.path = join(options.stateDir, "usage", "telemetry.json");
    this.clock = options.clock ?? Date.now;
    this.calendar = new Calendar(options.timeZone);
    this.saved = readSaved(this.path);
  }

  /** Whether the totals are sent, and why: config.json read again once it is a minute old. */
  switch(): TelemetrySwitch {
    const now = this.clock();
    if (!this.setting || now - this.setting.at >= switchMs) this.setting = { at: now, value: readSwitch(this.options.configPath, this.options.env) };
    return this.setting.value;
  }

  /** What `usage.telemetry` answers. */
  answer(): TelemetryAnswer {
    const now = this.switch();
    return { enabled: now.enabled, locked: now.locked, last_sent_day: this.saved.lastSentDay };
  }

  /** Sets config.json's switch (`usage.telemetry { enabled }`); off lets go of what was counted. Throws with a sentence when config.json cannot be written. */
  set(enabled: boolean): TelemetryAnswer {
    writeSwitch(this.options.configPath, enabled);
    this.setting = undefined;
    if (!this.switch().enabled) this.forget();
    return this.answer();
  }

  /** A Portals turn started (a SessionListener's `turnStarted`). */
  turnStarted(): void {
    try {
      if (this.stopped || !this.switch().enabled) return;
      this.today().turns += 1;
      this.changed();
    } catch (error) {
      log.debug("usage: a turn could not be counted", { why: (error as Error).message });
    }
  }

  /**
   * A device connected and said what it answers (`client.capabilities`, which a linked
   * Mac's call never sends). Counted once a day, by a hash of its id: a net member's id,
   * with the kind its platform says, else the id the app gave itself, as "other".
   */
  deviceConnected(signedIn: SignedIn, deviceID: string | undefined): void {
    try {
      if (this.stopped || signedIn.kind === "local" || (signedIn.kind === "member" && signedIn.member !== "device")) return;
      if (!this.switch().enabled) return;
      const member = signedIn.kind === "member";
      const id = member ? `member:${signedIn.id}` : `device:${deviceID ?? ""}`;
      const kind: DeviceKind = member ? kindOf(this.options.platformOf?.(signedIn.id)) : "other";
      const key = createHash("sha256").update(id).digest("hex").slice(0, 16);
      const devices = this.today().devices;
      if (devices[key] === kind) return;
      devices[key] = kind;
      this.changed();
    } catch (error) {
      log.debug("usage: a device could not be counted", { why: (error as Error).message });
    }
  }

  /** The body for `day`, as it would be sent now. */
  body(day: string): TelemetryDay {
    const counts = this.saved.days[day] ?? { turns: 0, devices: {} };
    const portals: Record<DeviceKind, number> = { iphone: 0, ipad: 0, mac: 0, other: 0 };
    for (const kind of Object.values(counts.devices)) portals[kind] += 1;
    const install = installID(this.options.stateDir);
    let netID: string | undefined;
    try {
      netID = this.options.netID ? this.options.netID() : readNetID(this.options.stateDir);
    } catch {
      netID = undefined;
    }
    return {
      v: 1,
      install,
      owner: ownerOf(netID && netIDPattern.test(netID) ? netID : undefined, install),
      day,
      version: this.options.version,
      os: this.options.os ?? process.platform,
      turns: counts.turns,
      portals,
      usage: this.options.book && this.options.prices ? usageRows(this.options.book.days(day, day), day, this.options.prices) : [],
    };
  }

  /** Looks now soon after start, then every hour. */
  start(): void {
    if (this.firstTimer || this.everyTimer || this.stopped) return;
    this.firstTimer = setTimeout(() => void this.tick(), this.options.firstMs ?? firstMs);
    this.firstTimer.unref();
    this.everyTimer = setInterval(() => void this.tick(), this.options.everyMs ?? everyMs);
    this.everyTimer.unref();
  }

  /** Stops the timers and saves the counts; a send under way is let finish on its own. */
  stop(): void {
    this.stopped = true;
    for (const timer of [this.firstTimer, this.saveTimer]) if (timer) clearTimeout(timer);
    if (this.everyTimer) clearInterval(this.everyTimer);
    this.firstTimer = this.everyTimer = this.saveTimer = undefined;
    this.save();
  }

  /**
   * Sends each finished day not sent yet, oldest first, of the last 7 the host was active,
   * once a scan of history has read past its end. Never rejects; one at a time.
   */
  tick(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = this.sendDue()
      // Said without the error: nothing of a day but its date and the server's status is logged.
      .catch(() => log.debug("usage: the anonymous totals could not be sent this time"))
      .finally(() => {
        this.sending = undefined;
      });
    return this.sending;
  }

  private async sendDue(): Promise<void> {
    if (this.stopped) return;
    if (!this.switch().enabled) {
      this.forget();
      return;
    }
    const now = this.clock();
    const [today] = this.calendar.at(now);
    this.prune(today);
    if (now < this.retryAt) return;
    if (!this.options.book || !this.options.prices) return;
    const scan = this.options.book.scan();
    if (scan.scanning || scan.scannedAt === undefined) return;
    const [scannedDay] = this.calendar.at(scan.scannedAt);
    const oldest = addDays(today, -daysBack);
    const due = Object.entries(this.saved.days)
      .filter(([day, counts]) => day < today && day >= oldest && day < scannedDay && this.saved.sent[day] === undefined && (counts.turns > 0 || Object.keys(counts.devices).length > 0))
      .map(([day]) => day)
      .sort();
    for (const day of due) {
      if (this.stopped || !this.switch().enabled) return;
      const body = this.body(day);
      const status = await this.post(body);
      if (status >= 200 && status < 300) {
        log.info("usage: anonymous totals sent", { day, status });
        this.saved.sent[day] = status;
        if (this.saved.lastSentDay === null || day > this.saved.lastSentDay) this.saved.lastSentDay = day;
        this.saved.last = { day, status, at: this.clock(), body };
        this.failures = 0;
        this.retryAt = 0;
        this.dirty = true;
        this.save();
      } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        // Refused as it is: sent again it would be refused again.
        log.info("usage: anonymous totals refused; the day is not sent again", { day, status });
        this.saved.sent[day] = status;
        this.dirty = true;
        this.save();
      } else {
        this.failures += 1;
        this.retryAt = this.clock() + Math.min(longestBackoffMs, (this.options.backoffMs ?? backoffMs) * 2 ** (this.failures - 1));
        log.info("usage: anonymous totals not sent; tried again later", { day, status });
        return;
      }
    }
  }

  /** The status the server answered; 0 when it did not (offline, timed out). */
  private async post(body: TelemetryDay): Promise<number> {
    try {
      const response = await (this.options.fetch ?? fetch)(statsAddress(this.options.env), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.answerMs ?? answerMs),
      });
      await response.body?.cancel().catch(() => undefined);
      return response.status;
    } catch {
      return 0;
    }
  }

  private today(): DayCounts {
    const [day] = this.calendar.at(this.clock());
    return (this.saved.days[day] ??= { turns: 0, devices: {} });
  }

  /** Off: what was counted for days not sent yet goes, so a day from before is never sent once it is on again. */
  private forget(): void {
    if (Object.keys(this.saved.days).length === 0) return;
    this.saved.days = {};
    this.dirty = true;
    this.save();
  }

  /** Days and sends older than kept go. */
  private prune(today: string): void {
    const oldest = addDays(today, -keptDays);
    for (const record of [this.saved.days, this.saved.sent]) {
      for (const day of Object.keys(record)) {
        if (day < oldest) {
          delete record[day];
          this.dirty = true;
        }
      }
    }
  }

  private changed(): void {
    this.dirty = true;
    if (this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, saveMs);
    this.saveTimer.unref();
  }

  private save(): void {
    if (!this.dirty) return;
    try {
      writeJSON(this.path, this.saved);
      this.dirty = false;
    } catch (error) {
      log.warn("usage: the anonymous totals' counts could not be saved", { why: (error as Error).message });
    }
  }
}
