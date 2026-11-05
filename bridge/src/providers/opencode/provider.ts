import { log } from "../../log.ts";
import { existsSync } from "node:fs";
import type { RecentFolder } from "../../folders.ts";
import { machineWord } from "../../platform.ts";
import { programVersion, VersionCheck } from "../program.ts";
import { Unknowns } from "../unknowns.ts";
import { mcpCommand, mcpFolderGone, mcpStatusText, type McpServer } from "../mcpStatus.ts";
import { knownLevels, type AdoptMode, type AgentCommand, type AgentProfile, type DeskAdoption, type DeskSession, type ModelCatalog, type Provider, type ProviderSession, type SessionOptions, type SessionSettings, type SessionSink, type UsageReport } from "../types.ts";
import { agentModes, agentSettings } from "./agents.ts";
import { commandCatalog, commandNamed, sendSkillsDeadline, skillCommands } from "./commands.ts";
import { usageReport } from "./usage.ts";
import { adopt, deskSessions } from "./desk.ts";
import { OpenCodeConnection, type OpenCodeApi } from "./client.ts";
import { majorVersion, minimumOpenCodeVersion, testedOpenCodeVersion } from "./options.ts";
import type { Message, ModelInfo, OpenCodeEvent, SessionInfo } from "./protocol.ts";
import { ServerLocator, type Endpoint, type OwnedStopResult, type ServerMode } from "./server.ts";
import { OpenCodeSession } from "./session.ts";
import { OpenCodeStopNotes, stopNoteLimits } from "./stopNotes.ts";
import { modelKey, nativeModelID } from "./models.ts";
import { onPath, threadVariables, type CommandAccess } from "../../portals/access.ts";
import { recoveryBufferLimit } from "./turn.ts";

// OpenCode 2 as an agent of the bridge, through OpenCode's own HTTP API: one connection
// to one OpenCode server for every thread (server.ts says which server), each thread one
// of its sessions. The user's own OpenCode settings decide what it may do without
// asking; what it asks comes to the phone (session.ts).

export interface OpenCodeSettings {
  /** The installed `opencode`. */
  path: string;
  mode: ServerMode;
  /** Start OpenCode's background service when none runs. */
  start: boolean;
  /** The General folder: where the bridge's own server runs, and what the model list is asked for. */
  folder: string;
  /** Where the bridge's own server writes what it prints. */
  logPath: string;
  portals?: CommandAccess;
}

export interface OpenCodeProviderOptions {
  settings: OpenCodeSettings;
  /** Where the server is, in place of finding it (tests). */
  locate?: () => Promise<Endpoint>;
  /** The service's registration file (tests). */
  registration?: string;
  /** Seconds between attempts to connect again (tests). */
  backoff?: number[];
  env?: NodeJS.ProcessEnv;
}

const catalogMaxAgeMs = 2 * 60_000;

interface Catalog {
  catalog: ModelCatalog;
  models: ModelInfo[];
  at: number;
}

interface PendingLoad {
  frames: OpenCodeEvent[];
  bytes: number;
  overflow: boolean;
}

export class OpenCodeProvider implements Provider {
  readonly version: VersionCheck;
  readonly supportsModes = true;
  readonly modeOptions = agentModes;
  readonly modeMeanings = { plan: "uses OpenCode's Plan agent, with its own settings and permissions" };
  readonly executes = ["agent", "mcp"];
  private readonly options: OpenCodeProviderOptions;
  private readonly locator: ServerLocator | null;
  private readonly connection: OpenCodeConnection;
  private readonly sessions = new Map<string, OpenCodeSession>();
  /** Only owned endpoints; view close must not lose the final stop annotation's sink. */
  private readonly stopSessions = new Map<string, OpenCodeSession>();
  private readonly stopNotes: OpenCodeStopNotes;
  private ownsServer = false;
  private readonly pendingLoads = new Map<string, PendingLoad>();
  /** Sessions made by `newThread`, until their thread is started. */
  private readonly made = new Map<string, SessionInfo>();
  private catalog: Catalog | null = null;
  private loading: Promise<Catalog> | null = null;
  private readonly unknowns = new Unknowns((type) => log.debug("OpenCode sent an unknown event", { type }));
  /** Session environments live in the native process, so every new connection prepares them again. */
  private readonly prepared = new WeakMap<OpenCodeApi, Map<string, Promise<void>>>();
  private readonly childThreads = new Map<string, string>();
  private folders: RecentFolder[] = [];
  private foldersAt = 0;
  private loadingFolders: Promise<void> | null = null;
  private instructionsWarning = false;

