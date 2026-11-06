import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays } from "../src/dates.ts";
import type { Summary } from "../src/summary.ts";
import { summary } from "../src/summary.ts";
import { access, dayBody, get, post, server, token, usageRow } from "./helpers.ts";

// GET /api/summary: active users are owners, not installs, and the numbers add up.

const TODAY = "2026-11-06";
const owner = (n: number) => n.toString(16).padStart(32, "0");
const install = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

async function send(handle: (request: Request) => Promise<Response>, body: Record<string, unknown>) {
  const response = await handle(post(body));
  assert.equal(response.status, 204);
}

async function read(handle: (request: Request) => Promise<Response>, days: number): Promise<Summary> {
  const response = await handle(get(`/api/summary?days=${days}`, token()));
  assert.equal(response.status, 200);
  return (await response.json()) as Summary;
}

test("a person's Macs make one active user and several hosts", async () => {
  const { handle } = server({ access: access().check });
  // Dana has two Macs in one net (one owner); a second person has one Mac in no net.
  await send(handle, dayBody({ install: install(1), owner: owner(1), turns: 10, portals: { iphone: 1, ipad: 1, mac: 1, other: 0 },
    usage: [usageRow({ agent: "claude", model: "claude-opus-5-5", input: 100, output: 50, cache_read: 1000, cache_write: 10, reasoning: 5, requests: 3, usd: 1.5 })] }));
  await send(handle, dayBody({ install: install(2), owner: owner(1), turns: 5, version: "0.3.4", portals: { iphone: 1, ipad: 0, mac: 2, other: 0 },
    usage: [usageRow({ agent: "codex", model: "gpt-5.5-codex", input: 200, output: 20, cache_read: 0, cache_write: 0, reasoning: 10, requests: 2, usd: 0.25 })] }));
  await send(handle, dayBody({ install: install(3), owner: install(3), turns: 1, os: "linux", portals: { iphone: 0, ipad: 0, mac: 0, other: 1 },
    usage: [usageRow({ agent: "claude", model: "other", input: 1, output: 1, cache_read: 0, cache_write: 0, reasoning: 0, requests: 1, usd: null })] }));

  const result = await read(handle, 7);
  assert.equal(result.from, "2026-10-31");
  assert.equal(result.to, TODAY);
  assert.equal(result.days.length, 7);
  const day = result.days.find((entry) => entry.day === "2026-11-05")!;
  assert.equal(day.dau, 2);
  assert.equal(day.hosts, 3);
  assert.equal(day.turns, 16);
  // Per owner the most any of its hosts saw: Dana's phone counts once, her two Macs' Mac counts as 2.
  assert.deepEqual(day.devices, { iphone: 1, ipad: 1, mac: 2, other: 1 });
  assert.deepEqual(day.tokens, { input: 301, output: 71, cache_read: 1000, cache_write: 10, reasoning: 15, total: 1382 });
  assert.deepEqual(day.by_agent, { claude: 1162, codex: 220 });
  assert.equal(day.requests, 6);
  assert.equal(day.usd, 1.75);
  assert.equal(day.wau, 2);
  assert.equal(day.mau, 2);
  // Today nobody has sent yet, but yesterday's users are still this week's.
  const today = result.days.at(-1)!;
  assert.equal(today.dau, 0);
  assert.equal(today.wau, 2);

  assert.deepEqual(result.totals, { owners: 2, hosts: 3, turns: 16, requests: 6, tokens: day.tokens, usd: 1.75 });
  assert.deepEqual(result.agents, ["claude", "codex"]);
  assert.deepEqual(result.mix.agents, [
    { name: "claude", tokens: 1162, requests: 4, usd: 1.5, owners: 2 },
    { name: "codex", tokens: 220, requests: 2, usd: 0.25, owners: 1 },
  ]);
  assert.deepEqual(result.mix.models.map((row) => row.name), ["claude-opus-5-5", "gpt-5.5-codex", "other"]);
  assert.deepEqual(result.mix.versions, [{ name: "0.3.3", hosts: 2 }, { name: "0.3.4", hosts: 1 }]);
  assert.deepEqual(result.mix.os, [{ name: "darwin", hosts: 2 }, { name: "linux", hosts: 1 }]);
});

