import type { D1Database } from "./d1.ts";
import { addDays } from "./dates.ts";

// GET /api/summary?days=N: what the page draws, worked out in D1 so only a few hundred
// rows come back whatever the number of hosts. Active users are owners (one per person's
// net, docs/plans/2026-11-06-token-analytics.md, section 6), never installs: a person with
// three Macs is one daily active user and three active hosts.

export const longestRange = 365;
/** The models listed by name; the rest are added up in `other_models`. */
const modelsListed = 24;

export interface TokenTypes {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** Already inside `output`; never added to `total`. */
  reasoning: number;
  /** input + output + cache_read + cache_write. */
  total: number;
}

export interface SummaryDay {
  day: string;
  /** Distinct owners who sent this day. */
  dau: number;
  /** Distinct owners who sent any of the 7 days ending this one. */
  wau: number;
  /** Distinct owners who sent any of the 30 days ending this one. */
  mau: number;
  /** Distinct installs who sent this day. */
  hosts: number;
  turns: number;
  /** Devices by kind: for each owner the most any one of its hosts saw, added up. */
  devices: { iphone: number; ipad: number; mac: number; other: number };
  requests: number;
  tokens: TokenTypes;
  /** Total tokens by agent. */
  by_agent: Record<string, number>;
  usd: number;
}

export interface MixRow {
  name: string;
  tokens: number;
  requests: number;
  usd: number;
  /** Distinct owners who used it in the range. */
  owners: number;
}

export interface Summary {
  from: string;
  to: string;
  days: SummaryDay[];
  /** The agents seen in the range, most tokens first. */
  agents: string[];
  totals: { owners: number; hosts: number; turns: number; requests: number; tokens: TokenTypes; usd: number };
  mix: {
    agents: MixRow[];
    models: MixRow[];
    other_models: { tokens: number; usd: number; count: number };
    /** Hosts by the version and OS each sent last in the range. */
    versions: { name: string; hosts: number }[];
    os: { name: string; hosts: number }[];
  };
}

type Row = Record<string, string | number | null>;

