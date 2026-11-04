import type { ModelCatalog } from "../types.ts";

/** Gateway model IDs are opaque, but its names and levels are keyed by model alone. */
export function modelKey(id: string, provider: string): string {
  return id && provider ? `${provider}/${id}` : id;
}

/** Accept legacy raw IDs as well as the provider-qualified picker IDs. */
export function nativeModelID(key: string, provider: string): string {
  const prefix = `${provider}/`;
  return provider && key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/** Native names still arrive from typed config.set and fleet/spawn commands. */
export function modelChoice(catalog: ModelCatalog, model: string, providerSlug?: string, currentProvider?: string): { model: string; providerSlug?: string } {
  if (providerSlug) {
    const provider = catalog.providers.find((provider) => provider.slug === providerSlug);
    if (!provider) return { model, providerSlug };
    const chosen = provider.models.find((key) => key === model)
      ?? provider.models.find((key) => nativeModelID(key, providerSlug) === model);
    if (!chosen) throw new Error(`OpenCode cannot run the model ${model} with provider ${providerSlug}. Choose a model offered by that provider.`);
    return { model: chosen, providerSlug };
  }
  if (catalog.providers.some((provider) => provider.models.includes(model))) return { model, providerSlug };
  const candidates = catalog.providers.flatMap((provider) => provider.models
    .filter((key) => key.slice(key.indexOf("/") + 1) === model)
    .map((key) => ({ model: key, providerSlug: provider.slug })));
  let choices = candidates;
  if (currentProvider) {
    const current = choices.filter((choice) => choice.providerSlug === currentProvider);
    if (current.length) choices = current;
  }
  if (choices.length === 1) return choices[0];
  if (choices.length > 1) throw new Error(`OpenCode model ${model} is offered by several providers. Choose ${choices.map((choice) => choice.model).join(" or ")}.`);
  return { model, providerSlug };
}
