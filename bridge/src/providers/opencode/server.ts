import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { counters } from "../../counters.ts";
import { log } from "../../log.ts";
import { threadVariables } from "../../portals/access.ts";
import { writeJSON } from "../../store/jsonFile.ts";
import { endGroup, processOf, type ProcessIdentity as Identity } from "../child.ts";
import { programVersion } from "../program.ts";
import { minimumOpenCodeVersion, supportedOpenCodeVersion as supportedVersion } from "./options.ts";
import { settleOwned, type OwnedStopResult } from "./shutdown.ts";

export type { OwnedStopResult } from "./shutdown.ts";

// The user's service is discovered, never recovered or replaced. In particular,
// Service.ensure also kills hung services when no version was requested.
//
// An owned server has its own process group and a private durable record. After a
// bridge crash, the next bridge proves which process it is before reusing it. A pid
// alone is not ownership: the system reuses them.

export interface Endpoint {
  url: string;
  /** Never logged. */
  headers: Record<string, string>;
  own: boolean;
  pid?: number;
  /** Stable for this native process, including across a bridge restart. */
  serverIdentity?: string;
  /** An owned native process recovered from a previous bridge. */
  reclaimed?: boolean;
}

export type ServerMode = "shared" | "own";

export interface ServerOptions {
  path: string;
  mode: ServerMode;
  start: boolean;
  cwd: string;
  logPath: string;
  env?: NodeJS.ProcessEnv;
  registration?: string;
  /** Defaults to <logPath>.server.json, in the bridge's private home. */
  recordPath?: string;
  startTimeoutMs?: number;
  /** Shorter native settlement deadline for tests; never exceeds four seconds. */
  settleTimeoutMs?: number;
  /** Owned stops only, before TERM. Notifications have at most 25ms to finish. */
  onStop?: (result: OwnedStopResult) => void | Promise<void>;
}

type ServiceModule = typeof import("@opencode/client/service");

export async function serviceModule(): Promise<ServiceModule> {
  try {
    return await import("@opencode/client/service");
  } catch (error) {
    throw new Error(`OpenCode's client is not installed with Portals host (${(error as Error).message}). With OpenCode 2 installed or providers.opencode enabled, run: npx portals-host@latest update (or npx portals-host@latest setup).`);
  }
}

interface Owner extends Identity { token: string }
interface OwnRecord {
  format: 1;
  id: string;
  bridge: Owner;
  password: string;
  server?: Identity;
  url?: string;
}
interface Registration { pid: number; version?: string; url: string; password?: string }

const listening = /server listening on (https?:\/\/\S+)/;
const probeMs = 2000;
function token(): string { return randomBytes(24).toString("base64url"); }

export class ServerLocator {
  private readonly options: ServerOptions;
  private child: ChildProcess | null = null;
  private ownEndpoint: Endpoint | null = null;
  private record: OwnRecord | null = null;
  private owner: Owner | null = null;
  private starting: Promise<Endpoint> | null = null;
  private stopping: Promise<void> | null = null;
  private rest: Promise<void> = Promise.resolve();
  private version: Promise<void> | null = null;
  private startedAt = 0;
  private closed = false;
  private readonly abort = new AbortController();

  constructor(options: ServerOptions) { this.options = options; }

  /** Extra signal grace only while there is an owned process to settle and stop. */
  get stopDeadlineMs(): number | undefined {
    const child = this.child;
    // The record was adopted only after ownership proof. Granting time is not
    // permission to signal: stopOwned still requires a fresh matching identity.
    return (child && child.exitCode === null && child.signalCode === null)
      || this.record?.server ? 16_000 : undefined;
  }

  locate(): Promise<Endpoint> {
    if (this.closed) return Promise.reject(new Error("OpenCode was stopped."));
    this.starting ??= this.find().finally(() => { this.starting = null; });
    return this.starting;
  }

  private get recordPath(): string { return this.options.recordPath ?? `${this.options.logPath}.server.json`; }

