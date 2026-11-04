import "./environment.ts";
import fs, { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startBridge, type BridgeOptions, type RunningBridge } from "../src/bridge.ts";
import { hashPassword } from "../src/http/auth.ts";
import { setLogLevel } from "../src/log.ts";
import type { Provider } from "../src/providers/types.ts";

// A bridge in a folder of its own on port 0, and a client that connects to it the way
// the app does: sign in, ticket, WebSocket, wait for gateway.ready, client.capabilities.

setLogLevel("silent");

export const username = "tester";
export const password = "correct horse battery";

let hash: Promise<string> | undefined;

export interface TestBridge extends RunningBridge {
  /** Stops the bridge and deletes its folder. */
  dispose(): Promise<void>;
}

export interface TestBridgeOptions {
  /** Merged into config.json. */
  config?: Record<string, unknown>;
  logCapacity?: number;
  /** Reuse a folder (a restart); its config is kept. */
  home?: string;
  /** Leave the folder in place on dispose, for a restart. */
  keepHome?: boolean;
  /** Agents to run instead of the scripted one. */
  providers?: Map<string, Provider>;
  /** Folders never offered for being temporary; [] offers the test's own folders. */
  temporaryFolders?: string[];
  /** The user's home folder, searched for folders (feature folder_search). */
  userHome?: string;
  /** How long another Mac's word on which threads its threads keep at work holds here, and how often this one says it again, in ms (feature held_elsewhere). */
  held?: { for?: number; every?: number };
  /** The waits before each new try at a starter's notice that could not be sent, in ms (`Fleet`'s `noticeRetries`). */
  noticeRetries?: number[];
  /** For the check for a later version, when a test turns it on (`updates.check`; feature update_notice): its own registry. */
  updates?: BridgeOptions["updates"];
  /** For the reading of the free space on the bridge's disk (feature disk_space): its own `statfs`. Else a disk with plenty of room, whatever the test machine's has. */
  disk?: BridgeOptions["disk"];
}

/** A volume of 500 GB with 200 GB free, for the tests that do not look at the disk: a full one on the test machine does not tell their threads so. */
export const roomyDisk: NonNullable<BridgeOptions["disk"]>["statfs"] = async () => ({ bsize: 1000, blocks: 500e6, bavail: 200e6 });

/**
 * Makes every write of a file whose path starts with `prefix` fail as on a full disk
 * (`ENOSPC`), or with `code`, until what this returns is called or the test ends.
 */
export function failingWrites(t: { after(fn: () => void): void }, prefix: string, code = "ENOSPC"): () => void {
  const real = fs.writeFileSync;
  const restore = () => {
    fs.writeFileSync = real;
    syncBuiltinESMExports();
  };
  t.after(restore);
  fs.writeFileSync = ((...args: Parameters<typeof real>) => {
    if (String(args[0]).startsWith(prefix)) throw Object.assign(new Error(`${code}: no space left on device, write`), { code });
    return real(...args);
  }) as typeof real;
  syncBuiltinESMExports();
  return restore;
}

export function temporaryHome(): string {
  return mkdtempSync(join(tmpdir(), "portals-bridge-test-"));
}

export async function startTestBridge(options: TestBridgeOptions = {}): Promise<TestBridge> {
  const home = options.home ?? temporaryHome();
  if (!options.home) {
    hash ??= hashPassword(password);
    // The scripted agent only: tests never start Claude Code, Pi or Cursor, reach Codex
    // or Hermes, or send through the relay or open its tunnel (unless a test asks). Threads run in the temporary folder unless a
    // test names another General.
    const config = {
      port: 0,
      auth: { username, passwordHash: await hash },
      generalFolder: realpathSync(tmpdir()),
      fake: { delayMs: 1 },
      ...options.config,
      providers: {
        claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, fake: true,
        ...(options.config?.providers as Record<string, boolean> | undefined),
      },
      push: { relay: null, ...(options.config?.push as Record<string, unknown> | undefined) },
      relay: { enabled: false, ...(options.config?.relay as Record<string, unknown> | undefined) },
      // Nor ask npm's registry for the latest version (unless a test asks).
      updates: { check: false, ...(options.config?.updates as Record<string, unknown> | undefined) },
      // A starter told of its threads' turns gets turns of its own: only the tests of it ask.
      fleet: { tellStarters: false, ...(options.config?.fleet as Record<string, unknown> | undefined) },
    };
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
  }
  const bridge = await startBridge({ home, logCapacity: options.logCapacity, providers: options.providers, temporaryFolders: options.temporaryFolders, userHome: options.userHome, held: options.held, noticeRetries: options.noticeRetries, updates: options.updates, disk: { statfs: roomyDisk, ...options.disk } });
  return {
    ...bridge,
    async dispose() {
      await bridge.close();
      if (!options.keepHome) rmSync(home, { recursive: true, force: true });
    },
  };
}

