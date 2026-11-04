import { log } from "../../log.ts";
import { machineWord } from "../../platform.ts";
import { readJSON, writeJSON } from "../../store/jsonFile.ts";
import { thinkingLevels, type AgentCommand, type AgentProfile, type ModelCatalog, type OngoingThread, type Provider, type ProviderSession, type SessionOptions, type SessionSettings, type SessionSink } from "../types.ts";
import { mcpCommand, mcpStatusText, type McpServer, type McpServerState } from "../mcpStatus.ts";
import { HermesClient, HermesError, serveConnector, type ClientListener, type Connector, type Frame } from "./client.ts";
import { ServeLocator } from "./serve.ts";
import { HermesSession, type Loaded } from "./session.ts";

// Hermes as agents of the bridge: one per Hermes profile (its `default` is `hermes` in
// profiles.list), all through one connection to the `hermes serve` this Mac runs
// (serve.ts). Which profiles there are is only known once Hermes answers, so the last
// list is kept in the bridge's state: after a restart the same agents are there at
// once, and their threads load as soon as Hermes is reached.
//
// Each profile keeps one ongoing conversation (feature bot_chat), the one Hermes Desktop
// keeps for it too: the profile's session titled "Bot Chat", which is how both find it,
// Hermes allowing one session of a title. The bridge never makes a second: a lookup that
// fails makes none.

export interface HermesSettings {
  /** The installed `hermes`. */
  path: string;
  /** Start `hermes serve` when none runs. */
  start: boolean;
  /** Where a `hermes serve` the bridge starts runs from (the General folder). */
  folder: string;
  /** Where it writes what it prints. */
  logPath: string;
}

export interface HermesHostOptions {
  settings: HermesSettings;
  /** The profiles as Hermes last listed them (`state/hermes.json`). */
  cachePath: string;
  /** A stand-in for the connection, for tests. */
  connect?: Connector;
  env?: NodeJS.ProcessEnv;
  /** Seconds between attempts to reconnect (tests). */
  backoff?: number[];
  pingMs?: number;
  /** How long a stopped turn may take to end before the bridge ends it (tests). */
  interruptGraceMs?: number;
  /** Each profile keeps one ongoing conversation, its Bot Chat (feature bot_chat). True unless said (tests). */
  oneThread?: boolean;
}

/** A Hermes profile, as the bridge offers it. */
export interface HermesProfile {
  /** Hermes's name for it, which every call for it carries. */
  profile: string;
  /** The bridge's name for it: `hermes` for the default profile. */
  name: string;
  displayName: string;
  description: string;
  model: string;
  provider: string;
}

/** What a thread runs on when Hermes is left to choose: its own default, whatever that is. */
export const hermesDefaultModel = "default";
const catalogMaxAgeMs = 2 * 60_000;
const description = `Hermes on this ${machineWord()}, with its own profile, memory and settings.`;
/** The title of a profile's one ongoing conversation, by which Hermes Desktop and the bridge find it. */
export const botChatTitle = "Bot Chat";
/** Hermes's command that compacts a conversation, which a thread takes from the app. */
const compressCommand: AgentCommand = { name: "compress", description: "Summarise the conversation so far, to free up context", usage: "[focus]", skill: false };

/** What `mcp.servers.status` says of a server, in `/mcp`'s words. `lazy`: connects when first used. */
const hermesMcpStates: Record<string, McpServerState> = { connected: "connected", connecting: "starting", failed: "failed", disabled: "off", configured: "notStarted" };

/** `/mcp` from Hermes's `mcp.servers.status`: its serve's last word on each server, which asking does not change. */
export function hermesMcpText(agent: string, servers: { name: string; status: string; tools?: number }[]): string {
  return mcpStatusText(agent, servers.map((server): McpServer => {
    const state = hermesMcpStates[server.status] ?? "unknown";
    const detail = server.status === "lazy" ? "starts when first used" : state === "unknown" ? server.status : undefined;
    return { name: server.name, state, ...(typeof server.tools === "number" ? { tools: server.tools } : {}), ...(detail ? { detail } : {}) };
  }));
}

