import { base64url, fromBase64url, utf8 } from "./encoding.ts";

// The tunnel (docs/pairing-and-relay.md, "The tunnel"): a backup way from a device to a
// Mac it cannot reach directly. Each Mac has one object, named by its relay id, which
// keeps three kinds of WebSocket:
//
// - the Mac's standby socket (`GET /v1/tunnel/<relay id>/mac`), always open and idle;
// - a device (`GET /v1/tunnel/<relay id>/device`), which is given a channel id, and the
//   standby socket is told `{"type":"open","channel":"…"}`;
// - the Mac's leg of that channel (`GET /v1/tunnel/<relay id>/mac/<channel>`), which the
//   object pairs with the device's, passing every message both ways as it is.
//
// What passes is sealed end to end between the device and the bridge: the relay holds no
// key and reads nothing. The Mac proves itself with its relay secret: the first standby
// socket claims the object (the secret's SHA-256 is kept), later ones must bring the same.
// A device brings nothing here; the bridge checks it.
//
// The object may be put to sleep between messages (the Worker's hibernation), so nothing
// lives in its memory but what it can read again: each socket's tags and attachment say
// what it is, and a device's few frames sent before the Mac's leg came are kept in its
// attachment. The Worker (src/worker.ts) hands this the object's sockets and storage; the
// tests hand it stand-ins.

/** 16 bytes in base64url: a relay id, or a channel id. */
export const idPattern = /^[A-Za-z0-9_-]{22}$/;
/** 32 bytes in base64url: a relay secret. */
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
/** What a bridge names its run by on its standby socket (`X-Portals-Standby`): base64url. */
const instancePattern = /^[A-Za-z0-9_-]{16,64}$/;
/**
 * A standby socket with no ping answered for this long is taken for gone (its bridge pings
 * every 30 s): another bridge's newer one may take its place.
 */
export const standbyStaleMs = 75_000;

/** How long a device waits for the Mac to open its leg of the channel. */
export const answerMs = 10_000;
/** At most this many devices through the tunnel to one Mac at once. */
export const mostDevices = 20;
/** What a device may send before the Mac's leg is there (its handshake's first frame is 32 bytes). */
const mostWaitingBytes = 1024;
/** The app sends one key and waits for the Mac's reply; leave room for a few extra messages. */
const mostWaitingFrames = 4;
/** Application budget for pending state, including base64, escaping and metadata; not a structured-clone size measurement. */
const mostWaitingAttachmentBytes = 1536;

/** The close codes a device or the Mac's leg is told (docs/pairing-and-relay.md). */
export const TunnelClose = {
  /** The device sent more than its handshake before the Mac's leg was there. */
  tooEarly: 4400,
  /** Another standby socket of the same Mac took this one's place. */
  replaced: 4409,
  /** The Mac already has the most devices through the tunnel. */
  tooMany: 4429,
  /** No standby socket: the Mac is not connected to the relay. */
  noMac: 4503,
  /** The Mac did not open its leg of the channel in time. */
  noAnswer: 4504,
} as const;

/** Which of a Mac's tunnel routes a socket came by. */
export type Leg = { kind: "mac" } | { kind: "channel"; channel: string } | { kind: "device" };

/** A tunnel route's relay id and leg, or undefined for a path that is not one. */
export function tunnelPath(pathname: string): { relay: string; leg: Leg } | undefined {
  const match = /^\/v1\/tunnel\/([A-Za-z0-9_-]{22})\/(mac|device)(?:\/([A-Za-z0-9_-]{22}))?$/.exec(pathname);
  if (!match) return undefined;
  const [, relay, side, channel] = match;
  if (side === "device") return channel === undefined ? { relay, leg: { kind: "device" } } : undefined;
  return { relay, leg: channel === undefined ? { kind: "mac" } : { kind: "channel", channel } };
}

