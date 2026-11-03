import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { pathsFor } from "../src/config.ts";
import { threadVariables } from "../src/portals/access.ts";
import { createThread, startTestBridge, TestClient, type Frame, type TestBridge } from "./helpers.ts";

// A Mac renamed from the app (feature net_rename, docs/net-plan.md) between real bridges:
// three on this Mac stand in for three Macs in one net, each in a folder of its own on a
// port of its own, with the scripted agent alone. The rules themselves, clocks that differ
// and a bridge from before among them, are in net.test.ts.

let a: TestBridge;
let b: TestBridge;
let c: TestBridge;
let toA: TestClient;
let toB: TestClient;
let toC: TestClient;
const machineOf: Record<string, string> = {};

before(async () => {
  a = await startTestBridge({ config: { fleet: { name: "Mac A" } } });
  b = await startTestBridge({ config: { fleet: { name: "Mac B" } } });
  // Kept for restarts.
  c = await startTestBridge({ config: { fleet: { name: "Mac C" } }, keepHome: true });
  toA = await TestClient.open(a);
  toB = await TestClient.open(b);
  toC = await TestClient.open(c);
  for (const [key, client] of [["a", toA], ["b", toB], ["c", toC]] as const) machineOf[key] = client.readyPayload.bridge.machine.id;
  await toB.call("net.join_with", { link: (await toA.call("net.invite")).link });
  await toC.call("net.join_with", { link: (await toB.call("net.invite")).link });
  for (const client of [toA, toB, toC]) await eventually(async () => (await client.call("net.list")).members.length === 3, "every Mac lists the three");
});

after(async () => {
  await Promise.all([toA, toB, toC].map((client) => client.close()));
  await Promise.all([a, b, c].map((bridge) => bridge.dispose()));
  rmSync(c.home, { recursive: true, force: true });
});

/** Waits until `check` gives something, asking again every 20 ms for up to 10 s. */
async function eventually<T>(check: () => Promise<T | undefined | false>, what: string): Promise<T> {
  const ends = Date.now() + 10_000;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() > ends) throw new Error(`timed out waiting until ${what}`);
    await sleep(20);
  }
}

/** The entry a bridge lists for the member `id`. */
async function entryOn(client: TestClient, id: string): Promise<Frame> {
  return (await client.call("net.list")).members.find((member: Frame) => member.id === id);
}

/** Waits until every Mac lists the member `id` named `name`. */
async function namedEverywhere(id: string, name: string): Promise<void> {
  for (const client of [toA, toB, toC]) await eventually(async () => (await entryOn(client, id))?.name === name, `every Mac names ${id} ${name}`);
}

