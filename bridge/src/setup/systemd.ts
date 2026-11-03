import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { label as defaultLabel } from "./launchAgent.ts";
import type { Service, ServiceSpec, ServiceState } from "./service.ts";
import { programOverride, type RunResult, type System } from "./system.ts";

// The systemd user service that keeps the bridge running on Linux (service.ts): a unit in
// ~/.config/systemd/user that the person's own systemd manager (`systemctl --user`)
// starts at login, or at boot once lingering is on (`loginctl enable-linger`), and
// starts again two seconds after it stops. Its output is appended to the log setup names.
// Only the bridge's own process is stopped with it (`KillMode=process`): `hermes serve`
// and Codex's app-server daemon, which it starts in process groups of their own, outlive
// a restart as they do under launchd, and the bridge finds them again.

/**
 * Where the person's systemd user units go: ~/.config/systemd/user, where their manager
 * looks. Not the shell's `$XDG_CONFIG_HOME`: the manager seldom has the one a shell's
 * profile sets, and would not find the unit there.
 */
export function unitFolder(home = homedir()): string {
  return join(home, ".config", "systemd", "user");
}

/**
 * The unit of a label: `portals-host.service` for the usual one, `portals-host-dev.service`
 * for `com.danielou.portals.bridge.dev` (a bridge in another folder, setup/state.ts), and
 * any other label (`PORTALS_BRIDGE_LABEL`) as it is, with what a unit's name cannot hold
 * made dashes.
 */
export function unitName(label: string): string {
  const base = label === defaultLabel ? "portals-host" : label.startsWith(`${defaultLabel}.`) ? `portals-host-${label.slice(defaultLabel.length + 1)}` : label;
  return `${base.replace(/[^A-Za-z0-9:_.-]/g, "-")}.service`;
}

/**
 * The unit's text. Each value is escaped as systemd reads it: `%` for its specifiers.
 * The command starts with `:`, so systemd puts no variables in it: a `$` in node's path or
 * the bridge's is a `$` (systemd finds the program before it would undo a doubled one).
 */
export function unit(spec: ServiceSpec): string {
  const environment = { PATH: spec.path, ...spec.environment };
  return `# Written by \`portals-host setup\`, which writes it again each time it runs.
[Unit]
Description=Portals host, which runs your coding agents for the Portals apps

[Service]
Type=simple
ExecStart=:${quoted(spec.node)} ${quoted(spec.script)}
WorkingDirectory=${plain(spec.workingDirectory)}
${Object.entries(environment)
  .map(([key, value]) => `Environment=${quoted(`${key}=${value}`)}`)
  .join("\n")}
Restart=always
RestartSec=2
KillMode=process
TimeoutStopSec=20
StandardOutput=append:${plain(spec.log)}
StandardError=append:${plain(spec.log)}

[Install]
WantedBy=default.target
`;
}

/** A value on a line of its own: `%` doubled. A line break would end the line, so none is taken. */
function plain(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`A systemd unit cannot hold a line break: ${JSON.stringify(value)}`);
  return value.replace(/%/g, "%%");
}

