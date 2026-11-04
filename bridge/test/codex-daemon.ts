import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { CodexError } from "../src/providers/codex/client.ts";
import { fixture, fixtureCwd, recordedThread, rewrite } from "./codex-fixtures.ts";

// A stand-in for Codex's shared app-server daemon: a WebSocket server on a unix socket
// that speaks JSON-RPC without the "jsonrpc" key, as the real one does. It keeps
// threads and turns, plays recorded turns (test/fixtures/codex) when the bridge starts
// one, tells every connection about every thread (as Codex does with status changes),
// and keeps a request open until some connection answers it, asking again whoever
// resumes the thread meanwhile.

type Json = any;

export class DaemonConnection {
  readonly socket: WebSocket;
  /** Every message from the client, in order. */
  readonly received: Json[] = [];
  readonly subscribed = new Set<string>();

  constructor(socket: WebSocket) {
    this.socket = socket;
  }

  send(message: Json): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

interface ThreadState {
  id: string;
  cwd: string;
  status: Json;
  turns: Json[];
  name: string | null;
  loaded: boolean;
  model: string;
  effort: string;
  approvalPolicy: Json;
  sandbox: Json;
  summary: string | null;
  /** Codex's plan mode or its default one, once a turn has set it. */
  collaborationMode: Json | null;
  /** Unix seconds. */
  updatedAt: number;
  /** The first message, as `thread/list` shows it. */
  preview: string;
  parentThreadId: string | null;
  source: Json;
}

interface OpenRequest {
  id: number;
  threadId: string;
  method: string;
  params: Json;
  settle: (answer: { result?: Json; error?: Json; from: DaemonConnection | "terminal" }) => void;
}

export interface Call {
  connection: DaemonConnection;
  method: string;
  params: Json;
}

export const testModels = [
  { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "", hidden: false, isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort, description: "" })) },
  { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6 Luna", description: "", hidden: false, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort, description: "" })) },
  { id: "gpt-reserve", model: "gpt-reserve", displayName: "Reserve", description: "", hidden: true, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
];

export class FakeDaemon {
  readonly folder: string;
  readonly socketPath: string;
  readonly connections: DaemonConnection[] = [];
  readonly threads = new Map<string, ThreadState>();
  readonly calls: Call[] = [];
  /** How each request was settled, in order. */
  readonly answers: { method: string; threadId: string; result?: Json; error?: Json; from: DaemonConnection | "terminal" }[] = [];
  readonly config: Json = { model: "gpt-6.1-sol", model_reasoning_effort: "high", model_reasoning_summary: null, approval_policy: "never", sandbox_mode: "danger-full-access" };
  /** A folder's own settings (its `.codex/config.toml`), over `config` when `config/read` names the folder. */
  readonly folderConfigs = new Map<string, Json>();
  /** Recordings to play, one per turn/start, in order. */
  readonly scripts: string[] = [];
  /** Turns still playing. */
  readonly playing: Promise<void>[] = [];
  /** False: the socket refuses new connections (the daemon is down). */
  accepting = true;
  /** The paged protocol; false stands in for an older app-server. */
  pagedHistory = false;
  historyPageSize = 2;
  /** Runs after a turns page is captured, before it is returned. */
  onTurnsRead: (params: Json) => void = () => {};
  /** While set, `turn/interrupt` is answered only once it resolves: Codex slow to take a Stop. */
  interruptHeld: Promise<void> | null = null;
  /** What `account/rateLimits/read` answers. */
  accountLimits: Json = {
    ordinaryUsageAllowed: true,
    rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1791337800 }, secondary: null, planType: "plus" },
    rateLimitsByLimitId: {
      codex_spark: {
        limitId: "codex_spark", limitName: "GPT-6.1-Spark", primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1791856800 }, secondary: null,
        credits: null, planType: "plus", rateLimitReachedType: "rate_limit_reached",
      },
      codex: {
        limitId: "codex", limitName: null, primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1791337800 },
        secondary: { usedPercent: 7.6, windowDurationMins: 10080, resetsAt: 1791856800 },
        credits: { hasCredits: true, unlimited: false, balance: "62500.0000000000" }, planType: "plus", rateLimitReachedType: null,
      },
    },
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
  };
  /** Runs when a `turn/steer` arrives, before it is answered. */
  onSteer: (params: Json) => void = () => {};
  /** Runs when a `thread/read` arrives, before it is answered (once it settles, when it gives a promise). */
  onRead: (params: Json) => void | Promise<void> = () => {};
  /** Runs when a `thread/resume` arrives, before it is answered: one that throws is Codex failing to resume. */
  onResume: (params: Json) => void | Promise<void> = () => {};
  /** Runs when a `config/read` arrives, before it is answered: one that throws is Codex failing to read. */
  onConfigRead: (params: Json) => void | Promise<void> = () => {};
  /** Runs when a `turn/start` arrives, before the turn starts and the call is answered. */
  onTurnStart: (params: Json) => void | Promise<void> = () => {};
  /** Runs when a `thread/list` arrives, before it is answered: one that throws is Codex failing to list. */
  onList: (params: Json) => void = () => {};
  /** Runs when a `thread/loaded/list` arrives, before it is answered. */
  onLoaded: (params: Json) => void = () => {};
  /** Ephemeral threads (Codex keeps nothing of them), as a title is asked for in one. */
  readonly ephemeral = new Set<string>();
  /** What a turn of an ephemeral thread answers: a title, as `outputSchema` asks for. */
  titleAnswer = JSON.stringify({ title: "Check the folder" });
  /** How a turn of an ephemeral thread ends. */
  titleStatus = "completed";
  /** Runs when a turn of an ephemeral thread starts, before it answers. */
  onTitleTurn: (params: Json) => void | Promise<void> = () => {};
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly open = new Map<number, OpenRequest>();
  private nextRequest = 1;
  private readonly callWaiters: { matches: (call: Call) => boolean; resolve: (call: Call) => void }[] = [];

  private constructor(folder: string) {
    this.folder = folder;
    this.socketPath = join(folder, "app-server-control.sock");
    this.server = createServer();
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (request, socket, head) => {
      if (!this.accepting) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    });
  }

  static async start(): Promise<FakeDaemon> {
    const daemon = new FakeDaemon(mkdtempSync(join(tmpdir(), "portals-codex-daemon-")));
    await new Promise<void>((resolve) => daemon.server.listen(daemon.socketPath, resolve));
    return daemon;
  }

  async close(): Promise<void> {
    for (const connection of this.connections) connection.socket.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.folder, { recursive: true, force: true });
  }

  /** Drops every connection, as a daemon restart or a network hiccup would. Threads and open requests stay. */
  dropAll(): void {
    for (const connection of this.connections.splice(0)) connection.socket.terminate();
  }

  /** The calls of one method so far. */
  callsOf(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** The first call from index `from` on that `matches`, once it is made. */
  waitForCall(matches: (call: Call) => boolean, from = this.calls.length): Promise<Call> {
    const made = this.calls.slice(from).find(matches);
    if (made) return Promise.resolve(made);
    return new Promise((resolve) => this.callWaiters.push({ matches, resolve }));
  }

  /** The next call of `method`. */
  nextCall(method: string): Promise<Call> {
    return this.waitForCall((call) => call.method === method);
  }

  /** Every connection hears it, whether it follows the thread or not. */
  broadcast(method: string, params: Json): void {
    this.observe(method, params);
    for (const connection of this.connections) connection.send({ method, params });
  }

  /**
   * Asks the connections that follow the thread (for a sub-agent's thread, those that
   * follow the thread it works for, as Codex does) and waits for the first answer from
   * anyone; then everyone hears `serverRequest/resolved`.
   */
  request(threadId: string, method: string, params: Json): Promise<{ result?: Json; error?: Json; from: DaemonConnection | "terminal" }> {
    const id = this.nextRequest++;
    return new Promise((resolve) => {
      this.open.set(id, {
        id,
        threadId,
        method,
        params,
        settle: (answer) => {
          this.open.delete(id);
          this.answers.push({ method, threadId, ...answer });
          this.broadcast("serverRequest/resolved", { threadId, requestId: id });
          resolve(answer);
        },
      });
      const asked = [threadId];
      for (let parent = this.threads.get(threadId)?.parentThreadId; parent; parent = this.threads.get(parent)?.parentThreadId) asked.push(parent);
      for (const connection of this.connections) if (asked.some((thread) => connection.subscribed.has(thread))) connection.send({ id, method, params });
    });
  }

  /** The requests waiting for an answer. */
  openRequests(): { id: number; threadId: string; method: string }[] {
    return [...this.open.values()].map(({ id, threadId, method }) => ({ id, threadId, method }));
  }

  /**
   * The id of the running turn of a thread, once it has one. `timeoutMs` only ends a wait
   * for a turn that never runs: on a busy Mac one may take more than 3 s to start.
   */
  async activeTurn(threadId: string, timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const thread = this.thread(threadId);
      const turn = thread.turns.at(-1);
      if (thread.status.type === "active" && turn?.status === "inProgress") return turn.id;
      if (Date.now() > deadline) throw new Error("no turn is running");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Codex finishes a turn by itself: a last message, then the end. */
  finishTurn(threadId: string, turnId: string, text = "Done.", status = "completed"): void {
    const item = { type: "agentMessage", id: `msg-${randomUUID()}`, text: "", phase: "final_answer", memoryCitation: null, delivery: null, questions: null };
    if (status === "completed") {
      this.broadcast("item/started", { threadId, turnId, item, startedAtMs: 1 });
      this.broadcast("item/agentMessage/delta", { threadId, turnId, itemId: item.id, delta: text });
      this.broadcast("item/completed", { threadId, turnId, item: { ...item, text }, completedAtMs: 2 });
    }
    this.broadcast("turn/completed", { threadId, turn: { id: turnId, items: [], itemsView: "summary", status, error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } });
  }

  /** Someone at a terminal answers first. */
  answerFromTerminal(id: number, result: Json): void {
    this.open.get(id)?.settle({ result, from: "terminal" });
  }

  // MARK: Threads

  /** A thread Codex has from before (made at the desk, or by an earlier run of the bridge). */
  addThread(
    cwd: string,
    turns: Json[] = [],
    options: { loaded?: boolean; status?: Json; name?: string | null; updatedAt?: number; preview?: string; parentThreadId?: string; source?: Json } = {},
  ): string {
    const id = randomUUID();
    this.threads.set(id, {
      id,
      cwd,
      status: options.status ?? (options.loaded ? { type: "idle" } : { type: "notLoaded" }),
      turns,
      name: options.name ?? null,
      loaded: options.loaded ?? false,
      model: this.config.model,
      effort: this.config.model_reasoning_effort,
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
      summary: null,
      collaborationMode: null,
      updatedAt: options.updatedAt ?? 1,
      preview: options.preview ?? "",
      parentThreadId: options.parentThreadId ?? null,
      source: options.source ?? "vscode",
    });
    return id;
  }

  private threadJSON(thread: ThreadState, turns: boolean, inProgress = false): Json {
    return {
      id: thread.id,
      cwd: thread.cwd,
      status: thread.status,
      name: thread.name,
      preview: thread.preview,
      parentThreadId: thread.parentThreadId,
      ephemeral: this.ephemeral.has(thread.id),
      modelProvider: "openai",
      model: thread.model,
      reasoningEffort: thread.effort,
      createdAt: 1,
      updatedAt: thread.updatedAt,
      source: thread.source,
      turns: turns
        ? thread.turns.map(({ started, ...turn }) => ({ ...structuredClone(turn), items: [...structuredClone(turn.items), ...(inProgress ? structuredClone(started ?? []) : [])] }))
        : [],
    };
  }

  private settings(thread: ThreadState): Json {
    return {
      model: thread.model,
      modelProvider: "openai",
      serviceTier: null,
      cwd: thread.cwd,
      approvalPolicy: thread.approvalPolicy,
      sandbox: thread.sandbox,
      reasoningEffort: thread.effort,
      collaborationMode: thread.collaborationMode,
    };
  }

  /** Keeps thread state in step with what is announced. */
  private observe(method: string, params: Json): void {
    const thread = this.threads.get(params?.threadId ?? params?.thread?.id);
    if (!thread) return;
    switch (method) {
      case "thread/status/changed":
        thread.status = params.status;
        break;
      case "turn/started":
        thread.status = { type: "active", activeFlags: [] };
        if (!thread.turns.some((turn) => turn.id === params.turn.id)) thread.turns.push({ ...structuredClone(params.turn), items: [] });
        break;
      case "item/started": {
        // Items in progress are only told by thread/resume, as Codex does.
        const turn = thread.turns.find((entry) => entry.id === params.turnId);
        if (turn) (turn.started ??= []).push(structuredClone(params.item));
        break;
      }
      case "item/completed": {
        const turn = thread.turns.find((entry) => entry.id === params.turnId);
        if (turn && !turn.items.some((item: Json) => item.id === params.item.id)) turn.items.push(structuredClone(params.item));
        if (turn?.started) turn.started = turn.started.filter((item: Json) => item.id !== params.item.id);
        break;
      }
      case "turn/completed": {
        const turn = thread.turns.find((entry) => entry.id === params.turn.id);
        if (turn) Object.assign(turn, { status: params.turn.status, error: params.turn.error, completedAt: params.turn.completedAt });
        thread.status = { type: "idle" };
        break;
      }
      case "thread/name/updated":
        thread.name = params.threadName ?? null;
        break;
      default:
        break;
    }
  }

  // MARK: Serving

  private accept(socket: WebSocket): void {
    const connection = new DaemonConnection(socket);
    this.connections.push(connection);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      connection.received.push(message);
      if (message.method !== undefined && message.id !== undefined) void this.serve(connection, message);
      else if (message.method === undefined && message.id !== undefined) this.answered(connection, message);
    });
    socket.on("close", () => {
      const index = this.connections.indexOf(connection);
      if (index >= 0) this.connections.splice(index, 1);
    });
  }

  private answered(connection: DaemonConnection, message: Json): void {
    const open = this.open.get(message.id);
    if (open) open.settle({ result: message.result, error: message.error, from: connection });
  }

  private async serve(connection: DaemonConnection, message: Json): Promise<void> {
    const call: Call = { connection, method: message.method, params: message.params ?? {} };
    this.calls.push(call);
    for (const waiter of [...this.callWaiters]) {
      if (waiter.matches(call)) {
        this.callWaiters.splice(this.callWaiters.indexOf(waiter), 1);
        waiter.resolve(call);
      }
    }
    try {
      const result = await this.handle(connection, call.method, call.params);
      connection.send({ id: message.id, result });
    } catch (error) {
      connection.send({ id: message.id, error: { code: error instanceof CodexError ? error.code : -32600, message: (error as Error).message } });
    }
  }

  thread(id: string): ThreadState {
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`thread not found: ${id}`);
    return thread;
  }

  private async handle(connection: DaemonConnection, method: string, params: Json): Promise<Json> {
    switch (method) {
      case "initialize":
        return { userAgent: "fake-codex/0.162.1", codexHome: "/Users/dev/.codex", platformFamily: "unix", platformOs: "macos" };
      case "model/list":
        return { data: testModels.filter((model) => params.includeHidden || !model.hidden), nextCursor: null };
      case "config/read":
        await this.onConfigRead(params);
        return { config: { ...this.config, ...(params?.cwd ? this.folderConfigs.get(params.cwd) : undefined) }, origins: {}, layers: null };
      case "thread/start": {
        const id = this.addThread(params.cwd, [], { loaded: true });
        if (params.ephemeral) this.ephemeral.add(id);
        const thread = this.thread(id);
        if (params.model) thread.model = params.model;
        connection.subscribed.add(id);
        return { thread: this.threadJSON(thread, false), ...this.settings(thread) };
      }
      case "thread/resume": {
        await this.onResume(params);
        const thread = this.thread(params.threadId);
        if (thread.turns.length === 0 && !thread.loaded) throw new Error(`no rollout found for thread id ${thread.id}`);
        thread.loaded = true;
        if (thread.status.type === "notLoaded") thread.status = { type: "idle" };
        connection.subscribed.add(thread.id);
        // What is waiting is asked again, under a new id.
        for (const open of [...this.open.values()]) {
          if (open.threadId !== thread.id) continue;
          this.open.delete(open.id);
          open.id = this.nextRequest++;
          this.open.set(open.id, open);
          setImmediate(() => connection.send({ id: open.id, method: open.method, params: open.params }));
        }
        return { thread: this.threadJSON(thread, params.excludeTurns !== true, true), ...this.settings(thread) };
      }
      case "thread/turns/list": {
        if (!this.pagedHistory) throw new CodexError(-32601, "Method not found: thread/turns/list");
        const turns = this.threadJSON(this.thread(params.threadId), true).turns.reverse();
        const start = Number(params.cursor ?? 0);
        const limit = Math.min(params.limit ?? 50, this.historyPageSize);
        const data = turns.slice(start, start + limit);
        if (params.itemsView === "notLoaded") for (const turn of data) { turn.items = []; turn.itemsView = "notLoaded"; }
        this.onTurnsRead(params);
        return { data, nextCursor: start + limit < turns.length ? String(start + limit) : null, backwardsCursor: null };
      }
      case "thread/read":
        await this.onRead(params);
        return { thread: this.threadJSON(this.thread(params.threadId), params.includeTurns === true) };
      case "thread/fork": {
        const from = this.thread(params.threadId);
        if (from.turns.length === 0) throw new Error(`no rollout found for thread id ${from.id}`);
        const id = this.addThread(from.cwd, structuredClone(from.turns.filter((turn) => turn.status !== "inProgress")), {
          loaded: true,
          preview: from.preview,
          updatedAt: Math.floor(Date.now() / 1000),
        });
        const thread = this.thread(id);
        thread.model = from.model;
        thread.effort = from.effort;
        connection.subscribed.add(id);
        return { thread: this.threadJSON(thread, params.excludeTurns !== true), ...this.settings(thread) };
      }
      case "thread/loaded/list":
        this.onLoaded(params);
        return { data: [...this.threads.values()].filter((thread) => thread.loaded).map((thread) => thread.id), nextCursor: null };
      case "thread/list": {
        this.onList(params);
        // Newest first, two to a page, so a client has to follow the cursor.
        const all = [...this.threads.values()].filter((thread) => !this.ephemeral.has(thread.id)).sort((a, b) => b.updatedAt - a.updatedAt);
        const start = params.cursor ? Number(params.cursor) : 0;
        const page = all.slice(start, start + 2);
        return { data: page.map((thread) => this.threadJSON(thread, false)), nextCursor: start + 2 < all.length ? String(start + 2) : null, backwardsCursor: null };
      }
      case "turn/start":
        await this.onTurnStart(params);
        return this.startTurn(params);
      case "thread/compact/start":
        // Answered at once with nothing; the recording playing (or the test) starts the
        // turn that compacts.
        if (this.thread(params.threadId).status.type === "active") throw new Error("a turn is already running");
        return {};
      case "turn/steer": {
        this.onSteer(params);
        const thread = this.thread(params.threadId);
        const running = thread.turns.find((turn) => turn.id === params.expectedTurnId && turn.status === "inProgress");
        if (thread.status.type !== "active" || !running) throw new Error(`expected active turn id ${params.expectedTurnId}, but there is none`);
        return { turnId: params.expectedTurnId };
      }
      case "turn/interrupt":
        if (this.interruptHeld) await this.interruptHeld;
        return {};
      case "account/rateLimits/read":
        return this.accountLimits;
      case "thread/unsubscribe":
        // An ephemeral thread is gone once nobody follows it.
        connection.subscribed.delete(params.threadId);
        if (this.ephemeral.delete(params.threadId)) this.threads.delete(params.threadId);
        return { status: "unsubscribed" };
      case "thread/name/set": {
        const thread = this.thread(params.threadId);
        setImmediate(() => this.broadcast("thread/name/updated", { threadId: thread.id, threadName: params.name }));
        return {};
      }
      default:
        throw new Error(`fake daemon: ${method} is not handled`);
    }
  }

  private startTurn(params: Json): Json {
    const thread = this.thread(params.threadId);
    if (this.ephemeral.has(thread.id)) return this.titleTurn(params);
    // As Codex does (0.162.1): the message goes into the running turn, whose id is the answer.
    const running = thread.status.type === "active" ? thread.turns.find((turn) => turn.status === "inProgress") : undefined;
    if (running) {
      const item = { type: "userMessage", id: `user-${randomUUID()}`, clientId: params.clientUserMessageId ?? null, content: params.input };
      setImmediate(() => {
        this.broadcast("item/started", { threadId: thread.id, turnId: running.id, item, startedAtMs: 1 });
        this.broadcast("item/completed", { threadId: thread.id, turnId: running.id, item, completedAtMs: 1 });
      });
      const { started: _started, ...turn } = running;
      return { turn: { ...structuredClone(turn), items: [], itemsView: "notLoaded" } };
    }
    if (thread.status.type === "active") throw new Error("a turn is already running");
    if (params.model) thread.model = params.model;
    if (params.effort) thread.effort = params.effort;
    if (params.approvalPolicy) thread.approvalPolicy = params.approvalPolicy;
    if (params.sandboxPolicy) thread.sandbox = params.sandboxPolicy;
    if (params.summary) thread.summary = params.summary;
    if (params.collaborationMode) thread.collaborationMode = params.collaborationMode;
    const name = this.scripts.shift();
    const recorded = name ? fixture(name).find((entry) => entry.kind === "response" && entry.method === "turn/start")!.result.turn : null;
    const turn = recorded ? structuredClone(recorded) : { id: randomUUID(), items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null };
    setImmediate(() => {
      this.broadcast("thread/settings/updated", {
        threadId: thread.id,
        threadSettings: {
          cwd: thread.cwd,
          model: thread.model,
          effort: thread.effort,
          approvalPolicy: thread.approvalPolicy,
          sandboxPolicy: thread.sandbox,
          summary: thread.summary,
          collaborationMode: thread.collaborationMode,
        },
      });
      if (name) this.playing.push(this.play(thread.id, name));
      else this.broadcast("turn/started", { threadId: thread.id, turn: { ...turn, startedAt: 1 } });
    });
    return { turn };
  }

  /** A turn of an ephemeral thread: it answers `titleAnswer` and ends. */
  private titleTurn(params: Json): Json {
    const threadId = params.threadId;
    const turn = { id: randomUUID(), items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null };
    setImmediate(async () => {
      this.broadcast("turn/started", { threadId, turn: { ...turn, startedAt: 1 } });
      await this.onTitleTurn(params);
      // Gone, when the bridge dropped meanwhile and so stopped following it.
      if (this.threads.has(threadId)) this.finishTurn(threadId, turn.id, this.titleAnswer, this.titleStatus);
    });
    return { turn };
  }

  /** Plays a recorded turn for `threadId`, in order, waiting for the bridge where the recording did. */
  async play(threadId: string, name: string): Promise<void> {
    const thread = this.thread(threadId);
    const replacements: [string, string][] = [
      [recordedThread(name), threadId],
      [fixtureCwd, thread.cwd],
    ];
    const entries = fixture(name);
    const start = entries.findIndex((entry) => entry.kind === "send" && entry.method === "turn/start");
    const from = this.calls.length;
    for (const entry of entries.slice(start + 1)) {
      await new Promise((resolve) => setImmediate(resolve));
      switch (entry.kind) {
        case "notification": {
          // The recorder's settings are the bridge's to choose here.
          if (entry.method === "thread/settings/updated") break;
          this.broadcast(entry.method!, rewrite(entry.params, replacements));
          break;
        }
        case "request":
          await this.request(threadId, entry.method!, rewrite(entry.params, replacements));
          break;
        case "send":
          // The recorder steered or interrupted here: so must the bridge.
          await this.waitForCall((call) => call.method === entry.method && call.params.threadId === threadId, from);
          break;
        default:
          break;
      }
    }
  }
}
