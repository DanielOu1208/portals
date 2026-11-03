import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { version } from "../src/version.ts";
import { closeCode, createThread, mintTicket, password, runTurn, sessionCookie, signIn, socketURL, startTestBridge, TestClient, username, type TestBridge } from "./helpers.ts";

// Sign-in, tickets and the WebSocket upgrade, as the app does them
// (docs/gateway-protocol.md, section 2).

let bridge: TestBridge;

before(async () => {
  bridge = await startTestBridge();
});

after(() => bridge.dispose());

/** A raw HTTP request, so the Host header can be anything. */
function rawGet(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port: bridge.port, path, headers: { Host: host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("the status route answers without signing in", async () => {
  const response = await fetch(`${bridge.url}/api/status`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", service: "portals-bridge", version });
});

test("signing in with the right password sets a session cookie", async () => {
  const response = await signIn(bridge);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^aeriportal_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
});

test("a wrong user name or password is 401", async () => {
  assert.equal((await signIn(bridge, { username, password: "wrong" })).status, 401);
  assert.equal((await signIn(bridge, { username: "someone", password })).status, 401);
  const garbage = await fetch(`${bridge.url}/auth/password-login`, { method: "POST", body: "not json" });
  assert.equal(garbage.status, 401);
});

test("a ticket needs a session, and comes with its lifetime", async () => {
  const without = await fetch(`${bridge.url}/api/auth/ws-ticket`, { method: "POST", body: "{}" });
  assert.equal(without.status, 401);
  const forged = await fetch(`${bridge.url}/api/auth/ws-ticket`, { method: "POST", body: "{}", headers: { Cookie: "aeriportal_session=abc" } });
  assert.equal(forged.status, 401);

  const cookie = await sessionCookie(bridge);
  const response = await fetch(`${bridge.url}/api/auth/ws-ticket`, { method: "POST", body: "{}", headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ticket: string; ttl_seconds: number };
  assert.ok(body.ticket.length >= 20);
  assert.equal(body.ttl_seconds, 30);
});

test("a ticket opens one WebSocket, which starts with gateway.ready", async () => {
  const ticket = await mintTicket(bridge);
  const socket = new WebSocket(socketURL(bridge, `?ticket=${ticket}`));
  const first = await new Promise<string>((resolve) => socket.once("message", (data) => resolve(data.toString())));
  assert.equal(JSON.parse(first).params.type, "gateway.ready");
  socket.close();

  // The same ticket again is refused with 4401, after the upgrade, so the app reads the code.
  const again = new WebSocket(socketURL(bridge, `?ticket=${ticket}`));
  assert.equal(await closeCode(again), 4401);
});

test("a missing or made-up ticket closes with 4401, and a token is not a ticket", async () => {
  for (const query of ["", "?ticket=", "?ticket=made-up", "?token=anything"]) {
    const socket = new WebSocket(socketURL(bridge, query));
    assert.equal(await closeCode(socket), 4401, query);
  }
});

test("a host name that is not allowed is refused: 403 over HTTP, 4403 on the WebSocket", async () => {
  assert.equal(await rawGet("/api/status", "evil.example"), 403);
  assert.equal(await rawGet("/api/status", `localhost:${bridge.port}`), 200);
  assert.equal(await rawGet("/api/status", `[::1]:${bridge.port}`), 200);

  const ticket = await mintTicket(bridge);
  const socket = new WebSocket(socketURL(bridge, `?ticket=${ticket}`), { headers: { Host: "evil.example" } });
  assert.equal(await closeCode(socket), 4403);
});

test("a WebSocket from a web page on another site is refused with 4403", async () => {
  const ticket = await mintTicket(bridge);
  const socket = new WebSocket(socketURL(bridge, `?ticket=${ticket}`), { origin: "https://evil.example" });
  assert.equal(await closeCode(socket), 4403);
});

/** The messages in what the bridge sent down a socket after the upgrade: whether each was compressed, and its bytes. */
function framesIn(bytes: Buffer): { compressed: boolean; bytes: number }[] {
  const frames: { compressed: boolean; bytes: number }[] = [];
  let at = 0;
  while (at + 2 <= bytes.length) {
    let length = bytes[at + 1] & 0x7f;
    let header = 2;
    if (length === 126) {
      length = bytes.readUInt16BE(at + 2);
      header = 4;
    } else if (length === 127) {
      length = Number(bytes.readBigUInt64BE(at + 2));
      header = 10;
    }
    // The bridge's frames are not masked; RSV1 marks a compressed one. Pings and the close are left out.
    if ((bytes[at] & 0x0f) < 8) frames.push({ compressed: (bytes[at] & 0x40) !== 0, bytes: length });
    at += header + length;
  }
  return frames;
}

test("a device that offers compression, as the app does, is sent frames of 1 KB or more compressed, each on its own, and smaller ones as they are; one that does not, all as they are", async (t) => {
  // A thread with the scripted agent's long reply in it, whose resume is about 20 KB of text.
  const owner = await TestClient.open(bridge);
  t.after(() => owner.close());
  const session = await createThread(owner);
  await runTurn(owner, session, "bench instant");

  for (const offers of [true, false]) {
    const ticket = await mintTicket(bridge);
    const wire: Buffer[] = [];
    const socket = new WebSocket(socketURL(bridge, `?ticket=${ticket}`), {
      perMessageDeflate: offers,
      createConnection: () => connect({ host: "127.0.0.1", port: bridge.port }).on("data", (chunk) => wire.push(chunk)),
    });
    let agreed: string | undefined;
    socket.once("upgrade", (response) => (agreed = response.headers["sec-websocket-extensions"]));
    const messages: Buffer[] = [];
    socket.on("message", (data: Buffer) => messages.push(data));
    const answered = (id: string) => new Promise<void>((done) => socket.on("message", (data: Buffer) => JSON.parse(data.toString()).id === id && done()));
    await new Promise((done) => socket.once("open", done));
    assert.equal(agreed, offers ? "permessage-deflate; server_no_context_takeover" : undefined);

    let waiting = answered("resume");
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: "resume", method: "session.resume", params: { session_id: session, profile: "fake" } }));
    await waiting;
    waiting = answered("ping");
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: "ping", method: "gateway.ping", params: {} }));
    await waiting;
    socket.close();

    // What came with the upgrade's answer is read again once ws takes over the socket.
    const frames = framesIn(Buffer.concat(wire.slice(wire.findIndex((chunk) => chunk.includes("\r\n\r\n")) + 1)));
    assert.equal(frames.length, messages.length);
    assert.ok(messages.some((message) => message.length > 15_000));
    for (const [index, message] of messages.entries()) {
      assert.equal(frames[index].compressed, offers && message.length >= 1024, `frame ${index}: ${message.length} bytes`);
      // Compressed, the long conversation is a fraction of its size, and any frame smaller
      // than it was. (gateway.ready is just over 1 KB with a long host name, as on a Mac on
      // a campus network, and halves less.)
      if (frames[index].compressed) {
        assert.ok(frames[index].bytes < message.length / (message.length > 15_000 ? 2 : 1), `frame ${index}: ${frames[index].bytes} bytes for ${message.length}`);
      }
      else assert.equal(frames[index].bytes, message.length);
    }
  }
});

test("other paths are 404", async () => {
  assert.equal((await fetch(`${bridge.url}/`)).status, 404);
  assert.equal((await fetch(`${bridge.url}/api/sessions`)).status, 404);
  const socket = new WebSocket(`${bridge.url.replace("http", "ws")}/elsewhere`);
  const failed = await new Promise<string>((resolve) => socket.once("error", (error) => resolve(error.message)));
  assert.match(failed, /404/);
});

test("without a password set up, sign-in answers 404", async (t) => {
  const open = await startTestBridge({ config: { auth: null } });
  t.after(() => open.dispose());
  assert.equal((await signIn(open)).status, 404);
});

test("too many failed sign-ins are answered with 429", async (t) => {
  const limited = await startTestBridge();
  t.after(() => limited.dispose());
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await signIn(limited, { username, password: "nope" })).status, 401);
  }
  assert.equal((await signIn(limited)).status, 429);
});
