import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Fleet, type FleetDelta, type ThreadSummary } from "../src/fleet/fleet.ts";
import { Links, writeLinks, type LinkCallOptions, type NetLink } from "../src/fleet/links.ts";
import { RemoteThreads } from "../src/fleet/remoteThreads.ts";
import { fleetOrder } from "../src/fleet/order.ts";
import { Folders } from "../src/folders.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { Registry, type ThreadRecord } from "../src/sessions/registry.ts";
import type { Provider } from "../src/providers/types.ts";
import type { Session } from "../src/sessions/session.ts";
import { hashPassword } from "../src/http/auth.ts";
import { pathsFor } from "../src/config.ts";
import { methods, type CallContext } from "../src/gateway/methods.ts";
import { createThread, password, startTestBridge, TestClient, username } from "./helpers.ts";

// Under /tmp by its real path (/private/tmp on a Mac): short enough for the socket to be in the folder.
const root = join(realpathSync("/tmp"), "portals-bridge-review");
const row = (id: string, title = id): ThreadSummary => ({ id, title, agent: "fake", agent_name: "Fake", folder: "/w", updated: 1, state: "idle" });
const response = (threads: ThreadSummary[], revision = 1, extra: Partial<FleetDelta> = {}): FleetDelta => ({
  epoch: "run", list: { id: "list", revision }, threads, positions: threads.map((_, index) => index),
  removed: [], active: [], order: fleetOrder(threads.map((row) => row.id)), ...extra,
});

function remote(t: TestContext, call: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>, legacy = false) {
  const links = new Links(join(root, "unused-fleet-delta-links.json"));
  const link: NetLink = { name: "far", url: "http://127.0.0.1:1", net: true };
  t.mock.method(links, "call", async (_name: string, method: string, params: Record<string, unknown>, _timeout: number, options: LinkCallOptions = {}) => {
    let request = legacy && options.fallback ? options.fallback : { method, params };
    for (;;) {
      const answer = await call(request.method, request.params);
      if (!options.receive) return answer;
      const reply = options.receive(answer, request.method);
      if ("result" in reply) return reply.result;
      request = reply.call;
    }
  });
  const cache = new RemoteThreads(links);
  t.after(() => cache.close());
  return { cache, link };
}

test("fleet delta merges changes and removals, with the complete overlay authoritative even when rows disagree", async (t) => {
  let n = 0;
  const { cache, link } = remote(t, (_method, params) => {
    if (n++ === 0) {
      assert.deepEqual(params, {});
      return response([row("a"), row("b")], 1, { full: true });
    }
    assert.deepEqual(params, { epoch: "run", list: "list", since: n === 2 ? 1 : 2 });
    return n === 2
      ? response([row("a", "changed")], 2, { removed: ["b"], active: [{ id: "a", state: "blocked", kind: "permission" }] })
      : response([], 2, { order: fleetOrder(["a"]) });
  });
  assert.equal((await cache.list(link)).length, 2);
  assert.deepEqual(await cache.list(link), [{ ...row("a", "changed"), state: "blocked", kind: "permission" }]);
  assert.deepEqual(await cache.list(link), [row("a", "changed")], "an empty overlay clears old blocking state without a registry change");
});

test("fleet delta fetches overlapping callers independently and never commits a late older reply", async (t) => {
  const finishes: ((answer: FleetDelta) => void)[] = [];
  const { cache, link } = remote(t, (_method, params) => {
    if (finishes.length === 2) {
      assert.equal(params.since, 2);
      return response([], 2, { order: fleetOrder(["a"]) });
    }
    return new Promise<FleetDelta>((resolve) => { finishes.push(resolve); });
  });
  const first = cache.list(link);
  const second = cache.list(link);
  assert.notEqual(first, second);
  finishes[1](response([row("a", "new")], 2, { full: true }));
  assert.deepEqual(await second, [row("a", "new")]);
  finishes[0](response([row("a", "old")], 1, { full: true }));
  assert.deepEqual(await first, [row("a", "old")]);
  assert.deepEqual(await cache.list(link), [row("a", "new")]);
});

