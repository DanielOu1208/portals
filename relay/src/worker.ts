import { Apns, fetchTransport } from "./apns.ts";
import { makeRelay, type Limiter } from "./relay.ts";
import { makeTunnelRoute, Tunnel, tunnelPath, type TunnelSocket } from "./tunnel.ts";

// The relay as a Cloudflare Worker (wrangler.jsonc). Secrets, set with
// `wrangler secret put` (README.md): APNS_KEY (the .p8 file's contents), APNS_KEY_ID,
// APNS_TEAM_ID, RELAY_SECRET, and RELAY_SECRET_PREVIOUS while a changed secret's tokens
// are still about. The tunnel needs none of them: its routes go to the Durable Object
// `MacTunnel`, one per Mac, before the notification routes look for their secrets.

interface Env {
  APNS_KEY: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  RELAY_SECRET: string;
  RELAY_SECRET_PREVIOUS?: string;
  /** Comma-separated bundle IDs (wrangler.jsonc). */
  BUNDLE_IDS: string;
  DEVICE_LIMIT?: Limiter;
  NOTIFY_LIMIT?: Limiter;
  /** Tunnel connections per relay id. */
  TUNNEL_LIMIT?: Limiter;
  MAC_TUNNEL: DurableObjectNamespace;
}

// The few Workers APIs the tunnel uses, as far as it uses them: the relay's types are
// Node's (tsconfig.json), and there is no dependency for Cloudflare's.

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/** A WebSocket as a Durable Object holds it, with what hibernation keeps beside it. */
type WorkerSocket = TunnelSocket;

interface DurableObjectState {
  acceptWebSocket(socket: WorkerSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WorkerSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
  getWebSocketAutoResponseTimestamp(socket: WorkerSocket): Date | null;
  storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(at: number): Promise<void>;
  };
}

declare const WebSocketPair: new () => { 0: WorkerSocket; 1: WorkerSocket };
declare const WebSocketRequestResponsePair: new (request: string, response: string) => unknown;

// One relay per Worker instance, so its provider token is made once a half hour, not
// once a request. Remade if the instance is handed different settings.
let current: { env: Env; handle: (request: Request) => Promise<Response> } | null = null;

function relayFor(env: Env): (request: Request) => Promise<Response> {
  if (current?.env === env) return current.handle;
  const missing = (["APNS_KEY", "APNS_KEY_ID", "APNS_TEAM_ID", "RELAY_SECRET"] as const).filter((name) => !env[name]);
  if (missing.length > 0) {
    const handle = async () => Response.json({ detail: `The relay is missing ${missing.join(", ")}.` }, { status: 503 });
    current = { env, handle };
    return handle;
  }
  const handle = makeRelay({
    secrets: [env.RELAY_SECRET, env.RELAY_SECRET_PREVIOUS].filter((secret): secret is string => Boolean(secret)),
    bundleIDs: env.BUNDLE_IDS.split(",").map((id) => id.trim()).filter(Boolean),
    apple: new Apns({ key: { pem: env.APNS_KEY, keyId: env.APNS_KEY_ID.trim(), teamId: env.APNS_TEAM_ID.trim() }, transport: fetchTransport() }),
    deviceLimit: env.DEVICE_LIMIT,
    notifyLimit: env.NOTIFY_LIMIT,
  });
  current = { env, handle };
  return handle;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const tunnel = makeTunnelRoute({
      limit: env.TUNNEL_LIMIT,
      forward: (relay, forwarded) => env.MAC_TUNNEL.get(env.MAC_TUNNEL.idFromName(relay)).fetch(forwarded),
    });
    return tunnel(request) ?? relayFor(env)(request);
  },
};

/**
 * One Mac's tunnel (src/tunnel.ts), a SQLite-backed Durable Object named by the Mac's
 * relay id. Its sockets are hibernatable: the object can sleep while they stay open, and
 * the standby socket's `ping` is answered with `pong` without waking it.
 */
export class MacTunnel {
  private readonly tunnel: Tunnel<WorkerSocket>;

  constructor(state: DurableObjectState) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.tunnel = new Tunnel<WorkerSocket>({
      accept: (socket, tags) => state.acceptWebSocket(socket, tags),
      sockets: (tag) => state.getWebSockets(tag),
      get: (key) => state.storage.get(key),
      put: (key, value) => state.storage.put(key, value),
      setAlarm: (at) => state.storage.setAlarm(at),
      now: () => Date.now(),
      pinged: (socket) => state.getWebSocketAutoResponseTimestamp(socket)?.getTime(),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const route = tunnelPath(new URL(request.url).pathname);
    if (!route) return Response.json({ detail: "Not found." }, { status: 404 });
    // Which run of a bridge opens a standby socket, so another bridge with the same relay id does not take it.
    const instance = request.headers.get("x-portals-standby");
    const refused = await this.tunnel.admit(route.leg, request.headers.get("authorization"), instance);
    if (refused) return Response.json({ detail: refused.detail }, { status: refused.status });
    const pair = new WebSocketPair();
    await this.tunnel.opened(pair[1], route.leg, instance);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  webSocketMessage(socket: WorkerSocket, message: string | ArrayBuffer): void {
    this.tunnel.message(socket, message);
  }

  webSocketClose(socket: WorkerSocket, code: number, reason: string): void {
    this.tunnel.closed(socket, code, reason);
  }

  webSocketError(socket: WorkerSocket): void {
    this.tunnel.closed(socket, 1011, "");
  }

  alarm(): Promise<void> {
    return this.tunnel.alarm();
  }
}
