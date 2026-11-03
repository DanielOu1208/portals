import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, webcrypto, type KeyObject } from "node:crypto";
import { EventEmitter } from "node:events";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { parseConfig } from "../src/config.ts";
import type { GatewaySocket } from "../src/gateway/gateway.ts";
import type { MemberSignIn } from "../src/net/net.ts";
import { Opener, publicKeyFrom, rawPublicKey, SealBroken, Sealer, tunnelKeys, x25519 } from "../src/relay/seal.ts";
import { Standby } from "../src/relay/standby.ts";
import { mostFrameBytes, Tunnel, TunnelRefused } from "../src/relay/tunnel.ts";
import { TunnelDevice } from "../scripts/tunnel-device.ts";
import { makeVectors, privateKeyFrom } from "../scripts/tunnel-vectors.ts";
import { startTestBridge, TestClient, type TestBridge } from "./helpers.ts";
import { RelayStandIn } from "./relay-standin.ts";

// The relay's tunnel from the bridge's side (docs/pairing-and-relay.md, "The tunnel";
// docs/net-plan.md, R1): the sealing against the test vectors the app checks too, the
// bridge's leg of a channel, its standby socket, and a device through the relay's own
// object (relay/src/tunnel.ts, in this process: test/relay-standin.ts) to a real bridge.

const vectors = JSON.parse(readFileSync(new URL("./fixtures/tunnel-vectors.json", import.meta.url), "utf8"));
const hex = (text: string) => Buffer.from(text, "hex");

// MARK: Sealing

test("the test vectors are what the bridge's sealing makes, and the file is up to date", () => {
  assert.deepEqual(makeVectors(), vectors, "run node scripts/tunnel-vectors.ts");
  // From the private keys alone, as the app's tests will.
  const macStatic = privateKeyFrom(hex(vectors.mac_static.private));
  const device = privateKeyFrom(hex(vectors.device_ephemeral.private));
  const mac = privateKeyFrom(hex(vectors.mac_ephemeral.private));
  assert.equal(rawPublicKey(macStatic).toString("hex"), vectors.mac_static.public);
  assert.equal(rawPublicKey(macStatic).toString("base64url"), vectors.mac_static.public_base64url);
  assert.equal(rawPublicKey(device).toString("hex"), vectors.device_ephemeral.public);
  assert.equal(rawPublicKey(mac).toString("hex"), vectors.mac_ephemeral.public);

  // Each side's view of the two shared secrets is the same.
  const devicePublic = publicKeyFrom(hex(vectors.device_ephemeral.public));
  assert.equal(x25519(mac, devicePublic).toString("hex"), vectors.shared_ephemeral);
  assert.equal(x25519(macStatic, devicePublic).toString("hex"), vectors.shared_static);
  const keys = tunnelKeys(
    { ephemeral: x25519(mac, devicePublic), static: x25519(macStatic, devicePublic) },
    { device: hex(vectors.device_ephemeral.public), mac: hex(vectors.mac_ephemeral.public), macStatic: hex(vectors.mac_static.public) },
  );
  assert.equal(keys.deviceToMac.toString("hex"), vectors.k_dm);
  assert.equal(keys.macToDevice.toString("hex"), vectors.k_md);

  const fromDevice = new Opener(keys.deviceToMac);
  for (const frame of vectors.device_to_mac) assert.equal(fromDevice.open(hex(frame.sealed)).toString("utf8"), frame.plaintext);
  const toDevice = new Sealer(keys.macToDevice);
  for (const frame of vectors.mac_to_device) assert.equal(toDevice.seal(Buffer.from(frame.plaintext, "utf8")).toString("hex"), frame.sealed);
});

test("the test vectors hold with WebCrypto too: SHA-256, HKDF and AES-GCM by another road", async () => {
  const subtle = webcrypto.subtle;
  const salt = new Uint8Array(await subtle.digest("SHA-256", Buffer.concat([Buffer.from("portals-tunnel-v1"), hex(vectors.device_ephemeral.public), hex(vectors.mac_ephemeral.public), hex(vectors.mac_static.public)])));
  assert.equal(Buffer.from(salt).toString("hex"), vectors.salt);
  const ikm = await subtle.importKey("raw", hex(vectors.ikm), "HKDF", false, ["deriveBits"]);
  const okm = Buffer.from(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: Buffer.from("keys") }, ikm, 512));
  assert.equal(okm.subarray(0, 32).toString("hex"), vectors.k_dm);
  assert.equal(okm.subarray(32).toString("hex"), vectors.k_md);
  for (const [direction, key] of [["device_to_mac", vectors.k_dm], ["mac_to_device", vectors.k_md]] as const) {
    const aes = await subtle.importKey("raw", hex(key), "AES-GCM", false, ["decrypt"]);
    for (const frame of vectors[direction]) {
      const plain = await subtle.decrypt({ name: "AES-GCM", iv: hex(frame.nonce), tagLength: 128 }, aes, hex(frame.sealed));
      assert.equal(Buffer.from(plain).toString("utf8"), frame.plaintext);
      assert.equal(frame.nonce, "00000000" + frame.counter.toString(16).padStart(16, "0"));
    }
  }
});

