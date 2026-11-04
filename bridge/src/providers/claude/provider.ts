import { randomUUID } from "node:crypto";
import { constants, realpathSync, statSync } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { normalize } from "node:path";
import { performance } from "node:perf_hooks";
import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query as sdkQuery,
  renameSession,
  type ModelInfo,
  type Options,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { counters } from "../../counters.ts";
import type { RecentFolder } from "../../folders.ts";
import { log } from "../../log.ts";
import {
  DeskRefused,
  type AdoptMode,
  type AgentCommand,
  type AgentProfile,
  type DeskAdoption,
  type DeskSession,
  type ModeOption,
  type ModelCatalog,
  type Provider,
  type ProviderSession,
  type SessionOptions,
  type SessionSink,
  type ThreadMode,
  type UsageReport,
} from "../types.ts";
import { machineWord } from "../../platform.ts";
import { ClaudeCheckpoints } from "./checkpoints.ts";
import { historyFromSession, turnCutOff } from "./history.ts";
import { ClaudeSettingsEnv } from "./settingsEnv.ts";
import { ClaudeSessionFiles } from "../../search/locate.ts";
import type { SearchFile } from "../../search/readers.ts";
import { fromAgentLog, fromJournal, pastSubagents, type PastSubagent } from "./tasks.ts";
import { InputQueue } from "./input.ts";
import { claudeModels } from "./models.ts";
import { childEnvironment, claudeAuthStatus, claudeVersion, desktopAgents, queryOptions, testedClaudeVersion, threadModeFor } from "./options.ts";
import { onPath, type CommandAccess } from "../../portals/access.ts";
import { WarmPool } from "../pool.ts";
import { VersionCheck } from "../program.ts";
import { ClaudeSession, terminalHasIt, titleWatch, type ClaudeHost, type PlanUsage, type QueryFactory, type QueryLike, type SessionFiles, type StoredSession } from "./session.ts";
import { ClaudeSignIn } from "./signIn.ts";
import { ContextWindows } from "./stream.ts";
import { hasLimits, HeardLimits, KnownModelWindows, planDisplayName, planUsageReport, stillStanding } from "./usage.ts";
import { claudeMentionLimit, type MentionLimit } from "../../sessions/mentions.ts";
import { mcpCommand, mcpFolderGone, mcpStatusText, type McpServer, type McpServerState } from "../mcpStatus.ts";

// Claude Code as an agent of the bridge (`claude` in profiles.list). It runs the
// installed `claude` through the Agent SDK, one process per thread in use, with
// The user's own settings and login.
//
// What Claude can run (its models and slash commands) is only known from a running
// Claude Code, so the bridge asks one at startup, without a session or a message, and
// again from every query it starts, and asks again the same way once what it found is
// ten minutes old. Until it knows, it offers the model aliases every Claude Code has.
// How the models are listed is in models.ts.

export interface ClaudeSettings {
  /** The installed `claude`. */
  path: string;
  idleMinutes: number;
  maxWarm: number;
  /** A fallback for when the Claude login cannot be used; null (the default) uses the login. */
  apiKey: string | null;
  /** A long-lived token from `claude setup-token`, used instead of the login; null or absent uses the login. */
  oauthToken?: string | null;
  /** Claude Code summarises each run of its tool calls (`claude.toolSummaries`); on unless false. */
  toolSummaries?: boolean;
  /** Where the startup check runs. */
  folder: string;
  /** The `portals` command, given to every thread's process. */
  portals?: CommandAccess;
}

export interface ClaudeProviderOptions {
  settings: ClaudeSettings;
  /** Stand-ins for tests. */
  query?: QueryFactory;
  files?: SessionFiles;
  env?: NodeJS.ProcessEnv;
  /** Claude Code's managed settings file (tests). */
  managedSettings?: string;
  /** Bridge-owned UUID membership for exact message forks across restarts. */
  checkpointPath?: string;
  /** What `claude agents --json` lists: the sessions running on the Mac now, the bridge's own left out. */
  agents?: () => Promise<unknown>;
  /** What `claude auth status --json` says. */
  authStatus?: () => Promise<unknown>;
  /** The clock, in milliseconds. */
  now?: () => number;
  /** How long a turn may take to end after Stop before its process is stopped; 15 s unless a test says otherwise. */
  interruptGraceMs?: number;
  /** When a new session's title is looked for while its turn runs (`titleWatch`), unless a test says otherwise. */
  titleWatchMs?: readonly number[];
}

/** The aliases every Claude Code takes, offered until the real list is known. */
const fallbackModels = ["default", "opus", "sonnet", "haiku"];

/**
 * How old what the check found can be before it is asked again. The user can change their
 * model setting at the desk meanwhile, and the default is listed by that model's name.
 */
const checkMaxAgeMs = 10 * 60_000;

/**
 * Commands of Claude Code's own that are not offered: ones that would leave the thread
 * (`/clear` starts a new session), change the user's settings for every session, need a
 * terminal, or have the app's or the bridge's own command in their place. Those Claude
 * Code itself says need a terminal (`terminal_slash_commands`) are left out too; this
 * list holds them as well, for before a session has said, and for an older Claude Code.
 */
