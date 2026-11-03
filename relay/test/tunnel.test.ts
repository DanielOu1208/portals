import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { serialize } from "node:v8";
import { answerMs, makeTunnelRoute, mostDevices, standbyStaleMs, Tunnel, TunnelClose, tunnelPath, type Leg, type TunnelHost, type TunnelSocket } from "../src/tunnel.ts";

// The tunnel's object (src/tunnel.ts) over stand-ins for the Worker's sockets, storage
// and alarm: what the Durable Object does with each socket, without Cloudflare.

const RELAY = randomBytes(16).toString("base64url");
const SECRET = randomBytes(32).toString("base64url");
const BEARER = `Bearer ${SECRET}`;

/** A socket the object accepted: what it was sent, and how it was closed. */
class FakeSocket implements TunnelSocket {
  readonly sent: (string | ArrayBuffer)[] = [];
  closedWith: { code: number; reason: string } | undefined;
  tags: string[] = [];
  private attachment: unknown = null;

  send(message: string | ArrayBuffer): void {
    if (this.closedWith) throw new Error("Can't call send() after close().");
    this.sent.push(message);
  }

  close(code = 1000, reason = ""): void {
    if (this.closedWith) throw new Error("Can't call close() after close().");
    this.closedWith = { code, reason };
  }

  serializeAttachment(value: unknown): void {
    // V8 serialization models the runtime's 16 KiB structured-clone limit, independently
    // of the tunnel's smaller UTF-8 JSON policy. Local Wrangler checks cover the runtime.
    const copy = structuredClone(value);
    assert.ok(serialize(copy).byteLength <= 16 * 1024, "a serialized attachment is at most 16 KiB");
    this.attachment = copy;
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  /** The text frames sent to it, as JSON. */
  texts(): unknown[] {
    return this.sent.filter((message) => typeof message === "string").map((message) => JSON.parse(message as string));
  }
}

/** The object's runtime: its sockets until each closes, its storage and its alarm. */
class FakeHost implements TunnelHost<FakeSocket> {
  readonly accepted: FakeSocket[] = [];
  readonly storage = new Map<string, unknown>();
  alarmAt: number | undefined;
  clock = 1_800_000_000_000;
  /** When each socket's `ping` was last answered. */
  readonly pings = new Map<FakeSocket, number>();

  accept(socket: FakeSocket, tags: string[]): void {
    socket.tags = tags;
    this.accepted.push(socket);
  }

  sockets(tag: string): FakeSocket[] {
    return this.accepted.filter((socket) => socket.tags.includes(tag) && !socket.closedWith);
  }

  async get(key: string): Promise<unknown> {
    return this.storage.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.storage.set(key, value);
  }

  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
  }

  now(): number {
    return this.clock;
  }

  pinged(socket: FakeSocket): number | undefined {
    return this.pings.get(socket);
  }
}

function setup() {
  const host = new FakeHost();
  const logged: string[] = [];
  const tunnel = new Tunnel(host, (line) => logged.push(line));
  /** A socket opened on `leg` as the Worker would: refused with a status, or taken in. */
  async function open(leg: Leg, authorization: string | null = leg.kind === "device" ? null : BEARER, instance: string | null = null): Promise<FakeSocket | number> {
    const refused = await tunnel.admit(leg, authorization, instance);
    if (refused) {
      assert.equal(typeof refused.detail, "string");
      return refused.status;
    }
    const socket = new FakeSocket();
    await tunnel.opened(socket, leg, instance);
    return socket;
  }
  async function socket(leg: Leg, authorization?: string | null): Promise<FakeSocket> {
    const opened = await open(leg, authorization);
    assert.ok(opened instanceof FakeSocket, `refused with ${opened}`);
    return opened;
  }
  /** The channel the standby socket was last told to open. */
  function lastOpen(standby: FakeSocket): string {
    const open = standby.texts().at(-1) as { type: string; channel: string };
    assert.equal(open.type, "open");
    assert.match(open.channel, /^[A-Za-z0-9_-]{22}$/);
    return open.channel;
  }
  return { host, tunnel, logged, open, socket, lastOpen };
}

