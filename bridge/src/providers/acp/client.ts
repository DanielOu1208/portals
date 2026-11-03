import { JsonChild, type ChildExit } from "../child.ts";
import { methodNotFoundCode, protocolVersion, type InitializeResult, type RpcId } from "./protocol.ts";

// One run of an agent that speaks the Agent Client Protocol: its process (../child.ts
// starts it, cuts its output into lines and ends it), and JSON-RPC 2.0 with it, one
// message per line (./protocol.ts). The bridge is the protocol's client: it starts the
// agent, says hello with `initialize`, and from then on both sides send requests and
// notifications.
//
// A client is one process. When that ends, for whatever reason, every waiting call
// fails with `AgentStopped`, the listener is told once, and the client is done: the
// provider makes another when the agent is next needed.
//
// Nothing here knows which agent runs, or what a session is.

/** A call the agent answered with an error. */
export class AcpError extends Error {
  readonly code: number;
  /** What the agent added to the message; often the real reason. */
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** The agent's process ended before it answered, or was not running. */
export class AgentStopped extends Error {}

export interface ClientListener {
  notification(method: string, params: any): void;
  request(id: RpcId, method: string, params: any): void;
  /** The process is gone, or never started. Called once. */
  stopped(reason: string): void;
}

export interface ClientOptions {
  /** What to call the agent in messages: "Cursor". */
  name: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** The folder the process runs in. */
  cwd: string;
  clientInfo: { name: string; title: string; version: string };
  /** What the bridge says it can do, as `clientCapabilities` at hello. Nothing when left out. */
  capabilities?: Record<string, unknown>;
  listener: ClientListener;
  /** How long the agent has to start and answer `initialize`. */
  startTimeoutMs?: number;
}

interface Waiting {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | null;
}

/** One line of the agent's output, as far as it is a message. */
interface Message {
  id?: RpcId | null;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown } | null;
}

const startTimeoutMs = 60_000;
const callTimeoutMs = 60_000;

export class AcpClient {
  /** What the agent said of itself; null until it has started. */
  info: InitializeResult | null = null;
  private readonly options: ClientOptions;
  private child: JsonChild | null = null;
  private starting: Promise<InitializeResult> | null = null;
  private nextID = 1;
  private readonly waiting = new Map<RpcId, Waiting>();
  /** The process is gone and the listener was told. */
  private ended = false;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  /** The process runs, has answered `initialize`, and was not asked to stop. */
  get isRunning(): boolean {
    return this.info !== null && this.child?.running === true;
  }

  /** The process's id; undefined before it was started, or when it could not be. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Starts the process and says hello. Rejects when the agent does not start or does not speak this protocol. */
  start(): Promise<InitializeResult> {
    this.starting ??= this.launch();
    return this.starting;
  }

  private async launch(): Promise<InitializeResult> {
    const { name, command, args, env, cwd } = this.options;
    this.child = new JsonChild({
      name,
      command,
      args,
      env,
      cwd,
      listener: { message: (value) => this.receive(value), exited: (exit) => this.end(exit) },
    });
    // A program that is not there fails this call like any other end of the process.
    const info = await this.call<InitializeResult>(
      "initialize",
      { protocolVersion, clientCapabilities: this.options.capabilities ?? {}, clientInfo: this.options.clientInfo },
      this.options.startTimeoutMs ?? startTimeoutMs,
    ).catch((error: Error) => {
      void this.stop();
      throw error instanceof AgentStopped ? error : new AgentStopped(`${name} did not start: ${error.message}`);
    });
    if (info?.protocolVersion !== protocolVersion) {
      void this.stop();
      throw new AgentStopped(`${name} speaks version ${String(info?.protocolVersion)} of the Agent Client Protocol; Portals speaks version ${protocolVersion}.`);
    }
    this.info = info;
    return info;
  }

  /** A request to the agent. `timeoutMs` 0 waits as long as it takes (a turn). */
  call<T = any>(method: string, params: unknown, timeoutMs = callTimeoutMs): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.ended || !this.child) {
        reject(new AgentStopped(`${this.options.name} is not running.`));
        return;
      }
      const id = this.nextID++;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.waiting.delete(id);
              reject(new Error(`${this.options.name} did not answer ${method} within ${seconds(timeoutMs)}.`));
            }, timeoutMs)
          : null;
      timer?.unref();
      // One the process cannot take any more waits with the rest for its end, which says why.
      this.waiting.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  /** Ends the process and whatever it started in its own process group. Resolves once that is gone. */
  stop(): Promise<void> {
    return this.child?.stop() ?? Promise.resolve();
  }

  private send(message: Record<string, unknown>): void {
    this.child?.send({ jsonrpc: "2.0", ...message });
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Message;
    if (typeof message.method === "string") {
      if (message.id === undefined || message.id === null) this.options.listener.notification(message.method, message.params ?? {});
      else this.options.listener.request(message.id, message.method, message.params ?? {});
      return;
    }
    if (message.id === undefined || message.id === null) return;
    // Not one of the bridge's calls, or one that was given up on: nothing waits for it.
    const waiting = this.waiting.get(message.id);
    if (!waiting) return;
    this.waiting.delete(message.id);
    if (waiting.timer) clearTimeout(waiting.timer);
    const error = message.error;
    if (error) {
      const text = typeof error.message === "string" && error.message !== "" ? error.message : "The agent answered with an error.";
      waiting.reject(new AcpError(typeof error.code === "number" ? error.code : 0, text, error.data));
    } else {
      waiting.resolve(message.result);
    }
  }

  private end(exit: ChildExit): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiting of this.waiting.values()) {
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.reject(new AgentStopped(exit.reason));
    }
    this.waiting.clear();
    this.options.listener.stopped(exit.reason);
  }
}

/** "60 seconds", "0.5 seconds". */
function seconds(ms: number): string {
  const count = Math.round(ms / 100) / 10;
  return `${count} second${count === 1 ? "" : "s"}`;
}

/** Answers a request the bridge has no part in: agents ask for an editor's services even when none were offered. */
export function refuse(client: AcpClient, id: RpcId, method: string): void {
  client.respondError(id, methodNotFoundCode, `Portals does not handle ${method}.`);
}
