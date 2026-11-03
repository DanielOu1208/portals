import { EventEmitter } from "node:events";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type WebSocket from "ws";
import { ErrorCode } from "../gateway/errors.ts";
import type { GatewaySocket } from "../gateway/gateway.ts";
import { log } from "../log.ts";
import type { MemberSignIn } from "../net/net.ts";
import { keyBytes, Opener, publicKeyFrom, rawPublicKey, Sealer, tunnelKeys, x25519 } from "./seal.ts";

// One device's connection through the relay (docs/pairing-and-relay.md, "The tunnel"):
// the bridge's leg of a channel, from the handshake to the gateway.
//
// 1. The device sends its ephemeral X25519 key, 32 bytes; the bridge answers with its own.
// 2. Both derive a key per direction (seal.ts), and every frame after is sealed.
// 3. The device's first sealed frame is `{"token":"…"}`, checked as a Bearer token is on
//    a direct connection; refused, the bridge sends one sealed `{"refused":"token"}` and
//    the tunnel closes with 4401. A device removed while its tunnel is open is told so
//    the same way, `{"refused":"removed"}`. The app leaves the net only on such a frame:
//    a close code the relay could have made up is not enough.
// 4. Then the tunnel is handed to the gateway as a socket signed in as that member, and
//    each sealed frame is one gateway text frame, as on a direct WebSocket (including
//    compact deltas only when the device negotiated lean_deltas).
//
// A frame that does not open closes the tunnel, so a relay pretending to be the Mac (it
// has no private half of the Mac's static key) fails at the device's first sealed frame.

/** The largest frame either way, before sealing. The relay passes up to 32 MiB; this leaves room. */
export const mostFrameBytes = 16 * 1024 * 1024;
/**
 * The largest sealed frame the leg takes from the relay: the relay's own limit. A device's
 * frame between the two is answered with an error for its call rather than closing the
 * tunnel; only a larger one closes it (1009).
 */
export const relayFrameBytes = 32 * 1024 * 1024;
/** How long the handshake and the token's arrival may take. */
const handshakeMs = 10_000;
/**
 * What may come while the token is checked, kept for the gateway: at most 4 frames and
 * 64 KiB in all (the app sends nothing before `gateway.ready`). More closes the tunnel, so
 * one who holds the Mac's relay id cannot fill the bridge's memory with a token it lacks.
 */
const mostEarlyFrames = 4;
const mostEarlyBytes = 64 * 1024;
/**
 * How long the token's check may take once it came. A token this Mac does not know has it
 * ask every other Mac first, 10 s each, so this is longer than one such call.
 */
const checkMs = 30_000;

/** The close codes a device is told by the bridge (the relay's own are in relay/src/tunnel.ts). */
export const TunnelRefused = {
  /** A frame that is not the handshake's, or that did not open. */
  broken: 4400,
  /** The token in the first sealed frame was not accepted, or the member was removed: after a sealed `{"refused":…}`. */
  token: 4401,
  /** The handshake and the token took too long. */
  slow: 4408,
} as const;

/** What the tunnel needs of the net: this Mac's static key, and the token check. */
export interface TunnelNet {
  /** This Mac's X25519 public key, raw, in base64url. */
  publicKey(): string;
  /** X25519 with this Mac's private key. */
  agree(publicKey: KeyObject): Buffer;
  authenticate(token: string): Promise<MemberSignIn | undefined>;
}

export interface TunnelOptions {
  net: TunnelNet;
  /** Takes over the tunnel once the device signed in: the gateway's `accept`. */
  accept(socket: GatewaySocket, member: MemberSignIn): void;
  handshakeMs?: number;
  checkMs?: number;
}

/** Waiting for the device's key, then for its token (and checking it), then open; or closed by the bridge. */
type Stage = "key" | "token" | "checking" | "open" | "refused";

/**
 * The bridge's leg of one channel. Once its device signed in it is a socket the gateway
 * takes as it takes a direct WebSocket: `send` seals, a frame that opens is a `message`,
 * and `close`, `ping` and `terminate` go to the leg. A ping is answered by the relay,
 * not the device, which the app's own heartbeat watches.
 */
export class Tunnel extends EventEmitter implements GatewaySocket {
  readonly OPEN = 1;
  private readonly leg: WebSocket;
  private readonly options: TunnelOptions;
  private stage: Stage = "key";
  private sealer: Sealer | undefined;
  private opener: Opener | undefined;
  /** Frames that opened while the token was being checked, for the gateway once it has the tunnel, and their bytes. */
  private early: Buffer[] = [];
  private earlyBytes = 0;
  /** The handshake's time limit, then the token check's. */
  private timer: NodeJS.Timeout;

