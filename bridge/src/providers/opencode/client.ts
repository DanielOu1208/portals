import { setTimeout as sleep } from "node:timers/promises";
import { log } from "../../log.ts";
import type { AgentInfo, CommandInfo, FormInfo, SessionInboxInfo, UsageLimitsInfo, McpServer, Project } from "@opencode/client";
import type { Endpoint } from "./server.ts";
import type { Message, ModelInfo, ModelRef, OpenCodeEvent, PermissionDecision, PermissionRequest, SessionInfo, SkillInfo } from "./protocol.ts";

// The bridge's one way to OpenCode: its own client (`@opencode/client`, an optional
// peer dependency loaded when OpenCode is first used), with every call the provider
// makes in one place, and one event stream for all threads.
//
// The stream is live only: what OpenCode says while it is down is gone, and a slow
// reader overflows it and is cut off. So events are handed on as they come, never
// waited on, and each time the stream comes back the sessions catch up from what
// OpenCode keeps (session.ts, `reconnected`).

type ClientModule = typeof import("@opencode/client");
type Client = ReturnType<ClientModule["OpenCode"]["make"]>;

export async function clientModule(): Promise<ClientModule> {
  try {
    return await import("@opencode/client");
  } catch (error) {
    throw new Error(`OpenCode's client is not installed with Portals host (${(error as Error).message}). With OpenCode 2 installed or providers.opencode enabled, run: npx portals-host@latest update (or npx portals-host@latest setup).`);
  }
}

/** A list OpenCode answers inside `{data}`, or as it is: the client unwraps some answers and not others. */
function data<T>(value: unknown): T {
  return (value && typeof value === "object" && !Array.isArray(value) && "data" in value ? (value as { data: unknown }).data : value) as T;
}

/** How many pages of a long conversation are read, at most. */
const maxPages = 100;

/** How long a folder's skills are asked for at least, the first time, while OpenCode may still be reading them. */
const skillsSettle = 1000;
/** How long a menu waits for a folder's skills at most: a freshly started OpenCode can take seconds to answer. */
const skillsDeadline = 10_000;

/** The calls the bridge makes, each in the shape the provider reads. */
export class OpenCodeApi {
  private readonly client: Client;
  /** The folders whose skills OpenCode has finished reading. */
  private readonly skillsRead = new Set<string>();

  constructor(client: Client) {
    this.client = client;
  }

  async info(): Promise<{ version: string; pid: number }> {
    return data(await this.client.server.info());
  }

  async models(directory: string): Promise<ModelInfo[]> {
    return data<ModelInfo[]>(await this.client.model.list({ location: { directory } })) ?? [];
  }

  /** The model providers OpenCode has, by id, with their names. */
  async providers(directory: string): Promise<{ id: string; name: string }[]> {
    return data<{ id: string; name: string }[]>(await this.client.provider.list({ location: { directory } })) ?? [];
  }

  async mcpStatuses(directory: string): Promise<McpServer[]> {
    return data(await this.client.mcp.list({ location: { directory } })) ?? [];
  }

  async projects(): Promise<Project[]> {
    return data(await this.client.project.list({ archived: false })) ?? [];
  }

  /** Read only output belonging to a tool's native shell, without opening its output file. */
  async shellOutput(directory: string, id: string, cursor: number): Promise<{ output: string; cursor: number; size: number; truncated: boolean }> {
    return data(await this.client.shell.output({ location: { directory }, id, cursor, limit: 8192 }));
  }

  async agents(directory: string): Promise<AgentInfo[]> {
    return data(await this.client.agent.list({ location: { directory } })) ?? [];
  }

  async defaultAgent(directory: string): Promise<string | undefined> {
    const entries = await this.client.config.get({ location: { directory } });
    return entries.reduce<string | undefined>((chosen, entry) => entry.type === "document" ? entry.info.default_agent ?? chosen : chosen, undefined);
  }