/** How a socket was closed, read afresh: an assertion that it was not would narrow it for good. */
function closeCode(socket: FakeSocket): number | undefined {
  return socket.closedWith?.code;
}

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

// MARK: The routes

test("a tunnel path names a relay id and a leg; anything else is not one", () => {
  const channel = randomBytes(16).toString("base64url");
  assert.deepEqual(tunnelPath(`/v1/tunnel/${RELAY}/mac`), { relay: RELAY, leg: { kind: "mac" } });
  assert.deepEqual(tunnelPath(`/v1/tunnel/${RELAY}/mac/${channel}`), { relay: RELAY, leg: { kind: "channel", channel } });
  assert.deepEqual(tunnelPath(`/v1/tunnel/${RELAY}/device`), { relay: RELAY, leg: { kind: "device" } });
  for (const path of [`/v1/tunnel/${RELAY}/device/${channel}`, `/v1/tunnel/${RELAY}`, `/v1/tunnel/short/mac`, `/v1/tunnel/${RELAY}/mac/short`, `/v1/tunnel/${RELAY}/other`, `/v1/tunnel/${RELAY}/mac/`]) {
    assert.equal(tunnelPath(path), undefined, path);
  }
});

test("the Worker sends a WebSocket to the Mac's object, after the rate limit per relay id", async () => {
  const forwarded: string[] = [];
  const keys: string[] = [];
  const route = makeTunnelRoute({
    limit: { limit: async ({ key }) => (keys.push(key), { success: keys.length <= 2 }) },
    forward: async (relay) => (forwarded.push(relay), new Response("to the object")),
  });
  const upgrade = { upgrade: "websocket" };
  assert.equal(route(new Request("https://relay.example/v1/health")), undefined, "not the tunnel's");

  assert.equal(await (await route(new Request(`https://relay.example/v1/tunnel/${RELAY}/device`, { headers: upgrade }))!).text(), "to the object");
  const plain = await route(new Request(`https://relay.example/v1/tunnel/${RELAY}/device`))!;
  assert.equal(plain.status, 426);
  assert.equal(typeof ((await plain.json()) as { detail: unknown }).detail, "string");
  assert.equal((await route(new Request(`https://relay.example/v1/tunnel/${RELAY}/nothing`, { headers: upgrade }))!).status, 404);
  assert.equal((await route(new Request(`https://relay.example/v1/tunnel/${RELAY}/mac`, { headers: upgrade }))!).status, 200);
  const limited = await route(new Request(`https://relay.example/v1/tunnel/${RELAY}/mac`, { headers: upgrade }))!;
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.deepEqual(forwarded, [RELAY, RELAY]);
  assert.deepEqual(keys, [RELAY, RELAY, RELAY]);
});

// MARK: The Mac's secret

test("the first standby socket claims the object, and only its secret opens the Mac's sockets after", async () => {
  const { host, open, logged } = setup();
  // Before any claim, a Mac's channel leg has nothing to be the leg of.
  assert.equal(await open({ kind: "channel", channel: randomBytes(16).toString("base64url") }), 404);
  assert.equal(await open({ kind: "mac" }, null), 401);
  assert.equal(await open({ kind: "mac" }, "Bearer short"), 401);
  assert.equal(host.storage.size, 0);

  assert.ok((await open({ kind: "mac" })) instanceof Object);
  assert.match(host.storage.get("secret") as string, /^[0-9a-f]{64}$/);
  assert.notEqual(host.storage.get("secret"), SECRET, "only its hash is kept");
  assert.equal(await open({ kind: "mac" }, `Bearer ${randomBytes(32).toString("base64url")}`), 401);
  assert.equal(await open({ kind: "channel", channel: randomBytes(16).toString("base64url") }, `Bearer ${randomBytes(32).toString("base64url")}`), 401);
  assert.ok((await open({ kind: "mac" })) instanceof Object, "the same secret again");
  assert.ok(logged.every((line) => !line.includes(SECRET)), "the secret is never logged");
});

