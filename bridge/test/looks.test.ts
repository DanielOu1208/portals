import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathsFor } from "../src/config.ts";
import { Looks } from "../src/looks.ts";
import { startTestBridge, TestClient, type RpcFailure } from "./helpers.ts";

// How the agents look on every device (feature agent_looks, src/looks.ts): what the
// bridge keeps, which look wins when two devices give one, and what a device is told.
// Two clients stand for two devices.

let root: string;
let files = 0;
before(() => {
  root = mkdtempSync(join(tmpdir(), "portals-looks-test-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

const file = () => join(root, `looks-${(files += 1)}.json`);
const invalid = (error: RpcFailure) => error.code === -32602;

test("a look is kept with who decided it, listed by agent name, and each change moves the revision by one", () => {
  const looks = new Looks(file());
  const start = looks.revision();
  assert.equal(start.revision, 0);
  assert.match(start.id, /^[0-9a-f]{16}$/);
  assert.deepEqual(looks.all(), []);

  assert.deepEqual(looks.set("codex", { shape: 2, face: 1, tint: 5, origin: "assigned" }), {
    look: { agent: "codex", shape: 2, face: 1, tint: 5, origin: "assigned" },
    taken: true,
  });
  looks.set("claude", { shape: 1, face: 0, tint: 3, showsLogo: false, origin: "chosen" });
  assert.deepEqual(looks.revision(), { id: start.id, revision: 2 });
  assert.deepEqual(looks.all(), [
    { agent: "claude", shape: 1, face: 0, tint: 3, shows_logo: false, origin: "chosen" },
    { agent: "codex", shape: 2, face: 1, tint: 5, origin: "assigned" },
  ]);
  assert.deepEqual(looks.get("codex"), { agent: "codex", shape: 2, face: 1, tint: 5, origin: "assigned" });
  assert.equal(looks.get("pi"), undefined);
});

test("the same look given again changes nothing", () => {
  const looks = new Looks(file());
  looks.set("codex", { shape: 2, face: 1, tint: 5, origin: "chosen" });
  assert.deepEqual(looks.set("codex", { shape: 2, face: 1, tint: 5, origin: "chosen" }).taken, true);
  assert.equal(looks.revision().revision, 1);
});

test("a look the app gave is taken only by an agent that has none, when the device says so", () => {
  const looks = new Looks(file());
  // Two devices see a new agent and each gives it a look: the first one's is everyone's.
  assert.equal(looks.set("pi", { shape: 4, face: 2, tint: 7, origin: "assigned" }, "any").taken, true);
  const second = looks.set("pi", { shape: 6, face: 0, tint: 9, origin: "assigned" }, "any");
  assert.deepEqual(second, { look: { agent: "pi", shape: 4, face: 2, tint: 7, origin: "assigned" }, taken: false });
  assert.equal(looks.revision().revision, 1);
  // The second device sent what the bridge has already: its look is the one given.
  assert.equal(looks.set("pi", { shape: 4, face: 2, tint: 7, origin: "assigned" }, "any").taken, true);
});

test("a look chosen by hand replaces one the app gave, and is replaced only by another chosen one", () => {
  const looks = new Looks(file());
  looks.set("claude", { shape: 0, face: 0, tint: 1, origin: "assigned" });
  // A choice a device made before the bridge kept looks: over a look the app gave.
  assert.equal(looks.set("claude", { shape: 3, face: 4, tint: 8, origin: "chosen" }, "chosen").taken, true);
  // Another device's older choice: the one the bridge has stays.
  assert.deepEqual(looks.set("claude", { shape: 5, face: 5, tint: 2, origin: "chosen" }, "chosen"), {
    look: { agent: "claude", shape: 3, face: 4, tint: 8, origin: "chosen" },
    taken: false,
  });
  // A look an app gave never takes the place of a choice, with or without a condition.
  assert.equal(looks.set("claude", { shape: 7, face: 1, tint: 4, origin: "assigned" }).taken, false);
  // A choice made now does.
  assert.deepEqual(looks.set("claude", { shape: 5, face: 5, tint: 2, origin: "chosen" }), {
    look: { agent: "claude", shape: 5, face: 5, tint: 2, origin: "chosen" },
    taken: true,
  });
  assert.equal(looks.revision().revision, 3);
});

test("the logo's setting is part of the look: off is kept, and taking the choice back leaves it out", () => {
  const looks = new Looks(file());
  looks.set("codex", { shape: 1, face: 0, tint: 3, showsLogo: false, origin: "chosen" });
  assert.equal(looks.get("codex")?.shows_logo, false);
  looks.set("codex", { shape: 1, face: 0, tint: 3, origin: "chosen" });
  assert.deepEqual(looks.get("codex"), { agent: "codex", shape: 1, face: 0, tint: 3, origin: "chosen" });
  assert.equal(looks.revision().revision, 2);
});

test("the looks are read back from the file, which only its owner can read, with the list's id and revision", () => {
  const path = file();
  const first = new Looks(path);
  first.set("codex", { shape: 2, face: 1, tint: 5, origin: "assigned" });
  first.set("claude", { shape: 1, face: 0, tint: 3, showsLogo: false, origin: "chosen" });
  assert.equal(statSync(path).mode & 0o777, 0o600);

  const again = new Looks(path);
  assert.deepEqual(again.revision(), first.revision());
  assert.deepEqual(again.all(), first.all());
});

test("a file with no list starts a new one, and an entry that is not a look costs only itself", () => {
  const path = file();
  writeFileSync(path, JSON.stringify({
    looks: {
      codex: { shape: 2, face: 1, tint: 5, origin: "assigned" },
      odd: { shape: "round", face: 1, tint: 5, origin: "assigned" },
      far: { shape: 1000, face: 1, tint: 5, origin: "assigned" },
      whose: { shape: 1, face: 1, tint: 5, origin: "somebody" },
    },
  }));
  const looks = new Looks(path);
  assert.deepEqual(looks.all(), [{ agent: "codex", shape: 2, face: 1, tint: 5, origin: "assigned" }]);
  assert.equal(looks.revision().revision, 0);

  writeFileSync(path, "not json");
  assert.deepEqual(new Looks(path).all(), []);
  // JSON that is no object holds no looks either, and the bridge still starts.
  for (const text of ["null", "[]", "3", '"looks"']) {
    writeFileSync(path, text);
    assert.deepEqual(new Looks(path).all(), []);
  }
});

test("a look the file did not take is not kept: the bridge goes on with the one it had, and the same look sent again is saved", () => {
  const path = file();
  const looks = new Looks(path);
  looks.set("claude", { shape: 1, face: 0, tint: 3, origin: "chosen" });
  // A folder where the file goes makes its write fail, as a full disk would.
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => looks.set("claude", { shape: 2, face: 0, tint: 3, origin: "chosen" }));
  assert.equal(looks.get("claude")?.shape, 1);
  assert.equal(looks.revision().revision, 1);

  rmSync(path, { recursive: true });
  assert.deepEqual(looks.set("claude", { shape: 2, face: 0, tint: 3, origin: "chosen" }).taken, true);
  assert.equal(looks.revision().revision, 2);
  assert.equal(new Looks(path).get("claude")?.shape, 2);
});

test("nothing is written until an agent is given a look", () => {
  const path = file();
  new Looks(path).revision();
  assert.throws(() => readFileSync(path), { code: "ENOENT" });
});

// MARK: Over the wire

test("gateway.ready lists agent_looks, and a device is told the looks and where their list is", async () => {
  const bridge = await startTestBridge();
  try {
    const client = await TestClient.open(bridge);
    assert.ok((client.readyPayload.bridge.features as string[]).includes("agent_looks"));

    const empty = await client.call("looks.list");
    assert.deepEqual(empty.looks, []);
    assert.equal(empty.list.revision, 0);
    assert.deepEqual((await client.call("sessions.activity")).looks, empty.list);

    const set = await client.call("look.set", { profile: "fake", shape: 3, face: 2, tint: 6 });
    // With no origin named, the look is one somebody chose.
    assert.deepEqual(set, { list: { id: empty.list.id, revision: 1 }, look: { agent: "fake", shape: 3, face: 2, tint: 6, origin: "chosen" }, taken: true });
    assert.deepEqual(await client.call("looks.list"), { list: set.list, looks: [set.look] });
    assert.deepEqual((await client.call("sessions.activity")).looks, set.list);
    await client.close();
  } finally {
    await bridge.dispose();
  }
});

test("a look one device gives is the one another device is told, also after the bridge starts again", async () => {
  // Its folder is kept for the second start.
  let bridge = await startTestBridge({ keepHome: true });
  const kept = bridge.home;
  try {
    const phone = await TestClient.open(bridge);
    const mac = await TestClient.open(bridge);
    const before = (await mac.call("sessions.activity")).looks;

    // The phone sees the agent first and gives it a look; the Mac, a moment later, its own.
    await phone.call("look.set", { profile: "fake", shape: 4, face: 2, tint: 7, origin: "assigned", unless: "any" });
    const late = await mac.call("look.set", { profile: "fake", shape: 6, face: 0, tint: 9, origin: "assigned", unless: "any" });
    assert.equal(late.taken, false);
    assert.deepEqual(late.look, { agent: "fake", shape: 4, face: 2, tint: 7, origin: "assigned" });

    // On the Mac the user chooses another by hand: the phone's next poll says something changed.
    await mac.call("look.set", { profile: "fake", shape: 1, face: 5, tint: 2, shows_logo: false });
    const now = (await phone.call("sessions.activity")).looks;
    assert.equal(now.id, before.id);
    assert.equal(now.revision, before.revision + 2);
    assert.deepEqual((await phone.call("looks.list")).looks, [{ agent: "fake", shape: 1, face: 5, tint: 2, shows_logo: false, origin: "chosen" }]);
    await phone.close();
    await mac.close();
    await bridge.dispose();

    assert.equal(JSON.parse(readFileSync(pathsFor(kept).looks, "utf8")).revision, 2);
    bridge = await startTestBridge({ home: kept });
    const again = await TestClient.open(bridge);
    assert.deepEqual(await again.call("looks.list"), { list: now, looks: [{ agent: "fake", shape: 1, face: 5, tint: 2, shows_logo: false, origin: "chosen" }] });
    await again.close();
  } finally {
    await bridge.dispose();
    rmSync(kept, { recursive: true, force: true });
  }
});

test("look.set says no to an agent the bridge does not run and to a look it cannot keep", async () => {
  const bridge = await startTestBridge();
  try {
    const client = await TestClient.open(bridge);
    const look = { profile: "fake", shape: 1, face: 1, tint: 1 };
    await assert.rejects(client.call("look.set", { ...look, profile: "nobody" }), invalid);
    await assert.rejects(client.call("look.set", { profile: "fake", shape: 1, face: 1 }), invalid);
    await assert.rejects(client.call("look.set", { ...look, shape: -1 }), invalid);
    await assert.rejects(client.call("look.set", { ...look, tint: 1000 }), invalid);
    await assert.rejects(client.call("look.set", { ...look, face: 1.5 }), invalid);
    await assert.rejects(client.call("look.set", { ...look, origin: "somebody" }), invalid);
    await assert.rejects(client.call("look.set", { ...look, unless: "never" }), invalid);
    await assert.rejects(client.call("look.set", { ...look, shows_logo: "no" }), invalid);
    assert.deepEqual((await client.call("looks.list")).looks, []);
    // Keys sent as null are not given.
    assert.equal((await client.call("look.set", { ...look, shows_logo: null, origin: null, unless: null })).look.origin, "chosen");
    await client.close();
  } finally {
    await bridge.dispose();
  }
});
