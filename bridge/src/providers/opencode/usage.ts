import type { UsageLimitsInfo, UsageLimitsBudget } from "@opencode/client";
import type { UsageLimit, UsageReport } from "../types.ts";

function percentOf(spent: number, limit: number): number | null {
  if (limit < 0) return null;
  if (limit === 0) return 100;
  return Math.min(100, Math.max(0, 100 * spent / limit));
}

function budgetLimits(budget: UsageLimitsBudget): UsageLimit[] {
  const scope = budget.shared || budget.scope === "combined" ? "shared" : "member";
  const name = `Monthly ${scope} budget ${budget.id}`;
  const limit = (label: string, spent: number): UsageLimit => ({
    name: `${label} ($${spent.toFixed(2)} of $${budget.limit.toFixed(2)})`,
    percent: percentOf(spent, budget.limit),
    resetsAt: budget.resetsAt / 1000,
    reached: spent >= budget.limit,
  });
  if (budget.per === "model") {
    const models = budget.models.filter((model) => model.spent !== undefined);
    if (models.length) return models.map((model) => limit(`${name}, ${model.name}`, model.spent!));
    return [limit(`${name}, highest model spend`, budget.spent)];
  }
  const coverage = budget.coverage === "all" ? "all models and services" : budget.models.map((model) => model.name).join(", ") || budget.vendors.join(", ") || "covered models";
  return [limit(`${name}, ${coverage}`, budget.spent)];
}

/** Only OpenCode Console's reported limits, never an invented external-provider allowance. */
export function usageReport(info: UsageLimitsInfo | null): UsageReport {
  if (!info) return { limits: [], note: "OpenCode reports no Console usage limits for this folder. API keys and external providers may have their own limits." };
  const limits: UsageLimit[] = [];
  if (info.go) {
    for (const [name, meter] of Object.entries(info.go)) {
      limits.push({
        name: `Go ${name}`,
        percent: Math.min(100, Math.max(0, meter.percent)),
        resetsAt: meter.resetsAt / 1000,
        reached: meter.limited,
        ...(name === "weekly" ? { windowSeconds: 7 * 86400 } : {}),
      });
    }
  }
  limits.push(...info.budgets.flatMap(budgetLimits));
  return { ...(info.go ? { plan: "go" } : {}), limits, note: `${info.workspace.name || "OpenCode Console workspace"}${limits.length ? "." : " reports no usage limits."} External providers may have their own limits.` };
}