const withheld = new Set([
  "clear", "model", "effort", "fast", "config", "output-style", "color", "focus", "theme", "vim", "statusline", "terminal-setup",
  "keybindings", "permissions", "hooks", "mcp", "plugin", "plugins", "reload-plugins", "reload-skills", "login", "logout",
  "resume", "exit", "quit", "heapdump", "ide", "agents", "autocompact", "advisor", "auto-mode-setup", "usage-credits",
  "extra-usage", "design", "design-consent", "design-revoke", "workflow-launch-exec", "import", "privacy-settings", "upgrade",
  "install-github-app", "add-dir", "remote-control", "doctor", "send-to-project",
  "status", "mode", "help", "new", "stop", "retry", "reasoning",
]);

export const sdkSessionFiles: SessionFiles = {
  async exists(id, cwd) {
    if ((await getSessionInfo(id, { dir: cwd })) !== undefined) return true;
    return (await getSessionMessages(id, { dir: cwd, limit: 1 })).length > 0;
  },
  async title(id, cwd) {
    const info = await getSessionInfo(id, { dir: cwd });
    if (!info) return null;
    if (info.customTitle) return info.customTitle;
    // `summary` falls back to the first prompt, which is no title.
    return info.summary && info.summary !== info.firstPrompt ? info.summary : null;
  },
  messages: (id, cwd) => getSessionMessages(id, { dir: cwd }),
  // Claude's own index of every project's sessions: quick (about 50 ms for 80 sessions).
  async folders() {
    return (await listSessions()).flatMap((session) => (session.cwd ? [{ path: session.cwd, lastUsed: session.lastModified }] : []));
  },
  // Sessions the SDK started (the bridge's, other tools') are left out, as a terminal's `/resume` does.
  desk: (limit) => listSessions({ limit, includeProgrammatic: false }),
  // Direct lookup echoes filesystem aliases; the index keeps the exact stored ids.
  info: async (id) => (await listSessions({ includeProgrammatic: true })).find((session) => session.sessionId === id),
  // A copy with the same history under a new id; the original is not touched.
  fork: async (id, cwd, upToMessageId) => (await forkSession(id, { dir: cwd, ...(upToMessageId ? { upToMessageId } : {}) })).sessionId,
  // A custom title, as `/rename` gives one; `title` reads it back.
  rename: (id, cwd, title) => renameSession(id, title, { dir: cwd }),
  journal: (path) => readJournal(path),
};

/** The largest workflow journal read. */
const journalLimit = 8 * 1024 * 1024;

/**
 * A workflow's journal (`<session>/workflows/<run>.json`) as JSON, or the log of its
 * agents (`<session>/subagents/workflows/<run>/journal.jsonl`) as its records; null for
 * anything else. Only a regular file in a session's folder, one with that session's own
 * file (`<session>.jsonl`) beside it, as Claude Code keeps them: the path comes from a
 * call's answer, which also holds words the model wrote. Opened without waiting, so that
 * a pipe put at the path does not hold up the thread's loading.
 */
async function readJournal(path: string): Promise<unknown> {
  const session = /^(\/.+)\/(?:workflows\/wf_[\w-]+\.json|subagents\/workflows\/wf_[\w-]+\/journal\.jsonl)$/.exec(path)?.[1];
  if (!session || normalize(path) !== path) return null;
  let handle: FileHandle | undefined;
  try {
    if (!(await stat(`${session}.jsonl`)).isFile()) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) return null;
    // A workflow's journal is a few hundred kilobytes at most; one far larger is not one.
    // Read up to the limit, also when it grows as it is read (a workflow still at work).
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > journalLimit) return null;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!path.endsWith(".jsonl")) return JSON.parse(text);
    // A record a line; one cut off as the process stopped is left out.
    return text.split("\n").flatMap((line) => {
      try {
        return line.trim() === "" ? [] : [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** What `promise` gives, or undefined if it takes longer than `ms`. */
function within<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined);
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref())]);
}

/** How long a Claude Code started for `/mcp` gives its servers to connect, and how often it is asked meanwhile. */
const mcpConnectMs = 15_000;
const mcpPollMs = 500;

type ClaudeMcpServer = Awaited<ReturnType<NonNullable<QueryLike["mcpServerStatus"]>>>[number];

/** Claude Code's MCP servers, asked again while one is still connecting, for up to `waitMs`. */
async function mcpServers(query: QueryLike, waitMs: number): Promise<ClaudeMcpServer[]> {
  const until = Date.now() + waitMs;
  for (;;) {
    const servers = await within(query.mcpServerStatus?.(), 10_000);
    if (!servers) throw new Error("Claude Code did not say how its MCP servers are.");
    if (!servers.some((server) => server.status === "pending") || Date.now() >= until) return servers;
    await new Promise((resolve) => setTimeout(resolve, mcpPollMs));
  }
}

