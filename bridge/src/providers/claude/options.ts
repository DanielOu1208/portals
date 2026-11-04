import { execFile } from "node:child_process";
import type { CanUseTool, EffortLevel, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { counters } from "../../counters.ts";
import { programVersion } from "../program.ts";
import type { ThreadMode } from "../types.ts";

// How the bridge starts Claude Code: the installed `claude`, the user's own settings and
// login, and an environment cleaned of anything that would confuse a child session.
// The bridge never reads, stores or forwards Claude credentials: the installed
// `claude` signs in with its own login (in the Keychain on a Mac, in
// ~/.claude/.credentials.json on Linux). Only `claude.apiKey` in config.json, off by
// default, gives the child an API key instead.

/** The Claude Code release the bridge was built and tested against (docs/bridge-spikes.md). */
export const testedClaudeVersion = "2.1.299";

/** Claude's own thinking levels. */
export const claudeEfforts: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The environment for `claude`: the bridge's own, without what would change who it
 * signs in as or make it think it runs inside another Claude Code session. With
 * `toolSummaries`, Claude Code says in a few words what each run of its tool calls on the
 * main thread did (`tool_use_summary`, one small model call of its own each; seen headless
 * on 2.1.299, 2026-10-26), for the app's status line (feature status_headline).
 */
export function childEnvironment(parent: NodeJS.ProcessEnv, options: { clientApp: string; apiKey: string | null; toolSummaries?: boolean }): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(parent)) {
    // Inherited ones (from a terminal Claude Code that started the bridge) break a child session.
    if (key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE" || key === "CLAUDE_PID" || key === "CLAUDE_EFFORT") continue;
    // Credentials come from claude's own login, or from config.json, never from the bridge's environment.
    if (key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN") continue;
    env[key] = value;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = options.clientApp;
  if (options.apiKey) env.ANTHROPIC_API_KEY = options.apiKey;
  if (options.toolSummaries) env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES = "1";
  return env;
}

export interface QuerySetup {
  claudePath: string;
  cwd: string;
  env: Record<string, string | undefined>;
  /** A session the bridge has not started yet: its id is chosen here. */
  sessionId?: string;
  /** A session that has history: it is resumed. */
  resume?: string;
  /** A model alias or id; "default" or "" leaves it to Claude Code. */
  model: string;
  /** null leaves the mode to the user's settings. */
  permissionMode: PermissionMode | null;
  effort: EffortLevel | null;
  /** Thinking text only streams with the summarized display; models without adaptive thinking get it from `setMaxThinkingTokens` instead. */
  adaptiveThinking: boolean;
  /** The title of a new session, instead of one Claude makes up. */
  title?: string;
  /** Lines added to Claude Code's own system prompt (the `portals` command). */
  append?: string;
  canUseTool: CanUseTool;
  stderr?: (data: string) => void;
}

export function queryOptions(setup: QuerySetup): Options {
  const options: Options = {
    pathToClaudeCodeExecutable: setup.claudePath,
    cwd: setup.cwd,
    env: setup.env,
    // The user's settings, CLAUDE.md files and plugins, as at the desk.
    settingSources: ["user", "project", "local"],
    systemPrompt: setup.append ? { type: "preset", preset: "claude_code", append: setup.append } : { type: "preset", preset: "claude_code" },
    // His default mode is bypassPermissions, which needs this.
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    canUseTool: setup.canUseTool,
    // The app stops subagents and workflows one at a time (`subagent.stop`), so Stop on
    // the turn stops only the turn and leaves them running; without this Claude Code
    // would stop them with it.
    perTaskStopAffordance: true,
    // A line every half minute or so on what each subagent is doing, for its row.
    agentProgressSummaries: true,
  };
  if (setup.resume) options.resume = setup.resume;
  else if (setup.sessionId) options.sessionId = setup.sessionId;
  if (setup.model && setup.model !== "default") options.model = setup.model;
  if (setup.permissionMode) options.permissionMode = setup.permissionMode;
  if (setup.effort) options.effort = setup.effort;
  if (setup.adaptiveThinking) options.thinking = { type: "adaptive", display: "summarized" };
  if (setup.title) options.title = setup.title;
  if (setup.stderr) options.stderr = setup.stderr;
  return options;
}

/** The thinking budget for models without adaptive thinking (Haiku 4.5), by effort. */
export function thinkingBudget(effort: EffortLevel | null): number {
  switch (effort) {
    case "low":
      return 2048;
    case "medium":
      return 4096;
    case "xhigh":
      return 16_000;
    case "max":
      return 31_999;
    default:
      return 8192;
  }
}

/**
 * A level the app sends (AgentCore/ModelSetting.swift) as one Claude has. Levels Claude
 * lacks go to the nearest it has; "" is no level at all.
 */
export function claudeEffort(level: string): EffortLevel | null {
  switch (level) {
    case "none":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
    case "ultra":
      return "max";
    default:
      return null;
  }
}

/**
 * What `/mode` names, as Claude's permission modes. `default` is no override; `medium` is
 * Claude Code's auto mode, in which a classifier approves or blocks each call and asks
 * only when it cannot tell.
 */
export function permissionModeFor(mode: ThreadMode): PermissionMode | null {
  switch (mode) {
    case "medium":
      return "auto";
    case "ask":
      return "default";
    case "edits":
      return "acceptEdits";
    case "plan":
      return "plan";
    case "full":
      return "bypassPermissions";
    case "default":
      return null;
  }
}

/** A permission mode Claude reports, as the `/mode` word for it; null for modes `/mode` has no word for. */
export function threadModeFor(mode: string | undefined | null): Exclude<ThreadMode, "default"> | null {
  switch (mode) {
    case "default":
      return "ask";
    case "acceptEdits":
      return "edits";
    case "plan":
      return "plan";
    case "auto":
      return "medium";
    case "bypassPermissions":
      return "full";
    default:
      return null;
  }
}

/** `claude --version`, as "2.1.292"; null when it cannot be run. */
export function claudeVersion(claudePath: string, env: Record<string, string | undefined>): Promise<string | null> {
  return programVersion(claudePath, env as NodeJS.ProcessEnv);
}

/**
 * The Claude Code sessions running on this Mac in terminals (or in the background), from
 * `claude agents --json`, without the bridge's own: its processes are listed too, as
 * interactive ones, and are told apart by being its children.
 */
export async function desktopAgents(claudePath: string, env: Record<string, string | undefined>): Promise<unknown> {
  const [listed, children] = await Promise.all([claudeAgents(claudePath, env), childProcesses()]);
  return withoutOwn(listed, children);
}

/** What `claude agents --json` listed, without the processes in `children`. */
export function withoutOwn(listed: unknown, children: Set<number>): unknown {
  if (!Array.isArray(listed)) return listed;
  return listed.filter((agent) => !(typeof agent?.pid === "number" && children.has(agent.pid)));
}

/** The ids of this process's children; empty when `ps` cannot say. */
function childProcesses(): Promise<Set<number>> {
  return new Promise((resolve) => {
    if (counters.on) counters.spawned("ps");
    execFile("/bin/ps", ["-A", "-o", "pid=,ppid="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const children = new Set<number>();
      if (!error) {
        for (const line of stdout.split("\n")) {
          const [pid, ppid] = line.trim().split(/\s+/).map(Number);
          if (ppid === process.pid && Number.isInteger(pid)) children.add(pid);
        }
      }
      resolve(children);
    });
  });
}

/**
 * `claude agents --json`: the Claude Code sessions running on this Mac (in terminals, or
 * in the background). A desk thread's Claude Code starts only once it has answered, so
 * one that has not answered in `timeoutMs` is killed, SIGKILL and not SIGTERM, which a
 * hung program (or a wrapper script in front of it) may ignore, as for the version check
 * (providers/program.ts): with SIGTERM the answer never came and the thread's turn never
 * started nor failed.
 */
export function claudeAgents(claudePath: string, env: Record<string, string | undefined>, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (counters.on) counters.spawned("claude_cli");
    execFile(claudePath, ["agents", "--json"], { env: env as NodeJS.ProcessEnv, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error(`claude agents failed: ${error.message.split("\n")[0]}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("claude agents did not answer with JSON"));
      }
    });
  });
}
