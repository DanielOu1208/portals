import { factoryUsage, type PlanLimitsOptions } from "../planLimits.ts";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { AutonomyLevel, DroidInteractionMode, ModelInfoSchema, type ModelInfo } from "@factory/droid-sdk/node";
import type { RecentFolder } from "../../folders.ts";
import { log } from "../../log.ts";
import { machineWord } from "../../platform.ts";
import { onPath, type CommandAccess } from "../../portals/access.ts";
import { readJSON, writeJSON } from "../../store/jsonFile.ts";
import { nameFromText, titleInstructions, titlePrompt } from "../codex/naming.ts";
import { WarmPool } from "../pool.ts";
import { titleSource } from "../titles.ts";
import { programVersion, reportVersion } from "../program.ts";
import {
  DeskRefused, type AdoptMode, type AgentCommand, type AgentProfile, type DeskAdoption, type DeskSession,
  type ModeOption, type ModelCatalog, type Provider, type SessionOptions, type SessionSink, type ThreadMode, type UsageReport,
} from "../types.ts";
import type { SearchFile } from "../../search/readers.ts";
import { appEffort, lowestEffort, modelCatalog, modeFor } from "./models.ts";
import { droidEnvironment, forgetStale, localSdk, staleMs, type DroidHandle, type DroidSdk } from "./sdk.ts";
import { DroidSession, type DroidHost } from "./session.ts";
import { DroidStore, type DroidThread } from "./store.ts";
import { customCommands } from "./commands.ts";
import { DroidSessionFiles, type StoredDroidSession } from "./desk.ts";
import { DroidForks } from "./fork.ts";
import { cancelledForkTool, settledDroidSnapshot, unfinishedDroidTools } from "./pending.ts";
import { droidProcesses, openedDroids, type DroidProcess } from "./processes.ts";

export interface DroidProviderOptions {
  command: string;
  directory: string;
  idleMs: number;
  maxWarm: number;
  portals?: CommandAccess;
  env?: NodeJS.ProcessEnv;
  sdk?: DroidSdk;
  checkVersion?: boolean;
  interruptGraceMs?: number;
  backgroundHoldMs?: number;
  now?: () => number;
  /**
   * The model a new thread is named with after its first message, in one short request
   * off the turn's path (`DroidSdk.title`). Left out: the thread's own model. null: the
   * bridge makes no names, and a thread takes Droid's own.
   */
  titleModel?: string | null;
  processes?: () => Promise<DroidProcess[]>;
  /** How `usage` reaches the keychain and the network (tests). */
  planLimits?: Pick<PlanLimitsOptions, "os" | "keychain" | "fetch">;
}

interface CatalogCache {
  models: ModelInfo[];
  /** Droid's own settings, as the last session it started had them: its model, level, autonomy and mode. */
  defaults?: { model: string; reasoning: string; autonomy?: string; interaction?: string };
}