  constructor(leg: WebSocket, options: TunnelOptions) {
    super();
    this.leg = leg;
    this.options = options;
    this.timer = setTimeout(() => this.refuse(TunnelRefused.slow, "The tunnel's handshake took too long."), options.handshakeMs ?? handshakeMs);
    this.timer.unref();
    leg.on("message", (data, isBinary) => this.received(data, isBinary));
    leg.on("close", (code, reason) => {
      clearTimeout(this.timer);
      this.dropEarly();
      if (this.stage === "open") this.emit("close", code, reason);
    });
    leg.on("pong", () => this.emit("pong"));
    leg.on("error", (error) => {
      if (this.stage === "open") this.emit("error", error);
      else log.debug("a tunnel's leg failed before its device signed in", { error: error.message });
    });
  }

  get readyState(): number {
    return this.leg.readyState;
  }

  get bufferedAmount(): number {
    return this.leg.bufferedAmount;
  }

  /** Seals one text frame for the device. One over 16 MiB is not sent: an answer is turned into an error for its call. */
  send(text: string, callback?: (error?: Error) => void): void {
    const plain = Buffer.from(text, "utf8");
    if (plain.length > mostFrameBytes) {
      this.tooLarge(text, callback);
      return;
    }
    let frame: Buffer;
    try {
      frame = this.sealer!.seal(plain);
    } catch (error) {
      this.refuse(TunnelRefused.broken, (error as Error).message);
      if (callback) process.nextTick(callback, error as Error);
      return;
    }
    this.leg.send(frame, { binary: true }, callback);
  }

  close(code?: number, reason?: string): void {
    // The gateway closes with 4401 only a member removed from the net (`closeMembers`): the device is told, sealed.
    if (code === TunnelRefused.token && this.stage === "open") this.tellRefused("removed", reason ?? "This device was removed from the net.");
    this.leg.close(code, reason);
  }

  ping(): void {
    this.leg.ping();
  }

  terminate(): void {
    this.leg.terminate();
  }