test("a full reply without positions derives registry order before a positioned readoption", async (t) => {
  let calls = 0;
  const { cache, link } = remote(t, () => ++calls === 1
    ? response([row("a"), row("b"), row("c")], 1, { full: true, positions: undefined })
    : response([row("a", "readopted")], 3, { positions: [2], order: fleetOrder(["b", "c", "a"]) }));
  assert.deepEqual((await cache.list(link)).map((row) => row.id), ["a", "b", "c"]);
  assert.deepEqual((await cache.list(link)).map((row) => row.id), ["b", "c", "a"]);
  assert.equal(calls, 2);
});

test("an incremental reply still requires positions after an implied-order full reply", async (t) => {
  let calls = 0;
  const { cache, link } = remote(t, () => ++calls === 1
    ? response([row("a")], 1, { full: true, positions: undefined })
    : response([row("a", "changed")], 2, { positions: undefined }));
  await cache.list(link);
  await assert.rejects(cache.list(link), /hung up before answering/);
  assert.equal(calls, 2);
});

test("absolute positions move a readopted row without a repair RPC", async (t) => {
  const calls: string[] = [];
  const { cache, link } = remote(t, (method) => {
    calls.push(method);
    return calls.length === 1
      ? response([row("a"), row("b"), row("c")], 1, { full: true })
      : response([row("a", "readopted")], 3, { positions: [2], order: fleetOrder(["b", "c", "a"]) });
  });
  await cache.list(link);
  assert.deepEqual((await cache.list(link)).map((row) => row.id), ["b", "c", "a"]);
  assert.deepEqual(calls, ["threads.delta", "threads.delta"]);
});

test("a corrupt delta discards its base without a repair RPC and the next request is full", async (t) => {
  let calls = 0;
  const { cache, link } = remote(t, (method, params) => {
    assert.equal(method, "threads.delta");
    if (++calls === 1) return response([row("a")], 1, { full: true });
    if (calls === 2) return response([], 1, { order: fleetOrder(["wrong"]) });
    assert.deepEqual(params, {});
    return response([row("fresh")], 2, { full: true });
  });
  await cache.list(link);
  await assert.rejects(cache.list(link), /hung up before answering/);
  assert.deepEqual(await cache.list(link), [row("fresh")]);
  assert.equal(calls, 3);
});

test("fleet delta uses only the legacy unfiltered local list when positions are not advertised", async (t) => {
  const calls: string[] = [];
  const { cache, link } = remote(t, (method, params) => {
    calls.push(method);
    assert.deepEqual(params, { local: true });
    return { threads: [row("a")] };
  }, true);
  assert.deepEqual(await cache.list(link), [row("a")]);
  assert.deepEqual(await cache.list(link), [row("a")]);
  assert.deepEqual(calls, ["threads.list", "threads.list"]);
});

for (const positions of [[0, 0], [0, 2], [0], [-1, 1], [0.5, 1], [0, Number.MAX_SAFE_INTEGER + 1]]) {
  test(`invalid absolute positions ${JSON.stringify(positions)} fail closed`, async (t) => {
    let calls = 0;
    const { cache, link } = remote(t, () => {
      calls++;
      return response([row("a"), row("b")], 1, { full: true, positions });
    });
    await assert.rejects(cache.list(link), /hung up before answering/);
    assert.equal(calls, 1);
  });
}

test("fleet delta discards an invalid incremental epoch and asks without a cursor next time", async (t) => {
  let n = 0;
  const { cache, link } = remote(t, (method, params) => {
    n++;
    if (n === 1) return response([row("old")], 1, { full: true });
    if (n === 2) return response([row("bad")], 2, { epoch: "another-run" });
    assert.equal(method, "threads.delta");
    assert.deepEqual(params, {});
    return response([row("correct")], 2, { full: true, epoch: "another-run" });
  });
  await cache.list(link);
  await assert.rejects(cache.list(link), /hung up before answering/);
  assert.deepEqual(await cache.list(link), [row("correct")]);
});

