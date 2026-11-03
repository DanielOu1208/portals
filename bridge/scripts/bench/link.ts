import { createConnection, createServer, type Server, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { seeded } from "../../src/providers/fakeBench.ts";

// A bad network between a harness device and a bridge: a TCP proxy on this Mac that
// holds each byte back for as long as it would take to cross a slow link, and counts
// the bytes each way as they go over it (HTTP headers and WebSocket framing included,
// no TLS). A device reaches the bridge through it by its address (`Link.url`) in
// place of the bridge's own.
//
// Each way has its latency and its bandwidth. A share of TCP's segments is lost: a lost
// one is sent again a round trip later and holds back what follows it, as a receiver
// takes nothing past a gap. A new connection waits out its handshakes (TCP's, and TLS's
// on the way to a phone) before its first byte. What crosses is held in the proxy until
// it is due, up to a window (what the network and the device's own buffer hold for
// it); past that the proxy stops reading, so the bridge's socket backs up as it would.
//
// Two things a test of a bad network needs on top: a stall, in which the device stops
// reading what comes from the bridge (a phone in a tunnel, an app the system suspended),
// and a cut, in which every connection over the link goes at once.

export interface Shape {
  /** One way, in milliseconds. */
  latencyMs: number;
  /** Bytes a second from the bridge to the device, and back. */
  down: number;
  up: number;
  /** The share of 1448-byte segments lost, from 0 to 1. */
  loss: number;
  /** Round trips a new connection takes before its first byte. */
  handshakes: number;
  /** Bytes held on their way to the device before the proxy stops reading the bridge. */
  window: number;
}

/** What crossed the link, each way, in bytes. */
export interface Crossed {
  up: number;
  down: number;
}

/** A segment as TCP sends it on most links. */
const segmentBytes = 1448;

/** One way of one connection: what `from` sends reaches `to` when it is due. */
class Way {
  private readonly from: Socket;
  private readonly to: Socket;
  private readonly link: Link;
  private readonly bytesPerSecond: number;
  private readonly crossed: (bytes: number) => void;
  private readonly queue: { data: Buffer; due: number }[] = [];
  private queued = 0;
  /** When the link has sent everything given to it so far. */
  private free = 0;
  private timer: NodeJS.Timeout | null = null;
  private held = false;
  /** `from` ended: `to` is ended once everything before it is through. */
  private ended = false;
  private passedOnEnd = false;

  constructor(from: Socket, to: Socket, link: Link, bytesPerSecond: number, crossed: (bytes: number) => void) {
    this.from = from;
    this.to = to;
    this.link = link;
    this.bytesPerSecond = bytesPerSecond;
    this.crossed = crossed;
    from.on("data", (chunk: Buffer) => this.take(chunk));
    from.on("end", () => {
      this.ended = true;
      this.deliver();
    });
    // A side that reads slowly backs this up too: taken up again once it took what it was given.
    to.on("drain", () => this.deliver());
  }

  hold(): void {
    this.held = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  release(): void {
    this.held = false;
    this.deliver();
  }

  private take(chunk: Buffer): void {
    const shape = this.link.shape;
    this.free = Math.max(performance.now(), this.free) + (chunk.length / this.bytesPerSecond) * 1000;
    for (let sent = 0; sent < chunk.length; sent += segmentBytes) {
      if (this.link.random() < shape.loss) this.free += 2 * shape.latencyMs;
    }
    this.queue.push({ data: chunk, due: this.free + shape.latencyMs });
    this.queued += chunk.length;
    if (this.queued > shape.window) this.from.pause();
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.held || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deliver();
    }, Math.max(0, this.queue[0].due - performance.now()));
  }

  private deliver(): void {
    if (this.held || this.to.destroyed) return;
    const now = performance.now();
    const due: Buffer[] = [];
    while (this.queue.length > 0 && this.queue[0].due <= now + 1) due.push(this.queue.shift()!.data);
    if (due.length > 0) {
      const data = due.length === 1 ? due[0] : Buffer.concat(due);
      this.queued -= data.length;
      this.crossed(data.length);
      if (!this.to.write(data)) return;
    }
    if (this.queued <= this.link.shape.window / 2 && this.from.isPaused() && !this.from.destroyed) this.from.resume();
    if (this.queue.length === 0 && this.ended && !this.passedOnEnd) {
      this.passedOnEnd = true;
      this.to.end();
    }
    this.schedule();
  }
}

