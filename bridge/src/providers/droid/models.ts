import { AutonomyLevel, DroidInteractionMode, ReasoningEffort, type ModelInfo } from "@factory/droid-sdk/node";
import { knownLevels, SettingRefused, type ModelCatalog, type ThreadMode } from "../types.ts";

export interface DroidPolicy {
  autonomyLevel: AutonomyLevel;
  interactionMode: DroidInteractionMode;
}

export function policyFor(mode: ThreadMode, defaults: DroidPolicy, beforePlan: ThreadMode): DroidPolicy {
  if (mode === "default") return defaults;
  if (mode === "plan") return { ...policyFor(beforePlan === "plan" ? "ask" : beforePlan, defaults, "ask"), interactionMode: DroidInteractionMode.Spec };
  return {
    autonomyLevel: { ask: AutonomyLevel.Off, edits: AutonomyLevel.Low, medium: AutonomyLevel.Medium, full: AutonomyLevel.High }[mode],
    interactionMode: DroidInteractionMode.Auto,
  };
}

export function modeFor(policy: DroidPolicy): Exclude<ThreadMode, "default"> | undefined {
  if (policy.interactionMode === DroidInteractionMode.Spec) return "plan";
  if (policy.interactionMode !== DroidInteractionMode.Auto) return undefined;
  if (policy.autonomyLevel === AutonomyLevel.Off) return "ask";
  if (policy.autonomyLevel === AutonomyLevel.Low) return "edits";
  if (policy.autonomyLevel === AutonomyLevel.Medium) return "medium";
  if (policy.autonomyLevel === AutonomyLevel.High) return "full";
  return undefined;
}

export function appEffort(effort: string): string {
  return effort === "off" ? "none" : knownLevels([effort])[0] ?? "";
}

export function sdkEffort(level: string, model?: ModelInfo): ReasoningEffort {
  const efforts = model?.supportedReasoningEfforts;
  const effort = level === "none" && efforts?.includes(ReasoningEffort.Off) ? ReasoningEffort.Off : level;
  if (!Object.values(ReasoningEffort).includes(effort as ReasoningEffort) || (efforts && !efforts.includes(effort as ReasoningEffort))) {
    throw new SettingRefused(`Droid does not support reasoning level "${level}"${model ? ` for ${model.displayName}` : ""}.`);
  }
  return effort as ReasoningEffort;
}

/** The least a model thinks at, for a short request such as a thread's name; undefined when its levels are not known. */
export function lowestEffort(model?: ModelInfo): ReasoningEffort | undefined {
  const order = [ReasoningEffort.Off, ReasoningEffort.None, ReasoningEffort.Minimal, ReasoningEffort.Low, ReasoningEffort.Medium];
  return order.find((effort) => model?.supportedReasoningEfforts.includes(effort));
}

/**
 * Droid's models, the first ("default") following Droid's own settings. Named by the model
 * those settings give, which it stands for in the list (2026-10-23: the composer
 * "should just read the model", not "Default (gpt-6.1-sol)"), with that model's levels.
 */
export function modelCatalog(models: ModelInfo[], defaults?: { model: string; reasoning: string }): ModelCatalog {
  const available = models.filter((model) => !model.disabled);
  const followed = defaults ? available.find((model) => model.id === defaults.model) : undefined;
  const levels: Record<string, string[]> = Object.fromEntries(available.map((model) => [model.id, knownLevels(model.supportedReasoningEfforts.map(appEffort))]));
  const defaultLevels: Record<string, string> = Object.fromEntries(available.map((model) => [model.id, appEffort(model.defaultReasoningEffort)]));
  return {
    providers: [{ slug: "droid", name: "Droid", models: ["default", ...available.filter((model) => model !== followed).map((model) => model.id)] }],
    model: "default", provider: "droid", reasoning: defaults?.reasoning ?? "",
    names: { default: followed?.displayName ?? defaults?.model ?? "Droid default", ...Object.fromEntries(available.map((model) => [model.id, model.displayName])) },
    levels: followed ? { default: levels[followed.id]!, ...levels } : levels,
    defaultLevels: followed ? { default: defaultLevels[followed.id]!, ...defaultLevels } : defaultLevels,
  };
}