  private environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), OPENCODE_DISABLE_AUTOUPDATE: "1" };
    for (const name of threadVariables) delete env[name];
    return env;
  }

  private async find(): Promise<Endpoint> {
    this.version ??= programVersion(this.options.path, this.environment()).then((version) => {
      if (!supportedVersion(version)) {
        const error = new Error(version === null
          ? `Could not verify OpenCode 2 at ${this.options.path}. Check opencode.path and run opencode --version.`
          : `OpenCode ${version} is installed at ${this.options.path}; Portals runs OpenCode 2 (${minimumOpenCodeVersion} or newer). Choose a separate v2 installation with opencode.path; upgrading is your choice (opencode upgrade --major).`);
        log.error(error.message);
        throw error;
      }
    }).catch((error) => {
      this.version = null;
      throw error;
    });
    await this.version;
    this.checkOpen();
    if (this.ownEndpoint && this.record?.server && same(this.record.server, processOf(this.record.server.pid))) return this.ownEndpoint;
    this.ownEndpoint = null;
    await this.rest;
    if (this.options.mode === "shared") {
      const found = await this.shared();
      this.checkOpen();
      if (found) return found;
    }
    return this.own();
  }

  private async shared(): Promise<Endpoint | null> {
    await serviceModule();
    const env = this.environment();
    const file = this.options.registration ?? join(env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state"), "opencode", "service.json");
    const discover = async (): Promise<Endpoint | null> => {
      const record = registration(file);
      if (!record) return null;
      if (record.version && !supportedVersion(record.version)) {
        log.error(`OpenCode's background service runs ${record.version}; Portals runs OpenCode 2. Upgrade it with: opencode upgrade --major`);
        return null;
      }
      const headers = authorization(record.password);
      const info = await probe(record.url, headers, this.abort.signal);
      if (!info || info.pid !== record.pid || (record.version && info.version !== record.version)) return null;
      if (!supportedVersion(info.version)) {
        log.error(`OpenCode's background service runs ${info.version}; Portals runs OpenCode 2. Upgrade it with: opencode upgrade --major`);
        return null;
      }
      return { url: record.url, headers, own: false, pid: info.pid, serverIdentity: `${info.pid}:${info.version}` };
    };
    const found = await discover();
    if (found) return found;
    // An occupied registration, healthy or not, is the user's to recover.
    if (!this.options.start || exists(file) || this.closed) return null;
    log.info("OpenCode has no background service registration; starting a service contender");
    const output = openSync(this.options.logPath, "a", 0o600);
    let child: ChildProcess;
    try {
      if (counters.on) counters.spawned("opencode");
      child = spawn(this.options.path, ["serve", "--service"], { cwd: this.options.cwd, env, detached: true, stdio: ["ignore", output, output] });
    } finally { closeSync(output); }
    let failed = false;
    child.once("error", () => { failed = true; });
    child.unref();
    // Native --service elects a winner without replacing it. Unlike Service.ensure,
    // this loop never signals a registered process, clears handoff, or deletes files.
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 30_000);
    while (!this.closed && Date.now() < deadline && !failed) {
      if (exists(file)) {
        const endpoint = await discover();
        if (endpoint) return endpoint;
        // Someone else won, but cannot be reached: leave both it and its record alone.
        if (registration(file)?.pid !== child.pid) return null;
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await sleep(25, undefined, { signal: this.abort.signal }).catch(() => undefined);
    }
    log.warn("OpenCode's background service could not be reached; using a server of the bridge's own");
    return null;
  }

  private async own(): Promise<Endpoint> {
    this.checkOpen();
    const identity = processOf(process.pid);
    if (!identity) throw this.uncertain("the host's own process identity could not be read");
    this.owner ??= { ...identity, token: token() };
    const release = this.lease();
    try {
      const previous = this.readRecord();
      if (previous) {
        if (previous.bridge.token !== this.owner.token) {
          const bridge = processOf(previous.bridge.pid);
          if (same(previous.bridge, bridge) || (!bridge && alive(previous.bridge.pid))) {
            throw this.uncertain(`host PID ${previous.bridge.pid} still owns the recorded server or its identity cannot be read`);
          }
        }
        if (!previous.server) throw this.uncertain("an earlier host stopped during server startup, before its PID was recorded");
        const current = processOf(previous.server.pid);
        if (current || alive(previous.server.pid)) {
          if (!same(previous.server, current) || previous.server.group !== previous.server.pid) {
            throw this.uncertain(`recorded server PID ${previous.server.pid} has a different or unreadable start identity/process group`);
          }
          const info = previous.url && await probe(previous.url, authorization(previous.password), this.abort.signal, true)
            .catch((error: Error) => { throw this.uncertain(error.message); });
          this.checkOpen();
          if (info && (info.pid !== previous.server.pid || !supportedVersion(info.version))) {
            throw this.uncertain(`recorded server PID ${previous.server.pid} answered as a different process or unsupported version`);
          }
          this.record = { ...previous, bridge: this.owner };
          writeJSON(this.recordPath, this.record);
          if (info && previous.url) {
            log.info("reclaimed the bridge's OpenCode server", { pid: previous.server.pid, url: previous.url });
            return this.endpoint(previous.url, true);
          }
          log.warn("the verified bridge-owned OpenCode server is unresponsive; stopping it before replacement", { pid: previous.server.pid });
          await this.stopOwned();
        }
      }
      return await this.startOwn();
    } finally { release(); }
  }

  private async startOwn(): Promise<Endpoint> {
    this.checkOpen();
    if (Date.now() - this.startedAt < 30_000) throw new Error(`OpenCode did not start. Its output is in ${this.options.logPath}.`);
    this.startedAt = Date.now();
    this.record = { format: 1, id: token(), bridge: this.owner!, password: token() };
    writeJSON(this.recordPath, this.record);
    const output = openSync(this.options.logPath, "a", 0o600);
    let child: ChildProcess;
    try {
      if (counters.on) counters.spawned("opencode");
      child = spawn(this.options.path, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: this.options.cwd, env: { ...this.environment(), OPENCODE_PASSWORD: this.record.password },
        detached: true, stdio: ["ignore", "pipe", output],
      });
    } finally { closeSync(output); }
    this.child = child;
    const record = this.record;
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ownEndpoint = null;
      this.rest = child.pid === undefined ? Promise.resolve() : endGroup(child.pid);
      if (!this.closed) log.warn("the bridge's opencode serve stopped", { code, signal });
    });
    child.on("error", () => undefined);
    try {
      const heard = this.listener(child);
      // Record the rejection now, even if verifying the just-spawned PID fails.
      void heard.catch(() => undefined);
      if (child.pid !== undefined) {
        const identity = processOf(child.pid);
        if (identity) {
          if (identity.group !== child.pid) throw this.uncertain("the newly started server's process group could not be verified");
          record.server = identity;
          writeJSON(this.recordPath, record);
        }
      }
      const url = await heard;
      if (!record.server) throw this.uncertain(`the start identity of newly started server PID ${child.pid ?? "unknown"} could not be read`);
      if (!loopback(url)) throw new Error("OpenCode printed a non-loopback server address.");
      record.url = url;
      writeJSON(this.recordPath, record);
      const info = await probe(url, authorization(record.password), this.abort.signal);
      this.checkOpen();
      if (!info || info.pid !== child.pid || !supportedVersion(info.version)) throw new Error(`The host-owned OpenCode server did not prove its PID, password and supported OpenCode 2 version (${minimumOpenCodeVersion} or newer).`);
      log.info("started an OpenCode server of the bridge's own", { url });
      return this.endpoint(url, false);
    } catch (error) {
      await this.stopOwned();
      throw error;
    }
  }

  private listener(child: ChildProcess): Promise<string> {
    return new Promise((resolve, reject) => {
      let printed = "";
      const finish = (error: Error | null, url?: string) => {
        clearTimeout(timer);
        child.off("error", failed);
        child.off("exit", exited);
        child.stdout?.off("data", data);
        child.stdout?.resume();
        this.abort.signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve(url!);
      };
      const failed = (error: Error) => finish(new Error(`could not start opencode serve: ${error.message}`));
      const exited = (code: number | null) => finish(new Error(`opencode serve stopped (${code ?? "signal"}). Its output is in ${this.options.logPath}.`));
      const aborted = () => finish(new Error("OpenCode was stopped."));
      const data = (chunk: Buffer) => {
        printed = (printed + chunk.toString("utf8")).slice(-8192);
        const found = listening.exec(printed);
        if (found) finish(null, found[1]);
      };
      const timer = setTimeout(() => finish(new Error(`OpenCode did not start in time. Its output is in ${this.options.logPath}.`)), this.options.startTimeoutMs ?? 30_000);
      child.once("error", failed);
      child.once("exit", exited);
      child.stdout?.on("data", data);
      this.abort.signal.addEventListener("abort", aborted, { once: true });
      if (this.closed) aborted();
    });
  }

  private endpoint(url: string, reclaimed: boolean): Endpoint {
    const record = this.record!;
    return this.ownEndpoint = { url, headers: authorization(record.password), own: true, pid: record.server!.pid, serverIdentity: record.id, reclaimed };
  }

  close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    this.stopping ??= (async () => {
      await this.starting?.catch(() => undefined);
      await this.stopOwned();
    })();
    return this.stopping;
  }

  private async stopOwned(): Promise<void> {
    const record = this.record;
    if (!record) return;
    const server = record.server;
    const child = this.child;
    let result: OwnedStopResult = { serverIdentity: record.id, settled: [], unsettled: [], complete: false };
    if (server && record.url && same(server, await processForStop(server.pid))) {
      result = await settleOwned({
        url: record.url, headers: authorization(record.password), own: true,
        pid: server.pid, serverIdentity: record.id,
      }, this.options.settleTimeoutMs);
    }
    if (!result.complete) log.warn("could not confirm all owned OpenCode turns stopped; native recovery may continue them after restart", {
      settled: result.settled, unsettled: result.unsettled,
    });
    await this.stopped(result);
    // Settlement and the callback can outlive this child. Its exit listener has
    // already cleaned up the group; never signal its possibly reused PID here.
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      if (server) {
        const current = await processForStop(child.pid);
        if (current && !same(server, current)) throw this.uncertain(`owned server PID ${child.pid} has a different start identity or process group`);
        if (!current) {
          // The OS can reap the process before Node delivers its exit event.
          const deadline = Date.now() + 1000;
          while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(20);
          if (child.exitCode === null && child.signalCode === null) throw this.uncertain(`owned server PID ${child.pid}'s identity could not be read`);
        }
      }
      if (child.exitCode === null && child.signalCode === null) await endGroup(child.pid);
      // SIGKILL can leave a zombie until Node receives and reaps the child.
      const deadline = Date.now() + 1000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(20);
      if (child.exitCode === null && child.signalCode === null) throw this.uncertain(`owned server PID ${child.pid} did not report its exit after SIGKILL`);
    }
    else if (!child && server) {
      const current = await processForStop(server.pid);
      if (same(server, current)) await endGroup(server.group);
      else if (current) throw this.uncertain(`recorded server PID ${server.pid} has a different start identity or process group`);
      else if (alive(server.pid)) throw this.uncertain(`recorded server PID ${server.pid}'s identity could not be read`);
    }
    if (server) {
      const deadline = Date.now() + 1000;
      while (processOf(server.pid, 250) && Date.now() < deadline) await sleep(20);
      if (processOf(server.pid, 250)) throw this.uncertain(`owned server PID ${server.pid} did not exit after SIGKILL`);
    }
    await this.rest;
    const current = this.readRecord();
    if (current?.id === record.id && current.bridge.token === this.owner?.token) unlinkSync(this.recordPath);
    if (this.record === record) this.record = null;
    this.ownEndpoint = null;
    this.child = null;
  }

  private async stopped(result: OwnedStopResult): Promise<void> {
    if (!this.options.onStop) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => this.options.onStop!(result)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 25); }),
      ]);
    } catch { log.warn("the owned OpenCode shutdown notification failed; stopping its server all the same"); }
    finally { clearTimeout(timer); }
  }

  private readRecord(): OwnRecord | null {
    try {
      const value = privateJSON(this.recordPath);
      if (value === null) return null;
      if (value?.format !== 1 || typeof value.id !== "string" || typeof value.password !== "string" || value.password.length < 32
        || !isIdentity(value.bridge) || typeof value.bridge.token !== "string"
        || (value.server !== undefined && !isIdentity(value.server))
        || (value.url !== undefined && (typeof value.url !== "string" || !loopback(value.url)))) throw new Error("invalid ownership record");
      return value as OwnRecord;
    } catch (error) { throw this.uncertain((error as Error).message); }
  }

  private lease(): () => void {
    const path = `${this.recordPath}.lock`;
    try {
      writeFileSync(path, JSON.stringify(this.owner), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Serialize stale-lease recovery too: check-then-unlink alone lets a second
      // recovering bridge unlink a newly acquired lease in another process.
      const guard = `${path}.reclaim`;
      try { writeFileSync(guard, JSON.stringify(this.owner), { flag: "wx", mode: 0o600 }); }
      catch { throw this.uncertain(`startup lease recovery is in progress or was interrupted; inspect ${guard}`); }
      try {
        let lease;
        try { lease = privateJSON(path); } catch (error) { throw this.uncertain(`startup lease: ${(error as Error).message}`); }
        if (lease !== null) {
          if (!isIdentity(lease) || typeof lease.token !== "string") throw this.uncertain("the startup lease is invalid");
          const current = processOf(lease.pid);
          if (same(lease, current) || (!current && alive(lease.pid))) throw this.uncertain(`host PID ${lease.pid} holds the startup lease or its identity cannot be read`);
          unlinkSync(path);
        }
        return this.lease();
      } finally { unlinkSync(guard); }
    }
    return () => {
      const current = privateJSON(path);
      if (current?.token === this.owner?.token) unlinkSync(path);
    };
  }

  private checkOpen(): void { if (this.closed) throw new Error("OpenCode was stopped."); }

  private uncertain(reason: string): Error {
    const error = new Error(`Cannot safely reclaim OpenCode: ${reason}. Check ${this.recordPath} (and its .lock) and the recorded process. Stop the host first; only after confirming no owned server is running, remove the stale record/lock and restart. No unverified process was stopped or second server started.`);
    log.error(error.message);
    return error;
  }
}