/** `/mcp` from what Claude Code says of each server (`McpServerStatus`). */
export function claudeMcpText(servers: ClaudeMcpServer[]): string {
  const states: Record<string, McpServerState> = { connected: "connected", pending: "starting", failed: "failed", "needs-auth": "signIn", disabled: "off" };
  return mcpStatusText("Claude Code", servers.map((server): McpServer => {
    const state = states[server.status] ?? "unknown";
    return {
      name: server.name,
      state,
      ...(state === "connected" && Array.isArray(server.tools) ? { tools: server.tools.length } : {}),
      ...(state === "failed" ? { detail: server.error } : state === "unknown" ? { detail: server.status } : {}),
    };
  }), { signIn: "To sign in to one, run /mcp in Claude Code on the host." });
}

/** How long Claude Code is given to say how much is used. */
const usageWaitMs = 15_000;

/** How long after a start whose answer had no limits to read the next one may be: this, then twice that each time, up to `checkMaxAgeMs`. */
const usageRetryMs = 60_000;

/** What Claude Code said of how much is used, and when it was heard. */
interface AskedUsage {
  usage: PlanUsage | undefined;
  at: number;
  /** From an earlier ask, not this one. */
  held?: true;
}

/** How long a list of the sessions open in terminals is used for `desk.list`. */
const terminalsMaxAgeMs = 2000;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** What to call a session from the desk: its own title, Claude's summary, or how it began. */
function deskTitle(session: StoredSession): string {
  return session.customTitle || session.summary || session.firstPrompt || "Untitled session";
}

export class ClaudeProvider implements Provider, ClaudeHost {
  readonly profile: AgentProfile = {
    name: "claude",
    kind: "claude",
    displayName: "Claude Code",
    description: `Claude Code on this ${machineWord()}, with your own settings and sign-in.`,
    model: "default",
    provider: "anthropic",
  };
  readonly supportsModes = true;
  /** Its command the bridge runs itself: `/mcp`, in place of Claude Code's own, which needs a terminal. */
  readonly executes = ["mcp"] as const;
  /**
   * The app's five, in its own words and order, and Claude Code's auto mode as `medium`:
   * a step between asking before everything and asking before nothing.
   */
  readonly modeOptions = [
    { id: "full", label: "Full access", description: "Edits files and runs commands without asking" },
    { id: "medium", label: "Auto", description: "Runs safe actions without asking, and asks when unsure" },
    { id: "edits", label: "Accept edits", description: "Edits files without asking, and asks before running commands" },
    { id: "ask", label: "Ask first", description: "Asks before editing files or running commands" },
    { id: "plan", label: "Plan", description: "Plans first, and asks before carrying the plan out" },
    { id: "default", label: "Your settings", description: "As the agent's own settings at the desk say" },
  ] satisfies ModeOption[];
  readonly modeMeanings = {
    medium: "uses Claude Code's auto mode: it runs safe actions without asking, blocks risky ones, and asks when unsure",
  };
  /**
   * Claude Code reads a message's mentions in itself, up to its limit, which its settings'
   * `env` sets for a session in `cwd` over the environment it runs in (`ClaudeSettingsEnv`).
   */
  mentionLimit(cwd: string | undefined): MentionLimit {
    const key = "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS";
    return claudeMentionLimit({ [key]: this.settingsEnv.value(key, cwd) ?? this.env[key] });
  }

  defaultMode(): Exclude<ThreadMode, "default"> | null {
    return threadModeFor(this.settingsMode);
  }
  readonly claudePath: string;
  readonly env: Record<string, string | undefined>;
  /** What Claude Code's settings files put in its environment. */
  private readonly settingsEnv: ClaudeSettingsEnv;
  readonly portals: CommandAccess | undefined;
  readonly query: QueryFactory;
  readonly files: SessionFiles;
  readonly checkpoints: ClaudeCheckpoints;
  readonly pool: WarmPool;
  readonly interruptGraceMs: number;
  readonly titleWatchMs: readonly number[];
  settingsMode: string | null = null;
  private readonly settings: ClaudeSettings;
  private readonly sessions = new Set<ClaudeSession>();
  private readonly agents: () => Promise<unknown>;
  private terminals: { ids: Set<string>; at: number } | null = null;
  /** Where its threads' session files are, for search; made at the first search. */
  private sessionFiles: ClaudeSessionFiles | null = null;
  private modelList: ModelInfo[] | null = null;
  /** The model a thread on `default` runs on, as the last check found it; null when Claude Code did not say. */
  private defaultModel: string | null = null;
  private commandList: SlashCommand[] | null = null;
  /** The commands the last session's Claude Code said need a terminal (`terminalCommands`). */
  private terminalOnly = new Set<string>();
  private defaultEffort = "";
  /** The effort each model runs at when a thread names none, as the last check found it. */
  private defaultLevels: Record<string, string> = {};
  /** A check has run to its end, effort and all. */
  private checked = false;
  private loading: Promise<void> | null = null;
  /** When the last check started. */
  private checkedAt = 0;
  private readonly now: () => number;
  /** What the turns reported of the usage limits, for `/usage` when no Claude Code can say. */
  private readonly heard: HeardLimits;
  /** Each model's own window (Fable's), as last said, for an answer that leaves them out. */
  private readonly modelWindows: KnownModelWindows;
  /** A Claude Code being started only to say how much is used, which any ask meanwhile waits for. */
  private usageStart: Promise<AskedUsage> | undefined;
  /** When the next of those may be. */
  private nextUsageStart = Number.NEGATIVE_INFINITY;
  /** How many of those in a row read no limits. */
  private usageMisses = 0;
  /** Which Claude Code runs: `claude --version` at start, then what each process says in its `system/init`. */
  readonly version: VersionCheck;
  /** The last answer to how much is used, which stands between those starts. */
  private lastUsage: AskedUsage | undefined;
  /** The last answer that had limits to read, for when one since has not: an old number with its age over none. Forgotten when the sign-in is one with no plan limits. */
  private lastLimits: AskedUsage | undefined;
  /** The window each model's context fills, as its processes have said: a thread's next process shows the context use from its first request. */
  readonly windows = new ContextWindows();
  /** When the sign-in ends, as `claude auth status` and the processes have said, and what threads say of it. */
  readonly signIn: ClaudeSignIn;
  private readonly authStatus: () => Promise<unknown>;

