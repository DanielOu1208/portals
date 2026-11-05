import { readFileSync } from "node:fs";
import { onTestCleanup } from "./opencode-test.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, ModelInfo, OpenCodeEvent, PermissionRequest, SessionInfo } from "../src/providers/opencode/protocol.ts";
import type { Endpoint } from "../src/providers/opencode/server.ts";
import type { FormInfo, McpServer, Project, SessionInboxInfo, UsageLimitsInfo } from "@opencode/client";

// A stand-in for an OpenCode 2 server (`opencode serve`, or the background service)
// that answers the HTTP calls the bridge makes, through OpenCode's own client, and plays
// turns recorded from OpenCode 2.2.5 on its event stream (test/fixtures/opencode). A
// recording is played when the bridge sends the message that starts it, with the
// recorded session's id and folder swapped for the test's; it waits at a permission
// request for the bridge's answer, and at an interrupt for the bridge's call.

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures/opencode");
/** Where the recordings were made. */
const recordedFolder = "/tmp/oc-spike/project";

export function recording(name: string): OpenCodeEvent[] {
  return readFileSync(join(fixtures, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** The approval recording's session as `GET /api/session/{id}/message` gave it. */
export function recordedMessages(): Message[] {
  return JSON.parse(readFileSync(join(fixtures, "approval.messages.json"), "utf8")).data;
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

interface FakeSession {
  info: SessionInfo;
  messages: Message[];
  permissions: PermissionRequest[];
  forms: FormInfo[];
  inbox: SessionInboxInfo[];
}

interface Turn {
  name: string;
  inputID?: string;
  /** Stop before this event until the bridge interrupts. */
  holdBefore?: string;
  /** Stop before this event, and drop the event stream: what is left is played while the bridge is away. */
  dropBefore?: string;
}

export class FakeOpenCode {
  readonly server: Server;
  readonly password: string | null;
  version = "2.2.5";
  readonly calls: Call[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly active = new Set<string>();
  models: ModelInfo[] = [
    { id: "deepseek-v4.1-flash-free", providerID: "opencode", name: "DeepSeek V4.1 Flash Free", limit: { context: 128_000 }, variants: [{ id: "default" }, { id: "low" }, { id: "high" }] },
    { id: "claude-sonnet-5", providerID: "anthropic", name: "Claude Sonnet 5", limit: { context: 200_000 }, variants: [{ id: "default" }, { id: "high" }, { id: "max" }] },
    { id: "claude-sonnet-5", providerID: "opencode", name: "Claude Sonnet 5", limit: { context: 200_000 } },
    { id: "retired", providerID: "opencode", name: "Retired", enabled: false },
  ];
  defaultModel: ModelInfo | null = this.models[0];
  agents = [{ id: "build", name: "Build", mode: "primary", hidden: false }, { id: "plan", name: "Plan", mode: "primary", hidden: false }, { id: "reviewer", name: "Reviewer", mode: "all", hidden: false }, { id: "explore", name: "Explore", mode: "subagent", hidden: false }];
  defaultAgent: string | undefined = undefined;
  commands = [{ name: "init", description: "Initialize project" }, { name: "review", description: "Review a change" }];
  /** What `GET /api/skill` answers: a lower-case name, one the app could send, and one it could not. */
  skills = [
    { id: "graphify", name: "graphify", description: "Graph a codebase", path: "/skills/graphify/SKILL.md" },
    { id: "init", name: "init", description: "A skill named like a command", path: "/skills/init/SKILL.md" },
    { id: "open", name: "OpenCode", description: "Named with capitals", path: "/skills/open/SKILL.md" },
  ];
  usage: UsageLimitsInfo | null = null;
  usageStatus = 200;
  instructionsStatus = 204;
  mcp: McpServer[] = [];
  projects: Project[] = [];
  providers = [
    { id: "opencode", name: "OpenCode Zen" },
    { id: "anthropic", name: "Anthropic" },
  ];
  private readonly streams = new Set<ServerResponse>();
  private readonly queued = new Map<string, Turn[]>();
  private readonly replies = new Map<string, (decision: string) => void>();
  private readonly interrupts = new Map<string, () => void>();
  private nextId = 1;
  /** A failing stream: each attempt answers this status, until cleared. */
  refuse: number | null = null;
  /** Turns still playing, by session, so a test can wait for one to finish. */
  private readonly playing = new Map<Promise<void>, string>();

  private constructor(password: string | null) {
    this.password = password;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: Error) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: "UnknownError", message: error.message }));
      });
    });
  }

  static async start(options: { password?: string | null } = {}): Promise<FakeOpenCode> {
    const fake = new FakeOpenCode(options.password === undefined ? "test-password" : options.password);
    onTestCleanup(() => fake.close());
    await new Promise<void>((resolve, reject) => {
      fake.server.once("error", reject);
      fake.server.listen(0, "127.0.0.1", () => {
        fake.server.removeListener("error", reject);
        resolve();
      });
    });
    return fake;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  endpoint(): Endpoint {
    return { url: this.url, headers: this.password ? { authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}` } : {}, own: false };
  }

  callsOf(method: string, path: RegExp): Call[] {
    return this.calls.filter((call) => call.method === method && path.test(call.path));
  }

  /** Plays `name` when the bridge next sends a message to `session`. */
  queueTurn(session: string, name: string, options: Omit<Turn, "name"> = {}): void {
    const turns = this.queued.get(session) ?? [];
    turns.push({ name, ...options });
    this.queued.set(session, turns);
  }

  /** Plays `name` in `session` now, as a message sent from OpenCode's terminal would. */
  play(session: string, name: string, options: Omit<Turn, "name"> = {}): void {
    this.track(session, this.run(session, { name, ...options }));
  }

  /** The turns playing now in `session`, played to their end. */
  async settled(session: string): Promise<void> {
    const of = () => [...this.playing].filter(([, id]) => id === session).map(([played]) => played);
    while (of().length > 0) await Promise.all(of());
  }

  emit(event: OpenCodeEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of this.streams) stream.write(frame);
  }

  /** Ends every event stream, as a restarted server does. */
  dropStreams(): void {
    for (const stream of this.streams) stream.end();
    this.streams.clear();
  }

  get streaming(): number {
    return this.streams.size;
  }

  async close(): Promise<void> {
    this.dropStreams();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  addSession(info: Partial<SessionInfo> & { id: string }, messages: Message[] = []): FakeSession {
    const session: FakeSession = {
      info: { time: { created: Date.now(), updated: Date.now() }, ...info },
      messages,
      permissions: [],
      forms: [],
      inbox: [],
    };
    this.sessions.set(info.id, session);
    return session;
  }

  private track(session: string, played: Promise<void>): void {
    this.playing.set(played, session);
    void played.finally(() => this.playing.delete(played));
  }

  /** A recording as it plays in `session`: its ids and folder swapped for the test's. */
  private events(name: string, session: string, inputID?: string): OpenCodeEvent[] {
    const events = recording(name);
    const first = events.find((event) => event.type === "session.inbox.enqueued")?.data.inboxID;
    const recorded = events[0].data.sessionID!;
    const folder = this.sessions.get(session)?.info.location?.directory ?? recordedFolder;
    return events.map((event) => {
      let json = JSON.stringify(event).replaceAll(recorded, session).replaceAll(recordedFolder, folder);
      if (inputID && typeof first === "string") json = json.replaceAll(first, inputID);
      return JSON.parse(json);
    });
  }

  private async run(session: string, turn: Turn): Promise<void> {
    const stored = this.sessions.get(session);
    let opener: { id: string; text: string } | undefined;
    this.active.add(session);
    for (const event of this.events(turn.name, session, turn.inputID)) {
      if (event.type === turn.holdBefore) await new Promise<void>((resolve) => this.interrupts.set(session, resolve));
      if (event.type === turn.dropBefore) this.dropStreams();
      if (event.type === "permission.replied") continue;
      if (event.type === "session.inbox.enqueued") {
        const item = event.data.item as { payload?: { text?: string } } | undefined;
        opener = { id: String(event.data.inboxID), text: item?.payload?.text ?? "" };
      }
      if (stored && event.type === "session.inbox.delivered" && opener && !stored.messages.some((message) => message.id === opener!.id)) {
        stored.messages.push({ type: "user", ...opener, time: { created: event.created ?? Date.now() } });
      }
      // REST and SSE describe the same state. Reconnect tests must not rely on an
      // event-only fake that has no durable text to recover.
      if (stored && /^session\.(text|reasoning)\.(delta|ended)$/.test(event.type)) {
        const id = String(event.data.assistantMessageID);
        let message = stored.messages.find((message) => message.id === id) as Extract<Message, { type: "assistant" }> | undefined;
        if (!message) {
          message = { type: "assistant", id, content: [], time: { created: event.created ?? Date.now() } };
          stored.messages.push(message);
        }
        const kind = event.type.startsWith("session.text.") ? "text" : "reasoning";
        const parts = message.content.filter((part) => part.type === kind);
        const ordinal = Number(event.data.ordinal ?? 0);
        while (parts.length <= ordinal) {
          const part = { type: kind, text: "" } as const;
          message.content.push(part);
          parts.push(part);
        }
        const part = parts[ordinal] as { text: string };
        part.text = event.type.endsWith(".ended") ? String(event.data.text) : part.text + String(event.data.delta ?? "");
      }
      if (event.type.startsWith("session.execution.") && event.type !== "session.execution.started") {
        this.active.delete(session);
        if (stored) {
          const outcome = event.type === "session.execution.succeeded" ? "succeeded" : event.type === "session.execution.failed" ? "failed" : "interrupted";
          stored.info.outcome = outcome;
          stored.messages.push({ type: "idle", id: `msg_idle_${this.nextId++}`, outcome, ...(event.data.error ? { error: event.data.error as any } : {}), time: { created: event.created ?? Date.now() } });
        }
      }
      this.emit(event);
      if (event.type === "permission.asked") {
        const request = event.data as unknown as PermissionRequest;
        stored?.permissions.push(request);
        const decision = await new Promise<string>((resolve) => this.replies.set(request.id, resolve));
        if (stored) stored.permissions = stored.permissions.filter((waiting) => waiting.id !== request.id);
        this.emit({ id: `evt_reply_${this.nextId++}`, type: "permission.replied", data: { sessionID: session, requestID: request.id, reply: decision } });
      }
    }
    this.active.delete(session);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.url);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : undefined;
    const method = request.method ?? "GET";
    this.calls.push({ method, path: url.pathname, query: url.searchParams, body });
    const json = (status: number, value?: unknown) => {
      if (value === undefined) {
        response.writeHead(status);
        response.end();
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (this.password && request.headers.authorization !== `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`) {
      return json(401, { name: "UnauthorizedError", message: "Unauthorized" });
    }
    const notFound = () => json(404, { name: "SessionNotFoundError", message: "Session not found" });
    const path = url.pathname;
    if (method === "GET" && path === "/api/info") return json(200, { version: this.version, pid: process.pid });
    if (method === "GET" && path === "/api/event") {
      if (this.refuse !== null) return json(this.refuse, { name: "UnknownError", message: "refused" });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${JSON.stringify({ id: `evt_connected_${this.nextId++}`, type: "server.connected", data: {} })}\n\n`);
      this.streams.add(response);
      response.once("close", () => this.streams.delete(response));
      return;
    }
    if (method === "GET" && path === "/api/model") return json(200, { location: {}, data: this.models });
    if (method === "GET" && path === "/api/model/default") return json(200, { location: {}, data: this.defaultModel });
    if (method === "GET" && path === "/api/provider") return json(200, { location: {}, data: this.providers });
    if (method === "GET" && path === "/api/agent") return json(200, { location: {}, data: this.agents });
    if (method === "GET" && path === "/api/config") return json(200, [{ type: "document", info: { ...(this.defaultAgent ? { default_agent: this.defaultAgent } : {}) } }]);
    if (method === "GET" && path === "/api/command") return json(200, { location: {}, data: this.commands });
    if (method === "GET" && path === "/api/skill") return json(200, { location: {}, data: this.skills });
    if (method === "GET" && path === "/api/mcp") return json(200, { location: {}, data: this.mcp });
    if (method === "GET" && path === "/api/project") return json(200, this.projects);
    if (method === "GET" && path === "/api/experimental/usage/limits") return json(this.usageStatus, this.usageStatus === 200 ? { location: {}, data: this.usage } : { message: "Console unavailable" });
    if (method === "GET" && path === "/api/session/active") return json(200, { data: Object.fromEntries([...this.active].map((id) => [id, { type: "busy" }])) });
    if (method === "GET" && path === "/api/session") {
      const parent = url.searchParams.get("parentID");
      const all = [...this.sessions.values()].map((session) => session.info)
        .filter((info) => !info.time.archived && (parent === "null" ? !info.parentID : !parent || info.parentID === parent))
        .sort((a, b) => b.time.updated - a.time.updated);
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const size = Math.min(2, Number(url.searchParams.get("limit") ?? 2));
      return json(200, { data: all.slice(from, from + size), cursor: { next: from + size < all.length ? String(from + size) : null } });
    }
    if (method === "POST" && path === "/api/session") {
      const id = `ses_test${String(this.nextId++).padStart(4, "0")}`;
      const session = this.addSession({ id, location: { directory: body.location?.directory }, ...(body.model ? { model: body.model } : {}), ...(body.title ? { title: body.title } : {}) });
      return json(200, { data: session.info });
    }
    if (method === "PUT" && /^\/api\/experimental\/session\/[^/]+\/instructions\/entries\/[^/]+$/.test(path)) return json(this.instructionsStatus, this.instructionsStatus === 204 ? undefined : { message: "Instructions unavailable" });
    const match = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return json(404, { name: "NotFound", message: path });
    const id = decodeURIComponent(match[1]);
    const rest = match[2] ?? "";
    const session = this.sessions.get(id);
    if (!session) return notFound();
    if (method === "GET" && rest === "") return json(200, { data: session.info });
    if (method === "PUT" && rest === "/environment") return json(204);
    if (method === "POST" && rest === "/fork") {
      const fork = this.addSession({ ...session.info, id: `ses_fork${this.nextId++}`, parentID: undefined }, structuredClone(session.messages));
      return json(200, { data: fork.info });
    }
    if (method === "PATCH" && rest === "") {
      if (typeof body.title === "string") session.info.title = body.title;
      return json(204);
    }
    if (method === "GET" && rest === "/message") {
      // Two at a time, so the bridge reads every page.
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const page = session.messages.slice(from, from + 2);
      const next = from + 2 < session.messages.length ? String(from + 2) : null;
      return json(200, { data: page, cursor: { next } });
    }
    if (method === "POST" && rest === "/prompt") {
      if (body.delivery === "steer") {
        const item = { id: body.id, sessionID: id, time: { created: Date.now() }, type: "user" as const, payload: { text: body.text }, delivery: body.delivery };
        session.inbox.push(item);
        this.emit({ id: `evt_${this.nextId++}`, type: "session.inbox.enqueued", data: { sessionID: id, inboxID: item.id, item } });
        return json(200, { data: item });
      }
      const turn = this.queued.get(id)?.shift();
      if (turn && typeof body.id === "string") turn.inputID = body.id;
      const enqueued = turn ? this.events(turn.name, id).find((event) => event.type === "session.inbox.enqueued") : undefined;
      const inboxID = body.id ?? (typeof enqueued?.data.inboxID === "string" ? enqueued.data.inboxID : `msg_test${this.nextId++}`);
      if (turn) setImmediate(() => this.track(id, this.run(id, turn)));
      return json(200, { data: { id: inboxID, sessionID: id, type: "user", text: body.text } });
    }
    if (method === "POST" && rest === "/interrupt") {
      const resume = this.interrupts.get(id);
      this.interrupts.delete(id);
      resume?.();
      const running = this.active.delete(id);
      if (running && !resume) {
        session.info.outcome = "interrupted";
        this.emit({ id: `evt_${this.nextId++}`, type: "session.execution.interrupted", data: { sessionID: id } });
      }
      return json(200, { interrupted: resume !== undefined || running });
    }
    if (method === "GET" && rest === "/inbox") return json(200, { data: session.inbox });
    if (method === "DELETE" && rest.startsWith("/inbox/")) {
      const inboxID = decodeURIComponent(rest.slice("/inbox/".length));
      if (!session.inbox.some((item) => item.id === inboxID)) return json(204);
      session.inbox = session.inbox.filter((item) => item.id !== inboxID);
      this.emit({ id: `evt_${this.nextId++}`, type: "session.inbox.cancelled", data: { sessionID: id, inboxID } });
      return json(204);
    }
    if (method === "GET" && rest === "/form") return json(200, { data: session.forms });
    const form = /^\/form\/([^/]+)(\/reply)?$/.exec(rest);
    if (form && ((method === "POST" && form[2]) || (method === "DELETE" && !form[2]))) {
      const formID = decodeURIComponent(form[1]);
      if (!session.forms.some((form) => form.id === formID)) return json(404, { message: "form not found" });
      session.forms = session.forms.filter((form) => form.id !== formID);
      this.emit({ id: `evt_${this.nextId++}`, type: form[2] ? "form.replied" : "form.cancelled", data: { sessionID: id, id: formID, ...(form[2] ? { answer: body.answer } : {}) } });
      return json(204);
    }
    if (method === "POST" && rest === "/model") {
      session.info.model = body.model;
      return json(204);
    }
    if (method === "POST" && rest === "/agent") {
      if (!this.agents.some((agent) => agent.id === body.agent && agent.mode !== "subagent")) return json(400, { message: "agent not selectable" });
      session.info.agent = body.agent;
      this.emit({ id: `evt_${this.nextId++}`, type: "session.agent.selected", data: { sessionID: id, agent: body.agent } });
      return json(204);
    }
    if (method === "POST" && rest === "/command") {
      if (!this.commands.some((command) => command.name === body.name)) return json(400, { message: "unknown command" });
      const turn = this.queued.get(id)?.shift();
      if (turn) setImmediate(() => this.track(id, this.run(id, turn)));
      return json(204);
    }
    if (method === "POST" && rest === "/compact") {
      const inboxID = body.id ?? `msg_compact${this.nextId++}`;
      setImmediate(() => {
        this.emit({ id: `evt_${this.nextId++}`, type: "session.compaction.started", data: { sessionID: id, reason: "manual", inputID: inboxID } });
        this.emit({ id: `evt_${this.nextId++}`, type: "session.compaction.ended", data: { sessionID: id, reason: "manual", text: "Summary" } });
        this.emit({ id: `evt_${this.nextId++}`, type: "session.execution.succeeded", data: { sessionID: id } });
        session.messages.push({ id: inboxID, type: "compaction", reason: "manual", status: "completed", time: { created: Date.now() } });
      });
      return json(200, { data: { id: inboxID, sessionID: id, type: "compaction" } });
    }
    if (method === "GET" && rest === "/permission") return json(200, { data: session.permissions });
    const reply = /^\/permission\/([^/]+)\/reply$/.exec(rest);
    if (method === "POST" && reply) {
      const answer = this.replies.get(decodeURIComponent(reply[1]));
      if (!answer) return json(404, { name: "PermissionNotFoundError", message: "Permission not found" });
      this.replies.delete(decodeURIComponent(reply[1]));
      answer(body.decision);
      return json(204);
    }
    return json(404, { name: "NotFound", message: path });
  }
}