test("fleet delta's periodic full read replaces drift and retains a usable registry cursor", async (t) => {
  let now = 1;
  t.mock.method(Date, "now", () => now);
  let n = 0;
  const truth = [row("a", "authoritative")];
  const { cache, link } = remote(t, (method, params) => {
    assert.equal(method, "threads.delta");
    if (n++ === 0) return response([row("a"), row("forgotten-removal")], 1, { full: true });
    return params.since === undefined ? response(truth, 1, { full: true }) : response([], 1, { order: fleetOrder(["a"]) });
  });
  await cache.list(link);
  now += 120_001;
  assert.deepEqual(await cache.list(link), truth);
  assert.deepEqual(await cache.list(link), truth);
});

test("fleet delta omits unreachable Macs, expires their cursor after a minute, and forgets removed or replaced links", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fails = false;
  const requests: Record<string, unknown>[] = [];
  const { cache, link } = remote(t, (_method, params) => {
    requests.push(params);
    if (fails) throw new Error("asleep");
    return response([row("a")], 1, { full: true });
  });
  await cache.list(link);
  fails = true;
  await assert.rejects(cache.list(link), /asleep/);
  t.mock.timers.tick(60_001);
  fails = false;
  await cache.list(link);
  assert.deepEqual(requests.at(-1), {});
  const replaced = { ...link, url: "http://127.0.0.1:2" };
  await cache.list(replaced);
  assert.deepEqual(requests.at(-1), {});
  cache.retain([]);
  await cache.list(replaced);
  assert.deepEqual(requests.at(-1), {});
});

test("fleet delta does not retain an oversized per-link cache or truncate its returned list", async (t) => {
  const rows = Array.from({ length: 20_001 }, (_, i) => row(`t${i}`));
  const methods: string[] = [];
  const { cache, link } = remote(t, (method) => {
    methods.push(method);
    return method === "threads.delta" ? response(rows, 1, { full: true }) : { threads: rows };
  });
  assert.equal((await cache.list(link)).length, rows.length);
  assert.equal((await cache.list(link)).length, rows.length);
  assert.deepEqual(methods, ["threads.delta", "threads.list"]);
});

for (const field of ["epoch", "list"] as const) {
  test(`fleet delta counts retained ${field} metadata without truncating a valid full answer`, async (t) => {
    const rows = [row("a")], given = response(rows, 1, { full: true }), methods: string[] = [];
    const large = "m".repeat(8 * 1024 * 1024 + 1);
    if (field === "epoch") given.epoch = large; else given.list.id = large;
    const { cache, link } = remote(t, (method) => {
      methods.push(method);
      return method === "threads.delta" ? given : { threads: rows };
    });
    assert.deepEqual(await cache.list(link), rows);
    assert.deepEqual(await cache.list(link), rows);
    assert.deepEqual(methods, ["threads.delta", "threads.list"]);
  });
}

async function scratch(t: TestContext) {
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, "fleet-delta-test-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    port: 0, host: "127.0.0.1", auth: { username, passwordHash: await hashPassword(password) },
    generalFolder: home, providers: { fake: true, claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false },
    fake: { delayMs: 3 }, relay: { enabled: false }, updates: { check: false }, push: { relay: null },
  }));
  let bridge = await startTestBridge({ home, keepHome: true });
  let client = await TestClient.open(bridge);
  t.after(async () => { await client.close(); await bridge.dispose(); rmSync(home, { recursive: true, force: true }); });
  return {
    home,
    get url() { return bridge.url; },
    get client() { return client; },
    async restart() {
      await client.close();
      await bridge.dispose();
      bridge = await startTestBridge({ home, keepHome: true });
      client = await TestClient.open(bridge);
    },
  };
}

