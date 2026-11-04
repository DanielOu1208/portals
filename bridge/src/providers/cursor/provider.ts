import { cursorUsage, type PlanLimitsOptions } from "../planLimits.ts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { counters } from "../../counters.ts";
import { log } from "../../log.ts";
import { machineWord } from "../../platform.ts";
import { onPath, type CommandAccess } from "../../portals/access.ts";
import { readBackedUp, readJSON, writeJSON } from "../../store/jsonFile.ts";
import { version } from "../../version.ts";
import { AcpClient, AgentStopped, refuse } from "../acp/client.ts";
import type { AvailableCommand, ConfigOption, InitializeResult, RpcId } from "../acp/protocol.ts";
import { reportVersion } from "../program.ts";
import { mcpCommand, mcpFolderGone, mcpStatusText, type McpServer, type McpServerState } from "../mcpStatus.ts";
import { DeskRefused, type AdoptMode, type AgentCommand, type AgentProfile, type DeskAdoption, type ModelCatalog, type ModeOption, type Provider, type ProviderSession, type SessionOptions, type SessionSettings, type SessionSink, type StoredMessage, type UsageReport } from "../types.ts";
import type { RecentFolder } from "../../folders.ts";
import type { SearchFile } from "../../search/readers.ts";
import { cursorFolders } from "./folders.ts";
import { ProcessNotes } from "./leftovers.ts";
import { cursorCatalog, listedModels, sessionModels, type CursorModel } from "./models.ts";
import { cursorArgs, cursorCapabilities, cursorForceArgs, cursorModeMeanings, cursorName, cursorVersion, hiddenCommands, testedCursorVersion } from "./options.ts";
import { isCursorRequest, keptTodos, permissionRequest, unplacedAnswer } from "./requests.ts";
import { CursorSession, errorText, newSession, NotSignedIn, type CursorHost, type CursorProcess, type KeptThread } from "./session.ts";

// Cursor as an agent of the bridge: `cursor-agent acp`, which speaks the Agent Client
// Protocol (../acp), with the user's own Cursor settings and sign-in.
//
// Cursor runs as a child process, one for each folder its threads are in, started when
// a thread there first needs it and stopped when none has used it for a while. It reads
// a project's rules, skills and MCP servers from where it starts, so a process of its
// own per folder is what makes a thread see them. Threads in the same folder share the
// process.
//
// Several things are the process's and not a session's, which is why the process is
// more than a connection here: the model Cursor is on, which sessions it has loaded,
// which thread announced which tool call (Cursor's own requests name only the call),
// and one queue for the calls that must not overlap.
//
// What Cursor said of its models and commands is kept in `agent.json`, so the app has
// the list before any process runs; each thread's conversation is kept beside it, in
// `threads/` (./session.ts); and the processes that run are noted in `processes.json`,
// so that a bridge can end what one that was killed left behind (./leftovers.ts).
//
// Every process has the bridge's `portals` command first on its PATH, and a thread's
// first message tells Cursor of it (./options.ts).

export interface CursorProviderOptions {
  /** The program: `cursor-agent`, as found. */
  command: string;
  /** What it is started with; `acp` unless a test says otherwise. */
  args?: string[];
  /** What it is started with for threads in Full access; `--force acp` unless a test says otherwise. */
  forceArgs?: string[];
  /** Where what Cursor said of itself, and its threads' conversations, are kept. */
  directory: string;
  /** A process stops after this long with nothing running or waiting. */
  idleMs: number;
  env?: NodeJS.ProcessEnv;
  /** The `portals` command, given to every process and told to each thread with its first message. */
  portals?: CommandAccess;
  /** Skips the version check (tests). */
  checkVersion?: boolean;
  /** How long Cursor has to start (tests). */
  startTimeoutMs?: number;
  /** How long Cursor has to end a turn it was asked to stop (tests). */
  interruptGraceMs?: number;
  /** Where Cursor keeps its sessions and chats, for the folders it worked in; null for none (tests). `~/.cursor` when absent. */
  cursorHome?: string | null;
  /** How `usage` reaches the keychain and the network (tests). */
  planLimits?: Pick<PlanLimitsOptions, "os" | "keychain" | "fetch">;
}

/** What is kept of Cursor between runs of the bridge. */
interface Kept {
  models: CursorModel[] | null;
  commands: AgentCommand[];
  /**
   * The models say which levels are not known (`CursorModel.unknown`). A file from a
   * bridge before that may hold models read from a session, every one but the model it
   * was on with no levels said: each with none is taken as not known, until Cursor lists
   * them again.
   */
  marksUnknown?: true;
}

/** A thread's file, as it may be read: one written by hand or cut short holds anything. */
type ThreadFile = Partial<KeptThread>;

