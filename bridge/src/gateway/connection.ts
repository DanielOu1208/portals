import { homedir, hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { counters, type ConnectionKind, type FrameKind } from "../counters.ts";
import { log } from "../log.ts";
import type { SignedIn } from "../net/net.ts";
import { hostOS } from "../platform.ts";
import { SettingRefused } from "../providers/types.ts";
import { redacted } from "../push/notifier.ts";
import type { LoggedEvent } from "../sessions/eventLog.ts";
import { version } from "../version.ts";
import { wellFormedJSON } from "../json.ts";
import { ErrorCode, RpcError } from "./errors.ts";
import { bridgeFeatures, bridgeProtocol } from "./features.ts";
import type { GatewaySocket } from "./gateway.ts";
import { Atomic, checkParams, methods, type Caller, type GatewayContext } from "./methods.ts";
import type { ConnectionEvent } from "./pollNow.ts";

// One app connection: JSON-RPC 2.0 over one WebSocket, one JSON object per text frame
// (docs/gateway-protocol.md, sections 3 and 4).
//
// The bridge speaks first, with `gateway.ready`. After that the app's requests are
// answered as they come, possibly out of order; events and the bridge's own questions
// go out in the order they happen. A frame that is not JSON is skipped.

let nextConnection = 1;

/**
 * Unsolicited events waiting for a device that stopped reading (a suspended app, for
 * example), excluding answers and the largest other frame. Reconnects can ask for
 * every running thread's whole conversation, and one tool event may itself be large.
 * Once written out, either exemption counts for nothing. The independent total queue
 * ceiling below also counts answers.
 */
const mostWaitingBytes = 8 * 1024 * 1024;
/**
 * All queued bytes, including replies: eight maximum 16 MiB relay frames, with ample
 * room for concurrent reconnect snapshots (six 3 MiB conversations in the regression).
 * An empty queue admits one frame of any size, so a huge direct snapshot can start;
 * only another frame waiting behind it can trip this ceiling.
 */
const mostQueuedBytes = 128 * 1024 * 1024;

export interface ReadyInfo {
  replayEpoch: string;
  /** What keeps devices from reaching this Mac through the relay, read as `gateway.ready` goes. */
  relayProblem?: () => string | undefined;
}

export class Connection implements Caller {
  readonly number = nextConnection++;
  takesRequests = false;
  keepsSubagentRequests = false;
  keepsAsyncQuestions = false;
  deviceID: string | undefined = undefined;
  sessionResync = false;
  messageReconciliation = false;
  leanDeltas = false;
  readonly replayEpoch: string;
  /** How it signed in: with the password, a member's token, or on the `portals` command's socket (not through the HTTP server). */
  readonly signedIn: SignedIn;
  private readonly socket: GatewaySocket;
  private readonly gateway: GatewayContext;
  /** Aborted when the socket closes, so what waits for this connection lets go. */
  private readonly closed = new AbortController();
  /** The frames handed to the socket, and how many of them it has written out, in order: a frame's number is how many came before it. */
  private framesSent = 0;
  private framesWritten = 0;
  /** The answers still waiting in the socket, oldest first, with the bytes each put in its queue; and what those add up to. */
  private readonly answers: { frame: number; bytes: number }[] = [];
  private answersWaiting = 0;
  /** Of the other frames still waiting, oldest first, each one larger than every one after it: the first is the largest. */
  private readonly largest: { frame: number; bytes: number }[] = [];
  /** Called by the socket as each frame is written out. */
  private readonly written = () => {
    this.framesWritten += 1;
    while (this.answers.length > 0 && this.answers[0].frame < this.framesWritten) this.answersWaiting -= this.answers.shift()!.bytes;
    while (this.largest.length > 0 && this.largest[0].frame < this.framesWritten) this.largest.shift();
  };

  constructor(socket: GatewaySocket, gateway: GatewayContext, ready: ReadyInfo, signedIn: SignedIn) {
    this.socket = socket;
    this.gateway = gateway;
    this.signedIn = signedIn;
    this.replayEpoch = ready.replayEpoch;
    socket.on("close", () => this.closed.abort(new Error("The connection closed.")));
    socket.on("message", (data) => {
      // Binary frames are read as UTF-8 text, as the app does.
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      void this.receive(bytes.toString("utf8"), bytes.length);
    });
    this.send("ready", {
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "gateway.ready",
        payload: {
          replay_epoch: ready.replayEpoch,
          heartbeat: true,
          // The extensions in section 11 this bridge offers (features.ts).
          // `machine` is read now: a Mac's host name changes with its network. Its `id`
          // does not: the bridge gave it to itself once (feature machine_order). Its `os`
          // is "macos" or "linux"; an app takes a bridge that does not say for a Mac's. `net`
          // says where the net's list is, so a device asks `net.list` only when it moved.
          // `version` is the bridge's own (package.json), for the app's About.
          // `relay_problem`, only when there is one: "in_use", another bridge holds this Mac's relay id.
          // `latest`, only when there is one: a later portals-host that is out (feature update_notice).
          bridge: { protocol: bridgeProtocol, version, features: bridgeFeatures, machine: { hostname: hostname(), home: homedir(), id: gateway.machine, os: hostOS }, net: gateway.net.revision(), ...relayProblem(ready.relayProblem?.()), ...latest(gateway.updates?.latest) },
        },
      },
    });
  }

  get isOpen(): boolean {
    return this.socket.readyState === this.socket.OPEN;
  }

  /**
   * What the connection turned out to be, for the counters. A device says first that it
   * answers the bridge's questions (`client.capabilities`), which a linked Mac's call
   * never does; that is kept whether or not the counters are on, so a device that
   * connected while they were off is a device once they are on.
   */
  get kind(): ConnectionKind {
    return this.signedIn.kind === "local" ? "local" : this.takesRequests ? "app" : "link";
  }

  sendEvent(event: LoggedEvent): void {
    if (
      this.leanDeltas && (event.type === "message.delta" || event.type === "reasoning.delta") &&
      typeof event.payload?.text === "string" && Object.keys(event.payload).length === 1
    ) {
      // Only the live envelope changes: the log and replay keep the same event and seq.
      this.send("events", { [event.type === "message.delta" ? "d" : "t"]: [event.session_id, event.seq, event.payload.text] });
      return;
    }
    this.send("events", { jsonrpc: "2.0", method: "event", params: event });
  }

  resync(): void {
    this.socket.close(1012, "Session snapshot changed");
  }

  /** Closes the connection with a code and a reason. */
  close(code: number, reason: string): void {
    this.closed.abort(new Error(reason));
    this.socket.close(code, reason);
  }

  /** An event about no session (`poll.now`), with neither `session_id` nor `seq`. */
  sendConnectionEvent(event: ConnectionEvent): void {
    this.send("events", { jsonrpc: "2.0", method: "event", params: event });
  }

  sendRequest(id: string, method: string, params: Record<string, unknown>): void {
    this.send("asks", { jsonrpc: "2.0", id, method, params });
  }

  /** Sends a frame; its bytes when the counters are on, else 0. */
  private send(kind: FrameKind, frame: unknown): number {
    if (!this.isOpen) return 0;
    const waiting = this.socket.bufferedAmount;
    if (waiting >= mostQueuedBytes) {
      this.stoppedReading(waiting, "queued outbound bytes", mostQueuedBytes);
      return 0;
    }
    if (waiting === 0) {
      // All written out, whether or not the socket has said so yet.
      this.answers.length = 0;
      this.answersWaiting = 0;
      this.largest.length = 0;
    } else if (waiting - this.answersWaiting - (this.largest[0]?.bytes ?? 0) > mostWaitingBytes) {
      this.stoppedReading(waiting);
      return 0;
    }
    // Half of a surrogate pair (a string cut in an emoji) would make the app drop the frame.
    const text = wellFormedJSON(frame);
    const bytes = Buffer.byteLength(text);
    if (waiting > 0 && waiting + bytes > mostQueuedBytes) {
      this.stoppedReading(waiting, "queued outbound bytes", mostQueuedBytes);
      return 0;
    }
    const number = this.framesSent++;
    this.socket.send(text, this.written);
    const buffered = this.socket.bufferedAmount;
    const added = buffered - waiting;
    if (added > 0 && kind === "answers") {
      this.answers.push({ frame: number, bytes: added });
      this.answersWaiting += added;
    } else if (added > 0) {
      while (this.largest.length > 0 && this.largest[this.largest.length - 1].bytes <= added) this.largest.pop();
      this.largest.push({ frame: number, bytes: added });
    }
    if (!counters.on) return 0;
    counters.sent(kind, bytes, buffered);
    return bytes;
  }

  /**
   * The device stopped reading and what waits for it keeps growing: the connection is
   * dropped, without the closing handshake, whose frame would wait behind the rest. The
   * app takes it as any dropped connection: it connects again and catches up by event
   * number, or from the whole conversation when the log no longer reaches back
   * (docs/gateway-protocol.md, sections 2 and 8).
   */
  private stoppedReading(waiting: number, reason = "unread events", limit = mostWaitingBytes): void {
    log.warn("dropped a connection that stopped reading", { connection: this.number, reason, waiting, limit });
    this.closed.abort(new Error("The connection stopped reading."));
    this.socket.terminate();
  }

  private async receive(text: string, bytes: number): Promise<void> {
    // Frames already on their way may arrive during the closing handshake after removal.
    if (!this.isOpen || this.closed.signal.aborted) return;
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      log.debug("skipped a frame that is not JSON", { connection: this.number });
      return;
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
    const { id, method, params } = frame as { id?: unknown; method?: unknown; params?: unknown };

    if (typeof method === "string") {
      // A notification (no id) asks for no answer; none is used by the app.
      if (id === undefined || id === null) return;
      await this.call(id, method, params, bytes);
      return;
    }
    if (typeof id === "string") this.answered(id, frame as Record<string, unknown>);
  }

  /** The app answered one of the bridge's questions. */
  private answered(id: string, frame: Record<string, unknown>): void {
    const session = this.gateway.sessions.withRequest(id);
    if (!session) {
      log.debug("an answer for a question that is closed or unknown", { connection: this.number, id });
      return;
    }
    const answer = "error" in frame && frame.error ? { error: frame.error as { code?: number; message?: string } } : { result: frame.result };
    if (!session.requests.answer(this, id, answer)) {
      log.info("ignored an answer from a connection that does not follow the thread", { connection: this.number, id });
    }
  }

  private async call(id: unknown, method: string, params: unknown, bytes: number): Promise<void> {
    const spec = Object.hasOwn(methods, method) ? methods[method] : undefined;
    const after: (() => void)[] = [];
    const started = counters.on ? performance.now() : 0;
    let sent = 0;
    let failed = false;
    try {
      if (!spec) throw new RpcError(ErrorCode.methodNotFound, `The bridge does not support ${method}.`);
      // A Mac removed from the net may only ask for the list, to learn that it is out.
      if (this.signedIn.kind === "member" && this.signedIn.removed && method !== "net.sync") throw new RpcError(ErrorCode.notAllowed, "This Mac was removed from the net.");
      const given = params === undefined || params === null ? {} : params;
      if (typeof given !== "object" || Array.isArray(given)) throw new RpcError(ErrorCode.invalidParams, "params must be an object.");
      checkParams(spec, given as Record<string, unknown>);
      let result = await spec.handle(given as Record<string, unknown>, {
        caller: this,
        gateway: this.gateway,
        afterReply: (action) => after.push(action),
        hungUp: this.closed.signal,
      });
      // Built and sent in one step; see `Atomic`.
      if (result instanceof Atomic) {
        if (this.closed.signal.aborted) return;
        result = result.build();
      }
      // A non-Atomic handler may already have accepted a prompt: its afterReply
      // action must still begin that turn even when the reply cannot be sent.
      sent = this.send("answers", { jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      // A call let go of because the connection closed: nobody to tell.
      if (this.closed.signal.aborted) return;
      sent = this.send("answers", { jsonrpc: "2.0", id, error: describe(error, method) });
      failed = true;
    }
    // Only a method of the bridge's own is counted by name: any other is a client's word.
    if (started) counters.rpc(spec ? method : "other", this.kind, performance.now() - started, bytes, sent, failed, waits(method, params));
    if (failed) return;
    for (const action of after) action();
  }
}

/** A call that waits for a thread on purpose (`thread.wait`, or a send or start with `wait`): its time is not work. */
function waits(method: string, params: unknown): boolean {
  return method === "thread.wait" || (typeof params === "object" && params !== null && (params as { wait?: unknown }).wait === true);
}

function describe(error: unknown, method: string): { code: number; message: string; data?: unknown } {
  if (error instanceof RpcError) {
    return error.data === undefined ? { code: error.code, message: error.message } : { code: error.code, message: error.message, data: error.data };
  }
  // Not a failure of the bridge: the agent has no such setting, and the sentence says so.
  if (error instanceof SettingRefused) return { code: ErrorCode.invalidParams, message: error.message };
  log.error(`${method} failed`, { error: redacted((error as Error)?.stack ?? String(error)) });
  const message = error instanceof Error && error.message ? redacted(error.message) : "Something went wrong on the bridge.";
  return { code: ErrorCode.internal, message };
}

function relayProblem(problem: string | undefined): { relay_problem?: string } {
  return problem ? { relay_problem: problem } : {};
}

function latest(version: string | undefined): { latest?: string } {
  return version ? { latest: version } : {};
}