// MARK: Channels

test("a device is given a channel, the Mac opens its leg, and every message passes both ways as it is", async () => {
  const { host, socket, open, lastOpen } = setup();
  const standby = await socket({ kind: "mac" });
  const device = await socket({ kind: "device" });
  const channel = lastOpen(standby);
  assert.equal(host.alarmAt, host.clock + answerMs);

  // The handshake's first frame comes before the Mac's leg does, and waits for it. Each
  // step is taken by a new object, as after a sleep: what waits is kept with the device's
  // socket, and the claim in storage.
  const first = bytes(...randomBytes(32));
  new Tunnel(host).message(device, first);

  const leg = await socket({ kind: "channel", channel });
  assert.deepEqual(leg.sent, [first]);
  assert.equal(await open({ kind: "channel", channel }), 409, "one leg per channel");
  assert.equal(await open({ kind: "channel", channel: randomBytes(16).toString("base64url") }), 404);

  const tunnel = new Tunnel(host);
  tunnel.message(leg, bytes(1, 2, 3));
  tunnel.message(device, bytes(4, 5));
  tunnel.message(device, "text as it is");
  assert.deepEqual(device.sent, [bytes(1, 2, 3)]);
  assert.deepEqual(leg.sent, [first, bytes(4, 5), "text as it is"]);
  // A paired device is not closed for the time it took.
  host.clock += answerMs * 2;
  await tunnel.alarm();
  assert.equal(device.closedWith, undefined);
});

test("when either end of a channel closes, so does the other, with its code when it can be passed on", async () => {
  const { tunnel, socket, lastOpen } = setup();
  const standby = await socket({ kind: "mac" });

  const refusedDevice = await socket({ kind: "device" });
  const refusedLeg = await socket({ kind: "channel", channel: lastOpen(standby) });
  refusedLeg.close(4401, "The token was not accepted.");
  tunnel.closed(refusedLeg, 4401, "The token was not accepted.");
  assert.deepEqual(refusedDevice.closedWith, { code: 4401, reason: "The token was not accepted." });

  const leaving = await socket({ kind: "device" });
  const leg = await socket({ kind: "channel", channel: lastOpen(standby) });
  leaving.close(1000, "");
  tunnel.closed(leaving, 1000, "");
  assert.deepEqual(leg.closedWith, { code: 1000, reason: "" });

  const dropped = await socket({ kind: "device" });
  const droppedLeg = await socket({ kind: "channel", channel: lastOpen(standby) });
  tunnel.closed(droppedLeg, 1006, "");
  assert.equal(dropped.closedWith?.code, 1001, "1006 is not a code one may send");
  // Its own close comes after: nothing more to do.
  tunnel.closed(dropped, 1001, "");
  assert.equal(standby.closedWith, undefined);
});

test("a device is closed with 4503 when the Mac has no standby socket, and 4504 when it does not answer in time", async () => {
  const { host, tunnel, socket, lastOpen } = setup();
  const alone = await socket({ kind: "device" });
  assert.equal(alone.closedWith?.code, TunnelClose.noMac);
  assert.equal(alone.closedWith?.reason, "The Mac is not connected to the relay.");

  const standby = await socket({ kind: "mac" });
  const early = await socket({ kind: "device" });
  host.clock += 4000;
  const late = await socket({ kind: "device" });
  assert.equal(host.alarmAt, host.clock - 4000 + answerMs, "the alarm is for the first due");

  host.clock += answerMs - 4000;
  await tunnel.alarm();
  assert.deepEqual(early.closedWith, { code: TunnelClose.noAnswer, reason: "The Mac did not answer." });
  assert.equal(late.closedWith, undefined);
  assert.equal(host.alarmAt, host.clock + 4000, "and set again for the next");
  const channel = lastOpen(standby);
  host.clock += 4000;
  await tunnel.alarm();
  assert.equal(closeCode(late), TunnelClose.noAnswer);
  // A leg that comes for a device gone finds nothing to pair with.
  assert.equal(await tunnel.admit({ kind: "channel", channel }, BEARER).then((refused) => refused?.status), 404);
});

