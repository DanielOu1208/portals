import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { counters } from "../../counters.ts";
import { log } from "../../log.ts";

// Finding the `hermes serve` this Mac runs, and starting one when none does
// (docs/bridge-spikes.md, S5).
//
// Hermes runs one backend per user on a Mac, which serves every profile: a second
// `hermes serve` (or `hermes dashboard`) finds the first and stops. The one that runs
// publishes where it is in `~/.local/state/hermes/gateway-locks/host-serve.json`, with
// its session token next to it in `host-serve.token` (owner only). The bridge reads
// both, makes the backend prove it is the one recorded, and connects to its WebSocket
// with the token. Hermes's own desktop app and terminal no longer do: since mid-2026
// they run their turns in Hermes's messaging gateway (`hermes gateway`), another process,
// so what they say in a session reaches the bridge only through Hermes's store
// (`sessions.changed`, HermesSession.changedConversation). When no backend answers,
// the bridge starts one in a process group of its own, so that it outlives the bridge:
// Hermes interrupts a turn whose client has been gone for 20 seconds, but a bridge that
// restarts is back well before that.

/** The record's format, as Hermes's `gateway/host_rendezvous.py` writes it. */
const recordVersion = 1;
const identityPath = "/api/host/identity";
const probeTimeoutMs = 2000;

/** Where a running `hermes serve` listens, and how to sign in to it. */
export interface ServeEndpoint {
  /** Always a loopback address. */
  host: string;
  port: number;
  /** The backend's session token: `?token=` on its WebSocket. Never logged. */
  token: string;
  pid: number;
}

/** The folder Hermes keeps its host records in, for this user. */
export function lockDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HERMES_GATEWAY_LOCK_DIR;
  if (override) return override;
  // Hermes ignores a relative XDG_STATE_HOME, as the XDG spec says.
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(homedir(), ".local", "state");
  return join(state, "hermes", "gateway-locks");
}

/**
 * The recorded backend, or null when there is none to try: no record, one written by
 * another user, an unknown format, a process that is gone, or a token that is not the
 * one the record names.
 */
export function readServeRecord(directory: string): ServeEndpoint | null {
  const recordPath = join(directory, "host-serve.json");
  try {
    // Only a record of this user's counts: anyone else could point the bridge anywhere.
    const uid = process.getuid?.();
    if (uid !== undefined && (statSync(recordPath).uid !== uid || statSync(directory).uid !== uid)) return null;
  } catch {
    return null;
  }
  let record: Record<string, unknown>;
  let token: string;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
    token = readFileSync(join(directory, "host-serve.token"), "utf8").trim();
  } catch {
    return null;
  }
  if (record?.role !== "serve" || record.protocolVersion !== recordVersion) return null;
  const pid = record.pid;
  const port = record.port;
  if (!Number.isInteger(pid) || (pid as number) <= 0 || !Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65535) return null;
  if (!token || fingerprint(token) !== record.tokenFingerprint) return null;
  if (!isAlive(pid as number)) return null;
  const bound = typeof record.host === "string" ? record.host : "";
  // A backend bound to every address is reached on loopback; one bound elsewhere is not the bridge's to use.
  const host = ["", "0.0.0.0", "::", "*", "127.0.0.1", "localhost"].includes(bound) ? "127.0.0.1" : bound === "::1" ? "::1" : null;
  if (!host) return null;
  return { host, port: port as number, token, pid: pid as number };
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Gone, or (EPERM) another user's: the record is this user's, so that is a reused pid.
    return false;
  }
}

/** The backend answers on its port as the process its record names. */
export async function proves(endpoint: ServeEndpoint, timeoutMs = probeTimeoutMs): Promise<boolean> {
  try {
    const response = await fetch(`http://${hostForURL(endpoint.host)}:${endpoint.port}${identityPath}`, {
      headers: { "X-Hermes-Token": endpoint.token, Authorization: `Bearer ${endpoint.token}` },
      // The recorded loopback endpoint proves itself, without forwarding its token.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return false;
    const identity = (await response.json()) as { role?: unknown; pid?: unknown };
    return identity.role === "serve" && identity.pid === endpoint.pid;
  } catch {
    return false;
  }
}

export function hostForURL(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/** The backend's WebSocket, signed in with its token. */
export function socketURL(endpoint: ServeEndpoint): string {
  return `ws://${hostForURL(endpoint.host)}:${endpoint.port}/api/ws?token=${encodeURIComponent(endpoint.token)}`;
}

export interface ServeOptions {
  /** The installed `hermes`. */
  path: string;
  /** Start a backend when none runs. */
  start: boolean;
  /** Where a backend the bridge starts runs from. */
  cwd: string;
  /** Where a backend the bridge starts writes what it prints. */
  logPath: string;
  env?: NodeJS.ProcessEnv;
  /** The records' folder (tests give another). */
  directory?: string;
  /** How long a backend the bridge started may take to answer. */
  startTimeoutMs?: number;
}

/** Finds the running backend, starting one first when allowed and none answers. */
export class ServeLocator {
  private readonly options: ServeOptions;
  private starting: Promise<ServeEndpoint> | null = null;
  /** When the bridge last started a backend, so a failing one is not started over and over. */
  private startedAt = 0;

  constructor(options: ServeOptions) {
    this.options = options;
  }

  private get directory(): string {
    return this.options.directory ?? lockDirectory(this.options.env);
  }

  /** The backend that answers now, or null. */
  async running(): Promise<ServeEndpoint | null> {
    const endpoint = readServeRecord(this.directory);
    return endpoint && (await proves(endpoint)) ? endpoint : null;
  }

  /** The running backend; starts one when none answers and the settings allow it. */
  async locate(): Promise<ServeEndpoint> {
    const endpoint = await this.running();
    if (endpoint) return endpoint;
    if (!this.options.start) throw new Error("Hermes is not running. Start it with `hermes serve`, or let the bridge start it (hermes.start in config.json).");
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<ServeEndpoint> {
    // A backend that dies at once is not started again for a minute.
    if (Date.now() - this.startedAt < 60_000) throw new Error("Hermes did not start. Its output is in " + this.options.logPath + ".");
    this.startedAt = Date.now();
    log.info("Hermes is not running; starting `hermes serve`");
    const output = openSync(this.options.logPath, "a", 0o600);
    try {
      // Its own process group: it outlives the bridge, which reconnects to it.
      if (counters.on) counters.spawned("hermes");
      const child = spawn(this.options.path, ["serve"], {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        detached: true,
        stdio: ["ignore", output, output],
      });
      child.once("error", (error) => log.warn("could not start `hermes serve`", { error: error.message }));
      child.unref();
    } finally {
      closeSync(output);
    }
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 90_000);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const endpoint = await this.running();
      if (endpoint) {
        log.info("Hermes started", { port: endpoint.port, pid: endpoint.pid });
        return endpoint;
      }
    }
    throw new Error(`Hermes did not start in time. Its output is in ${this.options.logPath}.`);
  }
}