  constructor(options: OpenCodeProviderOptions) {
    this.options = options;
    const { settings } = options;
    this.version = new VersionCheck({ name: "OpenCode", tested: testedOpenCodeVersion, minimum: minimumOpenCodeVersion, path: settings.path, setting: "opencode.path" });
    this.stopNotes = new OpenCodeStopNotes(`${settings.logPath}.stops.json`);
    this.locator = options.locate
      ? null
      : new ServerLocator({ path: settings.path, mode: settings.mode, start: settings.start, cwd: settings.folder, logPath: settings.logPath, env: options.env, registration: options.registration, onStop: (result) => this.serverStopped(result) });
    const locate = options.locate ?? (() => this.locator!.locate());
    this.connection = new OpenCodeConnection({
      locate,
      backoff: options.backoff,
      reached: (version, endpoint) => this.reached(version, endpoint),
      listener: {
        event: (event) => this.route(event),
        connected: (again) => {
          if (!again) return;
          this.catalog = null;
          for (const session of this.sessions.values()) session.reconnected();
        },
        disconnected: () => log.info("lost the connection to OpenCode; connecting again"),
      },
    });
  }

  get profile(): AgentProfile {
    return {
      name: "opencode",
      kind: "opencode",
      displayName: "OpenCode",
      description: `OpenCode on this ${machineWord()}, with its own models, settings and permissions.`,
      model: this.catalog?.catalog.model ?? "",
      provider: this.catalog?.catalog.provider ?? "",
    };
  }

  /** Says which OpenCode is installed. The connection is made when a thread or the model list first needs it. */
  start(): void {
    const { path } = this.options.settings;
    void programVersion(path, this.options.env ?? process.env).then((version) => {
      this.version.installedIs(version);
    });
  }

  async close(): Promise<void> {
    this.connection.close();
    try { await this.locator?.close(); }
    finally { this.stopSessions.clear(); }
  }

  get stopDeadlineMs(): number | undefined { return this.locator?.stopDeadlineMs; }

  private serverStopped(result: OwnedStopResult): void {
    this.stopNotes.remember(result);
    const delivered: string[] = [];
    for (const session of this.stopSessions.values()) {
      try {
        if (session.serverStopped(result)) delivered.push(session.id);
      } catch {
        log.warn("could not annotate an OpenCode thread after owned shutdown", { session: session.id });
      }
    }
    this.stopNotes.delivered(delivered);
  }

  private reached(version: string, endpoint: Endpoint): void {
    this.ownsServer = endpoint.own;
    this.version.runningIs(version);
    if (majorVersion(version) !== 2 || this.version.current()?.standing === "too old") {
      throw new Error(`OpenCode's server runs ${version}; Portals needs OpenCode 2 (${minimumOpenCodeVersion} or newer). Choose a compatible installation with opencode.path.`);
    }
  }

  private route(event: OpenCodeEvent): void {
    const form = event.data?.form as { sessionID?: string } | undefined;
    const id = event.data?.sessionID ?? form?.sessionID;
    if (typeof id === "string") this.sessions.get(id)?.event(event);
    for (const load of this.pendingLoads.values()) {
      if (load.overflow) continue;
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (load.frames.length + 1 > recoveryBufferLimit.frames || load.bytes + bytes > recoveryBufferLimit.bytes) {
        load.frames.length = 0;
        load.bytes = 0;
        load.overflow = true;
      } else {
        load.frames.push(event);
        load.bytes += bytes;
      }
    }
    for (const [own, session] of this.sessions) if (own !== id) session.childEvent(event);
  }

