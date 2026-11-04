import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { log } from "../../log.ts";
import { machineWord } from "../../platform.ts";
import type { CommandAccess } from "../../portals/access.ts";
import type { ChildExit } from "../child.ts";
import { nameFromText, titleInstructions, titlePrompt } from "../codex/naming.ts";
import { WarmPool } from "../pool.ts";
import { titleSource } from "../titles.ts";
import { VersionCheck } from "../program.ts";
import {
  DeskRefused,
  type AdoptMode,
  type AgentCommand,
  type AgentProfile,
  type DeskAdoption,
  type DeskSession,
  type ModelCatalog,
  type Provider,
  type ProviderSession,
  type SessionOptions,
  type SessionSettings,
  type SessionSink,
} from "../types.ts";
import { PiClient, PiGone } from "./client.ts";
import { PiSessionFiles, realFolder, terminalMayHaveIt, terminalPisNow, type StoredPiSession, type TerminalPis } from "./desk.ts";
import { cancelled } from "./dialogs.ts";
import { findSessionFile, readHistory, type PiHistory } from "./history.ts";
import type { SearchFile } from "../../search/readers.ts";
import { RememberedFiles } from "../../search/locate.ts";
import { appLevel, catalogArguments, forkArguments, titleArguments, forkId, isForkId, modelLevels, minimumPiVersion, piEnvironment, piLevel, piVersion, testedPiVersions } from "./options.ts";
import type { PiCommandInfo, PiModel, PiState } from "./protocol.ts";
import { PiSession, type PiHost } from "./session.ts";

// Pi as an agent of the bridge (`pi` in profiles.list). It runs the installed `pi` in its
// RPC mode, one process per thread in use, with the user's own settings, extensions,
// skills and sign-ins. Pi does not ask before it runs a command or edits a file, and
// through the bridge it does the same.
//
// Which models Pi can run and which commands it has is only known from a running Pi, so
// the bridge asks a short-lived one that has no session (`pi --mode rpc --no-session`)
// when it starts, keeps the answer ten minutes, and asks again in the background once
// it is older. When that Pi cannot start or does not answer, nothing is kept: the models
// fail with its sentence, `/compact` is the only command, and the next call asks again.
//
// Sessions started with `pi` in a terminal are offered to be taken up as threads
// (`deskSessions`, `adopt`), read from Pi's session files (desk.ts). One is continued
// under its own id, which is what a thread's process opens anyway; copied by Pi itself
// into a new session (`pi --fork`); or only read. Pi does not say which session a
// terminal has open, so one is not continued while a Pi runs in a terminal in its folder.

export interface PiSettings {
  /** The installed `pi`. */
  path: string;
  /** A thread's process stops after this long with nothing running or waiting. */
  idleMinutes: number;
  /** At most this many thread processes run at once. */
  maxWarm: number;
  /** The model a new thread starts on ("provider/id"); null or left out: Pi's own default. */
  model?: string | null;
  /**
   * The model ("provider/id") a new thread is named with after its first message, in one
   * short request at no thinking, off the turn's path. Left out: the thread's own model.
   * null: no names are made, and a thread keeps the first line of its first message.
   */
  titleModel?: string | null;
  /** Where the short-lived Pi runs: the General folder. */
  folder: string;
  /** The `portals` command, given to every thread's process. */
  portals?: CommandAccess;
}

export interface PiProviderOptions {
  settings: PiSettings;
  /** The bridge's environment, which Pi's processes start with (tests give another). */
  env?: NodeJS.ProcessEnv;
  /** Skips the version check (tests). */
  checkVersion?: boolean;
  /** The clock, in milliseconds. */
  now?: () => number;
  /** How long a turn may take to end after Stop before its process is stopped; 15 s unless a test says otherwise. */
  interruptGraceMs?: number;
  /** How long Pi has to answer a command; 30 s unless a test says otherwise. */
  callTimeoutMs?: number;
  /** The Pis that run in a terminal now, by folder; asks the Mac unless a test says otherwise. */
  terminals?: () => Promise<TerminalPis>;
}