/** A WebSocket the object has accepted, as the Worker's hibernation API gives it. */
export interface TunnelSocket {
  send(message: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  /** What the object keeps with the socket, which outlives its sleep: at most 16 KiB serialized by the runtime. */
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** What the object runs on: its sockets by tag, its storage and its alarm. */
export interface TunnelHost<Socket extends TunnelSocket> {
  /** Takes the socket in with its tags (`acceptWebSocket`). */
  accept(socket: Socket, tags: string[]): void;
  /** The open sockets with this tag, oldest first (`getWebSockets`). */
  sockets(tag: string): Socket[];
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  /** Calls `alarm` at this time, in milliseconds since 1970, instead of any time set before. */
  setAlarm(at: number): Promise<void>;
  now(): number;
  /** When the runtime last answered the socket's `ping`, in milliseconds since 1970 (`getWebSocketAutoResponseTimestamp`); undefined before any. */
  pinged?(socket: Socket): number | undefined;
}

/** A Mac's socket refused before it opens: the HTTP status and a sentence. */
export interface Refusal {
  status: number;
  detail: string;
}

/** A frame kept for the Mac's leg: base64url for binary (`b`), else text (`t`). */
type Waiting = { b: string } | { t: string };

type Attachment =
  | { leg: "mac"; since: number; replaced?: true; instance?: string }
  | { leg: "channel"; channel: string }
  | { leg: "device"; channel: string; opened: number; paired: boolean; waiting: Waiting[] }
  | { leg: "refused" };

export class Tunnel<Socket extends TunnelSocket> {
  private readonly host: TunnelHost<Socket>;
  private readonly log: (line: string) => void;
  /** The SHA-256 of the Mac's secret, hex, once read from storage. */
  private claimed: string | undefined;

  constructor(host: TunnelHost<Socket>, log: (line: string) => void = (line) => console.log(line)) {
    this.host = host;
    this.log = log;
  }

  /**
   * Whether a socket may open on `leg`: undefined, or why not. A Mac's socket must bring
   * the secret that claimed the object, and the first standby socket claims it. A
   * device is always let through, and told by a close code once it is open.
   */
  async admit(leg: Leg, authorization: string | null, instance: string | null = null): Promise<Refusal | undefined> {
    if (leg.kind === "device") return undefined;
    const secret = /^Bearer (\S+)$/i.exec(authorization ?? "")?.[1] ?? "";
    if (!secretPattern.test(secret)) return { status: 401, detail: "Open the tunnel with the Mac's relay secret." };
    const hash = await sha256(secret);
    this.claimed ??= (await this.host.get("secret")) as string | undefined;
    if (this.claimed === undefined) {
      if (leg.kind !== "mac") return { status: 404, detail: "No device is waiting on this channel." };
      await this.host.put("secret", hash);
      this.claimed = hash;
      this.log("tunnel: claimed by its Mac");
    } else if (this.claimed !== hash) {
      this.log(`tunnel: refused a ${leg.kind} socket with another secret`);
      return { status: 401, detail: "This relay id belongs to another Mac." };
    }
    if (leg.kind === "mac" && this.heldByAnother(instance)) {
      this.log("tunnel: refused a standby socket of another bridge with this Mac's relay id");
      return { status: 409, detail: "This relay id is in use by another bridge." };
    }
    if (leg.kind === "channel") {
      if (this.host.sockets(`device:${leg.channel}`).length === 0) return { status: 404, detail: "No device is waiting on this channel." };
      if (this.host.sockets(`channel:${leg.channel}`).length > 0) return { status: 409, detail: "This channel is already open." };
    }
    return undefined;
  }

  /**
   * Whether a standby socket of another run of a bridge (`instance`, its
   * `X-Portals-Standby`) holds the object and is alive: two bridges with the one relay id
   * (a copied bridge folder) took the standby socket from each other, each the newest in
   * turn. The first keeps it (2026-10-26: "First keeps it, newcomer warns"); the
   * same run's newer socket still takes its place (a reconnect the relay has not seen the
   * end of), and so does any newer one once the holder's pings have stopped
   * (`standbyStaleMs`). A bridge that names no run (from before this) replaces as before.
   */
  private heldByAnother(instance: string | null): boolean {
    if (instance === null || !instancePattern.test(instance)) return false;
    const holder = this.standbys().at(-1);
    const state = holder ? attachment(holder) : undefined;
    if (!holder || state?.leg !== "mac" || state.instance === undefined || state.instance === instance) return false;
    const heard = Math.max(state.since, this.host.pinged?.(holder) ?? 0);
    return this.host.now() - heard < standbyStaleMs;
  }

  /** Takes in a socket `admit` let through, now open. */
  async opened(socket: Socket, leg: Leg, instance: string | null = null): Promise<void> {
    switch (leg.kind) {
      case "mac":
        return this.standby(socket, instance !== null && instancePattern.test(instance) ? instance : undefined);
      case "channel":
        return this.channel(socket, leg.channel);
      case "device":
        return this.device(socket);
    }
  }

  /** The Mac's standby socket: the newest one is used, and any before it closed (`admit` keeps another bridge's newer one out). */
  private standby(socket: Socket, instance: string | undefined): void {
    const before = this.standbys();
    this.host.accept(socket, ["mac"]);
    socket.serializeAttachment({ leg: "mac", since: this.host.now(), ...(instance ? { instance } : {}) } satisfies Attachment);
    for (const old of before) {
      old.serializeAttachment({ ...attachment(old), replaced: true });
      shut(old, TunnelClose.replaced, "Another standby connection of this Mac took its place.");
    }
  }

  /** The standby sockets not replaced by a newer one, oldest first: one, unless one is just opening. */
  private standbys(): Socket[] {
    const open = this.host.sockets("mac").flatMap((socket) => {
      const state = attachment(socket);
      return state?.leg === "mac" && !state.replaced ? [{ socket, since: state.since }] : [];
    });
    return open.sort((one, other) => one.since - other.since).map((entry) => entry.socket);
  }

  private async device(socket: Socket): Promise<void> {
    const standby = this.standbys().at(-1);
    if (!standby) return this.refuse(socket, TunnelClose.noMac, "The Mac is not connected to the relay.");
    if (this.host.sockets("device").length >= mostDevices) return this.refuse(socket, TunnelClose.tooMany, "Too many devices are connected to this Mac through the relay.");
    const channel = base64url(crypto.getRandomValues(new Uint8Array(16)));
    this.host.accept(socket, ["device", `device:${channel}`]);
    socket.serializeAttachment({ leg: "device", channel, opened: this.host.now(), paired: false, waiting: [] } satisfies Attachment);
    try {
      standby.send(JSON.stringify({ type: "open", channel }));
    } catch {
      shut(socket, TunnelClose.noMac, "The Mac is not connected to the relay.");
      return;
    }
    await this.wake();
  }

  /** The Mac's leg of `channel`: paired with the device's, which gets what it sent meanwhile. */
  private channel(socket: Socket, channel: string): void {
    this.host.accept(socket, ["channel", `channel:${channel}`]);
    socket.serializeAttachment({ leg: "channel", channel } satisfies Attachment);
    const device = this.host.sockets(`device:${channel}`)[0];
    const state = device ? attachment(device) : undefined;
    if (!device || state?.leg !== "device" || state.paired) {
      shut(socket, 1000, "The device is gone.");
      return;
    }
    for (const frame of state.waiting) socket.send("b" in frame ? fromBase64url(frame.b)!.buffer : frame.t);
    device.serializeAttachment({ ...state, paired: true, waiting: [] } satisfies Attachment);
  }

  /** Accepted only to be closed: a WebSocket's close code is what the app reads. */
  private refuse(socket: Socket, code: number, reason: string): void {
    this.host.accept(socket, ["refused"]);
    socket.serializeAttachment({ leg: "refused" } satisfies Attachment);
    shut(socket, code, reason);
  }

  /** A message on one of the sockets: passed to the other end of its channel as it is. */
  message(socket: Socket, message: string | ArrayBuffer): void {
    const state = attachment(socket);
    if (state?.leg === "device" && !state.paired) {
      if (state.waiting.length >= mostWaitingFrames) {
        shut(socket, TunnelClose.tooEarly, "Wait for the Mac before sending more.");
        return;
      }
      const waiting: Waiting = typeof message === "string" ? { t: message } : { b: base64url(new Uint8Array(message)) };
      const bytes = state.waiting.reduce((sum, frame) => sum + size(frame), 0) + size(waiting);
      const next = { ...state, waiting: [...state.waiting, waiting] } satisfies Attachment;
      if (bytes > mostWaitingBytes || utf8(JSON.stringify(next)).length > mostWaitingAttachmentBytes) {
        shut(socket, TunnelClose.tooEarly, "Wait for the Mac before sending more.");
        return;
      }
      socket.serializeAttachment(next);
      return;
    }
    // The standby socket says nothing but `ping`, which the Worker answers without this.
    if (state?.leg !== "device" && state?.leg !== "channel") return;
    const other = this.other(state);
    try {
      if (!other) throw new Error("gone");
      other.send(message);
    } catch {
      shut(socket, 1001, "The other end of the tunnel is gone.");
    }
  }

  /** A socket closed (or failed): its close is answered, and the other end of its channel closes too. */
  closed(socket: Socket, code: number, reason: string): void {
    // Its closing handshake finished, which the Worker leaves to the object.
    shut(socket, passable(code) ? code : 1000, reason);
    const state = attachment(socket);
    if (state?.leg === "device" || state?.leg === "channel") {
      const passed = passable(code) ? { code, reason } : { code: 1001, reason: "The other end of the tunnel went away." };
      const other = this.other(state);
      if (other) shut(other, passed.code, passed.reason);
      return;
    }
    // The last standby socket gone: the devices still waiting for the Mac will not get it.
    if (state?.leg === "mac" && this.standbys().every((other) => other === socket)) {
      for (const device of this.host.sockets("device")) {
        const waiting = attachment(device);
        if (waiting?.leg === "device" && !waiting.paired) shut(device, TunnelClose.noMac, "The Mac is not connected to the relay.");
      }
    }
  }

  /** The alarm: devices the Mac did not answer in time are closed, and it is set again for the next. */
  async alarm(): Promise<void> {
    await this.wake();
  }

  private async wake(): Promise<void> {
    const now = this.host.now();
    let next = Infinity;
    for (const device of this.host.sockets("device")) {
      const state = attachment(device);
      if (state?.leg !== "device" || state.paired) continue;
      const due = state.opened + answerMs;
      if (due <= now) shut(device, TunnelClose.noAnswer, "The Mac did not answer.");
      else next = Math.min(next, due);
    }
    if (next !== Infinity) await this.host.setAlarm(next);
  }

  /** The other end of a channel: the Mac's leg for a device, the device for the Mac's leg. */
  private other(state: { leg: "device" | "channel"; channel: string }): Socket | undefined {
    return this.host.sockets(state.leg === "device" ? `channel:${state.channel}` : `device:${state.channel}`)[0];
  }
}

/** The Worker's own part of the routes: which object, after the rate limit. */
export interface TunnelRouteOptions {
  /** Connections per relay id. None: no limit. */
  limit?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** Hands the request to the object named `relay`. */
  forward(relay: string, request: Request): Promise<Response>;
}

/** The Worker's handler for `/v1/tunnel/…`: undefined for any other path. */
export function makeTunnelRoute(options: TunnelRouteOptions): (request: Request) => Promise<Response> | undefined {
  return (request) => {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/v1/tunnel/")) return undefined;
    return (async () => {
      const route = tunnelPath(pathname);
      if (!route) return problem(404, "Not found.");
      if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return problem(426, "This route takes a WebSocket.", { upgrade: "websocket" });
      }
      if (options.limit && !(await options.limit.limit({ key: route.relay })).success) {
        return problem(429, "Too many connections to this Mac; try again in a minute.", { "retry-after": "60" });
      }
      return options.forward(route.relay, request);
    })();
  };
}

function attachment(socket: TunnelSocket): Attachment | undefined {
  return (socket.deserializeAttachment() ?? undefined) as Attachment | undefined;
}

/** Closes a socket, which may be closing already: the Worker's throws then, and there is nothing more to do. */
function shut(socket: TunnelSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Closed already.
  }
}

function size(frame: Waiting): number {
  return "b" in frame ? (frame.b.length * 3) / 4 : utf8(frame.t).length;
}

/** Whether a close code may be sent on as it is: 1000, or one of the 3000s and 4000s. */
function passable(code: number): boolean {
  return code === 1000 || (code >= 3000 && code <= 4999);
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function problem(status: number, detail: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ detail }), { status, headers: { "content-type": "application/json", ...headers } });
}
