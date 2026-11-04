import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { connect as connectSocket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { counters } from "../../counters.ts";
import { codexProjects, type RecentFolder } from "../../folders.ts";
import { log } from "../../log.ts";
import { machineWord } from "../../platform.ts";
import { version } from "../../version.ts";
import {
  DeskRefused,
  knownLevels,
  type AdoptMode,
  type AgentCommand,
  type AgentProfile,
  type DeskAdoption,
  type DeskSession,
  type DeskState,
  type ModelCatalog,
  type Provider,
  type ProviderSession,
  type SessionOptions,
  type SessionSettings,
  type SessionSink,
  type ThreadMode,
  type UsageReport,
} from "../types.ts";
import { userAgentVersion, VersionCheck } from "../program.ts";
import { titleFrom, titleSource } from "../titles.ts";
import { CodexClient, processConnector, socketConnector, type ClientListener, type Connector } from "./client.ts";
import { codexVersion, defaultSocketPath, desktopDefaults, testedCodexVersion, threadModeFor, type DesktopDefaults } from "./options.ts";
import { compactCommand } from "./history.ts";
import { nameFrom, titleConfig, titleInstructions, titlePrompt, titleSchema } from "./naming.ts";
import { onPath, type CommandAccess } from "../../portals/access.ts";
import { idKey } from "./requests.ts";
import { CodexSession, type Applied, type CodexHost } from "./session.ts";
import { usageReport } from "./stream.ts";
import type { Model, RequestId, Thread, ThreadForkResponse, ThreadListResponse, ThreadStartResponse } from "./types/index.ts";
import { CodexRollouts } from "../../search/locate.ts";
import type { SearchFile } from "../../search/readers.ts";

// Codex as an agent of the bridge (`codex` in profiles.list). The bridge keeps one
// connection to Codex's app server for all its threads: in the shared mode (the
// default) to the daemon every Codex on this Mac uses, so threads outlive the bridge
// and a terminal can work on the same thread; in the own mode to a `codex app-server`
// of its own. Codex speaks for every thread on that connection, and a few things
// (status changes, usage limits) for threads the bridge does not follow, so everything
// is sorted by thread id here.
//
// A sub-agent a thread spawns works in a thread of its own, whose questions (approvals
// under `/mode ask`, `edits` or `plan`) Codex puts to whoever follows the thread it
// works for: they are that thread's cards. Which thread a sub-agent works for is learnt
// as it is spawned (a `subAgentActivity` or `spawnAgent` item of the thread), else asked
// of Codex (`thread/read`, its `parentThreadId`) when its first question comes.

export interface CodexSettings {
  mode: "shared" | "own";
  /** The installed `codex`. */
  path: string;
  /** The daemon's socket; null is `~/.codex`'s. */
  socket: string | null;
  /** Where images from the phone are written for Codex. */
  imagesDir: string;
  /** The `portals` command, given to a `codex app-server` the bridge starts and told to new threads. */
  portals?: CommandAccess;
  /**
   * The model a new thread is named with after its first message, as Codex's own apps
   * name theirs (naming.ts). Absent or null: it keeps that message's first line.
   */
  titleModel?: string | null;
}

export interface CodexProviderOptions {
  settings: CodexSettings;
  /** A stand-in for the connection, for tests. */
  connect?: Connector;
  env?: NodeJS.ProcessEnv;
  /** For the times in rate-limit warnings (tests). */
  timeZone?: string;
  /** Skips the version check (tests). */
  checkVersion?: boolean;
  /** Seconds between attempts to reconnect (tests). */
  backoff?: number[];
  /** Milliseconds a call waits for Codex to be reachable (tests). */
  readyMs?: number;
  /** Codex's config.toml, for its trusted projects (tests give another). */
  configPath?: string;
  /** Milliseconds between refreshes of the folders Codex's threads ran in. */
  folderRefreshMs?: number;
  /** How long a stopped turn may take to end before the bridge ends it (tests). */
  interruptGraceMs?: number;
  /** How long `codex app-server daemon start` may take before it is killed (tests). */
  daemonStartMs?: number;
  /** How many threads' parents are kept (`parents`; tests give fewer). */
  parentsKept?: number;
}

interface Catalog {
  models: Model[];
  defaults: DesktopDefaults;
  at: number;
}

const catalogMaxAgeMs = 10 * 60_000;
const daemonStartPauseMs = 60_000;
/** How long a title-generation thread has to answer. */
const namingMs = 60_000;
/** How often the folders of Codex's threads are asked for again. */
const folderRefreshMs = 3 * 60_000;
/** At most this many threads are read for their folders, newest first. */
const folderThreadLimit = 1000;
/** How long a list of threads is used again for `desk.list`. */
const deskMaxAgeMs = 5000;
/** How long `desk.list` waits for Codex before answering with the last list it has. */
const deskWaitMs = 8000;
/** How many sub-agents deep a question is followed up to the bridge's thread. */
const maxSubAgentDepth = 8;
/**
 * How many threads' parents are kept: the latest learned. One let go of is asked of Codex
 * again (`askOwner`'s `thread/read`) when a question of it comes; without a bound the map
 * grew by a sub-agent's thread for as long as the bridge ran (recovery-21).
 */
const parentsKeptDefault = 4096;

/** The environment for `codex`: the bridge's own, with `~/.codex` as Codex's home whatever the shell said. */
export function codexEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parent };
  delete env.CODEX_HOME;
  return env;
}

