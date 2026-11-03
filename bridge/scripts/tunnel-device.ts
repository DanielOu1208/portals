import { generateKeyPairSync } from "node:crypto";
import WebSocket from "ws";
import { keyBytes, Opener, publicKeyFrom, rawPublicKey, Sealer, tunnelKeys, x25519 } from "../src/relay/seal.ts";

// A device through the relay's tunnel, as the app will be (docs/pairing-and-relay.md,
// "The tunnel"): its ephemeral key, the Mac's, the keys, its token sealed, then JSON-RPC
// sealed both ways. For the bridge's tests (test/tunnel.test.ts) and the check against a
// relay run by `wrangler dev` (scripts/tunnel-check.ts).

export interface TunnelDeviceOptions {
  /** The relay's address: http(s)://… */
  relay: string;
  /** The Mac's relay id and static X25519 key (raw, base64url), from its entry in the net's list. */
  relayID: string;
  macKey: string;
  /** The device's token; what the first sealed frame carries. */
  token: string;
  timeoutMs?: number;
}

/** A frame as JSON: callers read whatever keys they check. */
export type Frame = any;

export class TunnelDevice {
  readonly socket: WebSocket;
  /** Every frame opened, in order, as JSON. */
  readonly frames: Frame[] = [];
  /** How the tunnel closed, once it did. */
  readonly closed: Promise<{ code: number; reason: string }>;
  private sealer: Sealer | undefined;
  private opener: Opener | undefined;
  private waiters: (() => void)[] = [];
  private nextID = 1;
  /** Set when a frame from the Mac did not open. */
  broken: Error | undefined;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.closed = new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    socket.on("close", () => this.wake());
  }

  /**
   * Opens the tunnel and sends the token. Resolves once the handshake is done and the
   * token is sent; the bridge's `gateway.ready` comes next if it took the token.
   */
  static async open(options: TunnelDeviceOptions): Promise<TunnelDevice> {
    const base = options.relay.replace(/\/+$/, "").replace(/^http/, "ws");
    const socket = new WebSocket(`${base}/v1/tunnel/${options.relayID}/device`, { perMessageDeflate: false });
    const device = new TunnelDevice(socket);
    const ephemeral = generateKeyPairSync("x25519");
    const mine = rawPublicKey(ephemeral.publicKey);
    const macStatic = Buffer.from(options.macKey, "base64url");
    const theirs = new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the Mac's key did not come")), options.timeoutMs ?? 15_000);
      socket.once("message", (data) => {
        clearTimeout(timer);
        resolve(data as Buffer);
      });
      socket.once("close", (code, reason) => {
        clearTimeout(timer);
        reject(new Error(`the tunnel closed before the Mac's key came: ${code} ${reason.toString()}`));
      });
      socket.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(mine);
    const mac = await theirs;
    if (mac.length !== keyBytes) throw new Error(`the Mac's key is ${mac.length} bytes`);
    const macKey = publicKeyFrom(mac);
    const keys = tunnelKeys(
      { ephemeral: x25519(ephemeral.privateKey, macKey), static: x25519(ephemeral.privateKey, publicKeyFrom(macStatic)) },
      { device: mine, mac, macStatic },
    );
    device.sealer = new Sealer(keys.deviceToMac);
    device.opener = new Opener(keys.macToDevice);
    socket.on("message", (data) => device.received(data as Buffer));
    device.sendText(JSON.stringify({ token: options.token }));
    return device;
  }

  /** Seals and sends one text frame. */
  sendText(text: string): void {
    this.socket.send(this.sealer!.seal(Buffer.from(text, "utf8")));
  }

  /** Sends a frame as it is, unsealed (for a test of one that does not open). */
  sendRaw(bytes: Buffer): void {
    this.socket.send(bytes);
  }

  /** Sends a request and returns its result; throws with the error's message. */
  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<Frame> {
    const id = `t${this.nextID++}`;
    this.sendText(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const answer = await this.find((frame) => frame.id === id && frame.method === undefined, timeoutMs);
    if (answer.error) throw new Error(`${method} failed: ${answer.error.message} (${answer.error.code})`);
    return answer.result;
  }

  /** Waits until some frame satisfies `predicate`, searching every frame opened so far. */
  find(predicate: (frame: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame through the tunnel")), timeoutMs);
      const attempt = () => {
        const found = this.frames.find(predicate);
        if (found !== undefined) {
          clearTimeout(timer);
          resolve(found);
        } else if (this.socket.readyState === WebSocket.CLOSED || this.broken) {
          clearTimeout(timer);
          reject(this.broken ?? new Error("the tunnel closed while waiting for a frame"));
        } else {
          this.waiters.push(attempt);
        }
      };
      attempt();
    });
  }

  close(): Promise<{ code: number; reason: string }> {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.close(1000);
    return this.closed;
  }

  private received(data: Buffer): void {
    try {
      this.frames.push(JSON.parse(this.opener!.open(data).toString("utf8")));
    } catch (error) {
      this.broken = error as Error;
      this.socket.close(4400, "A frame through the tunnel did not open.");
    }
    this.wake();
  }

  private wake(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }
}
