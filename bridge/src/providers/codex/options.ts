import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readGitText } from "../../git.ts";
import { programVersion } from "../program.ts";
import type { ThreadMode } from "../types.ts";
import type { AskForApproval, SandboxPolicy, TurnStartParams } from "./types/index.ts";

// How the bridge sets Codex up: which daemon, what `/mode` means in Codex's own terms,
// and the thinking levels. The config.toml is never written: everything here goes
// with one thread's turns (`turn/start`), which Codex keeps for that thread only.

/** The Codex release the bridge was built and tested against (docs/bridge-spikes.md). */
export const testedCodexVersion = "0.166.0";

/** The shared app-server daemon's socket for `~/.codex`. */
export function defaultSocketPath(): string {
  return join(homedir(), ".codex", "app-server-control", "app-server-control.sock");
}

/** What Codex runs with: who may approve, and where it may write. */
export interface Policy {
  approvalPolicy: AskForApproval;
  sandboxPolicy: SandboxPolicy;
}

/** Codex's sandbox modes as `config.toml` names them. */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** config.toml's `[sandbox_workspace_write]`: what the workspace-write sandbox lets through besides the thread's folder. */
export interface WorkspaceWrite {
  writableRoots: string[];
  networkAccess: boolean;
  excludeTmpdirEnvVar: boolean;
  excludeSlashTmp: boolean;
}

/** The sandbox policy for a sandbox mode; workspace-write as config.toml's `[sandbox_workspace_write]` sets it up. */
export function sandboxPolicy(mode: SandboxMode, workspace?: WorkspaceWrite): SandboxPolicy {
  switch (mode) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: workspace?.writableRoots ?? [],
        networkAccess: workspace?.networkAccess ?? false,
        excludeTmpdirEnvVar: workspace?.excludeTmpdirEnvVar ?? false,
        excludeSlashTmp: workspace?.excludeSlashTmp ?? false,
      };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
  }
}

/** The modes a turn runs with: plan mode carries out its plan in another of them. */
export type WorkMode = Exclude<ThreadMode, "plan">;

/**
 * What `/mode` names, in Codex's terms (docs/bridge-spikes.md, S3). `default` is
 * whatever config.toml says, and where it says nothing what Codex itself does for the
 * thread's folder; null while config.toml is not known. The session sends it only to
 * undo another mode: a thread in `default` all along keeps what Codex has. Plan mode is
 * not a policy but Codex's own plan mode (`collaborationMode`), which runs with the
 * policy of the mode its plan is carried out in.
 */
export function policyFor(mode: WorkMode, defaults: DesktopDefaults | null, cwd?: string): Policy | null {
  switch (mode) {
    case "medium":
      throw new Error("Codex does not offer Medium autonomy.");
    case "ask":
      return { approvalPolicy: "untrusted", sandboxPolicy: sandboxPolicy("workspace-write", defaults?.workspaceWrite) };
    case "edits":
      return { approvalPolicy: "on-request", sandboxPolicy: sandboxPolicy("workspace-write", defaults?.workspaceWrite) };
    case "full":
      return { approvalPolicy: "never", sandboxPolicy: sandboxPolicy("danger-full-access") };
    case "default": {
      if (!defaults) return null;
      const settled = settledDefaults(defaults, cwd);
      return { approvalPolicy: settled.approvalPolicy, sandboxPolicy: sandboxPolicy(settled.sandbox, defaults.workspaceWrite) };
    }
  }
}

/**
 * The approval policy and sandbox a thread in `cwd` runs with when nothing overrides
 * them: config.toml's, and for what it leaves out Codex's own choice, which goes by how
 * far config.toml trusts the folder's project (checked against Codex 0.162.1: a trusted
 * project asks on request and writes in its folder, an untrusted one asks before
 * anything but the safest commands and writes in its folder, any other only reads).
 */
export function settledDefaults(defaults: DesktopDefaults, cwd?: string): { approvalPolicy: AskForApproval; sandbox: SandboxMode } {
  if (defaults.approvalPolicy && defaults.sandbox) return { approvalPolicy: defaults.approvalPolicy, sandbox: defaults.sandbox };
  const trust = cwd ? projectTrust(cwd, defaults.projects) : null;
  return {
    approvalPolicy: defaults.approvalPolicy ?? (trust === "untrusted" ? "untrusted" : "on-request"),
    sandbox: defaults.sandbox ?? (trust === null ? "read-only" : "workspace-write"),
  };
}

/** How far config.toml's `[projects]` trusts the folder: the folder itself, else the git repository it is in. */
export function projectTrust(cwd: string, projects: Record<string, string>): "trusted" | "untrusted" | null {
  for (const path of [cwd, repositoryRoot(cwd)]) {
    const level = path ? projects[path] : undefined;
    if (level === "trusted" || level === "untrusted") return level;
  }
  return null;
}

/**
 * The git repository a folder is in, as Codex finds it for trust: the folder with the
 * `.git`; for a worktree, its main repository's. Null outside a repository.
 */