/** A thread's state, as `desk.list` says it. */
function deskState(thread: Thread): DeskState {
  const status = thread.status;
  switch (status?.type) {
    case "active":
      return status.activeFlags.includes("waitingOnApproval") || status.activeFlags.includes("waitingOnUserInput") ? "waiting" : "running";
    case "idle":
    case "systemError":
      return "idle";
    default:
      return "closed";
  }
}

export class CodexProvider implements Provider, CodexHost {
  readonly supportsModes = true;

  defaultMode(): Exclude<ThreadMode, "default"> | null {
    const defaults = this.defaults();
    return defaults ? threadModeFor(defaults.approvalPolicy, defaults.sandbox) : null;
  }
  /** Codex's sandbox decides more than its approvals do. */
  readonly modeMeanings = {
    edits: "edits files and runs commands in its folder without asking, and asks before going outside it",
  };
  readonly client: CodexClient;
  readonly imagesDir: string;
  readonly timeZone: string | undefined;
  readonly interruptGraceMs: number;
  readonly readyMs: number;
  private readonly settings: CodexSettings;
  private readonly env: NodeJS.ProcessEnv;
  private readonly portals: CommandAccess | undefined;
  private readonly checking: boolean;
  /** Which Codex runs: `codex --version` at start, then what the app server says of itself at each connect. */
  readonly version: VersionCheck;
  private readonly ownProcess: ReturnType<typeof processConnector> | null;
  private readonly sessions = new Map<string, CodexSession>();
  /** Threads made by `newThread`, until their session is started. */
  private readonly made = new Map<string, ThreadStartResponse>();
  private catalog: Catalog | null = null;
  private loading: Promise<Catalog> | null = null;
  private daemonStartedAt = 0;
  private readonly daemonStartMs: number;
  private started = false;
  private readonly configPath: string;
  private readonly folderRefreshMs: number;
  /** The folders Codex's threads ran in, as of the last refresh; empty until the first. */
  private threadFolders: RecentFolder[] = [];
  private refreshingFolders: Promise<void> | null = null;
  /** Where Codex's rollout files are, for search; made at the first search. */
  private rollouts: CodexRollouts | null = null;
  /** The last refresh failed: the log says so once for as long as that lasts, not every few minutes. */
  private foldersFailing = false;
  private folderTimer: NodeJS.Timeout | null = null;
  /** The newest threads as last listed, for `desk.list`. */
  private deskThreads: { threads: Thread[]; wanted: number; at: number } | null = null;
  private listingDesk: Promise<Thread[]> | null = null;
  /** The thread each sub-agent's thread works for (one of the bridge's, or another sub-agent's); null for a thread that is no sub-agent's. The latest `parentsKept` learned (`learnParent`). */
  private readonly parents = new Map<string, string | null>();
  private readonly parentsKept: number;
  /** Sub-agents' questions waiting while Codex is asked whose thread asks them, by request id: true once answered elsewhere meanwhile. */
  private readonly unowned = new Map<string, boolean>();
  /** Each title-generation thread at work: what Codex says of it goes to whoever waits for its answer, and `stop` ends the wait. */
  private readonly naming = new Map<string, { notify(method: string, params: Record<string, any>): void; stop(): void }>();