export async function signIn(bridge: RunningBridge, as = { username, password }): Promise<Response> {
  return fetch(`${bridge.url}/auth/password-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ provider: "basic", ...as }),
  });
}

/** Signs in and returns the session cookie, as `name=value`. */
export async function sessionCookie(bridge: RunningBridge): Promise<string> {
  const response = await signIn(bridge);
  if (response.status !== 200) throw new Error(`sign-in answered ${response.status}`);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

export async function mintTicket(bridge: RunningBridge, cookie?: string): Promise<string> {
  const response = await fetch(`${bridge.url}/api/auth/ws-ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie ?? (await sessionCookie(bridge)) },
    body: "{}",
  });
  if (response.status !== 200) throw new Error(`ws-ticket answered ${response.status}`);
  return ((await response.json()) as { ticket: string }).ticket;
}

export function socketURL(bridge: RunningBridge, query: string): string {
  return `${bridge.url.replace(/^http/, "ws")}/api/ws${query}`;
}

/** Resolves with the close code once the socket closes. */
export function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

/** A frame as JSON: tests read whatever keys they check. */
export type Frame = any;

export class RpcFailure extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface OpenOptions {
  /** Send client.capabilities with server_requests (default true). */
  takesRequests?: boolean;
  /** More keys of client.capabilities, such as `poll_now`. */
  capabilities?: Record<string, unknown>;
  /** A net member's token: signed in with it (`Authorization: Bearer`), with no ticket (feature net). */
  token?: string;
}