  private received(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.stage === "refused") return;
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!isBinary) {
      this.refuse(TunnelRefused.broken, "Frames through the tunnel are binary.");
      return;
    }
    if (this.stage === "key") {
      this.handshake(bytes);
      return;
    }
    let plain: Buffer;
    try {
      plain = this.opener!.open(bytes);
    } catch {
      log.info("closed a tunnel whose frame did not open");
      this.refuse(TunnelRefused.broken, "A frame through the tunnel did not open.");
      return;
    }
    if (this.stage === "open") this.deliver(plain);
    else if (this.stage === "token") void this.signIn(plain);
    else this.keepEarly(plain);
  }

  /** A frame that came while the token is checked, kept for the gateway; past the most, the tunnel closes. */
  private keepEarly(plain: Buffer): void {
    this.earlyBytes += plain.length;
    if (this.early.length >= mostEarlyFrames || this.earlyBytes > mostEarlyBytes) {
      log.info("closed a tunnel that sent too much before its token was accepted");
      this.refuse(TunnelRefused.broken, "Too much came through the tunnel before the token was accepted.");
      return;
    }
    this.early.push(plain);
  }

  private dropEarly(): void {
    this.early = [];
    this.earlyBytes = 0;
  }

  /** Steps 1 to 3: the device's ephemeral key in, this Mac's out, and the keys. */
  private handshake(deviceKey: Buffer): void {
    if (deviceKey.length !== keyBytes) {
      this.refuse(TunnelRefused.broken, "The tunnel's handshake was not understood.");
      return;
    }
    try {
      const device = publicKeyFrom(deviceKey);
      const ephemeral = generateKeyPairSync("x25519");
      const mac = rawPublicKey(ephemeral.publicKey);
      const keys = tunnelKeys(
        { ephemeral: x25519(ephemeral.privateKey, device), static: this.options.net.agree(device) },
        { device: deviceKey, mac, macStatic: Buffer.from(this.options.net.publicKey(), "base64url") },
      );
      this.opener = new Opener(keys.deviceToMac);
      this.sealer = new Sealer(keys.macToDevice);
      this.stage = "token";
      this.leg.send(mac, { binary: true });
    } catch (error) {
      // A key X25519 refuses (one of the few that make a shared secret of zeros).
      log.info("closed a tunnel whose handshake failed", { error: (error as Error).message });
      this.refuse(TunnelRefused.broken, "The tunnel's handshake was not understood.");
    }
  }

  /** Steps 5 and 6: the token, then the gateway, which gets what came meanwhile. */
  private async signIn(plain: Buffer): Promise<void> {
    this.stage = "checking";
    // The token is in: its check, which may wait for the other Macs, has a limit of its own.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refuse(TunnelRefused.slow, "The Mac took too long to check the token."), this.options.checkMs ?? checkMs);
    this.timer.unref();
    let token: unknown;
    try {
      token = (JSON.parse(plain.toString("utf8")) as { token?: unknown })?.token;
    } catch {
      token = undefined;
    }
    let member: MemberSignIn | undefined;
    let failed = false;
    try {
      member = typeof token === "string" ? await this.options.net.authenticate(token) : undefined;
    } catch (error) {
      failed = true;
      log.error("could not check a token through the relay", { error: (error as Error).message });
    }
    if (this.stage !== "checking" || this.leg.readyState !== this.leg.OPEN) return;
    if (!member) {
      // A check that failed is no answer: the device is not told its token was refused, and tries again.
      if (!failed) this.tellRefused("token", "The token was not accepted.");
      this.refuse(TunnelRefused.token, "The token was not accepted.");
      return;
    }
    clearTimeout(this.timer);
    this.stage = "open";
    this.options.accept(this, member);
    const early = this.early;
    this.dropEarly();
    for (const frame of early) this.deliver(frame);
  }

  /**
   * The one sealed frame that tells the device it is refused, before the close with 4401:
   * `{"refused":"token"}` or `{"refused":"removed"}`, with the sentence beside it. Only
   * the Mac can seal it, so a relay cannot make a device leave the net.
   */
  private tellRefused(refused: "token" | "removed", message: string): void {
    if (!this.sealer || this.leg.readyState !== this.leg.OPEN) return;
    try {
      this.leg.send(this.sealer.seal(Buffer.from(JSON.stringify({ refused, message }), "utf8")), { binary: true });
    } catch (error) {
      log.debug("could not tell a device through the relay that it was refused", { error: (error as Error).message });
    }
  }

  /** A frame from the device for the gateway; one over 16 MiB is answered with an error for its call instead. */
  private deliver(plain: Buffer): void {
    if (plain.length <= mostFrameBytes) {
      this.emit("message", plain, false);
      return;
    }
    let frame: { id?: unknown; method?: unknown } | undefined;
    try {
      frame = JSON.parse(plain.toString("utf8"));
    } catch {
      frame = undefined;
    }
    const id = frame?.id;
    if ((typeof id === "string" || typeof id === "number") && typeof frame?.method === "string") {
      log.warn("answered with an error a call too large for the relay", { method: frame.method, bytes: plain.length });
      const message = "The request is over 16 MiB, too large to send through the relay. Try again when this device reaches the Mac directly.";
      this.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: ErrorCode.internal, message } }));
      return;
    }
    log.warn("left out a frame from a device too large for the relay", { bytes: plain.length });
  }

  /** An answer too large for the relay becomes an error for its call; anything else that large is left out. */
  private tooLarge(text: string, callback?: (error?: Error) => void): void {
    let frame: { id?: unknown; result?: unknown; error?: unknown } | undefined;
    try {
      frame = JSON.parse(text);
    } catch {
      frame = undefined;
    }
    const id = frame?.id;
    if ((typeof id === "string" || typeof id === "number") && ("result" in frame! || "error" in frame!)) {
      log.warn("answered with an error a call whose answer is too large for the relay", { bytes: Buffer.byteLength(text) });
      const message = "The answer is over 16 MiB, too large to send through the relay. It comes when this device reaches the Mac directly.";
      this.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: ErrorCode.internal, message } }), callback);
      return;
    }
    log.warn("left out a frame too large for the relay", { bytes: Buffer.byteLength(text) });
    if (callback) process.nextTick(callback);
  }

  private refuse(code: number, reason: string): void {
    clearTimeout(this.timer);
    this.dropEarly();
    // Once open, the gateway hears of it as of any close.
    if (this.stage !== "open") this.stage = "refused";
    if (this.leg.readyState === this.leg.OPEN || this.leg.readyState === this.leg.CONNECTING) this.leg.close(code, reason);
  }
}
