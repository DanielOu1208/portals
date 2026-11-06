import type { D1Database } from "./d1.ts";
import { addDays, isDay } from "./dates.ts";

// One host's day of anonymous totals, as POST /v1/day takes it (the body in
// docs/plans/2026-11-06-token-analytics.md, section 6, sent by bridge/src/usage/telemetry.ts).
// Anyone can send one, so the body is checked strictly: only the known keys, every value
// of its type, every size capped. What does not pass is refused whole, and nothing of it
// is kept or repeated back.

/** How far back a day may be: the host sends at most the last 7, retried while offline. */
export const oldestDayAgo = 14;
/** The usage rows a day may hold: a host's agents times the models it prices. */
export const usageRowLimit = 64;

/** The day as the server keeps it. */
export interface Day {
  day: string;
  install: string;
  owner: string;
  version: string;
  os: string;
  turns: number;
  portals: { iphone: number; ipad: number; mac: number; other: number };
  usage: UsageRow[];
}

export interface UsageRow {
  agent: string;
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** Null when the host has no price for the model. */
  usd: number | null;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The owner is a hash of the host's net id, or the host's install id when it is in no net.
const ownerPattern = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
// Node's process.platform: "darwin", "linux", "win32".
const osPattern = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const agentPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
// Model names as the price table has them ("claude-opus-5-5", "gpt-5.5-codex",
// "openrouter/x-ai/grok-4", "gemini-3-pro@001"); nothing that could be markup or a sentence.
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,63}$/;

// The largest believable values. A heavy day for one model is around a billion tokens,
// almost all of it read from the cache.
const turnLimit = 1_000_000;
const deviceLimit = 1_000;
const requestLimit = 10_000_000;
const tokenLimit = 1_000_000_000_000;
const usdLimit = 1_000_000;

const topKeys = ["v", "install", "owner", "day", "version", "os", "turns", "portals", "usage"];
const portalKeys = ["iphone", "ipad", "mac", "other"];
const usageKeys = ["agent", "model", "requests", "input", "output", "cache_read", "cache_write", "reasoning", "usd"];

/**
 * The day `body` sends, or null when it is not one: an unknown or missing key, a value of
 * the wrong type, too big or too long, or a day more than `oldestDayAgo` days before
 * `today` (UTC) or after it. Rows for the same agent and model are added together (a host
 * sends every model its price table does not know as "other").
 */
export function parseDay(body: unknown, today: string): Day | null {
  if (!hasExactly(body, topKeys) || body.v !== 1) return null;
  const { install, owner, day, version, os, turns, portals, usage } = body;
  if (!matches(install, uuid) || !matches(owner, ownerPattern)) return null;
  if (typeof day !== "string" || !isDay(day) || day > today || day < addDays(today, -oldestDayAgo)) return null;
  if (!matches(version, versionPattern) || !matches(os, osPattern)) return null;
  if (!isCount(turns, turnLimit)) return null;
  if (!hasExactly(portals, portalKeys) || !portalKeys.every((key) => isCount(portals[key], deviceLimit))) return null;
  if (!Array.isArray(usage) || usage.length > usageRowLimit) return null;

  const rows = new Map<string, UsageRow>();
  for (const item of usage) {
    const row = parseUsage(item);
    if (!row) return null;
    const key = `${row.agent}\n${row.model}`;
    const earlier = rows.get(key);
    rows.set(key, earlier ? addRows(earlier, row) : row);
  }
  const added = [...rows.values()];
  if (added.some((row) => !withinLimits(row))) return null;

  return {
    day,
    install,
    owner,
    version,
    os,
    turns: turns as number,
    portals: { iphone: portals.iphone as number, ipad: portals.ipad as number, mac: portals.mac as number, other: portals.other as number },
    usage: added,
  };
}

function parseUsage(item: unknown): UsageRow | null {
  if (!hasExactly(item, usageKeys)) return null;
  const { agent, model, usd } = item;
  if (!matches(agent, agentPattern) || !matches(model, modelPattern)) return null;
  if (usd !== null && !(typeof usd === "number" && Number.isFinite(usd) && usd >= 0 && usd <= usdLimit)) return null;
  const row = {
    agent,
    model,
    requests: item.requests,
    input: item.input,
    output: item.output,
    cacheRead: item.cache_read,
    cacheWrite: item.cache_write,
    reasoning: item.reasoning,
    usd,
  };
  if (!isCount(row.requests, requestLimit)) return null;
  for (const tokens of [row.input, row.output, row.cacheRead, row.cacheWrite, row.reasoning]) {
    if (!isCount(tokens, tokenLimit)) return null;
  }
  return row as UsageRow;
}

function addRows(a: UsageRow, b: UsageRow): UsageRow {
  return {
    agent: a.agent,
    model: a.model,
    requests: a.requests + b.requests,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    usd: a.usd === null && b.usd === null ? null : (a.usd ?? 0) + (b.usd ?? 0),
  };
}

// Rows added together are held to the same caps as one row.
function withinLimits(row: UsageRow): boolean {
  return (
    row.requests <= requestLimit &&
    [row.input, row.output, row.cacheRead, row.cacheWrite, row.reasoning].every((tokens) => tokens <= tokenLimit) &&
    (row.usd === null || row.usd <= usdLimit)
  );
}

/**
 * Keeps `day` in one transaction, in place of whatever that install sent for that day
 * before: a resend (after a retry, or with counts the host has since corrected) never
 * counts twice, and a reader never sees half of it.
 */
export async function writeDay(db: D1Database, day: Day, receivedAt: number): Promise<void> {
  const statements = [
    db.prepare("DELETE FROM usage WHERE day = ? AND install = ?").bind(day.day, day.install),
    db
      .prepare(
        `INSERT OR REPLACE INTO days (day, install, owner, version, os, turns, portals_iphone, portals_ipad, portals_mac, portals_other, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(day.day, day.install, day.owner, day.version, day.os, day.turns, day.portals.iphone, day.portals.ipad, day.portals.mac, day.portals.other, receivedAt),
    ...day.usage.map((row) =>
      db
        .prepare(
          `INSERT INTO usage (day, install, agent, model, requests, input, output, cache_read, cache_write, reasoning, usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(day.day, day.install, row.agent, row.model, row.requests, row.input, row.output, row.cacheRead, row.cacheWrite, row.reasoning, row.usd),
    ),
  ];
  await db.batch(statements);
}

function hasExactly(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function isCount(value: unknown, limit: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= limit;
}