  constructor(options: CodexProviderOptions) {
    this.settings = options.settings;
    this.imagesDir = options.settings.imagesDir;
    this.timeZone = options.timeZone;
    this.interruptGraceMs = options.interruptGraceMs ?? 15_000;
    this.daemonStartMs = options.daemonStartMs ?? 30_000;
    this.readyMs = options.readyMs ?? 15_000;
    this.checking = options.checkVersion ?? true;
    this.version = new VersionCheck({ name: "Codex", tested: testedCodexVersion, path: options.settings.path, setting: "codex.path" });
    this.configPath = options.configPath ?? join(homedir(), ".codex", "config.toml");
    this.folderRefreshMs = options.folderRefreshMs ?? folderRefreshMs;
    this.parentsKept = Math.max(1, options.parentsKept ?? parentsKeptDefault);
    const env = codexEnvironment(options.env ?? process.env);
    this.portals = options.settings.portals;
    this.env = this.portals ? onPath(env, this.portals.bin) : env;
    const socket = options.settings.socket ?? defaultSocketPath();
    this.ownProcess = !options.connect && options.settings.mode === "own" ? processConnector(options.settings.path, this.env) : null;
    const connect = options.connect ?? this.ownProcess ?? socketConnector(socket);
    this.client = new CodexClient({
      connect,
      clientInfo: { name: "portals-bridge", title: "Portals", version },
      prepare: options.connect || options.settings.mode === "own" ? undefined : () => this.startDaemon(socket),
      backoff: options.backoff,
      readyMs: this.readyMs,
    });
    this.client.listen(this.listener);
  }

  get profile(): AgentProfile {
    return {
      name: "codex",
      kind: "codex",
      displayName: "Codex",
      description: `Codex on this ${machineWord()}, with your own settings and sign-in.`,
      model: this.catalog ? this.defaultModel(this.catalog) : "default",
      provider: "openai",
    };
  }

  /**
   * Connects, checks the installed version, learns the models and where its threads ran.
   * Images a run of the bridge left (it stopped mid-turn) go: Codex read each when its
   * message went in.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    rmSync(this.imagesDir, { recursive: true, force: true });
    void this.client.start();
    if (this.checking) void this.checkVersion();
    void this.catalogReady().catch(() => undefined);
    void this.refreshFolders();
    this.folderTimer = setInterval(() => void this.refreshFolders(), this.folderRefreshMs);
    this.folderTimer.unref();
  }

  private async checkVersion(): Promise<void> {
    this.version.installedIs(await codexVersion(this.settings.path, this.env));
  }

  /**
   * Starts the shared daemon when its socket is missing, or is there with nothing
   * listening on it (never stops or restarts one): a daemon killed or crashed leaves its
   * socket behind, and the bridge, which started one only for a socket missing, then
   * never connected to Codex again until something removed it.
   */
  private async startDaemon(socket: string): Promise<void> {
    if (Date.now() - this.daemonStartedAt < daemonStartPauseMs) return;
    if (existsSync(socket) && !(await nobodyListens(socket))) return;
    this.daemonStartedAt = Date.now();
    log.info("the Codex app-server daemon is not running; starting it");
    await new Promise<void>((resolve) => {
      // In the home folder, not the bridge's own (its app/ folder, which an update
      // deletes): the daemon outlives the bridge, and with its folder gone Codex can no
      // longer read its settings ("No such file or directory") until it is restarted.
      if (counters.on) counters.spawned("codex");
      // Every connection to Codex waits for this: one that does not end in time is
      // killed, SIGKILL and not SIGTERM, which a hung program (or a wrapper script in front
      // of it) may ignore, as for the version check (providers/program.ts). With SIGTERM
      // the bridge never connected to Codex until it was restarted.
      execFile(this.settings.path, ["app-server", "daemon", "start"], { cwd: homedir(), env: this.env, timeout: this.daemonStartMs, killSignal: "SIGKILL" }, (error) => {
        if (error) log.warn("could not start the Codex app-server daemon", { error: error.message });
        resolve();
      });
    });
  }

  // MARK: Codex's messages