function repositoryRoot(cwd: string): string | null {
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    const marker = join(folder, ".git");
    if (existsSync(marker)) {
      try {
        if (statSync(marker).isDirectory()) return folder;
        const pointer = /^gitdir:\s*(.+)$/m.exec(readGitText(marker) ?? "")?.[1]?.trim();
        const gitdir = pointer ? (isAbsolute(pointer) ? pointer : resolve(folder, pointer)) : "";
        const main = /^(.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(gitdir)?.[1];
        return main ?? folder;
      } catch {
        return folder;
      }
    }
    if (dirname(folder) === folder) return null;
  }
}

/**
 * Codex's plan mode or its default one, with the model and thinking level the turn runs
 * with (a collaboration mode takes their place); its instructions are Codex's own.
 */
export function collaborationMode(mode: "plan" | "default", model: string, effort: string | null): CollaborationMode {
  return { mode, settings: { model, reasoning_effort: effort, developer_instructions: null } };
}

export type CollaborationMode = NonNullable<TurnStartParams["collaborationMode"]>;

/** What config.toml sets, as far as the bridge cares (`config/read`). */
export interface DesktopDefaults {
  model: string | null;
  effort: string | null;
  approvalPolicy: AskForApproval | null;
  sandbox: SandboxMode | null;
  workspaceWrite: WorkspaceWrite;
  /** `model_reasoning_summary`; null when config.toml leaves it to Codex. */
  summary: string | null;
  /** `developer_instructions`, the active profile's first: a thread given its own replaces them. */
  developerInstructions: string | null;
  /** How far `[projects]` trusts each folder it names (`trust_level`). */
  projects: Record<string, string>;
}

export function desktopDefaults(config: Record<string, any> | undefined): DesktopDefaults {
  const profile = typeof config?.profile === "string" ? config?.profiles?.[config.profile] : undefined;
  // The active profile's settings come before the file's own, as in Codex.
  const sandbox = profile?.sandbox_mode ?? config?.sandbox_mode;
  const instructions = profile?.developer_instructions ?? config?.developer_instructions;
  const workspace = config?.sandbox_workspace_write ?? {};
  // Folders as Codex takes them: absolute, or from the home folder.
  const roots = Array.isArray(workspace.writable_roots) ? workspace.writable_roots.filter((root: unknown): root is string => typeof root === "string") : [];
  const projects: Record<string, string> = {};
  for (const [path, project] of Object.entries((config?.projects ?? {}) as Record<string, any>)) {
    if (typeof project?.trust_level === "string") projects[path] = project.trust_level;
  }
  return {
    model: typeof config?.model === "string" ? config.model : null,
    effort: typeof config?.model_reasoning_effort === "string" ? config.model_reasoning_effort : null,
    approvalPolicy: profile?.approval_policy ?? config?.approval_policy ?? null,
    sandbox: sandbox === "read-only" || sandbox === "workspace-write" || sandbox === "danger-full-access" ? sandbox : null,
    workspaceWrite: {
      writableRoots: roots.flatMap((root: string) => (root.startsWith("~/") ? [join(homedir(), root.slice(2))] : isAbsolute(root) ? [root] : [])),
      networkAccess: workspace.network_access === true,
      excludeTmpdirEnvVar: workspace.exclude_tmpdir_env_var === true,
      excludeSlashTmp: workspace.exclude_slash_tmp === true,
    },
    summary: typeof config?.model_reasoning_summary === "string" ? config.model_reasoning_summary : null,
    developerInstructions: typeof instructions === "string" && instructions.trim() !== "" ? instructions : null,
    projects,
  };
}

/** The `/mode` word for an approval policy and sandbox, when there is one. Plan mode is none: it is Codex's own. */
export function threadModeFor(approval: AskForApproval | null | undefined, sandbox: SandboxMode | null | undefined): Exclude<WorkMode, "default"> | null {
  if (approval === "never" && sandbox === "danger-full-access") return "full";
  if (approval === "untrusted" && sandbox === "workspace-write") return "ask";
  if (approval === "on-request" && sandbox === "workspace-write") return "edits";
  return null;
}

/** The app's thinking levels, weakest first, as far as Codex has them. */
const ladder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * A level the app sends (AgentCore/ModelSetting.swift) as one the model has: the level
 * itself, else the nearest one above it, else the strongest it has. "" is no level.
 */
export function codexEffort(level: string, supported: readonly string[]): string | null {
  if (level === "" || supported.length === 0) return level === "" ? null : level;
  if (supported.includes(level)) return level;
  const at = ladder.indexOf(level);
  if (at < 0) return null;
  const above = ladder.slice(at + 1).find((candidate) => supported.includes(candidate));
  if (above) return above;
  return [...ladder].reverse().find((candidate) => supported.includes(candidate)) ?? null;
}

/** `codex --version`, as "0.160.1"; null when it cannot be run. */
export function codexVersion(codexPath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return programVersion(codexPath, env);
}
