import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";

// The programs setup runs (launchctl or systemctl, tailscale, npm, claude, codex, pi),
// behind one small interface so the tests can stand in for them. Nothing here goes
// through a shell.

export interface RunResult {
  /** The exit code; 127 when the program could not be started. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Given to the program on standard input. */
  input?: string;
  /** Stopped after this long (default 60 s), answering code 124. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Runs it in this terminal, to ask its own questions; nothing is captured. */
  inherit?: boolean;
}

export interface System {
  run(program: string, args: string[], options?: RunOptions): Promise<RunResult>;
  /** The path of `name` on the PATH, or null. */
  which(name: string): string | null;
  /** The user's id, for launchd's `gui/<uid>` domain and the runtime folder of systemd's user manager. */
  uid: number;
  /** Where a droid installed on its own lands outside PATH (`standaloneDroids`); none when absent. */
  standaloneDroids?(): string[];
  /** Where an installed app keeps a droid of its own (`factoryAppDroids`); none when absent. */
  appDroids?(): string[];
}

/**
 * The droid that comes inside the Factory app on a Mac, which updates with the app: someone
 * who installed only the app has the CLI there and nowhere else (2026-10-30: "i have
 * the factory app installed doesnt that install the cli"). Tried after every other place.
 */
/**
 * Where a droid installed on its own lands outside PATH: beside the Node the bridge runs on,
 * and Homebrew's folders. Tried after PATH and before the Factory app's own (Codex's review).
 */
export function standaloneDroids(): string[] {
  return [join(dirname(process.execPath), "droid"), "/opt/homebrew/bin/droid", "/usr/local/bin/droid"];
}

export function factoryAppDroids(home = homedir(), platform = process.platform): string[] {
  if (platform !== "darwin") return [];
  const inside = join("Factory.app", "Contents", "Resources", "bin", "droid");
  return [join("/Applications", inside), join(home, "Applications", inside)];
}

export const realSystem: System = {
  run(program, args, options = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(program, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"] });
      } catch (error) {
        resolve({ code: 127, stdout: "", stderr: (error as Error).message });
        return;
      }
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({ code: 124, stdout, stderr: stderr + `\n${program} took too long and was stopped.` });
      }, options.timeoutMs ?? 60_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.input ?? "");
    });
  },
  which(name) {
    for (const folder of (process.env.PATH ?? "").split(delimiter)) {
      if (!folder) continue;
      const path = join(folder, name);
      if (isExecutable(path)) return path;
    }
    return null;
  },
  uid: process.getuid?.() ?? 501,
  standaloneDroids: () => standaloneDroids(),
  appDroids: () => factoryAppDroids(),
};

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where setup finds `launchctl`, `systemctl`, `loginctl`, `sudo` and `tailscale`.
 * `PORTALS_SETUP_LAUNCHCTL`, `PORTALS_SETUP_SYSTEMCTL` and the like name stand-ins
 * instead, to try setup without touching launchd, systemd or the tailnet; nothing else
 * should set them.
 */
export function programOverride(name: "launchctl" | "systemctl" | "loginctl" | "sudo" | "tailscale", env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[`PORTALS_SETUP_${name.toUpperCase()}`]?.trim();
  return value || undefined;
}