export class TestClient {
  readonly socket: WebSocket;
  /** Every frame received, in order. */
  readonly frames: Frame[] = [];
  readonly closed: Promise<number>;
  private cursor = 0;
  private nextID = 1;
  private waiters: (() => void)[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.closed = closeCode(socket);
    socket.on("message", (data) => {
      const text = data.toString();
      this.frames.push(JSON.parse(text));
      for (const wake of this.waiters.splice(0)) wake();
    });
    socket.on("close", () => {
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  static async open(bridge: RunningBridge, options: OpenOptions = {}): Promise<TestClient> {
    // Without compression, which the app asks for (http.test.ts): what a test sends at
    // once is then read at once, where a compressed frame waits its turn to be inflated.
    const client =
      options.token !== undefined
        ? new TestClient(new WebSocket(socketURL(bridge, ""), { perMessageDeflate: false, headers: { Authorization: `Bearer ${options.token}` } }))
        : new TestClient(new WebSocket(socketURL(bridge, `?ticket=${encodeURIComponent(await mintTicket(bridge))}`), { perMessageDeflate: false }));
    await client.next((frame) => frame.method === "event" && frame.params?.type === "gateway.ready");
    await client.call("client.capabilities", { server_requests: options.takesRequests ?? true, ...options.capabilities });
    return client;
  }

  get readyPayload(): Frame {
    return this.frames.find((frame) => frame.params?.type === "gateway.ready")?.params.payload;
  }

  /** Waits until some frame satisfies `predicate`, searching every frame received so far. */
  async find(predicate: (frame: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    return this.wait(() => this.frames.find(predicate), timeoutMs);
  }

  /** The first frame at or after index `start` that satisfies `predicate`. */
  async from(start: number, predicate: (frame: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    return this.wait(() => this.frames.slice(start).find(predicate), timeoutMs);
  }

  /** The next frame after the last one `next` returned that satisfies `predicate`. */
  async next(predicate: (frame: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    return this.wait(() => {
      for (let index = this.cursor; index < this.frames.length; index += 1) {
        if (predicate(this.frames[index])) {
          this.cursor = index + 1;
          return this.frames[index];
        }
      }
      return undefined;
    }, timeoutMs);
  }

  /** The next event of `type` (for `session`, when given). */
  nextEvent(type: string, session?: string, timeoutMs = 5000): Promise<Frame> {
    return this.next((frame) => frame.method === "event" && frame.params.type === type && (!session || frame.params.session_id === session), timeoutMs).then(
      (frame) => frame.params,
    );
  }

  /** The next question the bridge asks (`approval` or `clarify`). */
  nextRequest(timeoutMs = 5000): Promise<Frame> {
    return this.next((frame) => typeof frame.id === "string" && frame.id.startsWith("srq-") && typeof frame.method === "string", timeoutMs);
  }

  /** Sends a request and returns the whole response frame. */
  async request(method: string, params: Record<string, unknown> = {}, id: unknown = `r${this.nextID++}`): Promise<Frame> {
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.find((frame) => frame.id === id && frame.method === undefined && ("result" in frame || "error" in frame));
  }

  /** Sends a request and returns its result, or throws `RpcFailure`. */
  async call(method: string, params: Record<string, unknown> = {}): Promise<Frame> {
    const response = await this.request(method, params);
    if (response.error) throw new RpcFailure(response.error.code, response.error.message);
    return response.result;
  }

  /** Answers one of the bridge's questions. */
  answer(id: string, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  send(frame: unknown): void {
    this.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /** The event params received for `session`, in order. */
  events(session: string): Frame[] {
    return this.frames.filter((frame) => frame.method === "event" && frame.params.session_id === session).map((frame) => frame.params);
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close();
    await this.closed;
  }

  private wait<T>(check: () => T | undefined, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      const attempt = () => {
        const found = check();
        if (found !== undefined) {
          clearTimeout(timer);
          resolve(found);
        } else if (this.socket.readyState === WebSocket.CLOSED) {
          clearTimeout(timer);
          reject(new Error("the socket closed while waiting for a frame"));
        } else {
          this.waiters.push(attempt);
        }
      };
      attempt();
    });
  }
}

/** Creates a fake-agent thread on `client` and returns its id. */
export async function createThread(client: TestClient, params: Record<string, unknown> = {}): Promise<string> {
  const result = await client.call("session.create", { profile: "fake", source: "tui", ...params });
  return result.session_id;
}

/** Sends a message and waits for its turn's `message.complete`. Returns the turn's events. */
export async function runTurn(client: TestClient, session: string, text: string): Promise<Frame[]> {
  const before = client.events(session).length;
  const start = client.frames.length;
  const submitted = await client.call("prompt.submit", { session_id: session, text, profile: "fake" });
  if (submitted.status !== "streaming") throw new Error(`expected a new turn, got ${submitted.status}`);
  await client.from(start, (frame) => isEvent(frame, "message.complete", session));
  return client.events(session).slice(before);
}

export function isEvent(frame: Frame, type: string, session?: string): boolean {
  return frame.method === "event" && frame.params?.type === type && (!session || frame.params.session_id === session);
}

/** The reply text a run of events streamed. */
export function streamedText(events: Frame[], type = "message.delta"): string {
  return events.filter((event) => event.type === type).map((event) => event.payload.text).join("");
}

/**
 * A turn's end (`message.complete`'s payload, or its last stored message) without what
 * the turn spent (feature `turn_usage`), whose time varies from run to run, nor which turn
 * it was as the list numbers it (`turn`, a revision, which differs with what else the test
 * did): for the tests that compare the rest. It must have a time, from 0 up, and a `turn`,
 * when there is one, is a revision.
 */
export function unspent(payload: Record<string, any>): Record<string, any> {
  const { turn_usage: spent, turn, ...rest } = payload;
  if (typeof spent?.seconds !== "number" || !(spent.seconds >= 0)) throw new Error(`the turn's end says no time spent: ${JSON.stringify(spent)}`);
  if (turn !== undefined && !(Number.isInteger(turn) && turn > 0)) throw new Error(`the turn's end names no turn: ${JSON.stringify(turn)}`);
  return rest;
}
