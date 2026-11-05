import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { expandHome } from "../../config.ts";
import { isExecutable } from "../../setup/system.ts";
import { compareVersions } from "../program.ts";

/** The OpenCode, and the `@opencode/client`, the bridge was built and tested with. */
export const testedOpenCodeVersion = "2.2.5";
/** The 2.2 API added keyed session instructions; 1.x is a separate, incompatible line. */
export const minimumOpenCodeVersion = "2.2.0";

/** Both the executable and any surviving native service must support this API. */
export function supportedOpenCodeVersion(version: string | null): boolean {
  return majorVersion(version) === 2 && version !== null && compareVersions(version, minimumOpenCodeVersion) >= 0;
}

/** Where OpenCode's installers put `opencode`, after the PATH: its own script, then Homebrew's two prefixes. */
export function opencodeFolders(): string[] {
  return [join(homedir(), ".opencode", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

/** The configured `opencode`, `~` expanded; a bare name is looked for on PATH, then where the installers put it. */
export function opencodeProgram(configured: string, env: NodeJS.ProcessEnv = process.env, folders = opencodeFolders()): string | null {
  const path = expandHome(configured);
  if (isAbsolute(path)) return isExecutable(path) ? path : null;
  const candidates = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...folders].map((folder) => join(folder, path));
  return candidates.find((candidate) => isExecutable(candidate)) ?? null;
}

/** The first number of a version ("2.2.5" → 2); null when there is none. */
export function majorVersion(version: string | null): number | null {
  const major = /^(\d+)\./.exec(version ?? "")?.[1];
  return major === undefined ? null : Number(major);
}
