import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { expandHome } from "../config.ts";
import { childEnvironment } from "../providers/claude/options.ts";
import { factoryAppDroids, isExecutable, standaloneDroids, type System } from "./system.ts";

// Finding the coding agents the bridge runs. Each is optional: the bridge offers the
// ones that are installed. It runs the installed command with that command's own
// sign-in, so setup only looks; it never installs or signs in to any of them.

export interface FoundAgent {
  /** The installed command, or null. */
  path: string | null;
  version: string | null;
  /** Whether it is signed in; null when that could not be told. */
  signedIn: boolean | null;
}

export const installHints = {
  claude: "Install it with: curl -fsSL https://claude.ai/install.sh | bash",
  codex: "Install it with: npm install -g @openai/codex",
  pi: "Install it with: npm install -g @earendil-works/pi-coding-agent",
  cursor: "Install it with: curl https://cursor.com/install -fsS | bash",
  droid: "Install Droid from https://docs.factory.ai/cli/getting-started/quickstart, then run droid and /login in a terminal.",
};

const notFound: FoundAgent = { path: null, version: null, signedIn: null };

function firstExecutable(paths: (string | null)[]): string | null {
  return paths.find((path): path is string => path !== null && isExecutable(path)) ?? null;
}

export async function findClaude(system: System): Promise<FoundAgent> {
  const path = firstExecutable([join(homedir(), ".local", "bin", "claude"), system.which("claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
  if (!path) return notFound;
  const versionRun = await system.run(path, ["--version"], { timeoutMs: 20_000 });
  // "2.1.295 (Claude Code)"
  const version = versionRun.code === 0 ? (versionRun.stdout.trim().split(/\s+/)[0] ?? null) : null;
  // Asked in the environment the bridge runs it in, without the terminal's ANTHROPIC_API_KEY:
  // with one, `auth status` says signed in by the key, which the bridge never passes on.
  const status = await system.run(path, ["auth", "status", "--json"], { timeoutMs: 20_000, env: childEnvironment(process.env, { clientApp: "portals-bridge", apiKey: null }) as NodeJS.ProcessEnv });
  let signedIn: boolean | null = null;
  try {
    signedIn = (JSON.parse(status.stdout) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    signedIn = null;
  }
  return { path, version, signedIn };
}

export async function findCodex(system: System): Promise<FoundAgent> {
  const path = firstExecutable([system.which("codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);
  if (!path) return notFound;
  const versionRun = await system.run(path, ["--version"], { timeoutMs: 20_000 });
  // "codex-cli 0.162.0"
  const version = versionRun.code === 0 ? (versionRun.stdout.trim().split(/\s+/).at(-1) ?? null) : null;
  const status = await system.run(path, ["login", "status"], { timeoutMs: 20_000 });
  return { path, version, signedIn: status.code === 0 && /logged in/i.test(status.stdout + status.stderr) && !/not logged in/i.test(status.stdout + status.stderr) };
}

/**
 * Where `pi` is looked for when it is not on PATH: beside the `node` setup runs under,
 * where `npm install -g` puts it, and the two folders Homebrew's node uses for that.
 */
export function piFolders(): string[] {
  return [dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin"];
}

/**
 * Pi keeps a sign-in of its own for each model provider and has no command that says
 * which it has, so `signedIn` is always null. `folders` is where to look besides PATH.
 */
export async function findPi(system: System, folders: string[] = piFolders()): Promise<FoundAgent> {
  const path = firstExecutable([system.which("pi"), ...folders.map((folder) => join(folder, "pi"))]);
  if (!path) return notFound;
  const versionRun = await system.run(path, ["--version"], { timeoutMs: 20_000 });
  // "1.1.0"
  const version = versionRun.code === 0 ? (versionRun.stdout.trim().split(/\s+/).at(-1) ?? null) : null;
  return { path, version: version || null, signedIn: null };
}

/** Cursor's command-line agent, `cursor-agent`: where its installer puts it, else on the PATH. */
export async function findCursor(system: System): Promise<FoundAgent> {
  const path = firstExecutable([join(homedir(), ".local", "bin", "cursor-agent"), system.which("cursor-agent")]);
  if (!path) return notFound;
  const versionRun = await system.run(path, ["--version"], { timeoutMs: 20_000 });
  // "2026.10.01-e373342"
  const version = versionRun.code === 0 ? (/\d+\.\d+\.\d+/.exec(versionRun.stdout)?.[0] ?? null) : null;
  // "✓ Logged in as <email>", or "Not logged in". Read for those words only: the rest is never shown or kept.
  const status = await system.run(path, ["status"], { timeoutMs: 20_000 });
  const said = status.stdout + status.stderr;
  const signedIn = /not logged in|partially authenticated/i.test(said) ? false : status.code === 0 && /logged in|login successful/i.test(said) ? true : null;
  return { path, version, signedIn };
}

/** The configured Droid executable, with `~` expanded and a bare name found on PATH. */
export function droidProgram(
  configured: string, env: NodeJS.ProcessEnv = process.env, apps = factoryAppDroids(), standalone = standaloneDroids(),
): string | null {
  const path = expandHome(configured);
  const candidates = isAbsolute(path) ? [path] : (env.PATH ?? "").split(delimiter).filter(Boolean).map((folder) => join(folder, path));
  if (configured === "~/.local/bin/droid") {
    candidates.push(...(env.PATH ?? "").split(delimiter).filter(Boolean).map((folder) => join(folder, "droid")),
      ...standalone, ...apps);
  }
  return firstExecutable(candidates);
}

/** Discovery only: no login command or credential files are read. */
export async function findDroid(system: System, configured?: string): Promise<FoundAgent> {
  let preferred: string | null = null;
  if (configured) {
    const expanded = expandHome(configured);
    preferred = isAbsolute(expanded) ? expanded : system.which(configured);
  }
  const path = firstExecutable([
    preferred,
    join(homedir(), ".local", "bin", "droid"),
    system.which("droid"),
    ...(system.standaloneDroids?.() ?? []),
    ...(system.appDroids?.() ?? []),
  ]);
  if (!path) return notFound;
  // The documented updater switch applies only to this probe, never global settings.
  const versionRun = await system.run(path, ["--version"], {
    timeoutMs: 20_000,
    env: { ...process.env, FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
  });
  const version = versionRun.code === 0 ? (/\d+\.\d+\.\d+/.exec(versionRun.stdout)?.[0] ?? null) : null;
  return { path, version, signedIn: null };
}

/** Whether an Anthropic API key looks like one (`sk-ant-…`); it is not tried. */
export function looksLikeAnthropicKey(key: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}