interface Catalog {
  models: ModelCatalog;
  commands: AgentCommand[];
  /** When it was asked for. */
  at: number;
}

/** How old what the short-lived Pi said can be before it is asked again. */
const catalogMaxAgeMs = 10 * 60_000;
/** How long an old answer is used on after asking again has failed, before the next try. */
const catalogRetryMs = 60_000;
/** How long a thread's name may take to come. */
const namingMs = 60_000;

/** How long a list of the folders a Pi runs in a terminal in is used for `desk.list`. */
const terminalsMaxAgeMs = 2000;
/** How long one look through Pi's session folders serves `desk.list`, which asks about one removed thread after another. */
const sweepMaxAgeMs = 2000;

/** The bridge's own command for a Pi thread, carried out with Pi's `compact`. */
const compact: AgentCommand = { name: "compact", description: "Summarise the conversation so far, to free up context", usage: "[what to keep]", skill: false };

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pi's models as the app lists them: grouped by Pi's provider, the default's provider
 * first, so that an id two providers list (one paid by the token, one a plan) is taken
 * from the default's when a thread names none. The default is the model `preferred`
 * names ("provider/id", `pi.model` in config.json) when Pi lists it, else Pi's own.
 */
export function piCatalog(state: PiState, available: PiModel[], preferred?: string | null): ModelCatalog {
  // A model id with a space in it cannot be named in a model change.
  const usable = (model: PiModel | undefined): model is PiModel & { id: string; provider: string } =>
    typeof model?.id === "string" && model.id !== "" && !/\s/.test(model.id) && typeof model.provider === "string" && model.provider !== "";
  const models = available.filter(usable);
  const fallback = (preferred ? models.find((model) => `${model.provider}/${model.id}` === preferred) : undefined) ?? state.model;
  if (usable(fallback) && !models.some((model) => model.id === fallback.id && model.provider === fallback.provider)) models.unshift(fallback);
  const slugs = [...new Set(models.map((model) => model.provider))];
  if (usable(fallback)) slugs.sort((a, b) => Number(b === fallback.provider) - Number(a === fallback.provider));
  // The model a new thread starts on: the one named or Pi's own, else the first listed.
  const chosen = usable(fallback) ? fallback : models[0];
  // Pi's own level, as that model takes it: one that `preferred` names, or the first
  // listed, may not have the level Pi is on, and Pi would move it at the first message.
  const own = appLevel(state.thinkingLevel);
  const taken = chosen ? piLevel(own, modelLevels(chosen)) : null;
  const catalog: ModelCatalog = {
    providers: slugs.map((slug) => ({ slug, name: slug, models: models.filter((model) => model.provider === slug).map((model) => model.id) })),
    model: chosen?.id ?? "",
    provider: chosen?.provider ?? "",
    reasoning: taken === null ? own : appLevel(taken),
    levels: {},
    names: {},
  };
  // By id: two providers that list one id list the same model.
  for (const model of models) {
    catalog.levels![model.id] ??= modelLevels(model);
    if (typeof model.name === "string" && model.name !== "") catalog.names![model.id] ??= model.name;
  }
  return catalog;
}

/**
 * Pi's own commands as the app offers them: an extension's as Pi's own, a prompt
 * template or a skill as a skill. Left out: a name the app cannot send (it sends names
 * in lower case, and reads a name up to the first space or second slash), one listed
 * twice, and one called `compact`, which is the bridge's.
 */
export function piCommands(listed: PiCommandInfo[]): AgentCommand[] {
  const seen = new Set([compact.name]);
  return listed.flatMap((command): AgentCommand[] => {
    const name = typeof command?.name === "string" ? command.name : "";
    if (name === "" || name !== name.toLowerCase() || /[\s/]/.test(name) || seen.has(name)) return [];
    seen.add(name);
    return [{ name, description: typeof command.description === "string" ? command.description : "", usage: "", skill: command.source !== "extension" }];
  });
}

