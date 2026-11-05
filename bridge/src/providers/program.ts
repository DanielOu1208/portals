import { execFile } from "node:child_process";
import { log } from "../log.ts";
import { machineWord } from "../platform.ts";

// What an agent's program says its version is, and what the bridge makes of it. Each
// provider names the releases it was tested with, and a minimum only where an older
// release is known not to work (`VersionPolicy`): one older than that runs no turn,
// any other runs, with a warning for one not tested. The version is logged once a
// release and shown in `/status`, so it reaches the person using the thread.

/** Three numbers, as most programs print them: "codex-cli 0.160.1", "2.1.292 (Claude Code)". */
const threeNumbers = /(\d+\.\d+\.\d+)/;

/**
 * `<program> --version`, as the part of what it prints that `pattern` captures first:
 * "0.160.1". Null when the program cannot be run or prints something else.
 */
export function programVersion(path: string, env: NodeJS.ProcessEnv, pattern: RegExp = threeNumbers, timeoutMs = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { env, timeout: timeoutMs, killSignal: "SIGKILL" }, (error, stdout) => {
      resolve(error ? null : (pattern.exec(stdout)?.[1] ?? null));
    });
  });
}

/**
 * What the bridge holds an agent's program to: the releases it was tested with, and
 * the oldest it runs a turn on, where an older one is known not to work. A release
 * newer than the tested ones runs, with a warning, once; one older than the minimum runs
 * no turn.
 */
export interface VersionPolicy {
  /** What to call the program: "Claude Code". */
  name: string;
  /** The releases the bridge was tested with. */
  tested: string | readonly string[];
  /** The oldest release a turn runs on. Absent where no release is refused. */
  minimum?: string;
  /** What updates the program, named when it is too old: "pi update". */
  update?: string;
  /** Where the program was looked for, and the setting in config.json that says where. */
  path: string;
  setting: string;
}

/**
 * Where a release stands: one the bridge was tested with, one newer than all of them,
 * another (older, or between two tested ones), one older than the minimum, or none
 * that runs.
 */
export type VersionStanding = "tested" | "newer" | "untested" | "too old" | "missing";

/** The release of an agent's program the bridge knows of last, and where it stands. */
export interface AgentVersion {
  name: string;
  /** Null when the program was not found or did not run. */
  version: string | null;
  standing: VersionStanding;
  /** Said by a running process of the agent (its own report), not by `--version`. */
  running: boolean;
}

/** A release as three numbers and what follows them: "0.22.5+12.g1a2b3c" → [0, 22, 5] and "+12.g1a2b3c". */
function parts(version: string): { numbers: number[]; rest: string } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version.trim());
  return match ? { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], rest: match[4] } : null;
}

/**
 * Negative when release `a` came before `b`, positive when after, 0 for the same: by
 * their three numbers, then a build past a release (`+…`, as Hermes's own builds say
 * it) after the release, and a pre-release (`-…`) before it.
 */
export function compareVersions(a: string, b: string): number {
  const mine = parts(a);
  const theirs = parts(b);
  if (!mine || !theirs) return a === b ? 0 : NaN;
  for (let part = 0; part < 3; part++) {
    if (mine.numbers[part] !== theirs.numbers[part]) return mine.numbers[part] - theirs.numbers[part];
  }
  const rank = (rest: string) => (rest.startsWith("-") ? -1 : rest.startsWith("+") ? 1 : 0);
  return rank(mine.rest) - rank(theirs.rest);
}

/** Where release `version` stands against `policy`. */
export function versionStanding(policy: Pick<VersionPolicy, "tested" | "minimum">, version: string | null): VersionStanding {
  if (version === null) return "missing";
  const tested = typeof policy.tested === "string" ? [policy.tested] : policy.tested;
  if (policy.minimum !== undefined && compareVersions(version, policy.minimum) < 0) return "too old";
  if (tested.some((release) => compareVersions(version, release) === 0)) return "tested";
  return tested.every((release) => compareVersions(version, release) > 0) ? "newer" : "untested";
}

/**
 * One agent's version as the bridge learns it: from `--version` at start (and where the
 * provider asks again, as a process starts), and from what a running process says of
 * itself (Claude Code's `system/init`, Codex's `initialize`), which is the release a
 * thread runs on when the program was updated after it started. Each release is logged
 * once: an error for none or one too old, a warning for one newer than tested or
 * another, a line for a tested one. `/status` shows the last one known.
 */