test("every threads.list query parameter is accounted for; only an unfiltered non-local query uses delta", async (t) => {
  assert.deepEqual(methods["threads.list"].params, { state: "string", profile: "string", local: "boolean" },
    "a new list parameter must explicitly preserve its legacy forwarding before delta can be used");
  const home = mkdtempSync(join(root, "fleet-delta-params-"));
  const providers = new Map<string, Provider>();
  const sessions = new SessionManager({ registry: new Registry(join(home, "threads.json")), providers });
  const links = new Links(join(home, "links.json"), { macs: () => [{ name: "far", url: "http://127.0.0.1:1" }], token: () => "scratch" });
  const fleet = new Fleet({ sessions, providers, links,
    folders: new Folders({ general: home, hide: [], own: [], sources: [] }), here: { id: "test", name: "Test" } });
  t.after(async () => { fleet.close(); await sessions.close(); rmSync(home, { recursive: true, force: true }); });
  const forwarded: Record<string, unknown>[] = [];
  t.mock.method(links, "call", async (_name: string, method: string, params: Record<string, unknown>, timeout: number, options: unknown) => {
    assert.equal(method, "threads.list", "no delta probe on a filtered query");
    assert.equal(timeout, 8000);
    assert.deepEqual(options, { glance: true });
    forwarded.push(params);
    return { threads: [] };
  });
  let deltas = 0;
  t.mock.method(RemoteThreads.prototype, "list", async () => { deltas++; return []; });
  const call = (params: Record<string, unknown>) => methods["threads.list"].handle(params, { gateway: { fleet } } as unknown as CallContext);
  await call({});
  await call({ state: "working" });
  await call({ profile: "fake" });
  await call({ state: "idle", profile: "fake" });
  await call({ local: true, state: "working", profile: "fake" });
  assert.equal(deltas, 1);
  assert.deepEqual(forwarded, [
    { local: true, state: "working" },
    { local: true, profile: "fake" },
    { local: true, state: "idle", profile: "fake" },
  ]);
});

test("real mutually linked Macs keep cold state/profile queries exactly filtered, without requesting a delta", async (t) => {
  const left = await scratch(t), right = await scratch(t);
  writeLinks(pathsFor(left.home).links, [{ name: "right", url: right.url, user: username, password }]);
  writeLinks(pathsFor(right.home).links, [{ name: "left", url: left.url, user: username, password }]);
  await createThread(left.client);
  const working = await createThread(right.client);
  await right.client.call("prompt.submit", { session_id: working, profile: "fake", text: "slow please" });
  let deltas = 0;
  t.mock.method(RemoteThreads.prototype, "list", async () => { deltas++; throw new Error("filtered query must not request delta"); });
  for (const [near, far, name] of [[left, right, "right"], [right, left, "left"]] as const) {
    for (const query of [{ state: "working" }, { state: "idle" }, { profile: "fake" }, { profile: "nobody" }, { state: "working", profile: "fake" }]) {
      const own = (await near.client.call("threads.list", { ...query, local: true })).threads;
      const remote = (await far.client.call("threads.list", { ...query, local: true })).threads;
      const expected = [...own, ...remote.map((row: ThreadSummary) => ({ ...row, id: `${name}/${row.id}`, machine: name }))].sort((a, b) => b.updated - a.updated);
      const actual = await near.client.call("threads.list", query);
      assert.equal(JSON.stringify(actual.threads), JSON.stringify(expected));
      assert.deepEqual(actual.machines, [{ name, url: far.url, reachable: true }]);
    }
  }
  assert.equal(deltas, 0);
  await right.client.call("session.interrupt", { session_id: working, profile: "fake" });
});

