import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatch, usageText } from "../src/gateway/commands.ts";
import { HeardLimits, planUsageReport } from "../src/providers/claude/usage.ts";
import { usageReport } from "../src/providers/codex/stream.ts";
import type { Provider } from "../src/providers/types.ts";
import type { Session } from "../src/sessions/session.ts";
import { fakeClaude, planUsage } from "./claude-fixtures.ts";

// `/usage` as the thread shows it, from what each agent says, at fixed times (UTC).

test("Claude Code's own /usage answer: its windows and a model's own, used up when full, extra usage as a line of its own", () => {
  const report = planUsageReport({
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 41.6, resets_at: "2026-10-14T21:00:00Z" },
      seven_day: { utilization: 12, resets_at: "2026-10-19T09:00:00.000Z" },
      seven_day_opus: null,
      spend: { utilization: null, resets_at: null },
      model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "2026-10-19T09:00:00Z" }, { utilization: 3 }],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 250, utilization: 5 },
    },
  });
  assert.equal(
    usageText("Claude Code", report!, "UTC"),
    [
      "Claude Code usage, Max plan:",
      "5-hour: 42% used, resets Wed 9:00 PM",
      "Weekly: 12% used, resets Mon 9:00 AM",
      "Weekly Fable: used up, resets Mon 9:00 AM",
      "Extra usage: 5% of this month's limit used.",
    ].join("\n"),
  );
  // Signed in with an API key: no plan, no limits.
  assert.equal(
    usageText("Claude Code", planUsageReport({ subscription_type: null, rate_limits_available: false, rate_limits: null })!),
    "Claude Code usage:\nNo plan limits apply: Claude Code is not using a Claude plan's sign-in here (an API key has none).",
  );
  // A plan whose limits Claude Code could not read just now: none to give, not none at all.
  assert.equal(planUsageReport({ subscription_type: "max", rate_limits_available: true, rate_limits: null }), null);
});