  private readonly listener: ClientListener = {
    notification: (method, params) => {
      if (method === "account/rateLimits/updated") {
        for (const session of this.sessions.values()) session.rateLimits(params?.rateLimits ?? {});
        return;
      }
      const threadID = params?.threadId ?? params?.thread?.id;
      if (typeof threadID !== "string") return;
      const naming = this.naming.get(threadID);
      if (naming) {
        naming.notify(method, params);
        return;
      }
      // Codex tells every connection about every thread; only the bridge's own count, and
      // the sub-agents they spawned, which are threads of their own: shown on the subagents
      // line, and what their questions need.
      this.learnSubAgents(threadID, method, params);
      if (method === "serverRequest/resolved" && this.unowned.has(idKey(params.requestId))) this.unowned.set(idKey(params.requestId), true);
      const session = this.sessions.get(threadID);
      if (session) {
        session.notification(method, params);
        return;
      }
      const parent = params?.thread?.parentThreadId;
      if (method === "thread/started" && typeof parent === "string") {
        // A sub-agent's own sub-agent is on the line of the thread its parent works for.
        (this.sessions.get(parent) ?? this.ownerOf(threadID))?.agentStarted(threadID, params.thread);
        return;
      }
      this.ownerOf(threadID)?.subAgentNotification(method, params);
      for (const owner of this.sessions.values()) {
        if (!owner.ownsAgent(threadID)) continue;
        owner.agentNotification(threadID, method, params);
        return;
      }
    },
    request: (id: RequestId, method, params) => {
      const threadID = params?.threadId;
      if (typeof threadID === "string" && this.naming.has(threadID)) {
        this.client.respondError(id, -32601, "A title-generation thread is given nothing it asks for.");
        return;
      }
      const session = typeof threadID === "string" ? this.sessions.get(threadID) : undefined;
      if (session) {
        session.request(id, method, params ?? {});
        return;
      }
      if (method === "account/chatgptAuthTokens/refresh" || method === "attestation/generate") {
        this.client.respondError(id, -32601, `Portals does not handle ${method}.`);
        return;
      }
      // A sub-agent's question is its thread's; one about any other thread the bridge does
      // not follow is left to whoever does.
      if (typeof threadID === "string") void this.subAgentRequest(threadID, id, method, params ?? {});
    },
    connected: (again) => {
      // The daemon joined may be another release than `codex --version` says, and one started again after an update a newer one.
      this.version.runningIs(userAgentVersion(this.client.userAgent));
      if (!again) return;
      this.catalog = null;
      void this.catalogReady().catch(() => undefined);
      // Asked once for all of them; when Codex cannot say, each is followed again as before.
      const loaded = this.liveThreads([...this.sessions.keys()]).then(
        (ids) => new Set(ids),
        () => null,
      );
      for (const session of this.sessions.values()) void session.reconnected(loaded);
    },
    disconnected: () => {
      for (const session of this.sessions.values()) session.connectionLost();
      // What Codex says of a title-generation thread no longer reaches the bridge.
      for (const naming of this.naming.values()) naming.stop();
    },
  };

  // MARK: Sub-agents

  /** Sub-agents a thread the bridge follows (or one of their own) spawns, from what Codex says of it. */
  private learnSubAgents(threadID: string, method: string, params: Record<string, any>): void {
    if (method === "thread/started" && typeof params.thread?.parentThreadId === "string") {
      this.learnParent(threadID, params.thread.parentThreadId);
      return;
    }
    if ((method !== "item/started" && method !== "item/completed") || (!this.sessions.has(threadID) && !this.parents.get(threadID))) return;
    const item = params.item ?? {};
    const spawned: unknown[] = item.type === "subAgentActivity" ? [item.agentThreadId] : item.type === "collabAgentToolCall" && item.tool === "spawnAgent" && Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
    for (const child of spawned) {
      if (typeof child === "string" && child !== threadID && !this.sessions.has(child) && !this.parents.get(child)) this.learnParent(child, threadID);
    }
  }

  /** Keeps whose thread `thread` is, as the latest learned, letting go of the oldest past `parentsKept`. */
  private learnParent(thread: string, parent: string | null): void {
    this.parents.delete(thread);
    this.parents.set(thread, parent);
    while (this.parents.size > this.parentsKept) this.parents.delete(this.parents.keys().next().value!);
  }

  /** The bridge's thread a sub-agent's thread works for, however deep, as far as known. */
  private ownerOf(threadID: string): CodexSession | undefined {
    let id = this.parents.get(threadID);
    for (let depth = 0; id && depth < maxSubAgentDepth; depth += 1) {
      const session = this.sessions.get(id);
      if (session) return session;
      id = this.parents.get(id);
    }
    return undefined;
  }

