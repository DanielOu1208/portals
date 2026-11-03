import { randomBytes } from "node:crypto";
import type { RawData } from "ws";
import { counters } from "../counters.ts";
import { log } from "../log.ts";
import type { SignedIn } from "../net/net.ts";
import { Connection } from "./connection.ts";
import type { GatewayContext } from "./methods.ts";

// The app's side of the bridge: every open WebSocket, and the replay epoch they share.
//
// The epoch names this run of the bridge. The app compares it across reconnects: the
// same epoch means the replay logs it read from are still here; a new one means they
// are gone and it takes snapshots instead.

/**
 * What the gateway uses of a connection's socket: a `ws` WebSocket, or a device's tunnel
 * through the relay (src/relay/tunnel.ts), which seals and opens each frame.
 */
export interface GatewaySocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  terminate(): void;
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "pong", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export class Gateway {
  readonly replayEpoch = randomBytes(16).toString("hex");
  /** What keeps devices from reaching this Mac through the relay, for `gateway.ready` (`Standby.problem`). */
  relayProblem: () => string | undefined = () => undefined;
  readonly context: GatewayContext;
  private readonly connections = new Set<Connection>();
  private readonly sockets = new Set<GatewaySocket>();
  /** `closeAll` was called: the bridge is shutting down, and takes no connection on. */
  private closed = false;

  constructor(context: GatewayContext) {
    this.context = context;
  }

  /** Takes over a socket whose sign-in was accepted, or one on the `portals` command's socket (`local`). */
  accept(socket: GatewaySocket, signedIn: SignedIn): void {
    // Shutting down: the bridge's sessions may take a while to close (a Droid turn being
    // stopped), and an app reconnects at once. One taken on now would never be closed,
    // and the server would wait for it until the stop gives up (n18, 2026-10-30).
    if (this.closed) {
      socket.close(1001, "The bridge is shutting down.");
      return;
    }
    const connection = new Connection(socket, this.context, { replayEpoch: this.replayEpoch, relayProblem: () => this.relayProblem() }, signedIn);
    this.connections.add(connection);
    this.sockets.add(socket);
    if (counters.on) counters.opened(signedIn.kind === "local" ? "local" : "net");
    log.info("connection opened", { connection: connection.number });

    // Closes a socket that stopped answering protocol pings, so a phone that vanished
    // does not stay a follower of its threads. The app has its own heartbeat on top.
    let alive = true;
    socket.on("pong", () => {
      alive = true;
    });
    const watchdog = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 30_000);

    socket.on("close", (code) => {
      clearInterval(watchdog);
      this.connections.delete(connection);
      this.sockets.delete(socket);
      this.context.sessions.disconnected(connection);
      this.context.pollNow.leave(connection);
      if (counters.on) counters.closed(connection.kind);
      log.info("connection closed", { connection: connection.number, code });
    });
    socket.on("error", (error) => log.warn("connection error", { connection: connection.number, error: error.message }));
  }

  get openConnections(): number {
    return this.connections.size;
  }

  /**
   * Closes the connections of members taken out of the net here (removed, or of a net
   * this Mac is no longer in) with 4401, which the app takes as a sign-in not accepted.
   */
  closeMembers(ids: Set<string>): void {
    for (const connection of this.connections) {
      const signedIn = connection.signedIn;
      if (signedIn.kind !== "member" || !ids.has(signedIn.id)) continue;
      connection.close(4401, signedIn.member === "mac" ? "This Mac was removed from the net." : "This device was removed from the net.");
    }
  }

  /** Closes every connection, for shutting down. */
  closeAll(): void {
    this.closed = true;
    for (const socket of this.sockets) socket.close(1001, "The bridge is shutting down.");
  }
}