test("X25519 here is RFC 7748's (its section 6.1)", () => {
  const alice = privateKeyFrom(hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"));
  const bob = privateKeyFrom(hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb"));
  assert.equal(rawPublicKey(alice).toString("hex"), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  assert.equal(rawPublicKey(bob).toString("hex"), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
  assert.equal(x25519(alice, publicKeyFrom(rawPublicKey(bob))).toString("hex"), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
});

test("a frame opens only once, in its turn, and as it was sealed", () => {
  const key = randomBytes(32);
  const sealer = new Sealer(key);
  const frames = ["zero", "one", "two"].map((text) => sealer.seal(Buffer.from(text)));
  assert.equal(frames[0].length, 4 + 16, "the ciphertext, then the 16-byte tag");

  const tampered = Buffer.from(frames[0]);
  tampered[0] ^= 1;
  assert.throws(() => new Opener(key).open(tampered), SealBroken);
  const badTag = Buffer.from(frames[0]);
  badTag[badTag.length - 1] ^= 1;
  assert.throws(() => new Opener(key).open(badTag), SealBroken);
  assert.throws(() => new Opener(key).open(frames[1]), SealBroken, "out of turn: its counter is 1");
  assert.throws(() => new Opener(key).open(frames[0].subarray(0, 15)), SealBroken, "shorter than a tag");
  assert.throws(() => new Opener(randomBytes(32)).open(frames[0]), SealBroken, "another key");

  const opener = new Opener(key);
  assert.equal(opener.open(frames[0]).toString(), "zero");
  assert.throws(() => opener.open(frames[0]), SealBroken, "a replay");
  // A frame that did not open does not move the counter.
  assert.equal(opener.open(frames[1]).toString(), "one");
  assert.equal(opener.open(frames[2]).toString(), "two");
});

// MARK: The bridge's leg, alone

/** The relay's end of a leg: what the bridge sent, and how it closed it. */
class FakeLeg extends EventEmitter {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Buffer[] = [];
  closedWith: { code?: number; reason?: string } | undefined;

  send(data: Buffer, _options: unknown, callback?: (error?: Error) => void): void {
    this.sent.push(Buffer.from(data));
    if (callback) process.nextTick(callback);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  ping(): void {}

  terminate(): void {
    this.readyState = 3;
  }

  /** A frame from the device. */
  deliver(bytes: Buffer, isBinary = true): void {
    this.emit("message", bytes, isBinary);
  }
}

/** A Mac's key pair and a net that takes one token. */
function fakeNet(token = "t".repeat(43)) {
  const pair = generateKeyPairSync("x25519");
  return {
    key: rawPublicKey(pair.publicKey),
    net: {
      publicKey: () => rawPublicKey(pair.publicKey).toString("base64url"),
      agree: (other: KeyObject) => x25519(pair.privateKey, other),
      authenticate: async (given: string): Promise<MemberSignIn | undefined> => (given === token ? { kind: "member", id: "phone-0000-0001", member: "device", removed: false } : undefined),
    },
  };
}

/** The device's side of a handshake over a `FakeLeg`: sends its key, reads the Mac's, and keeps the keys. */
function handshake(leg: FakeLeg, macStatic: Buffer) {
  const ephemeral = generateKeyPairSync("x25519");
  const mine = rawPublicKey(ephemeral.publicKey);
  leg.deliver(mine);
  const mac = leg.sent.at(-1)!;
  assert.equal(mac.length, 32);
  const keys = tunnelKeys(
    { ephemeral: x25519(ephemeral.privateKey, publicKeyFrom(mac)), static: x25519(ephemeral.privateKey, publicKeyFrom(macStatic)) },
    { device: mine, mac, macStatic },
  );
  return { sealer: new Sealer(keys.deviceToMac), opener: new Opener(keys.macToDevice) };
}

test("a tunnel carries negotiated lean delta frames unchanged beside JSON-RPC frames", async () => {
  const { key, net } = fakeNet();
  const leg = new FakeLeg();
  let accept!: (socket: GatewaySocket) => void;
  const accepted = new Promise<GatewaySocket>((resolve) => { accept = resolve; });
  new Tunnel(leg as unknown as WebSocket, { net, accept });
  const device = handshake(leg, key);
  leg.deliver(device.sealer.seal(Buffer.from(JSON.stringify({ token: "t".repeat(43) }))));
  const socket = await accepted;
  const texts = [
    '{"d":["thread",4,"日本語\\n"]}',
    '{"jsonrpc":"2.0","method":"event","params":{"type":"tool.start","session_id":"thread","seq":5}}',
    '{"t":["thread",6,"checking"]}',
  ];
  for (const text of texts) socket.send(text);
  assert.deepEqual(leg.sent.slice(1).map((frame) => device.opener.open(frame).toString("utf8")), texts);
  socket.close();
});

test("an answer too large for the relay becomes an error for its call, and an event that large is left out", async () => {
  const { key, net } = fakeNet();
  const leg = new FakeLeg();
  let accepted: GatewaySocket | undefined;
  new Tunnel(leg as unknown as WebSocket, { net, accept: (socket) => (accepted = socket) });
  const device = handshake(leg, key);
  leg.deliver(device.sealer.seal(Buffer.from(JSON.stringify({ token: "t".repeat(43) }))));
  await sleep(10);
  assert.ok(accepted);

  const huge = "x".repeat(mostFrameBytes);
  const written: string[] = [];
  accepted.send(JSON.stringify({ jsonrpc: "2.0", id: "r7", result: { text: huge } }), () => written.push("answer"));
  accepted.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { text: huge } }), () => written.push("event"));
  accepted.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "small" } }), () => written.push("small"));
  await sleep(10);
  assert.deepEqual(written, ["answer", "event", "small"], "each frame's callback is called once, in order");
  const frames = leg.sent.slice(1).map((frame) => JSON.parse(device.opener.open(frame).toString()));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].id, "r7");
  assert.match(frames[0].error.message, /over 16 MiB, too large to send through the relay/);
  assert.equal(frames[1].params.type, "small");
});

