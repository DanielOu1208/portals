import WebSocket from "ws";
import { log } from "../../log.ts";
import { RpcClient, type Connected } from "../rpc.ts";
import { socketURL, type ServeEndpoint } from "./serve.ts";

// A connection to `hermes serve`, speaking the gateway protocol the app speaks to it
// (docs/gateway-protocol.md): JSON-RPC 2.0 over one WebSocket, `gateway.ready` first,
// then `client.capabilities`, events as `{"method":"event"}` frames, approvals and
// questions as requests from Hermes with string ids. The bridge is one client of
// Hermes for all its Hermes threads, as the app is for a Hermes host.
//
// When the connection drops, the client connects again with growing pauses
// (providers/rpc.ts) and says so (`connected(again)`), so the provider can follow its
// threads again.

export type Frame = Record<string, any>;

/** One open connection. */
export interface Transport {
  send(frame: Frame): void;
  close(): void;
}

export interface TransportHandlers {
  frame(frame: Frame): void;
  /** The connection is gone, for whatever reason. Called once. */
  closed(reason: string): void;
}

/** Opens a connection; rejects when it cannot. */
export type Connector = (handlers: TransportHandlers) => Promise<Transport>;

/** A failed call: Hermes's error code and message. */
export class HermesError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** The WebSocket of the backend `locate` finds (serve.ts). */
export function serveConnector(locate: () => Promise<ServeEndpoint>): Connector {
  return async (handlers) => {
    const endpoint = await locate();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(socketURL(endpoint), { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
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
          send: (frame) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
          },
          close: () => socket.close(),
        });
      });
      socket.on("message", (data) => {
        let frame: Frame;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          log.debug("Hermes sent a frame that is not JSON");
          return;
        }
        if (frame && typeof frame === "object") handlers.frame(frame);
      });
      socket.on("error", (error) => {
        if (!open) reject(error);
        else log.debug("Hermes socket error", { error: error.message });
      });
      socket.on("close", (code) => {
        if (open) end(`the socket closed (${code})`);
        else reject(new Error(`the socket closed before it opened (${code})`));
      });
    });
  };
}

export interface ClientListener {
  /** An event: `session_id` is Hermes's runtime id; `seq` numbers the session's events. */
  event(type: string, sessionID: string | undefined, seq: number | undefined, payload: Frame): void;
  /** A request from Hermes (an approval, a question). Answer it with `respond`, by the same id. */
  request(id: string, method: string, params: Frame): void;
  /**
   * The handshake is done; `again` after a reconnect. `sameRun`: the same Hermes as
   * before (its replay epoch is unchanged), so its sessions and their events are still there.
   */
  connected(again: boolean, sameRun: boolean): void;
  disconnected(reason: string): void;
}

export interface ClientOptions {
  connect: Connector;
  /** Seconds between attempts after a drop; the last one repeats. */
  backoff?: number[];
  /** Milliseconds a call waits for its answer. */
  timeoutMs?: number;
  /** Milliseconds between pings; Hermes is taken for gone after three times as long without a frame. */
  pingMs?: number;
}

/** Hermes sends `gateway.ready` first, at once (the app waits 15 s). */
const readyTimeoutMs = 15_000;

export class HermesClient {
  private readonly options: ClientOptions;
  private readonly rpc: RpcClient<Frame, ClientListener, string>;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;
  /** Names the run of Hermes the connection reached; a new one has none of the old sessions loaded. */
  private epoch: string | null = null;
  /** Waits for `gateway.ready` on a connection being opened. */
  private greeting: { resolve(payload: Frame): void; reject(error: Error): void } | null = null;
  /** The attempt's greeting, which the handshake waits for. */
  private greeted: Promise<Frame> = Promise.resolve({});