  async switchAgent(id: string, agent: string): Promise<void> {
    await this.client.session.switchAgent({ sessionID: id, agent });
  }

  async environment(id: string, variables: Record<string, string>): Promise<void> {
    await this.client.session.environment({ sessionID: id, variables });
  }

  /** A keyed entry leaves the user's own native instructions untouched. */
  async instructions(id: string, value: string | null): Promise<void> {
    const entry = this.client.experimental.session.instructions.entry;
    if (value) await entry.put({ sessionID: id, key: "portals", value });
    else await entry.remove({ sessionID: id, key: "portals" });
  }

  async commands(directory: string): Promise<CommandInfo[]> {
    return data(await this.client.command.list({ location: { directory } })) ?? [];
  }

  /**
   * The skills OpenCode would use in a folder: its own, the user's, and a plugin's. Not
   * `complete` when OpenCode did not finish listing them in `wait`.
   */
  async skills(directory: string, signal?: AbortSignal, wait = skillsDeadline): Promise<{ skills: SkillInfo[]; complete: boolean }> {
    // OpenCode reads a folder's skills in the background, so the first answers after it
    // starts are empty or partial (0 → 2 → 153 over ~400 ms on 2.2.5, measured), and it
    // says nothing when it is done. So the first time a folder is asked, keep asking for
    // `skillsSettle`, then until two answers name the same skills; later, one answer will do.
    // No more than `wait` in all: then the list is the last answer, or none, and the
    // folder is asked again on the next request for it. (The app keeps the menu it got
    // until the host reconnects, so one read past `wait` leaves that menu without them.)
    const deadline = AbortSignal.timeout(wait);
    const options = { signal: signal ? AbortSignal.any([signal, deadline]) : deadline };
    let skills: SkillInfo[] = [];
    try {
      if (this.skillsRead.has(directory)) return { skills: await this.skillList(directory, options), complete: true };
      const started = Date.now();
      let previous: string | undefined;
      for (;;) {
        skills = await this.skillList(directory, options);
        const names = skills.map((skill) => `${skill.id}:${skill.name}`).sort().join("\n");
        if (Date.now() - started >= skillsSettle && names === previous) break;
        previous = names;
        await sleep(100, undefined, options);
      }
    } catch (error) {
      if (signal?.aborted || !deadline.aborted) throw error;
      log.debug("OpenCode did not list its skills in time", { directory });
      return { skills, complete: false };
    }
    this.skillsRead.add(directory);
    return { skills, complete: true };
  }

  private async skillList(directory: string, options: { signal: AbortSignal }): Promise<SkillInfo[]> {
    return data(await this.client.skill.list({ location: { directory } }, options)) ?? [];
  }

  async command(id: string, name: string, text: string, files: { uri: string; name: string }[]): Promise<void> {
    await this.client.session.command({ sessionID: id, name, text, ...(files.length ? { files } : {}) });
  }

  async compact(id: string, inputID?: string): Promise<{ id: string }> {
    return data(await this.client.session.compact({ sessionID: id, delivery: "queue", ...(inputID ? { id: inputID } : {}) }));
  }

  async usage(directory: string): Promise<UsageLimitsInfo | null> {
    return data(await this.client.experimental.usage.limits({ location: { directory } })) ?? null;
  }

  async defaultModel(directory: string): Promise<ModelInfo | null> {
    return data<ModelInfo | null>(await this.client.model.default({ location: { directory } })) ?? null;
  }

  async createSession(input: { directory: string; model?: ModelRef; title?: string }): Promise<SessionInfo> {
    return data(
      await this.client.session.create({
        location: { directory: input.directory },
        ...(input.model ? { model: input.model } : {}),
        ...(input.title ? { title: input.title } : {}),
      }),
    );
  }

  async session(id: string): Promise<SessionInfo> {
    return data(await this.client.session.get({ sessionID: id }));
  }