test("the handshake and the token must come in time, the device's key must be 32 bytes and not of low order, and frames binary", async () => {
  const { key, net } = fakeNet();
  const slow = new FakeLeg();
  new Tunnel(slow as unknown as WebSocket, { net, accept: () => assert.fail("not signed in"), handshakeMs: 30 });
  await sleep(60);
  assert.equal(slow.closedWith?.code, TunnelRefused.slow);

  const short = new FakeLeg();
  new Tunnel(short as unknown as WebSocket, { net, accept: () => assert.fail("not signed in") });
  short.deliver(randomBytes(31));
  assert.equal(short.closedWith?.code, TunnelRefused.broken);

  // A key of low order, whose shared secret would be all zeros: X25519 refuses it.
  const zero = new FakeLeg();
  new Tunnel(zero as unknown as WebSocket, { net, accept: () => assert.fail("not signed in") });
  zero.deliver(Buffer.alloc(32));
  assert.equal(zero.closedWith?.code, TunnelRefused.broken);
  assert.equal(zero.sent.length, 0, "no key of the Mac's sent back");

  const text = new FakeLeg();
  new Tunnel(text as unknown as WebSocket, { net, accept: () => assert.fail("not signed in") });
  handshake(text, key);
  text.deliver(Buffer.from(JSON.stringify({ token: "t".repeat(43) })), false);
  assert.equal(text.closedWith?.code, TunnelRefused.broken);
});

test("frames that come while the token is checked reach the gateway after it, in order", async () => {
  const { key, net } = fakeNet();
  // The token's check waits until let go.
  let release: () => void = () => undefined;
  const slowNet = { ...net, authenticate: (token: string) => new Promise<MemberSignIn | undefined>((resolve) => (release = () => void net.authenticate(token).then(resolve))) };
  const leg = new FakeLeg();
  const heard: string[] = [];
  new Tunnel(leg as unknown as WebSocket, { net: slowNet, accept: (socket) => socket.on("message", (data) => heard.push(data.toString())) });
  const device = handshake(leg, key);
  leg.deliver(device.sealer.seal(Buffer.from(JSON.stringify({ token: "t".repeat(43) }))));
  leg.deliver(device.sealer.seal(Buffer.from("first")));
  leg.deliver(device.sealer.seal(Buffer.from("second")));
  release();
  await sleep(10);
  leg.deliver(device.sealer.seal(Buffer.from("third")));
  assert.deepEqual(heard, ["first", "second", "third"]);
});