/** How often the folders Cursor worked in are read again: a new one comes with a session Cursor made, rarely. */
const folderEveryMs = 10 * 60_000;

/** How many subagent sessions no thread takes are remembered. */
const ignoredKept = 500;

/** How many tool calls a process remembers the thread of. */
const callsKept = 2000;
const listTimeoutMs = 30_000;

class Process implements CursorProcess {
  readonly client: AcpClient;
  readonly cwd: string;
  /** Started with `--force`, for threads in Full access. */
  readonly forced: boolean;
  info: InitializeResult = { protocolVersion: 0 };
  readonly loaded = new Set<string>();
  current: ConfigOption[] | null = null;
  lastUsed = Date.now();
  /** Cursor's session that announced each tool call, by the call's id. */
  readonly calls = new Map<string, string>();
  /** Cursor listed its models when this run started; when not, they are read from what its sessions say. */
  listed = false;
  /** New sessions being made in it: waiting their turn, or asked of Cursor and not answered. */
  pending = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly learned: (process: Process, options: ConfigOption[]) => void;

  constructor(client: AcpClient, cwd: string, forced: boolean, learned: (process: Process, options: ConfigOption[]) => void) {
    this.client = client;
    this.cwd = cwd;
    this.forced = forced;
    this.learned = learned;
  }

  /** What it is known by among the processes that run: its folder, and whether it runs everything. */
  get key(): string {
    return processKey(this.cwd, this.forced);
  }

  learn(options: unknown): void {
    if (!Array.isArray(options)) return;
    this.current = options;
    this.learned(this, options);
  }

  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  touch(): void {
    this.lastUsed = Date.now();
  }

  /** Makes a new session, in its turn. The process counts as at work until Cursor has answered. */
  async making<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    try {
      return await this.exclusive(task);
    } finally {
      this.pending -= 1;
    }
  }

  /** Notes which session a tool call is of. The oldest go when there are many. */
  announced(toolCall: string, session: string): void {
    this.calls.set(toolCall, session);
    if (this.calls.size > callsKept) this.calls.delete(this.calls.keys().next().value!);
  }
}

type Params = Record<string, any>;

/** A process's place among those that run: one for each folder, and one more there for threads in Full access. */
function processKey(cwd: string, forced: boolean): string {
  return forced ? `${cwd}\0force` : cwd;
}

/** What `cursor-agent mcp list` says of a server, in `/mcp`'s words; an error is `Error: …`. */
const cursorMcpStates: Record<string, McpServerState> = {
  ready: "connected", loading: "starting", requires_authentication: "signIn", disabled: "off", "not loaded (needs approval)": "approval",
};

/** `/mcp` from what `cursor-agent mcp list` printed: a line a server, `name: state`. */
export function cursorMcpText(printed: string): string {
  const servers = printed.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split("\n").flatMap((line): McpServer[] => {
    const at = line.indexOf(": ");
    if (at <= 0 || line.startsWith("No MCP servers configured")) return [];
    const name = line.slice(0, at).trim(), said = line.slice(at + 2).trim();
    const error = /^Error: (.*)$/s.exec(said)?.[1];
    if (error !== undefined) return [{ name, state: "failed", detail: error }];
    const state = cursorMcpStates[said];
    return [state ? { name, state } : { name, state: "unknown", detail: said }];
  });
  return mcpStatusText(cursorName, servers, {
    signIn: "To sign in to one, run cursor-agent mcp login <name> on the host.",
    approve: "To approve one, run cursor-agent mcp enable <name> on the host, in the thread's folder.",
  });
}

