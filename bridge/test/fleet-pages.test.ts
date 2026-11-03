import "./environment.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { FleetDelta, ThreadSummary } from "../src/fleet/fleet.ts";
import { fleetOrder } from "../src/fleet/order.ts";
import { FleetPages, fleetPageBytes, type FleetPage } from "../src/fleet/pages.ts";

const row = (id: string, title = "x".repeat(180)): ThreadSummary => ({
  id, agent: "fake", agent_name: "Fake", folder: "/w", updated: 1, state: "idle", title,
});
function fixture(t: TestContext, rows = Array.from({ length: 500 }, (_, i) => row(`t${i}`))) {
  const source = { epoch: "run", list: { id: "list", revision: 1 }, rows, removed: [] as string[] };
  const store = new FleetPages(() => ({ epoch: source.epoch, list: source.list }), (cursor) => ({
    epoch: source.epoch, list: { ...source.list }, threads: source.rows,
    ...(cursor ? { positions: source.rows.map((_, i) => i) } : {}), removed: cursor ? source.removed : [],
    active: [{ id: source.rows[0]?.id ?? "", state: "working" }],
    order: fleetOrder(source.rows.map((row) => row.id)), ...(!cursor ? { full: true as const } : {}),
  }));
  t.after(() => store.close());
  return { store, source };
}
function page(reply: unknown): FleetPage {
  assert.ok(reply && typeof reply === "object" && "snapshot" in reply);
  return reply as FleetPage;
}

test("pages freeze summary values and insertion positions while the registry mutates", (t) => {
  const { store, source } = fixture(t);
  const expected = structuredClone(source.rows);
  let given = page(store.page({}));
  const threads = [...given.threads], positions = [...given.positions];
  assert.ok(given.next < given.total);
  source.rows[0].title = "changed after capture";
  source.rows.splice(1, 1);
  source.rows.push(row("readopted"));
  source.list.revision += 3;
  while (given.next < given.total) {
    given = page(store.page({ snapshot: given.snapshot, offset: given.next }));
    assert.ok(Buffer.byteLength(JSON.stringify(given)) <= fleetPageBytes);
    assert.equal("active" in given, false, "historical live state is never retained in pages");
    threads.push(...given.threads); positions.push(...given.positions);
  }
  assert.deepEqual(threads, expected);
  assert.deepEqual(positions, expected.map((_, i) => i));
  assert.equal(given.list.revision, 1);
});

test("delta snapshot offsets cover changed summaries and removals, reusing only a compatible target", (t) => {
  const { store, source } = fixture(t);
  source.removed = Array.from({ length: 300 }, (_, i) => `gone-${i}`);
  const cursor = { epoch: "run", list: "list", since: 0 };
  const first = page(store.page(cursor));
  assert.equal(first.full, undefined);
  assert.equal(page(store.page(cursor)).snapshot, first.snapshot);
  assert.notEqual(page(store.page({ ...cursor, since: 1 })).snapshot, first.snapshot);
  const removed: string[] = [...first.removed];
  let given = first;
  while (given.next < given.total) {
    given = page(store.page({ snapshot: given.snapshot, offset: given.next }));
    removed.push(...given.removed);
  }
  assert.deepEqual(removed, source.removed);
  assert.equal(given.total, source.rows.length + source.removed.length);
});

test("four snapshots and sixteen MiB are shared global limits, not per requesting Mac", (t) => {
  const { store, source } = fixture(t);
  const old = page(store.page({}));
  for (let i = 0; i < 4; i++) { source.list.revision++; store.page({}); }
  assert.deepEqual(store.page({ snapshot: old.snapshot, offset: old.next }), { reset: true });

  store.close();
  source.rows = Array.from({ length: 2000 }, (_, i) => row(`big-${i}`, "y".repeat(2000)));
  const large = page(store.page({}));
  source.list.revision++;
  const newest = page(store.page({}));
  // Two such snapshots exceed the shared conservative 16 MiB budget.
  assert.deepEqual(store.page({ snapshot: large.snapshot, offset: large.next }), { reset: true });
  assert.equal(page(store.page({ snapshot: newest.snapshot, offset: newest.next })).snapshot, newest.snapshot);
});

