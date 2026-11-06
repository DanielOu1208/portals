import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { bridgeFeatures } from "../src/gateway/features.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { Provider } from "../src/providers/types.ts";
import { Registry, type ThreadRecord } from "../src/sessions/registry.ts";
import { dayNumber, historyRangeProblem } from "../src/usage/history.ts";
import { costOf, readBundled, Prices } from "../src/usage/prices.ts";
import { realHome, testHome } from "./environment.ts";
import { createThread, offlineFetch, runTurn, startTestBridge, TestClient, type TestBridge } from "./helpers.ts";

// `usage.history` end to end (feature usage_history): a host started on a made-up person's
// history, whose threads (on the list, taken off it, taken up from the desk, started
// through Portals) say which requests went through Portals, with the dollars of now, the
// hours, the limit readings of the days asked for, and the range checked.

const folder = "/Users/dana/code/app";
const deskThread = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const removedThread = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const terminalSession = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function scratch(t: TestContext, prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

/** One request of Claude Code's, as its transcript has it. */
function request(session: string, id: string, at: string, model: string, input: number, output: number, cacheRead = 0): string {
  return `${JSON.stringify({
    type: "assistant",
    message: { model, id, role: "assistant", content: [], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } },
    requestId: `req_${id}`,
    timestamp: at,
    cwd: folder,
    sessionId: session,
  })}\n`;
}

function transcript(home: string, session: string, lines: string[]): void {
  const projects = join(home, ".claude", "projects", "-Users-dana-code-app");
  mkdirSync(projects, { recursive: true });
  appendFileSync(join(projects, `${session}.jsonl`), lines.join(""));
}

function thread(id: string, createdAt: string, origin: "phone" | "desk"): ThreadRecord {
  const at = Date.parse(createdAt) / 1000;
  return { id, agent: "fake", cwd: folder, title: null, model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: at, updatedAt: at, origin };
}

/** The scripted agent, as Claude Code: its threads' sessions are read from Claude Code's history. */
function claudeLike(t: TestContext): Provider {
  const agent = new FakeProvider({ directory: scratch(t, "portals-usage-fake-"), delayMs: 1, usage: true });
  (agent.profile as { kind: string }).kind = "claude";
  return agent;
}

async function scanned(client: TestClient, from: string, to: string, until: (answer: Record<string, any>) => boolean): Promise<Record<string, any>> {
  for (let tries = 0; tries < 200; tries += 1) {
    const answer = await client.call("usage.history", { from, to });
    if (answer.scan.scanned_at !== undefined && until(answer)) return answer;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the history was not read in time");
}

test("days are checked: two real days, from not after to, at most 400 of them", () => {
  assert.equal(dayNumber("2026-11-05"), Date.UTC(2026, 10, 5));
  assert.equal(dayNumber("2026-02-30"), undefined);
  assert.equal(dayNumber("2026-1-05"), undefined);
  assert.equal(dayNumber(20261105), undefined);
  assert.equal(historyRangeProblem("2026-11-01", "2026-11-05"), undefined);
  assert.equal(historyRangeProblem("2026-11-05", "2026-11-05"), undefined);
  assert.match(historyRangeProblem("2026-11-06", "2026-11-05")!, /after/);
  assert.match(historyRangeProblem("2026-11-06", undefined)!, /YYYY-MM-DD/);
  // 400 days inclusive is the most.
  assert.equal(historyRangeProblem("2025-10-03", "2026-11-06"), undefined);
  assert.match(historyRangeProblem("2025-10-02", "2026-11-06")!, /400/);
});

test("usage.history over the wire: Portals' sessions from the threads, the desk's before it was taken up, dollars of now, hours, limits, and a thread started through Portals", async (t) => {
  assert.ok((bridgeFeatures as readonly string[]).includes("usage_history"));
  const history = scratch(t, "portals-usage-history-");
  // Taken up from the desk at midnight on the 5th: the request on the 4th stays the desk's.
  transcript(history, deskThread, [
    request(deskThread, "msg_dana_1", "2026-11-04T10:00:00.000Z", "claude-opus-5-5", 100, 200, 1000),
    request(deskThread, "msg_dana_2", "2026-11-05T10:30:00.000Z", "claude-opus-5-5", 10, 20, 3000),
  ]);
  // A thread taken off the list went through Portals all the same.
  transcript(history, removedThread, [request(removedThread, "msg_dana_3", "2026-11-03T08:00:00.000Z", "claude-opus-5-5", 5, 6)]);
  // A session of the terminal's, on a model the price table does not have.
  transcript(history, terminalSession, [request(terminalSession, "msg_dana_4", "2026-11-05T12:00:00.000Z", "dana-model-unpriced", 7, 8)]);
  const usage = { home: history, timeZone: "UTC", pokeMs: 10, fetch: offlineFetch };

  // A host that ran before token analytics: its threads are on the list when it starts with them.
  const first = await startTestBridge({ keepHome: true, usage });
  const home = first.home;
  await first.close();
  rmSync(join(home, "state", "usage"), { recursive: true, force: true });
  const registry = new Registry(join(home, "state", "threads.json"));
  registry.add(thread(deskThread, "2026-11-05T00:00:00Z", "desk"));
  registry.add(thread(removedThread, "2026-11-01T00:00:00Z", "phone"));
  registry.remove(removedThread);
  // Limit readings kept before: one of the days asked for, one long before them.
  mkdirSync(join(home, "state", "usage"), { recursive: true });
  writeFileSync(
    join(home, "state", "usage", "limits.jsonl"),
    [
      { at: Date.now() - 80 * 86_400_000, agent: "claude", name: "weekly", percent: 3, resetsAt: null },
      { at: Date.parse("2026-11-04T09:00:00Z"), agent: "claude", name: "weekly", percent: 62, resetsAt: 1794000000, windowSeconds: 604800 },
    ].map((reading) => JSON.stringify(reading) + "\n").join(""),
  );

  const bridge: TestBridge = await startTestBridge({ home, providers: new Map<string, Provider>([["fake", claudeLike(t)]]), usage });
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });

  const answer = await scanned(client, "2026-11-03", "2026-11-05", (found) => found.days.length === 4);
  assert.equal(answer.time_zone, "UTC");
  assert.deepEqual(answer.agents, ["claude", "codex", "pi", "droid"]);
  assert.equal(answer.scan.scanning, false);
  const prices = new Prices({ stateDir: scratch(t, "portals-usage-prices-"), fetch: offlineFetch });
  const opus = prices.price("claude-opus-5-5")!;
  assert.ok(opus, "the shipped table prices the model");
  const usd = (input: number, output: number, cacheRead: number) => Math.round(costOf(opus, { input, output, cacheRead, cacheWrite: 0, cacheWrite1h: 0 }) * 1e6) / 1e6;
  const row = (day: string, model: string, via: string, input: number, output: number, cacheRead: number, dollars: number | null) => ({
    day, agent: "claude", model, folder, via, input, output, cache_read: cacheRead, cache_write: 0, cache_write_1h: 0, reasoning: 0, requests: 1, usd: dollars,
  });
  const sorted = (rows: Record<string, unknown>[]) => [...rows].sort((a, b) => `${a.day}${a.model}`.localeCompare(`${b.day}${b.model}`));
  assert.deepEqual(sorted(answer.days), [
    row("2026-11-03", "claude-opus-5-5", "portals", 5, 6, 0, usd(5, 6, 0)),
    row("2026-11-04", "claude-opus-5-5", "elsewhere", 100, 200, 1000, usd(100, 200, 1000)),
    row("2026-11-05", "claude-opus-5-5", "portals", 10, 20, 3000, usd(10, 20, 3000)),
    row("2026-11-05", "dana-model-unpriced", "elsewhere", 7, 8, 0, null),
  ]);
  const fifth = answer.hours.filter((hours: { day: string }) => hours.day === "2026-11-05");
  const portalsHours = fifth.find((hours: { via: string }) => hours.via === "portals");
  assert.equal(portalsHours.tokens.length, 24);
  assert.equal(portalsHours.tokens[10], 3030);
  assert.equal(fifth.find((hours: { via: string }) => hours.via === "elsewhere").tokens[12], 15);
  assert.deepEqual(answer.limits, [{ at: Date.parse("2026-11-04T09:00:00Z"), agent: "claude", name: "weekly", percent: 62, resets_at: 1794000000, window_seconds: 604800 }]);
  assert.equal(answer.prices_at, Date.parse(readBundled()!.at));

  // Only the days asked for.
  const one = await client.call("usage.history", { from: "2026-11-04", to: "2026-11-04" });
  assert.deepEqual(one.days.map((found: { day: string }) => found.day), ["2026-11-04"]);
  assert.deepEqual(one.limits.map((found: { percent: number }) => found.percent), [62]);

  // A thread started through Portals: its session counts from its start, read again as its turn ends.
  const started = await createThread(client);
  const today = new Date().toISOString().slice(0, 10);
  transcript(history, started, [
    request(started, "msg_dana_5", new Date(Date.now() - 3_600_000).toISOString(), "claude-opus-5-5", 1, 1),
    request(started, "msg_dana_6", new Date(Date.now() + 1000).toISOString(), "claude-opus-5-5", 2, 3),
  ]);
  await runTurn(client, started, "hello");
  // The panel's read of the plan is kept as a reading too.
  const read = await client.call("usage.read", { session_id: started });
  assert.equal(read.available, true);
  const now = await scanned(client, today, today, (found) => found.days.some((day: { via: string }) => day.via === "portals"));
  // The request an hour before it started is not Portals' (it may be yesterday's, by the clock).
  assert.deepEqual(now.days.filter((day: { via: string }) => day.via === "portals").map((day: { input: number; output: number }) => [day.input, day.output]), [[2, 3]]);
  assert.deepEqual(now.limits.map((reading: { name: string }) => reading.name).sort(), ["5-hour", "weekly", "weekly Opus"]);

  await assert.rejects(client.call("usage.history", { from: "2026-11-05", to: "2026-11-04" }), { code: -32602 });
  await assert.rejects(client.call("usage.history", { from: "2026-11-05" }), { code: -32602 });
  await assert.rejects(client.call("usage.history", { from: "2024-01-01", to: "2026-11-04" }), { code: -32602 });
});

test("a host started by the tests reads the scratch home's history, never the real one", async (t) => {
  // test/environment.ts made HOME a scratch folder and cleared CLAUDE_CONFIG_DIR, CODEX_HOME and the rest.
  assert.equal(homedir(), testHome);
  assert.notEqual(testHome, realHome);
  transcript(testHome, terminalSession, [request(terminalSession, "msg_dana_7", "2026-11-02T08:00:00.000Z", "claude-opus-5-5", 4, 4)]);
  t.after(() => rmSync(join(testHome, ".claude"), { recursive: true, force: true }));
  const bridge = await startTestBridge({ usage: { timeZone: "UTC" } });
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  const answer = await scanned(client, "2026-11-02", "2026-11-02", (found) => found.days.length > 0);
  assert.deepEqual(answer.days.map((day: { input: number; via: string }) => [day.input, day.via]), [[4, "elsewhere"]]);
});
