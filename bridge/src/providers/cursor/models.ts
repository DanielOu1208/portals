import { agentsChoice, choices, currentValue, optionOf } from "../acp/models.ts";
import type { ConfigOption } from "../acp/protocol.ts";
import { codexEffort } from "../codex/options.ts";
import { knownLevels, thinkingLevels, type ModelCatalog } from "../types.ts";

// Cursor's models as the app lists them, and what a choice in the app comes to at Cursor.
//
// Cursor lists its models without a session (`cursor/list_available_models`): every
// model with the settings it has and their defaults. One of a model's settings is its
// thinking level: the option in category `thought_level` whose values are levels
// (`effort`, `reasoning` or `reasoning_effort`, by model). Some models list `thinking`,
// on or off, in that category before it, which is not a level; some have none at all.
//
// The model is Cursor's, not a session's: setting one selects it for every session of
// the process and in Cursor's own settings. So the app's `default` is "leave it as
// Cursor has it", and nothing is set for a thread on it.

/** One of Cursor's models. */
export interface CursorModel {
  /** As the app knows it: Cursor's own id, except `auto` for its "Auto", whose id is `default`. */
  id: string;
  name: string;
  /** Its thinking levels: the option they are set on, and Cursor's value for each by the app's name for it. Left out for a model with none. */
  level?: { option: string; values: Record<string, string> };
  /** Its levels are not known: a Cursor that does not list its models said only those of the model it was on (`sessionModels`). */
  unknown?: true;
}

/** Cursor's own "Auto" model has the id the app keeps for "the agent's choice". */
const autoModel = "auto";

/** Cursor's values for a level that the app knows by another name. */
const levelNames: Record<string, string> = { "extra-high": "xhigh" };

/** A model's id as the app has it. */
function appID(value: string): string {
  return value === agentsChoice ? autoModel : value;
}

/** A model's id as Cursor takes it. */
export function cursorID(model: string): string {
  return model === autoModel ? agentsChoice : model;
}

/** The option among a model's that sets its thinking level, when it has one. */
function levelOption(options: ConfigOption[] | null | undefined): CursorModel["level"] {
  for (const option of options ?? []) {
    if (option?.category !== "thought_level" || typeof option.id !== "string") continue;
    const values: Record<string, string> = {};
    for (const choice of choices(option)) {
      const level = levelNames[choice.value] ?? choice.value;
      if ((thinkingLevels as readonly string[]).includes(level)) values[level] = choice.value;
    }
    // On or off is not a level.
    if (Object.keys(values).length > 0) return { option: option.id, values };
  }
  return undefined;
}

/** A model as listed; null for one the app could not name in a model change, which it writes as words. */
function model(value: unknown, name: unknown, level: CursorModel["level"]): CursorModel | null {
  if (typeof value !== "string" || value === "" || /\s/.test(value)) return null;
  return { id: appID(value), name: typeof name === "string" && name !== "" ? name : value, ...(level ? { level } : {}) };
}

/** The models in the answer to `cursor/list_available_models`; null when it holds none. */
export function listedModels(answer: unknown): CursorModel[] | null {
  const listed = (answer as { models?: unknown } | null)?.models;
  if (!Array.isArray(listed)) return null;
  const models = listed.flatMap((entry) => model(entry?.value, entry?.name, levelOption(Array.isArray(entry?.configOptions) ? entry.configOptions : [])) ?? []);
  return models.length > 0 ? models : null;
}

/**
 * The models a session's own options list, for a Cursor that does not answer the list:
 * the models by name, and the levels of the one the session is on. The others keep the
 * levels they were `known` with.
 */
export function sessionModels(options: ConfigOption[], known: CursorModel[] | null): CursorModel[] | null {
  const option = optionOf(options, "model");
  const current = currentValue(option);
  const models = choices(option).flatMap((choice) => {
    if (choice.value === current) return model(choice.value, choice.name, levelOption(options)) ?? [];
    const before = known?.find((entry) => entry.id === appID(choice.value));
    const made = model(choice.value, choice.name, before?.level);
    if (!made) return [];
    // Never said: not "none", which the app shows as no levels at all.
    return before && !before.unknown ? [made] : [{ ...made, unknown: true as const }];
  });
  return models.length > 0 ? models : null;
}

/** The levels a model takes, as the app names them, weakest first. */
export function levelsOf(model: CursorModel | undefined): string[] {
  return knownLevels(Object.keys(model?.level?.values ?? {}));
}

/**
 * What a level chosen in the app is set as on a model: the option and Cursor's value
 * for the level itself, else for the nearest one the model has. Null for a model with
 * no levels, and for no level chosen.
 */
export function levelSetting(model: CursorModel | undefined, chosen: string): { option: string; value: string; level: string } | null {
  const levels = levelsOf(model);
  if (!model?.level || levels.length === 0 || chosen === "") return null;
  const level = codexEffort(chosen, levels);
  return level && model.level.values[level] !== undefined ? { option: model.level.option, value: model.level.values[level], level } : null;
}

/** The app's name for the level an option of Cursor's is at, when it is one. */
export function levelAt(model: CursorModel | undefined, options: ConfigOption[] | null): string {
  if (!model?.level) return "";
  const value = currentValue((options ?? []).find((option) => option?.id === model.level!.option));
  return Object.entries(model.level.values).find(([, cursors]) => cursors === value)?.[0] ?? "";
}

/** The model Cursor is on, as the app knows it; null until Cursor has said. */
export function modelAt(options: ConfigOption[] | null): string | null {
  const value = currentValue(optionOf(options, "model"));
  return value === null ? null : appID(value);
}

/**
 * The list for the app. `default` leaves the choice to Cursor, so it takes no level and
 * is not named after whatever Cursor is on now: the bridge's own threads move that.
 */
export function cursorCatalog(agent: { id: string; name: string }, models: CursorModel[] | null): ModelCatalog {
  const listed = models ?? [];
  return {
    providers: [{ slug: agent.id, name: agent.name, models: [agentsChoice, ...listed.map((entry) => entry.id)] }],
    model: agentsChoice,
    provider: agent.id,
    reasoning: "",
    // One with none says so with an empty list, which an app that reads
    // `model_levels_none` offers no level for. An older one reads it as "any level", like
    // a model left out, so a level chosen for such a model is refused when it is set
    // (./session.ts).
    // A model whose levels are not known is left out, as taking any.
    levels: { [agentsChoice]: [], ...Object.fromEntries(listed.filter((entry) => !entry.unknown).map((entry) => [entry.id, levelsOf(entry)])) },
    names: { [agentsChoice]: `${agent.name}'s own`, ...Object.fromEntries(listed.map((entry) => [entry.id, entry.name])) },
  };
}