test("valid access refreshes idle expiry; restart, list replacement and invalid offsets reset tokens", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const { store, source } = fixture(t);
  let given = page(store.page({}));
  t.mock.timers.tick(40_000);
  given = page(store.page({ snapshot: given.snapshot, offset: given.next }));
  t.mock.timers.tick(40_000);
  given = page(store.page({ snapshot: given.snapshot, offset: 0 }));
  t.mock.timers.tick(60_001);
  assert.deepEqual(store.page({ snapshot: given.snapshot, offset: 0 }), { reset: true });
  given = page(store.page({}));
  assert.deepEqual(store.page({ snapshot: given.snapshot, offset: given.total + 1 }), { reset: true });
  given = page(store.page({}));
  source.epoch = "restart";
  assert.deepEqual(store.page({ snapshot: given.snapshot, offset: 0 }), { reset: true });
  given = page(store.page({}));
  source.list.id = "another-list";
  assert.deepEqual(store.page({ snapshot: given.snapshot, offset: 0 }), { reset: true });
});

test("oversized snapshots and individual rows do not truncate a valid full-list source", (t) => {
  const oversized = [row("huge", "z".repeat(fleetPageBytes))];
  const { store, source } = fixture(t, oversized);
  assert.deepEqual(store.page({}), { unavailable: true });
  assert.equal(source.rows[0].title?.length, fleetPageBytes);
  source.rows = [row("huge-again", "z".repeat(2 * 1024 * 1024))];
  for (let i = 0; i < 8; i++) {
    source.list.revision++;
    assert.deepEqual(store.page({}), { unavailable: true }, "unpageable rows release their budget immediately");
  }
  source.rows = [row("small")];
  assert.equal(page(store.page({})).threads[0].id, "small");
  source.rows = Array.from({ length: 20_001 }, (_, i) => row(`t${i}`));
  source.list.revision++;
  const full: Partial<FleetDelta> = { threads: source.rows };
  assert.deepEqual(store.page({}), { unavailable: true });
  assert.equal(full.threads?.length, 20_001);
});

test("invalid cursors share the full snapshot key instead of retaining request metadata", (t) => {
  const { store, source } = fixture(t);
  const full = page(store.page({})), large = "m".repeat(8 * 1024 * 1024 + 1);
  for (const cursor of [
    { epoch: large, list: source.list.id, since: 0 },
    { epoch: source.epoch, list: large, since: 0 },
    ...[-1, 0.5, 2, Number.MAX_SAFE_INTEGER + 1].map((since) => ({ epoch: source.epoch, list: source.list.id, since })),
  ]) assert.equal(page(store.page(cursor)).snapshot, full.snapshot);
});

test("snapshot metadata counts toward individual and shared storage budgets", (t) => {
  const { store, source } = fixture(t, Array.from({ length: 500 }, (_, i) => row(`t${i}`, "t".repeat(16_500))));
  source.list.id = "l".repeat(12_000);
  assert.deepEqual(store.page({}), { unavailable: true }, "rows alone fit, but metadata exceeds the individual limit");
  assert.equal(source.rows.length, 500, "the full-list source is unchanged");
  source.rows = source.rows.slice(0, 250);
  const first = page(store.page({}));
  source.list.revision++;
  const second = page(store.page({}));
  assert.deepEqual(store.page({ snapshot: first.snapshot, offset: first.next }), { reset: true }, "metadata makes two snapshots exceed the shared limit");
  assert.equal(page(store.page({ snapshot: second.snapshot, offset: second.next })).snapshot, second.snapshot);
});

test("fixed page metadata must fit even when the frozen list is empty", (t) => {
  const { store, source } = fixture(t, []);
  source.epoch = "e".repeat(fleetPageBytes);
  assert.deepEqual(store.page({}), { unavailable: true });
  assert.equal(source.rows.length, 0);
  source.epoch = "small";
  assert.equal(page(store.page({})).total, 0, "the rejected page released its snapshot budget");
});