export class CursorProvider implements Provider, CursorHost {
  readonly supportsModes = true;
  /** Its command the bridge runs itself, through `cursor-agent mcp list`: Cursor's ACP has none for it. */
  readonly executes = ["mcp"] as const;
  /**
   * Cursor's three modes alone (`cursorMode`), in the app's own words where they fit: with
   * none given, the app offered its five, and full access and accept edits were refused.
   */
  readonly modeOptions = [
    { id: "ask", label: "Ask", description: "Reads and answers: Cursor is told to edit no files and run no commands." },
    { id: "plan", label: "Plan", description: "Plans first, reading only, and waits for your go-ahead before carrying the plan out." },
    { id: "default", label: "Agent", description: "Cursor's agent mode: it asks before acting as your Cursor settings say (Allowlist, Auto-review or Run Everything)." },
    { id: "full", label: "Full access", description: "Cursor's agent mode with Run Everything: it edits, runs commands and searches the web without asking, unless your team does not allow it." },
  ] satisfies ModeOption[];
  readonly modeMeanings = cursorModeMeanings;
  /** Cursor takes a mode as it takes a prompt: one chosen during a turn counts from the next. */
  readonly modesWaitForTurn = true;
  readonly interruptGraceMs: number;
  /** What a thread's first message tells Cursor of the `portals` command; null when agents are not told. */
  readonly note: string | null;
  private readonly command: string;
  private readonly args: string[];
  private readonly forceArgs: string[];
  private readonly directory: string;
  private readonly idleMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly planLimits: CursorProviderOptions["planLimits"];
  private readonly startTimeoutMs: number | undefined;
  private readonly checking: boolean;
  /** The versions of the program told of since the bridge started; null is one that did not run. */
  private readonly versionsSaid = new Set<string | null>();
  /** Cursor's processes, by the folder each runs in. */
  private readonly running = new Map<string, Process>();
  private readonly starting = new Map<string, Promise<Process>>();
  /** Processes no longer running here whose end is not over: one being stopped, or what one that died left of its group. */
  private readonly ending = new Set<Process>();
  /** The processes that run, noted on disk. */
  private readonly notes: ProcessNotes;
  /** The end of what an earlier bridge left running. No process starts before it. */
  private cleared: Promise<void> = Promise.resolve();
  /** The threads loaded, by thread id, and by the Cursor session each talks to. */
  private readonly sessions = new Map<string, CursorSession>();
  private readonly bySession = new Map<string, CursorSession>();
  /** The thread each of Cursor's subagent sessions is of, by the subagent's session (./subagents.ts). */
  private readonly children = new Map<string, CursorSession>();
  /**
   * Subagent sessions no thread takes (one told of outside a turn, or by a subagent that
   * had ended), with theirs: what they ask is answered as unshown, and their tool calls
   * are noted as theirs, so a question of theirs is not taken for the one busy thread's.
   */
  private readonly ignored = new Set<string>();
  /** For a thread read from its file's backup: where its next save keeps the file that could not be used. */
  private readonly asides = new Map<string, string>();
  /** Sessions made by `newThread`, until their thread is started: the process each is in. */
  private readonly made = new Map<string, Process>();
  private kept: Kept;
  private timer: NodeJS.Timeout | null = null;
  /** The folders Cursor worked in, as last read (./folders.ts), and when they are read again. */
  private folders: RecentFolder[] = [];
  private folderTimer: NodeJS.Timeout | null = null;
  /** Where Cursor keeps its sessions and chats; null reads none (tests). */
  private readonly cursorHome: string | null;
  /** Where Cursor keeps the sessions made through ACP, each a folder of its own; null for none (tests). */
  private readonly sessionsFolder: string | null;
  private closed = false;

  constructor(options: CursorProviderOptions) {
    this.command = options.command;
    this.args = options.args ?? cursorArgs;
    this.forceArgs = options.forceArgs ?? cursorForceArgs;
    this.directory = options.directory;
    this.idleMs = options.idleMs;
    const env = options.env ?? process.env;
    this.env = options.portals ? onPath(env, options.portals.bin) : env;
    this.planLimits = options.planLimits;
    this.note = options.portals?.instructions ?? null;
    this.checking = options.checkVersion ?? true;
    this.startTimeoutMs = options.startTimeoutMs;
    this.interruptGraceMs = options.interruptGraceMs ?? 15_000;
    this.notes = new ProcessNotes(join(this.directory, "processes.json"));
    this.cursorHome = options.cursorHome === undefined ? join(homedir(), ".cursor") : options.cursorHome;
    this.sessionsFolder = this.cursorHome === null ? null : join(this.cursorHome, "acp-sessions");
    const kept = readJSON<Partial<Kept>>(join(this.directory, "agent.json"), {});
    const models = Array.isArray(kept.models) ? kept.models : null;
    this.kept = {
      models: kept.marksUnknown || !models ? models : models.map((model) => (model?.level ? model : { ...model, unknown: true as const })),
      commands: Array.isArray(kept.commands) ? kept.commands : [],
      marksUnknown: true,
    };
  }

  get profile(): AgentProfile {
    return { name: "cursor", kind: "cursor", displayName: cursorName, description: `${cursorName} on this ${machineWord()}, with your own settings and sign-in.`, model: "default", provider: "cursor" };
  }

  /** What `default` comes to is Cursor's agent mode, which is none of the app's four. */
  defaultMode(): null {
    return null;
  }

  /** The bridge's own record of the thread's conversation (feature thread_search). */
  async searchFile(thread: { id: string; cwd: string }): Promise<SearchFile | null> {
    const path = this.threadFile(thread.id);
    return existsSync(path) ? { path, format: "stored" } : null;
  }