  private api(): Promise<OpenCodeApi> {
    return this.connection.api();
  }

  async commands(thread?: { id: string; cwd: string }, name?: string): Promise<AgentCommand[]> {
    const mcp = mcpCommand(() => this.mcpStatus(thread));
    if (name === "mcp") return [mcp];
    const api = await this.api();
    const folder = thread?.cwd ?? this.options.settings.folder;
    const commands = commandCatalog(await api.commands(folder), async (argument) => {
      const session = thread && this.sessions.get(thread.id);
      if (!session) throw new Error("Open this OpenCode thread before selecting its agent.");
      return session.selectAgent(argument);
    });
    const own = [mcp, ...commands.filter((command) => command.name !== "mcp")];
    if (name !== undefined) {
      // One name, as the app sends `/name …` (lower cased): a command is not held up by the
      // skills, and a skill waits for them as a message does. One OpenCode did not list in
      // time goes as it was typed, as a message sent without its skills.
      const command = commandNamed(own, name);
      if (command) return [{ ...command, name }];
      // Commands that differ only in case hold the name from skills too, and none of them is meant.
      if (own.some((entry) => entry.name.toLowerCase() === name)) return [];
      try {
        const { skills, complete } = await api.skills(folder, undefined, sendSkillsDeadline);
        const skill = skillCommands(skills, own.map((command) => command.name)).filter((command) => command.name === name);
        if (skill.length > 0 || complete) return skill;
      } catch (error) {
        log.debug("OpenCode did not list its skills", { error: (error as Error).message });
      }
      return [{ name, description: "", usage: "", skill: true }];
    }
    // Skills come from OpenCode's own list; a menu that cannot have them is still a menu.
    try {
      return [...own, ...skillCommands((await api.skills(folder)).skills, own.map((command) => command.name))];
    } catch (error) {
      log.debug("OpenCode did not list its skills", { error: (error as Error).message });
      return own;
    }
  }

  private async mcpStatus(thread?: { cwd: string }): Promise<string> {
    const folder = thread?.cwd ?? this.options.settings.folder;
    if (thread && !existsSync(folder)) throw mcpFolderGone("OpenCode", folder);
    const servers = await (await this.api()).mcpStatuses(folder);
    return mcpStatusText("OpenCode", servers.map((server): McpServer => {
      const status = server.status;
      switch (status.status) {
        case "connected": return { name: server.name, state: "connected" };
        case "pending": return { name: server.name, state: "starting" };
        case "disabled": return { name: server.name, state: "off" };
        case "failed": return { name: server.name, state: "failed", detail: status.error };
        case "needs_auth": return { name: server.name, state: "signIn" };
        default: return { name: server.name, state: "unknown" };
      }
    }), { signIn: "Run `opencode auth login` in a terminal on the host to sign in to an MCP integration." });
  }

  /** Project discovery can start OpenCode: refresh in the background so the folder picker never waits for it. */
  async recentFolders(): Promise<RecentFolder[]> {
    if (!this.loadingFolders && Date.now() - this.foldersAt > catalogMaxAgeMs) {
      this.foldersAt = Date.now();
      this.loadingFolders = this.api().then((api) => api.projects()).then((projects) => {
        const folders = new Map<string, number>();
        for (const project of projects) {
          const lastUsed = project.time.active;
          for (const path of [project.canonical, ...project.sandboxes]) {
            if (path && Number.isFinite(lastUsed)) folders.set(path, Math.max(folders.get(path) ?? 0, lastUsed));
          }
        }
        this.folders = [...folders].map(([path, lastUsed]) => ({ path, lastUsed }));
      }).catch((error: Error) => log.debug("could not read OpenCode's recent projects", { error: error.message }))
        .finally(() => { this.loadingFolders = null; });
    }
    return this.folders.map((folder) => ({ ...folder }));
  }

