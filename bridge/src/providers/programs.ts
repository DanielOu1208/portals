import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { expandHome, type Config, type Paths } from "../config.ts";
import { log } from "../log.ts";
import { programFolders } from "../platform.ts";
import { droidProgram, piFolders } from "../setup/agents.ts";
import { isExecutable } from "../setup/system.ts";
import { endGroup } from "./child.ts";
import { claudeVersion, testedClaudeVersion } from "./claude/options.ts";
import { codexVersion, testedCodexVersion } from "./codex/options.ts";
import { cursorProgram, cursorVersion, testedCursorVersion } from "./cursor/options.ts";
import { testedDroidVersions } from "./droid/provider.ts";
import { droidEnvironment } from "./droid/sdk.ts";
import { testedHermesVersion } from "./hermes/provider.ts";
import { findHermes, hermesVersion } from "./hermes/setup.ts";
import { minimumOpenCodeVersion, opencodeProgram, testedOpenCodeVersion } from "./opencode/options.ts";
import { minimumPiVersion, piVersion, testedPiVersions } from "./pi/options.ts";
import { compareVersions, programVersion, versionStanding, type VersionCheck, type VersionStanding } from "./program.ts";
import { claudeChannel, LatestReleases, type LatestOptions, type LatestSource } from "./programLatest.ts";
import type { Provider } from "./types.ts";

// The programs of the agents on this host, for Settings > Agents (feature agent_programs,
// docs/gateway-protocol.md section 11): which are installed, their versions, how each was
// installed, and updating one with its own update command. Which command is the host's
// choice, from a fixed list, by where the program's files are: a device names a program,
// never a command. An installation the list does not know is told how to update, not
// updated. Nothing is stopped or restarted by this: a thread at work keeps the release it
// started on until its process next starts, and a service that stays up (Codex's daemon,
// OpenCode's server) until it restarts, which is never done here. Hermes alone restarts
// what runs on it, its gateway and so its bots, because its own update does.

export const programIDs = ["claude", "codex", "cursor", "droid", "pi", "opencode", "hermes"] as const;
export type ProgramID = (typeof programIDs)[number];

/** How long an update may take: past this it is ended, and has failed. */
const updateMs = 10 * 60_000;
/** Hermes's waits for its gateways' turns to end, and may back up and rebuild as well. */
const hermesUpdateMs = 30 * 60_000;

/** How long a version read stands for every device: a read starts a process per program. */
const versionStandsMs = 60_000;

/** What is told of a failed update: the end of what it printed. */
const tailLines = 12;
const tailBytes = 4096;

/** When threads at work move to a release the program was updated to. */
export type TakesEffect = "next_start" | "service_restart" | "gateway_restart";

/** How a program was installed: by its own installer, npm, Homebrew, inside an app, or some other way. */
export type InstallMethod = "own" | "npm" | "homebrew" | "app" | "other";

/** A program the host knows how to list. */
interface ProgramSpec {
  id: ProgramID;
  name: string;
  tested: string | readonly string[];
  minimum?: string;
  /** The installed program, as the host runs it; null when there is none. */
  find(config: Config, env: NodeJS.ProcessEnv, home: string): string | null;
  /** What `--version` says, in the environment that keeps the program from updating itself. */
  version(path: string, env: NodeJS.ProcessEnv): Promise<string | null>;
  /** The npm package it is published as, if any. */
  package?: string;
  /** Its own updater. `at`: the folders under the home folder its installer puts it in; absent, any installation (it decides for itself). */
  own?: { args: readonly string[]; at?: readonly string[] };
  /** What to run by hand, for an installation the host cannot update. */
  command: string;
  latest: LatestSource | null;
  takesEffect: TakesEffect;
  /** How long its update may take; `updateMs` otherwise. */
  updateMs?: number;
  /** Only looked for where the host runs it: running it at all is not free of effects. */
  onlyWhenOn?: boolean;
}

/** A program that is named by a bare name in config.json: on the PATH, then in the usual folders. */
function onPath(configured: string, env: NodeJS.ProcessEnv, folders: readonly string[]): string | null {
  const path = expandHome(configured);
  if (isAbsolute(path)) return isExecutable(path) ? path : null;
  return [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...folders].map((folder) => join(folder, path)).find((candidate) => isExecutable(candidate)) ?? null;
}

function npm(name: string, tag = "latest"): LatestSource {
  return { kind: "npm", package: name, tag: () => tag };
}

