import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { expandHome } from "../../config.ts";
import { programVersion } from "../program.ts";
import { HermesClient, serveConnector } from "./client.ts";
import { ServeLocator, type ServeEndpoint } from "./serve.ts";

// What the bridge's setup asks about Hermes (docs/bridge-spikes.md, S5): is it
// installed, which version, and can it run a turn; and, when it is missing or cannot,
// the commands to offer. Nothing here installs or configures Hermes itself: the
// person runs those commands, which ask their own questions.

/** Hermes's own installer, from its README. It ends by running `hermes setup` unless given `--skip-setup`. */
export const installCommand = "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash";

/** Hermes's setup wizard: a provider and a model, then the rest. */
export const setupCommand = "hermes setup";

/** Only the provider and model, which is what a turn needs. */
export const modelSetupCommand = "hermes setup model";

/** Where Hermes's installer puts the command. */
const installedPath = join(homedir(), ".local", "bin", "hermes");

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The installed `hermes`: the configured one (`~` expanded, a bare name looked up on
 * PATH), else the installer's. Null when there is none.
 */
export function findHermes(configured: string, env: NodeJS.ProcessEnv = process.env, fallback = installedPath): string | null {
  const path = expandHome(configured);
  if (isAbsolute(path)) {
    if (executable(path)) return path;
  } else {
    for (const folder of (env.PATH ?? "").split(delimiter)) {
      if (folder && executable(join(folder, path))) return join(folder, path);
    }
  }
  return executable(fallback) ? fallback : null;
}

/** "Hermes Agent v0.21.5+5295.g234badf (2026.9.24) · …" → "0.21.5+5295.g234badf"; null when it does not run. */
export function hermesVersion(path: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return programVersion(path, env, /v(\d+\.\d+\.\d+\S*)/, 30_000);
}

export interface Readiness {
  /** A turn can run: Hermes has a provider and model it can use. */
  ready: boolean;
  /** Why not, in Hermes's words. */
  problem?: string;
  model?: string;
  provider?: string;
}

export interface ReadinessOptions {
  /** The installed `hermes`. */
  path: string;
  /** Start `hermes serve` to ask, when none runs. */
  start: boolean;
  /** Where a `hermes serve` started here runs from, and where it writes. */
  cwd: string;
  logPath: string;
  env?: NodeJS.ProcessEnv;
  /** Hermes's records folder (tests). */
  directory?: string;
  /** A Hermes profile; its default when absent. */
  profile?: string;
}

/**
 * Asks the running `hermes serve` (started first when allowed) whether a new session
 * could run a turn: the check Hermes's own apps make before their first message.
 */
export async function hermesReadiness(options: ReadinessOptions): Promise<Readiness> {
  const locator = new ServeLocator({ path: options.path, start: options.start, cwd: options.cwd, logPath: options.logPath, env: options.env, directory: options.directory });
  let endpoint: ServeEndpoint;
  try {
    endpoint = await locator.locate();
  } catch (error) {
    return { ready: false, problem: (error as Error).message };
  }
  const client = new HermesClient({ connect: serveConnector(async () => endpoint), backoff: [1] });
  try {
    const check = await client.call<{ ok?: boolean; error?: string; model?: string; provider?: string }>(
      "setup.runtime_check",
      options.profile ? { profile: options.profile } : {},
    );
    const readiness: Readiness = { ready: check?.ok === true };
    if (!readiness.ready) readiness.problem = typeof check?.error === "string" && check.error !== "" ? check.error : "Hermes has no provider it can use.";
    if (typeof check?.model === "string" && check.model !== "") readiness.model = check.model;
    if (typeof check?.provider === "string" && check.provider !== "") readiness.provider = check.provider;
    return readiness;
  } catch (error) {
    return { ready: false, problem: (error as Error).message };
  } finally {
    client.close();
  }
}