  /**
   * A question about a thread the bridge does not follow: to the thread it works for, if
   * it is a sub-agent of one of the bridge's. One answered elsewhere while Codex is asked
   * whose it is (a terminal was quicker) is not put to the phone.
   */
  private async subAgentRequest(threadID: string, id: RequestId, method: string, params: Record<string, any>): Promise<void> {
    let owner = this.ownerOf(threadID);
    if (!owner) {
      const key = idKey(id);
      this.unowned.set(key, false);
      try {
        owner = await this.askOwner(threadID);
      } finally {
        if (this.unowned.get(key)) owner = undefined;
        this.unowned.delete(key);
      }
    }
    owner?.request(id, method, params);
  }

  /** The bridge's thread a sub-agent spawned while the bridge was not listening works for: Codex is asked whose it is, and whose that one is. */
  private async askOwner(threadID: string): Promise<CodexSession | undefined> {
    for (let thread = threadID, depth = 0; depth < maxSubAgentDepth; depth += 1) {
      if (!this.parents.has(thread)) {
        try {
          const read: Thread = (await this.client.call("thread/read", { threadId: thread, includeTurns: false })).thread;
          this.learnParent(thread, read.parentThreadId ?? null);
        } catch (error) {
          log.debug("could not ask Codex whose thread a question is about", { thread, error: (error as Error).message });
          return undefined;
        }
      }
      const parent = this.parents.get(thread);
      if (!parent) return undefined;
      const owner = this.sessions.get(parent);
      if (owner) return owner;
      thread = parent;
    }
    return undefined;
  }

  // MARK: Usage

  /** What Codex says of the account's limits now (`/usage`); the same for every thread. */
  async usage(): Promise<UsageReport> {
    return usageReport(await this.client.call("account/rateLimits/read", {}));
  }

  // MARK: Models

  private async catalogReady(): Promise<Catalog> {
    if (this.catalog && Date.now() - this.catalog.at < catalogMaxAgeMs) return this.catalog;
    this.loading ??= this.loadCatalog().finally(() => {
      this.loading = null;
    });
    // A stale list beats none while a fresh one loads.
    if (this.catalog) {
      void this.loading.catch(() => undefined);
      return this.catalog;
    }
    return this.loading;
  }

  private async loadCatalog(): Promise<Catalog> {
    const models: Model[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: Model[]; nextCursor: string | null } = await this.client.call("model/list", { cursor, includeHidden: false });
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const config = await this.client.call("config/read", {});
    this.catalog = { models: models.filter((model) => !model.hidden), defaults: desktopDefaults(config?.config), at: Date.now() };
    return this.catalog;
  }

  private defaultModel(catalog: Catalog): string {
    const configured = catalog.defaults.model;
    if (configured) return configured;
    return (catalog.models.find((model) => model.isDefault) ?? catalog.models[0])?.id ?? "default";
  }

  async models(): Promise<ModelCatalog> {
    let catalog: Catalog;
    try {
      catalog = await this.catalogReady();
    } catch (error) {
      const message = (error as Error).message;
      throw new Error(message.startsWith("Codex") ? message : `Codex did not say which models it has: ${message}`);
    }
    const model = this.defaultModel(catalog);
    const ids = catalog.models.map((entry) => entry.id);
    // A model config.toml names but Codex does not list (an old one) is still offered.
    if (!ids.includes(model)) ids.unshift(model);
    const entry = catalog.models.find((candidate) => candidate.id === model);
    // The levels each model lists. A model that lists none takes any (`codexEffort`).
    const levels = Object.fromEntries(
      catalog.models.flatMap((candidate) => {
        const supported = knownLevels(candidate.supportedReasoningEfforts.map((option) => option.reasoningEffort));
        return supported.length > 0 ? [[candidate.id, supported]] : [];
      }),
    );
    return {
      providers: [{ slug: "openai", name: "OpenAI", models: ids }],
      model,
      provider: "openai",
      reasoning: catalog.defaults.effort ?? entry?.defaultReasoningEffort ?? "",
      levels,
    };
  }

  /** The one Codex command a thread takes from the app: `/compact`, which the session carries out (`thread/compact/start`). */
  async commands(): Promise<AgentCommand[]> {
    return [{ name: compactCommand, description: "Summarise the conversation so far, to free up context", usage: "", skill: false }];
  }

  defaults(): DesktopDefaults | null {
    return this.catalog?.defaults ?? null;
  }

  /**
   * What config.toml sets for a thread in `cwd`, as Codex reads it for that folder (with
   * the `.codex/config.toml` of the folder and the project it is in). Throws when Codex
   * cannot say: the general settings may allow more than the folder's own.
   */
  async defaultsFor(cwd: string): Promise<DesktopDefaults> {
    try {
      return desktopDefaults((await this.client.call("config/read", { cwd }))?.config);
    } catch (error) {
      throw new Error(`Codex could not read its settings for this folder: ${(error as Error).message}`);
    }
  }