/** One connection over the link: the device's socket, the bridge's, and the two ways between. */
interface Pair {
  device: Socket;
  bridge: Socket | null;
  down: Way | null;
  up: Way | null;
}

export class Link {
  readonly shape: Shape;
  readonly random: () => number;
  private readonly server: Server;
  private readonly target: { host: string; port: number };
  private readonly pairs = new Set<Pair>();
  private readonly crossed: Crossed = { up: 0, down: 0 };
  private stalled = false;
  private address = "";

  private constructor(bridgeURL: string, shape: Shape, seed: number) {
    this.shape = shape;
    this.random = seeded(seed);
    const url = new URL(bridgeURL);
    this.target = { host: url.hostname, port: Number(url.port) };
    this.server = createServer({ allowHalfOpen: true }, (device) => this.accept(device));
  }

  /** A link to the bridge at `bridgeURL` (`http://127.0.0.1:<port>`), listening on a port of its own. */
  static async open(bridgeURL: string, shape: Shape, seed = 20261016): Promise<Link> {
    const link = new Link(bridgeURL, shape, seed);
    await new Promise<void>((done, failed) => {
      link.server.once("error", failed);
      link.server.listen(0, "127.0.0.1", () => done());
    });
    link.address = `http://127.0.0.1:${(link.server.address() as { port: number }).port}`;
    return link;
  }

  /** Where a device reaches the bridge over this link. */
  get url(): string {
    return this.address;
  }

  /** The bytes that crossed so far, each way. */
  totals(): Crossed {
    return { ...this.crossed };
  }

  /** The device stops reading what the bridge sends, on every connection, until `resume`. */
  stall(): void {
    this.stalled = true;
    for (const pair of this.pairs) pair.down?.hold();
  }

  resume(): void {
    this.stalled = false;
    for (const pair of this.pairs) pair.down?.release();
  }

  /** Every connection over the link goes at once, both ends; new ones are taken as before. */
  cut(): void {
    for (const pair of [...this.pairs]) this.drop(pair);
  }

  async close(): Promise<void> {
    this.cut();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  private accept(device: Socket): void {
    const pair: Pair = { device, bridge: null, down: null, up: null };
    this.pairs.add(pair);
    // What is due goes at once, as the bridge's and the device's own sockets send it: no wait for more to fill a segment.
    device.setNoDelay(true);
    device.pause();
    device.on("error", () => this.drop(pair));
    device.on("close", () => this.drop(pair));
    // The handshakes: nothing crosses until they are done.
    setTimeout(() => {
      if (!this.pairs.has(pair)) return;
      const bridge = createConnection({ ...this.target, allowHalfOpen: true });
      pair.bridge = bridge;
      bridge.setNoDelay(true);
      bridge.on("error", () => this.drop(pair));
      bridge.on("close", () => this.drop(pair));
      pair.down = new Way(bridge, device, this, this.shape.down, (bytes) => (this.crossed.down += bytes));
      pair.up = new Way(device, bridge, this, this.shape.up, (bytes) => (this.crossed.up += bytes));
      if (this.stalled) pair.down.hold();
      device.resume();
    }, this.shape.handshakes * 2 * this.shape.latencyMs);
  }

  private drop(pair: Pair): void {
    if (!this.pairs.delete(pair)) return;
    pair.down?.hold();
    pair.up?.hold();
    pair.device.destroy();
    pair.bridge?.destroy();
  }
}
