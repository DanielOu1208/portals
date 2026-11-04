import { randomUUID } from "node:crypto";
import { DroidErrorType, DroidWorkingState, FACTORY_PROTOCOL_VERSION, LEGACY_FACTORY_API_VERSION, ProcessTransport, resolveExecCoreDeps, SessionNotificationSchema,
  type DroidSession } from "@factory/droid-sdk/node";
import { log } from "../../log.ts";
import { DroidOAuthCallback } from "./oauthCallback.ts";
import { authRedirectState, safeAuthURL } from "./auth.ts";

/** A JSON-RPC message as the SDK's transport carries it, decoded. */
type Message = Parameters<ProcessTransport["send"]>[0];
/** One read as a plain object: Droid's params are not the SDK's to type. */
type Frame = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A turn's usage as the SDK reads it: its five counts, each one Droid left out or sent as no number taken as 0. */
function usage(value: unknown): Record<string, unknown> {
  const counts = { ...record(value) };
  for (const key of ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "thinkingTokens"]) {
    if (typeof counts[key] !== "number") counts[key] = 0;
  }
  if (counts.factoryCredits !== undefined && typeof counts.factoryCredits !== "number") delete counts.factoryCredits;
  return counts;
}

/**
 * A turn's end the SDK can read. The SDK reads each frame against Droid's protocol as it
 * was when it shipped, and drops one it cannot read whole; its stream ends only with the
 * turn's end, so a turn whose end it dropped stayed at work until Stop (a reason it does not
 * know, a usage count left out). Droid's CLI ships far more often than the SDK. Usage is
 * filled in, and a reason it does not know is told as an error, the reason kept (`reason`).
 * Undefined when it cannot be read either way.
 */
function readable(frame: Frame, notification: Frame): { frame: Frame; reason?: string } | undefined {
  const params = record(frame.params)!;
  const filled: Frame = { ...notification, tokenUsage: usage(notification.tokenUsage) };
  for (const key of ["cumulativeTokenUsage", "childTokenUsage", "cumulativeChildTokenUsage"]) {
    if (filled[key] === undefined) continue;
    if (record(filled[key])) filled[key] = usage(filled[key]); else delete filled[key];
  }
  if (filled.durationMs !== undefined && !(typeof filled.durationMs === "number" && filled.durationMs >= 0)) delete filled.durationMs;
  const told = (notification: Frame): Frame => ({ ...frame, params: { ...params, notification } });
  if (SessionNotificationSchema.safeParse(told(filled)).success) return { frame: told(filled) };
  const failed = told({ ...filled, reason: "error" });
  if (SessionNotificationSchema.safeParse(failed).success) return { frame: failed, reason: typeof notification.reason === "string" ? notification.reason : "" };
  return undefined;
}

/** A message the SDK's stream sent, waiting for its end (`DroidTransport.coalesced`). */
interface Awaited {
  /** The session Droid took it in, once its message was made: null until then. */
  session: string | null;
  requestId: string;
  stream?: { refusal?: string };
}

/**
 * Extra RPCs share the SDK transport, but never consume its notifications or requests.
 *
 * Droid takes a message sent while it is at work (a turn it began by itself to answer
 * background work, also the one it begins as it resumes a session whose work a stopped
 * process left unfinished) into the turn it runs, and ends that turn with one
 * `agent_turn_completed`, under that turn's id; the message's own end is only written to
 * the session's file (0.247, its coalesced message ids). The SDK's stream for the message
 * waits for an end under the message's id, so the thread showed Droid at work until Stop
 * (2026-10-27: "after it said it was finished it still showed as thinking"). The
 * end of the turn a message was taken into is told for the message too, as Droid writes it.
 */