  /**
   * Checks the installed version, ends what a bridge that was killed left running, and
   * starts the idle sweep. Cursor itself starts with its first thread.
   */
  start(): void {
    if (this.timer) return;
    this.checkVersion();
    this.cleared = this.notes.endLeftovers().catch((error: Error) => log.warn(`could not look for a ${cursorName} left running`, { error: error.message }));
    this.timer = setInterval(() => this.sweep(), Math.min(60_000, Math.max(1000, this.idleMs / 4)));
    this.timer.unref();
    if (this.cursorHome !== null) {
      void this.readFolders();
      this.folderTimer = setInterval(() => void this.readFolders(), folderEveryMs);
      this.folderTimer.unref();
    }
  }

  /** The folders Cursor worked in, at the desk and through ACP, as last read: it answers at once. */
  async recentFolders(): Promise<RecentFolder[]> {
    return this.folders;
  }

  private async readFolders(): Promise<void> {
    try {
      this.folders = await cursorFolders(this.cursorHome!);
    } catch (error) {
      log.debug(`could not read where ${cursorName} worked`, { error: (error as Error).message });
    }
  }

  /**
   * Logs which release of Cursor runs, once for each: when the bridge starts, and again
   * for another one found when a process starts. Cursor's command replaces itself with
   * a newer release whenever it is used in a terminal, so the one checked at the
   * bridge's start is not the one a thread runs on a week later. Nothing waits for it.
   */
  private checkVersion(): void {
    if (!this.checking) return;
    void cursorVersion(this.command, this.env).then((version) => {
      if (this.versionsSaid.has(version)) return;
      this.versionsSaid.add(version);
      reportVersion({ name: cursorName, version, tested: testedCursorVersion, path: this.command, setting: "cursor.path" });
    });
  }

  /** How much of the plan is used (`/usage`), as Cursor says it to cursor-agent's own sign-in (`planLimits.ts`). */
  async usage(): Promise<UsageReport> {
    return cursorUsage({ ...this.planLimits, home: this.env.HOME || homedir(), env: this.env });
  }

  async models(): Promise<ModelCatalog> {
    return cursorCatalog({ id: this.profile.name, name: cursorName }, this.kept.models);
  }

  async commands(thread?: { id: string; cwd: string }): Promise<AgentCommand[]> {
    const mcp = mcpCommand(() => this.mcpStatus(thread?.cwd));
    return [mcp, ...this.kept.commands.filter((command) => command.name !== mcp.name)];
  }