/** The `days` days ending with `today`, the server's UTC date. */
export async function summary(db: D1Database, days: number, today: string): Promise<Summary> {
  const from = addDays(today, 1 - days);
  const to = today;
  const range = (sql: string) => db.prepare(sql).bind(from, to).all<Row>();

  const [perDay, perAgent, actives, agents, models, hosts, totals] = await Promise.all([
    // Owners first, so a person's hosts make one active user and their devices are not
    // counted once per Mac: each Mac sees the same phone.
    range(
      `SELECT day, COUNT(*) AS dau, SUM(hosts) AS hosts, SUM(turns) AS turns,
              SUM(iphone) AS iphone, SUM(ipad) AS ipad, SUM(mac) AS mac, SUM(other) AS other
       FROM (SELECT day, owner, COUNT(*) AS hosts, SUM(turns) AS turns,
                    MAX(portals_iphone) AS iphone, MAX(portals_ipad) AS ipad, MAX(portals_mac) AS mac, MAX(portals_other) AS other
             FROM days WHERE day BETWEEN ? AND ? GROUP BY day, owner)
       GROUP BY day`,
    ),
    range(
      `SELECT day, agent, SUM(requests) AS requests, SUM(input) AS input, SUM(output) AS output,
              SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(reasoning) AS reasoning, TOTAL(usd) AS usd
       FROM usage WHERE day BETWEEN ? AND ? GROUP BY day, agent`,
    ),
    // Weekly and monthly actives for every day at once. Each owner's active days, in
    // order, are turned into spans: from an active day until 7 (or 30) days later, or
    // until the owner's next active day if that comes sooner, so an owner's spans never
    // overlap. The answer is where spans start and stop, and the actives of a day are the
    // starts minus the stops up to it. The days before `from` that reach into it are read too.
    db
      .prepare(
        `WITH active AS (SELECT DISTINCT owner, day FROM days WHERE day BETWEEN ? AND ?),
              spans AS (SELECT day, LEAD(day) OVER (PARTITION BY owner ORDER BY day) AS next FROM active)
         SELECT at, SUM(week) AS week, SUM(month) AS month FROM (
           SELECT day AS at, 1 AS week, 1 AS month FROM spans
           UNION ALL SELECT min(date(day, '+7 days'), COALESCE(next, '9999-12-31')), -1, 0 FROM spans
           UNION ALL SELECT min(date(day, '+30 days'), COALESCE(next, '9999-12-31')), 0, -1 FROM spans
         ) GROUP BY at ORDER BY at`,
      )
      .bind(addDays(from, -29), to)
      .all<Row>(),
    range(mixQuery("agent")),
    range(mixQuery("model")),
    // With MAX(day) the only aggregate, SQLite (and so D1) takes each install's version
    // and OS from the row of its latest day.
    range(
      `SELECT version, os, COUNT(*) AS hosts
       FROM (SELECT install, version, os, MAX(day) AS last FROM days WHERE day BETWEEN ? AND ? GROUP BY install)
       GROUP BY version, os`,
    ),
    range(`SELECT COUNT(DISTINCT owner) AS owners, COUNT(DISTINCT install) AS hosts, TOTAL(turns) AS turns FROM days WHERE day BETWEEN ? AND ?`),
  ]);

  const byDay = new Map<string, SummaryDay>();
  const list: SummaryDay[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const entry: SummaryDay = {
      day,
      dau: 0,
      wau: 0,
      mau: 0,
      hosts: 0,
      turns: 0,
      devices: { iphone: 0, ipad: 0, mac: 0, other: 0 },
      requests: 0,
      tokens: noTokens(),
      by_agent: {},
      usd: 0,
    };
    byDay.set(day, entry);
    list.push(entry);
  }

  for (const row of perDay.results) {
    const entry = byDay.get(String(row.day));
    if (!entry) continue;
    entry.dau = num(row.dau);
    entry.hosts = num(row.hosts);
    entry.turns = num(row.turns);
    entry.devices = { iphone: num(row.iphone), ipad: num(row.ipad), mac: num(row.mac), other: num(row.other) };
  }

  const totalTokens = noTokens();
  let totalRequests = 0;
  let totalUsd = 0;
  for (const row of perAgent.results) {
    const entry = byDay.get(String(row.day));
    if (!entry) continue;
    const tokens = tokenTypes(row);
    addTokens(entry.tokens, tokens);
    addTokens(totalTokens, tokens);
    entry.by_agent[String(row.agent)] = (entry.by_agent[String(row.agent)] ?? 0) + tokens.total;
    entry.requests += num(row.requests);
    entry.usd += num(row.usd);
    totalRequests += num(row.requests);
    totalUsd += num(row.usd);
  }

  let week = 0;
  let month = 0;
  let next = 0;
  const events = actives.results;
  for (const entry of list) {
    while (next < events.length && String(events[next].at) <= entry.day) {
      week += num(events[next].week);
      month += num(events[next].month);
      next++;
    }
    entry.wau = week;
    entry.mau = month;
  }

  const agentMix = agents.results.map(mixRow);
  const modelMix = models.results.map(mixRow);
  const listed = modelMix.slice(0, modelsListed);
  const rest = modelMix.slice(modelsListed);
  const versions = new Map<string, number>();
  const systems = new Map<string, number>();
  for (const row of hosts.results) {
    versions.set(String(row.version), (versions.get(String(row.version)) ?? 0) + num(row.hosts));
    systems.set(String(row.os), (systems.get(String(row.os)) ?? 0) + num(row.hosts));
  }
  const count = totals.results[0] ?? {};

  return {
    from,
    to,
    days: list,
    agents: agentMix.map((row) => row.name),
    totals: { owners: num(count.owners), hosts: num(count.hosts), turns: num(count.turns), requests: totalRequests, tokens: totalTokens, usd: totalUsd },
    mix: {
      agents: agentMix,
      models: listed,
      other_models: { tokens: rest.reduce((sum, row) => sum + row.tokens, 0), usd: rest.reduce((sum, row) => sum + row.usd, 0), count: rest.length },
      versions: ranked(versions),
      os: ranked(systems),
    },
  };
}

function mixQuery(column: "agent" | "model"): string {
  return `SELECT u.${column} AS name, SUM(u.requests) AS requests,
                 SUM(u.input + u.output + u.cache_read + u.cache_write) AS tokens,
                 TOTAL(u.usd) AS usd, COUNT(DISTINCT d.owner) AS owners
          FROM usage u JOIN days d ON d.day = u.day AND d.install = u.install
          WHERE u.day BETWEEN ? AND ?
          GROUP BY u.${column} ORDER BY tokens DESC, name`;
}

function mixRow(row: Row): MixRow {
  return { name: String(row.name), tokens: num(row.tokens), requests: num(row.requests), usd: num(row.usd), owners: num(row.owners) };
}

function ranked(counts: Map<string, number>): { name: string; hosts: number }[] {
  return [...counts].map(([name, hosts]) => ({ name, hosts })).sort((a, b) => b.hosts - a.hosts || a.name.localeCompare(b.name));
}

function noTokens(): TokenTypes {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0 };
}

function tokenTypes(row: Row): TokenTypes {
  const input = num(row.input);
  const output = num(row.output);
  const cacheRead = num(row.cache_read);
  const cacheWrite = num(row.cache_write);
  return { input, output, cache_read: cacheRead, cache_write: cacheWrite, reasoning: num(row.reasoning), total: input + output + cacheRead + cacheWrite };
}

function addTokens(into: TokenTypes, tokens: TokenTypes): void {
  into.input += tokens.input;
  into.output += tokens.output;
  into.cache_read += tokens.cache_read;
  into.cache_write += tokens.cache_write;
  into.reasoning += tokens.reasoning;
  into.total += tokens.total;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