  async usage(thread: string | undefined): Promise<UsageReport> {
    const api = await this.api();
    const info = thread === undefined ? undefined : await api.session(thread);
    return usageReport(await api.usage(info?.location?.directory ?? this.options.settings.folder));
  }

  // MARK: Models

  async models(): Promise<ModelCatalog> {
    return (await this.loadedCatalog()).catalog;
  }

  private async loadedCatalog(): Promise<Catalog> {
    if (this.catalog && Date.now() - this.catalog.at < catalogMaxAgeMs) return this.catalog;
    this.loading ??= this.loadCatalog().finally(() => {
      this.loading = null;
    });
    // A stale list beats none while a fresh one loads.
    if (this.catalog) {
      void this.loading.catch(() => undefined);
      return this.catalog;
    }
    try {
      return await this.loading;
    } catch (error) {
      throw new Error(`OpenCode did not say which models it has: ${(error as Error).message}`);
    }
  }

  private async loadCatalog(): Promise<Catalog> {
    const api = await this.api();
    const folder = this.options.settings.folder;
    const [listed, chosen, named] = await Promise.all([api.models(folder), api.defaultModel(folder), api.providers(folder).catch(() => [])]);
    const models = listed.filter((model) => model.enabled !== false);
    const names = new Map(named.map((provider) => [provider.id, provider.name]));
    const providers: ModelCatalog["providers"] = [];
    for (const model of models) {
      let entry = providers.find((provider) => provider.slug === model.providerID);
      if (!entry) providers.push((entry = { slug: model.providerID, name: names.get(model.providerID) ?? model.providerID, models: [] }));
      const key = modelKey(model.id, model.providerID);
      if (!entry.models.includes(key)) entry.models.push(key);
    }
    const levels: Record<string, string[]> = {};
    const modelNames: Record<string, string> = {};
    for (const model of models) {
      const key = modelKey(model.id, model.providerID);
      levels[key] = knownLevels((model.variants ?? []).map((variant) => variant.id));
      modelNames[key] = model.name || model.id;
    }
    const fallback = models[0];
    const catalog: ModelCatalog = {
      providers,
      model: chosen ? modelKey(chosen.id, chosen.providerID) : fallback ? modelKey(fallback.id, fallback.providerID) : "",
      provider: chosen?.providerID ?? fallback?.providerID ?? "",
      // OpenCode's own default for each model: its `default` variant.
      reasoning: "",
      levels,
      ...(Object.keys(modelNames).length > 0 ? { names: modelNames } : {}),
    };
    this.catalog = { catalog, models, at: Date.now() };
    return this.catalog;
  }

  private modelInfo(model: string, provider: string): ModelInfo | undefined {
    const id = nativeModelID(model, provider);
    return this.catalog?.models.find((entry) => entry.id === id && (provider === "" || entry.providerID === provider));
  }

  // MARK: Threads

  private async prepareSession(id: string, thread = id, refresh = false): Promise<void> {
    const api = await this.api();
    if (refresh) this.prepared.get(api)?.delete(id);
    return this.prepareOn(api, id, thread);
  }

  private prepareOn(api: OpenCodeApi, id: string, thread: string): Promise<void> {
    if (!this.options.settings.portals) return Promise.resolve();
    let prepared = this.prepared.get(api);
    if (!prepared) this.prepared.set(api, prepared = new Map());
    const previous = prepared.get(id);
    if (previous) return previous;
    const pending = this.prepareEnvironment(api, id, thread).catch((error) => {
      prepared.delete(id);
      throw error;
    });
    prepared.set(id, pending);
    return pending;
  }