  /**
   * How the MCP servers of a thread in `cwd` are (`/mcp`), as `cursor-agent mcp list` run
   * there says: it reads the folder's `.cursor/mcp.json` and the user's, and connects to
   * each for the moment it asks. Not run elsewhere for a thread whose folder is gone
   * (`mcpFolderGone`).
   */
  private mcpStatus(cwd: string | undefined): Promise<string> {
    if (cwd !== undefined && !existsSync(cwd)) return Promise.reject(mcpFolderGone(cursorName, cwd));
    return new Promise((resolve, reject) => {
      execFile(this.command, ["mcp", "list"], { cwd: cwd ?? (this.env.HOME || homedir()), env: { ...this.env, NO_COLOR: "1" }, timeout: 60_000, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${cursorName} did not say how its MCP servers are: ${(stderr.trim() || error.message).split("\n")[0]}`));
        else resolve(cursorMcpText(stdout));
      });
    });
  }

  // MARK: Threads

  /** Starts a session in `cwd`; its id is the bridge's thread id. */
  async newThread(options: { cwd: string; settings: SessionSettings }): Promise<string> {
    const process = await this.open(options.cwd);
    process.touch();
    try {
      const state = await process.making(() => newSession(process, options.cwd));
      this.made.set(state.sessionId, process);
      process.touch();
      return state.sessionId;
    } catch (error) {
      if (error instanceof NotSignedIn) this.release(process, null, "is not signed in");
      throw error;
    }
  }

  async startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    const process = this.made.get(options.id);
    this.made.delete(options.id);
    if (!process) throw new Error(`This ${cursorName} session was not started by the bridge.`);
    return this.add(new CursorSession(options, sink, this, { process, stored: [], session: options.id, told: false, todos: [], cut: false }), options.id);
  }

  /** A thread from before: its conversation as kept. Cursor starts when the thread gets a message. */
  async resumeSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    // The file's last save but one when a power cut left it unusable (`save`).
    const read = readBackedUp(this.threadFile(options.id));
    if (read.aside) this.asides.set(options.id, read.aside);
    const file = (read.found ?? {}) as ThreadFile;
    const session = typeof file.session === "string" && file.session !== "" ? file.session : options.id;
    // A thread taken off the list and taken up again while its process still runs is on it still.
    const process = [...this.running.values()].find((running) => running.loaded.has(session)) ?? null;
    const stored = Array.isArray(file.messages) ? file.messages : [];
    return this.add(new CursorSession(options, sink, this, { process, stored, session, told: file.told === true, todos: keptTodos(file.todos), cut: file.open === true }), session);
  }

  private add(session: CursorSession, cursorSession: string): CursorSession {
    this.sessions.set(session.id, session);
    this.bySession.set(cursorSession, session);
    return session;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.folderTimer) clearInterval(this.folderTimer);
    this.folderTimer = null;
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    this.bySession.clear();
    // One that was still starting is stopped as soon as it has.
    await Promise.allSettled([...this.starting.values()]);
    // With those stopped a moment ago, and what one that died left: nothing of Cursor's outlives the bridge.
    await Promise.all([...this.running.values(), ...this.ending].map((process) => process.client.stop()));
    await this.cleared;
  }

  // MARK: Forks

  /**
   * A thread of the bridge's, taken up again (`continue`, one taken off the list), only
   * read, or forked: a new thread whose Cursor session is a copy of this one's, which
   * Cursor loads as it would the thread's own and goes on from (recorded with 2026.10.22,
   * scenario fork-copy). Cursor has no call to fork a session; its sessions are folders
   * of its own (`~/.cursor/acp-sessions/<session>/`: a store and a `meta.json` with the
   * folder and title), and the copy is one of those. The thread's conversation as the
   * app shows it is copied too. Sessions started in Cursor's terminal are not offered:
   * Cursor's ACP opens none of them.
   */
  async adopt(id: string, mode: AdoptMode): Promise<DeskAdoption> {
    const read = this.hasExactThread(id) ? readBackedUp(this.threadFile(id)) : null;
    const file = (read?.found ?? null) as ThreadFile | null;
    if (!file) throw new DeskRefused(`${cursorName} has no thread by that id on this ${machineWord()}.`);
    const session = typeof file.session === "string" && file.session !== "" ? file.session : id;
    const meta = this.sessionMeta(session);
    const cwd = meta?.cwd ?? (typeof file.cwd === "string" ? file.cwd : null);
    if (!cwd) throw new DeskRefused(`Portals does not know which folder this ${cursorName} thread ran in.`);
    const adoption = { cwd, title: meta?.title ?? null, settings: { model: "default", provider: this.profile.name, reasoningEffort: "" } };
    if (mode !== "fork") return { id, ...adoption };
    const current = this.sessions.get(id);
    if (current?.busy || current?.isStuck) throw new DeskRefused(`This ${cursorName} thread is at work: fork it once its turn has ended.`);
    const fork = randomUUID();
    const title = adoption.title ? `${adoption.title} (fork)` : null;
    const from = this.sessionsFolder ? join(this.sessionsFolder, session) : null;
    const to = from && existsSync(from) ? join(this.sessionsFolder!, fork) : null;
    // Without Cursor's session (one that never got a message keeps none), the fork's first message starts one afresh.
    const kept: KeptThread = { messages: Array.isArray(file.messages) ? file.messages : [], cwd, ...(file.told === true ? { told: true } : {}), ...(Array.isArray(file.todos) && file.todos.length > 0 ? { todos: keptTodos(file.todos) } : {}) };
    try {
      if (to) {
        cpSync(from!, to, { recursive: true });
        writeFileSync(join(to, "meta.json"), JSON.stringify({ schemaVersion: 1, cwd, title: title ?? "Fork" }));
      }
      // Written here, not by `save`, which only logs a failure: a fork whose conversation is not on the disk would open empty.
      writeJSON(this.threadFile(fork), kept);
    } catch (error) {
      if (to) rmSync(to, { recursive: true, force: true });
      rmSync(this.threadFile(fork), { force: true });
      throw new DeskRefused(`The ${cursorName} thread could not be copied: ${(error as Error).message}`);
    }
    log.info(`${cursorName} thread forked`, { thread: id, fork });
    return { id: fork, ...adoption, title };
  }

  /** The manager keys policy by the supplied id, so filesystem aliases are not other identities. */
  private hasExactThread(id: string): boolean {
    if (!id || /[/\\\0]/.test(id) || /^\.+$/.test(id)) return false;
    try { return readdirSync(join(this.directory, "threads")).includes(`${id}.json`); }
    catch { return false; }
  }

  /** What Cursor keeps of a session beside its store: its folder and title. Null when there is none to read. */
  private sessionMeta(session: string): { cwd: string; title: string | null } | null {
    if (!this.sessionsFolder) return null;
    try {
      const meta = JSON.parse(readFileSync(join(this.sessionsFolder, session, "meta.json"), "utf8")) as { cwd?: unknown; title?: unknown };
      if (typeof meta.cwd !== "string" || meta.cwd === "") return null;
      return { cwd: meta.cwd, title: typeof meta.title === "string" && meta.title.trim() !== "" ? meta.title.trim() : null };
    } catch {
      return null;
    }
  }

  // MARK: Cursor's processes

  process(cwd: string, forced = false): Promise<CursorProcess> {
    return this.open(cwd, forced);
  }

  private open(cwd: string, forced = false): Promise<Process> {
    const key = processKey(cwd, forced);
    const running = this.running.get(key);
    if (running) return Promise.resolve(running);
    let starting = this.starting.get(key);
    if (!starting) {
      starting = this.launch(cwd, forced).finally(() => this.starting.delete(key));
      this.starting.set(key, starting);
    }
    return starting;
  }

  /**
   * Starts Cursor in `cwd`: the hello, then its list of models. No session call goes
   * to a process before both are answered: Cursor builds its shared services at the
   * first call that needs them, with no guard for one under way.
   */
  private async launch(cwd: string, forced: boolean): Promise<Process> {
    // Not beside a process a killed bridge left, which may have the same sessions open.
    await this.cleared;
    if (this.closed) throw new Error("The bridge is stopping.");
    if (!existsSync(cwd)) throw new Error(`The folder ${cwd} is gone, so ${cursorName} cannot run there.`);
    this.checkVersion();
    if (counters.on) counters.spawned("cursor");
    const process: Process = new Process(
      new AcpClient({
        name: cursorName,
        command: this.command,
        args: forced ? this.forceArgs : this.args,
        env: this.env,
        cwd,
        clientInfo: { name: "portals-bridge", title: "Portals", version },
        capabilities: cursorCapabilities,
        startTimeoutMs: this.startTimeoutMs,
        listener: {
          notification: (method, params) => this.notified(process, method, params),
          request: (id, method, params) => this.request(process, id, method, params),
          stopped: (reason) => this.stopped(process, reason),
        },
      }),
      cwd,
      forced,
      (from, options) => this.learned(from, options),
    );
    const hello = process.client.start();
    if (process.client.pid !== undefined) this.notes.add(process.client.pid);
    process.info = await hello;
    try {
      const models = listedModels(await process.client.call("cursor/list_available_models", {}, listTimeoutMs));
      if (models) {
        process.listed = true;
        this.keep({ ...this.kept, models });
      }
    } catch (error) {
      if (error instanceof AgentStopped) throw error;
      // Another release of Cursor, or one not signed in: its sessions say what they can be set to.
      log.warn(`${cursorName} did not list its models`, { error: errorText(error) });
    }
    // It may have gone again in the moment since it answered, or the bridge is stopping.
    if (!process.client.isRunning || this.closed) {
      this.end(process);
      throw new AgentStopped(`${cursorName} stopped as soon as it had started`);
    }
    this.running.set(process.key, process);
    log.info(`${cursorName} started`, { folder: cwd, ...(forced ? { runsEverything: true } : {}) });
    return process;
  }

  private stopped(process: Process, reason: string): void {
    const wasRunning = this.running.get(process.key) === process;
    if (wasRunning) this.running.delete(process.key);
    if (process.client.pid !== undefined) this.notes.remove(process.client.pid);
    // One that died may have left something of its group, which is being ended.
    this.end(process);
    for (const [id, made] of this.made) {
      if (made === process) this.made.delete(id);
    }
    for (const session of this.sessions.values()) {
      if (session.isOn(process)) session.connectionLost();
    }
    if (wasRunning) log.info(reason, { folder: process.cwd });
  }

  /** Whether a thread other than `except` needs `process` now, or a new session is being made in it or waits there for its thread. */
  private atWork(process: Process, except: CursorSession | null = null): boolean {
    for (const session of this.sessions.values()) {
      if (session !== except && session.busy && (session.isOn(process) || (session.cwd === process.cwd && session.runsForced === process.forced))) return true;
    }
    return process.pending > 0 || [...this.made.values()].includes(process);
  }

  release(process: CursorProcess, session: CursorSession | null, why: string): void {
    const running = process as Process;
    if (this.running.get(running.key) !== running || this.atWork(running, session)) return;
    this.stop(running, why);
  }

  /**
   * `session` moved to its folder's other process: the one it left is stopped when no
   * other thread is on it or at work there. One with threads on it, even at rest, stays.
   */
  left(process: CursorProcess, session: CursorSession): void {
    const running = process as Process;
    if (this.running.get(running.key) !== running || this.atWork(running, session)) return;
    if ([...this.sessions.values()].some((other) => other !== session && other.isOn(running))) return;
    this.stop(running, "has no thread left after one moved to its folder's other process");
  }

  /** Stops a process. It is gone from here at once: a message that comes now starts another. */
  private stop(process: Process, why: string): void {
    log.info(`${cursorName} ${why}; stopping it`, { folder: process.cwd, ...(process.forced ? { runsEverything: true } : {}) });
    this.running.delete(process.key);
    this.end(process);
  }

  /** Sees a process to its end, with what it started; `close` waits for the ones under way. */
  private end(process: Process): void {
    this.ending.add(process);
    void process.client.stop().finally(() => this.ending.delete(process));
  }

  /**
   * Stops every process that nothing has used for `idleMs` and nothing is waiting on,
   * and one that owes the answer to a prompt it was asked to stop as soon as nothing
   * else is at work on it.
   */
  sweep(now = Date.now()): void {
    for (const process of [...this.running.values()]) {
      if (this.atWork(process)) {
        // Idle time counts from when it stops being busy.
        process.lastUsed = now;
        continue;
      }
      const stuck = [...this.sessions.values()].some((session) => session.isOn(process) && session.isStuck);
      if (stuck) this.stop(process, "did not end a turn it was asked to stop");
      else if (now - process.lastUsed >= this.idleMs) this.stop(process, "has been idle");
    }
  }

  // MARK: From Cursor

  /**
   * A notification from Cursor. One the bridge cannot read (a later Cursor's, in a shape
   * nobody expected) is passed over: it must not end a thread, let alone the bridge.
   */
  private notified(process: Process, method: string, params: Params): void {
    try {
      this.notification(process, method, params);
    } catch (error) {
      log.warn(`passed over something ${cursorName} sent that could not be read`, { method, kind: params?.update?.sessionUpdate, error: (error as Error).message });
    }
  }

  private notification(process: Process, method: string, params: Params): void {
    const update = params.update;
    if (method !== "session/update" || !update || typeof update.sessionUpdate !== "string") return;
    switch (update.sessionUpdate) {
      case "available_commands_update":
        // A session just made says its commands before the bridge has its thread.
        if (Array.isArray(update.availableCommands)) this.commandsChanged(update.availableCommands);
        return;
      case "config_option_update":
        process.learn(update.configOptions);
        return;
      default:
        break;
    }
    const found = typeof params.sessionId === "string" ? this.sessionFor(params.sessionId) : undefined;
    if (!found) {
      if (typeof params.sessionId === "string" && this.ignored.has(params.sessionId)) this.passOver(process, params.sessionId, update);
      return;
    }
    if (!this.hears(process, found.session)) return;
    const { session, subagent } = found;
    // A subagent's own session, which its updates and questions name from now on. Only one
    // started in a turn, by the thread or a subagent at work: the turn's end is what ends
    // any that Cursor says no end of.
    if (update.sessionUpdate === "subagent_spawned" && typeof update.subagentSessionId === "string" && !session.isReplaying) {
      if (session.takesSpawn(subagent ?? null)) this.children.set(update.subagentSessionId, session);
      else this.ignore(update.subagentSessionId);
    }
    // Which thread a tool call is of: Cursor's own requests name the call and no session.
    if (update.sessionUpdate === "tool_call" && typeof update.toolCallId === "string" && !session.isReplaying) process.announced(update.toolCallId, params.sessionId);
    if (subagent) session.subagentUpdate(subagent, update);
    else session.update(update);
  }

  /** What a subagent session no thread takes tells: its own subagents are nobody's either, and its calls are its own. */
  private passOver(process: Process, id: string, update: Params): void {
    if (update.sessionUpdate === "subagent_spawned" && typeof update.subagentSessionId === "string") this.ignore(update.subagentSessionId);
    if (update.sessionUpdate === "tool_call" && typeof update.toolCallId === "string") process.announced(update.toolCallId, id);
  }

  private ignore(id: string): void {
    this.ignored.add(id);
    if (this.ignored.size > ignoredKept) this.ignored.delete(this.ignored.values().next().value!);
  }

  /** The thread a session of Cursor's is of: its own, or one of its subagents' (then named). */
  private sessionFor(id: string): { session: CursorSession; subagent?: string } | undefined {
    const own = this.bySession.get(id);
    if (own) return { session: own };
    const parent = this.children.get(id);
    return parent ? { session: parent, subagent: id } : undefined;
  }

  /**
   * Whether what `process` says of `session`'s Cursor session is for that thread. Not
   * from a process that is being stopped, nor from one the thread has left: a process
   * that ignores a stop has two seconds left to write in, and by then another may be
   * running the thread's next turn on the same Cursor session.
   */
  private hears(process: Process, session: CursorSession): boolean {
    return this.running.get(process.key) === process && session.isOn(process);
  }

  /**
   * A request from Cursor: a permission for the thread of the session it names, one of
   * Cursor's own for the thread its tool call is of. One that no thread can be shown,
   * or that could not be read, is still answered.
   */
  private request(process: Process, id: RpcId, method: string, params: Params): void {
    const unshown = () => {
      if (method === permissionRequest) process.client.respond(id, { outcome: { outcome: "cancelled" } });
      // Never an error: Cursor takes one for consent to a plan, and asks a question again as permission cards.
      else if (isCursorRequest(method)) process.client.respond(id, unplacedAnswer(method));
      // An editor's file and terminal services, which the bridge never offered, or a request of a later Cursor's.
      else refuse(process.client, id, method);
    };
    const failed = (error: unknown) => {
      log.warn(`could not show a request of ${cursorName}'s`, { method, error: (error as Error)?.message });
      unshown();
    };
    try {
      if (method === permissionRequest) {
        const found = typeof params.sessionId === "string" ? this.sessionFor(params.sessionId) : undefined;
        if (found && this.hears(process, found.session)) found.session.permission(process, id, params as Parameters<CursorSession["permission"]>[2], found.subagent).catch(failed);
        else unshown();
        return;
      }
      const found = isCursorRequest(method) ? this.threadOf(process, params) : undefined;
      if (found?.session.takesRequests && this.hears(process, found.session)) found.session.request(process, id, method, params, found.subagent).catch(failed);
      else unshown();
    } catch (error) {
      failed(error);
    }
  }

  /**
   * The thread one of Cursor's own requests is for: the one that announced its tool
   * call; when that is not known, the one thread with a turn open on the process, if
   * there is exactly one.
   */
  private threadOf(process: Process, params: Params): { session: CursorSession; subagent?: string } | undefined {
    const announcedBy = typeof params.toolCallId === "string" ? process.calls.get(params.toolCallId) : undefined;
    if (announcedBy) return this.sessionFor(announcedBy);
    const open = [...this.sessions.values()].filter((session) => session.isOn(process) && session.takesRequests);
    return open.length === 1 ? { session: open[0]! } : undefined;
  }

  // MARK: What Cursor says of itself

  /** A session said what it can be set to: the models, for a Cursor that did not list them. */
  private learned(process: Process, options: ConfigOption[]): void {
    if (process.listed) return;
    const models = sessionModels(options, this.kept.models);
    if (models) this.keep({ ...this.kept, models });
  }

  private commandsChanged(commands: AvailableCommand[]): void {
    const own = commands.flatMap((command): AgentCommand[] => {
      const name = typeof command?.name === "string" ? command.name.replace(/^\/+/, "") : "";
      if (name === "" || /\s/.test(name) || hiddenCommands.has(name)) return [];
      return [{ name, description: typeof command.description === "string" ? command.description : "", usage: typeof command.input?.hint === "string" ? command.input.hint : "", skill: false }];
    });
    this.keep({ ...this.kept, commands: own });
  }

  private keep(kept: Kept): void {
    if (JSON.stringify(kept) === JSON.stringify(this.kept)) return;
    this.kept = kept;
    try {
      writeJSON(join(this.directory, "agent.json"), kept);
    } catch (error) {
      log.warn(`could not keep what ${cursorName} said of itself`, { error: (error as Error).message });
    }
  }

  model(id: string): CursorModel | undefined {
    return this.kept.models?.find((model) => model.id === id);
  }

  modelsKnown(): boolean {
    return this.kept.models !== null;
  }

  // MARK: Conversations

  private threadFile(id: string): string {
    return join(this.directory, "threads", `${id}.json`);
  }

  /**
   * Keeps a thread's conversation, the only copy of it the app is shown from, and the
   * file it replaces as `<file>.bak`: nothing waits for a save to be on the disk, so a
   * power cut can leave the file empty, and the thread is then read from the save
   * before (`resumeSession`). That save keeps the file that could not be used aside
   * (store/jsonFile.ts `readBackedUp`), not as the `.bak`.
   */
  save(id: string, kept: KeptThread): void {
    try {
      const aside = this.asides.get(id);
      writeJSON(this.threadFile(id), kept, aside === undefined ? { backup: true } : { aside });
      this.asides.delete(id);
    } catch (error) {
      log.warn(`could not keep a ${cursorName} conversation`, { session: id, error: (error as Error).message });
    }
  }

  /** The thread whose conversation Cursor has now as `id`, after it was started afresh (`rerouted`). */
  threadKnownAs(id: string): string | undefined {
    const session = this.bySession.get(id);
    return session && session.id !== id ? session.id : undefined;
  }

  rerouted(session: CursorSession, from: string, to: string): void {
    if (this.bySession.get(from) === session) this.bySession.delete(from);
    this.bySession.set(to, session);
  }

  forget(session: CursorSession): void {
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    for (const [id, known] of this.bySession) {
      if (known === session) this.bySession.delete(id);
    }
    for (const [id, known] of this.children) {
      if (known === session) this.children.delete(id);
    }
  }
}
