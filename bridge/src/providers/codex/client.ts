import WebSocket from "ws";
import { counters } from "../../counters.ts";
import { wellFormedJSON } from "../../json.ts";
import { log } from "../../log.ts";
import { JsonChild } from "../child.ts";
import { RpcClient, type Connected } from "../rpc.ts";
import type { InitializeResponse, RequestId } from "./types/index.ts";

// A JSON-RPC connection to `codex app-server` (docs/bridge-spikes.md, S1). Messages
// carry no "jsonrpc" key: `{id, method, params}` for requests, `{id, result|error}` for
// answers, `{method, params}` for notifications, in both directions.
//
// Two ways in, chosen by `codex.mode` in config.json:
//
// - shared: the app-server daemon every Codex on this Mac uses
//   (`~/.codex/app-server-control/app-server-control.sock`). It speaks WebSocket over
//   that unix socket, one message per text frame. Threads live on in the daemon when
//   the bridge stops, and a terminal and the phone can work on the same thread.
// - own: a `codex app-server` child process of the bridge's own, one message per line
//   on its stdin and stdout. The fallback, should the daemon not be usable.
//
// Each connection starts with `initialize` and `initialized`. When it drops, the client
// connects again with growing pauses (providers/rpc.ts) and says so (`connected(true)`),
// so the provider can resume the threads it follows.

/** One message as it travels. */
export interface RpcMessage {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** One open connection. */
export interface Transport {
  send(message: RpcMessage): void;
  close(): void;
}

export interface TransportHandlers {
  message(message: RpcMessage): void;
  /** The connection is gone, for whatever reason. Called once. */
  closed(reason: string): void;
}

/** Opens a connection; rejects when it cannot. */
export type Connector = (handlers: TransportHandlers) => Promise<Transport>;

/** A failed call: Codex's error code and message. */
export class CodexError extends Error {
  readonly code: number;
  /**
   * Codex has not taken the call: it answered with this error, or the call never went to
   * it. False when it may have (no answer came in time, or the connection dropped first).
   */
  readonly notTaken: boolean;

  constructor(code: number, message: string, notTaken = false) {
    super(message);
    this.code = code;
    this.notTaken = notTaken;
  }
}

// MARK: Connectors

/** The shared daemon's socket, through `ws+unix`. */
export function socketConnector(socketPath: string): Connector {
  return (handlers) =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      let open = false;
      let ended = false;
      const end = (reason: string) => {
        if (ended) return;
        ended = true;
        handlers.closed(reason);
      };
      socket.on("open", () => {
        open = true;
        resolve({
          send: (message) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(wellFormedJSON(message));
          },
          close: () => socket.close(),
        });
      });
      socket.on("message", (data) => {
        let message: RpcMessage;
        try {
          message = JSON.parse(data.toString()) as RpcMessage;
        } catch {
          log.debug("Codex sent a frame that is not JSON");
          return;
        }
        // `null` is JSON too, but no message.
        if (message && typeof message === "object") handlers.message(message);
      });
      socket.on("error", (error) => {
        if (!open) reject(error);
        else log.debug("Codex socket error", { error: error.message });
      });
      socket.on("close", (code) => {
        if (open) end(`the socket closed (${code})`);
        else reject(new Error(`the socket closed before it opened (${code})`));
      });
    });
}

/** A `codex app-server` of the bridge's own, over stdio. */
export function processConnector(codexPath: string, env: NodeJS.ProcessEnv): Connector & { close(): Promise<void> } {
  const children = new Set<JsonChild>();
  let closed = false;
  const connect: Connector = (handlers) =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error("the own Codex connector is closed"));
        return;
      }
      if (counters.on) counters.spawned("codex");
      const child = new JsonChild({
        name: "codex app-server",
        command: codexPath,
        args: ["app-server"],
        env,
        cwd: process.cwd(),
        listener: {
          message: (message) => {
            if (message && typeof message === "object") handlers.message(message as RpcMessage);
          },
          exited: (exit) => {
            if (exit.error) reject(new Error(exit.error));
            handlers.closed(exit.error ?? `codex app-server exited (${exit.signal ?? exit.code})`);
            // A crash can leave descendants being stopped. Keep it until that is done,
            // so provider shutdown waits for old connections as well as the current one.
            void child.stop().then(() => children.delete(child));
          },
        },
      });
      children.add(child);
      if (child.pid !== undefined) {
        resolve({
          send: (message) => { child.send(message); },
          close: () => { void child.stop(); },
        });
      }
    });
  return Object.assign(connect, {
    async close(): Promise<void> {
      closed = true;
      await Promise.all([...children].map((child) => child.stop()));
    },
  });
}

// MARK: The client

