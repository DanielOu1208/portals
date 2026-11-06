import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setLogLevel } from "../src/log.ts";
import type { Provider, UsageReport } from "../src/providers/types.ts";
import { LimitLog, LimitSampler, limitsKeptMs, watchLimits } from "../src/usage/limits.ts";

// The plans' limits over time (src/usage/limits.ts): every reading kept with its time in
// limits.jsonl, one the same as the last of its window not kept again, 90 days of them,
// every answer an agent gives kept whoever asked, and one asked every 15 minutes only
// while a thread runs.

setLogLevel("silent");

function folder(): string {
  return join(mkdtempSync(join(tmpdir(), "portals-usage-limits-")), "usage");
}

const weekly = (percent: number, extra: Partial<UsageReport["limits"][number]> = {}) => ({ name: "weekly", percent, resetsAt: 1794000000, windowSeconds: 604800, ...extra });

test("a reading the same as its window's last is not kept; a change, or a window of another agent, is", () => {
  const usage = folder();
  let now = Date.parse("2026-11-05T10:00:00Z");
  const limits = new LimitLog({ folder: usage, clock: () => now });
  assert.equal(limits.heard("claude", { limits: [weekly(40), { name: "5-hour", percent: 10, resetsAt: 1793900000, windowSeconds: 18000 }] }), 2);
  now += 60_000;
  assert.equal(limits.heard("claude", { limits: [weekly(40), { name: "5-hour", percent: 10, resetsAt: 1793900000, windowSeconds: 18000 }] }), 0);
  now += 60_000;
  assert.equal(limits.heard("claude", { limits: [weekly(41)] }), 1);
  // The same window of another agent is another window.
  assert.equal(limits.heard("codex", { limits: [weekly(41)] }), 1);
  // A new window after a reset, at the same share: its reset time moved.
  now += 60_000;
  assert.equal(limits.heard("claude", { limits: [weekly(41, { resetsAt: 1794604800 })] }), 1);
  // No share said: nothing to keep.
  assert.equal(limits.heard("claude", { limits: [{ name: "weekly Opus", percent: null, resetsAt: null }] }), 0);

  const lines = readFileSync(join(usage, "limits.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 5);
  assert.deepEqual(lines[0], { at: Date.parse("2026-11-05T10:00:00Z"), agent: "claude", name: "weekly", percent: 40, resetsAt: 1794000000, windowSeconds: 604800 });

  // Read again at a start: the last of each window is known, so the same reading is still not kept.
  const again = new LimitLog({ folder: usage, clock: () => now + 60_000 });
  assert.equal(again.all().length, 5);
  assert.equal(again.heard("claude", { limits: [weekly(41, { resetsAt: 1794604800 })] }), 0);
});

test("a window kept from an earlier answer keeps its own time, and one older than its window's last is not kept", () => {
  const now = Date.parse("2026-11-05T10:00:00Z");
  const limits = new LimitLog({ folder: folder(), clock: () => now });
  limits.heard("claude", { limits: [weekly(50)] });
  limits.heard("claude", { limits: [weekly(45, { heardAt: now - 3_600_000 }), { name: "5-hour", percent: 7, resetsAt: null, heardAt: now - 7_200_000 }] });
  assert.deepEqual(limits.all().map((reading) => [reading.name, reading.percent, reading.at]), [
    ["5-hour", 7, now - 7_200_000],
    ["weekly", 50, now],
  ]);
  // Limits only as last heard (no Claude Code could be asked): the report's own time.
  limits.heard("codex", { limits: [weekly(9)], heardAt: now - 60_000 });
  assert.equal(limits.between(now - 61_000, now - 59_000)[0].agent, "codex");
});

test("90 days are kept: older readings are dropped as the file is read, and once a day as readings come", () => {
  const usage = folder();
  const now = Date.parse("2026-11-05T10:00:00Z");
  let clock = now;
  mkdirSync(usage, { recursive: true });
  const line = (at: number, percent: number) => JSON.stringify({ at, agent: "claude", name: "weekly", percent, resetsAt: null }) + "\n";
  const file = join(usage, "limits.jsonl");
  writeFileSync(file, line(now - limitsKeptMs - 1, 1) + "not json\n" + line(now - limitsKeptMs + 1000, 2) + JSON.stringify({ at: now, agent: "fake", name: "weekly", percent: 3 }) + "\n" + line(now - 1000, 4));
  const limits = new LimitLog({ folder: usage, clock: () => clock });
  assert.deepEqual(limits.all().map((reading) => reading.percent), [2, 4]);
  assert.equal(readFileSync(file, "utf8"), line(now - limitsKeptMs + 1000, 2) + line(now - 1000, 4));

  // A host that runs on: a day later the oldest is past 90 days, but not by a day yet, and the reading is appended.
  clock = now + 86_400_000;
  limits.heard("claude", { limits: [{ name: "weekly", percent: 5, resetsAt: null }] });
  assert.equal(readFileSync(file, "utf8"), line(now - limitsKeptMs + 1000, 2) + line(now - 1000, 4) + line(clock, 5));
  // A day after that, what is past 90 days goes as a reading comes, and the file is written again without it.
  clock = now + 2 * 86_400_000;
  limits.heard("claude", { limits: [{ name: "weekly", percent: 6, resetsAt: null }] });
  assert.deepEqual(limits.all().map((reading) => reading.percent), [4, 5, 6]);
  assert.equal(readFileSync(file, "utf8"), line(now - 1000, 4) + line(now + 86_400_000, 5) + line(clock, 6));
});

/** A provider with `usage`, for the tests. */
function agent(kind: string, answer: () => Promise<UsageReport>): Provider & { asked: number } {
  const provider = {
    asked: 0,
    profile: { name: kind, kind, displayName: kind, description: "", model: "", provider: "" },
    async usage() {
      provider.asked += 1;
      return answer();
    },
  };
  return provider as unknown as Provider & { asked: number };
}

test("every answer an agent gives is kept, and what it says by itself; an agent whose usage is never read is not watched", async () => {
  const now = Date.parse("2026-11-05T10:00:00Z");
  const limits = new LimitLog({ folder: folder(), clock: () => now });
  let percent = 20;
  const claude = agent("claude", async () => ({ limits: [weekly(percent)] }));
  watchLimits(claude, limits);
  assert.deepEqual(await claude.usage!("thread", { fresh: true }), { limits: [weekly(20)] });
  percent = 21;
  await claude.usage!(undefined);
  assert.deepEqual(limits.all().map((reading) => reading.percent), [20, 21]);
  claude.onLimits!({ limits: [{ name: "5-hour", percent: 3, resetsAt: null }] });
  assert.equal(limits.all().length, 3);
  // An answer that fails is the asker's to hear.
  const failing = agent("codex", async () => {
    throw new Error("signed out");
  });
  watchLimits(failing, limits);
  await assert.rejects(failing.usage!(undefined), /signed out/);

  const scripted = agent("fake", async () => ({ limits: [weekly(1)] }));
  watchLimits(scripted, limits);
  await scripted.usage!(undefined);
  assert.equal(scripted.onLimits, undefined);
  assert.equal(limits.all().length, 3);
});

test("a reading is asked for every 15 minutes while a thread runs, of each agent with one running, and never while none does", async () => {
  let now = Date.parse("2026-11-05T10:00:00Z");
  const claude = agent("claude", async () => ({ limits: [] }));
  const codex = agent("codex", async () => ({ limits: [] }));
  const quiet = { profile: { name: "pi", kind: "pi", displayName: "Pi", description: "", model: "", provider: "" } } as unknown as Provider;
  let running: { thread: string; provider: Provider }[] = [];
  const asked: [string, string][] = [];
  const sampler = new LimitSampler({
    running: () => running,
    ask: async (provider, thread) => {
      asked.push([provider.profile.name, thread]);
      return provider.usage!(thread);
    },
    clock: () => now,
  });
  assert.equal(sampler.check(), 0);
  running = [{ thread: "t1", provider: claude }, { thread: "t2", provider: claude }, { thread: "t3", provider: codex }, { thread: "t4", provider: quiet }];
  assert.equal(sampler.check(), 2);
  assert.deepEqual(asked, [["claude", "t1"], ["codex", "t3"]]);
  now += 14 * 60_000;
  assert.equal(sampler.check(), 0);
  now += 60_000;
  running = [];
  assert.equal(sampler.check(), 0);
  running = [{ thread: "t3", provider: codex }];
  assert.equal(sampler.check(), 1);
  assert.deepEqual(asked.at(-1), ["codex", "t3"]);
  // One whose asking fails costs nothing, and what lists the threads failing neither.
  const sampled = new LimitSampler({ running: () => { throw new Error("no list"); }, ask: async () => ({ limits: [] }) });
  assert.equal(sampled.check(), 0);
  const refused = new LimitSampler({ running: () => [{ thread: "t1", provider: claude }], ask: async () => { throw new Error("no"); } });
  assert.equal(refused.check(), 1);
  await new Promise((resolve) => setImmediate(resolve));
  sampler.start();
  sampler.stop();
});