export class PiProvider implements Provider, PiHost {
  readonly piPath: string;
  readonly instructions: string | null;
  readonly pool: WarmPool;
  readonly interruptGraceMs: number;
  readonly callTimeoutMs: number;
  private readonly settings: PiSettings;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly checking: boolean;
  /** Which Pi is installed, as `pi --version` said at the bridge's start, and again while it was too old. */
  readonly version: VersionCheck;
  /** The last check of the installed version: why no turn can run on it, or null. */
  private checked: Promise<string | null> = Promise.resolve(null);
  private readonly sessions = new Set<PiSession>();
  /** The session file each thread's process named, by thread. */
  private readonly files = new Map<string, string>();
  /** Where unloaded threads' session files are, for search; made at the first search. */
  private searchPaths: RememberedFiles | null = null;
  private catalog: Catalog | null = null;
  private loading: Promise<Catalog> | null = null;
  /** The short-lived Pis at work now (one asked for the models, one copying a session), each until it is gone. */
  private readonly errands = new Set<{ client: PiClient; gone: PromiseWithResolvers<void> }>();
  /** The one-shot Pis making a thread's name now (`name`), stopped when the provider closes. */
  private readonly namers = new Set<ChildProcess>();
  /** Pi's session files, for the sessions from the desk. */
  private readonly stored: PiSessionFiles;
  private readonly askTerminals: () => Promise<TerminalPis>;
  /** The Pis that ran in a terminal when last asked, and when that was. */
  private terminals: { pis: TerminalPis; at: number } | null = null;

  constructor(options: PiProviderOptions) {
    this.settings = options.settings;
    this.piPath = options.settings.path;
    this.instructions = options.settings.portals?.instructions ?? null;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.checking = options.checkVersion ?? true;
    this.version = new VersionCheck({ name: "Pi", tested: testedPiVersions, minimum: minimumPiVersion, update: "pi update", path: this.piPath, setting: "pi.path" });
    this.pool = new WarmPool({ maxWarm: options.settings.maxWarm, idleMs: options.settings.idleMinutes * 60_000, now: options.now });
    this.interruptGraceMs = options.interruptGraceMs ?? 15_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
    this.stored = new PiSessionFiles(this.env, this.now);
    this.askTerminals = options.terminals ?? terminalPisNow;
  }

  get profile(): AgentProfile {
    return {
      name: "pi",
      kind: "pi",
      displayName: "Pi",
      description: `Pi on this ${machineWord()}, with your own settings, extensions and sign-ins. It does not ask before it acts.`,
      model: this.catalog?.models.model ?? "",
      provider: this.catalog?.models.provider ?? "",
    };
  }

  environment(thread: string | null): NodeJS.ProcessEnv {
    return piEnvironment(this.env, this.piPath, this.settings.portals, thread);
  }

  /** Starts the idle sweep, checks the installed version and learns the models and commands. */
  start(): void {
    this.pool.start();
    if (this.checking) this.checked = this.checkVersion();
    void this.catalogReady().catch(() => undefined);
  }

  /**
   * Logs which Pi is installed, and resolves with the sentence a turn fails with when it
   * is older than the minimum: such a Pi lacks records a turn ends by, so a turn on it
   * could run for ever. Null for any other, and for none (a turn then fails with its own
   * sentence, which names `pi.path`).
   */
  private async checkVersion(): Promise<string | null> {
    this.version.installedIs(await piVersion(this.piPath, this.environment(null)));
    return this.version.refusal();
  }

  /** Why no turn can run on the installed Pi; null when one can. Checked again while it is too old, so an update is seen without a restart. */
  async refusal(): Promise<string | null> {
    if ((await this.checked) !== null) this.checked = this.checkVersion();
    return this.checked;
  }

  // MARK: Models and commands