  /** The ids of the sessions OpenCode is running a turn in now. */
  async active(): Promise<Set<string>> {
    return new Set(Object.keys(data<Record<string, unknown>>(await this.client.session.active()) ?? {}));
  }

  /** Newest sessions first, across native pages; a null parent selects only top-level sessions. */
  async sessions(wanted: number, parentID: string | null = null): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    if (wanted < 1) return sessions;
    let cursor: string | undefined;
    for (let pages = 0; pages < maxPages; pages += 1) {
      const page = await this.client.session.list({ limit: Math.min(100, wanted - sessions.length), order: "desc", archived: false, parentID, ...(cursor ? { cursor } : {}) });
      sessions.push(...(data<SessionInfo[]>(page) ?? []));
      const next = page.cursor?.next;
      if (!next || sessions.length >= wanted) return sessions;
      cursor = next;
    }
    return sessions;
  }

  async fork(id: string): Promise<SessionInfo> {
    return data(await this.client.session.fork({ sessionID: id }));
  }

  /** The whole conversation, oldest first. */
  async messages(id: string): Promise<Message[]> {
    const messages: Message[] = [];
    let page = await this.client.message.list({ sessionID: id, order: "asc", limit: 200 });
    for (let pages = 1; ; pages += 1) {
      messages.push(...(data<Message[]>(page) ?? []));
      const next = (page as { cursor?: { next?: string | null } }).cursor?.next;
      if (!next || pages >= maxPages) return messages;
      page = await this.client.message.list({ sessionID: id, cursor: next });
    }
  }

  /** Hands OpenCode a message; it runs it as soon as the session is free. Resolves with the message's id. */
  async prompt(id: string, text: string, files: { uri: string; name: string }[], options: { id?: string; delivery?: "steer" | "queue"; skills?: { id: string; name: string }[] } = {}): Promise<{ id: string }> {
    return data(await this.client.session.prompt({ sessionID: id, text, ...(files.length > 0 ? { files } : {}), ...options }));
  }

  async inbox(id: string): Promise<SessionInboxInfo[]> {
    return data(await this.client.session.inbox.list({ sessionID: id })) ?? [];
  }

  async forms(id: string): Promise<FormInfo[]> {
    return data(await this.client.session.form.list({ sessionID: id })) ?? [];
  }

  async replyForm(id: string, formID: string, answer: Record<string, string | number | boolean | string[]>): Promise<void> {
    await this.client.session.form.reply({ sessionID: id, formID, answer });
  }

  async cancelForm(id: string, formID: string): Promise<void> {
    await this.client.session.form.cancel({ sessionID: id, formID });
  }

  /** Stops the running turn; false when none ran. */
  async interrupt(id: string): Promise<boolean> {
    return data<{ interrupted?: boolean }>(await this.client.session.interrupt({ sessionID: id }))?.interrupted === true;
  }

  /** Takes back a message OpenCode has not begun on yet. */
  async cancelInbox(id: string, inboxID: string): Promise<void> {
    await this.client.session.inbox.cancel({ sessionID: id, inboxID });
  }

  async switchModel(id: string, model: ModelRef): Promise<void> {
    await this.client.session.switchModel({ sessionID: id, model });
  }

  async rename(id: string, title: string): Promise<void> {
    await this.client.session.update({ sessionID: id, title });
  }

  async pendingPermissions(id: string): Promise<PermissionRequest[]> {
    return data<PermissionRequest[]>(await this.client.permission.list({ sessionID: id })) ?? [];
  }

  async replyPermission(id: string, requestID: string, decision: PermissionDecision, message?: string): Promise<void> {
    await this.client.permission.reply({ sessionID: id, requestID, decision, ...(message ? { message } : {}) });
  }

  events(signal: AbortSignal): AsyncIterable<OpenCodeEvent> {
    return this.client.event.subscribe({ signal }) as AsyncIterable<OpenCodeEvent>;
  }
}