test("the standby socket going closes the devices still waiting for the Mac, not those it answered", async () => {
  const { tunnel, socket, lastOpen } = setup();
  const standby = await socket({ kind: "mac" });
  const answered = await socket({ kind: "device" });
  await socket({ kind: "channel", channel: lastOpen(standby) });
  const waiting = await socket({ kind: "device" });
  standby.close(1006, "");
  tunnel.closed(standby, 1006, "");
  assert.equal(waiting.closedWith?.code, TunnelClose.noMac);
  assert.equal(answered.closedWith, undefined);
});

test("a newer standby socket takes the place of the one before, which is closed and told no more", async () => {
  const { tunnel, socket, lastOpen } = setup();
  const old = await socket({ kind: "mac" });
  const fresh = await socket({ kind: "mac" });
  assert.equal(old.closedWith?.code, TunnelClose.replaced);
  const device = await socket({ kind: "device" });
  lastOpen(fresh);
  assert.equal(old.texts().length, 0);
  // The old one's close, when it comes, leaves the device waiting for the new one.
  tunnel.closed(old, TunnelClose.replaced, "");
  assert.equal(device.closedWith, undefined);
});

test("two bridges with one relay id: the first keeps the standby socket, the second is refused 409 while the first is alive; its own reconnect, an old bridge, or a holder gone quiet still take its place", async () => {
  const { host, open, logged } = setup();
  const first = randomBytes(16).toString("base64url");
  const second = randomBytes(16).toString("base64url");
  const standby = async (instance: string | null) => {
    const opened = await open({ kind: "mac" }, BEARER, instance);
    assert.ok(opened instanceof FakeSocket, `refused with ${opened}`);
    return opened;
  };
  const holder = await standby(first);
  // Another bridge (a copied folder): refused before it opens, and the first keeps it.
  assert.equal(await open({ kind: "mac" }, BEARER, second), 409);
  assert.equal(closeCode(holder), undefined);
  assert.ok(logged.some((line) => line.includes("another bridge")));
  // Still refused while the first pings, past the time with none.
  host.clock += standbyStaleMs;
  host.pings.set(holder, host.clock - 10_000);
  assert.equal(await open({ kind: "mac" }, BEARER, second), 409);
  // The first's own newer socket (a reconnect the relay has not seen the end of) takes its place.
  const again = await standby(first);
  assert.equal(closeCode(holder), TunnelClose.replaced);
  // Its pings stop (the bridge is gone, its socket not closed yet): the second takes it.
  host.clock += standbyStaleMs;
  const taken = await standby(second);
  assert.equal(closeCode(again), TunnelClose.replaced);
  // A bridge from before this names no run, and replaces as it did.
  await standby(null);
  assert.equal(closeCode(taken), TunnelClose.replaced);
  // A name that is not one counts as none.
  await standby("not a run!");
});

test("at most twenty devices at once through one Mac's tunnel", async () => {
  const { socket } = setup();
  await socket({ kind: "mac" });
  const devices = [];
  for (let index = 0; index < mostDevices; index++) devices.push(await socket({ kind: "device" }));
  assert.ok(devices.every((device) => device.closedWith === undefined));
  const one = await socket({ kind: "device" });
  assert.equal(one.closedWith?.code, TunnelClose.tooMany);
  devices[0].close(1000, "");
  assert.equal((await socket({ kind: "device" })).closedWith, undefined, "room again once one leaves");
});