test("a device renames a Mac through another Mac of the net: every Mac lists the new name, and the Mac renamed says it at once in what it passes on", async () => {
  const { code } = await toA.call("net.invite");
  const joined = await fetch(`${a.url}/net/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, member: { id: "phone-0000-0001", kind: "device", name: "iPhone", platform: "ios" } }),
  });
  const { token } = (await joined.json()) as { token: string };
  const phone = await TestClient.open(a, { token });
  assert.ok(phone.readyPayload.bridge.features.includes("net_rename"));

  // On A, of C: answered with A's list, the name in it at once.
  const answer = await phone.call("net.rename", { member: machineOf.c, name: "  Studio  " });
  assert.equal(answer.you, "phone-0000-0001");
  const renamed = answer.members.find((member: Frame) => member.id === machineOf.c);
  assert.deepEqual([renamed.name, renamed.named_by], ["Studio", machineOf.a]);
  assert.ok(renamed.named > 0);
  await namedEverywhere(machineOf.c, "Studio");
  // C took it as its own, and wrote its entry anew with the same stamp.
  await eventually(async () => (await entryOn(toA, machineOf.c)).by === machineOf.c, "C wrote its entry anew");
  assert.equal((await entryOn(toC, machineOf.c)).named, renamed.named);

  // C goes by it at once, without a restart: its join link, a message it passes on to
  // another Mac, and a thread it starts there.
  assert.match((await toC.call("net.invite")).link, /&name=Studio$/);
  const thread = await createThread(toA);
  await toC.call("thread.send", { thread: `mac-a/${thread}`, text: "hello from the studio", wait: true });
  const said = (await toA.call("thread.read", { thread, last: 1 })).messages.filter((message: Frame) => message.role === "user").map((message: Frame) => message.text);
  assert.deepEqual(said, [`[Portals: from the command line (machine ${machineOf.c}) on Studio]\nhello from the studio`]);
  const started = await toC.call("thread.start", { machine: "mac-a", profile: "fake", text: "started from the studio", wait: true });
  const id = started.thread.id.slice("mac-a/".length);
  const listed = (await toA.call("threads.changes")).threads.find((entry: Frame) => entry.id === id);
  assert.deepEqual(listed.started_by, { name: "the portals command on Studio", from: { machine: machineOf.c, machine_name: "Studio" } });
  // And A links to it by its new name.
  await eventually(async () => (await toA.call("threads.list")).machines.some((machine: Frame) => machine.name === "studio" && machine.reachable), "A links to C as studio");
  await phone.close();
});

test("a device renames itself, and another device, through any Mac of the net: every Mac lists the new names (feature net_rename_devices)", async () => {
  const join = async (bridge: TestBridge, client: TestClient, id: string, name: string, platform: string) => {
    const { code } = await client.call("net.invite");
    const joined = await fetch(`${bridge.url}/net/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, member: { id, kind: "device", name, platform } }),
    });
    return ((await joined.json()) as { token: string }).token;
  };
  // A Mac's app joins through B under the name Mac Catalyst gave it; a phone through C.
  const app = await TestClient.open(b, { token: await join(b, toB, "macapp-0000-0002", "iPad", "macos") });
  await join(c, toC, "phone-0000-0003", "iPhone", "ios");
  assert.ok(app.readyPayload.bridge.features.includes("net_rename_devices"));
  await namedEverywhere("phone-0000-0003", "iPhone");

  // Itself, through B: answered with B's list, the name in it at once, then on every Mac.
  const answer = await app.call("net.rename", { member: "macapp-0000-0002", name: "MacBook Pro 16" });
  assert.equal(answer.you, "macapp-0000-0002");
  const own = answer.members.find((member: Frame) => member.id === "macapp-0000-0002");
  assert.deepEqual([own.name, own.named_by], ["MacBook Pro 16", machineOf.b]);
  await namedEverywhere("macapp-0000-0002", "MacBook Pro 16");
  // The phone, which joined through C, from B.
  await app.call("net.rename", { member: "phone-0000-0003", name: "Dana's iPhone" });
  await namedEverywhere("phone-0000-0003", "Dana's iPhone");
  // And through A by the command, from the person at that Mac.
  const there = await portals(["net", "rename", "phone-0000-0003", "Pocket"], a.home);
  assert.equal(there.code, 0, there.stderr);
  await namedEverywhere("phone-0000-0003", "Pocket");
  await assert.rejects(app.call("net.rename", { member: "phone-0000-0003", name: " " }), { message: "A device's name cannot be empty." });
  await app.close();
});

test("two devices renaming the same Mac on two Macs at once end with one name on every Mac, the later rename's", async () => {
  // One through A, the other through C, both of B, at the same moment.
  const [throughA, throughC] = await Promise.all([toA.call("net.rename", { member: machineOf.b, name: "From A" }), toC.call("net.rename", { member: machineOf.b, name: "From C" })]);
  const made = [throughA, throughC].map((answer) => answer.members.find((member: Frame) => member.id === machineOf.b));
  const later = made.reduce((one, other) => (one.named !== other.named ? (one.named > other.named ? one : other) : one.named_by > other.named_by ? one : other));
  await namedEverywhere(machineOf.b, later.name);
  // Settled: every copy the same, B's own name with them.
  for (const client of [toA, toB, toC]) {
    const entry = await entryOn(client, machineOf.b);
    assert.deepEqual([entry.name, entry.named, entry.named_by], [later.name, later.named, later.named_by]);
  }
  assert.match((await toB.call("net.invite")).link, new RegExp(`&name=${encodeURIComponent(later.name)}$`));
});