test("at most 4 frames and 64 KiB may come while the token is checked: more closes the tunnel, and what was kept goes", async () => {
  const { key, net } = fakeNet();
  // The token's check waits until let go.
  const releases: (() => void)[] = [];
  const slowNet = { ...net, authenticate: (token: string) => new Promise<MemberSignIn | undefined>((resolve) => releases.push(() => void net.authenticate(token).then(resolve))) };
  const token = Buffer.from(JSON.stringify({ token: "t".repeat(43) }));

  const many = new FakeLeg();
  new Tunnel(many as unknown as WebSocket, { net: slowNet, accept: () => assert.fail("not signed in") });
  const one = handshake(many, key);
  many.deliver(one.sealer.seal(token));
  for (let count = 0; count < 4; count += 1) many.deliver(one.sealer.seal(Buffer.from(`frame ${count}`)));
  assert.equal(many.closedWith, undefined, "four are kept");
  many.deliver(one.sealer.seal(Buffer.from("frame 4")));
  assert.deepEqual(many.closedWith, { code: TunnelRefused.broken, reason: "Too much came through the tunnel before the token was accepted." });

  const large = new FakeLeg();
  new Tunnel(large as unknown as WebSocket, { net: slowNet, accept: () => assert.fail("not signed in") });
  const other = handshake(large, key);
  large.deliver(other.sealer.seal(token));
  large.deliver(other.sealer.seal(Buffer.alloc(40 * 1024, 0x61)));
  assert.equal(large.closedWith, undefined);
  large.deliver(other.sealer.seal(Buffer.alloc(30 * 1024, 0x61)));
  assert.deepEqual(large.closedWith, { code: TunnelRefused.broken, reason: "Too much came through the tunnel before the token was accepted." }, "over 64 KiB in all");

  // The token accepted after the tunnel closed: nothing reaches the gateway.
  for (const release of releases) release();
  await sleep(10);
});

test("a token refused or a member removed is told the device in one sealed frame before the close with 4401; a check that failed is not", async () => {
  const { key, net } = fakeNet();
  const refused = new FakeLeg();
  new Tunnel(refused as unknown as WebSocket, { net, accept: () => assert.fail("not signed in") });
  const device = handshake(refused, key);
  refused.deliver(device.sealer.seal(Buffer.from(JSON.stringify({ token: "w".repeat(43) }))));
  await sleep(10);
  assert.deepEqual(refused.closedWith, { code: TunnelRefused.token, reason: "The token was not accepted." });
  assert.deepEqual(refused.sent.slice(1).map((frame) => JSON.parse(device.opener.open(frame).toString())), [{ refused: "token", message: "The token was not accepted." }]);

  const removed = new FakeLeg();
  let accepted: GatewaySocket | undefined;
  new Tunnel(removed as unknown as WebSocket, { net, accept: (socket) => (accepted = socket) });
  const member = handshake(removed, key);
  removed.deliver(member.sealer.seal(Buffer.from(JSON.stringify({ token: "t".repeat(43) }))));
  await sleep(10);
  accepted!.close(4401, "This device was removed from the net.");
  assert.deepEqual(removed.sent.slice(1).map((frame) => JSON.parse(member.opener.open(frame).toString())), [{ refused: "removed", message: "This device was removed from the net." }]);
  assert.equal(removed.closedWith?.code, 4401);

  // Another close is not a refusal.
  const closing = new FakeLeg();
  new Tunnel(closing as unknown as WebSocket, { net, accept: (socket) => socket.close(1001, "The bridge is shutting down.") });
  const leaving = handshake(closing, key);
  closing.deliver(leaving.sealer.seal(Buffer.from(JSON.stringify({ token: "t".repeat(43) }))));
  await sleep(10);
  assert.equal(closing.sent.length, 1, "only the Mac's key");

  const failing = new FakeLeg();
  new Tunnel(failing as unknown as WebSocket, { net: { ...net, authenticate: () => Promise.reject(new Error("the list could not be read")) }, accept: () => assert.fail("not signed in") });
  const unlucky = handshake(failing, key);
  failing.deliver(unlucky.sealer.seal(Buffer.from(JSON.stringify({ token: "t".repeat(43) }))));
  await sleep(10);
  assert.equal(failing.closedWith?.code, 4401);
  assert.equal(failing.sent.length, 1, "no sealed refusal: the device tries again");
});