/** The bridge's name for a Hermes profile: `hermes` for the default, else the profile's own unless another agent has it. */
export function agentName(profile: string, taken: ReadonlySet<string>): string {
  if (profile === "default") return "hermes";
  const name = profile.toLowerCase();
  return taken.has(name) || name === "hermes" ? `hermes-${name}` : name;
}

/** "aeri" → "Aeri", "deep-research" → "Deep research". */
function displayNameFor(profile: string): string {
  if (profile === "default") return "Hermes";
  const words = profile.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export class HermesHost {
  readonly client: HermesClient;
  private readonly options: HermesHostOptions;
  /** As Codex's: how long a stopped turn may take to end before the bridge ends it. */
  readonly interruptGraceMs: number;
  readonly oneThread: boolean;
  private readonly sessions = new Map<string, HermesSession>();
  private readonly providers = new Map<string, HermesProvider>();
  /** Whoever is told of a profile Hermes lists once the bridge runs (`Provider.onAgentAdded`). */
  readonly added = new Set<(name: string, provider: Provider) => void>();
  /** The bridge's agents, which profiles that appear later join. */
  private agents: Map<string, Provider> | null = null;
  /** Names the bridge's other agents already have. */
  private taken = new Set<string>();
  /** Sessions made by `newThread`, until their session is started. */
  private readonly made = new Map<string, Loaded>();
  /** Events for runtime ids no session has claimed yet (a resume answered after its first events). */
  private readonly unclaimed = new Map<string, { type: string; seq: number | undefined; payload: Frame; at: number }[]>();
  private started = false;
  private refreshing: Promise<void> | null = null;
  /** The profiles' ongoing conversations open in the bridge, told when Hermes's stored sessions change (`sessions.changed`). */
  private readonly watching = new Set<HermesSession>();
  /** Hermes's `sessions.changed` came, to be told the sessions in `watching` a moment later, once for a burst. */
  private changeTimer: NodeJS.Timeout | null = null;

  constructor(options: HermesHostOptions) {
    this.options = options;
    this.interruptGraceMs = options.interruptGraceMs ?? 15_000;
    this.oneThread = options.oneThread ?? true;
    const locator = new ServeLocator({
      path: options.settings.path,
      start: options.settings.start,
      cwd: options.settings.folder,
      logPath: options.settings.logPath,
      env: options.env,
    });
    this.client = new HermesClient({ connect: options.connect ?? serveConnector(() => locator.locate()), backoff: options.backoff, pingMs: options.pingMs });
    this.client.listen(this.listener);
  }

  /**
   * Adds the Hermes agents to the bridge's: the profiles Hermes listed last time, or its
   * default profile before it ever answered. Profiles that appear later are added as
   * Hermes lists them.
   */
  addTo(agents: Map<string, Provider>): void {
    this.agents = agents;
    this.taken = new Set(agents.keys());
    const cached = readJSON<{ profiles?: HermesProfile[] }>(this.options.cachePath, {}).profiles;
    const profiles = Array.isArray(cached) && cached.length > 0 ? cached : [this.describe({ name: "default" })];
    for (const profile of profiles) this.offer(profile);
  }

  private offer(profile: HermesProfile): void {
    const existing = this.providers.get(profile.profile);
    if (existing) {
      existing.describe(profile);
      return;
    }
    const provider = new HermesProvider(this, profile);
    this.providers.set(profile.profile, provider);
    if (!this.agents || this.agents.has(provider.profile.name)) return;
    this.agents.set(provider.profile.name, provider);
    for (const listener of this.added) listener(provider.profile.name, provider);
  }

  private describe(entry: Frame): HermesProfile {
    const profile = String(entry.name);
    return {
      profile,
      name: agentName(profile, this.taken),
      displayName: typeof entry.display_name === "string" && entry.display_name.trim() !== "" ? entry.display_name.trim() : displayNameFor(profile),
      description: typeof entry.description === "string" && entry.description.trim() !== "" ? entry.description.trim() : description,
      model: typeof entry.model === "string" && entry.model !== "" ? entry.model : hermesDefaultModel,
      provider: typeof entry.provider === "string" ? entry.provider : "",
    };
  }

  /** Connects, then learns the profiles. Once, however many agents call it. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.client.start();
    void this.refreshProfiles();
  }

  /** Asks Hermes for its profiles, keeps the list, and offers any new one. */
  refreshProfiles(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const listed = await this.client.call<{ profiles?: Frame[] }>("profiles.list", {});
        const profiles = (listed.profiles ?? []).filter((entry) => typeof entry?.name === "string" && entry.name !== "").map((entry) => this.describe(entry));
        if (profiles.length === 0) return;
        for (const profile of profiles) this.offer(profile);
        writeJSON(this.options.cachePath, { profiles });
      } catch (error) {
        log.warn("could not ask Hermes for its profiles", { error: (error as Error).message });
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  close(): void {
    this.client.close();
  }

  // MARK: Sessions

  call<T = any>(method: string, params: Frame, timeoutMs?: number): Promise<T> {
    return this.client.call<T>(method, params, timeoutMs);
  }

  respond(id: string, result: unknown): void {
    this.client.respond(id, result);
  }

  respondError(id: string, code: number, message: string): void {
    this.client.respondError(id, code, message);
  }

  bind(runtimeID: string, session: HermesSession): void {
    for (const [id, bound] of this.sessions) {
      if (bound === session && id !== runtimeID) this.sessions.delete(id);
    }
    this.sessions.set(runtimeID, session);
    const early = this.unclaimed.get(runtimeID);
    this.unclaimed.delete(runtimeID);
    for (const event of early ?? []) session.event(event.type, event.seq, event.payload);
  }

  forget(session: HermesSession): void {
    for (const [id, bound] of this.sessions) {
      if (bound === session) this.sessions.delete(id);
    }
  }

  /** Makes the Hermes session for a new thread and returns its stored id, the thread's. */
  async create(profile: string, options: { cwd: string; settings: SessionSettings }): Promise<string> {
    const params: Frame = { profile, source: "tui", cwd: options.cwd };
    // Left to Hermes, model and provider both: it resolves them as for a session of its own.
    if (options.settings.model && options.settings.model !== hermesDefaultModel) {
      params.model = options.settings.model;
      if (options.settings.provider) params.provider = options.settings.provider;
    }
    if (options.settings.reasoningEffort) params.reasoning_effort = options.settings.reasoningEffort;
    const created = await this.client.call<Loaded & { stored_session_id?: string }>("session.create", params, 120_000);
    const id = created.stored_session_id ?? created.session_id;
    if (typeof id !== "string" || id === "") throw new Error("Hermes did not say which session it made.");
    this.made.set(id, created);
    return id;
  }

  /**
   * The profile's Bot Chat, as the provider's `ongoingThread` gives it: found by its title,
   * else made when `make`. Made hidden, as Hermes Desktop makes it, following the
   * profile's own settings; one another app named first meanwhile is that one. Throws
   * when Hermes cannot list its sessions.
   */
  async ongoing(profile: string, make: boolean, options: { cwd: string }): Promise<OngoingThread | null> {
    const cwd = options.cwd || this.options.settings.folder;
    const found = await this.botChat(profile);
    if (found) return ongoingOf(found, cwd);
    if (!make) return null;
    const created = await this.client.call<Loaded & { stored_session_id?: string }>(
      "session.create",
      { profile, source: "tui", cwd, title: botChatTitle, hidden: true, follow_profile_config: true },
      120_000,
    );
    const id = created.stored_session_id ?? created.session_id;
    if (typeof id !== "string" || id === "" || typeof created.session_id !== "string") throw new Error("Hermes did not say which session it made.");
    try {
      // Only a session with a title is kept, and the title is what Hermes refuses a second of.
      await this.client.call("session.title", { session_id: created.session_id, profile, title: botChatTitle });
    } catch (error) {
      const winner = await this.botChat(profile);
      void this.client.call("session.close", { session_id: created.session_id, profile }).catch(() => undefined);
      if (winner) return ongoingOf(winner, cwd);
      throw new Error(`Hermes did not keep the conversation: ${(error as Error).message}`);
    }
    this.made.set(id, created);
    return { id, cwd, createdAt: Math.floor(Date.now() / 1000) };
  }

  /**
   * Where the profile's Bot Chat stands in Hermes's store: the latest segment of it (a
   * compression can start one) and how many messages it holds, which a turn said in
   * another app moves. Null when the profile has none.
   */
  async botChatMark(profile: string): Promise<string | null> {
    const row = await this.botChat(profile);
    if (!row) return null;
    return [row.resolved_id ?? row.id, row.message_count ?? "", row.live_message_count ?? ""].join(" ");
  }

  watch(session: HermesSession): void {
    this.watching.add(session);
  }

  unwatch(session: HermesSession): void {
    this.watching.delete(session);
  }

  /**
   * Hermes says its stored sessions changed (at most every two seconds, for any of its
   * processes' writes): each ongoing conversation open here looks whether another app
   * went on with it, the bridge's own turns among them told apart there.
   */
  private sessionsChanged(): void {
    if (this.changeTimer || this.watching.size === 0) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      for (const session of this.watching) session.mayHaveChangedElsewhere();
    }, 250);
    this.changeTimer.unref();
  }

  /** The profile's session titled Bot Chat, or null when it has none. Throws when Hermes cannot say. */
  private async botChat(profile: string): Promise<Frame | null> {
    const listed = await this.client.call<{ sessions?: Frame[] }>("session.list", { profile, title: botChatTitle, include_hidden: true, limit: 200 });
    if (!Array.isArray(listed?.sessions)) throw new Error("Hermes did not list its sessions.");
    return listed.sessions.find((row) => typeof row?.id === "string" && row.id !== "" && row.title === botChatTitle) ?? null;
  }

  async startSession(profile: string, options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    const created = this.made.get(options.id);
    this.made.delete(options.id);
    if (!created) return this.resumeSession(profile, options, sink);
    // Made empty a moment ago, but another app may have written in it since: where Hermes's
    // copy stands is not known, so the first change is read in full (not taken as the start).
    const session = new HermesSession(options, profile, sink, this, { ...created, messages: [] }, null);
    if (options.title) await session.rename(options.title).catch((error: Error) => log.debug("Hermes did not take the thread's title", { error: error.message }));
    return session;
  }

  async resumeSession(profile: string, options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    // Where the profile's Bot Chat stands, asked before it is read: a change written while
    // it is read is then seen as one. Null when Hermes cannot say, and the first change
    // is looked at in full (`HermesSession.changedConversation`).
    const mark = options.ongoing === true ? await this.botChatMark(profile).catch(() => null) : undefined;
    let loaded: Loaded;
    try {
      loaded = await this.client.call<Loaded>("session.resume", { session_id: options.id, profile, inline_images: false }, 120_000);
    } catch (error) {
      throw new Error(`Hermes could not open this thread: ${(error as Error).message}`);
    }
    if (typeof loaded?.session_id !== "string") throw new Error("Hermes did not say which session it opened.");
    return new HermesSession(options, profile, sink, this, loaded, mark);
  }

  /** Of these stored ids, the sessions Hermes has loaded and at work now. */
  async live(ids: string[]): Promise<string[]> {
    const listed = await this.client.call<{ sessions?: Frame[] }>("session.active_list", {});
    const wanted = new Set(ids);
    const busy = new Set(["working", "waiting", "starting"]);
    return (listed.sessions ?? []).filter((row) => wanted.has(row?.session_key) && busy.has(row?.status)).map((row) => String(row.session_key));
  }

  private readonly listener: ClientListener = {
    event: (type, sessionID, seq, payload) => {
      if (!sessionID) {
        if (type === "sessions.changed") this.sessionsChanged();
        return;
      }
      const session = this.sessions.get(sessionID);
      if (session) {
        session.event(type, seq, payload);
        return;
      }
      // Kept a moment, for a session about to claim its runtime id.
      const now = Date.now();
      const early = (this.unclaimed.get(sessionID) ?? []).filter((event) => now - event.at < 10_000);
      if (early.length < 500) early.push({ type, seq, payload, at: now });
      this.unclaimed.set(sessionID, early);
      for (const [id, events] of this.unclaimed) {
        if (events.every((event) => now - event.at >= 10_000)) this.unclaimed.delete(id);
      }
    },
    request: (id, method, params) => {
      const sessionID = typeof params.session_id === "string" ? params.session_id : "";
      const session = this.sessions.get(sessionID);
      if (session) {
        session.request(id, method, params);
        return;
      }
      // Not one of the bridge's threads: nobody here can answer it.
      this.client.respondError(id, -32601, "Not supported by this client");
    },
    connected: (again, sameRun) => {
      if (!again) return;
      for (const provider of this.providers.values()) provider.forgetCatalog();
      void this.refreshProfiles();
      for (const session of new Set(this.sessions.values())) void session.reconnected(sameRun);
    },
    disconnected: () => {
      for (const session of new Set(this.sessions.values())) session.connectionLost();
    },
  };
}