  /** What the short-lived Pi said, asked for when there is nothing yet, and again in the background once it is old. */
  private catalogReady(): Promise<Catalog> {
    const known = this.catalog;
    if (known && this.now() - known.at <= catalogMaxAgeMs) return Promise.resolve(known);
    if (!this.loading) {
      this.loading = this.ask().finally(() => {
        this.loading = null;
      });
      // Nobody waits for this one: what is known is used meanwhile, and on for a while if it fails.
      if (known) {
        this.loading.catch((error: Error) => {
          log.warn("could not ask Pi for its models and commands again", { error: error.message });
          known.at = this.now() - catalogMaxAgeMs + catalogRetryMs;
        });
      }
    }
    // An old list beats none while a new one is asked for.
    return known ? Promise.resolve(known) : this.loading;
  }

  /** Starts a Pi with no session, asks what it runs on, which models it has and which commands, and stops it. */
  private ask(): Promise<Catalog> {
    const at = this.now();
    return this.shortLived(catalogArguments, isDirectory(this.settings.folder) ? this.settings.folder : homedir(), async (client) => {
      const state = (await client.call<PiState>({ type: "get_state" })) ?? {};
      const available = (await client.call<{ models?: PiModel[] }>({ type: "get_available_models" }))?.models;
      const listed = (await client.call<{ commands?: PiCommandInfo[] }>({ type: "get_commands" }))?.commands;
      const wanted = this.settings.model ?? null;
      const models = piCatalog(state, Array.isArray(available) ? available : [], wanted);
      if (models.model === "") throw new Error("Pi has no model it can run. Sign in at the desk first (`pi`, then /login).");
      const before = this.catalog?.models;
      if (before?.model !== models.model || before.provider !== models.provider || before.reasoning !== models.reasoning) {
        const starts = { provider: models.provider, model: models.model, level: models.reasoning };
        if (wanted !== null && `${models.provider}/${models.model}` === wanted) {
          log.info("the model a new Pi thread starts on, as pi.model in config.json names it", starts);
        } else {
          // Which model that is depends on the keys the bridge's environment has.
          if (wanted !== null) log.warn(`pi.model in config.json names ${wanted}, which Pi does not list, so a new Pi thread starts on Pi's own default`, starts);
          else log.info("Pi's own default, which a new Pi thread runs on unless it names a model", starts);
        }
      }
      this.catalog = { models, commands: piCommands(Array.isArray(listed) ? listed : []), at };
      return this.catalog;
    });
  }

  /**
   * A Pi started for one errand and stopped after it: `work` asks it what it is there
   * for. Nobody is there to answer what an extension asks as it starts, so its dialogs
   * are cancelled. Fails with how the process ended, when it ended instead of answering,
   * else with what `work` failed with. `work`'s answer waits for the process to be gone
   * only when `untilGone` says so; closing the provider always does.
   */
  private async shortLived<T>(args: string[], cwd: string, work: (client: PiClient) => Promise<T>, untilGone = false): Promise<T> {
    let ended: ChildExit | null = null;
    const client = new PiClient({
      command: this.piPath,
      args,
      env: this.environment(null),
      cwd,
      timeoutMs: this.callTimeoutMs,
      listener: {
        event: () => undefined,
        dialog: (request) => client.answer(cancelled(request.id!)),
        exited: (exit) => {
          ended = exit;
        },
      },
    });
    const errand = { client, gone: Promise.withResolvers<void>() };
    this.errands.add(errand);
    try {
      return await work(client);
    } catch (error) {
      // How it ended is the reason, when it ended instead of answering. A call fails a
      // moment before the end is told when there was no process to write to.
      if (error instanceof PiGone) await client.stop();
      const exit = ended as ChildExit | null;
      if (exit && exit.error !== null) throw new Error(`Pi could not be started at ${this.piPath} (${exit.error}). Check pi.path in config.json.`);
      throw new Error(exit ? exit.reason : (error as Error).message);
    } finally {
      const gone = client.stop().then(() => {
        this.errands.delete(errand);
        errand.gone.resolve();
      });
      if (untilGone) await gone;
    }
  }

  async models(): Promise<ModelCatalog> {
    try {
      return structuredClone((await this.catalogReady()).models);
    } catch (error) {
      throw new Error(`Pi did not say which models it has: ${(error as Error).message}`);
    }
  }