export class DroidProvider implements Provider, DroidHost {
  readonly profile: AgentProfile = {
    name: "droid", kind: "droid", displayName: "Droid",
    description: `Droid on this ${machineWord()}, with your own settings and sign-in.`, model: "default", provider: "droid",
  };
  readonly supportsModes = true;
  /** Its commands the bridge runs itself (`commands`). */
  readonly executes = ["skills", "mcp", "cost", "rename"] as const;
  readonly modesWaitForTurn = true;
  readonly modeOptions = [
    { id: "ask", label: "Off", description: "Asks before changes and commands that Droid's rules do not already allow." },
    { id: "edits", label: "Low", description: "File edits and low-risk commands can run without asking." },
    { id: "medium", label: "Medium", description: "Reversible development actions can run without asking. Droid can still ask for approval." },
    { id: "full", label: "High", description: "High-risk actions can run without asking, subject to Droid's safety rules. This is not unsafe permission bypass." },
    { id: "plan", label: "Spec", description: "Plans first and waits for your approval before implementation." },
    { id: "default", label: "Default", description: "Inherits your Droid CLI settings." },
  ] satisfies ModeOption[];
  readonly modeMeanings = {
    ask: "asks before changes and commands that its rules do not already allow.",
    edits: "uses Droid Low autonomy: file edits and low-risk commands can run without asking.",
    medium: "uses Droid Medium autonomy: reversible development actions can run without asking. Droid can still ask for approval.",
    plan: "plans in Droid Spec Mode and waits for your approval before implementation.",
    full: "uses Droid High autonomy, not unsafe permission bypass. Droid can still ask for approval.",
  };
  readonly sdk: DroidSdk;
  readonly store: DroidStore;
  readonly pool: WarmPool;
  readonly note: string | null;
  readonly tellsThread: boolean;
  readonly interruptGraceMs: number;
  readonly backgroundHoldMs: number;
  readonly now: () => number;
  private readonly options: DroidProviderOptions;
  private readonly env: Record<string, string>;
  private readonly cacheFile: string;
  private cache: CatalogCache;
  private readonly sessions = new Set<DroidSession>();
  private readonly deskReads = new Map<string, symbol>();
  private readonly files: DroidSessionFiles;
  private readonly forks: DroidForks;
  private readonly commandCache = new Map<string, Awaited<ReturnType<DroidHandle["listCommands"]>>>();
  private loading: Promise<void> | null = null;
  private checkedAt: number | undefined;
  private closed = false;
  /** Stops the one-shot Droids making names now, when the provider closes. */
  private readonly naming = new AbortController();

  constructor(options: DroidProviderOptions) {
    this.options = options;
    this.env = droidEnvironment(options.portals ? onPath(options.env ?? process.env, options.portals.bin) : options.env ?? process.env);
    this.sdk = options.sdk ?? localSdk(options.command, this.env);
    this.store = new DroidStore(options.directory);
    const home = this.env.FACTORY_HOME_OVERRIDE ?? this.env.HOME ?? homedir();
    this.files = new DroidSessionFiles(home, join(options.directory, "names"));
    this.forks = new DroidForks(options.directory, home);
    this.pool = new WarmPool({ idleMs: options.idleMs, maxWarm: options.maxWarm });
    this.note = options.portals?.instructions ?? null;
    this.tellsThread = options.portals !== undefined;
    this.interruptGraceMs = options.interruptGraceMs ?? 15_000;
    this.backgroundHoldMs = options.backgroundHoldMs ?? 60 * 60_000;
    this.now = options.now ?? Date.now;
    this.cacheFile = join(options.directory, "models.json");
    const cache = readJSON<Partial<CatalogCache>>(this.cacheFile, {});
    this.cache = {
      models: Array.isArray(cache.models) ? cache.models.flatMap((value) => {
        const parsed = ModelInfoSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }) : [],
      defaults: typeof cache.defaults?.model === "string" && typeof cache.defaults.reasoning === "string" ? cache.defaults : undefined,
    };
  }

  /** The bridge's own record of the thread's conversation (feature thread_search). */
  async searchFile(thread: { id: string; cwd: string }): Promise<SearchFile | null> {
    const path = this.store.file(thread.id);
    return path ? { path, format: "stored" } : null;
  }

  start(): void {
    this.pool.start();
    this.forks.sweep();
    // What a naming stopped as the bridge stopped left behind.
    try { forgetStale(this.env.HOME, realpathSync(join(this.options.directory, "names")), Date.now() - staleMs); } catch { /* No names made yet. */ }
    if (this.options.checkVersion !== false) {
      void programVersion(this.options.command, this.env).then((version) =>
        reportVersion({ name: "Droid", version, tested: ["0.236.0", "0.245.0", "0.247.0", "1.0.0"], path: this.options.command, setting: "droid.path" }));
    }
    void this.refresh();
  }

  /** How much of the plan is used (`/usage`), as Factory says it to Droid's own sign-in (`planLimits.ts`). */
  async usage(): Promise<UsageReport> {
    return factoryUsage({ ...this.options.planLimits, home: this.env.FACTORY_HOME_OVERRIDE ?? this.env.HOME ?? homedir(), env: this.env });
  }

