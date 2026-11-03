import { execFile } from "node:child_process";
import { log } from "../log.ts";

// What an agent's installed program says its version is, and what a provider logs about
// it when the bridge starts. Each provider names the release it was built and tested
// against; another one still runs, with a warning.

/** Three numbers, as most programs print them: "codex-cli 0.160.1", "2.1.292 (Claude Code)". */
const threeNumbers = /(\d+\.\d+\.\d+)/;

/**
 * `<program> --version`, as the part of what it prints that `pattern` captures first:
 * "0.160.1". Null when the program cannot be run or prints something else.
 */
export function programVersion(path: string, env: NodeJS.ProcessEnv, pattern: RegExp = threeNumbers, timeoutMs = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { env, timeout: timeoutMs, killSignal: "SIGKILL" }, (error, stdout) => {
      resolve(error ? null : (pattern.exec(stdout)?.[1] ?? null));
    });
  });
}

export interface VersionReport {
  /** What to call the program: "Claude Code". */
  name: string;
  /** What `programVersion` gave. */
  version: string | null;
  /** The releases the bridge was tested with. */
  tested: string | readonly string[];
  /** Where the program was looked for, and the setting in config.json that says where. */
  path: string;
  setting: string;
}

/** Logs which version runs: an error when none does, a warning when it is not the tested one. */
export function reportVersion({ name, version, tested, path, setting }: VersionReport): void {
  const versions = typeof tested === "string" ? [tested] : tested;
  if (version === null) {
    log.error(`${name} was not found or did not run at ${path}. Set ${setting} in config.json.`);
  } else if (!versions.includes(version)) {
    log.warn(`${name} is ${version}; this bridge was tested with ${versions.join(", ")}. Check a thread before relying on it.`);
  } else {
    log.info(`${name} ${version}`);
  }
}