function authorization(password?: string): Record<string, string> {
  return password === undefined ? {} : { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
}

function loopback(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
}

async function probe(url: string, headers: Record<string, string>, signal: AbortSignal, strict = false): Promise<{ pid: number; version: string } | null> {
  if (!loopback(url)) return null;
  const response = await fetch(new URL("/api/info", url), { headers, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(probeMs)]) }).catch(() => null);
  if (!response) return null;
  if (!response.ok) {
    if (strict) throw new Error(`recorded server did not accept its ownership proof (HTTP ${response.status})`);
    return null;
  }
  const info = await response.json().catch(() => null) as { pid?: unknown; version?: unknown } | null;
  if (info && typeof info.pid === "number" && Number.isSafeInteger(info.pid) && info.pid > 1 && typeof info.version === "string") return { pid: info.pid, version: info.version };
  if (strict) throw new Error("recorded server returned an invalid ownership proof");
  return null;
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

function registration(path: string): Registration | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Number.isSafeInteger(value?.pid) && value.pid > 1 && typeof value.url === "string" && loopback(value.url)
      && (value.password === undefined || typeof value.password === "string") ? value : null;
  } catch { return null; }
}

function privateJSON(path: string): any {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("ownership file is not a private, owner-only regular file");
  const contents = readFileSync(path, "utf8");
  try { return JSON.parse(contents); }
  catch { throw new Error("ownership file contains invalid JSON"); }
}

function isIdentity(value: any): value is Identity & { token?: unknown } {
  return Number.isSafeInteger(value?.pid) && value.pid > 1 && typeof value.start === "string" && value.start !== "" && Number.isSafeInteger(value.group) && value.group > 1;
}

function same(left: Identity, right: Identity | null): boolean {
  return right !== null && left.pid === right.pid && left.start === right.start && left.group === right.group;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** A busy host can miss one short OS read. Retry unreadable proofs within one
 * second; a positive identity (including a mismatch) is never retried away. */
async function processForStop(pid: number): Promise<Identity | null> {
  const deadline = Date.now() + 1000;
  for (;;) {
    const current = processOf(pid, Math.max(1, Math.min(250, deadline - Date.now())));
    if (current || !alive(pid) || Date.now() >= deadline) return current;
    await sleep(20);
  }
}