/** A Bot Chat as Hermes lists it, as the bridge's ongoing thread. */
function ongoingOf(row: Frame, cwd: string): OngoingThread {
  const found: OngoingThread = { id: String(row.id), cwd: typeof row.cwd === "string" && row.cwd !== "" ? row.cwd : cwd };
  if (typeof row.started_at === "number" && Number.isFinite(row.started_at) && row.started_at > 0) found.createdAt = Math.floor(row.started_at);
  if (typeof row.preview === "string" && row.preview.trim() !== "") found.preview = row.preview.trim();
  return found;
}

interface Catalog {
  catalog: ModelCatalog;
  at: number;
}

/** One Hermes profile as an agent of the bridge. */
export class HermesProvider implements Provider {
  private readonly host: HermesHost;
  private described: HermesProfile;
  private catalog: Catalog | null = null;
  private loading: Promise<ModelCatalog> | null = null;
  readonly ongoingThread?: Provider["ongoingThread"];
  /** Its command the bridge runs itself (`mcp.servers.status`). */
  readonly executes = ["mcp"] as const;

  constructor(host: HermesHost, profile: HermesProfile) {
    this.host = host;
    this.described = profile;
    if (host.oneThread) this.ongoingThread = (make, options) => this.host.ongoing(this.described.profile, make, options);
  }

