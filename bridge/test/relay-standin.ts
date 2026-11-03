import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { Tunnel, tunnelPath, type Leg, type TunnelHost, type TunnelSocket } from "../../relay/src/tunnel.ts";

// The relay's tunnel in this process: the Worker's Durable Object logic itself
// (relay/src/tunnel.ts) over `ws` sockets, with the Worker's part played here: one object
// per relay id, `ping` answered with `pong` without it, hibernation's tags and
// attachments, and its alarm as a timer. No rate limit. For the bridge's tests of its
// side of the tunnel; `wrangler dev` runs the real Worker (scripts/tunnel-check.ts).

class StandInSocket implements TunnelSocket {
  readonly ws: WebSocket;
  tags: string[] = [];
  private attachment: unknown = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  send(message: string | ArrayBuffer): void {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error("Can't call send() on a socket that is not open.");
    if (typeof message === "string") this.ws.send(message);
    else this.ws.send(Buffer.from(message), { binary: true });
  }

  close(code?: number, reason?: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error("Can't call close() after close().");
    this.ws.close(code, reason);
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
}

class StandInHost implements TunnelHost<StandInSocket> {
  readonly accepted = new Set<StandInSocket>();
  private readonly storage = new Map<string, unknown>();
  private timer: NodeJS.Timeout | undefined;
  alarm: () => Promise<void> = async () => undefined;
  /** When each socket's `ping` was last answered. */
  readonly pings = new Map<StandInSocket, number>();

  accept(socket: StandInSocket, tags: string[]): void {
    socket.tags = tags;
    this.accepted.add(socket);
    socket.ws.on("close", () => this.accepted.delete(socket));
  }

  sockets(tag: string): StandInSocket[] {
    return [...this.accepted].filter((socket) => socket.tags.includes(tag) && socket.ws.readyState === WebSocket.OPEN);
  }

  async get(key: string): Promise<unknown> {
    return this.storage.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.storage.set(key, value);
  }

  async setAlarm(at: number): Promise<void> {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.alarm(), Math.max(0, at - Date.now()));
  }

  now(): number {
    return Date.now();
  }

  pinged(socket: StandInSocket): number | undefined {
    return this.pings.get(socket);
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

export class RelayStandIn {
  readonly url: string;
  /** Each socket that asked to open, by leg, in order: the Mac's standby sockets, its legs and the devices. */
  readonly asked: Leg["kind"][] = [];
  private readonly server: Server;
  private readonly sockets: WebSocketServer;
  private readonly objects = new Map<string, { host: StandInHost; tunnel: Tunnel<StandInSocket> }>();

  private constructor(server: Server, sockets: WebSocketServer) {
    this.server = server;
    this.sockets = sockets;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** Listens on `port` (any free one by default). */
  static async start(port = 0): Promise<RelayStandIn> {
    const sockets = new WebSocketServer({ noServer: true });
    const server = createServer((_request, response) => {
      response.writeHead(426, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "This route takes a WebSocket." }));
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const relay = new RelayStandIn(server, sockets);
    server.on("upgrade", (request, socket, head) => void relay.upgrade(request, socket, head));
    return relay;
  }

  /** The object of `relay`, made when it is first asked for, as the Worker's are. */
  private object(relay: string): { host: StandInHost; tunnel: Tunnel<StandInSocket> } {
    let object = this.objects.get(relay);
    if (!object) {
      const host = new StandInHost();
      const tunnel = new Tunnel(host, () => undefined);
      host.alarm = () => tunnel.alarm();
      object = { host, tunnel };
      this.objects.set(relay, object);
    }
    return object;
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => undefined);
    const route = tunnelPath(new URL(request.url ?? "/", "http://relay").pathname);
    if (!route) return refuse(socket, 404, "Not found.");
    this.asked.push(route.leg.kind);
    const { host, tunnel } = this.object(route.relay);
    const instance = typeof request.headers["x-portals-standby"] === "string" ? request.headers["x-portals-standby"] : null;
    const refused = await tunnel.admit(route.leg, request.headers.authorization ?? null, instance);
    if (refused) return refuse(socket, refused.status, refused.detail);
    this.sockets.handleUpgrade(request, socket, head, (ws) => {
      const held = new StandInSocket(ws);
      ws.on("message", (data: Buffer, isBinary) => {
        // The Worker's auto-response: the object never hears it.
        if (!isBinary && data.toString() === "ping") {
          host.pings.set(held, Date.now());
          ws.send("pong");
          return;
        }
        tunnel.message(held, isBinary ? new Uint8Array(data).slice().buffer : data.toString());
      });
      ws.on("close", (code, reason) => tunnel.closed(held, code, reason.toString()));
      ws.on("error", () => undefined);
      void tunnel.opened(held, route.leg, instance);
    });
  }

  /** The open sockets of `relay` on a leg: "mac" for its standby sockets, "channel", "device". */
  open(relay: string, tag: "mac" | "channel" | "device"): WebSocket[] {
    return this.object(relay).host.sockets(tag).map((socket) => socket.ws);
  }

  /** Drops every socket without a closing handshake, as a relay that went away. */
  dropAll(): void {
    for (const ws of this.sockets.clients) ws.terminate();
  }

  async close(): Promise<void> {
    for (const { host } of this.objects.values()) host.stop();
    this.dropAll();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}

function refuse(socket: Duplex, status: number, detail: string): void {
  const body = JSON.stringify({ detail });
  socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}