  /**
   * A kept list is answered at once, never waiting for a new Droid process; once it is old,
   * Droid is asked again in the background. With none kept yet, the list waits for Droid's.
   */
  async models(): Promise<ModelCatalog> {
    if (!this.closed && (this.checkedAt === undefined || this.now() - this.checkedAt > 10 * 60_000)) void this.refresh();
    if (this.cache.models.length === 0) await this.loading;
    return modelCatalog(this.cache.models, this.cache.defaults);
  }

  private async refresh(): Promise<void> {
    if (this.loading) return this.loading;
    this.checkedAt = this.now();
    this.loading = this.sdk.models().then((models) => {
      this.cache.models = models;
      writeJSON(this.cacheFile, this.cache);
    }).catch((error: Error) => {
      log.warn("could not list Droid models", { error: error.message });
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  model(id: string): ModelInfo | undefined { return this.cache.models.find((model) => model.id === id && !model.disabled); }

  async commands(thread?: { id: string; cwd: string }, name?: string): Promise<AgentCommand[]> {
    const session = thread ? [...this.sessions].find((session) => session.id === thread.id) : undefined;
    const builtins: AgentCommand[] = [
      { name: "context", description: "Show Droid's estimated context breakdown", usage: "", skill: false },
      { name: "compact", description: "Summarize Droid's conversation to free context", usage: "[instructions]", skill: false },
      ...(["skills", "mcp"] as const).map((name): AgentCommand => ({
        name, description: name === "skills" ? "List skills or confirm a Droid-wide change" : "List MCP servers and tools or confirm a Droid-wide change",
        requiresWritable: true,
        usage: name === "skills" ? "[on|off <name> [confirm]]" : "[tools [server] | on|off <server> [confirm] | tool on|off <server> <tool> [confirm]]", skill: false,
        execute: async (argument) => {
          if (!session) throw new Error("This Droid thread is not open.");
          return session.controlsCommand(name, argument);
        },
      })),
      { name: "cost", description: "Show this Droid session's observed tokens and Factory credits", usage: "", skill: false,
        execute: async () => { if (!session) throw new Error("This Droid thread is not open."); return session.cost(); } },
      { name: "rename", description: "Rename this thread in Droid and Portals", usage: "<title>", skill: false,
        execute: async (title) => {
          if (!session) throw new Error("This Droid thread is not open.");
          if (!title) throw new Error("Give /rename a nonempty title.");
          await session.rename(title);
          session.renamed(title);
          return `Renamed this thread to "${title}".`;
        } },
    ];
    if (this.closed || builtins.some((command) => command.name === name)) return builtins;
    const home = this.env.HOME || homedir();
    const cwd = thread?.cwd ?? home;
    let listed = this.commandCache.get(cwd) ?? { commands: [] };
    for (const candidate of this.sessions) {
      if (candidate.cwd !== cwd) continue;
      try {
        const fresh = await candidate.listCommandsIfWarm();
        if (!fresh) continue;
        listed = fresh;
        this.commandCache.set(cwd, fresh);
        break;
      } catch { /* Cached metadata and read-only discovery remain available. */ }
    }
    return [...builtins, ...customCommands(listed, home, thread?.cwd)];
  }

  /**
   * A name for a thread whose first message is `message` and whose model is `model`, made
   * the way Codex threads are named (../codex/naming.ts): Codex's title prompt, in one
   * `droid exec` on `titleModel` or else the thread's model, at its lowest effort, in an
   * empty folder of the bridge's. Null when names are off, when there is nothing to name
   * it by, or when Droid gives none within a minute; a failure is logged and gives null too.
   */
  async name(message: string, model: string): Promise<string | null> {
    const chosen = this.options.titleModel === undefined ? model : this.options.titleModel;
    const said = titleSource(message);
    if (!chosen || said === "" || !this.sdk.title || this.closed) return null;
    try {
      const cwd = join(this.options.directory, "names");
      mkdirSync(cwd, { recursive: true });
      const answer = await this.sdk.title({
        prompt: titlePrompt(said), instructions: titleInstructions, model: chosen,
        effort: lowestEffort(this.model(chosen)), cwd: realpathSync(cwd), signal: this.naming.signal,
      });
      return nameFromText(answer);
    } catch (error) {
      // Said, so that names that stop coming (a model gone from Droid's list, say) are seen.
      if (!this.closed) log.warn("Droid did not make a thread's name", { model: chosen, error: (error as Error).message });
      return null;
    }
  }

  learn(handle: DroidHandle): void {
    const { modelId, reasoningEffort, autonomyLevel, interactionMode } = handle.settings;
    this.cache.defaults = {
      model: modelId, reasoning: appEffort(reasoningEffort),
      ...(autonomyLevel ? { autonomy: autonomyLevel } : {}), ...(interactionMode ? { interaction: interactionMode } : {}),
    };
    writeJSON(this.cacheFile, this.cache);
  }

  /**
   * What a thread following Droid's own settings runs in, as the last session Droid started
   * had them, so a new thread's composer names its autonomy rather than "Default" (2026-10-23: it "should just read the model ... and then the actual autonomy mode").
   */
  defaultMode(): Exclude<ThreadMode, "default"> | null {
    const autonomy = this.cache.defaults?.autonomy;
    if (!autonomy) return null;
    const interaction = (this.cache.defaults?.interaction ?? DroidInteractionMode.Auto) as DroidInteractionMode;
    return modeFor({ autonomyLevel: autonomy as AutonomyLevel, interactionMode: interaction }) ?? null;
  }

  async startSession(options: SessionOptions, sink: SessionSink): Promise<DroidSession> {
    if (this.closed) throw new Error("The Droid provider is closed.");
    if (this.store.exists(options.id)) throw new Error("This Droid thread already exists. Resume it instead.");
    const session = new DroidSession(options, sink, this, null);
    this.sessions.add(session);
    try {
      await session.initialize();
      return session;
    } catch (error) { await session.close(); throw error; }
  }

  async resumeSession(options: SessionOptions, sink: SessionSink): Promise<DroidSession> {
    if (this.closed) throw new Error("The Droid provider is closed.");
    let state = this.store.read(options.id);
    if (options.readOnly && state.deskSource) {
      state = await this.readDesk(state.session, options.id, options.cwd) ?? state;
    }
    const session = new DroidSession(options, sink, this, state);
    this.sessions.add(session);
    return session;
  }

  async readDesk(session: string, id: string, cwd: string): Promise<DroidThread | null> {
    const read = Symbol();
    this.deskReads.set(id, read);
    try {
      const source = await this.files.find(session);
      if (!source) return null;
      const state = await this.files.thread(source, id);
      // An older import cannot replace a newer refresh, in memory or on disk.
      if (this.deskReads.get(id) !== read) return null;
      const kept = this.store.exists(id) ? this.store.read(id) : null;
      // A concurrent Continue may have claimed this transcript while discovery awaited.
      if (kept && (!kept.deskSource || kept.deskReadOnly === false)) return null;
      state.deskReadCwd = kept?.deskReadCwd ?? canonicalFolder(cwd);
      this.store.write(state);
      return state;
    } catch (error) {
      // A source that can no longer be imported (its mode changed to one Portals cannot
      // run, a file that cannot be read) leaves the snapshot read before: it still opens.
      log.warn("could not refresh a Droid desk session read in Portals", { session: id, error: (error as Error).message });
      return null;
    } finally {
      if (this.deskReads.get(id) === read) this.deskReads.delete(id);
    }
  }

  /** Where Droid's sessions ran, at the desk and here alike, from the headers of its session files. */
  async recentFolders(): Promise<RecentFolder[]> {
    return this.files.folders();
  }

  async deskSessions(wanted: number): Promise<DeskSession[]> {
    const mappings = this.store.mappings();
    const bySession = new Map(mappings.map((thread) => [thread.session, thread.id]));
    // The sessions Portals' threads went on from: the threads', so never listed at all.
    const former = new Set(mappings.flatMap((thread) => [...thread.formerSessions ?? [], ...thread.previousSession ? [thread.previousSession] : []])
      .filter((session) => !bySession.has(session)));
    let open: ReturnType<typeof openedDroids>;
    try { open = openedDroids(await (this.options.processes ?? droidProcesses)(), this.sdk.ownedPids?.() ?? new Set()); }
    catch { open = { ids: new Set(), folders: new Set(), uncertain: true }; }
    return (await this.files.newest(wanted + former.size)).filter((session) => !former.has(session.id)).slice(0, wanted).map((session) => ({
      id: bySession.get(session.id) ?? session.id, title: session.title, cwd: session.cwd, updated: session.updated,
      state: open.uncertain || open.ids.has(session.id) || open.folders.has(canonicalFolder(session.cwd)) ? "open" : "closed",
    }));
  }

  async keeps(id: string): Promise<boolean> {
    const native = this.store.exists(id) ? this.store.read(id).session : id;
    return await this.files.find(native) !== null;
  }

  async canContinue(id: string, cwd: string): Promise<void> {
    try {
      const open = openedDroids(await (this.options.processes ?? droidProcesses)(), this.sdk.ownedPids?.() ?? new Set());
      if (open.desktop) throw new DeskRefused("The Factory app is open and may have this session loaded. Quit the Factory app before continuing here, or use Fork. You can still read this session.");
      if (open.uncertain || open.ids.has(id) || open.folders.has(canonicalFolder(cwd))) {
        throw new DeskRefused("Droid may have this session open elsewhere. Quit Droid elsewhere before continuing it here, or fork it instead.");
      }
    } catch (error) {
      if (error instanceof DeskRefused) throw error;
      throw new DeskRefused("Portals could not check whether Droid has this session open elsewhere. Quit Droid elsewhere and try again, or fork it instead.");
    }
    const source = await this.files.find(id);
    if (!source) throw new DeskRefused("Droid's saved conversation is no longer available.");
    checkReadFolder(source.cwd, cwd);
    if (unfinishedDroidTools(readFileSync(source.path, "utf8")).size) {
      throw new DeskRefused("Droid has unfinished tool calls that Continue could resume automatically. Wait for them to finish, or use Fork. Fork cancels those unfinished calls only in the copy and runs nothing.");
    }
  }

  async adopt(id: string, mode: AdoptMode, readOnly = false): Promise<DeskAdoption> {
    let kept = this.store.exists(id) ? this.store.read(id) : null;
    const source = await this.files.find(kept?.session ?? id);
    if (!source) throw new DeskRefused(`Droid has no session by that id on this ${machineWord()}.`);
    kept = this.store.exists(id) ? this.store.read(id) : null;
    const current = [...this.sessions].find((session) => session.id === id);
    if (mode === "continue") {
      // Only a thread the bridge lists as read is held to the folder it was read in. A
      // record an earlier read or a fork's folder check left, with no such thread now, is
      // refreshed below from where the session is now.
      if (readOnly && kept?.deskSource && kept.deskReadOnly !== false) {
        checkReadFolder(source.cwd, kept.deskReadCwd ?? kept.cwd);
      }
      await this.canContinue(source.id, source.cwd);
    }
    if (mode !== "fork") {
      const refresh = mode === "continue" && kept?.deskSource && kept.deskReadOnly !== false;
      const state = !kept || refresh ? await this.files.thread(source, id) : kept;
      if (state.deskSource) state.deskReadCwd ??= canonicalFolder(state.cwd);
      if (mode === "continue" && state.deskSource) state.deskReadOnly = false;
      // Only a file snapshot is refreshed; a bridge-owned transcript is authoritative.
      if (!kept || refresh) this.store.write(state);
      return { id, cwd: source.cwd, title: source.title || null, settings: state.settings };
    }
    // A session Portals cannot run is refused before Droid is asked to make a copy of it.
    await this.files.settings(source);
    const title = `${source.title || "Untitled session"} (fork)`;
    let fork: string;
    let warm = false;
    try {
      const copied = await current?.fork(title, async (thread) => {
        if (thread && thread.session !== source.id) throw new Error("Droid's conversation changed. Try Fork again.");
        return this.forks.copy(source, title, this.sdk);
      });
      warm = copied?.warm ?? false;
      kept = copied?.thread ?? kept;
      fork = copied?.id ?? await this.forks.copy(source, title, this.sdk);
    }
    catch (error) { throw new DeskRefused((error as Error).message); }
    if (fork === source.id || fork === kept?.session || fork === id) throw new DeskRefused("Droid did not make a separate session.");
    const made = await this.files.find(fork);
    if (!made) throw new DeskRefused("Droid made a fork, but its saved conversation could not be found.");
    // A failure from here on leaves the fork, cold or warm: it is a session of its own now
    // (`DroidForks.copy` took off its token, the one proof it was the bridge's), which
    // another request or bridge may already have found and taken up, and the session of
    // that id found here may not be the very file that was proven.
    return this.forked(made, title, kept, warm);
  }

  /** The thread of a fork Droid made (`adopt`), saved. */
  private async forked(made: StoredDroidSession, title: string, kept: DroidThread | null, warm: boolean): Promise<DeskAdoption> {
    const fork = made.id;
    if (warm) {
      // An interrupted warm handle can be idle yet still have persisted pending calls.
      // Settle only its new, not-yet-registered fork before anything can load it.
      const text = readFileSync(made.path, "utf8");
      const settled = settledDroidSnapshot(text);
      if (settled !== text) writeFileSync(made.path, settled, { mode: 0o600 });
    }
    const imported = await this.files.thread(made);
    const state = kept && (warm || !kept.deskSource || kept.deskReadOnly === false)
      ? { ...structuredClone(kept), id: fork, session: fork, open: false, deskSource: false }
      : { ...imported, deskSource: false };
    // Preserve bridge display metadata, but never show an unfinished copied call as successful.
    const importedIds = new Map(Object.entries(imported.nativeToolIds ?? {}));
    const latest = new Map(imported.messages.flatMap((row) => row.role === "tool" ? [[importedIds.get(row.tool_call_id) ?? row.tool_call_id, row] as const] : []));
    const cancelled = new Map([...latest].flatMap(([id, row]) => row.content?.includes(cancelledForkTool) ? [[id, row.content] as const] : []));
    const nativeIds = new Map(Object.entries(state.nativeToolIds ?? {}));
    for (const row of state.messages.toReversed()) {
      if (row.role !== "tool") continue;
      // Threads saved before the map existed used this exact suffix for background Execute.
      const nativeId = nativeIds.get(row.tool_call_id) ?? (cancelled.has(row.tool_call_id) || row.name !== "terminal"
        ? row.tool_call_id : row.tool_call_id.replace(/#bg-[a-f0-9]{8}$/, ""));
      if (cancelled.has(nativeId)) { row.content = cancelled.get(nativeId); cancelled.delete(nativeId); }
    }
    state.sessionTokens = 0;
    state.liveSessionTokens = 0;
    state.sessionCredits = 0;
    this.store.write(state);
    return { id: fork, cwd: made.cwd, title, settings: state.settings };
  }

  forget(session: DroidSession): void { this.sessions.delete(session); }

  async close(): Promise<void> {
    this.closed = true;
    this.naming.abort();
    this.pool.stop();
    await Promise.all([...this.sessions].map((session) => session.close()));
    await this.loading;
  }
}

function canonicalFolder(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function checkReadFolder(current: string, read: string): void {
  if (canonicalFolder(current) !== canonicalFolder(read)) {
    throw new DeskRefused(`This session moved to ${current} since it was read; open it from there, or use Fork.`);
  }
}