  constructor(options: ClaudeProviderOptions) {
    this.settings = options.settings;
    this.now = options.now ?? Date.now;
    this.heard = new HeardLimits(this.now);
    this.modelWindows = new KnownModelWindows(this.now);
    this.claudePath = options.settings.path;
    const { apiKey, oauthToken = null } = options.settings;
    const env = childEnvironment(options.env ?? process.env, { clientApp: "portals-bridge", apiKey, oauthToken, toolSummaries: options.settings.toolSummaries !== false });
    this.signIn = new ClaudeSignIn({ credential: apiKey ? "apiKey" : oauthToken ? "oauthToken" : "login", now: this.now });
    this.portals = options.settings.portals;
    this.env = this.portals ? onPath(env, this.portals.bin) : env;
    this.settingsEnv = new ClaudeSettingsEnv(this.env, options.managedSettings);
    this.query = options.query ?? ((prompt, queryOptions) => sdkQuery({ prompt, options: queryOptions }) as QueryLike);
    this.files = options.files ?? sdkSessionFiles;
    this.checkpoints = new ClaudeCheckpoints(options.checkpointPath);
    this.agents = options.agents ?? (() => desktopAgents(this.claudePath, this.env));
    this.authStatus = options.authStatus ?? (() => claudeAuthStatus(this.claudePath, this.env));
    this.pool = new WarmPool({ maxWarm: options.settings.maxWarm, idleMs: options.settings.idleMinutes * 60_000 });
    this.interruptGraceMs = options.interruptGraceMs ?? 15_000;
    this.titleWatchMs = options.titleWatchMs ?? titleWatch;
    this.version = new VersionCheck({ name: "Claude Code", tested: testedClaudeVersion, path: this.claudePath, setting: "claude.path" });
  }

  /** Starts the idle sweep, checks the installed version and learns the models, and when the sign-in ends. */
  start(): void {
    this.pool.start();
    void this.checkVersion();
    void this.catalogReady();
    void this.checkSignIn();
  }

  private async checkVersion(): Promise<void> {
    this.version.installedIs(await claudeVersion(this.claudePath, this.env));
  }

  /**
   * When the login ends (`loginExpiresAt`, Claude Code 2.1.318), known before any thread
   * runs: a turn the ended login refuses says so from the first. A key or a token in
   * config.json has no such date.
   */
  async checkSignIn(): Promise<void> {
    if (this.settings.apiKey || this.settings.oauthToken) return;
    try {
      const status = await this.authStatus();
      if (status && typeof status === "object") this.signIn.heard((status as { loginExpiresAt?: unknown }).loginExpiresAt);
    } catch (error) {
      log.debug("could not ask Claude Code when its sign-in ends", { error: (error as Error).message });
    }
  }

  // MARK: Models and commands

  /**
   * Waits (a while at most) for the startup check, to its end: its models come first,
   * each model's effort a moment later. Once it is old, what it found is used while it
   * runs again.
   */
  private async catalogReady(): Promise<void> {
    if (this.modelList && this.checked) {
      if (this.now() - this.checkedAt > checkMaxAgeMs) void this.check();
      return;
    }
    await this.check();
  }