  /** `/compact`, and Pi's own: its extensions' commands, its prompt templates and its skills. */
  async commands(): Promise<AgentCommand[]> {
    try {
      return [compact, ...(await this.catalogReady()).commands];
    } catch {
      return [compact];
    }
  }

  // MARK: Sessions from the desk

  /**
   * The Pis that run in a terminal now, by folder; the last answer when it is younger
   * than `maxAgeMs`. Throws when the Mac cannot be asked.
   */
  private async terminalPis(maxAgeMs: number): Promise<TerminalPis> {
    if (this.terminals && this.now() - this.terminals.at < maxAgeMs) return this.terminals.pis;
    const pis = await this.askTerminals();
    this.terminals = { pis, at: this.now() };
    return pis;
  }

  /**
   * Whether a Pi runs in a terminal in this folder now, for a session from the desk
   * before one of its turns. When the Mac cannot be asked, it fails with a sentence:
   * the turn is not written on a guess. A Pi whose folder the Mac would not say (one
   * run with `sudo`), beside others it did place, is in none here: it was a reason not
   * to take the session up. When it places none of them, the Mac counts as not asked
   * (`terminalPisNow`), and such a Pi alone stops these turns for as long as it runs.
   */
  async inTerminal(cwd: string): Promise<boolean> {
    try {
      return (await this.terminalPis(0)).folders.includes(await realFolder(cwd));
    } catch (error) {
      log.warn("could not ask the Mac whether Pi runs in a terminal", { error: (error as Error).message });
      throw new Error(`Portals could not check whether Pi is running in a terminal on the ${machineWord()} (${(error as Error).message}), so nothing was sent to this session. Send the message again.`);
    }
  }

  /** Pi's sessions, newest first, each `open` while a Pi runs in a terminal in its folder. The bridge's own threads are among them: the bridge leaves those out. */
  async deskSessions(wanted: number): Promise<DeskSession[]> {
    // The files of the threads loaded here need not be read to be left out.
    const own = new Set([...this.sessions].flatMap((session) => this.files.get(session.id) ?? []));
    const [stored, terminals] = await Promise.all([
      this.stored.newest(wanted, own),
      this.terminalPis(terminalsMaxAgeMs).then(
        (pis) => pis.folders,
        (error: Error) => {
          log.warn("could not ask the Mac whether Pi runs in a terminal", { error: error.message });
          return [] as string[];
        },
      ),
    ]);
    // Each folder's real path once, and none when no Pi is in any terminal.
    const real = new Map<string, Promise<string>>();
    const taken = async (cwd: string) => terminals.length > 0 && terminals.includes(await (real.get(cwd) ?? real.set(cwd, realFolder(cwd)).get(cwd)!));
    return Promise.all(
      stored.map(async (session): Promise<DeskSession> => ({ id: session.id, title: session.title, cwd: session.cwd, updated: session.updated, state: (await taken(session.cwd)) ? "open" : "closed" })),
    );
  }

  /** As `adopt` finds it: the session's file is still there (a session is deleted at the desk by deleting its file). Asked for a listing, of one removed thread after another. */
  async keeps(id: string): Promise<boolean> {
    return (await this.stored.find(id, sweepMaxAgeMs)) !== null;
  }