export class DroidTransport extends ProcessTransport {
  private readonly oauth = new DroidOAuthCallback((serverName, code, state) => this.request("droid.submit_mcp_auth_code", { serverName, code, state }),
    (serverName) => this.request("droid.cancel_mcp_auth", { serverName }));
  private readonly authRequests = new Map<string, string>();
  constructor(options?: ConstructorParameters<typeof ProcessTransport>[0]) {
    const deps = resolveExecCoreDeps(undefined);
    // The SDK's optional wire logger writes raw OAuth URLs, state and submitted codes.
    // Never enable it for bridge sessions, even when the parent environment asks for it.
    super(options, { ...deps, environmentResolver: { ...deps.environmentResolver, resolveTransportLogEnvValue: () => undefined } });
  }
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  /** The SDK stream's messages (`droid.add_user_message` it sent) whose end has not come, the oldest first. */
  private readonly awaited = new Map<string, Awaited>();
  private streaming: { refusal?: string } | undefined;
  /**
   * How long Droid may be idle with a message's turn not ended before that turn is ended
   * here: Droid ends a turn, then goes idle, within a few milliseconds. An end the SDK
   * dropped all the same (`readable`) must not leave the turn at work until Stop.
   */
  idleEndMs = 10_000;
  /** The session Droid went idle in with a message's turn not ended, and the time it has left (`watchIdle`). */
  private idle: { session: string; timer: NodeJS.Timeout } | undefined;
  private readonly refused = new Set<string>();
  /** The SDK's `droid.load_session` requests whose answer has not come. */
  private readonly loads = new Set<string>();
  /**
   * What the last session loaded on this process said its last call to the model took
   * (`lastCallTokenUsage`, what Droid's context meter shows), which the SDK's resume
   * leaves out: the thread's meter as it reopens (`DroidSession.observeContext`).
   */
  loadedUsage: unknown;
  /**
   * Answers Droid's pick lists (`droid.pick_options`, a request Droid sends since 0.10.0's
   * protocol, which the SDK's client would cancel: no session option sets its handler):
   * when set, such a request is answered here and never reaches the client.
   */
  pickOptions: ((params: unknown) => Promise<unknown>) | undefined;

  // Since SDK 0.10.0 the transport carries messages decoded, envelopes whose params it
  // leaves as Droid sent them; they are read here as plain objects.
  override async send(message: Message): Promise<void> {
    const frame = message as Frame;
    if (frame.type === "request") {
      if (frame.method === "droid.initialize_session" || frame.method === "droid.load_session") {
        // Remote callback delivery suppresses Droid's own host-browser launch. Do it
        // on every load too, including resumed and SDK-replaced sessions.
        message = { ...message, params: { ...record(frame.params), mcpOAuthCallbackUri: await this.oauth.uri() } } as Message;
      }
      const server = record(frame.params)?.serverName;
      if (typeof server === "string" && typeof frame.id === "string") {
        if (frame.method === "droid.authenticate_mcp_server") this.authRequests.set(frame.id, server);
        if (frame.method === "droid.cancel_mcp_auth") {
          this.oauth.forget(server);
          for (const [id, name] of this.authRequests) if (name === server) this.authRequests.delete(id);
        }
        if (frame.method === "droid.submit_mcp_auth_code") this.oauth.forget(server);
      }
    }
    this.track(message as Frame);
    return super.send(message);
  }

  private observeAuth(frame: Frame): void {
    if (frame.type === "response" && typeof frame.id === "string") {
      const server = this.authRequests.get(frame.id);
      if (server) { this.authRequests.delete(frame.id); this.oauth.forget(server); }
    }
    if (frame.method !== "droid.session_notification") return;
    const event = record(record(frame.params)?.notification);
    if (event?.type !== "mcp_auth_required" || typeof event.serverName !== "string" || typeof event.state !== "string" ||
        !event.state || ![...this.authRequests.values()].includes(event.serverName)) return;
    const url = safeAuthURL(event.authUrl);
    const redirectState = url ? authRedirectState(url) : undefined;
    if (redirectState) this.oauth.remember(event.serverName, event.state, redirectState);
  }

  /** A message the SDK sends for a stream (not one of ours, `request`: a steering message no stream waits for), or a session it loads. */
  private track(frame: Frame): void {
    if (frame.type !== "request" || typeof frame.id !== "string" || this.pending.has(frame.id)) return;
    if (frame.method === "droid.load_session") { this.loads.add(frame.id); return; }
    const id = record(frame.params)?.messageId;
    if (frame.method !== "droid.add_user_message" || typeof id !== "string") return;
    this.awaited.set(id, { session: null, requestId: frame.id, stream: this.streaming });
    while (this.awaited.size > 64) this.awaited.delete(this.awaited.keys().next().value!);
  }

  /** Only one SDK stream runs on a process; a refused send ends with Droid's reason. */
  async *stream(session: Pick<DroidSession, "stream">, ...params: Parameters<DroidSession["stream"]>) {
    if (this.streaming) throw new Error("A Droid stream is already running.");
    const stream: { refusal?: string } = {};
    this.streaming = stream;
    try {
      for await (const event of session.stream(...params)) {
        if (event.type === "result" && stream.refusal) {
          yield { ...event, error: { type: "error" as const, message: stream.refusal, errorType: DroidErrorType.ERROR, timestamp: new Date().toISOString() } };
        } else yield event;
      }
    } finally {
      if (this.streaming === stream) this.streaming = undefined;
    }
  }

