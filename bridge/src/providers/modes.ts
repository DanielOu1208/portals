import type { ModeOption, ModeState, Provider } from "./types.ts";

export function providerModeOptions(provider: Provider): ModeOption[] | undefined {
  // modeMeanings complete a sentence in /mode; they are not standalone picker text.
  return provider.modeOptions;
}

export function modeFields(state: ModeState | null): Record<string, unknown> {
  if (!state) return {};
  return {
    mode: state.mode,
    ...(state.defaultsTo ? { mode_default: state.defaultsTo } : {}),
    ...(state.options ? { mode_options: state.options } : {}),
  };
}