export interface ConnectionListener {
  /** An event, other than `server.connected`. Called as it comes: it must not wait on anything. */
  event(event: OpenCodeEvent): void;
  /** The stream is up; `again` after it had been up before (what came meanwhile is lost). */
  connected(again: boolean): void;
  disconnected(): void;
}

export interface ConnectionOptions {
  /** Where the server is now: asked again before every attempt, as a restarted one moves. */
  locate(): Promise<Endpoint>;
  listener: ConnectionListener;
  /** Seconds between attempts. */
  backoff?: number[];
  /** Each server reached, with the version it says it runs. */
  reached?(version: string, endpoint: Endpoint): void;
}

const defaultBackoff = [0.5, 1, 2, 5, 10];

/** One event stream for every thread, connected again whenever it drops. */
export class OpenCodeConnection {
  private readonly options: ConnectionOptions;
  private current: OpenCodeApi | null = null;
  private readonly waiting: { resolve(api: OpenCodeApi): void; reject(error: Error): void }[] = [];
  private running = false;
  private closed = false;
  private everConnected = false;
  private abort: AbortController | null = null;
  private pause: { timer: NodeJS.Timeout; resolve(): void } | null = null;

  constructor(options: ConnectionOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.current !== null;
  }

  start(): void {
    if (this.running || this.closed) return;
    this.running = true;
    void this.loop();
  }

  /** The API of the server connected now, connecting first when needed. Fails when an attempt fails meanwhile. */
  api(): Promise<OpenCodeApi> {
    if (this.closed) return Promise.reject(new Error("OpenCode was stopped."));
    if (this.current) return Promise.resolve(this.current);
    this.start();
    // An attempt waiting out its pause is tried now: someone wants OpenCode.
    this.wake();
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
    this.wake();
    for (const waiter of this.waiting.splice(0)) waiter.reject(new Error("OpenCode was stopped."));
  }

  private wake(): void {
    if (!this.pause) return;
    clearTimeout(this.pause.timer);
    this.pause.resolve();
    this.pause = null;
  }

  private async loop(): Promise<void> {
    const backoff = this.options.backoff ?? defaultBackoff;
    let attempt = 0;
    while (!this.closed) {
      let failure: Error;
      try {
        const endpoint = await this.options.locate();
        const { OpenCode } = await clientModule();
        const api = new OpenCodeApi(OpenCode.make({ baseUrl: endpoint.url, headers: endpoint.headers }));
        // Before the stream: a server that will not sign the bridge in says so here.
        const info = await api.info();
        this.options.reached?.(info.version, endpoint);
        const abort = new AbortController();
        this.abort = abort;
        for await (const event of api.events(abort.signal)) {
          if (this.closed) break;
          if (event.type === "server.connected") {
            if (this.current) continue;
            this.current = api;
            attempt = 0;
            const again = this.everConnected;
            this.everConnected = true;
            for (const waiter of this.waiting.splice(0)) waiter.resolve(api);
            this.tell(() => this.options.listener.connected(again));
            continue;
          }
          if (this.current) this.tell(() => this.options.listener.event(event));
        }
        failure = new Error("its event stream ended");
      } catch (error) {
        failure = error as Error;
      }
      this.abort = null;
      if (this.current) {
        this.current = null;
        this.tell(() => this.options.listener.disconnected());
      }
      if (this.closed) break;
      log.debug("OpenCode is not reachable", { error: failure.message });
      for (const waiter of this.waiting.splice(0)) waiter.reject(new Error(`OpenCode is not reachable: ${failure.message}`));
      const seconds = backoff[Math.min(attempt, backoff.length - 1)];
      attempt += 1;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.pause = null;
          resolve();
        }, seconds * 1000);
        timer.unref();
        this.pause = { timer, resolve };
      });
    }
    this.running = false;
  }

  private tell(call: () => void): void {
    try {
      call();
    } catch (error) {
      log.warn("an OpenCode event could not be handled", { error: (error as Error).message });
    }
  }
}