  constructor(options: ClientOptions) {
    this.options = options;
    this.rpc = new RpcClient({
      name: "Hermes",
      connect: (handlers) => {
        // Timed from before the connector finds Hermes (and starts it, if need be).
        this.greeted = this.awaitGreeting();
        return options.connect(handlers);
      },
      backoff: options.backoff,
      timeoutMs: options.timeoutMs,
      readyMs: 20_000,
      // Strings, as the app's: Hermes's own requests use `srq-…`, so the two never meet.
      request: (n, method, params) => {
        const id = `b${n}`;
        return { id, frame: { jsonrpc: "2.0", id, method, params } };
      },
      receive: (frame) => this.receive(frame),
      handshake: (generation) => this.handshake(generation),
      dropped: (reason) => {
        this.greeting?.reject(new Error(`the connection closed before Hermes greeted it (${reason})`));
        this.greeting = null;
        this.stopPings();
      },
      // Its close counts for nothing now, so a greeting still awaited is let go of here.
      closing: () => {
        this.greeting?.reject(new Error("The connection to Hermes was closed."));
        this.greeting = null;
        this.stopPings();
      },
      // A call's failure is Hermes's error, with its code; a wait's is a sentence.
      error: (why, message) => (why === "closed" || why === "not reachable" ? new Error(message) : new HermesError(why === "timed out" ? -32001 : -32000, message)),
    });
  }

  get isConnected(): boolean {
    return this.rpc.isConnected;
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

  /** Calls a method and waits for its result. Throws `HermesError` for an error answer. */
  call<T = any>(method: string, params: Frame, timeoutMs?: number): Promise<T> {
    return this.rpc.call<T>(method, params, timeoutMs);
  }

  respond(id: string, result: unknown): void {
    this.rpc.transport?.send({ jsonrpc: "2.0", id, result });
  }

  respondError(id: string, code: number, message: string): void {
    this.rpc.transport?.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  close(): void {
    this.rpc.close();
  }

  // MARK: Connecting

  private awaitGreeting(): Promise<Frame> {
    const greeted = new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Hermes did not greet the connection in time.")), readyTimeoutMs);
      timer.unref();
      this.greeting = {
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
    greeted.catch(() => undefined);
    return greeted;
  }

  private async handshake(generation: number): Promise<Connected<ClientListener>> {
    this.lastFrameAt = Date.now();
    const ready = await this.greeted;
    await this.rpc.send("client.capabilities", { server_requests: true });
    const epoch = typeof ready.replay_epoch === "string" ? ready.replay_epoch : null;
    const sameRun = epoch !== null && epoch === this.epoch;
    this.epoch = epoch;
    return {
      tell: (listener, again) => listener.connected(again, sameRun),
      ready: ready.heartbeat ? () => this.startPings(generation) : undefined,
    };
  }

  /** Pings while connected, and drops a connection Hermes has gone quiet on (behind a dead socket). */
  private startPings(generation: number): void {
    const every = this.options.pingMs ?? 15_000;
    this.pingTimer = setInterval(() => {
      if (this.rpc.generation !== generation) return;
      if (Date.now() - this.lastFrameAt > every * 3) {
        log.warn("Hermes went quiet; connecting again");
        const transport = this.rpc.transport;
        this.rpc.dropped("no frame for too long");
        transport?.close();
        return;
      }
      this.rpc.send("gateway.ping", {}).catch(() => undefined);
    }, every);
    this.pingTimer.unref();
  }

  private stopPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  // MARK: Frames

  private receive(frame: Frame): void {
    this.lastFrameAt = Date.now();
    if (frame.method === "event") {
      const params = frame.params ?? {};
      if (typeof params.type !== "string") return;
      if (params.type === "gateway.ready") {
        this.greeting?.resolve(params.payload ?? {});
        this.greeting = null;
        return;
      }
      // Nothing counts before the greeting, as for the app.
      if (!this.rpc.isConnected && this.greeting) return;
      const sessionID = typeof params.session_id === "string" && params.session_id !== "" ? params.session_id : undefined;
      const seq = Number.isInteger(params.seq) ? (params.seq as number) : undefined;
      this.rpc.tell("an event from Hermes", { event: params.type }, (listener) => listener.event(params.type, sessionID, seq, params.payload ?? {}));
      return;
    }
    if (typeof frame.method === "string") {
      const id = frame.id;
      if (typeof id !== "string" && typeof id !== "number") return;
      if (frame.method === "gateway.ping") {
        this.respond(String(id), { ok: true });
        return;
      }
      this.rpc.tell("a request from Hermes", { method: frame.method }, (listener) => listener.request(String(id), frame.method, frame.params ?? {}));
      return;
    }
    const id = typeof frame.id === "string" || typeof frame.id === "number" ? String(frame.id) : null;
    if (id === null) return;
    const waiting = this.rpc.answered(id);
    if (!waiting) return;
    if (frame.error) waiting.reject(new HermesError(Number(frame.error.code ?? -32000), String(frame.error.message ?? "Hermes refused the call.")));
    else waiting.resolve(frame.result ?? null);
  }
}