test("fleet delta is opt-in: old frames stay unchanged; cursors handle removal, bad base and restarted Macs", async (t) => {
  const peer = await scratch(t);
  assert.ok(peer.client.readyPayload.bridge.features.includes("fleet_delta"));
  const id = await createThread(peer.client);
  const first = await peer.client.call("threads.delta");
  assert.equal(first.full, true);
  assert.equal("positions" in first, false, "a full wire reply already gives every row in registry order");
  assert.equal(first.threads[0].id, id);
  const cursor = { epoch: first.epoch, list: first.list.id, since: first.list.revision };
  assert.deepEqual((await peer.client.call("threads.delta", cursor)).threads, []);
  assert.deepEqual(Object.keys(await peer.client.call("threads.list", { local: true })), ["threads"]);
  assert.deepEqual(Object.keys(await peer.client.call("threads.changes")).sort(), ["full", "list", "removed", "threads"]);
  await peer.client.call("thread.delete", { thread: id });
  assert.deepEqual((await peer.client.call("threads.delta", cursor)).removed, [id]);
  assert.deepEqual((await peer.client.call("threads.delta")).removed, [], "a replacing full delta never repeats historical tombstones");
  assert.equal((await peer.client.call("threads.delta", { ...cursor, since: -1 })).full, true);
  await peer.restart();
  const restarted = await peer.client.call("threads.delta", cursor);
  assert.equal(restarted.full, true);
  assert.notEqual(restarted.epoch, cursor.epoch);
  assert.deepEqual(restarted.threads, []);
});

test("fleet delta bounds string storage as well as row count without truncating answers", async (t) => {
  const rows = Array.from({ length: 18 }, (_, i) => row(`large${i}`, "x".repeat(500_000)));
  const calls: string[] = [];
  const { cache, link } = remote(t, (method) => {
    calls.push(method);
    return method === "threads.delta" ? response(rows, 1, { full: true }) : { threads: rows };
  });
  assert.equal((await cache.list(link)).length, 18);
  assert.equal((await cache.list(link)).length, 18);
  assert.deepEqual(calls, ["threads.delta", "threads.list"]);
});

test("seeded fleet merges match full fetches byte for byte across ties, removal/readoption, states and restarts", async (t) => {
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, "fleet-delta-property-"));
  const registry = new Registry(join(home, "threads.json"));
  const providers = new Map<string, Provider>();
  const sessions = new SessionManager({ registry, providers });
  const links = new Links(join(home, "links.json"));
  const states = new Map<string, string>();
  t.mock.method(sessions, "loadedRecords", () => registry.all());
  t.mock.method(sessions, "get", (id: string) => ({
    requests: { list: () => states.get(id) === "blocked" ? [{ method: "clarify" }] : [] },
    isAtWork: states.get(id) === "working",
    messages: states.get(id) === "error" ? [{ role: "assistant", display_kind: "failed_turn" }] : [],
  } as unknown as Session));
  const makeFleet = () => new Fleet({
    sessions, providers, links, folders: new Folders({ general: home, hide: [], own: [], sources: [] }),
    here: { id: "0123456789abcdef", name: "Test Mac" },
  });
  let fleet = makeFleet();
  let repairs = 0;
  const { cache, link } = remote(t, (method, params) => {
    if (method === "threads.list") { repairs++; return { threads: fleet.threads() }; }
    return fleet.delta(params.epoch as string | undefined, params.list as string | undefined, params.since as number | undefined);
  });
  t.after(async () => { fleet.close(); await sessions.close(); rmSync(home, { recursive: true, force: true }); });
  let seed = 0x5eedca1;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  let next = 0;
  let tied = 0;
  let readopted = 0;
  for (let step = 0; step < 500; step++) {
    // Real-looking second-resolution timestamps: several events share each second.
    now = 1_800_000_000_000 + Math.floor(step / 5) * 1000;
    const records = registry.all();
    const record = records[random(Math.max(records.length, 1))];
    const action = random(7);
    if (!record || action === 0) {
      const id = `thread-${++next}`;
      const added: ThreadRecord = {
        id, agent: next % 2 ? "fake" : "other", cwd: `/w/${next % 3}`, title: next % 3 ? id : null,
        model: "", provider: "", reasoningEffort: "", origin: "phone",
        createdAt: Math.floor(now / 1000), updatedAt: Math.floor(now / 1000),
        ...(next % 5 === 0 ? { readOnly: true } : {}),
      };
      registry.add(added);
    } else if (action === 1) {
      registry.set(record.id, { title: step % 2 ? `Title ${step}` : null });
    } else if (action === 2) {
      registry.update(record.id, {});
    } else if (action === 3) {
      registry.remove(record.id);
    } else if (action === 4) {
      // Both changes happen between refreshes: an old row's Map slot must not survive.
      const removed = registry.remove(record.id)!;
      registry.add(structuredClone(removed));
      readopted++;
    } else {
      states.set(record.id, ["idle", "working", "blocked", "error"][random(4)]);
    }
    if (step > 0 && step % 67 === 0) { fleet.close(); fleet = makeFleet(); }
    const expected = fleet.threads();
    if (new Set(expected.map((row) => row.updated)).size < expected.length) tied++;
    assert.equal(JSON.stringify(await cache.list(link)), JSON.stringify(expected), `seed 0x5eedca1, step ${step}`);
  }
  assert.ok(readopted > 0 && tied > 0);
  assert.equal(repairs, 0, "absolute positions remove every readoption repair RPC");
  t.diagnostic(`500 seeded refreshes: ${tied} contained timestamp ties; ${readopted} removed/re-adopted between refreshes; ${repairs} digest repairs; all byte-identical.`);
});

