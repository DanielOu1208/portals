import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageLimitsBudget } from "@opencode/client";
import { usageReport } from "../src/providers/opencode/usage.ts";

const budget: UsageLimitsBudget = { id: "team", limit: 100, spent: 25, scope: "combined", per: "set", coverage: "all", models: [], vendors: [], picked: false, shared: true, resetsAt: 1_800_000_000 };
const workspace = { id: "ws", name: "Team", usageURL: "https://opencode.ai/workspace/ws" };

test("OpenCode Go's actual rolling, weekly and monthly meters retain their reset and blocked state", () => {
  const report = usageReport({ workspace, budgets: [], go: { rolling: { percent: 20, limited: false, resetsAt: 1 }, weekly: { percent: 42, limited: false, resetsAt: 2 }, monthly: { percent: 105, limited: true, resetsAt: 3 } } });
  assert.equal(report.plan, "go");
  assert.deepEqual(report.limits.map((limit) => [limit.name, limit.percent, limit.resetsAt, limit.reached]), [["Go rolling", 20, 0.001, false], ["Go weekly", 42, 0.002, false], ["Go monthly", 100, 0.003, true]]);
  assert.equal(report.limits[0].windowSeconds, undefined);
});

test("budget rows distinguish pooled and per-model spend without inventing a plan or allowance", () => {
  const report = usageReport({ workspace, budgets: [budget, { ...budget, id: "models", scope: "each", shared: false, per: "model", models: [{ providerID: "openai", modelID: "one", name: "One", spent: 10 }, { providerID: "anthropic", modelID: "two", name: "Two", spent: 100 }] }] });
  assert.equal(report.plan, undefined);
  assert.match(report.limits[0].name, /shared.*all models and services/);
  assert.deepEqual(report.limits.map((limit) => limit.percent), [25, 10, 100]);
  assert.equal(report.limits[2].reached, true);
  assert.equal(report.limits[0].resetsAt, budget.resetsAt / 1000);
  assert.deepEqual(usageReport(null).limits, []);
});
