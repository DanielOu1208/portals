import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathsFor } from "../src/config.ts";
import { isLaterMachineOrder, longestOrder, machineID, orderNames, SidebarOrder } from "../src/order.ts";
import { startTestBridge, TestClient, type RpcFailure } from "./helpers.ts";

// The order of the agents and the folders in the sidebar on every device (feature
// sidebar_order, src/order.ts): what the bridge keeps, and what a device is told. Two
// clients stand for two devices.

let root: string;
let files = 0;
before(() => {
  root = mkdtempSync(join(tmpdir(), "portals-order-test-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

const file = () => join(root, `order-${(files += 1)}.json`);
const invalid = (error: RpcFailure) => error.code === -32602;
/** The Macs as a bridge keeps them before they were ever arranged. */
const noMacs = { machines: [], machinesAt: 0 };

test("the two lists are kept whole, one left out stays as it is, and each change moves the revision by one", () => {
  const order = new SidebarOrder(file());
  const start = order.revision();
  assert.equal(start.revision, 0);
  assert.match(start.id, /^[0-9a-f]{16}$/);
  assert.deepEqual(order.get(), { agents: [], folders: [], ...noMacs });

  assert.deepEqual(order.set({ agents: ["codex", "claude"] }), { agents: ["codex", "claude"], folders: [], ...noMacs });
  assert.deepEqual(order.set({ folders: ["/Users/dev/notes", "/Users/dev/app"] }), { agents: ["codex", "claude"], folders: ["/Users/dev/notes", "/Users/dev/app"], ...noMacs });
  assert.deepEqual(order.revision(), { id: start.id, revision: 2 });

  // Both at once is one change; an empty list is no order at all.
  order.set({ agents: ["claude", "codex"], folders: [] });
  assert.deepEqual(order.get(), { agents: ["claude", "codex"], folders: [], ...noMacs });
  assert.equal(order.revision().revision, 3);
});

test("the same order given again changes nothing", () => {
  const order = new SidebarOrder(file());
  order.set({ agents: ["codex", "claude"] });
  order.set({ agents: ["codex", "claude"] });
  order.set({});
  assert.equal(order.revision().revision, 1);
});

test("what is handed out is a copy: changing it changes nothing the bridge keeps", () => {
  const order = new SidebarOrder(file());
  const given = ["codex", "claude"];
  order.set({ agents: given });
  given.reverse();
  order.get().agents.push("pi");
  assert.deepEqual(order.get().agents, ["codex", "claude"]);
});

test("a failed save leaves the order and revision unchanged, and the same change can be retried durably", () => {
  const path = file();
  const order = new SidebarOrder(path);
  order.set({ agents: ["claude", "codex"], machines: { ids: ["aa11aa11aa11aa11"], at: 1000 } });
  const before = { order: order.get(), list: order.revision() };
  const backup = `${path}.saved`;
  renameSync(path, backup);
  mkdirSync(path);
  const change = { agents: ["codex", "claude"], machines: { ids: ["bb22bb22bb22bb22", "aa11aa11aa11aa11"], at: 2000 } };

  assert.throws(() => order.set(change));
  assert.deepEqual(order.get(), before.order);
  assert.deepEqual(order.revision(), before.list);
  rmSync(path, { recursive: true });
  renameSync(backup, path);

  order.set(change);
  const restarted = new SidebarOrder(path);
  assert.deepEqual(restarted.get(), order.get());
  assert.deepEqual(restarted.revision(), { id: before.list.id, revision: before.list.revision + 1 });
  assert.deepEqual(restarted.get().agents, change.agents);
  assert.equal(restarted.get().machinesAt, change.machines.at);
});

test("a list names each thing once, and is no list with an empty name, a name too long or too many of them", () => {
  assert.deepEqual(orderNames(["codex", "claude", "codex"]), ["codex", "claude"]);
  assert.deepEqual(orderNames([]), []);
  assert.equal(orderNames("codex"), undefined);
  assert.equal(orderNames(["codex", ""]), undefined);
  assert.equal(orderNames(["codex", 3]), undefined);
  assert.equal(orderNames(["x".repeat(4097)]), undefined);
  assert.equal(orderNames(Array.from({ length: longestOrder + 1 }, (_, index) => `folder-${index}`)), undefined);
  assert.equal(orderNames(Array.from({ length: longestOrder }, (_, index) => `folder-${index}`))?.length, longestOrder);
});

test("the order is kept in a private file and read again by the next bridge", () => {
  const path = file();
  const first = new SidebarOrder(path);
  first.set({ agents: ["codex", "claude"], folders: ["/Users/dev/notes"] });
  assert.equal(statSync(path).mode & 0o777, 0o600);

  const again = new SidebarOrder(path);
  assert.deepEqual(again.revision(), first.revision());
  assert.deepEqual(again.get(), first.get());
});

test("a file with no id starts a new order, and a list that is none reads as empty", () => {
  const path = file();
  writeFileSync(path, JSON.stringify({ agents: ["codex", "claude"], folders: "everything" }));
  const order = new SidebarOrder(path);
  assert.deepEqual(order.get(), { agents: ["codex", "claude"], folders: [], ...noMacs });
  assert.equal(order.revision().revision, 0);

  // The Macs' order without the moment it was arranged is no order: nothing could ever replace it rightly.
  writeFileSync(path, JSON.stringify({ machines: ["aa11aa11aa11aa11"], machinesAt: "yesterday" }));
  assert.deepEqual(new SidebarOrder(path).get(), { agents: [], folders: [], ...noMacs });

  writeFileSync(path, "not json");
  assert.deepEqual(new SidebarOrder(path).get(), { agents: [], folders: [], ...noMacs });
});

test("nothing is written until something is put in order", () => {
  const path = file();
  new SidebarOrder(path).revision();
  assert.throws(() => readFileSync(path), { code: "ENOENT" });
});

test("state files containing a non-object JSON value do not prevent the bridge from starting", () => {
  for (const value of [null, [], 3, "order"]) {
    const path = file();
    writeFileSync(path, JSON.stringify(value));
    assert.deepEqual(new SidebarOrder(path).get(), { agents: [], folders: [], ...noMacs });
    const id = machineID(path);
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.equal(machineID(path), id);
  }
});

// MARK: Over the wire

test("gateway.ready lists sidebar_order, and a device is told the order and where it is", async () => {
  const bridge = await startTestBridge();
  try {
    const client = await TestClient.open(bridge);
    assert.ok((client.readyPayload.bridge.features as string[]).includes("sidebar_order"));

    const empty = await client.call("order.list");
    assert.deepEqual({ agents: empty.agents, folders: empty.folders }, { agents: [], folders: [] });
    assert.equal(empty.list.revision, 0);
    assert.deepEqual((await client.call("sessions.activity")).order, empty.list);

    const set = await client.call("order.set", { agents: ["codex", "fake"] });
    assert.deepEqual(set, { list: { id: empty.list.id, revision: 1 }, agents: ["codex", "fake"], folders: [], machines: [], machines_at: 0 });
    assert.deepEqual(await client.call("order.list"), set);
    assert.deepEqual((await client.call("sessions.activity")).order, set.list);
    await client.close();
  } finally {
    await bridge.dispose();
  }
});

test("an order one device gives is the one another device is told, also after the bridge starts again", async () => {
  // Its folder is kept for the second start.
  let bridge = await startTestBridge({ keepHome: true });
  const kept = bridge.home;
  try {
    const phone = await TestClient.open(bridge);
    const mac = await TestClient.open(bridge);
    const before = (await mac.call("sessions.activity")).order;

    // On the phone the folders are arranged; on the Mac, a moment later, the agents.
    await phone.call("order.set", { folders: ["/Users/dev/notes", "/Users/dev/app"] });
    const both = await mac.call("order.set", { agents: ["fake", "codex"] });
    // Each device sent only its own list, and neither took the other's away.
    assert.deepEqual({ agents: both.agents, folders: both.folders }, { agents: ["fake", "codex"], folders: ["/Users/dev/notes", "/Users/dev/app"] });

    // The phone's next poll says something changed, and it asks.
    const now = (await phone.call("sessions.activity")).order;
    assert.equal(now.id, before.id);
    assert.equal(now.revision, before.revision + 2);
    assert.deepEqual((await phone.call("order.list")).agents, ["fake", "codex"]);
    await phone.close();
    await mac.close();
    await bridge.dispose();

    bridge = await startTestBridge({ home: kept, keepHome: true });
    assert.deepEqual(JSON.parse(readFileSync(pathsFor(kept).order, "utf8")).folders, ["/Users/dev/notes", "/Users/dev/app"]);
    const later = await TestClient.open(bridge);
    assert.deepEqual(await later.call("order.list"), { list: now, agents: ["fake", "codex"], folders: ["/Users/dev/notes", "/Users/dev/app"], machines: [], machines_at: 0 });
    await later.close();
  } finally {
    await bridge.dispose();
    rmSync(kept, { recursive: true, force: true });
  }
});

test("order.set: an agent or a folder the bridge does not have now keeps its place, and a list that is none is refused", async () => {
  const bridge = await startTestBridge();
  try {
    const client = await TestClient.open(bridge);
    // The bridge arranges nothing itself, so it need not know what a name is.
    assert.deepEqual((await client.call("order.set", { agents: ["gone", "fake"], folders: ["/no/such/folder"] })).agents, ["gone", "fake"]);
    // Named twice: once, where it was named first.
    assert.deepEqual((await client.call("order.set", { agents: ["fake", "gone", "fake"] })).agents, ["fake", "gone"]);

    await assert.rejects(client.call("order.set", {}), (error: RpcFailure) => invalid(error) && error.message === "Say what to put in order: agents, folders or machines.");
    await assert.rejects(client.call("order.set", { agents: "fake" }), (error: RpcFailure) => invalid(error) && error.message === "agents must be a list of strings.");
    await assert.rejects(client.call("order.set", { folders: ["/Users/dev/app", 3] }), invalid);
    await assert.rejects(client.call("order.set", { agents: ["fake", ""] }), (error: RpcFailure) => invalid(error) && error.message === `agents must be a list of at most ${longestOrder} names, none of them empty.`);
    // What was refused changed nothing.
    assert.deepEqual((await client.call("order.list")).list.revision, 2);
    await client.close();
  } finally {
    await bridge.dispose();
  }
});

// MARK: The Macs (feature machine_order)

test("the Macs' order is replaced only by one arranged later, whichever device tells the bridge last", () => {
  const order = new SidebarOrder(file());
  const mini = "aa11aa11aa11aa11";
  const macbook = "bb22bb22bb22bb22";
  assert.deepEqual(order.set({ machines: { ids: [mini, macbook], at: 2000 } }), { agents: [], folders: [], machines: [mini, macbook], machinesAt: 2000 });
  assert.equal(order.revision().revision, 1);

  // A device that was out of reach brings an order arranged before that one: it is not taken.
  order.set({ machines: { ids: [macbook, mini], at: 1500 } });
  // Nor is the one kept, sent again at its moment (of two different ones of the same
  // moment, the tie is broken by their ids: the test below).
  order.set({ machines: { ids: [mini, macbook], at: 2000 } });
  assert.deepEqual(order.get().machines, [mini, macbook]);
  assert.equal(order.revision().revision, 1);

  // Arranged later, it is, and the agents sent with an older order of the Macs are still taken.
  order.set({ machines: { ids: [macbook, mini], at: 2500 } });
  order.set({ agents: ["codex"], machines: { ids: [mini, macbook], at: 100 } });
  assert.deepEqual(order.get(), { agents: ["codex"], folders: [], machines: [macbook, mini], machinesAt: 2500 });
  assert.equal(order.revision().revision, 3);
});

test("two orders of the Macs from the same moment end the same on every bridge, whichever came first", () => {
  const mini = "aa11aa11aa11aa11";
  const macbook = "bb22bb22bb22bb22";
  const one = { ids: [mini, macbook], at: 4000 };
  const other = { ids: [macbook, mini], at: 4000 };
  const first = new SidebarOrder(file());
  const second = new SidebarOrder(file());
  first.set({ machines: one });
  first.set({ machines: other });
  second.set({ machines: other });
  second.set({ machines: one });
  assert.deepEqual(first.get().machines, second.get().machines);
  // And the app decides the same way: the one kept is the later of the two.
  assert.equal(isLaterMachineOrder(one, other), !isLaterMachineOrder(other, one));
  assert.deepEqual(first.get().machines, isLaterMachineOrder(one, other) ? one.ids : other.ids);
  // The same order given again is no change.
  const revision = first.revision().revision;
  first.set({ machines: { ids: [...first.get().machines], at: 4000 } });
  assert.equal(first.revision().revision, revision);
});

test("the Macs' order and its moment are read again by the next bridge", () => {
  const path = file();
  new SidebarOrder(path).set({ machines: { ids: ["aa11aa11aa11aa11", "bb22bb22bb22bb22"], at: 1_791_940_000_000 } });
  assert.deepEqual(new SidebarOrder(path).get(), { agents: [], folders: [], machines: ["aa11aa11aa11aa11", "bb22bb22bb22bb22"], machinesAt: 1_791_940_000_000 });
});

test("a bridge gives itself an id once and keeps it", () => {
  const path = join(root, "machine.json");
  const id = machineID(path);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(machineID(path), id);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // A file that holds none starts over; with no file to keep it in, each asking makes one.
  writeFileSync(path, JSON.stringify({ id: "mine" }));
  assert.notEqual(machineID(path), "mine");
  assert.notEqual(machineID(), machineID());
});

test("gateway.ready carries the bridge's id, and two devices end up with the Macs in the order arranged last", async () => {
  let bridge = await startTestBridge({ keepHome: true });
  const kept = bridge.home;
  try {
    const phone = await TestClient.open(bridge);
    const mac = await TestClient.open(bridge);
    assert.ok((phone.readyPayload.bridge.features as string[]).includes("machine_order"));
    const here = phone.readyPayload.bridge.machine.id as string;
    assert.match(here, /^[0-9a-f]{16}$/);
    assert.equal(mac.readyPayload.bridge.machine.id, here);
    const other = "cc33cc33cc33cc33";

    const first = await mac.call("order.set", { machines: [other, here], machines_at: 5000 });
    assert.deepEqual({ machines: first.machines, at: first.machines_at }, { machines: [other, here], at: 5000 });
    // The phone arranged them before that, out of reach: the answer is the order the bridge kept, to take.
    const late = await phone.call("order.set", { machines: [here, other], machines_at: 4000 });
    assert.deepEqual({ machines: late.machines, at: late.machines_at, list: late.list }, { machines: [other, here], at: 5000, list: first.list });
    // And then arranges them again: now it is the later one.
    const again = await phone.call("order.set", { machines: [here, other], machines_at: 6000 });
    assert.deepEqual((await mac.call("sessions.activity")).order, again.list);
    assert.deepEqual((await mac.call("order.list")).machines, [here, other]);

    await assert.rejects(phone.call("order.set", { machines: [here] }), (error: RpcFailure) => invalid(error) && error.message === "machines_at must say when the Macs were arranged, in milliseconds since 1970.");
    await assert.rejects(phone.call("order.set", { machines: [here], machines_at: 0 }), invalid);
    await assert.rejects(phone.call("order.set", { machines: "all", machines_at: 7000 }), invalid);
    await phone.close();
    await mac.close();
    await bridge.dispose();

    // The id is the bridge's for good: the same after it starts again.
    bridge = await startTestBridge({ home: kept, keepHome: true });
    const later = await TestClient.open(bridge);
    assert.equal(later.readyPayload.bridge.machine.id, here);
    assert.deepEqual((await later.call("order.list")).machines, [here, other]);
    await later.close();
  } finally {
    await bridge.dispose();
    rmSync(kept, { recursive: true, force: true });
  }
});
