import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { knownLevels } from "../types.ts";
import { claudeEfforts } from "./options.ts";

// Claude Code's models as the app lists them. Claude Code offers aliases (`default`,
// `opus`, `fable`) beside full ids, each with the name it shows for it ("Opus 5.5"),
// except `default`, which it calls "Default (recommended)". A thread on `default` names
// no model, and runs on whatever Claude Code's settings come to, so the app is sent
// that model's name for it, and the alias that runs the same model is left off the
// list: one row per model, the default's marked as such in the app.

/** What the app is told about Claude Code's models (`model.options`). */
export interface ClaudeModels {
  /** The models to list, in Claude Code's order. */
  models: string[];
  /** What to call each one, the unlisted ones too (`model_names`). */
  names: Record<string, string>;
  /** The thinking levels each one takes (`model_levels`). */
  levels: Record<string, string[]>;
}

/**
 * Claude Code's list as the app is sent it. `applied` is the model a session that names
 * none runs on (`claude-opus-5-5`), when Claude Code has said: The user's own `model`
 * setting when they have one. Its list's `default` is always Claude Code's recommended
 * model, setting or not, so that is used only when `applied` is not known.
 */
export function claudeModels(list: readonly ModelInfo[], applied: string | null): ClaudeModels {
  const own = list.find((entry) => entry.value === "default");
  const runs = applied ?? own?.resolvedModel;
  // The entry for the model `default` runs on (`opus`), when Claude Code lists one.
  const twin = runs === undefined ? undefined : list.find((entry) => entry !== own && resolved(entry) === runs);
  const names = Object.fromEntries(list.map((entry) => [entry.value, entry.displayName.trim() || entry.value]));
  const levels = Object.fromEntries(list.map((entry) => [entry.value, levelsOf(entry)]));
  if (own) {
    names.default = defaultName(own, twin, applied);
    levels.default = levelsOf(twin ?? own);
  }
  const models = list.filter((entry) => entry === own || !own || runs === undefined || resolved(entry) !== runs).map((entry) => entry.value);
  return { models, names, levels };
}

/** The model an entry runs: its id, for an alias the one it stands for. */
function resolved(entry: ModelInfo): string {
  return entry.resolvedModel ?? entry.value;
}

/**
 * The effort levels Claude Code lists for a model. One that lists none (Haiku 4.5) gets its
 * thinking budget from the level instead (options.ts, `thinkingBudget`), which knows
 * every one of Claude's levels.
 */
function levelsOf(entry: ModelInfo): string[] {
  return knownLevels(entry.supportedEffortLevels?.length ? entry.supportedEffortLevels : claudeEfforts);
}

/**
 * What to call `default`: the name of the model it runs on. Claude Code's own default
 * says it in its description ("Opus 5.5 · Best for everyday, complex tasks"); a model
 * setting it lists no entry for goes by its id.
 */
function defaultName(own: ModelInfo, twin: ModelInfo | undefined, applied: string | null): string {
  const twinName = twin?.displayName.trim();
  if (twinName) return twinName;
  if (applied && applied !== own.resolvedModel) return applied;
  const [described, rest] = own.description.split(" · ");
  if (rest !== undefined && described.trim()) return described.trim();
  return own.resolvedModel ?? (own.displayName.trim() || own.value);
}
