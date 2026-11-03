import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { GatewaySocket } from "../gateway/gateway.ts";
import { log } from "../log.ts";
import type { MemberSignIn } from "../net/net.ts";
import { relayFrameBytes, Tunnel, type TunnelNet } from "./tunnel.ts";

// The bridge's side of the relay's tunnel (docs/pairing-and-relay.md, "The tunnel"), the
// backup way in for a device that cannot reach this Mac directly. The bridge keeps one
// idle standby socket open to its object at the relay, named by its relay id and opened
// with its relay secret (state/net-own.json); the relay tells it on that socket when a
// device comes, and the bridge opens that channel's leg (tunnel.ts), which is handed to
// the gateway once the device signed in.
//
// The standby socket is opened as the bridge starts and again after it closes, waiting
// 1 s and twice as long each time up to a minute; a socket that stayed open a while
// starts again at 1 s. Every 30 s it sends `ping`, which the relay answers with `pong`
// without waking the object; a ping with no answer by the next closes it. One not open
// within 15 s (a relay that took the request and never answered it) is given up, as a
// failed attempt, and opened again after the wait. A channel's leg has the tunnel's own
// 10 s for its opening and handshake (tunnel.ts), after which it is closed.
//
// Another bridge with the same relay id (a copied bridge folder) holding the standby
// socket: the relay keeps the one that holds it (2026-10-26: "First keeps it,
// newcomer warns"), telling a newcomer 409 before it opens; each run of a bridge names
// itself (`X-Portals-Standby`) so its own reconnect is not taken for another bridge. The
// newcomer says so once in its log, reports it to the app (`problem`, gateway.ready's
// `bridge.relay_problem`) and tries again only every five minutes. A relay from before
// this replaces the holder instead, closing it with 4409: that bridge takes it the same
// way, so two bridges take turns every five minutes rather than every second.

/** How long to wait before opening the standby socket again: at first, and at most. */
const firstRetryMs = 1000;
const lastRetryMs = 60_000;
/** How often the standby socket is pinged. */
const pingEveryMs = 30_000;
/** How long a standby socket must have stayed open for the next wait to start again at 1 s. */
const steadyMs = 60_000;
/** How long the standby socket may take to open. */
const openingMs = 15_000;
/** How long to wait before trying again while another bridge holds this relay id. */
const inUseRetryMs = 5 * 60_000;
/** The relay closed the standby socket for a newer one, or refused it for another bridge's. */
const replacedCode = 4409;
const inUseStatus = 409;

/** A relay id or a channel id: 16 bytes in base64url. */
const idPattern = /^[A-Za-z0-9_-]{22}$/;

export interface StandbyOptions {
  /** The relay's address (config `relay.url`). */
  url: string;
  /** The relay id and secret are read from it each time the standby socket opens. */
  net: TunnelNet & { relay(): { id: string; secret: string } };
  accept(socket: GatewaySocket, member: MemberSignIn): void;
  firstRetryMs?: number;
  lastRetryMs?: number;
  pingEveryMs?: number;
  openingMs?: number;
  handshakeMs?: number;
  inUseRetryMs?: number;
}

/** What is wrong with the way in through the relay, for the app: another bridge holds this Mac's relay id. */
export type RelayProblem = "in_use";

export class Standby {
  private readonly options: StandbyOptions;
  private readonly base: string;
  private socket: WebSocket | undefined;
  /** The legs open or opening, closed with the bridge. */
  private readonly legs = new Set<WebSocket>();
  private wait: number;
  private retry: NodeJS.Timeout | undefined;
  private pinger: NodeJS.Timeout | undefined;
  private stopped = false;
  /** Whether the last attempt failed, so a relay that stays away is logged once, not every minute. */
  private failing = false;
  /** This run of the bridge, as the relay is told it, so its own reconnect is not another bridge's. */
  private readonly instance = randomBytes(16).toString("base64url");
  /** Another bridge holds this Mac's relay id, as the relay said at the last attempt. */
  private inUse = false;

  constructor(options: StandbyOptions) {
    this.options = options;
    // ws:// or wss://, from the relay's http:// or https:// address.
    this.base = options.url.replace(/\/+$/, "").replace(/^http/, "ws");
    this.wait = options.firstRetryMs ?? firstRetryMs;
  }

  /** Whether the standby socket is open now. */
  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** What keeps devices from coming through the relay that the person can mend, if anything. */
  get problem(): RelayProblem | undefined {
    return this.inUse ? "in_use" : undefined;
  }

  start(): void {
    this.connect();
  }