const specs: readonly ProgramSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    tested: testedClaudeVersion,
    find: (config, env, home) => onPath(config.claude.path, env, programFolders(undefined, home)),
    version: claudeVersion,
    package: "@anthropic-ai/claude-code",
    // `~/.claude/local` is its older installer's, which `claude update` updates as well.
    own: { args: ["update"], at: [".local/share/claude/versions", ".claude/local"] },
    command: "claude update",
    latest: { kind: "npm", package: "@anthropic-ai/claude-code", tag: (env) => claudeChannel(env, env.HOME || homedir()) },
    takesEffect: "next_start",
  },
  {
    id: "codex",
    name: "Codex",
    tested: testedCodexVersion,
    find: (config, env, home) => onPath(config.codex.path, env, programFolders(undefined, home)),
    version: codexVersion,
    package: "@openai/codex",
    // None of its own here: `codex update` may replace its daemon, which is not this host's to restart.
    command: "codex update",
    latest: npm("@openai/codex"),
    takesEffect: "service_restart",
  },
  {
    id: "cursor",
    name: "Cursor",
    tested: testedCursorVersion,
    find: (config) => cursorProgram(config.cursor.path),
    version: cursorVersion,
    own: { args: ["update"], at: [".local/share/cursor-agent/versions"] },
    command: "cursor-agent update",
    // Its install script names the release it installs, as `https://downloads.cursor.com/lab/2026.11.05-86047df/…`.
    latest: { kind: "page", url: "https://cursor.com/install", pattern: /downloads\.cursor\.com\/lab\/(\d+\.\d+\.\d+)/ },
    takesEffect: "next_start",
  },
  {
    id: "droid",
    name: "Droid",
    tested: testedDroidVersions,
    find: (config, env) => droidProgram(config.droid.path, env),
    version: (path, env) => programVersion(path, droidEnvironment(env)),
    package: "@factory/cli",
    own: { args: ["update"], at: [".local/bin"] },
    command: "droid update",
    latest: npm("@factory/cli"),
    takesEffect: "next_start",
  },
  {
    id: "pi",
    name: "Pi",
    tested: testedPiVersions,
    minimum: minimumPiVersion,
    find: (config, env) => onPath(config.pi.path, env, piFolders()),
    version: piVersion,
    package: "@earendil-works/pi-coding-agent",
    command: "pi update",
    latest: npm("@earendil-works/pi-coding-agent"),
    takesEffect: "next_start",
  },
  {
    id: "opencode",
    name: "OpenCode",
    tested: testedOpenCodeVersion,
    minimum: minimumOpenCodeVersion,
    find: (config, env) => opencodeProgram(config.opencode.path, env),
    version: (path, env) => programVersion(path, { ...env, OPENCODE_DISABLE_AUTOUPDATE: "1" }),
    package: "@opencode/cli",
    own: { args: ["upgrade"], at: [".opencode/bin"] },
    command: "opencode upgrade",
    latest: npm("@opencode/cli"),
    takesEffect: "service_restart",
  },
  {
    id: "hermes",
    name: "Hermes",
    tested: testedHermesVersion,
    find: (config, env, home) => findHermes(config.hermes.path, env, join(home, ".local", "bin", "hermes")),
    version: hermesVersion,
    // `hermes update` restarts every gateway it finds on the new code, by launchd, systemd or
    // as started by hand, and refuses an installation it does not own (Docker, Nix, its desktop
    // app) with what to run instead. `--yes`: nobody is at a terminal to answer its prompts.
    own: { args: ["update", "--yes"] },
    command: "hermes update",
    latest: { kind: "github", repository: "NousResearch/hermes-agent" },
    takesEffect: "gateway_restart",
    updateMs: hermesUpdateMs,
    onlyWhenOn: true,
  },
];