  private async prepareEnvironment(api: OpenCodeApi, id: string, thread: string): Promise<void> {
    const portals = this.options.settings.portals;
    if (!portals) return;
    const env = onPath(this.options.env ?? process.env, portals.bin);
    const variables = Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
    // OpenCode 2.2.5 replaces the entire shell environment, so preserve the bridge's
    // normal environment and provider credentials, but not transport passwords.
    for (const name of ["OPENCODE_PASSWORD", "PORTALS_PASSWORD", "AERIPORTAL_PASSWORD"]) delete variables[name];
    for (const name of threadVariables) variables[name] = "";
    variables.PORTALS_THREAD = thread;
    await api.environment(id, variables);
    try {
      await api.instructions(id, portals.instructions);
    } catch (error) {
      if (!this.instructionsWarning) {
        this.instructionsWarning = true;
        log.warn("OpenCode did not take Portals' session instructions; the portals command is still available", { error: (error as Error).message });
      }
    }
  }

  async newThread(options: { cwd: string; settings: SessionSettings }): Promise<string> {
    const api = await this.api();
    const { model, provider, reasoningEffort } = options.settings;
    const info = await api.createSession({
      directory: options.cwd,
      ...(model && provider ? { model: { id: nativeModelID(model, provider), providerID: provider, ...(reasoningEffort ? { variant: reasoningEffort } : {}) } } : {}),
    });
    if (typeof info?.id !== "string" || info.id === "") throw new Error("OpenCode did not say which session it made.");
    await this.prepareSession(info.id);
    this.made.set(info.id, info);
    return info.id;
  }

