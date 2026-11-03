import { knownLevels, type ModelCatalog } from "../types.ts";
import type { ConfigChoice, ConfigGroup, ConfigOption } from "./protocol.ts";

// An agent's models as the app lists them. The protocol has no list of models apart
// from a session: each session says what it can be set to (`configOptions`), one of
// which is its model. So a provider learns the list from the first session it starts,
// keeps it, and until then offers only `default`: the agent's own choice, which a
// thread runs on unless another model is chosen for it.

/** The model that leaves the choice to the agent. */
export const agentsChoice = "default";

/** One model the agent offers. */
export interface KnownModel {
  /** The value the agent takes. */
  id: string;
  name: string;
  /** The heading the agent lists it under, when it has headings. */
  group?: { id: string; name: string };
}

/** What a session told of the agent's models. */
export interface KnownModels {
  models: KnownModel[];
  /** The model a new session starts on; null until a new session said. */
  own: string | null;
}

function isGroup(entry: ConfigChoice | ConfigGroup): entry is ConfigGroup {
  return Array.isArray((entry as ConfigGroup).options);
}

/** The option of a kind (`model`, `thought_level`), when the session has one to choose from a list. */
export function optionOf(options: ConfigOption[] | null | undefined, category: string): ConfigOption | undefined {
  return (options ?? []).find((option) => option?.category === category && (option.type ?? "select") === "select" && Array.isArray(option.options));
}

/** An option's choices, whatever headings they are under. */
export function choices(option: ConfigOption | undefined): ConfigChoice[] {
  return (option?.options ?? []).flatMap((entry) => (isGroup(entry) ? entry.options : [entry])).filter((choice) => typeof choice?.value === "string");
}

/**
 * The models a session's options list. Ones whose value has a space are left out: the
 * app writes a model change as words (`config.set`).
 */
export function modelsOf(options: ConfigOption[] | null | undefined): KnownModel[] {
  const option = optionOf(options, "model");
  const models: KnownModel[] = [];
  for (const entry of option?.options ?? []) {
    const group = isGroup(entry) ? { id: entry.group, name: entry.name } : undefined;
    for (const choice of isGroup(entry) ? entry.options : [entry]) {
      if (typeof choice?.value !== "string" || choice.value === "" || /\s/.test(choice.value) || choice.value === agentsChoice) continue;
      models.push({ id: choice.value, name: typeof choice.name === "string" && choice.name !== "" ? choice.name : choice.value, ...(group ? { group } : {}) });
    }
  }
  return models;
}

/** The value an option is at, when it is one of its choices' kind. */
export function currentValue(option: ConfigOption | undefined): string | null {
  return typeof option?.currentValue === "string" ? option.currentValue : null;
}

/**
 * The thinking level an option is at and the ones it takes, as the app names levels.
 * Agents name theirs as they like; only the ones the app knows by the same name count.
 */
export function levelsOf(options: ConfigOption[] | null | undefined): { current: string; levels: string[] } {
  const option = optionOf(options, "thought_level");
  const levels = knownLevels(choices(option).map((choice) => choice.value));
  const current = currentValue(option);
  return { current: current !== null && levels.includes(current) ? current : "", levels };
}

/**
 * The list for the app. Models whose ids all read `vendor/model` (OpenCode's) go under
 * their vendor, as do ones the agent lists under headings; the rest go under the agent.
 */
export function catalogFor(agent: { id: string; name: string }, known: KnownModels | null): ModelCatalog {
  const providers = new Map<string, { name: string; models: string[] }>([[agent.id, { name: agent.name, models: [agentsChoice] }]]);
  const names: Record<string, string> = {};
  const models = known?.models ?? [];
  const byVendor = models.length > 0 && models.every((model) => !model.group && /^[^/]+\/.+/.test(model.id));
  for (const model of models) {
    let slug = agent.id;
    let heading = agent.name;
    let name = model.name;
    if (model.group) {
      slug = model.group.id;
      heading = model.group.name;
    } else if (byVendor) {
      slug = model.id.slice(0, model.id.indexOf("/"));
      // "Vendor/Model" names give the heading and leave the model's own name.
      const cut = model.name.indexOf("/");
      heading = cut > 0 ? model.name.slice(0, cut) : slug;
      name = cut > 0 && cut < model.name.length - 1 ? model.name.slice(cut + 1) : model.name;
    }
    // The agent's own model is listed as `default`, by its name, not a second time. It
    // stays named, so a thread set to it by its id is still taken.
    if (model.id === known?.own) {
      names[model.id] = name;
      names[agentsChoice] = name;
      continue;
    }
    if (name !== model.id) names[model.id] = name;
    const entry = providers.get(slug) ?? { name: heading, models: [] };
    entry.models.push(model.id);
    providers.set(slug, entry);
  }
  names[agentsChoice] ??= "Default";
  return {
    providers: [...providers].map(([slug, entry]) => ({ slug, name: entry.name, models: entry.models })),
    model: agentsChoice,
    provider: agent.id,
    reasoning: "",
    names,
  };
}
