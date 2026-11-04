import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { onPath, type CommandAccess } from "../../portals/access.ts";
import { codexEffort } from "../codex/options.ts";
import { programVersion } from "../program.ts";
import { knownLevels } from "../types.ts";
import type { PiModel } from "./protocol.ts";

// The Pi releases the bridge was tested with, Pi's thinking levels and the app's, and what
// a Pi process is started with. Pi's levels are `off`, `minimal`, `low`, `medium`, `high`,
// `xhigh` and `max`; the app's `none` is Pi's `off`, the rest go by the same names, and
// the app's `ultra` is the strongest a model has.

/**
 * The Pi releases the bridge was built and tested against. Pi's RPC mode is the same
 * from 1.1.0 to 1.5.0, its documentation and code byte for byte. Another release runs,
 * with a warning at start.
 */
export const testedPiVersions = ["1.1.0", "1.5.0"] as const;

/**
 * The oldest Pi a turn runs on: an older one lacks records a turn ends by
 * (`agent_settled` came in 0.80.4, a `prompt`'s `disposition` in 0.99.0, `aborted` in
 * 1.1.0), so a turn on it could run for ever.
 */
export const minimumPiVersion = "1.1.0";

/** The extension beside this module, both in the source tree and the built package. */
const permissionExtension = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./permission-extension.ts" : "./permission-extension.js", import.meta.url));

/** `pi --version`, as "1.1.0"; null when it cannot be run. */
export function piVersion(piPath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return programVersion(piPath, env);
}

/** Pi's levels, weakest first. */
export const piLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** One of Pi's levels as the app names it; "" for a word that is none of Pi's. */
export function appLevel(piLevel: string | undefined): string {
  if (piLevel === "off") return "none";
  return (piLevels as readonly string[]).includes(piLevel ?? "") ? piLevel! : "";
}

/**
 * The levels a model takes, as the app names them, weakest first. RPC gives the exact
 * list for the current model only (`get_available_thinking_levels`), so this is Pi's own
 * rule for any model (pi-ai's `getSupportedThinkingLevels`): only `off` for one that does
 * not think; else `off` to `high`, less any its `thinkingLevelMap` sets to null, plus
 * `xhigh` and `max` when the map names them.
 */
export function modelLevels(model: Pick<PiModel, "reasoning" | "thinkingLevelMap">): string[] {
  if (model.reasoning !== true) return ["none"];
  const map = model.thinkingLevelMap ?? {};
  const taken = piLevels.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
  return knownLevels(taken.map(appLevel));
}

/**
 * A level the app sends, as the one to give Pi for a model that takes `supported` (the
 * app's names, from `modelLevels`): the level itself, else the nearest one above it,
 * else the strongest the model has. Null for "" (no level chosen) and for a word that is
 * no level. Pi clamps whatever it is sent, by the same rule.
 */
export function piLevel(level: string, supported: readonly string[]): string | null {
  const nearest = level === "" ? null : codexEffort(level, supported);
  if (nearest === null || appLevel(nearest === "none" ? "off" : nearest) === "") return null;
  return nearest === "none" ? "off" : nearest;
}

// MARK: Starting a process

/**
 * What a thread's process starts with: Pi's RPC mode on the session whose id is the
 * thread's, which Pi opens when the folder has one and makes when not. `append` is a
 * few lines for the end of Pi's system prompt (the `portals` command, how the app
 * shows math), when there are any. Nothing says whether a project's own `.pi/`
 * resources load: that is Pi's own setting, as at the desk.
 *
 * Pi takes `--append-system-prompt` in place of the file it would have appended by
 * itself (`APPEND_SYSTEM.md`, a trusted project's or else the one in its own folder,
 * `agentDir`), so the user's own file is named first, and the lines after it. A
 * project's file is not named: whether Pi trusts the project is Pi's to say.
 */
export function threadArguments(thread: string, append: string | null, agentDir: string): string[] {
  const args = ["--mode", "rpc", "--session-id", thread, "-e", permissionExtension];
  if (!append) return args;
  const own = join(agentDir, "APPEND_SYSTEM.md");
  if (isFile(own)) args.push("--append-system-prompt", own);
  args.push("--append-system-prompt", append);
  return args;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** What the short-lived Pi that is asked for the models and the commands starts with: no session, and nothing fetched as it starts. */
export const catalogArguments = ["--mode", "rpc", "--no-session", "--offline"];

/**
 * What the one-shot Pi that names a thread starts with (`pi --print`): the model
 * ("provider/id") at no thinking, `instructions` in place of Pi's system prompt, and
 * none of what the user's Pi loads besides its sign-ins: no session, no tools, no
 * extensions, MCP servers, skills, prompt templates, themes or context files (AGENTS.md),
 * nothing fetched as it starts. The prompt is the one message: it begins with a word of
 * the bridge's, never an `@` Pi would read as a file.
 */
export function titleArguments(model: string, instructions: string, prompt: string): string[] {
  return [
    "--print", "--no-session", "--offline",
    "--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    "--model", model, "--thinking", "off",
    "--system-prompt", instructions,
    "--", prompt,
  ];
}

/**
 * What the short-lived Pi that copies a session starts with: Pi's own `--fork` of the
 * session file `source`, into a new session under `id` in the folder it is started in.
 * Pi writes the copy as it starts, and fails when it already has a session by that id.
 */
export function forkArguments(source: string, id: string): string[] {
  return ["--mode", "rpc", "--fork", source, "--session-id", id, "--offline"];
}

/**
 * The id of a copy the bridge has Pi make of a session from the desk (`session.adopt`
 * mode `fork`). It says what the session is: one the bridge made, which no terminal had
 * when it was taken up, where a session continued from the desk is asked about before
 * every turn. A restarted bridge knows a copy by it, and the desk's list leaves it out.
 */
export function forkId(uuid: string): string {
  return `fork-${uuid}`;
}

export function isForkId(id: string): boolean {
  return id.startsWith("fork-");
}

/**
 * The environment a Pi process starts with: the bridge's own, with the folder of
 * `piPath` first on PATH (`pi` is a script, run by whichever `node` comes first there)
 * and before it the folder of the `portals` command, when the bridge offers it. A
 * thread's process is told which thread it is, so it can say so when it uses that
 * command.
 */
export function piEnvironment(parent: NodeJS.ProcessEnv, piPath: string, portals: CommandAccess | undefined, thread: string | null): NodeJS.ProcessEnv {
  let env: NodeJS.ProcessEnv = { ...parent };
  // A bare name is found on PATH as it is.
  if (piPath.includes("/")) env = onPath(env, dirname(piPath));
  if (!portals) return env;
  env = onPath(env, portals.bin);
  if (thread !== null) env.PORTALS_THREAD = thread;
  return env;
}