  async adopt(id: string, mode: AdoptMode): Promise<DeskAdoption> {
    const session = await this.stored.find(id);
    if (!session) throw new DeskRefused(`Pi has no session by that id on this ${machineWord()}.`);
    // A session with nothing to call it by is a thread with no title yet: its next message gives it one.
    const adoption = { cwd: session.cwd, title: session.title || null, settings: await this.settingsOf(session) };
    switch (mode) {
      case "continue": {
        if (!isDirectory(session.cwd)) throw new DeskRefused(`The session's folder, ${session.cwd}, is no longer there.`);
        const folder = await realFolder(session.cwd);
        // Pi names a session's folder after the real path its process runs in. Where the
        // session's folder has since become a link to another, Pi started there would not
        // find the session, and would begin an empty one under the same id.
        if (folder !== session.cwd) throw new DeskRefused(`This session's folder, ${session.cwd}, now leads to ${folder}, where Pi would not find the session. Fork it instead.`);
        // A copy the bridge made, taken off the list and now taken back, is its own still: not asked about.
        if (!isForkId(id)) await this.notInTerminal(folder);
        this.files.set(id, session.path);
        return { id, ...adoption };
      }
      case "fork": {
        const fork = forkId(randomUUID());
        const made = await this.copy(session, fork);
        this.files.set(fork, made.file);
        // The Pi that made the copy has said what the copy comes back on.
        const settings = await this.settingsOfCopy(adoption.settings, made);
        return { id: fork, ...adoption, settings, title: adoption.title && `${adoption.title} (fork)` };
      }
      case "read":
        this.files.set(id, session.path);
        return { id, ...adoption };
    }
  }

  /** Refuses a session to be continued while a Pi runs in a terminal in its folder (a real path), or may. */
  private async notInTerminal(folder: string): Promise<void> {
    let terminals: TerminalPis;
    try {
      terminals = await this.terminalPis(0);
    } catch (error) {
      throw new DeskRefused(`Portals could not check whether Pi is running in a terminal on the ${machineWord()} (${(error as Error).message}). Fork the session instead.`);
    }
    if (terminals.folders.includes(folder)) throw new DeskRefused(terminalMayHaveIt);
    // One whose folder the Mac would not say may be in this one.
    if (terminals.unread.length > 0) throw new DeskRefused("Portals could not check whether Pi is running in a terminal in this session's folder (the Mac would not say where a Pi in a terminal runs). Fork the session instead.");
  }

  /**
   * What a copy's thread runs on: the model and the level the Pi that made it came back
   * on, unless that Pi fell back from the session's own model, which the thread then
   * keeps (`PiSession.comeBack` has why).
   */
  private async settingsOfCopy(fromFile: SessionSettings, made: { model: PiModel | null; level: string }): Promise<SessionSettings> {
    const model = made.model;
    if (typeof model?.id !== "string" || typeof model.provider !== "string") return fromFile;
    if (fromFile.model !== "" && (await this.fellBack(fromFile.provider, fromFile.model, model))) return fromFile;
    return { model: model.id, provider: model.provider, reasoningEffort: appLevel(made.level) || fromFile.reasoningEffort };
  }

  /**
   * What a thread that takes a session up is said to run on, until Pi has opened the
   * session and says itself (`PiSession.comeBack`): the model and the level the file
   * last names. Where it names no model, Pi's own default; no level is the model's own.
   */
  private async settingsOf(session: StoredPiSession): Promise<SessionSettings> {
    if (session.model) return { model: session.model.id, provider: session.model.provider, reasoningEffort: session.level };
    const known = await this.catalogReady().catch(() => null);
    return { model: known?.models.model ?? "", provider: known?.models.provider ?? "", reasoningEffort: session.level };
  }

  /**
   * Has Pi copy a session into a new one under `id`, in the same folder, and returns the
   * copy's file. A short-lived Pi does it as it starts (`--fork`), reading the original
   * as `pi --fork` at the desk would, so a terminal that has it open loses nothing.
   */
  private async copy(session: StoredPiSession, id: string): Promise<{ file: string; model: PiModel | null; level: string }> {
    const refusal = await this.refusal();
    if (refusal !== null) throw new DeskRefused(refusal);
    // Pi makes the copy for the folder it is started in.
    if (!isDirectory(session.cwd)) throw new DeskRefused(`The session's folder, ${session.cwd}, is no longer there.`);
    const made = async (client: PiClient) => {
      // Its answer says the copy is made, where, and what Pi came back on for it.
      const state = (await client.call<PiState>({ type: "get_state" })) ?? {};
      if (state.sessionId !== id || typeof state.sessionFile !== "string" || state.sessionFile === "") throw new Error("Pi started on another session than the copy.");
      return { file: state.sessionFile, model: state.model ?? null, level: state.thinkingLevel ?? "" };
    };
    try {
      // The thread's own process starts only once this one is gone: never two on one session file.
      return await this.shortLived(forkArguments(session.path, id), session.cwd, made, true);
    } catch (error) {
      // A copy Pi wrote before it failed stays where it is, a session of its own that the desk's list leaves out.
      throw new DeskRefused(`Pi could not copy the session: ${(error as Error).message}`);
    }
  }

