import type WebSocket from "ws";

// One call to a gateway as a client of it: this bridge's own, for the `portals`
// command, or another Mac's, for a link (docs/fleet-plan.md). Connect, wait for
// `gateway.ready`, ask, take the answer and hang up. The frames are the ones the app
// sends (docs/gateway-protocol.md, section 3).

/** The gateway's answer was an error: its code and its sentence. */
export class GatewayError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** The gateway closed the connection before answering, with this close code. */
export class HungUp extends Error {
  readonly code: number;

  constructor(code: number) {
    super("The bridge hung up before answering.");
    this.code = code;
  }
}

/** The socket exhausted its call budget, with the existing public sentence. */
export class CallTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`The bridge did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
  }
}

/**
 * The bytes a call sent and received, added up as it goes, for whoever counts them
 * (counters.ts). What it sent is counted as it is handed over, so a call that fails
 * part way still has it.
 */
export interface CallBytes {
  out: number;
  in: number;
  /** Sign-ins the call tried first (links.ts). */
  signins: number;
}

export interface CallRequest {
  method: string;
  params: Record<string, unknown>;
}

/** Choose the old call on the same connection when the greeting lacks this feature. */
export interface CallFallback extends CallRequest {
  feature: string;
}

export type CallReceiver = (answer: unknown, method: string) => { result: unknown } | { call: CallRequest };
export type CallReady = (features: unknown[]) => void;

/**
 * Makes one call over the socket `open` makes. Rejects with `GatewayError`, `HungUp`, or
 * the socket's own error. `signal` hangs up early: the other side lets go of the call
 * (a wait, say) when the connection closes. `bytes`, when given, is added to.
 */
export function callOnce(open: () => WebSocket, method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal, bytes?: CallBytes, fallback?: CallFallback, receive?: CallReceiver, ready?: CallReady): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const socket = open();
    let done = false;
    let requestId = 0;
    let currentMethod = method;
    const send = (call: CallRequest) => {
      currentMethod = call.method;
      const request = JSON.stringify({ jsonrpc: "2.0", id: `c${++requestId}`, method: call.method, params: call.params });
      if (bytes) bytes.out += Buffer.byteLength(request);
      socket.send(request);
    };
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abandon);
      socket.terminate();
      settle();
    };
    const abandon = () => finish(() => reject(signal?.reason));
    signal?.addEventListener("abort", abandon, { once: true });
    const timer = setTimeout(() => finish(() => reject(new CallTimeout(timeoutMs))), timeoutMs);
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", (code) => finish(() => reject(new HungUp(code))));
    socket.on("message", (data) => {
      if (done) return;
      let frame: { id?: unknown; method?: unknown; params?: { type?: unknown; payload?: { bridge?: { features?: unknown } } }; result?: unknown; error?: { code?: number; message?: string } };
      const text = data.toString();
      if (bytes) bytes.in += Buffer.byteLength(text);
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      // The gateway speaks first; anything sent before that is thrown away.
      if (frame.method === "event" && frame.params?.type === "gateway.ready") {
        if (requestId !== 0) return;
        const features = frame.params.payload?.bridge?.features;
        const old = fallback && (!Array.isArray(features) || !features.includes(fallback.feature));
        try {
          ready?.(Array.isArray(features) ? features : []);
          send(old ? fallback : { method, params });
        } catch (error) {
          finish(() => reject(error));
        }
        return;
      }
      if (frame.id !== `c${requestId}` || frame.method !== undefined) return;
      const failure = frame.error;
      if (failure) finish(() => reject(new GatewayError(failure.code ?? -32603, failure.message ?? "The bridge refused.")));
      else {
        try {
          const reply = receive ? receive(frame.result, currentMethod) : { result: frame.result };
          if ("call" in reply) send(reply.call);
          else finish(() => resolve(reply.result));
        } catch (error) {
          finish(() => reject(error));
        }
      }
    });
  });
}