/** A value in double quotes, with `\` and `"` escaped. */
function quoted(value: string): string {
  return `"${plain(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** What `systemctl show` says, as KEY=VALUE lines. */
function properties(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) found.set(line.slice(0, at), line.slice(at + 1));
  }
  return found;
}

/** The states of a unit systemd is keeping running: starting, running, being started again or stopped. */
const keptStates = new Set(["active", "activating", "deactivating", "reloading"]);

export class SystemdService implements Service {
  readonly label: string;
  readonly unit: string;
  readonly file: string;
  private readonly system: System;
  private readonly systemctl: string;

  /** `folder`: where its unit goes, ~/.config/systemd/user unless a test says otherwise. */
  constructor(system: System, label: string, folder = unitFolder()) {
    this.system = system;
    this.label = label;
    this.unit = unitName(label);
    this.file = join(folder, this.unit);
    this.systemctl = programOverride("systemctl") ?? system.which("systemctl") ?? "/usr/bin/systemctl";
  }

  get name(): string {
    return `systemd user service ${this.unit}`;
  }

  /** `systemctl --user`, which reaches the person's manager through their session's runtime folder. */
  private run(args: string[], timeoutMs = 30_000): Promise<RunResult> {
    return this.system.run(this.systemctl, ["--user", ...args], { timeoutMs, env: userSession(this.system.uid) });
  }

  private async show(...names: string[]): Promise<Map<string, string> | null> {
    const result = await this.run(["show", this.unit, ...names.flatMap((name) => ["-p", name])], 15_000);
    return result.code === 0 ? properties(result.stdout) : null;
  }

  /** Whether the person's systemd manager answers (`userManagerAnswers`). */
  reachable(): Promise<boolean> {
    return userManagerAnswers(this.system);
  }

  async runs(script: string): Promise<boolean | null> {
    const shown = await this.show("LoadState", "ActiveState", "ExecStart");
    if (!shown || !shown.has("LoadState") || !shown.has("ActiveState")) return null;
    const active = shown.get("ActiveState")!;
    if (active === "inactive" || active === "failed") return false;
    if (shown.get("LoadState") !== "loaded" || !keptStates.has(active)) return null;
    // `{ path=/usr/bin/node ; argv[]=/usr/bin/node /home/dana/…/app/dist/main.js ; ignore_errors=no ; … }`,
    // a `$` in it as the unit has it, doubled, or as run.
    const execStart = shown.get("ExecStart");
    if (!execStart) return null;
    return execStart.includes(` ${script} ;`) || execStart.includes(` ${script.replace(/\$/g, "$$$$")} ;`);
  }

  fileRuns(script?: string): boolean {
    try {
      const text = readFileSync(this.file, "utf8");
      const runs = text.split("\n").some((line) => line.startsWith("ExecStart=") && (script === undefined
        ? /^ExecStart=:"(?:[^"\\]|\\.)+" "(?:[^"\\]|\\.)+"$/.test(line)
        : line.endsWith(` ${quoted(script)}`)));
      return runs && text.trimEnd().endsWith("WantedBy=default.target");
    } catch {
      return false;
    }
  }

  async state(): Promise<ServiceState> {
    const shown = await this.show("LoadState", "ActiveState", "MainPID");
    const active = shown?.get("ActiveState");
    // A failed or incomplete query does not prove the bridge stopped, but status and
    // update can still report what they know without changing the service.
    if (!shown || !active || (!keptStates.has(active) && active !== "inactive" && active !== "failed")) {
      return { loaded: false, unknown: `systemd could not confirm the state of ${this.unit}.` };
    }
    if (!keptStates.has(active)) return { loaded: false };
    const pid = Number(shown.get("MainPID"));
    return pid > 0 ? { loaded: true, pid } : { loaded: true };
  }

  async install(spec: ServiceSpec): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    // systemd opens the log to append to, and makes no folder for it: without one, the
    // bridge would fail at every start.
    mkdirSync(dirname(spec.log), { recursive: true });
    writeFileSync(this.file, unit(spec));
    await this.must(["daemon-reload"]);
    await this.must(["enable", this.unit]);
    // Starts it, or stops the one running and starts it again with the new unit.
    await this.must(["restart", this.unit]);
  }

  async start(): Promise<void> {
    await this.must(["daemon-reload"]);
    await this.must(["start", this.unit]);
  }

  async restart(): Promise<void> {
    await this.must(["restart", this.unit]);
  }

  /** Stops it; it stays enabled, so it starts again at the next login or boot, as a LaunchAgent booted out does at the next login. */
  async stop(): Promise<void> {
    // Waits until it has stopped, killed after TimeoutStopSec (20 seconds).
    await this.must(["stop", this.unit], 60_000);
  }

  async remove(): Promise<void> {
    // As a LaunchAgent that cannot be stopped: nothing is removed while it may still run.
    if (!(await this.reachable())) throw new Error(`systemd's user manager can't be reached, so ${this.unit} was not stopped. Run this from a login session of your own.`);
    const before = await this.state();
    if (before.unknown) throw new Error(before.unknown);
    const disabled = await this.run(["disable", "--now", this.unit], 60_000);
    if (disabled.code !== 0) {
      const stopped = await this.state();
      if (stopped.unknown || stopped.loaded) throw new Error(`systemctl --user disable --now failed: ${(disabled.stderr || disabled.stdout).trim()}`);
    }
    if (existsSync(this.file)) rmSync(this.file);
    await this.run(["daemon-reload"]);
    await this.run(["reset-failed", this.unit]);
  }

  private async must(args: string[], timeoutMs?: number): Promise<void> {
    const result = await this.run(args, timeoutMs);
    if (result.code !== 0) throw new Error(`systemctl --user ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

/** Whether the person's systemd manager answers: not when there is no systemd, or no session of theirs (`sudo -u`, a container). */
export async function userManagerAnswers(system: System): Promise<boolean> {
  const systemctl = programOverride("systemctl") ?? system.which("systemctl") ?? "/usr/bin/systemctl";
  return (await system.run(systemctl, ["--user", "show-environment"], { timeoutMs: 15_000, env: userSession(system.uid) })).code === 0;
}

/**
 * The environment for `systemctl --user` and `loginctl`: this one, with the session's
 * runtime folder named when it is not (a shell from `sudo -u` or `su` has none, though the
 * person's manager is there), which is where `systemctl --user` finds the manager.
 */
export function userSession(uid: number, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env.XDG_RUNTIME_DIR || !existsSync(`/run/user/${uid}`)) return env;
  return { ...env, XDG_RUNTIME_DIR: `/run/user/${uid}` };
}

/** `loginctl`, or a stand-in (`PORTALS_SETUP_LOGINCTL`). */
function loginctl(system: System): string {
  return programOverride("loginctl") ?? system.which("loginctl") ?? "/usr/bin/loginctl";
}

/**
 * Whether systemd keeps `user`'s services running while they are logged out, and starts
 * them at boot. loginctl knows only users who are logged in or lingering, and says it
 * does not know the others: those are not lingering.
 */
export async function lingering(system: System, user: string): Promise<boolean> {
  const result = await system.run(loginctl(system), ["show-user", user, "--property=Linger", "--value"], { timeoutMs: 15_000, env: userSession(system.uid) });
  return result.code === 0 && result.stdout.trim() === "yes";
}

/**
 * Turns lingering on for `user`, in this terminal: by themselves where polkit lets them
 * (it may ask for a password), else, `withSudo`, as root (sudo asks). Says whether it is on.
 */
export async function enableLingering(system: System, user: string, withSudo = false): Promise<boolean> {
  const program = loginctl(system);
  const [command, args] = withSudo ? [programOverride("sudo") ?? system.which("sudo") ?? "/usr/bin/sudo", [program, "enable-linger", user]] : [program, ["enable-linger", user]];
  const result = await system.run(command, args, { timeoutMs: 120_000, inherit: true, env: userSession(system.uid) });
  return result.code === 0 && (await lingering(system, user));
}