  private check(): Promise<void> {
    this.loading ??= this.loadCatalog().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async loadCatalog(): Promise<void> {
    this.checkedAt = this.now();
    const started = counters.on ? performance.now() : 0;
    try {
      await this.askClaudeCode();
    } finally {
      this.checked = true;
      if (started) counters.claudeChecked(performance.now() - started);
    }
  }

  /**
   * A Claude Code started only to be asked something, in the check's folder, with no
   * session kept and no message sent; ready once its initialization result has come.
   */
  private checkQuery(extra: Partial<Options> = {}): { query: QueryLike; input: InputQueue; ready: Promise<Awaited<ReturnType<QueryLike["initializationResult"]>>> } {
    const input = new InputQueue();
    const folder = isDirectory(this.settings.folder) ? this.settings.folder : homedir();
    const query = this.query(input, {
      ...queryOptions({
        claudePath: this.claudePath,
        cwd: folder,
        env: this.env,
        model: "default",
        permissionMode: null,
        effort: null,
        adaptiveThinking: true,
        canUseTool: async () => ({ behavior: "deny", message: "Nothing runs here." }),
      }),
      persistSession: false,
      ...extra,
    });
    const ready = Promise.race([
      query.initializationResult(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Claude Code took too long to start.")), 30_000).unref()),
    ]);
    return { query, input, ready };
  }

  private async askClaudeCode(): Promise<void> {
    const { query, input, ready } = this.checkQuery();
    try {
      const init = await ready;
      this.modelList = init.models ?? this.modelList;
      this.commandList = init.commands ?? this.commandList;
      this.settingsMode ??= init.current_permission_mode ?? null;
      // The check names no model, so the model its settings come to is the one a thread
      // on `default` runs on. A Claude Code that does not say keeps the list it gave.
      const settings = await within(query.getSettings?.(), 10_000);
      this.defaultModel = settings?.applied?.model || this.defaultModel;
      this.defaultEffort = settings?.applied?.effort || this.defaultEffort;
      this.defaultLevels = await this.effortByModel(query, settings?.applied?.effort ?? null);
    } catch (error) {
      log.warn("could not ask Claude Code for its models and commands", { error: (error as Error).message });
    } finally {
      input.end();
      query.close();
    }
  }

  /**
   * The effort each model runs at when a thread names none (your settings can give each
   * model its own, and Claude Code has one per model otherwise), asked of the check's
   * query model by model. A model Claude Code gives no effort is left out.
   */
  private async effortByModel(query: QueryLike, ownEffort: string | null): Promise<Record<string, string>> {
    const levels: Record<string, string> = {};
    if (ownEffort) levels.default = ownEffort;
    if (!query.getSettings) return levels;
    for (const model of this.modelList ?? []) {
      if (model.value === "default") continue;
      try {
        await within(query.setModel(model.value), 5000);
        const effort = (await within(query.getSettings(), 5000))?.applied?.effort;
        if (effort) levels[model.value] = effort;
      } catch (error) {
        log.debug("could not ask a model's effort", { model: model.value, error: (error as Error).message });
      }
    }
    return levels;
  }

  async models(): Promise<ModelCatalog> {
    await this.catalogReady();
    const known = this.modelList ? claudeModels(this.modelList, this.defaultModel) : null;
    const catalog: ModelCatalog = {
      providers: [{ slug: "anthropic", name: "Claude", models: known?.models ?? fallbackModels }],
      model: "default",
      provider: "anthropic",
      reasoning: this.defaultEffort,
    };
    if (known) {
      catalog.names = known.names;
      catalog.levels = known.levels;
    }
    if (Object.keys(this.defaultLevels).length > 0) catalog.defaultLevels = { ...this.defaultLevels };
    return catalog;
  }

  /** Where Claude Code's sessions ran, from its own history (the desk's and the bridge's alike). */
  async recentFolders(): Promise<RecentFolder[]> {
    return this.files.folders();
  }

  // MARK: Usage

  limitsHeard(info: Record<string, unknown>): void {
    this.heard.heard(info);
  }

  /**
   * `/usage`: asked of a running Claude Code, the thread's own first, else of one started
   * only to ask; when none can say, the last answer with what the turns have said since over
   * it, or as the turns last reported it where no answer read limits, with the plan it said.
   * `fresh`, for a person typing `/usage`, starts one whatever the last answer was.
   */
  async usage(thread: string, options: { fresh?: boolean } = {}): Promise<UsageReport> {
    const report = await this.planUsage(thread, options.fresh === true);
    // A plan named as Claude Code names it to the person ("Ultra"), where it says.
    const named = report.plan ? await planDisplayName(this.env) : null;
    return named ? { ...report, plan: named } : report;
  }

  private async planUsage(thread: string, fresh: boolean): Promise<UsageReport> {
    const asked = await this.askUsage(thread, fresh).catch((error: Error) => {
      log.warn("could not ask Claude Code how much is used", { error: error.message });
      return undefined;
    });
    const usage = asked?.usage;
    if (usage?.rate_limits_available === false) {
      // Signed in with no plan limits: so it says, unless a turn has reported some since.
      if (!this.heard.heardSince(asked!.at)) return this.modelWindows.fill(planUsageReport(usage)!, usage, asked!.at);
    } else {
      // This ask's limits; failing those the last ones read, what the turns have said since over them.
      const earlier = this.lastLimits && { ...this.lastLimits, held: true as const };
      const known = usage && hasLimits(usage) ? asked : earlier;
      if (known) return this.answered(known);
      const report = usage && planUsageReport(usage);
      if (report) return this.modelWindows.fill(report, usage!, asked!.at);
    }
    const heard = this.modelWindows.add(this.heard.report());
    return usage?.subscription_type ? { ...heard, plan: usage.subscription_type } : heard;
  }

  /** An answer with limits as the report: an earlier ask's with its age, what the turns have said since over it, less what no longer stands. */
  private answered({ usage, at, held }: AskedUsage): UsageReport {
    const report = this.modelWindows.fill(planUsageReport(usage!)!, usage!, at);
    return held ? stillStanding(this.heard.over({ ...report, heardAt: at }, at), at, this.now()) : report;
  }

  /**
   * A running Claude Code's answer now. With none running, the last answer, and one started
   * only to ask at most once in `checkMaxAgeMs` while they read limits, as often as the model
   * check, for each start costs a process with nobody at it: a panel left open must not
   * bring one up a minute. After an answer that read none (it failed, or the limits could
   * not be read just now) the next start is sooner, a minute on, then 2, 4, 8 and 10.
   */
  private async askUsage(thread: string, fresh: boolean): Promise<AskedUsage> {
    const running = [...this.sessions]
      .sort((one, other) => Number(other.id === thread) - Number(one.id === thread))
      .map((session) => session.liveQuery)
      .find((query) => query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET);
    if (running) {
      const usage = await within(running.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET!({ skipBehaviors: true }), usageWaitMs);
      // What stands from now on, not an older answer of one started to ask. Nothing read is nothing to stand.
      return usage && planUsageReport(usage) ? this.usageHeard(usage) : { usage, at: this.now() };
    }
    if (this.usageStart) return this.usageStart;
    if (!fresh && this.lastUsage && this.now() < this.nextUsageStart) return { ...this.lastUsage, held: true };
    this.usageStart = this.startToAskUsage()
      .catch((error: Error) => {
        log.warn("could not ask Claude Code how much is used", { error: error.message });
        return undefined;
      })
      .then((usage) => {
        this.usageStart = undefined;
        return this.usageHeard(usage);
      });
    return this.usageStart;
  }

  /** An answer heard: it stands until the next start may be. */
  private usageHeard(usage: PlanUsage | undefined): AskedUsage {
    const asked: AskedUsage = { usage, at: this.now() };
    this.lastUsage = asked;
    if (usage && hasLimits(usage)) {
      this.lastLimits = asked;
      this.usageMisses = 0;
      this.nextUsageStart = asked.at + checkMaxAgeMs;
    } else {
      if (usage?.rate_limits_available === false) this.lastLimits = undefined;
      this.nextUsageStart = asked.at + Math.min(usageRetryMs * 2 ** this.usageMisses, checkMaxAgeMs);
      this.usageMisses += 1;
    }
    return asked;
  }

  /**
   * A Claude Code started only to say how much is used, with none of the person's hooks,
   * MCP servers or plugins: nothing else is asked of it, and they would all run at each
   * start. The model check has them, for the models and commands they bring.
   */
  private async startToAskUsage(): Promise<PlanUsage | undefined> {
    const { query, input, ready } = this.checkQuery({ settingSources: [], strictMcpConfig: true, mcpServers: {}, plugins: [] });
    try {
      await ready;
      return await within(query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.({ skipBehaviors: true }), usageWaitMs);
    } finally {
      input.end();
      query.close();
    }
  }

  // MARK: Sessions from the desk

  /**
   * The sessions a terminal (or Claude Code running in the background) has open now,
   * from `claude agents --json`; the last list when it is younger than `maxAgeMs`.
   * Throws when Claude Code cannot say.
   */
  private async openSessions(maxAgeMs: number): Promise<Set<string>> {
    if (this.terminals && Date.now() - this.terminals.at < maxAgeMs) return this.terminals.ids;
    const listed = await this.agents();
    if (!Array.isArray(listed)) throw new Error("claude agents did not answer with a list");
    const ids = new Set(listed.flatMap((agent) => (typeof agent?.sessionId === "string" ? [agent.sessionId as string] : [])));
    this.terminals = { ids, at: Date.now() };
    return ids;
  }

  async isOpenInTerminal(id: string): Promise<boolean> {
    try {
      return (await this.openSessions(0)).has(id);
    } catch (error) {
      // Checked when the session was taken up; a check that cannot run now stops nothing.
      log.warn("could not ask Claude Code which sessions are open", { error: (error as Error).message });
      return false;
    }
  }

  /** Claude Code's sessions from a terminal, newest first, each `open` while a terminal has it. */
  async deskSessions(wanted: number): Promise<DeskSession[]> {
    const [stored, open] = await Promise.all([
      this.files.desk(wanted),
      this.openSessions(terminalsMaxAgeMs).catch((error: Error) => {
        log.warn("could not ask Claude Code which sessions are open", { error: error.message });
        return new Set<string>();
      }),
    ]);
    return stored.flatMap((session): DeskSession[] =>
      session.cwd
        ? [{ id: session.sessionId, title: deskTitle(session), cwd: session.cwd, updated: session.lastModified, state: open.has(session.sessionId) ? "open" : "closed" }]
        : [],
    );
  }

  /** Claude Code's own session file (feature thread_search). */
  async searchFile(thread: { id: string; cwd: string }): Promise<SearchFile | null> {
    this.sessionFiles ??= new ClaudeSessionFiles(this.env);
    const path = await this.sessionFiles.find(thread.id, thread.cwd);
    // The conversation as its history reads it, for which hits a compaction hides: by
    // the folder Claude Code keeps it under when that is not the thread's (it moved), as
    // the search found its file wherever it is.
    const shown = async () => {
      const messages = await this.files.messages(thread.id, thread.cwd);
      if (messages.length > 0) return messages;
      const kept = (await this.files.info(thread.id))?.cwd;
      return kept && kept !== thread.cwd ? this.files.messages(thread.id, kept) : messages;
    };
    return path ? { path, format: "claude", shown } : null;
  }

  /** As `adopt` finds it. Claude Code deletes sessions older than its `cleanupPeriodDays` (30 by default). */
  async keeps(id: string): Promise<boolean> {
    return (await this.files.info(id))?.cwd !== undefined;
  }

  async adopt(id: string, mode: AdoptMode): Promise<DeskAdoption> {
    const session = await this.files.info(id);
    if (!session?.cwd) throw new DeskRefused(`Claude Code has no session by that id on this ${machineWord()}.`);
    const cwd = session.cwd;
    const settings = { model: "default", provider: "anthropic", reasoningEffort: (await this.models()).reasoning };
    switch (mode) {
      case "continue": {
        let open: Set<string>;
        try {
          open = await this.openSessions(0);
        } catch (error) {
          throw new DeskRefused(`Portals could not check whether a terminal on the ${machineWord()} has this session open (${(error as Error).message}). Fork it instead.`);
        }
        if (open.has(id)) throw new DeskRefused(terminalHasIt);
        return { id, cwd, title: deskTitle(session), settings };
      }
      case "fork": {
        const fork = await this.files.fork(id, cwd);
        return { id: fork, cwd, title: (await this.files.title(fork, cwd)) ?? `${deskTitle(session)} (fork)`, settings };
      }
      case "read":
        return { id, cwd, title: deskTitle(session), settings };
    }
  }

  /** Forks a known bridge opener, retaining the entire native chain prefix. */
  async forkAt(id: string, checkpointId: string, before: boolean, expectedCwd: string): Promise<DeskAdoption> {
    const session = await this.files.info(id);
    if (!session?.cwd || session.sessionId !== id) throw new DeskRefused("Claude Code has no session by that exact id.");
    try {
      if (realpathSync(session.cwd) !== realpathSync(expectedCwd)) throw new Error("folder changed");
    } catch {
      throw new DeskRefused("The Claude Code session's folder no longer matches this Portals thread. Branching was refused.");
    }
    if ([...this.sessions].some((session) => session.id === id && session.busy) || await this.isOpenInTerminal(id)) throw new DeskRefused("Wait for this Claude Code session to finish before branching it.");
    const cwd = expectedCwd;
    const messages = await this.files.messages(id, cwd);
    if (turnCutOff(messages) && !this.checkpoints.completedAtEnd(id, messages)) throw new DeskRefused("This Claude Code turn has not finished, so it cannot be branched yet.");
    const history = historyFromSession(messages, cwd, this.checkpoints.forSession(id, messages));
    const checkpoint = history.find((message) => message.role === "user" && message.checkpoint?.id === checkpointId);
    if (checkpoint?.role !== "user" || !(before ? checkpoint.checkpoint?.can_edit : checkpoint.checkpoint?.can_fork)) throw new DeskRefused("Claude Code has no safe message boundary at this checkpoint.");
    const boundary = this.checkpoints.boundary(id, checkpointId, messages);
    const cut = boundary ? (before ? boundary.before : boundary.after) : -1;
    const settings = [...this.sessions].find((session) => session.id === id)?.settings() ?? { model: "default", provider: "anthropic", reasoningEffort: (await this.models()).reasoning };
    const title = `${deskTitle(session)} (fork)`;
    // There is no prior chain entry before the first prompt: start an empty native
    // session under a fresh UUID, as startSession does, never copy the original prompt.
    if (cut < 0) return { id: randomUUID(), cwd, title, settings };
    const native = messages[cut] as { uuid?: unknown };
    if (typeof native?.uuid !== "string") throw new DeskRefused("Claude Code could not identify the retained native boundary.");
    let fork: string;
    try {
      fork = await this.files.fork(id, cwd, native.uuid);
    } catch (error) {
      throw new DeskRefused(`Claude Code could not fork at this checkpoint: ${(error as Error).message}`);
    }
    if (!fork || fork === id) throw new DeskRefused("Claude Code did not create a separate fork, so it was not adopted.");
    const copied = await this.files.messages(fork, cwd);
    try {
      this.checkpoints.copied(id, fork, messages.slice(0, cut + 1), copied);
    } catch (error) {
      log.warn("could not save forked Claude message checkpoints", { session: fork, error: (error as Error).message });
    }
    return { id: fork, cwd, title, settings };
  }

  modelInfo(model: string): ModelInfo | undefined {
    return this.modelList?.find((entry) => entry.value === model) ?? this.modelList?.find((entry) => entry.resolvedModel === model);
  }

  async commands(thread?: { id: string; cwd: string }, name?: string): Promise<AgentCommand[]> {
    const mcp = mcpCommand(() => this.mcpStatus(thread));
    // The bridge's own: not waiting for the check to run it.
    if (name === mcp.name) return [mcp];
    await this.catalogReady();
    const seen = new Set<string>([mcp.name]);
    return [mcp, ...(this.commandList ?? []).flatMap((command) => {
      const name = command.name.toLowerCase();
      if (withheld.has(name) || this.terminalOnly.has(name) || name.startsWith("_") || seen.has(name)) return [];
      seen.add(name);
      return [{ name, description: command.description, usage: command.argumentHint ?? "", skill: command.builtin !== true }];
    })];
  }

  /**
   * How the thread's MCP servers are (`/mcp`), as its running Claude Code says. With none
   * running, a Claude Code started in the thread's folder only to say, given a while for
   * its servers to connect: what the thread's next message would find. A thread whose
   * folder is gone has none to show (`mcpFolderGone`); the startup check's folder is for
   * a call with no thread.
   */
  private async mcpStatus(thread: { id: string; cwd: string } | undefined): Promise<string> {
    const running = thread ? [...this.sessions].find((session) => session.id === thread.id)?.liveQuery : undefined;
    if (running) return claudeMcpText(await mcpServers(running, 0));
    if (thread && !isDirectory(thread.cwd)) throw mcpFolderGone("Claude Code", thread.cwd);
    const { query, input, ready } = this.checkQuery(thread ? { cwd: thread.cwd } : {});
    try {
      await ready;
      return claudeMcpText(await mcpServers(query, mcpConnectMs));
    } finally {
      input.end();
      query.close();
    }
  }

  terminalCommands(names: unknown): void {
    // Left out when none needs one, and by a Claude Code from before the list.
    this.terminalOnly = new Set(Array.isArray(names) ? names.filter((name): name is string => typeof name === "string").map((name) => name.toLowerCase()) : []);
  }

  learn(query: QueryLike, reported: { permissionMode: string | null; effort: string | null }, overridden: boolean): void {
    if (!overridden && reported.permissionMode) this.settingsMode = reported.permissionMode;
    if (reported.effort && !this.defaultEffort) this.defaultEffort = reported.effort;
    // Plugins and skills change between sessions; any running Claude Code knows the current lists.
    void Promise.all([query.supportedModels(), query.supportedCommands()])
      .then(([models, commands]) => {
        if (models.length > 0) this.modelList = models;
        if (commands.length > 0) this.commandList = commands;
      })
      .catch(() => undefined);
  }

  // MARK: Sessions

  async startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    return this.track(new ClaudeSession(options, sink, this));
  }

  async resumeSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    // History is read from Claude's own files; no process starts until a message is sent.
    const messages = await this.files.messages(options.id, options.cwd);
    const cutOff = turnCutOff(messages) && !this.checkpoints.completedAtEnd(options.id, messages);
    return this.track(new ClaudeSession(options, sink, this, historyFromSession(messages, options.cwd, this.checkpoints.forSession(options.id, messages)), await this.withJournals(pastSubagents(messages)), cutOff));
  }

