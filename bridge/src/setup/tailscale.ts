import { hostOS, type HostOS } from "../platform.ts";
import { isExecutable, programOverride, type System } from "./system.ts";

// How the phone reaches the bridge: `tailscale serve` on this machine maps an HTTPS port
// on its tailnet name to the bridge on 127.0.0.1, for devices on the same tailnet
// only. Setup reads what is mapped already and never changes a mapping it did not
// make: it reuses one that points at the bridge, or adds one on a free port. On Linux,
// tailscaled lets only root and the user it names its operator change what it serves
// (anyone may read it), so setup offers to name the person once, with sudo.

/** The CLI inside the Tailscale app, for Macs where it is not on the PATH. */
const appCLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** Where to get Tailscale for `os`. */
export function tailscaleDownload(os: HostOS = hostOS): string {
  return `https://tailscale.com/download/${os === "macos" ? "mac" : "linux"}`;
}

/** How to connect Tailscale on `os` once it is installed. */
export function tailscaleConnect(os: HostOS = hostOS): string {
  return os === "macos" ? "Open it and sign in." : "Run sudo tailscale up and sign in.";
}

/**
 * Whether Tailscale refused to change what it serves because this user may not: on Linux,
 * "Access denied: serve config denied", and its hint to set an operator.
 */
export function refusedToUser(message: string): boolean {
  return /access denied|--operator=/i.test(message);
}

/** Ports tried for a new mapping, in order. */
export const servePorts = Array.from({ length: 90 }, (_, index) => 10010 + index);

export interface TailscaleStatus {
  /** Signed in and connected. */
  running: boolean;
  /** The machine's name on the tailnet (`mac.tailnet.ts.net`, no final dot), or null without MagicDNS. */
  dnsName: string | null;
  /** HTTPS certificates are on for the tailnet, which `tailscale serve` needs. */
  https: boolean;
}

export interface ServeMapping {
  /** The port on the tailnet name. */
  port: number;
  /** Where it goes (`http://127.0.0.1:9120`). */
  proxy: string;
}

export interface ServeStatus {
  /** Every port something is served on (HTTPS, HTTP or TCP). */
  ports: Set<number>;
  /** The HTTPS ports that proxy the root path somewhere. */
  mappings: ServeMapping[];
}

export function parseStatus(text: string): TailscaleStatus {
  const data = JSON.parse(text) as { BackendState?: string; Self?: { DNSName?: string }; CertDomains?: string[] | null };
  const dnsName = data.Self?.DNSName?.replace(/\.$/, "") || null;
  return {
    running: data.BackendState === "Running",
    dnsName,
    https: Array.isArray(data.CertDomains) && data.CertDomains.length > 0,
  };
}

export function parseServeStatus(text: string): ServeStatus {
  const data = (text.trim() === "" ? {} : JSON.parse(text)) as {
    TCP?: Record<string, unknown>;
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  };
  const ports = new Set(Object.keys(data.TCP ?? {}).map(Number).filter(Number.isInteger));
  const mappings: ServeMapping[] = [];
  for (const [hostPort, web] of Object.entries(data.Web ?? {})) {
    const port = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
    const proxy = web.Handlers?.["/"]?.Proxy;
    if (Number.isInteger(port) && proxy) mappings.push({ port, proxy });
  }
  return { ports, mappings };
}

/** The mapping that already goes to the bridge on `bridgePort`, if any. */
export function mappingTo(status: ServeStatus, bridgePort: number): ServeMapping | undefined {
  const targets = new Set([`http://127.0.0.1:${bridgePort}`, `http://localhost:${bridgePort}`, `127.0.0.1:${bridgePort}`, `localhost:${bridgePort}`, `${bridgePort}`]);
  return status.mappings.find((mapping) => targets.has(mapping.proxy.replace(/\/$/, "")));
}

/** The first port of `servePorts` nothing is served on. */
export function freeServePort(status: ServeStatus): number | undefined {
  return servePorts.find((port) => !status.ports.has(port));
}

export class Tailscale {
  readonly path: string;
  private readonly system: System;

  private constructor(system: System, path: string) {
    this.system = system;
    this.path = path;
  }

  /** The installed CLI, or null when Tailscale is not installed. */
  static find(system: System): Tailscale | null {
    const path = programOverride("tailscale") ?? system.which("tailscale") ?? (isExecutable(appCLI) ? appCLI : null);
    return path ? new Tailscale(system, path) : null;
  }

  async status(): Promise<TailscaleStatus> {
    const result = await this.system.run(this.path, ["status", "--json"], { timeoutMs: 15_000 });
    // Stopped or signed out still prints JSON, with another BackendState.
    try {
      return parseStatus(result.stdout);
    } catch {
      return { running: false, dnsName: null, https: false };
    }
  }

  async serveStatus(): Promise<ServeStatus> {
    const result = await this.system.run(this.path, ["serve", "status", "--json"], { timeoutMs: 15_000 });
    if (result.code !== 0) throw new Error(firstLine(result.stderr) || "tailscale serve status failed");
    return parseServeStatus(result.stdout);
  }

  /** Maps HTTPS `port` on the tailnet name to `target`, in the background (it outlives this command). */
  async serve(port: number, target: string): Promise<{ ok: boolean; message: string }> {
    const result = await this.system.run(this.path, ["serve", "--bg", "--yes", `--https=${port}`, target], { timeoutMs: 60_000 });
    return { ok: result.code === 0, message: (result.stdout + result.stderr).trim() };
  }

  /**
   * Makes `user` Tailscale's operator, who may change what it serves without root, with
   * sudo in this terminal (it asks for the password). Linux only.
   */
  async makeOperator(user: string): Promise<{ ok: boolean; message: string }> {
    const sudo = programOverride("sudo") ?? this.system.which("sudo") ?? "/usr/bin/sudo";
    const result = await this.system.run(sudo, [this.path, "set", `--operator=${user}`], { timeoutMs: 120_000, inherit: true });
    return { ok: result.code === 0, message: (result.stdout + result.stderr).trim() };
  }

  /** Removes the mapping on HTTPS `port`. */
  async unserve(port: number): Promise<{ ok: boolean; message: string }> {
    const result = await this.system.run(this.path, ["serve", `--https=${port}`, "off"], { timeoutMs: 30_000 });
    return { ok: result.code === 0, message: (result.stdout + result.stderr).trim() };
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