  async startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    const info = this.made.get(options.id);
    this.made.delete(options.id);
    if (!info) return this.resumeSession(options, sink);
    void this.loadedCatalog().catch(() => undefined);
    const agents = await agentSettings(await this.api(), options.cwd);
    const session = new OpenCodeSession(options, sink, this.hostFor(options), { info, messages: [], running: false, agents });
    if (options.mode === "plan") await session.setMode("plan");
    if (options.title) await session.rename(options.title).catch((error: Error) => log.debug("OpenCode did not take the thread's title", { error: error.message }));
    return session;
  }

  async resumeSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    const held: PendingLoad = { frames: [], bytes: 0, overflow: false };
    if (!options.readOnly) this.pendingLoads.set(options.id, held);
    try {
      const api = await this.api();
      const [info, messages, active, inbox, children] = await Promise.all([api.session(options.id), api.messages(options.id), api.active(), api.inbox(options.id), api.sessions(1000, options.id)]);
      if (!options.readOnly) await this.prepareSession(options.id, options.id, true);
      const agents = await agentSettings(api, info.location?.directory ?? options.cwd);
      void this.loadedCatalog().catch(() => undefined);
      // Native stop inventory includes nested children too. Rebuild ownership
      // only while a shutdown note is pending, without letting a broken child
      // prevent the root from opening or silently certify an incomplete tree.
      const nativeIDs = new Set([options.id]);
      let inventoryComplete = true;
      if (this.stopNotes.pending) {
        const pending = children.slice(0, 999);
        const queued = new Set([options.id, ...pending.map((child) => child.id)]);
        if (children.length > pending.length) inventoryComplete = false;
        for (let at = 0; at < pending.length; ++at) {
          const child = pending[at];
          if (nativeIDs.has(child.id)) continue;
          nativeIDs.add(child.id);
          try {
            for (const nested of await api.sessions(1000, child.id)) {
              if (queued.has(nested.id)) continue;
              if (pending.length === 999) { inventoryComplete = false; break; }
              queued.add(nested.id);
              pending.push(nested);
            }
          }
          catch { inventoryComplete = false; }
        }
      }
      const histories = new Map<string, readonly Message[]>([[options.id, messages]]);
      await Promise.all(this.stopNotes.executionSessions(nativeIDs).filter((id) => id !== options.id).map(async (id) => {
        try { histories.set(id, await api.messages(id)); }
        catch { inventoryComplete = false; }
      }));
      const stopNote = this.stopNotes.take(options.id, [...nativeIDs], messages, active, info.time.created, inventoryComplete, histories);
      return new OpenCodeSession(options, sink, this.hostFor(options), { info, messages, running: !options.readOnly && active.has(options.id), inbox, agents, children, active, recover: true, stopNote });
    } catch (error) {
      if ((error as Error).name === "SessionNotFoundError") this.stopNotes.shown(options.id);
      throw new Error(`OpenCode could not open this thread: ${(error as Error).message}`);
    } finally {
      if (this.pendingLoads.get(options.id) === held) this.pendingLoads.delete(options.id);
    }
  }

  async liveThreads(ids: string[]): Promise<string[]> {
    const api = await this.api();
    const active = await api.active();
    const live = await Promise.all(ids.map(async (id) => active.has(id) || (await api.sessions(1000, id)).some((child) => active.has(child.id))));
    return ids.filter((_, index) => live[index]);
  }

  async deskSessions(wanted: number): Promise<DeskSession[]> {
    return deskSessions(await this.api(), wanted);
  }

  async adopt(id: string, mode: AdoptMode): Promise<DeskAdoption> {
    return adopt(await this.api(), id, mode);
  }

  async keeps(id: string): Promise<boolean> {
    try {
      await (await this.api()).session(id);
      return true;
    } catch (error) {
      if ((error as Error).name === "SessionNotFoundError") return false;
      throw error;
    }
  }

  private hostFor(options: SessionOptions) {
    return {
      ...this.host,
      api: async () => {
        const api = await this.api();
        if (!options.readOnly) {
          // Recovery and the next admission both wait for the new server's shell setup.
          try { await this.prepareOn(api, options.id, options.id); }
          catch (error) {
            if ((error as Error).name !== "SessionNotFoundError") throw error;
            try { await api.session(options.id); }
            catch (confirmation) {
              // An independently absent session has no shell to prepare. Let normal
              // history recovery confirm its deletion and close its waiting cards.
              if ((confirmation as Error).name === "SessionNotFoundError") return api;
              throw confirmation;
            }
            throw error;
          }
          await Promise.all([...this.childThreads].filter(([, root]) => root === options.id).map(([id, root]) =>
            this.prepareOn(api, id, root).catch((error: Error) => log.debug("could not restore an OpenCode child's shell setup", { error: error.message }))));
        }
        return api;
      },
    };
  }

  private readonly host = {
    api: () => this.api(),
    bind: (session: OpenCodeSession) => {
      this.sessions.set(session.id, session);
      if (this.ownsServer) {
        this.stopSessions.delete(session.id);
        this.stopSessions.set(session.id, session);
        if (this.stopSessions.size > stopNoteLimits.ids) this.stopSessions.delete(this.stopSessions.keys().next().value!);
      }
      // Every resumed session takes a fresh snapshot on attachment. On overflow it
      // reconstructs from that snapshot rather than replaying a truncated prefix.
      for (const event of this.pendingLoads.get(session.id)?.frames ?? []) {
        const id = event.data.sessionID ?? (event.data.form as { sessionID?: string } | undefined)?.sessionID;
        if (id === session.id) session.event(event);
        else session.childEvent(event);
      }
    },
    forget: (session: OpenCodeSession) => {
      if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
      for (const [id, root] of this.childThreads) if (root === session.id) this.childThreads.delete(id);
    },
    contextOf: (model: string, provider: string) => this.modelInfo(model, provider)?.limit?.context,
    levelsOf: (model: string, provider: string) => {
      const info = this.modelInfo(model, provider);
      return info ? knownLevels((info.variants ?? []).map((variant) => variant.id)) : undefined;
    },
    prepareChild: async (id: string, thread: string) => {
      await this.prepareSession(id, thread, true);
      this.childThreads.set(id, thread);
    },
    unknown: (kind: string) => this.unknowns.note(kind),
  };
}