  /**
   * Past workflows with what their journals tell of them: their phases and agents, which
   * the conversation does not keep. One cut off before its journal was written (its
   * process stopped with the bridge) has only the log of its agents.
   */
  private async withJournals(past: PastSubagent[]): Promise<PastSubagent[]> {
    const files = this.files;
    if (!files.journal) return past;
    await Promise.all(
      past.map(async ({ subagent, journal, agentLog }) => {
        const read = journal ? await files.journal!(journal).catch(() => null) : null;
        if (read) {
          fromJournal(subagent, read);
          return;
        }
        const log = agentLog ? await files.journal!(agentLog).catch(() => null) : null;
        if (Array.isArray(log)) fromAgentLog(subagent, log);
      }),
    );
    return past;
  }

  private track(session: ClaudeSession): ClaudeSession {
    this.sessions.add(session);
    return session;
  }

  /** A session closed (its thread was taken off the list, or loaded again as another session): it and its history are let go. */
  forget(session: ClaudeSession): void {
    this.sessions.delete(session);
  }

  /** How many sessions this keeps track of, and how many processes it keeps warm (the counters' gauges). */
  get tracked(): { sessions: number; warm: number } {
    return { sessions: this.sessions.size, warm: this.pool.size };
  }

  async close(): Promise<void> {
    this.pool.stop();
    await Promise.all([...this.sessions].map((session) => session.close()));
    this.sessions.clear();
  }
}
