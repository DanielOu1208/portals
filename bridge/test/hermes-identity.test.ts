import "./environment.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { proves } from "../src/providers/hermes/serve.ts";

async function listen(t: TestContext, server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return (server.address() as AddressInfo).port;
}

test("Hermes's identity probe never sends its token to a redirect destination", async (t) => {
  const forwarded: unknown[] = [];
  const destination = await listen(t, createServer((request, response) => {
    forwarded.push(request.headers["x-hermes-token"]);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ role: "serve", pid: process.pid }));
  }));
  const recorded = await listen(t, createServer((_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${destination}/api/host/identity` });
    response.end();
  }));
  const accepted = await proves({ host: "127.0.0.1", port: recorded, token: "stand-in-token", pid: process.pid });
  assert.equal(forwarded.length, 0, "a redirect destination must receive no request or token");
  assert.equal(accepted, false, "only the recorded endpoint can prove its identity");
});