test("a device that sends more than its handshake before the Mac's leg is there is closed", async () => {
  const { tunnel, socket } = setup();
  await socket({ kind: "mac" });
  const device = await socket({ kind: "device" });
  tunnel.message(device, bytes(...randomBytes(32)));
  tunnel.message(device, bytes(...randomBytes(600)));
  assert.equal(device.closedWith, undefined);
  tunnel.message(device, bytes(...randomBytes(600)));
  assert.equal(closeCode(device), TunnelClose.tooEarly);
});

for (const kind of ["text", "binary", "mixed"] as const) {
  test(`four empty ${kind} frames fit before the Mac's leg, but a fifth is refused before storage`, async () => {
    const { host, socket } = setup();
    await socket({ kind: "mac" });
    const device = await socket({ kind: "device" });
    const empty = (index: number) => kind === "binary" || (kind === "mixed" && index % 2 === 1) ? bytes() : "";
    // Reconstruct the object between messages, as after hibernation.
    for (let index = 0; index < 4; index++) new Tunnel(host).message(device, empty(index));
    assert.equal(closeCode(device), undefined);
    const before = device.deserializeAttachment();
    new Tunnel(host).message(device, empty(4));
    assert.deepEqual(device.closedWith, { code: TunnelClose.tooEarly, reason: "Wait for the Mac before sending more." });
    assert.deepEqual(device.deserializeAttachment(), before, "a refused frame never reaches attachment storage");
  });
}

test("escaped text exceeding the pending JSON budget is refused before storage", async () => {
  const { tunnel, socket } = setup();
  await socket({ kind: "mac" });
  const device = await socket({ kind: "device" });
  const before = device.deserializeAttachment();
  tunnel.message(device, "\0".repeat(1000));
  assert.equal(closeCode(device), TunnelClose.tooEarly);
  assert.deepEqual(device.deserializeAttachment(), before);
});

test("the waiting attachment fits exactly its JSON budget, replays in order, and refuses one byte more", async () => {
  const { host, tunnel, socket, lastOpen } = setup();
  const standby = await socket({ kind: "mac" });
  for (const extra of [0, 1]) {
    const device = await socket({ kind: "device" });
    const channel = lastOpen(standby);
    const first = bytes(...randomBytes(32));
    tunnel.message(device, first);
    const state = device.deserializeAttachment() as { waiting: unknown[] };
    const room = 1536 - Buffer.byteLength(JSON.stringify({ ...state, waiting: [...state.waiting, { t: "" }] }));
    const text = "\0".repeat(Math.floor(room / 6)) + ".".repeat(room % 6 + extra);
    new Tunnel(host).message(device, text);
    if (extra) {
      assert.equal(closeCode(device), TunnelClose.tooEarly);
      assert.deepEqual(device.deserializeAttachment(), state);
    } else {
      assert.equal(closeCode(device), undefined);
      assert.equal(Buffer.byteLength(JSON.stringify(device.deserializeAttachment())), 1536);
      const leg = await socket({ kind: "channel", channel });
      assert.deepEqual(leg.sent, [first, text]);
    }
  }
});

test("the payload budget still counts UTF-8 bytes, and accepts the existing text and binary boundaries", async () => {
  const { tunnel, socket } = setup();
  await socket({ kind: "mac" });
  for (const frame of ["é".repeat(512), new Uint8Array(1023).buffer]) {
    const device = await socket({ kind: "device" });
    tunnel.message(device, frame);
    assert.equal(closeCode(device), undefined);
    tunnel.message(device, "é");
    assert.equal(closeCode(device), TunnelClose.tooEarly);
  }
});