  efforts(model: string): string[] {
    const entry = this.catalog?.models.find((candidate) => candidate.id === model || candidate.model === model);
    return entry ? entry.supportedReasoningEfforts.map((option) => option.reasoningEffort) : [];
  }

  // MARK: Folders

  /**
   * Where Codex's threads ran, as of the last refresh, and the projects config.toml
   * trusts. Never waits for Codex: `thread/list` can take seconds, so it is asked in
   * the background, at startup and every few minutes.
   */
  async recentFolders(): Promise<RecentFolder[]> {
    return [...this.threadFolders, ...codexProjects(this.configPath)];
  }

  private refreshFolders(): Promise<void> {
    const started = counters.on && !this.refreshingFolders ? performance.now() : 0;
    this.refreshingFolders ??= this.loadThreadFolders(started)
      .then(() => {
        if (this.foldersFailing) log.info("Codex says where its threads ran again");
        this.foldersFailing = false;
      })
      .catch((error: Error) => {
        if (started) counters.codexFolders(0, performance.now() - started, true);
        // The folders stay as last read. Not said for a refresh the bridge's stopping cut short.
        const first = !this.foldersFailing && this.folderTimer !== null;
        (first ? log.warn : log.debug)("could not ask Codex where its threads ran", { error: error.message });
        if (first) this.foldersFailing = true;
      })
      .finally(() => {
        this.refreshingFolders = null;
      });
    return this.refreshingFolders;
  }

  /** `started`: when the refresh began, while the counters are on. */
  private async loadThreadFolders(started = 0): Promise<void> {
    const newest = new Map<string, number>();
    let cursor: string | null = null;
    let read = 0;
    do {
      // From Codex's own index: a scan of every rollout file took 10 s on a Mac.
      const page: ThreadListResponse = await this.client.call(
        "thread/list",
        { cursor, limit: 100, sortKey: "updated_at", useStateDbOnly: true },
        60_000,
      );
      for (const thread of page.data) {
        if (thread.cwd) newest.set(thread.cwd, Math.max(newest.get(thread.cwd) ?? 0, thread.updatedAt * 1000));
      }
      read += page.data.length;
      cursor = page.nextCursor;
    } while (cursor && read < folderThreadLimit);
    this.threadFolders = [...newest].map(([path, lastUsed]) => ({ path, lastUsed }));
    if (started) counters.codexFolders(read, performance.now() - started, false);
  }

  // MARK: Threads from the desk

  /**
   * Codex's threads, newest first, as sessions from the desk. A terminal's threads say
   * they come from `vscode`, as the bridge's own do (docs/bridge-spikes.md, S1), so
   * they are told apart by the bridge's registry, not by their source. Sub-agents'
   * threads and ones with no message yet (nothing to continue) are left out. Read from
   * Codex's index, kept a few seconds; when Codex is slow the last list is used.
   */
  async deskSessions(wanted: number): Promise<DeskSession[]> {
    return (await this.listDesk(wanted)).flatMap((thread): DeskSession[] => {
      if (thread.parentThreadId || thread.ephemeral || typeof thread.source === "object") return [];
      const title = (thread.name?.trim() || titleFrom(thread.preview ?? "")) ?? "";
      if (title === "" || !thread.cwd) return [];
      return [{ id: thread.id, title, cwd: thread.cwd, updated: thread.updatedAt * 1000, state: deskState(thread) }];
    });
  }