test("a host's version is the last it sent in the range", async () => {
  const { handle } = server({ access: access().check });
  await send(handle, dayBody({ day: "2026-11-03", version: "0.3.2" }));
  await send(handle, dayBody({ day: "2026-11-05", version: "0.3.3" }));
  await send(handle, dayBody({ day: "2026-11-04", version: "0.3.2" }));
  assert.deepEqual((await read(handle, 7)).mix.versions, [{ name: "0.3.3", hosts: 1 }]);
});

test("weekly and monthly actives match counting owners day by day", async () => {
  const { db } = server();
  // 40 owners over 120 days, each active on a scattered set of days (some on several hosts).
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const active = new Map<string, Set<string>>();
  for (let n = 1; n <= 40; n++) {
    for (let ago = 0; ago < 120; ago++) {
      if (random() > 0.12 + (n % 5) * 0.05) continue;
      const day = addDays(TODAY, -ago);
      const hosts = 1 + Math.floor(random() * 2);
      for (let h = 0; h < hosts; h++) {
        db.sqlite.prepare("INSERT INTO days VALUES (?, ?, ?, '0.3.3', 'darwin', 1, 0, 0, 1, 0, 0)").run(day, install(n * 10 + h), owner(n));
      }
      if (!active.has(day)) active.set(day, new Set());
      active.get(day)!.add(owner(n));
    }
  }
  const distinct = (end: string, span: number) => {
    const owners = new Set<string>();
    for (let back = 0; back < span; back++) for (const who of active.get(addDays(end, -back)) ?? []) owners.add(who);
    return owners.size;
  };
  const result = await summary(db, 90, TODAY);
  for (const day of result.days) {
    assert.equal(day.dau, active.get(day.day)?.size ?? 0, `dau ${day.day}`);
    assert.equal(day.wau, distinct(day.day, 7), `wau ${day.day}`);
    assert.equal(day.mau, distinct(day.day, 30), `mau ${day.day}`);
  }
});

test("the range is 1 to 365 days, 30 when not given", async () => {
  const { handle } = server({ access: access().check });
  assert.equal((await read(handle, 1)).days.length, 1);
  assert.equal((await read(handle, 365)).days.length, 365);
  const fallback = (await (await handle(get("/api/summary", token()))).json()) as Summary;
  assert.equal(fallback.days.length, 30);
  for (const days of ["0", "366", "-1", "7.5", "abc", "1e2"]) {
    assert.equal((await handle(get(`/api/summary?days=${days}`, token()))).status, 400, days);
  }
});

test("the summary is quick with a year of many hosts", async () => {
  const { db } = server();
  const insertDay = db.sqlite.prepare("INSERT INTO days VALUES (?, ?, ?, '0.3.3', 'darwin', 3, 1, 0, 1, 0, 0)");
  const insertUsage = db.sqlite.prepare("INSERT INTO usage VALUES (?, ?, ?, ?, 10, 100, 100, 1000, 10, 0, 0.1)");
  db.sqlite.exec("BEGIN");
  for (let ago = 0; ago < 365; ago++) {
    const day = addDays(TODAY, -ago);
    for (let n = 0; n < 200; n++) {
      if ((n + ago) % 3 === 0) continue;
      insertDay.run(day, install(n), owner(Math.floor(n / 2)));
      insertUsage.run(day, install(n), n % 2 ? "claude" : "codex", n % 2 ? "claude-opus-5-5" : "gpt-5.5-codex");
    }
  }
  db.sqlite.exec("COMMIT");
  const started = performance.now();
  const result = await summary(db, 365, TODAY);
  const took = performance.now() - started;
  assert.equal(result.days.length, 365);
  assert.ok(result.days.every((day) => day.mau >= day.wau && day.wau >= day.dau));
  assert.ok(took < 2000, `took ${Math.round(took)} ms`);
});