test("fleet delta carries approval and queued-handoff state changes between registry deltas", async (t) => {
  const peer = await scratch(t);
  const client = peer.client;
  const id = await createThread(client);
  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: id, text: "approve this", profile: "fake" });
  const ask = await client.from(start, (frame) => frame.method === "approval");
  const blocked = await client.call("threads.delta");
  assert.deepEqual(blocked.active.find((item: any) => item.id === id), { id, state: "blocked", kind: "permission" });
  await client.call("prompt.submit", { session_id: id, text: "slow please", profile: "fake", when_busy: "queue" });
  client.answer(ask.id, { choice: "once" });
  await client.from(start, (frame) => frame.method === "event" && frame.params.type === "message.start" && frame.params.payload.text === "slow please");
  const working = await client.call("threads.delta", { epoch: blocked.epoch, list: blocked.list.id, since: blocked.list.revision });
  assert.deepEqual(working.active.find((item: any) => item.id === id), { id, state: "working" });
  await client.call("session.interrupt", { session_id: id, profile: "fake" });
  const idle = await client.call("threads.delta", { epoch: working.epoch, list: working.list.id, since: working.list.revision });
  assert.equal(idle.active.some((item: any) => item.id === id), false);
});

test("a refresh that fails after the minute's expiry released its base does not bring the rows back (Codex review, low)", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  let phase = "warm";
  let fail: (error: Error) => void = () => {};
  const requests: Record<string, unknown>[] = [];
  const { cache, link } = remote(t, async (_method, params) => {
    requests.push(params);
    if (phase === "fail") throw new Error("asleep");
    if (phase === "pending") await new Promise((_resolve, reject) => { fail = reject; });
    return response([row("a")], 1, { full: true });
  });
  await cache.list(link);
  phase = "fail";
  await assert.rejects(cache.list(link), /asleep/);
  t.mock.timers.tick(59_000);
  phase = "pending";
  const pending = assert.rejects(cache.list(link), /asleep/);
  t.mock.timers.tick(1_001);
  fail(new Error("asleep"));
  await pending;
  const held = (cache as unknown as { cached: Map<string, { rows: Map<string, unknown>; cursor?: unknown }> }).cached.get("far")!;
  assert.equal(held.rows.size, 0, "the rows the expiry let go stay let go");
  assert.equal(held.cursor, undefined);
  phase = "warm";
  await cache.list(link);
  assert.deepEqual(requests.at(-1), {}, "the next refresh asks for a whole list");
  phase = "fail";
  await assert.rejects(cache.list(link), /asleep/);
  t.mock.timers.tick(60_001);
  assert.equal(held.rows.size, 0, "a later failure arms the expiry again");
});

