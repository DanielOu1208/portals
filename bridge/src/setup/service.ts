import { hostOS, type HostOS } from "../platform.ts";
import { LaunchAgent } from "./launchAgent.ts";
import { SystemdService } from "./systemd.ts";
import type { System } from "./system.ts";
import type { DefinitionUpdate } from "./serviceDefinition.ts";

// What keeps the bridge running, started again when it stops: a LaunchAgent on a Mac
// (launchAgent.ts), a systemd user service on Linux (systemd.ts), each in the person's own
// session, so the agents the bridge starts have their logins and files. Setup, update,
// status, `relay reset` and uninstall use either one through this.

export interface ServiceSpec {
  /** The label setup keeps (`com.danielou.portals.bridge`), from which a unit's name comes on Linux. */
  label: string;
  /** The node that runs the bridge. */
  node: string;
  /** The script it runs (`<app>/dist/main.js`). */
  script: string;
  workingDirectory: string;
  /** PATH for the bridge, so it finds `claude`, `codex` and `node`. */
  path: string;
  log: string;
  /** Environment variables besides PATH (`PORTALS_BRIDGE_HOME` for a bridge outside the usual folder). */
  environment?: Record<string, string>;
}

export interface ServiceState {
  /** Loaded and kept running: by launchd, or by systemd (starting, running, or started again after it stopped). */
  loaded: boolean;
  /** Why the manager could not be checked; when present, loaded is not proof of absence. */
  unknown?: string;
  /** Its process, while it runs. */
  pid?: number;
}

export interface Service {
  readonly label: string;
  /** Its definition on disk: the plist, or the unit file. */
  readonly file: string;
  /** How setup names it to the person: "LaunchAgent com.danielou.portals.bridge", "systemd user service portals-host.service". */
  readonly name: string;
  /**
   * Whether the loaded job runs `script`: the bridge of one folder (`<folder>/app/dist/main.js`).
   * Two folders can share a label, and only the loaded job says which of them runs; its file on
   * disk may already be another's (a setup stopped halfway). False when none is loaded,
   * and null when the manager cannot verify the loaded job.
   */
  runs(script: string): Promise<boolean | null>;
  /** Whether its file on disk runs `script` and is whole; without a script, checks that it has a complete command. */
  fileRuns(script?: string): boolean;
  state(): Promise<ServiceState>;
  /** Writes its file and loads it, replacing a loaded one: the bridge (re)starts. */
  install(spec: ServiceSpec): Promise<void>;
  /** Re-render its current settings with this version's template, reloading safely where supported. */
  refreshDefinition(): Promise<DefinitionUpdate>;
  /** Loads the file that is there, which starts the bridge. */
  start(): Promise<void>;
  /** Stops the bridge and starts it again (after an update). */
  restart(): Promise<void>;
  /** Stops it and unloads it, until it is started or the person logs in again; the file stays. */
  stop(): Promise<void>;
  /** Stops it, unloads it and removes its file. */
  remove(): Promise<void>;
}

/** The service of `label` on this system; `folder` is where its file goes, for tests. */
export function serviceFor(system: System, label: string, folder?: string, os: HostOS = hostOS): Service {
  return os === "macos" ? new LaunchAgent(system, label, folder) : new SystemdService(system, label, folder);
}

/** What keeps the bridge running on `os`, for setup's words: "LaunchAgent", "systemd user service". */
export function serviceKind(os: HostOS = hostOS): string {
  return os === "macos" ? "LaunchAgent" : "systemd user service";
}
