import "./environment.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { callLink } from "../src/fleet/links.ts";

/**
 * The first byte of each WebSocket frame in `bytes` (FIN, RSV1 and the opcode): 0x81 a
 * text frame as it is, 0xC1 one compressed (RSV1). `http` skips the server's 101 answer.
 */
function frameHeads(bytes: Buffer, http: boolean): number[] {
  let at = http ? bytes.indexOf("\r\n\r\n") + 4 : 0;
  const heads: number[] = [];
  while (at + 2 <= bytes.length) {
    const head = bytes[at];
    const masked = (bytes[at + 1] & 0x80) !== 0;
    let length = bytes[at + 1] & 0x7f;
    at += 2;
    if (length === 126) { length = bytes.readUInt16BE(at); at += 2; }
    else if (length === 127) { length = Number(bytes.readBigUInt64BE(at)); at += 8; }
    at += (masked ? 4 : 0) + length;
    if (at > bytes.length) break;
    heads.push(head);
  }
  return heads;
}

for (const accepts of [false, true]) {
  for (const auth of ["password", "token"]) {
    for (const large of [false, true]) {
      for (const largeRequest of [false, true]) {
        test(`fleet ${auth} call keeps exact JSON with ${accepts ? "compressed" : "legacy uncompressed"} ${large ? "large" : "small"} reply and ${largeRequest ? "large" : "small"} request`, async (t) => {
          const server = createServer((request, response) => {
            request.resume();
            response.setHeader("content-type", "application/json");
            if (request.url === "/auth/password-login") {
              response.setHeader("set-cookie", "scratch=one; HttpOnly");
              response.end("{}");
            } else {
              assert.equal(request.url, "/api/auth/ws-ticket");
              assert.equal(request.headers.cookie, "scratch=one");
              response.end(JSON.stringify({ ticket: "scratch-ticket" }));
            }
          });
          const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: accepts ? { threshold: 1024, serverNoContextTakeover: true } : false });
          const offers: string[] = [];
          const negotiated: string[] = [];
          const received: string[] = [];
          const inbound: Buffer[] = [];
          const outbound: Buffer[] = [];
          server.on("upgrade", (request, socket, head) => {
            offers.push(String(request.headers["sec-websocket-extensions"]));
            if (auth === "token") assert.equal(request.headers.authorization, "Bearer scratch-token");
            else assert.equal(request.url, "/api/ws?ticket=scratch-ticket");
            socket.on("data", (data: Buffer) => inbound.push(data));
            // Everything the server writes, its 101 answer and then its frames, as it goes out.
            const write = socket.write.bind(socket) as (chunk: unknown, ...rest: unknown[]) => boolean;
            socket.write = ((chunk: unknown, ...rest: unknown[]) => {
              outbound.push(Buffer.from(chunk as Buffer));
              return write(chunk, ...rest);
            }) as typeof socket.write;
            sockets.handleUpgrade(request, socket, head, (peer) => sockets.emit("connection", peer));
          });
          const result = { threads: [{ id: "one", title: large ? "A realistic title repeated. ".repeat(2000) : "One", state: "idle" }] };
          sockets.on("connection", (peer) => {
            negotiated.push(peer.extensions);
            peer.send(JSON.stringify({ method: "event", params: { type: "gateway.ready" } }));
            peer.on("message", (data) => {
              received.push(data.toString());
              peer.send(JSON.stringify({ jsonrpc: "2.0", id: "c1", result }));
            });
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          t.after(async () => {
            await new Promise<void>((resolve) => sockets.close(() => resolve()));
            await new Promise<void>((resolve) => server.close(() => resolve()));
          });
          const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
          const link = auth === "token" ? { name: "peer", url, token: "scratch-token" } : { name: "peer", url, user: "scratch", password: "scratch" };
          const params = largeRequest ? { local: true, text: "A long message passed on to another Mac. ".repeat(100) } : { local: true };
          const answer = await callLink(link, "threads.list", params, 8000);
          assert.equal(JSON.stringify(answer), JSON.stringify(result));
          assert.deepEqual(received, [JSON.stringify({ jsonrpc: "2.0", id: "c1", method: "threads.list", params })]);
          assert.equal(offers.length, 1);
          assert.match(offers[0], /permessage-deflate/);
          assert.match(offers[0], /client_no_context_takeover/);
          assert.match(offers[0], /server_no_context_takeover/);
          assert.deepEqual(negotiated, [accepts ? "permessage-deflate" : ""]);
          // The request goes compressed only at 1 KB or more, on a connection that took it.
          assert.equal(frameHeads(Buffer.concat(inbound), false)[0], accepts && largeRequest ? 0xc1 : 0x81);
          // The small ready event goes as it is; the answer compressed only when large and taken.
          assert.deepEqual(frameHeads(Buffer.concat(outbound), true).slice(0, 2), [0x81, accepts && large ? 0xc1 : 0x81]);
        });
      }
    }
  }
}