/** How to update a program as it is installed. */
export interface Installation {
  method: InstallMethod;
  /** What the host runs to update it; absent where it cannot. */
  run?: { program: string; args: readonly string[]; folders: readonly string[] };
  /** The command as a person would run it. Absent for one that updates with its app. */
  command?: string;
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function escapedForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * How the program at `path` was installed, and so how to update it, from where its files
 * are. Assumes nothing of the machine: a global npm package of its own name under a prefix
 * this host can write to, or the folders its own installer uses; anything else names what to run.
 */
export function installationOf(spec: Pick<ProgramSpec, "package" | "own" | "command">, path: string, home: string): Installation {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // Named as it is.
  }
  if (spec.package) {
    const latest = `${spec.package}@latest`;
    const inside = escapedForPattern(spec.package);
    const global = new RegExp(`^(.*)/lib/node_modules/${inside}/`).exec(real);
    if (global) {
      const prefix = global[1];
      const command = `npm install -g ${latest}`;
      if (!writable(join(prefix, "lib", "node_modules"))) return { method: "npm", command };
      const own = join(prefix, "bin", "npm");
      // The npm of the same prefix, so an nvm's Node goes on holding it, and `--prefix`, so nothing in the environment moves it.
      return { method: "npm", command, run: { program: isExecutable(own) ? own : "npm", args: ["install", "-g", "--prefix", prefix, latest], folders: [join(prefix, "bin")] } };
    }
    if (new RegExp(`/\\.bun/install/global/node_modules/${inside}/`).test(real)) return { method: "other", command: `bun add -g ${latest}` };
    if (new RegExp(`/pnpm/.*/${inside}/`).test(real)) return { method: "other", command: `pnpm add -g ${latest}` };
  }
  const cask = /\/Caskroom\/([^/]+)\//.exec(real);
  if (cask) return { method: "homebrew", command: `brew upgrade --cask ${cask[1]}` };
  const formula = /\/Cellar\/([^/]+)\//.exec(real);
  if (formula) return { method: "homebrew", command: `brew upgrade ${formula[1]}` };
  // The droid inside the Factory app, which updates with the app.
  if (real.includes(".app/Contents/")) return { method: "app" };
  if (spec.own && (!spec.own.at || spec.own.at.some((folder) => real.startsWith(`${join(home, folder)}/`)))) {
    return { method: "own", command: spec.command, run: { program: path, args: spec.own.args, folders: [dirname(path)] } };
  }
  return { method: "other", command: spec.command };
}

/** Where an update is or how it ended. */
export interface ProgramUpdate {
  state: "running" | "done" | "failed";
  /** Milliseconds since 1970. */
  startedAt: number;
  endedAt?: number;
  /** The version before it, and what it is now it has ended; null when it did not say. */
  from?: string | null;
  to?: string | null;
  timedOut?: boolean;
  /** While it runs, the last thing it printed. */
  line?: string;
  /** Of a failed one, the end of what it printed. */
  tail?: string;
}

/** One program as `programs.list` says it. */
export interface ProgramReport {
  id: ProgramID;
  name: string;
  installed: boolean;
  version: string | null;
  standing: VersionStanding;
  tested: string[];
  minimum?: string;
  how: InstallMethod | null;
  canUpdate: boolean;
  command?: string;
  latest?: string;
  updateAvailable?: boolean;
  /** The host's agents it runs. */
  agents: string[];
  takesEffect: TakesEffect;
  /** What a service that stays up runs, where that is not `version`. */
  runningVersion?: string;
  update?: ProgramUpdate;
}

/** A device's request that cannot be done. The message is for the user. */
export class ProgramRefused extends Error {}

export interface ProgramsOptions {
  config: Config;
  paths: Pick<Paths, "state" | "programs">;
  providers: Map<string, Provider>;
  /** The user's home folder (tests give another). */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** How long an update may take, in ms, instead of its own (tests). */
  updateMs?: number;
  /** For the latest releases: another clock or stand-in for the sources (tests). */
  latest?: Partial<Pick<LatestOptions, "fetch" | "now" | "everyMs" | "answerMs" | "check">>;
}

interface VersionRead {
  path: string | null;
  version: string | null;
  at: number;
}

/** Lines of what a command printed: colours out, and a line rewritten in place as its last state. */
export function plainLines(text: string): string[] {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split("\n")
    .map((line) => (line.split("\r").filter((part) => part.trim() !== "").at(-1) ?? "").trim())
    .filter((line) => line !== "");
}

/** The last `tailBytes` of a file; "" for one that cannot be read. */
function lastBytes(file: string): string {
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, tailBytes);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

export class AgentPrograms {
  private readonly options: ProgramsOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  readonly latest: LatestReleases;
  private readonly reads = new Map<ProgramID, VersionRead>();
  private readonly reading = new Map<ProgramID, Promise<VersionRead>>();
  private readonly updates = new Map<ProgramID, ProgramUpdate>();
  /** Each update's log while it runs. */
  private readonly logs = new Map<ProgramID, string>();
  /** Each update under way ending (tests wait for it). */
  private readonly ending = new Map<ProgramID, Promise<void>>();

  constructor(options: ProgramsOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
    this.latest = new LatestReleases({ file: options.paths.programs, check: options.config.updates.check, env: this.env, ...options.latest });
  }