  /** Synthetic ends (a refusal's, an idle turn's: `watchIdle`) settle only an SDK iterator, never a provider's own turn. */
  refusedEnd(notification: unknown): boolean {
    const inner = record(notification);
    return inner?.type === "agent_turn_completed" && typeof inner.turnId === "string" && this.refused.has(inner.turnId);
  }

  /** The answer to a session's load: what it says of its last call is kept (`loadedUsage`). */
  private loaded(frame: Frame): void {
    if (this.loads.size === 0 || frame.type !== "response" || typeof frame.id !== "string" || !this.loads.delete(frame.id)) return;
    this.loadedUsage = record(frame.result)?.lastCallTokenUsage;
  }

  /** The ends to tell after `frame`: one for each awaited message Droid took into the turn it ends. */
  private coalesced(frame: Frame): Message[] {
    if (this.awaited.size === 0 || frame.method !== "droid.session_notification") return [];
    const params = record(frame.params);
    const notification = record(params?.notification);
    if (!params || !notification) return [];
    const session = typeof params.sessionId === "string" ? params.sessionId : "";
    if (notification.type === "create_message") {
      const made = record(notification.message);
      const awaited = typeof made?.id === "string" ? this.awaited.get(made.id) : undefined;
      if (awaited && made?.role === "user") awaited.session = session;
      if (made?.role === "system" && made.visibility === "user_only" && typeof notification.requestId === "string") {
        const text = Array.isArray(made.content) ? made.content.flatMap((block) => {
          const item = record(block);
          return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
        }).join("\n") : "";
        if (!text.startsWith("Error:")) return [];
        for (const [id, waiting] of this.awaited) {
          // A refusal is said of a message Droid never took. One it took (its user row was
          // made) ends with its turn: an error noted on the way (an API error it retries)
          // must not end it early and have the turn's real end filtered (`refusedEnd`).
          if (waiting.requestId !== notification.requestId || waiting.session !== null) continue;
          this.awaited.delete(id);
          if (waiting.stream) waiting.stream.refusal = text.replace(/^Error:\s*/, "");
          this.refused.add(id);
          while (this.refused.size > 64) this.refused.delete(this.refused.values().next().value!);
          return [{ ...frame, params: { ...params, notification: { type: "agent_turn_completed", turnId: id, reason: "error",
            tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } } } } as Message];
        }
      }
      return [];
    }
    if (notification.type !== "agent_turn_completed" || typeof notification.turnId !== "string") return [];
    // Its own end: the stream ends with it.
    if (this.awaited.delete(notification.turnId)) return [];
    const ends: Message[] = [];
    for (const [id, awaited] of this.awaited) {
      if (awaited.session !== session) continue;
      this.awaited.delete(id);
      ends.push({ ...frame, params: { ...params, notification: { ...notification, turnId: id } } } as Message);
    }
    return ends;
  }

  /** A turn's end, made readable to the SDK (`readable`): a stream ended with a reason it does not know says that reason. */
  private normalized(message: Message): Message {
    const frame = message as Frame;
    if (frame.method !== "droid.session_notification") return message;
    const params = record(frame.params);
    const notification = record(params?.notification);
    if (notification?.type !== "agent_turn_completed" || SessionNotificationSchema.safeParse(frame).success) return message;
    const read = readable(frame, notification);
    if (!read) {
      // The SDK drops it: a message's turn is ended once Droid is idle (`watchIdle`).
      log.warn("Droid sent a turn's end the Droid SDK cannot read", { reason: String(notification.reason) });
      return message;
    }
    log.info("Droid sent a turn's end the Droid SDK could not read as it was; it was made readable", { reason: String(notification.reason) });
    if (read.reason !== undefined) {
      // Its stream, and those of the messages Droid took into the turn (`coalesced`).
      const session = typeof params!.sessionId === "string" ? params!.sessionId : "";
      for (const [id, awaited] of this.awaited) {
        if (awaited.stream && (id === notification.turnId || awaited.session === session)) {
          awaited.stream.refusal ??= `Droid ended the turn with a reason Portals does not know${read.reason ? ` ("${read.reason}")` : ""}.`;
        }
      }
    }
    return read.frame as Message;
  }

  /**
   * Droid went idle in a session with a message's turn not ended (its user row made): should
   * its end not come in `idleEndMs`, and Droid not go back to work, the turn is ended here as
   * failed, as a refusal is (`coalesced`), so the SDK's stream ends.
   */
  private watchIdle(frame: Frame, handler: (message: Message) => void): void {
    if (frame.method !== "droid.session_notification") return;
    const params = record(frame.params);
    const notification = record(params?.notification);
    // A process's idle as it starts names no session.
    const session = params?.sessionId;
    if (notification?.type !== "droid_working_state_changed" || typeof session !== "string" || !session) return;
    if (this.idle?.session === session) {
      clearTimeout(this.idle.timer);
      this.idle = undefined;
    }
    if (notification.newState !== DroidWorkingState.Idle || this.idle) return;
    if (![...this.awaited.values()].some((awaited) => awaited.stream && awaited.session === session)) return;
    const timer = setTimeout(() => {
      this.idle = undefined;
      for (const [id, waiting] of this.awaited) {
        if (!waiting.stream || waiting.session !== session) continue;
        log.warn("Droid went idle without ending a message's turn; it was ended", { session });
        this.awaited.delete(id);
        waiting.stream.refusal ??= "Droid stopped working without saying the turn had ended. Send another message to go on.";
        this.refused.add(id);
        while (this.refused.size > 64) this.refused.delete(this.refused.values().next().value!);
        handler({ ...frame, params: { ...params!, notification: { type: "agent_turn_completed", turnId: id, reason: "error",
          tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } } } } as Message);
      }
    }, this.idleEndMs);
    timer.unref();
    this.idle = { session, timer };
  }

  override onMessage(handler: (message: Message) => void): void {
    super.onMessage((received) => {
      const message = this.normalized(received);
      const frame = message as Frame;
      this.observeAuth(frame);
      if (this.pickOptions && frame.type === "request" && frame.method === "droid.pick_options" && typeof frame.id === "string") {
        void this.pick(frame.id, frame.params);
        return;
      }
      this.loaded(frame);
      const ends = this.coalesced(frame);
      this.route(message, handler);
      for (const end of ends) handler(end);
      this.watchIdle(frame, handler);
    });
  }

  /** A pick list answered by `pickOptions`; cancelled, as the SDK's client does, when it cannot be. */
  private async pick(id: string, params: unknown): Promise<void> {
    const result = await this.pickOptions!(params).catch(() => ({ cancelled: true, selectedIds: [] }));
    await this.send({ jsonrpc: "2.0", type: "response", factoryApiVersion: LEGACY_FACTORY_API_VERSION, factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
      id, result } as Message).catch(() => undefined);
  }

  private route(message: Message, handler: (message: Message) => void): void {
    const frame = message as Frame;
    const request = this.pending.size > 0 && frame.type === "response" && typeof frame.id === "string" ? this.pending.get(frame.id) : undefined;
    if (!request) { handler(message); return; }
    this.pending.delete(frame.id as string);
    const error = record(frame.error);
    if (error) request.reject(new Error(typeof error.message === "string" ? error.message : "Droid request failed."));
    else request.resolve(frame.result);
  }

  override onError(handler: (error: Error) => void): void {
    super.onError((error) => { this.rejectPending(error); handler(error); });
  }

  async request<T>(method: string, params: unknown = {}, id = `portals-${randomUUID()}`, timeoutMs = 30_000): Promise<T> {
    if (!this.isConnected) throw new Error("The Droid process is not connected.");
    if (this.pending.has(id)) throw new Error("This Droid request is already pending.");
    let timer: NodeJS.Timeout | undefined;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Droid took too long to answer ${method}.`));
      }, timeoutMs);
      timer.unref();
    });
    try {
      void this.send({
        factoryApiVersion: LEGACY_FACTORY_API_VERSION, factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
        type: "request", jsonrpc: "2.0", id, method, params,
      } as Message).catch((error: Error) => { this.pending.get(id)?.reject(error); });
      return await response as T;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  override async close(): Promise<void> {
    this.authRequests.clear();
    await this.oauth.close();
    this.awaited.clear();
    this.refused.clear();
    this.loads.clear();
    clearTimeout(this.idle?.timer);
    this.idle = undefined;
    this.rejectPending(new Error("The Droid process closed."));
    await super.close();
  }
}
