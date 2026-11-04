import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { serveConnector, type Connector, type Frame } from "../src/providers/hermes/client.ts";

// A stand-in for `hermes serve` that plays turns captured from Hermes 0.21.5: the
// app's own fixtures (Packages/PortalsKit/Tests/HermesBackendTests/Fixtures), which
// are what Hermes sent the app and what the app sent back. A fixture is played from the
// call that starts it (a `prompt.submit`, a `session.resume`): what Hermes sent is sent
// again, with the fixture's session ids swapped for the test's; a question waits for
// the bridge's answer, and a call the app made next (a `session.interrupt`) waits for
// the bridge to make it. Everything else gets a plain answer.

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../Packages/PortalsKit/Tests/HermesBackendTests/Fixtures");

interface Line {
  dir: "in" | "out";
  frame: Frame;
}

export function fixture(name: string): Line[] {
  return readFileSync(join(fixtures, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

export interface Call {
  method: string;
  params: Frame;
  id: string;
  connection: number;
}

interface Played {
  name: string;
  /** Calls the app made next that the bridge does not (it never asks for events it already has): passed over. */
  skip: string[];
  /** A call the app made next after which this Hermes says nothing more of the turn: it answers it, and the rest is not played. */
  stopAt?: string;
}

interface Connection {
  socket: WebSocket;
  number: number;
}

interface FakeSession {
  stored: string;
  runtime: string;
  profile: string;
  cwd: string;
  messages: Frame[];
  title: string | null;
  hidden?: boolean;
  /** Unix seconds. */
  startedAt?: number;
}

export class FakeHermes {
  readonly server: WebSocketServer;
  readonly token = "test-session-token";
  epoch = "epoch-1";
  readonly calls: Call[] = [];
  /** The bridge's answers to Hermes's requests, by request id. */
  readonly answers = new Map<string, Frame>();
  readonly sessions = new Map<string, FakeSession>();
  profiles: Frame[] = [
    { name: "default", is_default: true, model: null, provider: null, description: "", display_name: "" },
    { name: "aeri", is_default: false, model: null, provider: null, description: "", display_name: "" },
  ];
  modelOptions: Frame = {
    providers: [
      { slug: "gmi", name: "GMI Cloud", models: ["zai-org/GLM-5.3-Flash", "google/gemini-3.8-flash"], authenticated: true },
      { slug: "openrouter", name: "OpenRouter", models: ["x/y"], authenticated: false },
    ],
    model: "zai-org/GLM-5.3-Flash",
    provider: "gmi",
  };
  reasoning = "medium";
  /** What the next `prompt.submit` of a session plays, by stored id. */
  readonly turns = new Map<string, Played>();
  /** What the next `session.resume` of a session plays, by stored id. */
  readonly resumes = new Map<string, Played>();
  /** Answered by `session.active_list`. */
  active: Frame[] = [];
  /** What `session.compress` answers; it fails with `compressFails` when that is set. */
  compressResult: Frame = {
    status: "compressed", removed: 7, before_messages: 10, after_messages: 3, before_tokens: 24_063, after_tokens: 3_100,
    summary: { headline: "Compressed: 10 → 3 messages", token_line: "Rough transcript estimate: ~24,063 → ~3,100 tokens", note: null, noop: false, aborted: false },
  };
  compressFails: { code: number; message: string } | null = null;
  /** `session.list` fails with this when set. */
  listFails: { code: number; message: string } | null = null;
  /** What `commands.catalog` answers, as Hermes 0.22.5 shapes it. */
  catalog: Frame = {
    pairs: [["/context", "Show detailed context window view"], ["/model", "Switch model"], ["/plan", "Write a markdown implementation plan"], ["/yolo", "Toggle YOLO mode"], ["/tidy", "Tidy a folder"]],
    categories: [{ name: "Session", pairs: [["/context", "Show detailed context window view"], ["/plan", "Write a markdown implementation plan"]] }, { name: "Configuration", pairs: [["/model", "Switch model"], ["/yolo", "Toggle YOLO mode"]] }],
    skills: { "/tidy": { usage: 0, origin: "local" } },
  };
  /** What `usage.bars` answers. */
  usageBars: Frame = { ok: true, available: false };
  /** Each session's `yolo` (Hermes's for the session alone), by runtime id. */
  readonly yolo = new Map<string, boolean>();
  /** Runs when a `session.title` arrives, before it is taken (another app naming its session first). */
  onTitle: (params: Frame) => void = () => {};
  /** Runs when a `session.resume` arrives, before it is answered (once it settles, when it gives a promise). */
  onResume: (params: Frame) => void | Promise<void> = () => {};
  /** Runs when a `session.compress` arrives, before it is answered (once it settles, when it gives a promise). */
  onCompress: (params: Frame) => void | Promise<void> = () => {};
  private readonly connections = new Set<Connection>();
  private connectionCount = 0;
  private nextRuntime = 1;
  private readonly waiters: (() => void)[] = [];
  /** A player waiting for the bridge to call `method`, or to answer request `id`. */
  private readonly awaiting: { method?: string; answer?: string; resolve(frame: Frame): void }[] = [];

  private constructor(server: WebSocketServer) {
    this.server = server;
    server.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/api/ws" || url.searchParams.get("token") !== this.token) {
        socket.close(4401);
        return;
      }
      const connection = { socket, number: ++this.connectionCount };
      this.connections.add(connection);
      socket.on("close", () => this.connections.delete(connection));
      socket.on("message", (data) => this.receive(connection, JSON.parse(data.toString())));
      this.send(connection, { jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { heartbeat: true, replay_epoch: this.epoch } } });
    });
  }

  static async start(): Promise<FakeHermes> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    return new FakeHermes(server);
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** The real connector, given this server as the backend it found. */
  connector(): Connector {
    return serveConnector(async () => ({ host: "127.0.0.1", port: this.port, token: this.token, pid: process.pid }));
  }

  get connectionCountSoFar(): number {
    return this.connectionCount;
  }

  /** Drops every connection, as a dead socket would. */
  /** An event of no session to every connection, as Hermes's `sessions.changed` is. */
  broadcast(type: string, payload: Frame = {}): void {
    for (const connection of this.connections) this.send(connection, { jsonrpc: "2.0", method: "event", params: { type, session_id: "", payload } });
  }

  /** An event for a session, by its stored id, as Hermes sends a loaded session's. */
  tell(stored: string, type: string, payload: Frame = {}): void {
    const session = this.sessions.get(stored);
    if (!session?.runtime) throw new Error(`${stored} is not loaded`);
    for (const connection of this.connections) this.send(connection, { jsonrpc: "2.0", method: "event", params: { type, session_id: session.runtime, payload } });
  }

  dropAll(): void {
    for (const connection of this.connections) connection.socket.terminate();
  }

  /** Another run of Hermes: a new epoch, and no session loaded (their runtime ids go). */
  restart(): void {
    this.epoch = `epoch-${Number(this.epoch.split("-")[1]) + 1}`;
    for (const session of this.sessions.values()) session.runtime = "";
    // What was being played went with the old run.
    this.awaiting.length = 0;
    this.dropAll();
  }

  /** Plays `name` on the next `prompt.submit` of `stored`. */
  queueTurn(stored: string, name: string, skip: string[] = [], stopAt?: string): void {
    this.turns.set(stored, { name, skip, stopAt });
  }

  /** Plays `name` on the next `session.resume` of `stored`. */
  queueResume(stored: string, name: string, skip: string[] = []): void {
    this.resumes.set(stored, { name, skip });
  }

  /** A session Hermes has stored, as if made before the test. */
  addSession(stored: string, profile = "default", messages: Frame[] = [], title: string | null = null): void {
    this.sessions.set(stored, { stored, runtime: "", profile, cwd: "", messages, title, startedAt: 1_761_000_000 });
  }

  callsOf(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  async waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the fake Hermes");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 10);
      });
    }
  }

  async close(): Promise<void> {
    for (const connection of this.connections) connection.socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // MARK: Frames

  private send(connection: Connection, frame: Frame): void {
    if (connection.socket.readyState === connection.socket.OPEN) connection.socket.send(JSON.stringify(frame));
  }

  private receive(connection: Connection, frame: Frame): void {
    for (const wake of this.waiters.splice(0)) wake();
    if (typeof frame.method !== "string") {
      // An answer to one of Hermes's requests.
      this.answers.set(String(frame.id), frame);
      const index = this.awaiting.findIndex((entry) => entry.answer === String(frame.id));
      if (index >= 0) this.awaiting.splice(index, 1)[0].resolve(frame);
      return;
    }
    const call = { method: frame.method, params: frame.params ?? {}, id: String(frame.id), connection: connection.number };
    if (frame.method !== "gateway.ping") this.calls.push(call);
    const index = this.awaiting.findIndex((entry) => entry.method === frame.method);
    if (index >= 0) {
      this.awaiting.splice(index, 1)[0].resolve(frame);
      return;
    }
    void this.answer(connection, call);
  }

  private reply(connection: Connection, id: string, result: unknown): void {
    this.send(connection, { jsonrpc: "2.0", id, result });
  }

  private fail(connection: Connection, id: string, code: number, message: string): void {
    this.send(connection, { jsonrpc: "2.0", id, error: { code, message } });
  }

  private session(runtime: unknown): FakeSession | undefined {
    return [...this.sessions.values()].find((session) => session.runtime !== "" && session.runtime === runtime);
  }

  private async answer(connection: Connection, call: Call): Promise<void> {
    const { id, params } = call;
    switch (call.method) {
      case "client.capabilities":
        return this.reply(connection, id, { server_requests: ["approval", "clarify", "sudo", "secret"] });
      case "gateway.ping":
        return this.reply(connection, id, { ok: true });
      case "profiles.list":
        return this.reply(connection, id, { profiles: this.profiles });
      case "model.options":
        return this.reply(connection, id, this.modelOptions);
      case "config.get":
        return this.reply(connection, id, { value: this.reasoning });
      case "session.active_list":
        return this.reply(connection, id, { sessions: this.active });
      case "session.create": {
        const runtime = `rt${this.nextRuntime++}`;
        const stored = `20261009_000000_${runtime}`;
        // Kept with its title only once `session.title` names it, as Hermes keeps a session once it has a title or a message.
        this.sessions.set(stored, { stored, runtime, profile: params.profile ?? "default", cwd: params.cwd ?? "", messages: [], title: null, hidden: params.hidden === true, startedAt: 1_761_100_000 });
        return this.reply(connection, id, {
          session_id: runtime,
          stored_session_id: stored,
          message_count: 0,
          messages: [],
          info: { model: params.model ?? this.modelOptions.model, provider: params.provider ?? this.modelOptions.provider, cwd: params.cwd, profile_name: params.profile ?? "default" },
        });
      }
      case "session.resume": {
        await this.onResume(params);
        const session = this.sessions.get(params.session_id);
        if (!session) return this.fail(connection, id, 4007, "session not found");
        if (!session.runtime) session.runtime = `rt${this.nextRuntime++}`;
        const played = this.resumes.get(session.stored);
        if (played) {
          this.resumes.delete(session.stored);
          return this.play(connection, played, session, "session.resume", id);
        }
        return this.reply(connection, id, {
          session_id: session.runtime,
          running: false,
          messages: session.messages,
          info: { model: this.modelOptions.model, provider: this.modelOptions.provider, title: session.title ?? undefined },
        });
      }
      case "session.events.since":
        return this.reply(connection, id, { events: [], truncated: false, latest_seq: 0, open_requests: [] });
      case "prompt.submit": {
        const session = this.session(params.session_id);
        if (!session) return this.fail(connection, id, 4001, "session not found");
        const played = this.turns.get(session.stored);
        if (!played) return this.fail(connection, id, 5000, "the test queued no turn");
        this.turns.delete(session.stored);
        return this.play(connection, played, session, "prompt.submit", id);
      }
      case "image.attach_bytes":
        return this.reply(connection, id, { attached: true, name: params.filename });
      case "session.title": {
        this.onTitle(params);
        const session = this.session(params.session_id);
        if (!session) return this.fail(connection, id, 4001, "session not found");
        const taken = [...this.sessions.values()].some((other) => other !== session && other.profile === session.profile && other.title === params.title);
        if (taken) return this.fail(connection, id, 4000, `Title '${params.title}' is already in use by session x`);
        session.title = params.title;
        return this.reply(connection, id, { pending: false, title: params.title });
      }
      case "session.interrupt":
        return this.reply(connection, id, { status: "interrupted" });
      case "session.list": {
        if (this.listFails) return this.fail(connection, id, this.listFails.code, this.listFails.message);
        const profile = params.profile ?? "default";
        const rows = [...this.sessions.values()]
          .filter((session) => session.profile === profile && session.title !== null && (params.title === undefined || session.title === params.title))
          .filter((session) => params.include_hidden === true || session.hidden !== true)
          .map((session) => ({
            id: session.stored,
            resolved_id: session.stored,
            title: session.title,
            preview: String(session.messages.findLast((message) => message.role === "user" || message.role === "assistant")?.text ?? ""),
            started_at: session.startedAt ?? 1_761_000_000,
            message_count: session.messages.length,
            source: "tui",
          }));
        return this.reply(connection, id, { sessions: rows });
      }
      case "session.compress": {
        const session = this.session(params.session_id);
        if (!session) return this.fail(connection, id, 4001, "session not found");
        if (this.compressFails) return this.fail(connection, id, this.compressFails.code, this.compressFails.message);
        await this.onCompress(params);
        this.send(connection, { jsonrpc: "2.0", method: "event", params: { type: "status.update", session_id: session.runtime, payload: { kind: "compressing", text: "Compressing the conversation…" } } });
        return this.reply(connection, id, this.compressResult);
      }
      case "session.close":
        return this.reply(connection, id, { closed: true });
      case "config.set":
        if (params.key === "yolo") {
          if (params.scope !== "session") return this.fail(connection, id, 4000, "the fake Hermes changes yolo for one session only");
          this.yolo.set(params.session_id, params.value === "on");
          return this.reply(connection, id, { key: "yolo", value: params.value === "on" ? "1" : "0", scope: "session" });
        }
        return this.reply(connection, id, params.key === "model" ? { deferred: false } : {});
      case "commands.catalog":
        return this.reply(connection, id, this.catalog);
      case "slash.exec":
        return this.reply(connection, id, { output: `Hermes ran ${params.command}` });
      case "command.dispatch":
        return this.reply(connection, id, { type: params.name === "tidy" ? "skill" : "send", message: `[the ${params.name} prompt] ${params.arg ?? ""}`.trim() });
      case "usage.bars":
        return this.reply(connection, id, this.usageBars);
      case "subagent.interrupt":
        return this.reply(connection, id, { found: true, subagent_id: params.subagent_id });
      default:
        return this.fail(connection, id, 4000, `the fake Hermes has no ${call.method}`);
    }
  }

  // MARK: Playing a fixture

  private waitForCall(method: string): Promise<Frame> {
    return new Promise((resolve) => this.awaiting.push({ method, resolve }));
  }

  private waitForAnswer(id: string): Promise<Frame> {
    const given = this.answers.get(id);
    if (given) return Promise.resolve(given);
    return new Promise((resolve) => this.awaiting.push({ answer: id, resolve }));
  }

  /**
   * Plays a fixture from its first call of `method`, which the bridge has just made as
   * `bridgeID`, until its next `prompt.submit` or its end.
   */
  private async play(connection: Connection, played: Played, session: FakeSession, method: string, bridgeID: string): Promise<void> {
    const lines = fixture(played.name);
    const start = lines.findIndex((line) => line.dir === "out" && line.frame.method === method);
    if (start < 0) throw new Error(`${played.name} has no ${method}`);
    const trigger = lines[start].frame;
    // The fixture's ids, swapped for the test's in everything sent.
    const swaps = new Map<string, string>();
    const fixtureRuntime = method === "prompt.submit" ? trigger.params.session_id : runtimeIn(lines, start);
    if (fixtureRuntime) swaps.set(fixtureRuntime, session.runtime);
    const fixtureStored = method === "session.resume" ? trigger.params.session_id : storedIn(lines);
    if (fixtureStored) swaps.set(fixtureStored, session.stored);
    const swap = (frame: Frame): Frame => {
      let text = JSON.stringify(frame);
      for (const [from, to] of swaps) text = text.split(from).join(to);
      return JSON.parse(text);
    };
    /** Fixture request ids → the bridge's, for the answers to send. */
    const ids = new Map<string, string>([[String(trigger.id), bridgeID]]);
    /** Questions sent here, whose answers are awaited where they are sent. */
    const asked = new Set<string>();
    for (const line of lines.slice(start + 1)) {
      const frame = line.frame;
      if (frame.method === "gateway.ping" || (line.dir === "in" && frame.result?.ok === true && Object.keys(frame.result).length === 1)) continue;
      if (line.dir === "out") {
        if (frame.method === "prompt.submit") break;
        if (typeof frame.method === "string" && !played.skip.includes(frame.method)) {
          // The app called this next: wait for the bridge to.
          const made = await this.waitForCall(frame.method);
          ids.set(String(frame.id), String(made.id));
          if (frame.method === played.stopAt) {
            const answer = lines.find((other) => other.dir === "in" && other.frame.method === undefined && String(other.frame.id) === String(frame.id));
            if (answer) this.send(connection, { ...swap(answer.frame), id: String(made.id) });
            return;
          }
        } else if (frame.method === undefined && !asked.has(String(frame.id))) {
          // The answer to a question the resume answer listed as open.
          await this.waitForAnswer(String(frame.id));
        }
        continue;
      }
      if (frame.method === "event") {
        this.send(connection, swap(frame));
        continue;
      }
      if (typeof frame.method === "string") {
        // A question: sent, then answered by the bridge before anything else.
        asked.add(String(frame.id));
        this.send(connection, swap(frame));
        await this.waitForAnswer(String(frame.id));
        continue;
      }
      const answered = ids.get(String(frame.id));
      if (answered) this.send(connection, { ...swap(frame), id: answered });
    }
  }
}

/** The runtime id a fixture's resume answer gives. */
function runtimeIn(lines: Line[], start: number): string | undefined {
  const answer = lines.slice(start + 1).find((line) => line.dir === "in" && line.frame.id === lines[start].frame.id);
  return answer?.frame.result?.session_id;
}

/** The stored id a fixture's `session.create` answer gives. */
function storedIn(lines: Line[]): string | undefined {
  return lines.find((line) => line.dir === "in" && typeof line.frame.result?.stored_session_id === "string")?.frame.result.stored_session_id;
}
