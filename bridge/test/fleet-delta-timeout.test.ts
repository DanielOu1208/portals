import "./environment.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { Links, writeLinks } from "../src/fleet/links.ts";
import { fleetOrder } from "../src/fleet/order.ts";
import { RemoteThreads } from "../src/fleet/remoteThreads.ts";
import { RpcError } from "../src/gateway/errors.ts";

for (const auth of ["token", "password"]) {
  test(`${auth}: full delta timeout has exactly the legacy full-list error and backoff`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
    let phase = "baseline";
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    const row = { id: "a", agent: "fake", agent_name: "Fake", folder: "/w", state: "idle", updated: 1 };
    sockets.on("connection", (peer) => {
      peer.send(JSON.stringify({ method: "event", params: { type: "gateway.ready", payload: { bridge: { features: ["fleet_delta", "fleet_delta_positions"] } } } }));
      peer.on("message", (data) => {
        const request = JSON.parse(data.toString());
        if (request.method === "profiles.list") {
          peer.send(JSON.stringify({ id: "c1", result: { profiles: [] } }));
        } else if (request.method === "threads.delta") {
          if (phase === "timeout") { t.mock.timers.tick(8000); return; }
          peer.send(JSON.stringify({ id: "c1", result: {
            epoch: "one", list: { id: "list", revision: 1 },
            threads: [row], positions: [0], removed: [], active: [],
            order: fleetOrder(["a"]), full: true,
          } }));
        } else {
          assert.equal(request.method, "threads.list");
          t.mock.timers.tick(8000);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const root = join(realpathSync("/tmp"), "portals-bridge-review");
    mkdirSync(root, { recursive: true });
    const home = mkdtempSync(join(root, "fleet-delta-timeout-"));
    t.after(async () => {
      for (const peer of sockets.clients) peer.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    });
    t.mock.method(globalThis, "fetch", async (input: unknown) => {
      const route = String(input);
      t.mock.timers.tick(700);
      return route.endsWith("password-login")
        ? new Response("{}", { headers: { "set-cookie": "scratch=one; HttpOnly" } })
        : new Response(JSON.stringify({ ticket: "scratch" }));
    });
    const path = join(home, "links.json");
    writeLinks(path, [{ name: "far", url, user: "scratch", password: "scratch" }]);
    const makeLinks = () => new Links(path, auth === "token"
      ? { macs: () => [{ name: "far", url }], token: () => "scratch" } : undefined);
    const failure = async (action: () => Promise<unknown>) => {
      try { await action(); assert.fail("expected a timeout"); } catch (error) {
        assert.ok(error instanceof RpcError);
        return { code: error.code, message: error.message };
      }
    };
    const legacy = makeLinks();
    // Match the session-cookie state of an already warmed fleet cache.
    await legacy.call("far", "profiles.list", {}, 8000);
    const expected = await failure(() => legacy.call("far", "threads.list", { local: true }, 8000, { glance: true }));
    assert.equal(expected.message, `Could not reach far: The bridge did not answer within ${auth === "token" ? 8 : 7} seconds.`);
    phase = "warm";
    const links = makeLinks(), cache = new RemoteThreads(links);
    t.after(() => cache.close());
    const link = links.all()[0];
    await cache.list(link);
    phase = "timeout";
    const actual = await failure(() => cache.list(link));
    assert.deepEqual(actual, expected);
    assert.deepEqual(await failure(() => cache.list(link)), expected, "listing backoff retains the same public error");
  });
}
