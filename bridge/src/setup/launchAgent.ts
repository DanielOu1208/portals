import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Service, ServiceSpec, ServiceState } from "./service.ts";
import { programOverride, type System } from "./system.ts";
import { checkDefinitionFields, replaceDefinition, specFromPlist, UnsupportedServiceDefinition, type DefinitionUpdate } from "./serviceDefinition.ts";

// The LaunchAgent that keeps the bridge running on a Mac (service.ts): started at login,
// started again if it stops, its output in a log under ~/Library/Logs. It runs in the
// person's own session (launchd's `gui/<uid>` domain), so the agents it starts have their
// logins and files.

export const label = "com.danielou.portals.bridge";
/** The label before the app was called Portals. */
export const oldLabel = "com.danielou.aeriportal.bridge";
/** How long a stopped bridge may take to be gone from launchd, a little over launchd's own 20 seconds. */
const stopTimeoutMs = 25_000;

/** Where the person's LaunchAgents are. */
export function launchAgentsFolder(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

export function plist(spec: ServiceSpec): string {
  const string = (value: string) => `<string>${escape(value)}</string>`;
  const environment = { PATH: spec.path, ...spec.environment };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(spec.label)}
  <key>ProgramArguments</key>
  <array>
    ${string(spec.node)}
    ${string(spec.script)}
  </array>
  <key>WorkingDirectory</key>${string(spec.workingDirectory)}
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment)
  .map(([key, value]) => `    <key>${escape(key)}</key>${string(value)}`)
  .join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>StandardOutPath</key>${string(spec.log)}
  <key>StandardErrorPath</key>${string(spec.log)}
</dict>
</plist>
`;
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export class LaunchAgent implements Service {
  readonly label: string;
  readonly file: string;
  private readonly system: System;
  private readonly launchctl: string;

  /** `plistFolder`: where its plist goes, ~/Library/LaunchAgents unless a test says otherwise. */
  constructor(system: System, agentLabel: string, plistFolder = launchAgentsFolder()) {
    this.system = system;
    this.label = agentLabel;
    this.file = join(plistFolder, `${agentLabel}.plist`);
    this.launchctl = programOverride("launchctl") ?? "/bin/launchctl";
  }

  private get target(): string {
    return `gui/${this.system.uid}/${this.label}`;
  }

  get name(): string {
    return `LaunchAgent ${this.label}`;
  }

  /**
   * Whether the job launchd has loaded under this label runs `script`: the bridge of one
   * folder (`<folder>/app/dist/main.js`), as `launchctl print` lists its arguments. Two
   * folders can share a label (a copy of one, its setup.json with it, or two of one name in
   * different places), and only the loaded job says which of them runs; its plist on disk
   * may already be another's (a setup stopped halfway). False when none is loaded.
   */
  async runs(script: string): Promise<boolean | null> {
    const result = await this.system.run(this.launchctl, ["print", this.target], { timeoutMs: 15_000 });
    if (result.code === 3 || result.code === 113) return false;
    if (result.code !== 0) return null;
    const block = /^\s*arguments = \{([^}]*)\}/m.exec(result.stdout)?.[1];
    if (block === undefined) return null;
    return block.split("\n").some((line) => line.trim() === script);
  }

  /** Whether its plist on disk runs `script`, and is whole (a write cut short is not): what `start` would start. */
  fileRuns(script?: string): boolean {
    try {
      const text = readFileSync(this.file, "utf8");
      const runs = script === undefined
        ? /<key>ProgramArguments<\/key>\s*<array>\s*<string>[^<]+<\/string>\s*<string>[^<]+<\/string>\s*<\/array>/.test(text)
        : text.includes(`<string>${escape(script)}</string>`);
      return runs && text.trimEnd().endsWith("</plist>");
    } catch {
      return false;
    }
  }

  async state(): Promise<ServiceState> {
    const result = await this.system.run(this.launchctl, ["print", this.target], { timeoutMs: 15_000 });
    if (result.code === 3 || result.code === 113) return { loaded: false };
    // Only a missing job proves absence; an unanswered query remains unknown to callers.
    if (result.code !== 0) return { loaded: false, unknown: `launchctl print failed: ${(result.stderr || result.stdout).trim()}` };
    const pid = /^\s*pid = (\d+)/m.exec(result.stdout)?.[1];
    return pid ? { loaded: true, pid: Number(pid) } : { loaded: true };
  }

  /** Writes the plist and loads it, replacing a loaded one: the bridge (re)starts. */
  async install(spec: ServiceSpec): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, plist(spec));
    if ((await this.state()).loaded) await this.stop();
    await this.start();
  }

  /** Loads the plist that is there (`launchctl bootstrap`), which starts the bridge. */
  async start(): Promise<void> {
    // launchd keeps the labels switched off with `launchctl disable` (or `unload -w`), a
    // removed plist's too, and loads none of them: "Bootstrap failed: 5: Input/output error".
    await this.system.run(this.launchctl, ["enable", this.target], { timeoutMs: 15_000 });
    const result = await this.system.run(this.launchctl, ["bootstrap", `gui/${this.system.uid}`, this.file], { timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(`launchctl bootstrap failed: ${(result.stderr || result.stdout).trim()}`);
  }

  /** Stops the bridge and starts it again (after an update). */
  async restart(): Promise<void> {
    const result = await this.system.run(this.launchctl, ["kickstart", "-k", this.target], { timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(`launchctl kickstart failed: ${(result.stderr || result.stdout).trim()}`);
  }

  /** Do not unload a job from its own updater. launchd reads the new plist at its next bootstrap. */
  refreshDefinition(): Promise<DefinitionUpdate> {
    if (!existsSync(this.file)) throw new UnsupportedServiceDefinition("the service definition is missing");
    const before = readFileSync(this.file, "utf8");
    const next = plist(specFromPlist(before, this.label));
    checkDefinitionFields(before, next, "plist");
    return replaceDefinition(this.file, next);
  }

  /** Stops it and unloads it (`launchctl bootout`); the plist stays. */
  async stop(): Promise<void> {
    const result = await this.system.run(this.launchctl, ["bootout", this.target], { timeoutMs: 30_000 });
    // 3 (no such process) and 113 (not loaded): nothing to stop.
    if (result.code !== 0 && result.code !== 3 && result.code !== 113) {
      const state = await this.state();
      if (state.unknown || state.loaded) throw new Error(`launchctl bootout failed: ${(result.stderr || result.stdout).trim()}`);
    }
    // bootout returns while the bridge is still stopping, and launchd loads nothing under a
    // label it still has (error 5 again). It kills what has not stopped after 20 seconds.
    const deadline = Date.now() + stopTimeoutMs;
    for (;;) {
      const state = await this.state();
      if (state.unknown) throw new Error(state.unknown);
      if (!state.loaded) break;
      if (Date.now() > deadline) throw new Error("Portals host did not stop: launchd still has its LaunchAgent");
      await sleep(200);
    }
  }

  /** Stops it, unloads it and removes its plist. */
  async remove(): Promise<void> {
    const state = await this.state();
    if (state.unknown) throw new Error(state.unknown);
    await this.stop();
    if (existsSync(this.file)) rmSync(this.file);
  }
}