test("a request too large for the relay is answered with an error for its call, and the tunnel stays open", async () => {
  const { key, net } = fakeNet();
  const leg = new FakeLeg();
  const heard: string[] = [];
  new Tunnel(leg as unknown as WebSocket, { net, accept: (socket) => socket.on("message", (data) => heard.push(data.toString())) });
  const device = handshake(leg, key);
  leg.deliver(device.sealer.seal(Buffer.from(JSON.stringify({ token: "t".repeat(43) }))));
  await sleep(10);

  const huge = "x".repeat(mostFrameBytes);
  leg.deliver(device.sealer.seal(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "r9", method: "file.attach_bytes", params: { data: huge } }))));
  leg.deliver(device.sealer.seal(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "note", params: { data: huge } }))));
  leg.deliver(device.sealer.seal(Buffer.from("small")));
  assert.deepEqual(heard, ["small"], "neither large frame reached the gateway");
  assert.equal(leg.closedWith, undefined);
  const answers = leg.sent.slice(1).map((frame) => JSON.parse(device.opener.open(frame).toString()));
  assert.equal(answers.length, 1);
  assert.equal(answers[0].id, "r9");
  assert.match(answers[0].error.message, /request is over 16 MiB, too large to send through the relay/);
});

test("the token's check has its own time limit once the token came, so asking the other Macs is not cut short", async () => {
  const { key, net } = fakeNet();
  const slowNet = { ...net, authenticate: async (token: string) => (await sleep(80), net.authenticate(token)) };
  const leg = new FakeLeg();
  let accepted = false;
  new Tunnel(leg as unknown as WebSocket, { net: slowNet, accept: () => (accepted = true), handshakeMs: 40, checkMs: 1000 });
  const device = handshake(leg, key);
  leg.deliver(device.sealer.seal(Buffer.from(JSON.stringify({ token: "t".repeat(43) }))));
  await sleep(120);
  assert.equal(leg.closedWith, undefined);
  assert.ok(accepted, "signed in after the handshake's limit had passed");

  const stuck = new FakeLeg();
  new Tunnel(stuck as unknown as WebSocket, { net: { ...net, authenticate: () => new Promise<undefined>(() => undefined) }, accept: () => assert.fail("not signed in"), handshakeMs: 1000, checkMs: 30 });
  const other = handshake(stuck, key);
  stuck.deliver(other.sealer.seal(Buffer.from(JSON.stringify({ token: "t".repeat(43) }))));
  await sleep(60);
  assert.deepEqual(stuck.closedWith, { code: TunnelRefused.slow, reason: "The Mac took too long to check the token." });
});

// MARK: The standby socket

