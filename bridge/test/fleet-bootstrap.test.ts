import "./environment.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { Fleet, type FleetDelta, type ThreadSummary } from "../src/fleet/fleet.ts";
import { Links, type LinkCallOptions, writeLinks } from "../src/fleet/links.ts";
import { fleetOrder } from "../src/fleet/order.ts";
import { FleetPages, type FleetCursor } from "../src/fleet/pages.ts";
import { Folders } from "../src/folders.ts";
import type { Provider } from "../src/providers/types.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { Registry } from "../src/sessions/registry.ts";

async function until(condition: () => boolean): Promise<void> {
  const end = performance.now() + 1500;
  while (!condition() && performance.now() < end) await setImmediate();
  assert.ok(condition(), "expected transport progress before the test's bounded wait");
}
const row = (id: string): ThreadSummary => ({
  id, agent: "fake", agent_name: "Fake", folder: "/w", state: "idle", updated: 1, title: "title-".repeat(30),
});

async function setup(t: TestContext, auth: "token" | "password" = "token", features = ["fleet_delta_positions", "fleet_pages"]) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  const home = mkdtempSync(join(tmpdir(), "portals-fleet-boot-"));
  const source = {
    epoch: "run", list: { id: "list", revision: 1 }, rows: Array.from({ length: 500 }, (_, i) => row(`t${i}`)),
    versions: new Map<string, number>(), removed: new Map<string, number>(),
    active: [] as FleetDelta["active"],
  };
  const delta = (cursor?: FleetCursor): FleetDelta => {
    const valid = cursor && cursor.epoch === source.epoch && cursor.list === source.list.id;
    const threads = valid ? source.rows.filter((row) => (source.versions.get(row.id) ?? 1) > cursor.since) : source.rows;
    const slots = new Map(source.rows.map((row, i) => [row.id, i]));
    return {
      epoch: source.epoch, list: { ...source.list }, threads, ...(valid ? { positions: threads.map((row) => slots.get(row.id)!) } : {}),
      removed: valid ? [...source.removed].filter(([id, revision]) => revision > cursor.since && !slots.has(id)).map(([id]) => id) : [],
      active: source.active, order: fleetOrder(source.rows.map((row) => row.id)), ...(!valid ? { full: true as const } : {}),
    };
  };
  const store = new FleetPages(() => ({ epoch: source.epoch, list: source.list }), delta);
  const control = {
    fullTimeout: true, incrementalTimeout: false, hold: false, holdFull: false, pagesPerExchange: Infinity,
    corruptPage: false, pageFault: "", corruptFull: false, refused: false, hangup: false,
  };
  const requests: { method: string; params: Record<string, unknown> }[] = [], pending: (() => void)[] = [];
  const server = createServer(), sockets = new WebSocketServer({ server });
  sockets.on("connection", (peer) => {
    let pages = 0;
    peer.send(JSON.stringify({ method: "event", params: { type: "gateway.ready", payload: { bridge: { features } } } }));
    peer.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      requests.push({ method: request.method, params: request.params });
      if (request.method === "profiles.list") { peer.send(JSON.stringify({ id: request.id, result: { profiles: [] } })); return; }
      if (control.hangup) { peer.terminate(); return; }
      if ((control.fullTimeout && request.params.since === undefined && request.method !== "threads.page") || (control.incrementalTimeout && request.method === "threads.delta")) {
        control.fullTimeout = false;
        t.mock.timers.tick(8000);
        return;
      }
      let result: unknown;
      if (request.method === "threads.page") {
        if (pages++ >= control.pagesPerExchange) { t.mock.timers.tick(8000); return; }
        result = store.page(request.params);
        if (control.corruptPage && result && typeof result === "object" && "threads" in result) {
          result = { ...result, threads: [...(result as { threads: unknown[] }).threads, null] };
        }
        if (result && typeof result === "object" && "snapshot" in result) {
          const given = result as import("../src/fleet/pages.ts").FleetPage;
          if (control.pageFault === "offset") result = { ...given, offset: given.offset + 1 };
          if (control.pageFault === "identity") result = { ...given, snapshot: "different-snapshot" };
          if (control.pageFault === "digest") result = { ...given, order: { ...given.order, digest: "different" } };
          if (control.pageFault === "position") result = { ...given, positions: given.positions.map(() => 0) };
          if (control.pageFault === "metadata") result = { ...given, snapshot: "s".repeat(12_000) };
        }
      } else if (request.method === "threads.delta") {
        result = delta(request.params.since === undefined ? undefined : request.params);
        if (control.corruptFull) result = { ...result as FleetDelta, threads: [null] };
      } else {
        assert.equal(request.method, "threads.list");
        result = { threads: truth() };
      }
      const send = () => peer.send(JSON.stringify({ id: request.id, result }));
      if ((control.hold && request.method === "threads.page")
        || (control.holdFull && request.method === "threads.delta" && request.params.since === undefined)) pending.push(send);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`, path = join(home, "links.json");
  writeLinks(path, [{ name: "far", url, user: "scratch", password: "scratch" }]);
  t.mock.method(globalThis, "fetch", async (input: unknown) => control.refused ? new Response("{}", { status: 401 })
    : String(input).endsWith("password-login") ? new Response("{}", { headers: { "set-cookie": "scratch=one; HttpOnly" } })
    : new Response(JSON.stringify({ ticket: "scratch" })));
  const links = new Links(path, auth === "token" ? { macs: () => [{ name: "far", url }], token: () => "scratch" } : undefined);
  const calls: Promise<unknown>[] = [], original = links.call.bind(links);
  t.mock.method(links, "call", (name: string, method: string, params: Record<string, unknown>, timeout?: number, options?: LinkCallOptions) => {
    const promise = original(name, method, params, timeout, options);
    calls.push(promise); void promise.catch(() => undefined);
    return promise;
  });
  const providers = new Map<string, Provider>(), registry = new Registry(join(home, "threads.json"));
  registry.add({ id: "local", agent: "fake", cwd: home, title: "Local", model: "", provider: "", reasoningEffort: "", origin: "phone", createdAt: 1, updatedAt: 1 });
  const sessions = new SessionManager({ registry, providers });
  const fleet = new Fleet({ sessions, providers, links, folders: new Folders({ general: home, hide: [], own: [], sources: [] }), here: { id: "0123456789abcdef", name: "Near" } });
  function truth(): ThreadSummary[] {
    const active = new Map(source.active.map((live) => [live.id, live]));
    return source.rows.map((row): ThreadSummary => ({
      id: row.id, agent: row.agent, agent_name: row.agent_name, folder: row.folder,
      state: active.get(row.id)?.state ?? "idle", ...(active.get(row.id)?.kind ? { kind: active.get(row.id)!.kind } : {}),
      updated: row.updated, ...(row.title ? { title: row.title } : {}), ...(row.read_only ? { read_only: true } : {}),
    })).sort((a, b) => b.updated - a.updated);
  }
  t.after(async () => {
    fleet.close(); store.close(); await sessions.close();
    for (const peer of sockets.clients) peer.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  const drain = async () => { await Promise.allSettled(calls); await setImmediate(); };
  return { source, store, control, requests, pending, links, calls, features, drain, list: () => fleet.everyThread(), truth };
}

for (const auth of ["token", "password"] as const) {
  test(`${auth}: backoff answers remain immediate and start only one detached paging exchange, sealed fresh before publication`, async (t) => {
    const { source, control, calls, requests, pending, list, truth } = await setup(t, auth);
    const first = await list();
    assert.equal(first.threads.length, 1);
    assert.equal(first.machines?.[0].error, "Could not reach far: The bridge did not answer within 8 seconds.");
    control.hold = true;
    const started = performance.now();
    assert.deepEqual(await list(), first);
    assert.ok(performance.now() - started < 50, "backoff never waits for the detached socket");
    await until(() => pending.length === 1);
    assert.deepEqual(await list(), first);
    assert.equal(calls.length, 2, "a second refresh does not launch another detached exchange");
    source.rows[0].title = "new title after frozen first page";
    source.versions.set("t0", ++source.list.revision);
    source.rows.splice(1, 1); source.removed.set("t1", ++source.list.revision);
    source.rows.push(row("t1")); source.versions.set("t1", ++source.list.revision);
    source.active = [{ id: "t0", state: "blocked", kind: "question" }];
    control.hold = false;
    pending.shift()!();
    await Promise.allSettled(calls);
    const final = await list();
    assert.equal(final.machines?.[0].reachable, true);
    const remote = final.threads.filter((row) => row.machine);
    assert.equal(JSON.stringify(remote), JSON.stringify(truth().map((row) => ({ ...row, id: `far/${row.id}`, machine: "far" }))));
    assert.ok(requests.some((request) => request.method === "threads.page"));
    assert.equal(requests.at(-1)?.method, "threads.delta");
  });
}

test("combined base and pending metadata are bounded without changing immediate backoff or valid full answers", async (t) => {
  const { source, control, requests, drain, list, truth } = await setup(t);
  for (const row of source.rows) row.title = "t".repeat(16_500);
  const first = await list();
  control.incrementalTimeout = true;
  assert.deepEqual(await list(), first);
  await drain();
  assert.ok(requests.filter((request) => request.method === "threads.page").length >= 500);
  control.pageFault = "metadata";
  assert.deepEqual(await list(), first);
  await drain();
  assert.equal(requests.at(-1)?.method, "threads.page", "oversized combined state is discarded before a seal is attempted");
  control.incrementalTimeout = false;
  t.mock.timers.tick(30_001);
  const fresh = await list();
  assert.deepEqual(requests.at(-1)?.params, {}, "discarded metadata is not retained as a delta base");
  assert.equal(fresh.machines?.[0].reachable, true);
  assert.equal(JSON.stringify(fresh.threads.filter((row) => row.machine)), JSON.stringify(truth().map((row) => ({ ...row, id: `far/${row.id}`, machine: "far" }))));
});

test("a peer without paging keeps the exact immediate full-fetch backoff and opens no detached socket", async (t) => {
  const { calls, requests, list } = await setup(t, "token", ["fleet_delta_positions"]);
  const first = await list();
  assert.deepEqual(await list(), first);
  assert.deepEqual(await list(), first);
  assert.equal(calls.length, 3);
  assert.deepEqual(requests.map((request) => request.method), ["threads.delta"]);
});

test("an incremental timeout does not activate bootstrap paging", async (t) => {
  const { control, requests, list } = await setup(t);
  control.fullTimeout = false;
  assert.equal((await list()).threads.length, 501);
  control.incrementalTimeout = true;
  const failed = await list();
  assert.equal(failed.threads.length, 1);
  assert.deepEqual(await list(), failed);
  assert.equal(requests.some((request) => request.method === "threads.page"), false);
});

test("complete pages survive successive deadlines for over a minute, with no partial app rows and idle expiry refreshed by progress", async (t) => {
  const { control, requests, drain, list, truth } = await setup(t);
  control.pagesPerExchange = 1;
  let given = await list(), windows = 0;
  const started = Date.now();
  while (!given.machines?.[0].reachable && windows++ < 10) {
    assert.equal(given.threads.length, 1);
    if (windows > 1) t.mock.timers.tick(40_000);
    given = await list();
    await drain();
  }
  assert.ok(given.machines?.[0].reachable);
  assert.ok(Date.now() - started > 60_000);
  assert.equal(given.threads.length, truth().length + 1);
  assert.equal(requests.filter((request) => request.method === "threads.page" && request.params.snapshot === undefined).length, 1,
    "progress did not restart from an old first-failure expiry");
});

test("a far restart or expired token discards all historical pages before a new complete seal", async (t) => {
  const { source, store, control, requests, drain, list } = await setup(t);
  await list();
  control.pagesPerExchange = 1;
  await list(); await drain();
  const oldToken = requests.find((request) => request.method === "threads.page" && request.params.snapshot)?.params.snapshot;
  assert.ok(oldToken);
  store.close(); source.epoch = "new-runtime";
  source.rows = [row("new-only")];
  control.pagesPerExchange = Infinity;
  await list(); await drain();
  const final = await list();
  assert.deepEqual(final.threads.filter((row) => row.machine).map((row) => row.id), ["far/new-only"]);
  assert.equal(requests.filter((request) => request.method === "threads.page" && request.params.snapshot === undefined).length, 2);
});

test("a malformed late page drops every staged row, uses the standard hung-up error, and cannot be resumed", async (t) => {
  const { control, requests, links, drain, list } = await setup(t);
  await list(); control.pagesPerExchange = 1;
  await list(); await drain();
  control.corruptPage = true; control.pagesPerExchange = Infinity;
  await list(); await drain();
  const failed = await list();
  assert.equal(failed.threads.length, 1);
  assert.equal(failed.machines?.[0].error, "Could not reach far: it hung up before answering.");
  const count = requests.length;
  assert.deepEqual(await list(), failed);
  assert.equal(requests.length, count, "corruption never starts another detached exchange");
  control.corruptPage = false;
  await links.call("far", "profiles.list", {});
  assert.equal((await list()).machines?.[0].reachable, true);
  assert.deepEqual(requests.at(-1)?.params, {});
});

test("idle expiry aborts a held detached page and its late reply cannot resurrect staging", async (t) => {
  const { control, pending, requests, links, drain, list } = await setup(t);
  await list(); control.hold = true;
  await list(); await until(() => pending.length === 1);
  t.mock.timers.tick(60_001);
  await drain();
  control.hold = false;
  pending.shift()!();
  await links.call("far", "profiles.list", {});
  const final = await list();
  assert.equal(final.machines?.[0].reachable, true);
  assert.equal(requests.at(-1)?.method, "threads.delta");
  assert.deepEqual(requests.at(-1)?.params, {});
});

test("a corrupt concurrent foreground page invalidates an older detached exchange without resurrection", async (t) => {
  const { control, pending, requests, links, drain, list } = await setup(t);
  await list(); control.hold = true;
  await list(); await until(() => pending.length === 1);
  await links.call("far", "profiles.list", {});
  const foreground = list();
  await until(() => pending.length === 2);
  const older = pending.shift()!, newer = pending.shift()!;
  control.hold = false; control.corruptPage = true;
  newer();
  const failed = await foreground;
  assert.equal(failed.threads.length, 1);
  assert.equal(failed.machines?.[0].error, "Could not reach far: it hung up before answering.");
  older(); await drain();
  control.corruptPage = false;
  await links.call("far", "profiles.list", {});
  assert.equal((await list()).machines?.[0].reachable, true);
  assert.deepEqual(requests.at(-1)?.params, {}, "no old stage or base returned after invalidation");
});

test("a restarted older peer clears staging and uses the legacy call selected by its greeting", async (t) => {
  const { features, control, requests, drain, list } = await setup(t);
  await list(); control.pagesPerExchange = 1;
  await list(); await drain();
  features.length = 0;
  await list(); await drain();
  const final = await list();
  assert.equal(final.machines?.[0].reachable, true);
  assert.deepEqual(requests.slice(-2).map((request) => ({ method: request.method, params: request.params })), [
    { method: "threads.list", params: { local: true } }, { method: "threads.list", params: { local: true } },
  ]);
});

for (const [bound, count, titleLength] of [["bytes", 5000, 700], ["rows", 12_000, 0]] as const) {
  test(`the combined staged base and catch-up phase respect the ${bound} bound without app truncation`, async (t) => {
    const { source, control, links, requests, drain, list } = await setup(t);
    source.rows = Array.from({ length: count }, (_, i) => ({ ...row(`t${i}`), title: "x".repeat(titleLength) }));
    await list(); control.incrementalTimeout = true;
    await list(); await drain();
    source.list.revision++;
    for (const row of source.rows) { row.title = "y".repeat(titleLength); source.versions.set(row.id, source.list.revision); }
    control.incrementalTimeout = false;
    await list(); await drain();
    const failed = await list();
    assert.equal(failed.threads.length, 1);
    assert.equal(failed.machines?.[0].error, "Could not reach far: it hung up before answering.");
    await links.call("far", "profiles.list", {});
    const final = await list();
    assert.equal(final.threads.length, count + 1, "a valid whole answer is never truncated by staging bounds");
    assert.deepEqual(requests.at(-1)?.params, {});
  });
}

test("a timed-out seal pages its mutation backlog before another fresh seal", async (t) => {
  const { source, control, requests, drain, list, truth } = await setup(t);
  await list(); control.incrementalTimeout = true;
  await list(); await drain();
  assert.equal((await list()).threads.length, 1, "a complete historical base is still not an app result");
  await drain();
  source.rows[0].title = "changed during the seal timeout";
  source.versions.set("t0", ++source.list.revision);
  source.active = [{ id: "t0", state: "working" }];
  control.incrementalTimeout = false;
  await list(); await drain();
  const final = await list();
  assert.equal(final.machines?.[0].reachable, true);
  assert.equal(JSON.stringify(final.threads.filter((row) => row.machine)),
    JSON.stringify(truth().map((row) => ({ ...row, id: `far/${row.id}`, machine: "far" }))));
  assert.ok(requests.some((request) => request.method === "threads.page" && request.params.since === 1));
});

test("a paged fleet stays visible across repeated slow full safety refreshes", async (t) => {
  const { control, requests, drain, list } = await setup(t);
  await list();
  await list(); await drain();
  const verified = await list();
  assert.equal(verified.threads.length, 501);
  for (let cycle = 0; cycle < 2; cycle++) {
    t.mock.timers.tick(120_001);
    control.fullTimeout = true;
    const at = requests.length;
    assert.deepEqual(await list(), verified, "the safety timeout must not remove the verified list");
    assert.deepEqual(await list(), verified, "private pages must not replace the published list");
    await drain();
    assert.deepEqual(await list(), verified);
    assert.deepEqual(requests.slice(at).find((request) => request.method === "threads.page")?.params, {},
      "each safety refresh still rebuilds a full base");
  }
});

test("a recovered safety refresh swaps the verified list only after its replacement is sealed", async (t) => {
  const { source, control, requests, pending, drain, list } = await setup(t);
  control.fullTimeout = false;
  const verified = await list();
  source.rows[0].title = "new full-only title";
  t.mock.timers.tick(120_001);
  control.fullTimeout = true;
  assert.deepEqual(await list(), verified);
  control.hold = true;
  assert.deepEqual(await list(), verified);
  await until(() => pending.length === 1);
  assert.deepEqual(await list(), verified);
  source.active = [{ id: "t0", state: "working" }];
  control.hold = false;
  pending.shift()!();
  await drain();
  const fresh = await list();
  assert.equal(fresh.threads.length, 501);
  assert.equal(fresh.threads.find((thread) => thread.id === "far/t0")?.title, "new full-only title");
  assert.equal(fresh.threads.find((thread) => thread.id === "far/t0")?.state, "working");
  assert.equal(requests.at(-1)?.method, "threads.delta");
  assert.equal(fresh.machines?.[0].reachable, true);
});

test("a safety refresh that times out partway retains its verified list and resumes the private pages", async (t) => {
  const { source, control, requests, drain, list } = await setup(t);
  control.fullTimeout = false;
  const verified = await list();
  source.rows[0].title = "full-only change after the last verification";
  t.mock.timers.tick(120_001);
  control.fullTimeout = true;
  control.pagesPerExchange = 1;
  assert.deepEqual(await list(), verified);
  assert.deepEqual(await list(), verified);
  await drain();
  assert.ok(requests.some((request) => request.method === "threads.page" && request.params.snapshot !== undefined));
  assert.deepEqual(await list(), verified, "a complete first page is not a complete verified replacement");
  await drain();
  control.pagesPerExchange = Infinity;
  assert.deepEqual(await list(), verified);
  await drain();
  const fresh = await list();
  assert.equal(fresh.threads.length, 501);
  assert.equal(fresh.threads.find((thread) => thread.id === "far/t0")?.title, "full-only change after the last verification");
  assert.equal(requests.filter((request) => request.method === "threads.page" && request.params.snapshot === undefined).length, 1,
    "timeouts resume the private full snapshot instead of starting it again");
});

test("idle expiry of a held safety refresh keeps the verified list and retries a full replacement", async (t) => {
  const { control, pending, requests, links, drain, list } = await setup(t);
  control.fullTimeout = false;
  const verified = await list();
  t.mock.timers.tick(120_001);
  control.fullTimeout = true;
  assert.deepEqual(await list(), verified);
  control.hold = true;
  assert.deepEqual(await list(), verified);
  await until(() => pending.length === 1);
  await links.call("far", "profiles.list", {});
  const foreground = list();
  await until(() => pending.length === 2);
  t.mock.timers.tick(60_001);
  assert.deepEqual(await foreground, verified, "expiry abandons staging, not the published replacement fallback");
  await drain();
  control.hold = false;
  for (const send of pending.splice(0)) send();
  await links.call("far", "profiles.list", {});
  assert.deepEqual(await list(), verified);
  assert.deepEqual(requests.at(-1)?.params, {}, "an expired private candidate restarts the full safety check");
});

test("a later safety timeout cannot restore rows removed by an overlapping verified replacement", async (t) => {
  const { source, control, pending, requests, list } = await setup(t);
  control.fullTimeout = false;
  assert.equal((await list()).threads.length, 501);
  source.rows = [row("replacement")];
  source.list.revision++;
  t.mock.timers.tick(120_001);
  control.holdFull = true;
  const first = list();
  await until(() => pending.length === 1);
  const later = list();
  await until(() => pending.length === 2);
  pending.shift()!();
  const fresh = await first;
  assert.equal(fresh.threads.length, 2);
  t.mock.timers.tick(8000);
  assert.deepEqual(await later, fresh);
  control.holdFull = false;
  pending.shift()!();
  assert.deepEqual(await list(), fresh, "a failed newer request must not resurrect the old verified list");
  assert.equal(requests.at(-1)?.params.since, source.list.revision, "the newer verified cursor survives too");
});

test("a successful cold bootstrap does not cancel another independent cold paging caller", async (t) => {
  const { control, pending, calls, links, list } = await setup(t);
  await list();
  control.hold = true;
  await list();
  await until(() => pending.length === 1);
  const background = calls.at(-1)!;
  await links.call("far", "profiles.list", {});
  const foreground = list();
  await until(() => pending.length === 2);
  control.hold = false;
  pending.shift()!();
  await background;
  await setImmediate();
  pending.shift()!();
  const fresh = await foreground;
  assert.equal(fresh.threads.length, 501);
  assert.equal(fresh.machines?.[0].reachable, true);
});

test("a malformed safety page keeps the verified list until a valid full replacement works", async (t) => {
  const { source, control, drain, list, links, requests } = await setup(t);
  control.fullTimeout = false;
  const verified = await list();
  t.mock.timers.tick(120_001);
  control.fullTimeout = true;
  assert.deepEqual(await list(), verified);
  control.corruptPage = true;
  assert.deepEqual(await list(), verified);
  await drain();
  assert.deepEqual(await list(), verified);
  control.corruptPage = false;
  source.rows = [row("replacement")];
  await links.call("far", "profiles.list", {});
  const fresh = await list();
  assert.deepEqual(fresh.threads.filter((thread) => thread.machine).map((thread) => thread.id), ["far/replacement"]);
  assert.deepEqual(requests.at(-1)?.params, {});
});

test("removing a link during its safety refresh discards the verified fallback and held pages", async (t) => {
  const { control, pending, links, drain, list } = await setup(t);
  control.fullTimeout = false;
  await list();
  t.mock.timers.tick(120_001);
  control.fullTimeout = true;
  await list();
  control.hold = true;
  await list();
  await until(() => pending.length === 1);
  await links.call("far", "profiles.list", {});
  const foreground = list();
  await until(() => pending.length === 2);
  t.mock.method(links, "all", () => []);
  assert.equal((await list()).threads.length, 1);
  const removed = await foreground;
  assert.equal(removed.threads.length, 1, "a removed link cannot publish its old verified fallback");
  for (const send of pending.splice(0)) send();
  await drain();
  assert.equal((await list()).threads.length, 1);
});

for (const [bound, count, titleLength] of [["bytes", 5000, 700], ["rows", 12_000, 0]] as const) {
  test(`verified and replacement safety rows share the ${bound} bound without dropping the verified list`, async (t) => {
    const { source, control, requests, links, drain, list } = await setup(t);
    source.rows = Array.from({ length: count }, (_, i) => ({ ...row(`t${i}`), title: "x".repeat(titleLength) }));
    control.fullTimeout = false;
    const verified = await list();
    assert.equal(verified.threads.length, count + 1);
    for (const row of source.rows) row.title = "y".repeat(Math.max(1, titleLength));
    t.mock.timers.tick(120_001);
    control.fullTimeout = true;
    assert.deepEqual(await list(), verified);
    assert.deepEqual(await list(), verified);
    await drain();
    assert.equal(requests.at(-1)?.method, "threads.page", "the bounded private candidate is rejected before a seal");
    assert.deepEqual(await list(), verified);
    await links.call("far", "profiles.list", {});
    const recovered = await list();
    assert.equal(recovered.threads.length, count + 1, "a recovered full fetch is never truncated by private staging bounds");
    assert.ok(recovered.threads.filter((thread) => thread.machine).every((thread) => thread.title?.startsWith("y")));
    assert.deepEqual(requests.at(-1)?.params, {});
  });
}

for (const failure of ["schema", "hangup", "refused"] as const) {
  test(`a ${failure} failure never activates detached bootstrap paging`, async (t) => {
    const { control, calls, requests, list } = await setup(t, failure === "refused" ? "password" : "token");
    control.fullTimeout = false;
    control.corruptFull = failure === "schema"; control.hangup = failure === "hangup"; control.refused = failure === "refused";
    const first = await list(), count = requests.length;
    assert.equal(first.threads.length, 1);
    assert.deepEqual(await list(), first);
    assert.equal(requests.length, count);
    assert.equal(calls.length, 2, "only the app's two calls, with no detached page call");
  });
}

for (const fault of ["offset", "identity", "digest", "position"]) {
  test(`a late page with invalid ${fault} discards the entire phase`, async (t) => {
    const { control, requests, links, drain, list } = await setup(t);
    await list(); control.pagesPerExchange = 1;
    await list(); await drain();
    control.pageFault = fault; control.pagesPerExchange = Infinity;
    await list(); await drain();
    const failed = await list();
    assert.equal(failed.threads.length, 1);
    assert.equal(failed.machines?.[0].error, "Could not reach far: it hung up before answering.");
    control.pageFault = "";
    await links.call("far", "profiles.list", {});
    assert.equal((await list()).machines?.[0].reachable, true);
    assert.deepEqual(requests.at(-1)?.params, {});
  });
}

test("removing a link aborts detached work and a late page cannot recreate its cache", async (t) => {
  const { control, pending, links, requests, drain, list } = await setup(t);
  await list(); control.hold = true;
  await list(); await until(() => pending.length === 1);
  const all = t.mock.method(links, "all", () => []);
  assert.equal((await list()).threads.length, 1);
  await drain();
  all.mock.restore(); control.hold = false;
  pending.shift()!();
  await links.call("far", "profiles.list", {});
  assert.equal((await list()).machines?.[0].reachable, true);
  assert.deepEqual(requests.at(-1)?.params, {});
});
