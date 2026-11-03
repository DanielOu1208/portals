import "./environment.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { counters } from "../src/counters.ts";
import { Fleet } from "../src/fleet/fleet.ts";
import { Links, writeLinks } from "../src/fleet/links.ts";
import { fleetOrder } from "../src/fleet/order.ts";
import { Folders } from "../src/folders.ts";
import { log } from "../src/log.ts";
import type { Provider } from "../src/providers/types.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { Registry } from "../src/sessions/registry.ts";

async function setup(t: TestContext, auth: "token" | "password") {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  const control = { phase: "warm" };
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const row = { id: "a", agent: "fake", agent_name: "Fake", folder: "/private/folder", title: "private-title-do-not-log", state: "idle", updated: 1 };
  sockets.on("connection", (peer) => {
    peer.send(JSON.stringify({ method: "event", params: { type: "gateway.ready", payload: { bridge: { features: ["fleet_delta", "fleet_delta_positions"] } } } }));
    peer.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push({ method: request.method, params: request.params });
      if (control.phase === "hangup") { peer.terminate(); return; }
      const base = { epoch: "one", list: { id: "list", revision: 1 }, threads: [], positions: [], removed: [], active: [], order: fleetOrder(["a"]) };
      const result = request.method === "profiles.list" ? { profiles: [] }
        : control.phase === "warm" || control.phase === "fresh" ? { ...base, full: true, threads: [row], positions: [0] }
        : control.phase === "digest" ? { ...base, order: fleetOrder(["wrong"]) }
        : control.phase === "position" ? { ...base, threads: [row], positions: [4] }
        : control.phase === "active" ? { ...base, active: [{ id: "unknown", state: "working" }] }
        : { ...base, threads: [row, null], positions: [0, 1] };
      peer.send(JSON.stringify({ id: request.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = join(realpathSync("/tmp"), "portals-bridge-review");
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, "fleet-failure-"));
  const path = join(home, "links.json");
  writeLinks(path, [{ name: "far-work", url, user: "scratch", password: "scratch" }]);
  t.mock.method(globalThis, "fetch", async (input: unknown) => String(input).endsWith("password-login")
    ? new Response("{}", { headers: { "set-cookie": "scratch=one; HttpOnly" } })
    : new Response(JSON.stringify({ ticket: "scratch" })));
  const fleets: { fleet: Fleet; sessions: SessionManager }[] = [];
  const make = () => {
    const providers = new Map<string, Provider>();
    const registry = new Registry(join(home, `threads-${fleets.length}.json`));
    registry.add({ id: "local", agent: "fake", cwd: home, title: "Local", model: "", provider: "", reasoningEffort: "", origin: "phone", createdAt: 1, updatedAt: 1 });
    const sessions = new SessionManager({ registry, providers });
    const links = new Links(path, auth === "token" ? { macs: () => [{ name: "far-work", url }], token: () => "scratch" } : undefined);
    const fleet = new Fleet({ sessions, providers, links, folders: new Folders({ general: home, hide: [], own: [], sources: [] }), here: { id: "0123456789abcdef", name: "Near" } });
    fleets.push({ fleet, sessions });
    return { fleet, links };
  };
  t.after(async () => {
    for (const { fleet, sessions } of fleets) { fleet.close(); await sessions.close(); }
    for (const peer of sockets.clients) peer.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  return { control, requests, home, make };
}

for (const auth of ["token", "password"] as const) {
  for (const reason of ["digest", "position", "schema", "active"] as const) {
    test(`${auth}: invalid ${reason} is byte-identical to a real hung-up Mac, without stale rows or payload diagnostics`, async (t) => {
      const { control, requests, home, make } = await setup(t, auth);
      control.phase = "hangup";
      const baseline = await make().fleet.everyThread({ state: "idle" });
      assert.equal(baseline.machines?.[0].error, "Could not reach far-work: it hung up before answering.");
      control.phase = "warm";
      const { fleet, links } = make();
      assert.equal((await fleet.everyThread()).threads.length, 2);

      const config = join(home, "counters.json"), file = join(home, "counters.log");
      writeFileSync(config, JSON.stringify({ counters: { enabled: true } }));
      assert.equal(counters.start({ config, file, seconds: 3600, ps: "/usr/bin/true" }), true);
      const diagnostics: unknown[] = [];
      t.mock.method(log, "warn", (message: string, fields?: Record<string, unknown>) => { diagnostics.push({ message, fields }); });
      try {
        control.phase = reason;
        const actual = await fleet.everyThread();
        assert.equal(JSON.stringify(actual), JSON.stringify(baseline));
        assert.equal(requests.at(-1)?.method, "threads.delta", "there was no repair RPC");
        const count = requests.length;
        assert.equal(JSON.stringify(await fleet.everyThread()), JSON.stringify(baseline));
        assert.equal(requests.length, count, "existing failed-list backoff is preserved");
      } finally {
        counters.stop();
      }
      const recorded = readFileSync(file, "utf8");
      const key = reason === "active" ? "schema" : reason;
      const lines = recorded.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(lines.reduce((n, line) => n + (line.fleet_rejected?.[key] ?? 0), 0), 1);
      assert.deepEqual(diagnostics, [{ message: "Discarded an invalid linked-Mac list.", fields: { reason: key } }]);
      for (const forbidden of ["private-title-do-not-log", "/private/folder", home, "far-work"]) {
        assert.equal(recorded.includes(forbidden), false);
        assert.equal(JSON.stringify(diagnostics).includes(forbidden), false);
      }
      control.phase = "fresh";
      await links.call("far-work", "profiles.list", {});
      assert.equal((await fleet.everyThread()).threads.length, 2);
      assert.deepEqual(requests.at(-1)?.params, {}, "the rejected base and cursor were discarded");
    });
  }
}