  // MARK: Sessions

  async startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    return this.track(new PiSession(options, sink, this));
  }

  async resumeSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    // History is read from Pi's own session file; no process starts until a message is sent.
    const history = await this.history(options.id, options.cwd);
    // A thread with no title takes the name Pi has for its session.
    const title = options.title || history.title;
    if (title && !options.title) sink.emit({ type: "title", title });
    return this.track(new PiSession({ ...options, title }, sink, this, history.messages, history.read));
  }

  /** Pi's own session file (feature thread_search), remembered: a miss looks in every folder of Pi's sessions. */
  async searchFile(thread: { id: string; cwd: string }): Promise<SearchFile | null> {
    this.searchPaths ??= new RememberedFiles((id, cwd) => findSessionFile(id, cwd, this.env));
    const path = this.files.get(thread.id) ?? (await this.searchPaths.find(thread.id, thread.cwd));
    return path ? { path, format: "pi" } : null;
  }

  async history(thread: string, cwd: string, open = false): Promise<PiHistory> {
    const file = this.files.get(thread) ?? (await findSessionFile(thread, cwd, this.env));
    return readHistory(file, cwd, open);
  }

  private track(session: PiSession): PiSession {
    this.sessions.add(session);
    return session;
  }

  sessionFile(thread: string, path: string): void {
    this.files.set(thread, path);
  }

  async fellBack(provider: string, model: string, now: PiModel): Promise<boolean> {
    const known = (await this.catalogReady().catch(() => null))?.models;
    if (!known) return false;
    const listed = known.providers.some((entry) => entry.slug === provider && entry.models.includes(model));
    return !listed && now.id === known.model && now.provider === known.provider;
  }

  // MARK: Names

  /**
   * A name for a thread whose first message is `message`, made the way Codex threads are
   * named (../codex/naming.ts): one `pi --print` with the title prompt and nothing else of
   * the user's Pi but its sign-ins (`titleArguments`), on `pi.titleModel` or else the
   * thread's own model. Null when names are turned off, when there is nothing to name it
   * by, or when Pi gives none within a minute; a failure is logged and gives null too.
   */
  async name(message: string, settings: SessionSettings): Promise<string | null> {
    const model = this.settings.titleModel === undefined ? (settings.provider ? `${settings.provider}/${settings.model}` : settings.model) : this.settings.titleModel;
    const said = titleSource(message);
    if (!model || said === "") return null;
    const args = titleArguments(model, titleInstructions, titlePrompt(said));
    // It speaks for no thread, whatever the bridge was started from.
    const env = this.environment(null);
    delete env.PORTALS_THREAD;
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const child = execFile(this.piPath, args, { cwd: tmpdir(), env, timeout: namingMs, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
          this.namers.delete(child);
          if (error) reject(new Error(stderr.trim().split("\n").at(-1) || error.message));
          else resolve(stdout);
        });
        child.stdin?.end();
        this.namers.add(child);
      });
      return nameFromText(answer);
    } catch (error) {
      // Said, so that names that stop coming (a model gone from Pi's list, say) are seen.
      log.warn("Pi did not make a thread's name", { model, error: (error as Error).message });
      return null;
    }
  }

  forget(session: PiSession): void {
    this.sessions.delete(session);
  }

  async close(): Promise<void> {
    this.pool.stop();
    for (const namer of this.namers) namer.kill();
    this.namers.clear();
    // One on an errand is stopped, which ends the errand.
    const errands = [...this.errands].map((errand) => {
      void errand.client.stop();
      return errand.gone.promise;
    });
    await Promise.all([...errands, ...[...this.sessions].map((session) => session.close())]);
    this.sessions.clear();
  }
}