  /** Closes the standby socket and every leg, and opens no more. */
  close(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.pinger);
    this.socket?.close(1001, "The bridge is shutting down.");
    for (const leg of this.legs) leg.close(1001, "The bridge is shutting down.");
  }

  private connect(): void {
    if (this.stopped) return;
    const { id, secret } = this.options.net.relay();
    const socket = new WebSocket(`${this.base}/v1/tunnel/${id}/mac`, { headers: { Authorization: `Bearer ${secret}`, "X-Portals-Standby": this.instance }, perMessageDeflate: false, maxPayload: 64 * 1024 });
    this.socket = socket;
    let openedAt = 0;
    let answered = true;
    // Ping and retry both wait on the socket opening or closing: one that does neither is given up.
    const opening = setTimeout(() => {
      if (socket.readyState !== WebSocket.CONNECTING) return;
      if (!this.failing) log.warn("the relay's tunnel is not open: the relay did not answer within 15 s; trying again", { relay: this.base });
      this.failing = true;
      socket.terminate();
    }, this.options.openingMs ?? openingMs);
    opening.unref();
    socket.on("unexpected-response", (_request, response) => {
      // The relay's own answer, not a socket: 401 when another Mac holds this relay id,
      // 409 when another bridge with this Mac's relay id and secret holds its standby socket.
      if (response.statusCode === inUseStatus) {
        this.anotherBridge();
        response.resume();
        socket.terminate();
        return;
      }
      if (!this.failing) {
        const why = response.statusCode === 401 ? "the relay did not take this Mac's relay secret" : `the relay answered ${response.statusCode}`;
        log.warn(`the relay's tunnel is not open: ${why}; trying again`, { relay: this.base });
      }
      this.failing = true;
      response.resume();
      socket.terminate();
    });
    socket.on("open", () => {
      clearTimeout(opening);
      openedAt = Date.now();
      if (this.failing) log.info("the relay's tunnel is open again");
      this.failing = false;
      this.inUse = false;
      this.pinger = setInterval(() => {
        if (!answered) {
          log.info("the relay did not answer the standby socket's ping; opening it again");
          socket.terminate();
          return;
        }
        answered = false;
        socket.send("ping");
      }, this.options.pingEveryMs ?? pingEveryMs);
      this.pinger.unref();
    });
    socket.on("message", (data, isBinary) => {
      const text = isBinary ? "" : data.toString();
      if (text === "pong") {
        answered = true;
        return;
      }
      let message: { type?: unknown; channel?: unknown } | undefined;
      try {
        message = JSON.parse(text);
      } catch {
        message = undefined;
      }
      if (message?.type === "open" && typeof message.channel === "string" && idPattern.test(message.channel)) this.openLeg(message.channel);
    });
    socket.on("error", (error) => {
      if (!this.failing) log.info(`the relay's tunnel is not open: ${error.message}; trying again`, { relay: this.base });
      this.failing = true;
    });
    socket.on("close", (code) => {
      clearTimeout(opening);
      clearInterval(this.pinger);
      if (this.socket !== socket || this.stopped) return;
      this.socket = undefined;
      if (openedAt > 0) log.debug("the relay's standby socket closed", { code });
      // Taken by another bridge's newer socket, from a relay that lets the newest have it:
      // this one's own newer socket never closes the one before (it is let go of first).
      if (code === replacedCode) this.anotherBridge();
      if (this.inUse) {
        this.retry = setTimeout(() => this.connect(), this.options.inUseRetryMs ?? inUseRetryMs);
        this.retry.unref();
        return;
      }
      const steady = openedAt > 0 && Date.now() - openedAt >= steadyMs;
      if (steady) this.wait = this.options.firstRetryMs ?? firstRetryMs;
      this.retry = setTimeout(() => this.connect(), this.wait);
      this.retry.unref();
      this.wait = Math.min(this.wait * 2, this.options.lastRetryMs ?? lastRetryMs);
    });
  }

  /** Another bridge holds this Mac's relay id: said once in the log, to the app (`problem`), and tried again slowly. */
  private anotherBridge(): void {
    if (!this.inUse) {
      log.warn("another bridge is using this Mac's relay id (a copy of this bridge's folder?), so devices cannot reach this Mac through the relay; trying again every five minutes. To give this bridge a relay id of its own, run `npx portals-host relay reset` on this Mac (with PORTALS_BRIDGE_HOME set to this bridge's folder, for one not in the usual place).", { relay: this.base });
    }
    this.inUse = true;
    this.failing = true;
  }

  /** A device came: this Mac's leg of its channel, which does the handshake and hands the device to the gateway. */
  private openLeg(channel: string): void {
    if (this.stopped) return;
    const { id, secret } = this.options.net.relay();
    const leg = new WebSocket(`${this.base}/v1/tunnel/${id}/mac/${channel}`, {
      headers: { Authorization: `Bearer ${secret}` },
      // Sealed frames do not compress.
      perMessageDeflate: false,
      // As much as the relay passes: a device's frame over 16 MiB is answered with an error for its call (tunnel.ts).
      maxPayload: relayFrameBytes,
    });
    this.legs.add(leg);
    leg.on("close", () => this.legs.delete(leg));
    leg.on("unexpected-response", (_request, response) => {
      log.debug("the relay did not open a channel's leg", { status: response.statusCode });
      response.resume();
      leg.terminate();
    });
    // It hands itself to the gateway once its device has signed in, or closes the leg.
    new Tunnel(leg, { net: this.options.net, accept: this.options.accept, handshakeMs: this.options.handshakeMs });
  }
}
