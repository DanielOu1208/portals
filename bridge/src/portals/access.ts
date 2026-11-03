import { delimiter } from "node:path";
import type { Config, Paths } from "../config.ts";
import { agentInstructions, mathInstructions, visualInstructions } from "./guide.ts";

// What an agent the bridge runs is given of the `portals` command (docs/fleet-plan.md),
// and of how the app shows its replies.

export interface CommandAccess {
  /** The folder the command is in, put first on the agent's PATH. */
  bin: string;
  /**
   * A few lines for the agent's instructions: the command's, unless agents are not
   * told of it (`fleet.tellAgents`), then how the app shows math, then that it shows
   * visuals, unless agents are not told (`visuals.tellAgents`). Null for none.
   */
  instructions: string | null;
}

export function commandAccess(config: Config, paths: Paths): CommandAccess {
  const told = config.fleet.tellAgents ? agentInstructions(paths.command) : null;
  const visuals = config.visuals.tellAgents ? visualInstructions(paths.command) : null;
  return { bin: paths.bin, instructions: [told, mathInstructions, visuals].filter(Boolean).join("\n\n") };
}

/**
 * What says which thread a command runs in, first to last (`thread`): the bridge's own
 * (`PORTALS_THREAD`, which it gives each Claude Code, Pi and Droid thread's process), and
 * those Codex and Cursor give each command they run, one process running many threads.
 */
export const threadVariables = ["PORTALS_THREAD", "CODEX_THREAD_ID", "CURSOR_CONVERSATION_ID"] as const;

/** The thread a command runs in, as its environment says (`threadVariables`); undefined when none does. */
export function thread(env: Record<string, string | undefined>): string | undefined {
  for (const name of threadVariables) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * `env` with the command's folder first on its PATH, and none of `threadVariables`: an
 * agent's process must not take them from the bridge's own environment (a bridge started
 * from an agent's shell), where they name a thread that is not its own.
 */
export function onPath<T extends Record<string, string | undefined>>(env: T, bin: string): T {
  const clean: Record<string, string | undefined> = { ...env, PATH: env.PATH ? `${bin}${delimiter}${env.PATH}` : bin };
  for (const name of threadVariables) delete clean[name];
  return clean as T;
}