test("a plan whose limits Claude Code could not read just now: the windows the turns last reported, with the plan", async () => {
  const { provider } = fakeClaude({ now: () => Date.parse("2026-10-14T11:12:00Z") });
  provider.limitsHeard({ status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: 1791337800 });
  planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: null };
  try {
    assert.equal(
      usageText("Claude Code", await provider.usage("a-thread"), "UTC"),
      ["Claude Code usage, Max plan:", "5-hour: 42% used, resets Wed 1:50 AM", "As Claude Code last said, Wed 11:12 AM."].join("\n"),
    );
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("a model's own window, used or not, kept from the answer that said it for one that leaves it out, until it resets", async () => {
  let now = Date.parse("2026-11-01T20:00:00Z");
  const { provider } = fakeClaude({ now: () => now });
  const weekly = { utilization: 66, resets_at: "2026-11-30T02:00:00Z" };
  try {
    // A Claude Code started just to ask: Fable's window, nothing used of it.
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { seven_day: weekly, model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-11-03T02:00:00Z" }] } };
    const names = async () => (await provider.usage("a-thread")).limits.map((limit) => `${limit.name} ${limit.percent}`);
    assert.deepEqual(await names(), ["weekly 66", "weekly Fable 0"]);
    // A running one's answer from what it fetched before: nothing said of it, so as last said.
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { seven_day: weekly } };
    assert.deepEqual(await names(), ["weekly 66", "weekly Fable 0"]);
    // Past its reset, not any more.
    now = Date.parse("2026-11-03T03:00:00Z");
    assert.deepEqual(await names(), ["weekly 66"]);
    // An answer that lists none: none.
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { seven_day: weekly, model_scoped: [] } };
    assert.deepEqual(await names(), ["weekly 66"]);
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("a kept window says when it was said, one with no reset time goes after a week, and windows said replace those kept", async () => {
  let now = Date.parse("2026-11-01T20:00:00Z");
  const said = now;
  const { provider } = fakeClaude({ now: () => now });
  const asked = async () => (await provider.usage("a-thread")).limits.map((limit) => [limit.name, limit.percent, limit.heardAt ?? null]);
  const reports = async () => {
    // Past the ten minutes one started only to ask stands for.
    now += 11 * 60_000;
    return asked();
  };
  const weekly = { utilization: 66, resets_at: "2026-11-30T02:00:00Z" };
  try {
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { seven_day: weekly, model_scoped: [{ display_name: "Fable", utilization: 3, resets_at: null }] } };
    assert.deepEqual(await asked(), [["weekly", 66, null], ["weekly Fable", 3, null]]);
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { seven_day: weekly } };
    assert.deepEqual(await reports(), [["weekly", 66, null], ["weekly Fable", 3, said]]);
    assert.equal(
      usageText("Claude Code", { limits: [{ name: "weekly Fable", percent: 3, resetsAt: 1791856800, heardAt: said }] }, "UTC"),
      ["Claude Code usage:", "Weekly Fable: 3% used, resets Tue 2:00 AM (as last said, Sun 8:00 PM)"].join("\n"),
    );
    // A week on, with no reset time to go by, not any more.
    now = said + 7 * 86400_000 - 12 * 60_000;
    assert.deepEqual(await reports(), [["weekly", 66, null], ["weekly Fable", 3, said]]);
    now = said + 7 * 86400_000;
    assert.deepEqual(await reports(), [["weekly", 66, null]]);

    // Said again: as it is said now, with no mark.
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { seven_day: weekly, model_scoped: [{ display_name: "Fable", utilization: 9, resets_at: null }] } };
    assert.deepEqual(await reports(), [["weekly", 66, null], ["weekly Fable", 9, null]]);
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("kept windows stay when the limits could not be read, and an API key's answer forgets them instead of showing them beside its note", async () => {
  let now = Date.parse("2026-11-01T20:00:00Z");
  const said = now;
  const { provider } = fakeClaude({ now: () => now });
  const next = async () => {
    now += 11 * 60_000;
    return provider.usage("a-thread");
  };
  const fable = { display_name: "Fable", utilization: 3, resets_at: "2026-11-30T02:00:00Z" };
  try {
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { model_scoped: [fable] } };
    await next();
    for (const answer of [{ subscription_type: "max", rate_limits_available: true, rate_limits: null }, new Error("Claude Code would not start.")]) {
      planUsage.answer = answer;
      const report = await next();
      // The answer that read them, as of when it did.
      assert.deepEqual(report.limits.map((limit) => [limit.name, limit.percent]), [["weekly Fable", 3]]);
      assert.equal(report.heardAt, said + 11 * 60_000);
    }
    planUsage.answer = { subscription_type: null, rate_limits_available: false, rate_limits: null };
    const key = await next();
    assert.deepEqual(key.limits, []);
    assert.match(key.note ?? "", /^No plan limits apply/);
    // And they do not come back.
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: null };
    assert.deepEqual((await next()).limits, []);
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("a Claude Code started only to ask has no hooks, MCP servers or plugins, starts at most every ten minutes, and the last answer stands between", async () => {
  let now = Date.parse("2026-11-01T20:00:00Z");
  const { provider, queries } = fakeClaude({ now: () => now });
  const percent = async () => (await provider.usage("a-thread")).limits.map((limit) => limit.percent);
  const answer = (utilization: number) => ({ subscription_type: "max", rate_limits_available: true, rate_limits: { seven_day: { utilization, resets_at: "2026-11-30T02:00:00Z" } } });
  try {
    planUsage.answer = answer(10);
    assert.deepEqual(await percent(), [10]);
    assert.equal(queries.length, 1);
    const { settingSources, strictMcpConfig, mcpServers, plugins, persistSession } = queries[0].options;
    assert.deepEqual({ settingSources, strictMcpConfig, mcpServers, plugins, persistSession }, { settingSources: [], strictMcpConfig: true, mcpServers: {}, plugins: [], persistSession: false });

    // Each minute a panel asks, nothing is started, and it says what it said.
    planUsage.answer = answer(20);
    for (let minute = 1; minute < 10; minute += 1) {
      now += 60_000;
      assert.deepEqual(await percent(), [10]);
    }
    assert.equal(queries.length, 1);
    now += 60_000;
    assert.deepEqual(await percent(), [20]);
    assert.equal(queries.length, 2);
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("an answer with no limits to read is not held: the next start is a minute on, then 2, 4, 8 and 10, and an answer that reads them ends that", async () => {
  let now = Date.parse("2026-11-01T20:00:00Z");
  const { provider, queries } = fakeClaude({ now: () => now });
  const startsByMinute = async (minutes: number) => {
    const starts: number[] = [];
    for (let minute = 0; minute < minutes; minute += 1) {
      const before = queries.length;
      await provider.usage("a-thread");
      if (queries.length > before) starts.push(minute);
      now += 60_000;
    }
    return starts;
  };
  const good = { subscription_type: "max", rate_limits_available: true, rate_limits: { seven_day: { utilization: 10, resets_at: "2026-11-30T02:00:00Z" } } };
  try {
    // Signed out, or failing: not one a minute.
    planUsage.answer = new Error("Claude Code would not start.");
    assert.deepEqual(await startsByMinute(36), [0, 1, 3, 7, 15, 25, 35]);
    // Now it answers: read at the next start, and held for ten minutes from there.
    planUsage.answer = good;
    assert.deepEqual(await startsByMinute(11), [9]);
    assert.deepEqual((await provider.usage("a-thread")).limits.map((limit) => limit.percent), [10]);

    // Could not read the limits just now, an answer all the same, and a fresh back-off.
    now += 10 * 60_000;
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: null };
    const count = queries.length;
    await provider.usage("a-thread");
    assert.equal(queries.length, count + 1);
    now += 60_000;
    planUsage.answer = { ...good, rate_limits: { seven_day: { utilization: 20, resets_at: "2026-11-30T02:00:00Z" } } };
    assert.deepEqual((await provider.usage("a-thread")).limits.map((limit) => limit.percent), [20]);
    assert.equal(queries.length, count + 2);
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("a held answer says when it was heard, and after a failed ask the last numbers stay, with their age, over an empty report", async () => {
  let now = Date.parse("2026-11-01T20:00:00Z");
  const said = now;
  const { provider } = fakeClaude({ now: () => now });
  const weekly = { utilization: 10, resets_at: "2026-11-30T02:00:00Z" };
  try {
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { seven_day: weekly } };
    assert.equal((await provider.usage("a-thread")).heardAt, undefined);
    now += 9 * 60_000;
    assert.equal((await provider.usage("a-thread")).heardAt, said);

    // The ask that follows fails: the numbers do not go, and they say how old they are.
    now += 2 * 60_000;
    planUsage.answer = new Error("offline");
    const failed = await provider.usage("a-thread");
    assert.deepEqual([failed.plan, failed.limits.map((limit) => limit.percent), failed.heardAt], ["max", [10], said]);
    assert.equal(failed.note, undefined);

    // A turn has reported since: what it said goes over them, window by window, and the rest stay.
    now += 60_000;
    const heard = now;
    provider.limitsHeard({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5 });
    const reported = await provider.usage("a-thread");
    assert.deepEqual([reported.limits.map((limit) => [limit.name, limit.percent, limit.heardAt ?? null]), reported.heardAt], [[["weekly", 10, null], ["5-hour", 50, heard]], said]);

    // Signed in with an API key since, at the next start: nothing of the old plan's, held or not.
    now += 2 * 60_000;
    planUsage.answer = { subscription_type: null, rate_limits_available: false, rate_limits: null };
    const key = await provider.usage("a-thread");
    assert.deepEqual(key.limits, []);
    assert.match(key.note ?? "", /^No plan limits apply/);
    assert.equal(key.heardAt, undefined);
    now += 4 * 60_000;
    planUsage.answer = new Error("offline");
    // The old plan's numbers do not come back; what a turn said is what there is.
    assert.deepEqual((await provider.usage("a-thread")).limits.map((limit) => limit.name), ["5-hour"]);
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("a failed ask keeps the last numbers though a turn has said only \"allowed\" since", async () => {
  let now = Date.parse("2026-11-01T20:00:00Z");
  const said = now;
  const { provider } = fakeClaude({ now: () => now });
  const resets = "2026-11-30T02:00:00Z";
  try {
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 40, resets_at: resets }, seven_day: { utilization: 20, resets_at: resets } } };
    await provider.usage("a-thread");
    now += 60_000;
    provider.limitsHeard({ status: "allowed", rateLimitType: "five_hour" });
    now += 11 * 60_000;
    for (const failing of [{ subscription_type: "max", rate_limits_available: true, rate_limits: null }, new Error("offline")]) {
      planUsage.answer = failing;
      now += 10 * 60_000;
      const report = await provider.usage("a-thread");
      assert.deepEqual([report.limits.map((limit) => [limit.name, limit.percent]), report.heardAt], [[["5-hour", 40], ["weekly", 20]], said]);
    }
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("an answer held past a window's reset no longer says what it said of that window", async () => {
  let now = Date.parse("2026-11-01T20:00:00Z");
  const { provider } = fakeClaude({ now: () => now });
  const shown = async () => (await provider.usage("a-thread")).limits.map((limit) => [limit.name, limit.percent, limit.resetsAt, limit.reached ?? false]);
  const weeklyResets = Date.parse("2026-11-05T00:00:00Z") / 1000;
  try {
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: "2026-11-01T20:05:00Z" }, seven_day: { utilization: 20, resets_at: "2026-11-05T00:00:00Z" } } };
    assert.deepEqual((await shown())[0], ["5-hour", 100, Date.parse("2026-11-01T20:05:00Z") / 1000, true]);

    // Within the hold, and after an ask that fails: the 5-hour's number is over, the week's stands.
    now += 6 * 60_000;
    const over = [["5-hour", null, null, false], ["weekly", 20, weeklyResets, false]];
    assert.deepEqual(await shown(), over);
    now += 5 * 60_000;
    planUsage.answer = new Error("offline");
    assert.deepEqual(await shown(), over);
    assert.doesNotMatch(usageText("Claude Code", await provider.usage("a-thread"), "UTC"), /used up/);
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("a window that says no reset time stands a week after it was said, used up or not", async () => {
  let now = Date.parse("2026-11-01T20:00:00Z");
  const { provider } = fakeClaude({ now: () => now });
  const shown = async () => (await provider.usage("a-thread")).limits.map((limit) => [limit.name, limit.percent, limit.reached ?? false]);
  try {
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { seven_day: { utilization: 100, resets_at: null } } };
    await provider.usage("a-thread");
    planUsage.answer = new Error("offline");
    now += 7 * 86400_000 - 1;
    assert.deepEqual(await shown(), [["weekly", 100, true]]);
    now += 1;
    assert.deepEqual(await shown(), [["weekly", null, false]]);
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("a turn's number keeps a held window's reset time only while that time is still to come", async () => {
  const resets = "2026-11-01T21:00:00Z";
  let now = Date.parse("2026-11-01T20:55:00Z");
  const { provider } = fakeClaude({ now: () => now });
  const shown = async () => (await provider.usage("a-thread")).limits.map((limit) => [limit.percent, limit.resetsAt]);
  try {
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 42, resets_at: resets } } };
    await provider.usage("a-thread");
    now += 60_000;
    provider.limitsHeard({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5 });
    assert.deepEqual(await shown(), [[50, Date.parse(resets) / 1000]]);
    // Past it, within the hold: a new window, whose reset nobody has said.
    now = Date.parse("2026-11-01T21:02:00Z");
    provider.limitsHeard({ status: "allowed", rateLimitType: "five_hour", utilization: 0.02 });
    assert.deepEqual(await shown(), [[2, null]]);
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("a turn's newer report wins over a held answer, whichever way, window by window; an older one, or a bare allowed, does not", async () => {
  let now = Date.parse("2026-11-01T20:00:00Z");
  const said = now;
  const { provider } = fakeClaude({ now: () => now });
  const shown = async () => (await provider.usage("a-thread")).limits.map((limit) => [limit.name, limit.percent, limit.reached ?? false, limit.heardAt ?? null]);
  const resets = "2026-11-30T02:00:00Z";
  try {
    provider.limitsHeard({ status: "allowed", rateLimitType: "five_hour", utilization: 0.99 });
    now += 1000;
    const answered = now;
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 42, resets_at: resets }, seven_day: { utilization: 10, resets_at: resets } } };
    // Older than the answer: the answer stands.
    assert.deepEqual(await shown(), [["5-hour", 42, false, null], ["weekly", 10, false, null]]);

    // Says little: nothing new, and the number stays.
    now += 60_000;
    provider.limitsHeard({ status: "allowed", rateLimitType: "seven_day" });
    assert.deepEqual(await shown(), [["5-hour", 42, false, null], ["weekly", 10, false, null]]);

    // Turned away by the week: that window says so, with when, and the other is untouched.
    now += 60_000;
    const rejected = now;
    provider.limitsHeard({ status: "rejected", rateLimitType: "seven_day", utilization: 1 });
    const report = await provider.usage("a-thread");
    assert.equal(report.heardAt, answered);
    assert.deepEqual(report.limits.map((limit) => [limit.name, limit.percent, limit.reached ?? false, limit.heardAt ?? null]), [["5-hour", 42, false, null], ["weekly", 100, true, rejected]]);
    assert.ok(report.limits[1].resetsAt, "keeps the time it resets at, which the turn did not say");

    // Turned away with no number to say it by: used up all the same.
    now += 60_000;
    const away = now;
    provider.limitsHeard({ status: "rejected", rateLimitType: "five_hour" });
    assert.deepEqual((await shown())[0], ["5-hour", null, true, away]);

    // The other way: held as used up, a turn since is allowed through.
    now = said + 11 * 60_000;
    planUsage.answer = { subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: resets } } };
    assert.deepEqual(await shown(), [["5-hour", 100, true, null]]);
    now += 60_000;
    const lower = now;
    provider.limitsHeard({ status: "allowed", rateLimitType: "five_hour", utilization: 0.2 });
    assert.deepEqual(await shown(), [["5-hour", 20, false, lower]]);
    // With no number to say it by, it is no longer used up all the same.
    now += 60_000;
    const bare = now;
    provider.limitsHeard({ status: "allowed", rateLimitType: "five_hour" });
    assert.deepEqual(await shown(), [["5-hour", null, false, bare]]);
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("a turn's report since an answer that no plan limits apply is what shows", async () => {
  let now = Date.parse("2026-11-01T20:00:00Z");
  const { provider } = fakeClaude({ now: () => now });
  try {
    planUsage.answer = { subscription_type: null, rate_limits_available: false, rate_limits: null };
    assert.match((await provider.usage("a-thread")).note ?? "", /^No plan limits apply/);
    now += 10_000;
    provider.limitsHeard({ status: "rejected", rateLimitType: "five_hour", utilization: 1 });
    const report = await provider.usage("a-thread");
    assert.deepEqual(report.limits.map((limit) => [limit.name, limit.reached]), [["5-hour", true]]);
    assert.equal(report.heardAt, now);
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("asked fresh, as a typed /usage asks, one is started whatever stands, and what it says stands from then on", async () => {
  let now = Date.parse("2026-11-01T20:00:00Z");
  const { provider, queries } = fakeClaude({ now: () => now });
  const answer = (utilization: number) => ({ subscription_type: "max", rate_limits_available: true, rate_limits: { seven_day: { utilization, resets_at: "2026-11-30T02:00:00Z" } } });
  try {
    planUsage.answer = answer(10);
    await provider.usage("a-thread");
    assert.equal(queries.length, 1);
    now += 60_000;
    planUsage.answer = answer(20);
    const fresh = await provider.usage("a-thread", { fresh: true });
    assert.deepEqual([fresh.limits[0].percent, fresh.heardAt], [20, undefined]);
    assert.equal(queries.length, 2);
    now += 60_000;
    planUsage.answer = answer(30);
    assert.deepEqual((await provider.usage("a-thread")).limits.map((limit) => limit.percent), [20]);
    assert.equal(queries.length, 2);
    // A turn's report in the same moment is no newer than what is asked now.
    provider.limitsHeard({ status: "allowed", rateLimitType: "seven_day", utilization: 0.15 });
    const asked = await provider.usage("a-thread", { fresh: true });
    assert.deepEqual([asked.limits[0].percent, asked.limits[0].heardAt, asked.heardAt], [30, undefined, undefined]);
    // Over the command, as a thread's /usage goes.
    const typed: unknown[] = [];
    const typedProvider = { profile: { displayName: "Claude Code" }, usage: async (...args: unknown[]) => (typed.push(args), { limits: [] }) };
    await dispatch({ id: "a-thread" } as unknown as Session, typedProvider as unknown as Provider, "usage", "");
    assert.deepEqual(typed, [["a-thread", { fresh: true }]]);
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("a running Claude Code is asked each time, however lately one was started, and its answer stands over the older one's when it has gone", async () => {
  let now = Date.parse("2026-11-01T20:00:00Z");
  const { provider, queries } = fakeClaude({ now: () => now });
  const percent = async () => (await provider.usage("a-thread")).limits.map((limit) => limit.percent);
  const answer = (utilization: number) => ({ subscription_type: "max", rate_limits_available: true, rate_limits: { seven_day: { utilization, resets_at: "2026-11-30T02:00:00Z" } } });
  // As `ClaudeProvider.sessions` holds a thread's session: only what `askUsage` reads of it.
  const sessions = (provider as unknown as { sessions: Set<unknown> }).sessions;
  let asked = 0;
  const running = { id: "a-thread", liveQuery: { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ((asked += 1), answer(30 + asked)) } };
  try {
    planUsage.answer = answer(10);
    assert.deepEqual(await percent(), [10]);
    sessions.add(running);
    now += 60_000;
    assert.deepEqual(await percent(), [31]);
    now += 60_000;
    assert.deepEqual(await percent(), [32]);
    assert.equal(queries.length, 1);
    // Gone within the ten minutes: not back to 10, and nothing started.
    sessions.delete(running);
    now += 60_000;
    assert.deepEqual(await percent(), [32]);
    assert.equal(queries.length, 1);
  } finally {
    planUsage.answer = new Error("not set");
    await provider.close();
  }
});

test("the model check keeps the person's settings, hooks and MCP servers, for the models and commands they bring", async () => {
  const { provider, queries } = fakeClaude();
  try {
    await provider.models();
    assert.ok(queries.length > 0);
    assert.deepEqual(queries[0].options.settingSources, ["user", "project", "local"]);
    assert.equal(queries[0].options.strictMcpConfig, undefined);
  } finally {
    await provider.close();
  }
});

test("the windows the turns reported, each as last heard, with when; nothing heard says so", () => {
  let now = Date.parse("2026-10-14T11:12:00Z");
  const heard = new HeardLimits(() => now);
  assert.equal(usageText("Claude Code", heard.report(), "UTC"), "Claude Code usage:\nClaude Code says how much is used with each turn, and no turn has run since the bridge started.");
  heard.heard({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: 1791337800 }, seven_day: { utilization: 0.09, resetsAt: 1791856800 } } });
  now += 60_000;
  heard.heard({ status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: 1791337800 });
  // Ignored: says nothing of a window.
  heard.heard({ status: "allowed" });
  assert.equal(
    usageText("Claude Code", heard.report(), "UTC"),
    ["Claude Code usage:", "5-hour: used up, resets Wed 1:50 AM", "Weekly: 9% used, resets Tue 2:00 AM", "As Claude Code last said, Wed 11:13 AM."].join("\n"),
  );
  // Turned away by one window, reported with every window: only that one is used up.
  heard.heard({
    status: "rejected",
    rateLimitType: "seven_day",
    unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1791337800 }, seven_day: { utilization: 1, resetsAt: 1791856800 } },
  });
  assert.deepEqual(
    heard.report().limits.map((limit) => [limit.name, limit.percent, limit.reached ?? false]),
    [["5-hour", 20, false], ["weekly", 100, true]],
  );
});

test("Codex's account limits: its own first, another limit by its name, the plan by OpenAI's name for it, credits as people write them", () => {
  const snapshot = (limitId: string, limitName: string | null, primary: unknown, secondary: unknown = null) =>
    ({ limitId, limitName, primary, secondary, credits: null, planType: "prolite", rateLimitReachedType: null, normalModelSlug: null, individualLimit: null, spendControlReached: null }) as never;
  const report = usageReport({
    rateLimitsByLimitId: {
      spark: snapshot("spark", "GPT-6.1-Spark", { usedPercent: 3, windowDurationMins: 300, resetsAt: 1791337800 }),
      codex: {
        ...(snapshot("codex", null, { usedPercent: 0.6, windowDurationMins: 10_080, resetsAt: 1791856800 }) as object),
        credits: { hasCredits: true, unlimited: false, balance: "62500.0000000000" },
      } as never,
    },
  });
  assert.equal(
    usageText("Codex", report, "UTC"),
    ["Codex usage, Pro 100 plan:", "Weekly: 1% used, resets Tue 2:00 AM", "5-hour GPT-6.1-Spark: 3% used, resets Wed 1:50 AM", "Credits left: 62,500."].join("\n"),
  );
});

test("Codex's account limits: a workspace's spending limit, what turns work away where no window shows it, unlimited credits", () => {
  const snapshot = (fields: object) =>
    ({ limitId: "codex", limitName: null, primary: null, secondary: null, credits: null, planType: "business", rateLimitReachedType: null, normalModelSlug: null, individualLimit: null, spendControlReached: null, ...fields }) as never;
  // Spent: the limit is used up, not absent.
  assert.equal(
    usageText(
      "Codex",
      usageReport({ rateLimits: snapshot({ individualLimit: { limit: "100", used: "100", remainingPercent: 0, resetsAt: 1791856800 }, spendControlReached: true, rateLimitReachedType: "workspace_member_usage_limit_reached" }) }),
      "UTC",
    ),
    ["Codex usage, Business plan:", "Spending limit: used up, resets Tue 2:00 AM"].join("\n"),
  );
  assert.equal(
    usageText("Codex", usageReport({ rateLimits: snapshot({ primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null }, individualLimit: { limit: "100", used: "40", remainingPercent: 60, resetsAt: 1791856800 } }) }), "UTC"),
    ["Codex usage, Business plan:", "5-hour: 12% used", "Spending limit: 40% used, resets Tue 2:00 AM"].join("\n"),
  );
  // Turned away with no limit that shows it: said, not "no limits".
  assert.equal(
    usageText("Codex", usageReport({ rateLimits: snapshot({ rateLimitReachedType: "workspace_owner_credits_depleted" }) }), "UTC"),
    ["Codex usage, Business plan:", "The workspace's credits are used up."].join("\n"),
  );
  assert.equal(
    usageText("Codex", usageReport({ rateLimits: snapshot({ primary: { usedPercent: 99.6, windowDurationMins: 300, resetsAt: null }, rateLimitReachedType: "rate_limit_reached" }) }), "UTC"),
    ["Codex usage, Business plan:", "5-hour: 100% used", "The Codex usage limit is reached."].join("\n"),
  );
  assert.equal(
    usageText("Codex", usageReport({ rateLimits: snapshot({ credits: { hasCredits: true, unlimited: true, balance: null } }) }), "UTC"),
    ["Codex usage, Business plan:", "Credits: unlimited."].join("\n"),
  );
  assert.equal(usageText("Codex", usageReport({ rateLimits: snapshot({}) }), "UTC"), ["Codex usage, Business plan:", "Codex says no limits apply to this account."].join("\n"));
});