export interface ClientListener {
  notification(method: string, params: any): void;
  /** A request from Codex. Answer it with `respond` or `respondError`, by the same id. */
  request(id: RequestId, method: string, params: any): void;
  /** The handshake is done; `again` after a reconnect. */
  connected(again: boolean): void;
  disconnected(reason: string): void;
}

export interface ClientOptions {
  connect: Connector;
  clientInfo: { name: string; title: string; version: string };
  /** Seconds between attempts after a drop; the last one repeats. */
  backoff?: number[];
  /** Milliseconds a call waits for its answer. */
  timeoutMs?: number;
  /** Milliseconds a call waits for the connection before it gives up. */
  readyMs?: number;
  /** Before each attempt to connect (start the daemon when its socket is missing). */
  prepare?: () => Promise<void>;
}

export class CodexClient {
  private readonly rpc: RpcClient<RpcMessage, ClientListener, number>;
  private readonly clientInfo: ClientOptions["clientInfo"];
  private serverUserAgent: string | null = null;

  constructor(options: ClientOptions) {
    this.clientInfo = options.clientInfo;
    this.rpc = new RpcClient({
      name: "Codex",
      connect: (handlers) => options.connect({ message: handlers.frame, closed: handlers.closed }),
      backoff: options.backoff,
      timeoutMs: options.timeoutMs,
      readyMs: options.readyMs ?? 15_000,
      // Awaited before every attempt, given or not: an attempt begins a step after it is made, as it always has.
      prepare: () => options.prepare?.(),
      request: (id, method, params) => ({ id, frame: { id, method, params } }),
      receive: (message) => this.receive(message),
      handshake: () => this.handshake(),
      // Not taken, unless it may have reached Codex: no answer came in time, or the connection dropped first.
      error: (why, message) => new CodexError(why === "timed out" ? -32001 : -32000, message, why !== "timed out" && why !== "dropped"),
    });
  }

  get isConnected(): boolean {
    return this.rpc.isConnected;
  }

  /** The version reported by this live app server, rather than an installed CLI. */
  get serverVersion(): string | null {
    return this.isConnected ? /\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(this.serverUserAgent ?? "")?.[1] ?? null : null;
  }

  get supportsMessageForks(): boolean {
    return this.versionAtLeast("0.166.0");
  }

  /** Checks the current handshake and sends without yielding to a reconnect between them. */
  async callVersioned<T>(method: string, params: unknown, minimum: string): Promise<T> {
    await this.whenReady();
    if (!this.versionAtLeast(minimum)) throw new CodexError(-32601, `This Codex app server must be version ${minimum} or newer to branch at a message.`, true);
    return this.rpc.send<T>(method, params);
  }

  private versionAtLeast(minimum: string): boolean {
    const version = this.serverVersion;
    if (!version) return false;
    const actual = version.split(".").map(Number);
    const required = minimum.split(".").map(Number);
    for (let index = 0; index < required.length; index += 1) {
      if (actual[index] !== required[index]) return actual[index] > required[index];
    }
    return true;
  }

  listen(listener: ClientListener): () => void {
    return this.rpc.listen(listener);
  }

  /** Connects (once); on failure keeps trying in the background. Resolves after the first attempt either way. */
  start(): Promise<void> {
    return this.rpc.start();
  }

  /** Waits until the client is connected, at most `timeoutMs`. */
  whenReady(timeoutMs?: number): Promise<void> {
    return this.rpc.whenReady(timeoutMs);
  }

  /** Calls a method and waits for its result. Throws `CodexError` for an error answer. */
  call<T = any>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    return this.rpc.call<T>(method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    this.rpc.transport?.send(params === undefined ? { method } : { method, params });
  }

  respond(id: RequestId, result: unknown): void {
    this.rpc.transport?.send({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.rpc.transport?.send({ id, error: { code, message } });
  }

  close(): void {
    this.rpc.close();
  }

  private async handshake(): Promise<Connected<ClientListener>> {
    this.serverUserAgent = null;
    const initialized = await this.rpc.send<InitializeResponse>("initialize", {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.serverUserAgent = initialized.userAgent;
    this.notify("initialized");
    return { tell: (listener, again) => listener.connected(again) };
  }

  private receive(message: RpcMessage): void {
    if (message.method !== undefined) {
      const { id, method } = message;
      if (id !== undefined && id !== null) {
        this.rpc.tell("a request from Codex", { method }, (listener) => listener.request(id, method, message.params ?? {}));
      } else {
        this.rpc.tell("a notification from Codex", { method }, (listener) => listener.notification(method, message.params ?? {}));
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = this.rpc.answered(message.id);
    if (!waiting) return;
    if (message.error) waiting.reject(new CodexError(message.error.code, message.error.message, true));
    else waiting.resolve(message.result);
  }
}
