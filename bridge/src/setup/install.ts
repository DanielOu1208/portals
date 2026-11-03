import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Paths } from "../config.ts";
import { hostOS, programFolders, type HostOS } from "../platform.ts";
import { isExecutable, type System } from "./system.ts";

// Installing the bridge where the LaunchAgent runs it: `app/` in the bridge's folder.
// `npx` keeps the package in a cache it may clear, so setup copies the package's
// built JavaScript there and installs what it needs to run.
//
// The Agent SDK is an optional peer dependency of the package, not a dependency, so
// `npx portals-host` does not fetch the copy of Claude Code the SDK carries (over
// 200 MB; the bridge runs the installed `claude`). The installed bridge gets the SDK as
// a dependency of its own, without that copy (`--omit=optional`).

/** The package this file is part of: the folder above dist/ (or src/). */
export const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

interface Manifest {
  name: string;
  version: string;
  description?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
}

export function readManifest(root = packageRoot): Manifest {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest;
}

/** The installed bridge's package.json: what it needs to run, the peer SDK included. */
export function appManifest(manifest: Manifest): Record<string, unknown> {
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    private: true,
    type: "module",
    dependencies: { ...manifest.dependencies, ...manifest.peerDependencies },
    ...(manifest.overrides ? { overrides: manifest.overrides } : {}),
  };
}

export class InstallError extends Error {}

/** The npm that came with the node running this, else the one on the PATH. */
export function findNpm(system: System): string | null {
  const beside = join(dirname(process.execPath), "npm");
  return isExecutable(beside) ? beside : system.which("npm");
}

/**
 * Copies this package's `dist/` and README into `paths.app` and installs its runtime
 * packages there. The copy is made beside the old one and swapped in only once npm
 * has finished, so a failed install leaves the running bridge as it was.
 */
export async function installApp(system: System, paths: Paths, root = packageRoot): Promise<{ version: string }> {
  const manifest = readManifest(root);
  if (!existsSync(join(root, "dist", "main.js"))) {
    throw new InstallError(`${root} has no dist/main.js. Build it first: npm run build`);
  }
  if (existsSync(paths.app) && realpathSync(paths.app) === realpathSync(root)) {
    // Running from the installed copy itself: it is already there.
    return { version: manifest.version };
  }
  const npm = findNpm(system);
  if (!npm) throw new InstallError("npm was not found. It comes with Node: https://nodejs.org");

  const next = `${paths.app}.new`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true, mode: 0o700 });
  cpSync(join(root, "dist"), join(next, "dist"), { recursive: true });
  for (const file of ["README.md"]) {
    if (existsSync(join(root, file))) cpSync(join(root, file), join(next, file));
  }
  writeFileSync(join(next, "package.json"), JSON.stringify(appManifest(manifest), null, 2) + "\n");

  const result = await system.run(npm, ["install", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: next,
    timeoutMs: 10 * 60_000,
    // npm's own scripts start with `#!/usr/bin/env node`.
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
  });
  if (result.code !== 0) {
    rmSync(next, { recursive: true, force: true });
    throw new InstallError(`npm install failed:\n${(result.stderr || result.stdout).trim()}`);
  }

  const old = `${paths.app}.old`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(paths.app)) renameSync(paths.app, old);
  try {
    renameSync(next, paths.app);
  } catch (error) {
    if (existsSync(old)) renameSync(old, paths.app);
    throw error;
  }
  rmSync(old, { recursive: true, force: true });
  return { version: manifest.version };
}

/** The version installed in `paths.app`, or null. */
export function installedVersion(paths: Paths): string | null {
  try {
    return readManifest(paths.app).version;
  } catch {
    return null;
  }
}

/**
 * The PATH the bridge runs with: the folders of the agents and node it uses, then the
 * usual ones (src/platform.ts). A LaunchAgent, or a systemd unit, does not get the PATH
 * of a terminal.
 */
export function bridgePath(programs: (string | null)[], os: HostOS = hostOS): string {
  const folders = [
    ...programs.filter((program): program is string => Boolean(program)).map((program) => dirname(program)),
    dirname(process.execPath),
    ...programFolders(os),
  ];
  return [...new Set(folders)].join(":");
}