test("mixed text within the pending JSON budget may serialize above 2 KiB and still replays intact", async () => {
  const { tunnel, socket, lastOpen } = setup();
  const standby = await socket({ kind: "mac" });
  const device = await socket({ kind: "device" });
  const text = "a".repeat(1022) + "Ā";
  assert.equal(Buffer.byteLength(text), 1024);
  tunnel.message(device, text);
  const state = device.deserializeAttachment();
  assert.equal(closeCode(device), undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 1536);
  assert.ok(serialize(state).byteLength > 2048);
  const leg = await socket({ kind: "channel", channel: lastOpen(standby) });
  assert.deepEqual(leg.sent, [text]);
});

test("the app's largest legitimate pre-leg burst is one key, and paired startup or reconnect traffic has no pending cap", async () => {
  const { host, socket, lastOpen } = setup();
  const standby = await socket({ kind: "mac" });
  // RelayTunnel.swift sends one key, waits for the Mac's, then sends its sealed token.
  // HermesConnection.swift waits for gateway.ready before capabilities or heartbeat.
  for (let reconnect = 0; reconnect < 3; reconnect++) {
    const device = await socket({ kind: "device" });
    const key = bytes(...randomBytes(32));
    new Tunnel(host).message(device, key);
    const leg = await socket({ kind: "channel", channel: lastOpen(standby) });
    assert.deepEqual(leg.sent, [key]);
    const tunnel = new Tunnel(host);
    tunnel.message(leg, key);
    const token = new Uint8Array(80).buffer;
    tunnel.message(device, token);
    const startup = Array.from({ length: 10 }, () => new Uint8Array(32 * 1024).buffer);
    for (const frame of startup) tunnel.message(device, frame);
    assert.deepEqual(leg.sent, [key, token, ...startup]);
    assert.equal(closeCode(device), undefined);
    assert.equal(closeCode(leg), undefined);
  }
});

test("a refused pending burst leaves another paired channel working", async () => {
  const { tunnel, socket, lastOpen } = setup();
  const standby = await socket({ kind: "mac" });
  const live = await socket({ kind: "device" });
  const leg = await socket({ kind: "channel", channel: lastOpen(standby) });
  const early = await socket({ kind: "device" });
  for (let index = 0; index < 5; index++) tunnel.message(early, "");
  assert.equal(closeCode(early), TunnelClose.tooEarly);
  tunnel.message(live, "still here");
  tunnel.message(leg, bytes(1, 2, 3));
  assert.deepEqual(leg.sent, ["still here"]);
  assert.deepEqual(live.sent, [bytes(1, 2, 3)]);
  assert.equal(closeCode(live), undefined);
  assert.equal(closeCode(standby), undefined);
});

test("back-to-back pre-pair reconnects have fresh budgets even when the old close arrives late", async () => {
  const { host, socket, lastOpen } = setup();
  const standby = await socket({ kind: "mac" });
  let old: FakeSocket | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    const device = await socket({ kind: "device" });
    const channel = lastOpen(standby);
    const key = new Uint8Array(32).fill(attempt).buffer;
    new Tunnel(host).message(device, key);
    if (old) new Tunnel(host).closed(old, 1001, "The old link went away.");
    const state = device.deserializeAttachment() as { waiting: unknown[] };
    assert.equal(state.waiting.length, 1, "another socket's old key is never counted");
    assert.equal(closeCode(device), undefined, "a late old close cannot close the reconnect");
    if (attempt === 7) {
      const leg = await socket({ kind: "channel", channel });
      assert.deepEqual(leg.sent, [key], "only this attempt's key is replayed");
    } else {
      // The new device may arrive before the old one's closing event is delivered.
      device.close(1001);
      old = device;
    }
  }
});

test("the standby socket's other words are ignored", async () => {
  const { tunnel, socket } = setup();
  const standby = await socket({ kind: "mac" });
  tunnel.message(standby, "hello");
  tunnel.message(standby, bytes(1));
  assert.equal(standby.closedWith, undefined);
  assert.deepEqual(standby.sent, []);
});