export class VersionCheck {
  readonly policy: VersionPolicy;
  /** The releases logged already; null for none that runs. */
  private readonly said = new Set<string | null>();
  private installed: string | null | undefined;
  private running: string | undefined;
  /** When `--version` last said, in milliseconds since 1970; 0 before it has. */
  installedAt = 0;
  /** A read of `--version` under way, for whoever would otherwise start another. */
  reading: Promise<unknown> | undefined;

  constructor(policy: VersionPolicy) {
    this.policy = policy;
  }

  /** What `--version` gave: the release, or null when the program did not run. */
  installedIs(version: string | null): void {
    this.installed = version;
    this.installedAt = Date.now();
    this.report(version, false);
  }

  /** What a running process said its release is. Anything that is not a release is left out. */
  runningIs(version: unknown): void {
    if (typeof version !== "string" || !parts(version)) return;
    this.running = version;
    this.report(version, true);
  }

  /**
   * What `--version` gave after the program was updated. A process started from now on runs
   * that, so what an older one said is over, unless a service that stays up runs on it
   * (`keepsRunning`: Codex's daemon, OpenCode's server), whose threads stay on what it said.
   */
  updated(version: string | null, keepsRunning: boolean): void {
    if (!keepsRunning) this.running = undefined;
    this.installedIs(version);
  }

  /** The last release known: a running process's over `--version`. Null before either said. */
  current(): AgentVersion | null {
    const version = this.running ?? this.installed;
    if (version === undefined) return null;
    return { name: this.policy.name, version, standing: versionStanding(this.policy, version), running: this.running !== undefined };
  }

  /** The sentence a turn fails with when the release known is older than the minimum; null otherwise. */
  refusal(): string | null {
    const known = this.current();
    if (known?.standing !== "too old") return null;
    const { name, minimum, update } = this.policy;
    const how = update ? ` (${update})` : "";
    return `${name} ${known.version} is too old for the bridge, which needs ${minimum} or newer. Update it on the ${machineWord()}${how}, then send the message again.`;
  }

  /**
   * The line `/status` shows of the release last known: "Version: Claude Code 2.1.318",
   * and what is off about it. Null before it is known.
   */
  statusLine(): string | null {
    const known = this.current();
    if (!known) return null;
    const { path, setting, minimum, update } = this.policy;
    const tested = typeof this.policy.tested === "string" ? [this.policy.tested] : this.policy.tested;
    const newest = [...tested].sort(compareVersions).at(-1);
    const release = `${known.name} ${known.version}`;
    switch (known.standing) {
      case "missing":
        return `Version: ${known.name} was not found or did not run at ${path}. Set ${setting} in config.json.`;
      case "too old":
        return `Version: ${release}, older than ${minimum}, the oldest Portals runs. Update it${update ? ` (${update})` : ""}.`;
      case "newer":
        return `Version: ${release}, newer than the ${newest} Portals was tested with`;
      case "untested":
        return `Version: ${release}, not one Portals was tested with (the newest it was is ${newest})`;
      case "tested":
        return `Version: ${release}`;
    }
  }

  private report(version: string | null, running: boolean): void {
    if (this.said.has(version)) return;
    this.said.add(version);
    const { name, path, setting, minimum, update } = this.policy;
    const tested = typeof this.policy.tested === "string" ? [this.policy.tested] : this.policy.tested;
    const from = running ? { from: "its running process" } : undefined;
    switch (versionStanding(this.policy, version)) {
      case "missing":
        log.error(`${name} was not found or did not run at ${path}. Set ${setting} in config.json.`);
        break;
      case "too old":
        log.error(`${name} is ${version}, which is too old for this bridge: it needs ${minimum} or newer. No ${name} thread runs until it is updated${update ? ` (${update})` : ""}.`, from);
        break;
      case "newer":
        log.warn(`${name} is ${version}, newer than this bridge was tested with (${tested.join(", ")}). Check a thread before relying on it.`, from);
        break;
      case "untested":
        log.warn(`${name} is ${version}; this bridge was tested with ${tested.join(", ")}. Check a thread before relying on it.`, from);
        break;
      case "tested":
        log.info(`${name} ${version}`, from);
        break;
    }
  }
}

/** The release in Codex's `userAgent` ("portals-bridge/0.166.0 (Mac OS 27.0.0; arm64) …"); null when it names none. */
export function userAgentVersion(userAgent: unknown): string | null {
  return typeof userAgent === "string" ? (/\/(\d+\.\d+\.\d+)/.exec(userAgent)?.[1] ?? null) : null;
}