test("a provider's new display name reaches a warm linked-Mac list at once, though the registry did not change (Codex review, low)", async (t) => {
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, "fleet-delta-names-"));
  const registry = new Registry(join(home, "threads.json"));
  const profile = { name: "fake", kind: "fake", displayName: "Old label", description: "", model: "", provider: "" };
  const providers = new Map<string, Provider>([["fake", { profile } as unknown as Provider]]);
  const sessions = new SessionManager({ registry, providers });
  const fleet = new Fleet({
    sessions, providers, links: new Links(join(home, "links.json")), folders: new Folders({ general: home, hide: [], own: [], sources: [] }),
    here: { id: "0123456789abcdef", name: "Test Mac" },
  });
  t.after(async () => { fleet.close(); await sessions.close(); rmSync(home, { recursive: true, force: true }); });
  registry.add({ id: "a", agent: "fake", cwd: "/w", title: null, model: "", provider: "", reasoningEffort: "", origin: "phone", createdAt: 1, updatedAt: 1 } as ThreadRecord);
  registry.add({ id: "b", agent: "later", cwd: "/w", title: null, model: "", provider: "", reasoningEffort: "", origin: "phone", createdAt: 1, updatedAt: 2 } as ThreadRecord);
  const fulls: boolean[] = [];
  const { cache, link } = remote(t, (_method, params) => {
    const answer = fleet.delta(params.epoch as string | undefined, params.list as string | undefined, params.since as number | undefined);
    fulls.push(answer.full === true);
    return answer;
  });
  assert.deepEqual(await cache.list(link), fleet.threads());
  assert.deepEqual(await cache.list(link), fleet.threads());
  const revision = registry.revision;
  profile.displayName = "New label";
  providers.set("later", { profile: { ...profile, name: "later", displayName: "Later" } } as unknown as Provider);
  assert.equal(registry.revision, revision, "names are not part of the registry's revision");
  const names = await cache.list(link);
  assert.deepEqual(names, fleet.threads());
  assert.deepEqual(names.map((thread) => thread.agent_name).sort(), ["Later", "New label"]);
  assert.deepEqual(await cache.list(link), fleet.threads());
  assert.deepEqual(fulls, [true, false, true, false], "one whole list when the names change, deltas again after");
});

test("fleet pages use the same provider-name epoch as deltas across continuation and name changes", async (t) => {
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, "fleet-page-names-"));
  const registry = new Registry(join(home, "threads.json"));
  const profile = { name: "fake", kind: "fake", displayName: "Old label", description: "", model: "", provider: "" };
  const providers = new Map<string, Provider>([["fake", { profile } as unknown as Provider]]);
  const sessions = new SessionManager({ registry, providers });
  const fleet = new Fleet({
    sessions, providers, links: new Links(join(home, "links.json")), folders: new Folders({ general: home, hide: [], own: [], sources: [] }),
    here: { id: "0123456789abcdef", name: "Test Mac" },
  });
  t.after(async () => { fleet.close(); await sessions.close(); rmSync(home, { recursive: true, force: true }); });
  for (let i = 0; i < 200; i++) registry.add({
    id: `t${i}`, agent: "fake", cwd: "/w", title: "title-".repeat(30), model: "", provider: "", reasoningEffort: "",
    origin: "phone", createdAt: 1, updatedAt: 1,
  } as ThreadRecord);
  const first = fleet.page({});
  assert.ok("snapshot" in first);
  assert.ok(first.next < first.total);
  const ids = first.threads.map((thread) => thread.id);
  let page = first;
  while (page.next < page.total) {
    const next = fleet.page({ snapshot: page.snapshot, offset: page.next });
    assert.ok("snapshot" in next, "a current snapshot must survive its next page");
    page = next;
    ids.push(...page.threads.map((thread) => thread.id));
  }
  assert.deepEqual(ids, fleet.delta(undefined, undefined, undefined).threads.map((thread) => thread.id));
  profile.displayName = "New label";
  assert.deepEqual(fleet.page({ snapshot: first.snapshot, offset: first.next }), { reset: true });
  const renamed = fleet.page({});
  assert.ok("snapshot" in renamed);
  assert.notEqual(renamed.epoch, first.epoch);
  assert.ok(renamed.threads.every((thread) => thread.agent_name === "New label"));
});