  /** Every program that is installed or has an agent here, the slower reads shared by every device that asks meanwhile. */
  async list(): Promise<ProgramReport[]> {
    const reports = await Promise.all(specs.map((spec) => this.report(spec)));
    const listed = reports.filter((report): report is ProgramReport => report !== null);
    const sources = new Map<string, LatestSource>();
    for (const report of listed) {
      const spec = specs.find(({ id }) => id === report.id)!;
      if (report.installed && spec.latest) sources.set(spec.id, spec.latest);
    }
    this.latest.askIfDue(sources);
    return listed;
  }

  /**
   * Starts updating `id` with its own command, and answers at once with where that stands:
   * `programs.list` says the rest. Asked again while one runs, it is the one running.
   */
  async update(id: string): Promise<ProgramReport> {
    const spec = specs.find((candidate) => candidate.id === id);
    if (!spec) throw new ProgramRefused(`Portals does not know a program called ${id}.`);
    if (spec.onlyWhenOn && this.agentsOf(spec.id).length === 0) throw new ProgramRefused(`This host does not run ${spec.name}.`);
    if (this.updates.get(spec.id)?.state !== "running") {
      const path = spec.find(this.options.config, this.env, this.home);
      if (!path) throw new ProgramRefused(`${spec.name} is not installed on this host.`);
      const installation = installationOf(spec, path, this.home);
      if (!installation.run) {
        throw new ProgramRefused(installation.command ? `Portals cannot update ${spec.name} here: to update it, run ${installation.command} on this host.` : `${spec.name} updates with the app it came in.`);
      }
      this.start(spec, path, installation.run);
    }
    return (await this.report(spec))!;
  }

  /** The update of `id` under way ending; at once when there is none (tests). */
  settled(id: ProgramID): Promise<void> {
    return this.ending.get(id) ?? Promise.resolve();
  }

  private start(spec: ProgramSpec, path: string, run: NonNullable<Installation["run"]>): void {
    const update: ProgramUpdate = { state: "running", startedAt: Date.now() };
    this.updates.set(spec.id, update);
    this.ending.set(spec.id, this.runUpdate(spec, path, run, update).catch((error: Error) => {
      // Never left running: a device would wait on it until the host restarted.
      log.error("an update ended strangely", { program: spec.id, error: error.message });
      update.state = "failed";
      update.endedAt = Date.now();
      update.tail = error.message;
    }));
  }