  onAgentAdded(listener: (name: string, provider: Provider) => void): void {
    this.host.added.add(listener);
  }

  get profile(): AgentProfile {
    const { name, displayName, description, model, provider } = this.described;
    // The kind is what tells the app it is Hermes's: a profile called `pi` keeps that name on a bridge that runs no Pi.
    return { name, kind: "hermes", displayName, description, model: this.catalog?.catalog.model ?? model, provider: this.catalog?.catalog.provider ?? provider };
  }

  /** Hermes's newest word on the profile. Its bridge name stays: threads are kept under it. */
  describe(profile: HermesProfile): void {
    this.described = { ...profile, name: this.described.name };
  }

  start(): void {
    this.host.start();
  }

  async close(): Promise<void> {
    this.host.close();
  }

  forgetCatalog(): void {
    this.catalog = null;
  }

  async models(): Promise<ModelCatalog> {
    if (this.catalog && Date.now() - this.catalog.at < catalogMaxAgeMs) return this.catalog.catalog;
    this.loading ??= this.loadCatalog().finally(() => {
      this.loading = null;
    });
    // A stale list beats none while a fresh one loads.
    if (this.catalog) {
      void this.loading.catch(() => undefined);
      return this.catalog.catalog;
    }
    try {
      return await this.loading;
    } catch (error) {
      throw new Error(`Hermes did not say which models ${this.described.displayName} has: ${(error as Error).message}`);
    }
  }