test("a Mac renamed while it is off goes by the name as it starts again, over its fleet.name, and after another restart; its config.json is left as it was", async () => {
  await toC.close();
  const home = c.home;
  await c.close();
  await toA.call("net.rename", { member: machineOf.c, name: "Back Room" });
  c = await startTestBridge({ home, keepHome: true });
  toC = await TestClient.open(c);
  await namedEverywhere(machineOf.c, "Back Room");
  await eventually(async () => /&name=Back%20Room$/.test((await toC.call("net.invite")).link), "C goes by the new name");
  // Started once more: the name kept, its own (fleet.name) still in its config.
  await toC.close();
  await c.close();
  c = await startTestBridge({ home, keepHome: true });
  toC = await TestClient.open(c);
  assert.match((await toC.call("net.invite")).link, /&name=Back%20Room$/);
  assert.equal(JSON.parse(readFileSync(pathsFor(home).config, "utf8")).fleet.name, "Mac C");
  const thread = await createThread(toB);
  await toC.call("thread.send", { thread: `${await linkName(toC, machineOf.b)}/${thread}`, text: "still here", wait: true });
  const said = (await toB.call("thread.read", { thread, last: 1 })).messages.filter((message: Frame) => message.role === "user").map((message: Frame) => message.text);
  assert.deepEqual(said, [`[Portals: from the command line (machine ${machineOf.c}) on Back Room]\nstill here`]);
});

/** What `client`'s bridge calls the Mac `id` in a thread's id: the link named after its name in the net. */
async function linkName(client: TestClient, id: string): Promise<string> {
  const name = (await entryOn(client, id)).name as string;
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

test("a rename that cannot be one is refused with a sentence, and nothing changes", async () => {
  const before = await toA.call("net.list");
  for (const [params, message] of [
    [{ member: machineOf.b, name: "" }, "A Mac's name cannot be empty."],
    [{ member: machineOf.b, name: "x".repeat(81) }, "A Mac's name is at most 80 characters."],
    [{ member: machineOf.b, name: "two\nlines" }, "A Mac's name is one line."],
    [{ member: "nobody-0000", name: "Studio" }, "There is no member nobody-0000 in this net."],
    [{ member: machineOf.b, name: "Studio", after: "soon" }, "after must be a whole number."],
    [{ member: machineOf.b }, "name is missing."],
  ] as const) {
    await assert.rejects(toA.call("net.rename", params), (error: { code: number; message: string }) => error.code === -32602 && error.message === message, message);
  }
  assert.equal((await toA.call("net.list")).revision, before.revision);
});

/** Runs the `portals` command against `home`'s bridge. */
function portals(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env, PORTALS_BRIDGE_HOME: home };
  for (const name of threadVariables) delete env[name];
  const script = fileURLToPath(new URL("../src/portals.ts", import.meta.url));
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

test("portals net rename renames this Mac, or another of the net by its id, on every Mac", async () => {
  const here = await portals(["net", "rename", "Desk"], b.home);
  assert.equal(here.code, 0, here.stderr);
  assert.equal(JSON.parse(here.stdout).members.find((member: Frame) => member.id === machineOf.b).name, "Desk");
  await namedEverywhere(machineOf.b, "Desk");
  const there = await portals(["net", "rename", machineOf.a, "Hall"], b.home);
  assert.equal(there.code, 0, there.stderr);
  await namedEverywhere(machineOf.a, "Hall");
  const empty = await portals(["net", "rename", " "], b.home);
  assert.equal(empty.code, 1);
  assert.equal(JSON.parse(empty.stderr).error.message, "A Mac's name cannot be empty.");
  assert.equal((await portals(["net", "rename"], b.home)).code, 2);
  assert.equal((await portals(["net", "rename", "one", "two", "three"], b.home)).code, 2);
  assert.match((await portals(["help"], b.home)).stdout, /portals net rename \[MEMBER\] NAME/);
});