  private async runUpdate(spec: ProgramSpec, path: string, run: NonNullable<Installation["run"]>, update: ProgramUpdate): Promise<void> {
    update.from = await spec.version(path, this.env);
    const folder = join(this.options.paths.state, "program-updates");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${spec.id}.log`);
    this.logs.set(spec.id, file);
    // Into a file, not a pipe: what it restarts may keep what it was given to print to, and
    // would die writing to a pipe nobody reads any more (Hermes's gateways, started by hand).
    const output = openSync(file, "w");
    log.info(`updating ${spec.name}`, { command: [run.program, ...run.args].join(" ") });
    let failure: string | null = null;
    let timedOut = false;
    try {
      const exit = await new Promise<number | null>((resolve) => {
        // In its home folder, away from any project's npm settings; a group of its own, so
        // that a timeout ends what it started too, and it goes on to its end should the host stop.
        const child = spawn(run.program, [...run.args], {
          cwd: this.home,
          env: { ...this.env, PATH: [...run.folders, this.env.PATH].filter(Boolean).join(delimiter), NO_COLOR: "1", TERM: "dumb" },
          stdio: ["ignore", output, output],
          detached: true,
        });
        child.unref();
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid !== undefined) void endGroup(child.pid);
        }, this.options.updateMs ?? spec.updateMs ?? updateMs);
        timer.unref();
        child.once("error", (error) => {
          clearTimeout(timer);
          failure = `Could not run ${run.program}: ${error.message}`;
          resolve(null);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      const done = exit === 0 && !timedOut && failure === null;
      const lines = plainLines(lastBytes(file));
      const to = await this.readAgain(spec);
      update.to = to;
      update.endedAt = Date.now();
      if (!done) {
        const said = lines.slice(-tailLines).join("\n");
        update.tail = failure ?? (said !== "" ? said : `It ended with code ${exit ?? "none"} and said nothing.`);
        update.timedOut = timedOut || undefined;
      }
      update.state = done ? "done" : "failed";
      log.info(done ? `updated ${spec.name}` : `could not update ${spec.name}`, { from: update.from, to, timedOut: timedOut || undefined, code: exit });
    } finally {
      closeSync(output);
      this.logs.delete(spec.id);
    }
  }

  /** The version after an update, which the provider's own check takes too, so `/status` and a thread's refusal go by it at once. */
  private async readAgain(spec: ProgramSpec): Promise<string | null> {
    // A read begun before the update ended says what was there then.
    this.reading.delete(spec.id);
    const read = await this.readNow(spec);
    const { version } = read;
    this.reads.set(spec.id, read);
    for (const check of this.checksOf(spec.id)) check.updated(version, spec.takesEffect === "service_restart");
    return version;
  }

  /** The providers' version checks: Hermes's bots share one. */
  private checksOf(id: ProgramID): Set<VersionCheck> {
    return new Set(this.providersOf(id).map((provider) => provider.version).filter((check): check is VersionCheck => check !== undefined));
  }

  private providersOf(id: ProgramID): Provider[] {
    return [...this.options.providers.values()].filter((provider) => provider.profile.kind === id);
  }

  private agentsOf(id: ProgramID): string[] {
    return [...this.options.providers.entries()].filter(([, provider]) => provider.profile.kind === id).map(([name]) => name);
  }

  /** `--version` as of the last minute: not again meanwhile, and not during an update, whose program may be half there. */
  private read(spec: ProgramSpec): Promise<VersionRead> {
    const kept = this.reads.get(spec.id);
    if (kept && (Date.now() - kept.at < versionStandsMs || this.updates.get(spec.id)?.state === "running")) return Promise.resolve(kept);
    const asking = this.reading.get(spec.id);
    if (asking) return asking;
    const reading: Promise<VersionRead> = this.readNow(spec).then((read) => {
      // Not an answer that an update has overtaken (`readAgain`).
      if (this.reading.get(spec.id) !== reading) return this.reads.get(spec.id) ?? read;
      this.reading.delete(spec.id);
      this.reads.set(spec.id, read);
      // A program updated by itself or by hand: `/status` and a thread's refusal go by it too.
      if (read.path) for (const check of this.checksOf(spec.id)) check.installedIs(read.version);
      return read;
    });
    this.reading.set(spec.id, reading);
    return reading;
  }

  private async readNow(spec: ProgramSpec): Promise<VersionRead> {
    const path = spec.find(this.options.config, this.env, this.home);
    return { path, version: path ? await spec.version(path, this.env) : null, at: Date.now() };
  }

  private async report(spec: ProgramSpec): Promise<ProgramReport | null> {
    const agents = this.agentsOf(spec.id);
    if (spec.onlyWhenOn && agents.length === 0) return null;
    const { path, version } = await this.read(spec);
    if (!path && agents.length === 0) return null;
    const installation = path ? installationOf(spec, path, this.home) : null;
    const update = this.updateNow(spec.id);
    // A release from where its updater looks; none for an installation that follows another
    // (Homebrew may be behind npm), or a build past its release, which says nothing of what is next.
    const latest = installation?.run ? this.latest.version(spec.id) : undefined;
    const order = latest !== undefined && version !== null ? compareVersions(latest, version) : Number.NaN;
    const pastRelease = version?.includes("+") === true && order <= 0;
    const tested = typeof spec.tested === "string" ? [spec.tested] : [...spec.tested];
    const running = this.providersOf(spec.id)[0]?.version?.current();
    return {
      id: spec.id,
      name: spec.name,
      installed: path !== null,
      version,
      standing: versionStanding({ tested, minimum: spec.minimum }, version),
      tested,
      ...(spec.minimum ? { minimum: spec.minimum } : {}),
      how: installation?.method ?? null,
      canUpdate: installation?.run !== undefined,
      ...(installation?.command ? { command: installation.command } : {}),
      ...(latest !== undefined ? { latest } : {}),
      ...(!Number.isNaN(order) && !pastRelease ? { updateAvailable: order > 0 } : {}),
      agents,
      takesEffect: spec.takesEffect,
      ...(spec.takesEffect === "service_restart" && running?.running && running.version !== null && running.version !== version ? { runningVersion: running.version } : {}),
      ...(update ? { update } : {}),
    };
  }

  /** The update of `id` as it stands, with what one running printed last. */
  private updateNow(id: ProgramID): ProgramUpdate | undefined {
    const update = this.updates.get(id);
    if (update?.state !== "running") return update;
    const file = this.logs.get(id);
    const line = file ? plainLines(lastBytes(file)).at(-1) : undefined;
    return { ...update, ...(line ? { line } : {}) };
  }
}