  private async loadCatalog(): Promise<ModelCatalog> {
    const profile = this.described.profile;
    const options = await this.host.call<Frame>("model.options", { profile });
    const reasoning = await this.host.call<{ value?: unknown }>("config.get", { key: "reasoning", profile }).catch(() => ({ value: "" }));
    // Providers not signed in are hidden, as the app hides them from Hermes itself.
    const providers = (Array.isArray(options.providers) ? options.providers : [])
      .filter((entry: Frame) => typeof entry?.slug === "string" && entry.authenticated !== false)
      .map((entry: Frame) => ({
        slug: entry.slug as string,
        name: typeof entry.name === "string" && entry.name !== "" ? entry.name : (entry.slug as string),
        models: (Array.isArray(entry.models) ? entry.models : []).filter((model: unknown): model is string => typeof model === "string"),
      }));
    const provider = typeof options.provider === "string" ? options.provider : "";
    let model = typeof options.model === "string" && options.model !== "" ? options.model : "";
    const names: Record<string, string> = {};
    if (model === "") {
      // No default model: Hermes chooses as it would for a new session of its own.
      model = hermesDefaultModel;
      names[hermesDefaultModel] = "Hermes's choice";
    } else {
      // A model the config names but no provider lists still runs.
      const own = providers.find((entry) => entry.slug === provider);
      if (own && !own.models.includes(model)) own.models.unshift(model);
      else if (!own) providers.unshift({ slug: provider || "hermes", name: provider || "Hermes", models: [model] });
    }
    if (providers.length === 0) providers.push({ slug: provider || "hermes", name: provider || "Hermes", models: [model] });
    const level = typeof reasoning?.value === "string" && (thinkingLevels as readonly string[]).includes(reasoning.value) ? reasoning.value : "";
    const catalog: ModelCatalog = { providers, model, provider: provider || providers[0].slug, reasoning: level };
    if (Object.keys(names).length > 0) catalog.names = names;
    this.catalog = { catalog, at: Date.now() };
    return catalog;
  }

  /** Hermes's `/compress` (`/compact` too), which the session carries out (`session.compress`), and `/mcp`, which the bridge answers. */
  async commands(): Promise<AgentCommand[]> {
    return [compressCommand, mcpCommand(() => this.mcpStatus())];
  }

  private async mcpStatus(): Promise<string> {
    let answer: { servers?: { name: string; status: string; tools?: number }[] } | undefined;
    try {
      answer = await this.host.client.call("mcp.servers.status", { profile: this.described.profile });
    } catch (error) {
      if (error instanceof HermesError && error.code === -32601) throw new Error("This Hermes cannot say how its MCP servers are: a newer one can.");
      throw new Error(`Hermes did not say how its MCP servers are: ${(error as Error).message}`);
    }
    return hermesMcpText(this.described.displayName, Array.isArray(answer?.servers) ? answer.servers : []);
  }

  newThread(options: { cwd: string; settings: SessionSettings }): Promise<string> {
    return this.host.create(this.described.profile, options);
  }

  startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    return this.host.startSession(this.described.profile, options, sink);
  }

  resumeSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    return this.host.resumeSession(this.described.profile, options, sink);
  }

  liveThreads(ids: string[]): Promise<string[]> {
    return this.host.live(ids);
  }
}