  private async listDesk(wanted: number): Promise<Thread[]> {
    const cached = this.deskThreads;
    if (cached && cached.wanted >= wanted && Date.now() - cached.at < deskMaxAgeMs) return cached.threads;
    this.listingDesk ??= this.newestThreads(wanted)
      .then((threads) => {
        this.deskThreads = { threads, wanted, at: Date.now() };
        return threads;
      })
      .finally(() => {
        this.listingDesk = null;
      });
    const listing = this.listingDesk;
    if (!cached) return listing;
    // A list a little old beats waiting long for a new one.
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<Thread[]>((resolve) => {
      timer = setTimeout(() => resolve(cached.threads), deskWaitMs);
      timer.unref();
    });
    try {
      return await Promise.race([listing.catch(() => cached.threads), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The newest `wanted` threads, from Codex's index (a few milliseconds; a scan of its files takes seconds). */
  private async newestThreads(wanted: number): Promise<Thread[]> {
    const threads: Thread[] = [];
    let cursor: string | null = null;
    do {
      const page: ThreadListResponse = await this.client.call(
        "thread/list",
        { cursor, limit: Math.min(wanted - threads.length, 100), sortKey: "updated_at", useStateDbOnly: true },
        60_000,
      );
      threads.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor && threads.length < wanted);
    return threads;
  }

  async adopt(id: string, mode: AdoptMode): Promise<DeskAdoption> {
    let thread: Thread;
    try {
      thread = (await this.client.call("thread/read", { threadId: id, includeTurns: false })).thread;
    } catch (error) {
      throw new DeskRefused(`Codex has no thread by that id on this ${machineWord()} (${(error as Error).message}).`);
    }
    if (thread.id !== id) throw new DeskRefused("Use the exact Codex thread id shown in the sessions list.");
    const title = thread.name?.trim() || titleFrom(thread.preview ?? "");
    // Nothing stored yet, so nothing to join or copy (docs/bridge-spikes.md, S1).
    if (!title) throw new DeskRefused("This Codex thread has no messages yet, so there is nothing to take up.");
    const catalog = await this.models();
    const settings = (from: { model: string | null; reasoningEffort: string | null }): SessionSettings => ({
      model: from.model ?? catalog.model,
      provider: "openai",
      reasoningEffort: from.reasoningEffort ?? catalog.reasoning,
    });
    if (mode !== "fork") return { id, cwd: thread.cwd, title, settings: settings(thread) };
    let fork: ThreadForkResponse;
    try {
      fork = await this.client.call("thread/fork", { threadId: id, excludeTurns: true });
    } catch (error) {
      throw new DeskRefused(`Codex could not fork this thread: ${(error as Error).message}`);
    }
    return { id: fork.thread.id, cwd: fork.cwd ?? thread.cwd, title: `${title} (fork)`, settings: settings({ model: fork.model, reasoningEffort: fork.reasoningEffort }) };
  }

  // MARK: Names

  /**
   * Names a thread the bridge started, after its first message, the way Codex's own apps
   * name theirs (naming.ts): Codex's daemon names none by itself. Until the name comes,
   * and when none does, the thread keeps that message's first line. A thread named
   * meanwhile (renamed in the app, `portals start --title`, named by another app) keeps
   * its name.
   */
  nameThread(threadID: string, message: string): void {
    const model = this.settings.titleModel;
    const said = titleSource(message);
    if (!model || said === "") return;
    void this.makeName(model, said)
      .then(async (name) => {
        if (!name) return;
        const thread: Thread = (await this.client.call("thread/read", { threadId: threadID, includeTurns: false })).thread;
        if (typeof thread.name === "string" && thread.name.trim() !== "") return;
        await this.client.call("thread/name/set", { threadId: threadID, name });
      })
      .catch((error: Error) => log.warn("could not name a Codex thread", { thread: threadID, error: error.message }));
  }

  /**
   * The name a title-generation thread gives a thread whose first message says `said`;
   * null when it gives none in time. The thread is ephemeral (Codex keeps nothing of it),
   * has a line for instructions in place of Codex's own, and runs with nothing it could
   * act with (naming.ts, `titleConfig`): when Codex cannot say which MCP servers the
   * user's config sets up, none is made.
   */
  private async makeName(model: string, said: string): Promise<string | null> {
    const config = (await this.client.call("config/read", {}))?.config;
    if (!config || typeof config !== "object") throw new Error("Codex did not say what its config sets up.");
    const servers = config.mcp_servers && typeof config.mcp_servers === "object" ? Object.keys(config.mcp_servers) : [];
    const started: ThreadStartResponse = await this.client.call("thread/start", {
      cwd: tmpdir(),
      ephemeral: true,
      model,
      baseInstructions: titleInstructions,
      approvalPolicy: "never",
      sandbox: "read-only",
      environments: [],
      config: titleConfig(servers),
    });
    const id = started.thread.id;
    let answer = "";
    let failure: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const ended = new Promise<boolean>((resolve) => {
        this.naming.set(id, {
          notify: (method, params) => {
            if (method === "item/completed" && params.item?.type === "agentMessage" && typeof params.item.text === "string") answer = params.item.text;
            else if (method === "turn/completed") {
              if (params.turn?.status !== "completed") failure = params.turn?.error?.message ?? `the turn ended ${params.turn?.status ?? "without a status"}`;
              resolve(true);
            }
          },
          stop: () => resolve(false),
        });
        timer = setTimeout(() => resolve(false), namingMs);
        timer.unref();
      });
      const turn = await this.client.call("turn/start", {
        threadId: id,
        input: [{ type: "text", text: titlePrompt(said), text_elements: [] }],
        clientUserMessageId: randomUUID(),
        effort: "low",
        outputSchema: titleSchema,
      });
      if (!(await ended)) {
        void this.client.call("turn/interrupt", { threadId: id, turnId: turn.turn?.id }).catch(() => undefined);
        return null;
      }
      // Said, so that names that stop coming (the model gone from Codex's list, say) are seen.
      if (failure) log.warn("Codex did not make a thread's name", { model, error: failure });
      return nameFrom(answer);
    } finally {
      clearTimeout(timer);
      this.naming.delete(id);
      void this.client.call("thread/unsubscribe", { threadId: id }).catch(() => undefined);
    }
  }

  // MARK: Threads

  /** Starts a Codex thread in `cwd`; its id is the bridge's thread id. */
  async newThread(options: { cwd: string; settings: SessionSettings }): Promise<string> {
    const params: Record<string, unknown> = { cwd: options.cwd };
    if (options.settings.model && options.settings.model !== "default") params.model = options.settings.model;
    // Codex runs one process for all its threads, so a thread is given the bridge's lines here.
    // Instructions given to a thread replace config.toml's, so those come first; when
    // they cannot be read, the thread gets config.toml's alone.
    if (this.portals?.instructions) {
      const catalog = await this.catalogReady().catch(() => null);
      if (catalog) params.developerInstructions = [catalog.defaults.developerInstructions, this.portals.instructions].filter(Boolean).join("\n\n");
    }
    const result: ThreadStartResponse = await this.client.call("thread/start", params);
    this.made.set(result.thread.id, result);
    return result.thread.id;
  }

  async startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    const made = this.made.get(options.id);
    this.made.delete(options.id);
    if (!made) throw new Error("This Codex thread was not started by the bridge.");
    const applied: Applied = {
      model: made.model,
      effort: made.reasoningEffort,
      approvalPolicy: made.approvalPolicy,
      sandboxPolicy: made.sandbox,
      summary: null,
    };
    const session = new CodexSession(options, sink, this, { applied, subscribed: true });
    this.sessions.set(options.id, session);
    // What default comes to in its folder, for `/mode` and the mode chip.
    await session.noteFolderDefaults();
    return session;
  }

  async resumeSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    // Registered first, so what Codex sends while it loads is kept for it.
    const session = new CodexSession(options, sink, this, { applied: null, subscribed: false });
    this.sessions.set(options.id, session);
    try {
      await session.load();
    } catch (error) {
      this.sessions.delete(options.id);
      throw error;
    }
    return session;
  }

  /** Codex's rollout file (feature thread_search), found by walking its folders, not by asking the daemon. */
  async searchFile(thread: { id: string; cwd: string }): Promise<SearchFile | null> {
    this.rollouts ??= new CodexRollouts(this.env);
    const path = await this.rollouts.find(thread.id);
    return path ? { path, format: "codex" } : null;
  }

  /** Of these threads, the ones Codex has loaded now (running, or open somewhere), which the bridge follows from its start. */
  async liveThreads(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const loaded = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { data: string[]; nextCursor: string | null } = await this.client.call("thread/loaded/list", { cursor });
      for (const id of page.data) loaded.add(id);
      cursor = page.nextCursor;
    } while (cursor);
    return ids.filter((id) => loaded.has(id));
  }

  forget(session: CodexSession): void {
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
  }

  async close(): Promise<void> {
    if (this.folderTimer) clearInterval(this.folderTimer);
    this.folderTimer = null;
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    this.client.close();
    await this.ownProcess?.close();
  }
}

/**
 * Whether connecting to the Unix socket at `path` is refused: a socket file whose process
 * is gone. Anything else (it answers, or does not in a second) is taken for a daemon there.
 */
function nobodyListens(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connectSocket(path);
    const done = (refused: boolean) => {
      clearTimeout(timer);
      probe.destroy();
      resolve(refused);
    };
    const timer = setTimeout(() => done(false), 1000);
    probe.once("connect", () => done(false));
    probe.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED"));
  });
}