test("the standby socket is opened again after the relay goes, waiting longer each time up to its most", async () => {
  // A relay that refuses every socket, noting when each came.
  const tries: number[] = [];
  const refusing = createServer();
  refusing.on("upgrade", (_request, socket) => {
    tries.push(Date.now());
    socket.end("HTTP/1.1 503 Busy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
  const { net } = fakeNet();
  const standby = new Standby({
    url: `http://127.0.0.1:${(refusing.address() as AddressInfo).port}`,
    net: { ...net, relay: () => ({ id: randomBytes(16).toString("base64url"), secret: randomBytes(32).toString("base64url") }) },
    accept: () => undefined,
    firstRetryMs: 20,
    lastRetryMs: 80,
  });
  standby.start();
  await sleep(450);
  standby.close();
  await new Promise<void>((resolve) => refusing.close(() => resolve()));
  const waits = tries.slice(1).map((at, index) => at - tries[index]);
  assert.ok(waits.length >= 4, `${waits.length} tries after the first`);
  // 20, 40, 80, 80, …: each at least what it should be, and none past the most by much.
  assert.ok(waits[0] >= 18 && waits[1] >= 38 && waits[2] >= 78, waits.join(", "));
  assert.ok(waits.every((wait) => wait < 80 + 60), waits.join(", "));
  const count = tries.length;
  await sleep(150);
  assert.equal(tries.length, count, "none after it was closed");
});

test("a standby socket the relay closes for another's (4409, a relay that lets the newest have it) says another bridge holds the relay id, and is opened again only slowly", async () => {
  // A relay from before the first one kept it: it takes the socket, then another bridge's replaces it.
  const tries: number[] = [];
  const sockets = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => sockets.once("listening", () => resolve()));
  sockets.on("connection", (socket) => {
    tries.push(Date.now());
    setTimeout(() => socket.close(4409, "Another standby connection of this Mac took its place."), 20);
  });
  const { net } = fakeNet();
  const standby = new Standby({
    url: `http://127.0.0.1:${(sockets.address() as AddressInfo).port}`,
    net: { ...net, relay: () => ({ id: randomBytes(16).toString("base64url"), secret: randomBytes(32).toString("base64url") }) },
    accept: () => undefined,
    firstRetryMs: 20,
    lastRetryMs: 40,
    inUseRetryMs: 300,
  });
  try {
    assert.equal(standby.problem, undefined);
    standby.start();
    await sleep(200);
    assert.equal(standby.problem, "in_use");
    // Not every 20-40 ms: the next try waits the slow retry.
    assert.equal(tries.length, 1);
    await sleep(250);
    assert.equal(tries.length, 2);
  } finally {
    standby.close();
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  }
});

test("a standby socket whose pings go unanswered is opened again", async () => {
  // A relay that takes the socket and never says pong.
  const sockets = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => sockets.once("listening", () => resolve()));
  let opened = 0;
  const pings: string[] = [];
  sockets.on("connection", (socket) => {
    opened += 1;
    socket.on("message", (data) => pings.push(data.toString()));
  });
  const { net } = fakeNet();
  const standby = new Standby({
    url: `http://127.0.0.1:${(sockets.address() as AddressInfo).port}`,
    net: { ...net, relay: () => ({ id: randomBytes(16).toString("base64url"), secret: randomBytes(32).toString("base64url") }) },
    accept: () => undefined,
    firstRetryMs: 10,
    pingEveryMs: 30,
  });
  standby.start();
  await sleep(250);
  standby.close();
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  assert.ok(pings.length >= 2 && pings.every((ping) => ping === "ping"), pings.join(","));
  assert.ok(opened >= 2, `${opened} standby sockets`);
});

test("a standby socket the relay takes and never answers is given up and opened again; a leg that never opens is closed with the handshake's limit", async (t) => {
  // A relay that takes every request and answers none but the standby socket's, once asked to.
  const asked: string[] = [];
  /** The requests it left waiting that the bridge has not let go of. */
  const waiting = new Set<import("node:stream").Duplex>();
  const every: import("node:stream").Duplex[] = [];
  const sockets = new WebSocketServer({ noServer: true });
  let answer = false;
  const stalling = createServer();
  stalling.on("upgrade", (request, socket, head) => {
    asked.push(request.url!.endsWith("/mac") ? "mac" : "leg");
    every.push(socket);
    if (answer && request.url!.endsWith("/mac")) {
      sockets.handleUpgrade(request, socket, head, (standby) => standby.send(JSON.stringify({ type: "open", channel: randomBytes(16).toString("base64url") })));
      return;
    }
    waiting.add(socket);
    socket.on("error", () => undefined);
    socket.once("end", () => waiting.delete(socket));
    socket.once("close", () => waiting.delete(socket));
  });
  await new Promise<void>((resolve) => stalling.listen(0, "127.0.0.1", resolve));
  const { net } = fakeNet();
  const standby = new Standby({
    url: `http://127.0.0.1:${(stalling.address() as AddressInfo).port}`,
    net: { ...net, relay: () => ({ id: randomBytes(16).toString("base64url"), secret: randomBytes(32).toString("base64url") }) },
    accept: () => assert.fail("no device"),
    firstRetryMs: 10,
    openingMs: 50,
    handshakeMs: 50,
  });
  t.after(async () => {
    standby.close();
    for (const socket of every) socket.destroy();
    await new Promise<void>((resolve) => stalling.close(() => resolve()));
  });
  standby.start();
  await sleep(300);
  assert.ok(asked.filter((leg) => leg === "mac").length >= 3, `${asked.join(",")}: given up and opened again`);
  await sleep(100);
  assert.ok(waiting.size <= 1, `${waiting.size} waiting: each given up`);

  // Now the standby socket opens and a device comes, whose leg the relay never answers.
  answer = true;
  const ends = Date.now() + 2000;
  while (!asked.includes("leg") && Date.now() < ends) await sleep(10);
  assert.ok(asked.includes("leg"), "the leg was asked for");
  await sleep(150);
  assert.equal(waiting.size, 0, "the leg's request was let go of too");
});

test("relay.enabled is on and relay.url the deployed relay unless config.json says otherwise", () => {
  assert.deepEqual(parseConfig({}).relay, { enabled: true, url: "https://portals-relay.danielou1208.workers.dev" });
  assert.deepEqual(parseConfig({ relay: { enabled: false, url: "http://127.0.0.1:8787/" } }).relay, { enabled: false, url: "http://127.0.0.1:8787" });
  assert.throws(() => parseConfig({ relay: { enabled: "yes" } }), /relay.enabled must be true or false/);
  assert.throws(() => parseConfig({ relay: { url: "ftp://relay" } }), /relay.url must be the relay's https address/);
  assert.throws(() => parseConfig({ relay: 1 }), /relay must be an object/);
});

// MARK: Through the relay's object, to a real bridge

let relay: RelayStandIn;
let bridge: TestBridge;
let toBridge: TestClient;
/** The Mac as the net lists it: what a device needs to reach it through the relay. */
let mac: { id: string; relay: string; key: string };

before(async () => {
  relay = await RelayStandIn.start();
  bridge = await startTestBridge({ config: { relay: { enabled: true, url: relay.url } } });
  toBridge = await TestClient.open(bridge);
  const listed = await toBridge.call("net.list");
  mac = listed.members.find((member: { id: string }) => member.id === listed.here);
  await eventually(() => relay.open(mac.relay, "mac").length === 1, "the bridge's standby socket is open");
});

after(async () => {
  await toBridge?.close();
  await bridge?.dispose();
  await relay?.close();
});

async function eventually(check: () => boolean, what: string): Promise<void> {
  const ends = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > ends) throw new Error(`timed out waiting until ${what}`);
    await sleep(10);
  }
}

/** Joins a device through the bridge, as the app does: a code, then `POST /net/join`. */
async function joinDevice(id: string): Promise<string> {
  const { code } = await toBridge.call("net.invite");
  const response = await fetch(`${bridge.url}/net/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, member: { id, kind: "device", name: "iPhone", platform: "ios" } }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}

test("a device in the net reaches the bridge through the relay: signed in by its token, it lists threads and talks to an agent", async () => {
  const token = await joinDevice("phone-tunnel-0001");
  const device = await TunnelDevice.open({ relay: relay.url, relayID: mac.relay, macKey: mac.key, token });
  const ready = await device.find((frame) => frame.method === "event" && frame.params?.type === "gateway.ready");
  assert.equal(ready.params.payload.bridge.net.id, (await toBridge.call("net.list")).net);
  assert.equal(ready.params.payload.bridge.machine.id, mac.id);
  await device.call("client.capabilities", { server_requests: true });
  assert.equal((await device.call("net.list")).you, "phone-tunnel-0001", "signed in as the member its token is");

  const session = (await device.call("session.create", { profile: "fake", source: "tui" })).session_id;
  assert.ok((await device.call("threads.list")).threads.some((thread: { id: string }) => thread.id === session));
  const submitted = await device.call("prompt.submit", { session_id: session, text: "Hi through the relay", profile: "fake" });
  assert.equal(submitted.status, "streaming");
  const done = await device.find((frame) => frame.method === "event" && frame.params?.type === "message.complete" && frame.params.session_id === session);
  assert.match(done.params.payload.text, /Hello from the fake agent\. You said: Hi through the relay\./);
  // The relay saw only sealed frames: the reply's words never passed it in the clear.
  assert.equal(relay.open(mac.relay, "device").length, 1);

  assert.equal((await device.close()).code, 1000);
});

test("a token the bridge does not take is told the device, sealed, and closes the tunnel with 4401", async () => {
  const device = await TunnelDevice.open({ relay: relay.url, relayID: mac.relay, macKey: mac.key, token: randomBytes(32).toString("base64url") });
  assert.deepEqual(await device.closed, { code: 4401, reason: "The token was not accepted." });
  assert.deepEqual(device.frames, [{ refused: "token", message: "The token was not accepted." }], "the one frame the device opened");
});

test("a device that uses another key for the Mac fails at its first frame, which the bridge cannot open", async () => {
  const token = await joinDevice("phone-tunnel-0002");
  const wrong = rawPublicKey(generateKeyPairSync("x25519").publicKey).toString("base64url");
  const device = await TunnelDevice.open({ relay: relay.url, relayID: mac.relay, macKey: wrong, token });
  assert.deepEqual(await device.closed, { code: TunnelRefused.broken, reason: "A frame through the tunnel did not open." });
  assert.equal(device.frames.length, 0, "nothing came from the Mac but its key");
});

test("a frame changed on the way closes the tunnel, and a removed device's tunnel is closed as its connection is", async () => {
  const token = await joinDevice("phone-tunnel-0003");
  const tampered = await TunnelDevice.open({ relay: relay.url, relayID: mac.relay, macKey: mac.key, token });
  await tampered.find((frame) => frame.params?.type === "gateway.ready");
  tampered.sendRaw(randomBytes(40));
  assert.equal((await tampered.closed).code, TunnelRefused.broken);

  const removed = await TunnelDevice.open({ relay: relay.url, relayID: mac.relay, macKey: mac.key, token });
  await removed.find((frame) => frame.params?.type === "gateway.ready");
  await toBridge.call("net.remove", { member: "phone-tunnel-0003" });
  assert.deepEqual(await removed.closed, { code: 4401, reason: "This device was removed from the net." });
  assert.deepEqual(removed.frames.at(-1), { refused: "removed", message: "This device was removed from the net." }, "told sealed, before the close");
  const again = await TunnelDevice.open({ relay: relay.url, relayID: mac.relay, macKey: mac.key, token });
  assert.equal((await again.closed).code, 4401, "and is kept out");
  assert.deepEqual(again.frames, [{ refused: "token", message: "The token was not accepted." }]);
});

test("a device's request over 16 MiB through the relay is answered with an error for it, and the tunnel goes on", async () => {
  const token = await joinDevice("phone-tunnel-0005");
  const device = await TunnelDevice.open({ relay: relay.url, relayID: mac.relay, macKey: mac.key, token });
  await device.find((frame) => frame.params?.type === "gateway.ready");
  await assert.rejects(device.call("file.attach_bytes", { name: "big.bin", data: "A".repeat(mostFrameBytes + 1024) }), /request is over 16 MiB, too large to send through the relay/);
  assert.equal((await device.call("net.list")).you, "phone-tunnel-0005", "the tunnel is still open");
  await device.close();
});

test("the bridge's standby socket comes back after the relay drops it, and devices reach the bridge again", async () => {
  const before = relay.asked.filter((leg) => leg === "mac").length;
  relay.dropAll();
  await eventually(() => relay.asked.filter((leg) => leg === "mac").length > before && relay.open(mac.relay, "mac").length === 1, "the standby socket is open again");
  const token = await joinDevice("phone-tunnel-0004");
  const device = await TunnelDevice.open({ relay: relay.url, relayID: mac.relay, macKey: mac.key, token });
  await device.find((frame) => frame.params?.type === "gateway.ready");
  await device.close();
});

test("a second bridge with this Mac's relay id (a copy of its folder) leaves the first its standby socket: it says so in gateway.ready and does not try again every second", async () => {
  const copy = mkdtempSync(join(tmpdir(), "portals-copied-bridge-"));
  cpSync(bridge.home, copy, { recursive: true });
  const asked = () => relay.asked.filter((leg) => leg === "mac").length;
  const before = asked();
  const holder = relay.open(mac.relay, "mac")[0];
  const second = await startTestBridge({ home: copy });
  try {
    await eventually(() => asked() > before, "the copy asked for the standby socket");
    await sleep(100);
    // The first keeps it, and devices still reach the first.
    assert.deepEqual(relay.open(mac.relay, "mac"), [holder]);
    const copied = await TestClient.open(second);
    assert.equal(copied.readyPayload.bridge.relay_problem, "in_use");
    await copied.close();
    const first = await TestClient.open(bridge);
    assert.equal(first.readyPayload.bridge.relay_problem, undefined);
    await first.close();
    // No asking again a second later, as after a relay that went away: five minutes later.
    const count = asked();
    await sleep(1500);
    assert.equal(asked(), count);
    assert.deepEqual(relay.open(mac.relay, "mac"), [holder]);
  } finally {
    await second.dispose();
    rmSync(copy, { recursive: true, force: true });
  }
});

test("the relay's object keeps the Mac's relay id for its secret: another secret is refused", async () => {
  const response = await new Promise<number>((resolve) => {
    const socket = new WebSocket(`${relay.url.replace(/^http/, "ws")}/v1/tunnel/${mac.relay}/mac`, { headers: { Authorization: `Bearer ${randomBytes(32).toString("base64url")}` } });
    socket.on("unexpected-response", (_request, answer) => resolve(answer.statusCode ?? 0));
    socket.on("error", () => undefined);
  });
  assert.equal(response, 401);
});
